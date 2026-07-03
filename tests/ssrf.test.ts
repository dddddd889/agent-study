import { afterEach, describe, expect, test } from "bun:test";
import {
  assertUrlAllowed,
  isIpLiteral,
  isPrivateIp,
  type SsrfConfig,
} from "../src/ssrf";
import { httpRequestTool } from "../src/tools";

// ============ 单元:isPrivateIp(纯函数)============
describe("SSRF:isPrivateIp", () => {
  test("IPv4 私有/保留段 → true", () => {
    for (const ip of [
      "127.0.0.1", "127.5.5.5", // loopback
      "10.0.0.1", "10.255.255.255", // 10/8
      "172.16.0.1", "172.31.255.255", // 172.16/12
      "192.168.1.1", // 192.168/16
      "169.254.169.254", // 云元数据
      "100.64.0.1", // CGNAT
      "0.0.0.0", "224.0.0.1", "240.0.0.1", // 保留/组播
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  test("IPv4 公网 → false", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "11.0.0.0", "172.32.0.1", "192.169.0.0", "100.63.255.255"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  test("IPv6 私有/保留 → true;公网 → false", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false); // Google 公网 DNS
  });

  test("IPv4-mapped IPv6:抠出内嵌 IPv4 再判", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });

  test("认不出的地址 → 保守当私有(fail-safe)", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
  });

  test("isIpLiteral 识别字面量", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
  });
});

// ============ 单元:assertUrlAllowed(注入假 lookup + 显式 cfg,不碰 env/网络)============
const ON: SsrfConfig = { enabled: true, allowlist: [] };
const fakeLookup = (map: Record<string, string[]>) => async (host: string) => {
  const ips = map[host];
  if (!ips) throw new Error("NXDOMAIN");
  return ips.map((address) => ({ address }));
};

describe("SSRF:assertUrlAllowed", () => {
  test("域名解析到公网 → 放行", async () => {
    await assertUrlAllowed("https://example.com/x", ON, fakeLookup({ "example.com": ["93.184.216.34"] }));
  });

  test("域名解析到内网 → 拒", async () => {
    await expect(
      assertUrlAllowed("http://evil.com", ON, fakeLookup({ "evil.com": ["127.0.0.1"] })),
    ).rejects.toThrow(/私有|SSRF/);
  });

  test("解析结果含任一内网 IP 就拒", async () => {
    await expect(
      assertUrlAllowed("http://mix.com", ON, fakeLookup({ "mix.com": ["1.2.3.4", "10.0.0.1"] })),
    ).rejects.toThrow(/私有|SSRF/);
  });

  test("IP 字面量直接判(不经 DNS):内网拒、公网放", async () => {
    const boom = () => Promise.reject(new Error("不该调 DNS"));
    await expect(assertUrlAllowed("http://127.0.0.1/", ON, boom)).rejects.toThrow(/私有|SSRF/);
    await expect(assertUrlAllowed("http://[::1]/", ON, boom)).rejects.toThrow(/私有|SSRF/);
    await assertUrlAllowed("http://93.184.216.34/", ON, boom); // 公网字面量放行
  });

  test("非 http/https 协议 → 拒(即便 SSRF 关闭也拦)", async () => {
    await expect(assertUrlAllowed("file:///etc/passwd", ON)).rejects.toThrow(/http\/https/);
    await expect(
      assertUrlAllowed("file:///x", { enabled: false, allowlist: [] }),
    ).rejects.toThrow(/http\/https/);
  });

  test("SSRF 关闭 → 内网也放行(仅剩协议校验)", async () => {
    await assertUrlAllowed(
      "http://127.0.0.1/",
      { enabled: false, allowlist: [] },
      () => Promise.reject(new Error("不该调 DNS")),
    );
  });

  test("白名单:命中(含子域)放行、未命中拒", async () => {
    const cfg: SsrfConfig = { enabled: true, allowlist: ["example.com"] };
    const lk = fakeLookup({ "example.com": ["93.184.216.34"], "api.example.com": ["93.184.216.34"] });
    await assertUrlAllowed("https://example.com", cfg, lk);
    await assertUrlAllowed("https://api.example.com", cfg, lk); // 子域
    await expect(assertUrlAllowed("https://evil.com", cfg, lk)).rejects.toThrow(/白名单/);
  });

  test("白名单比的是域名字符串:IP 字面量(哪怕正是该域名的 IP)不命中 → 拒", async () => {
    const cfg: SsrfConfig = { enabled: true, allowlist: ["example.com"] };
    const boom = () => Promise.reject(new Error("不该调 DNS")); // 白名单在解析前先拦
    // 93.184.216.34 是 example.com 的 IP,但白名单比对主机名字符串,IP 字面量 ≠ "example.com"
    await expect(assertUrlAllowed("http://93.184.216.34/", cfg, boom)).rejects.toThrow(/白名单/);
    // 子域后缀不能被「凑」出来:notexample.com 不该命中 example.com
    await expect(
      assertUrlAllowed("https://notexample.com", cfg, fakeLookup({ "notexample.com": ["93.184.216.34"] })),
    ).rejects.toThrow(/白名单/);
  });
});

// ============ 集成:httpRequestTool 重定向逐跳复校 ============
describe("SSRF:重定向逐跳复校(httpRequestTool)", () => {
  const saved = process.env.AGENT_HTTP_SSRF;
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_HTTP_SSRF;
    else process.env.AGENT_HTTP_SSRF = saved;
  });

  test("公网 URL 302 跳到内网 → 被拦(不 fetch 内网)", async () => {
    delete process.env.AGENT_HTTP_SSRF; // 开启 SSRF(免被 tools.test 的 =0 串味)
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (u: any) => {
      seen.push(String(u));
      // 首个(公网 IP 字面量)返回 302 → 内网
      return new Response("", { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } });
    }) as unknown as typeof fetch;
    try {
      await expect(
        // 首 URL 用公网 IP 字面量:免真 DNS;跳转目标是内网字面量 → 复校时被拦。
        httpRequestTool.run({ url: "http://93.184.216.34/redir" }),
      ).rejects.toThrow(/私有|SSRF|127/);
      expect(seen).toEqual(["http://93.184.216.34/redir"]); // 只发了首个,内网那跳没发出去
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
