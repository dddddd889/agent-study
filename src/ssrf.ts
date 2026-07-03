import { lookup as dnsLookup } from "node:dns/promises";

// 第 26 步:http_request 的 SSRF 防护 —— 校验【解析后的 IP】而非主机名字符串。
// 见 docs/26、ADR-0010。http_request 是 agent 自己的 fetch(不在 shell 执行沙箱内),
// 是另一条需独立防护的联网出口。发请求前先 DNS 解析,把解析出的所有 IP 逐个对私有/保留段
// 黑名单校验,命中即拒。校验解析结果 → 免疫十进制/十六进制混淆 IP、域名指向内网。

// ---- IP 解析(纯函数)----

// "a.b.c.d" → 32 位无符号整数;非合法 IPv4 返回 null。
function ipv4ToInt(s: string): number | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1, 5).map(Number);
  if (p.some((n) => n > 255)) return null;
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

// IPv6 字符串 → 128 位 BigInt;非合法返回 null。处理 :: 压缩与内嵌 IPv4 尾(::ffff:1.2.3.4)。
function ipv6ToBigInt(input: string): bigint | null {
  const ip = input.split("%")[0]!; // 去掉 zone id(%eth0)
  if (!ip.includes(":")) return null;

  // 末组是点分 IPv4(如 ::ffff:1.2.3.4)→ 换成两个十六进制组。
  let s = ip;
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    s = ip.slice(0, lastColon + 1) +
      ((v4 >>> 16) & 0xffff).toString(16) + ":" + (v4 & 0xffff).toString(16);
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];

  let groups: string[];
  if (halves.length === 1) {
    if (left.length !== 8) return null; // 无 :: 必须恰好 8 组
    groups = left;
  } else {
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null; // :: 至少代表一组 0
    groups = [...left, ...Array(missing).fill("0"), ...right];
  }
  if (groups.length !== 8) return null;

  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

// 该 host 字符串是否是 IP 字面量(IPv4 或 IPv6)——是则无需 DNS,可直接判。
export function isIpLiteral(host: string): boolean {
  return ipv4ToInt(host) !== null || ipv6ToBigInt(host) !== null;
}

// ---- 私有/保留段黑名单 ----

// [基址整数, 前缀位数]。
const V4_BLOCKS: [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10(CGNAT)
  [0x7f000000, 8], // 127.0.0.0/8(loopback)
  [0xa9fe0000, 16], // 169.254.0.0/16(link-local,含云元数据 169.254.169.254)
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xe0000000, 4], // 224.0.0.0/4(组播)
  [0xf0000000, 4], // 240.0.0.0/4(保留)
];

const V6_BLOCKS: [bigint, number][] = [
  [0n, 128], // :: 未指定
  [1n, 128], // ::1 loopback
  [0xfc00n << 112n, 7], // fc00::/7(unique-local 唯一本地地址)
  [0xfe80n << 112n, 10], // fe80::/10(link-local 链路本地地址)
];

function matchV4(ip: number): boolean {
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

function matchV6(ip: bigint): boolean {
  return V6_BLOCKS.some(([base, bits]) => {
    const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
    return (ip & mask) === (base & mask);
  });
}

// 一个 IP 是否落在私有/保留段(该拒)。IPv4-mapped(::ffff:a.b.c.d)抠出内嵌 IPv4 再判。
// 无法解析的地址 → 保守当作私有(fail-safe,拒)。
export function isPrivateIp(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return matchV4(v4);

  const v6 = ipv6ToBigInt(ip);
  if (v6 === null) return true; // 认不出 → 保守拒
  if (v6 >> 32n === 0xffffn) return matchV4(Number(v6 & 0xffffffffn)); // ::ffff:0:0/96
  return matchV6(v6);
}

// ---- URL 放行校验 ----

export interface SsrfConfig {
  enabled: boolean; // AGENT_HTTP_SSRF !== "0"
  allowlist: string[]; // AGENT_HTTP_ALLOWLIST(逗号分隔),空=不启用
}

// 【校验时】现取,便于测试用 env 切换。
export function ssrfConfig(): SsrfConfig {
  return {
    enabled: process.env.AGENT_HTTP_SSRF !== "0",
    allowlist: (process.env.AGENT_HTTP_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function hostInAllowlist(host: string, list: string[]): boolean {
  const h = host.toLowerCase();
  return list.some((e) => {
    const entry = e.toLowerCase();
    return h === entry || h.endsWith("." + entry); // 精确或子域
  });
}

// 解析函数(依赖注入,默认真实 dns.lookup;测试塞假解析)。
export type LookupFn = (host: string) => Promise<{ address: string }[]>;
const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true });

// 校验一个 URL 是否放行(协议 + SSRF + 可选白名单);不放行即抛(交 Agent 转 is_error)。
// 每一跳重定向都要调它(含首个 URL)。
export async function assertUrlAllowed(
  url: string,
  cfg: SsrfConfig,
  lookup: LookupFn = defaultLookup,
): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`非法 URL：${url}`);
  }
  // 协议校验先于 SSRF 开关:即便关了 SSRF,也只允许 http/https(挡 file:// 等)。
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`只允许 http/https URL：${url}`);
  }
  if (!cfg.enabled) return; // SSRF 校验关闭(AGENT_HTTP_SSRF=0)

  const host = u.hostname.replace(/^\[|\]$/g, ""); // 去 IPv6 方括号

  // 白名单启用时:host 必须在名单内。
  if (cfg.allowlist.length > 0 && !hostInAllowlist(host, cfg.allowlist)) {
    throw new Error(
      `拒绝：${host} 不在 AGENT_HTTP_ALLOWLIST 白名单内`,
    );
  }

  // IP 字面量直接判(无需 DNS);域名则解析后逐个 IP 判。
  if (isIpLiteral(host)) {
    if (isPrivateIp(host)) throw blocked(host, host);
    return;
  }

  let addrs: { address: string }[];
  try {
    addrs = await lookup(host);
  } catch {
    throw new Error(`拒绝：无法解析主机 ${host}`);
  }
  if (!addrs.length) throw new Error(`拒绝：主机 ${host} 无解析结果`);
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw blocked(host, address);
  }
}

function blocked(host: string, ip: string): Error {
  return new Error(
    `拒绝：${host} 解析到私有/保留地址 ${ip}（疑似 SSRF）;确需访问设 AGENT_HTTP_SSRF=0`,
  );
}
