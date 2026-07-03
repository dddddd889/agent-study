# http_request SSRF 防护：校验「解析后 IP」的黑名单 + 逐跳复校

## 决策

给 `http_request` 加 SSRF 防护——它是 agent 自己的 `fetch`（**不在** shell 执行沙箱内，第 25 步只管 shell 子进程），是另一条需独立防护的联网出口。核心：**发请求前先 DNS 解析，校验解析出的所有 IP，命中私有/保留段就拒。**

收口在 `src/ssrf.ts`：
- `isPrivateIp(ip)`（纯函数）：把 IP 转整数/BigInt，对 IPv4+IPv6 的私有/保留 CIDR 逐段比对；IPv4-mapped（`::ffff:a.b.c.d`）抠出内嵌 IPv4 再判。
- `assertUrlAllowed(url, cfg, lookup?)`（异步）：协议校验（仅 http/https）→ 白名单（若启用）→ IP 字面量直接判 / 域名 `dns.lookup(all)` 后逐个判。`lookup` 依赖注入，便于离线测试。
- `httpRequestTool.run`：`redirect:"manual"` **手动跟随重定向、每一跳都复校** URL（含首个）；合并 `AbortSignal.timeout` + 用户 `ctx.signal`。

开关：`AGENT_HTTP_SSRF=0`（关校验，本地连 localhost 自测用）、`AGENT_HTTP_ALLOWLIST=h1,h2`（可选白名单，默认空）、`AGENT_HTTP_TIMEOUT=30000`。

## 为什么这样

- **校验解析后的 IP，而非主机名字符串**：只看字符串（拦 `localhost`/`10.`）必漏——`evil.com` 能解析到 `127.0.0.1`，`http://2130706433/`（十进制）、`http://0x7f000001/`（十六进制）绕过正则。校验**解析结果**：混淆 IP 被解析器归一、域名指向内网也拦得住。

- **黑名单为主 + 可选白名单**：SSRF（打内网）和**数据外泄到公网**是两类威胁。黑名单（拦私有/保留段）解 SSRF、默认开、放行公网（否则 agent 没法查文档/调 API）。公网外泄是另一回事——默认由**审批**兜（`http_request` 是 `exec` 类，default 下每次问）；要硬防则开可选**白名单**（默认空，锁死场景才用）。

- **DNS 重绑定作已知局限**：「解析+校验一次再正常 fetch」有 TOCTOU 残留（攻击者控 DNS、两次解析不同）。彻底堵要把连接**钉在已校验 IP** 上，但按 IP 连会让 HTTPS 的证书/SNI 校验崩、且 Bun fetch 不好塞 servername——对教学项目不划算。故覆盖现实里绝大多数 SSRF（静态指向内网/混淆/`localhost`），主动重绑定诚实标注为局限。

- **重定向逐跳复校**：`fetch` 默认自动跟随，公网 URL 可 `302 → 169.254.169.254` 绕进内网。故 `redirect:"manual"` 自己跟、每跳把 `Location` 重新过一遍校验、设跳数上限（5）防环。否则前面拦了首 URL、跳转又放进来，等于白做。

- **IP 字面量短路**：host 本就是 IP（`127.0.0.1`、`[::1]`）时直接判、跳过 DNS——省一次解析，也让 IP-字面量 URL 的测试可完全离线。

## 边界

- **只管 `http_request`**：shell 的 SSRF 由执行沙箱禁网解（第 25 步）。两条出口两套机制，SSRF 才闭环。
- **DNS 重绑定不防**（见上，已知局限）。
- **白名单是防外泄、不是防 SSRF**：两者正交，可各自开关。
- **无法解析的地址**（异常输入）→ 保守**当私有**拒（fail-safe）。
- 与执行沙箱（ADR-0009）、路径沙箱（ADR-0007）正交，共同构成安全线：路径沙箱管文件路径、执行沙箱管 shell 子进程、SSRF 防护管 agent 自身的 HTTP 出口。
