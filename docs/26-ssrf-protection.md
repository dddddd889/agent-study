# 第 26 步：http_request 的 SSRF 防护

> 第 25 步用执行沙箱**禁网**堵住了 `shell` 的外连。但 agent 还有**第二条联网出口**：`http_request`——它是 agent **自己进程的 `fetch`**，不是子进程，执行沙箱碰不到它。现状它只挡了非 http(s) 协议，`fetch(url)` 直接发，没校验目标 IP、跟随重定向、无超时。这一步给它加 SSRF 防护，安全线才闭环。

## 核心：校验「解析后的 IP」，不是主机名字符串

只看 URL 字符串（拦 `localhost`、`10.`）必漏：

- `http://evil.com` 能 DNS 解析到 `127.0.0.1`；
- `http://2130706433/`（十进制）、`http://0x7f000001/`（十六进制）绕过正则。

所以发请求前**先自己 DNS 解析**，把解析出的**所有 IP** 逐个对私有/保留段黑名单校验，命中即拒。校验**解析结果**→ 混淆 IP 被解析器归一、域名指向内网也拦得住。

[src/ssrf.ts](../src/ssrf.ts)：

| 函数 | 职责 |
|---|---|
| `isPrivateIp(ip)` | 纯函数:IP 转整数/BigInt，对 IPv4+IPv6 私有/保留 CIDR 逐段比对 |
| `isIpLiteral(host)` | host 是否为 IP 字面量（是则跳过 DNS 直接判） |
| `assertUrlAllowed(url, cfg, lookup?)` | 异步:协议 → 白名单 → IP 校验;不放行即抛 |
| `ssrfConfig()` | 读 `AGENT_HTTP_SSRF` / `AGENT_HTTP_ALLOWLIST` |

## 黑名单拦哪些（IPv4 + IPv6）

用 **CIDR 整数/前缀比较**（不是字符串前缀，`10.` 会误伤 `104.x`）：

- **IPv4**：`0/8`、`10/8`、`100.64/10`(CGNAT)、`127/8`(loopback)、`169.254/16`(link-local，**含云元数据 `169.254.169.254`**)、`172.16/12`、`192.168/16`、`224/4`(组播)、`240/4`(保留)。
- **IPv6**：`::`、`::1`、`fc00::/7`(ULA)、`fe80::/10`(link-local)。
- **IPv4-mapped**（`::ffff:127.0.0.1`）：抠出内嵌 IPv4 再按 IPv4 规则判——否则是个大绕过口。
- **认不出的地址** → 保守当私有拒（fail-safe）。

## 两类威胁：SSRF vs 数据外泄

黑名单只解 **SSRF**（打内网/元数据）。**外泄到公网**（把密钥 POST 到 `attacker.com`）是另一类——黑名单放行公网（否则 agent 没法查文档/调 API），所以外泄默认由**审批**兜（`http_request` 是 `exec` 类，default 模式每次发请求都问）。

要**硬防**外泄，开可选**白名单** `AGENT_HTTP_ALLOWLIST=api.github.com,example.com`：只放行名单内 host（含子域），其余含公网一律拒。默认空=不启用。

## 重定向逐跳复校

`fetch` 默认自动跟随重定向，公网 URL 可 `302 → 169.254.169.254` 绕进内网。所以用 `redirect:"manual"` **自己跟**，每收到 3xx 就把 `Location` **重新过一遍 `assertUrlAllowed`**，通过才继续，跳数上限 5 防环。否则拦了首 URL、跳转又放进来，等于白做。

## 超时 + 中断合并

现在还合并了超时与用户中断：`AbortSignal.any([AbortSignal.timeout(ms), ctx.signal])`——超时（默认 `AGENT_HTTP_TIMEOUT=30000`）或 Ctrl+C **任一触发即断**。

## 已知局限：DNS 重绑定

「解析+校验一次，再正常 `fetch`」有 TOCTOU 残留：攻击者控 `evil.com` 的 DNS、两次解析给不同 IP（校验时公网、fetch 实连时内网）。彻底堵要把连接**钉在已校验 IP** 上，但按 IP 连会让 **HTTPS 证书/SNI 校验崩**、Bun fetch 也不好塞 servername——对教学项目不划算。故本步覆盖现实里绝大多数 SSRF（静态指向内网/混淆 IP/`localhost`），主动重绑定**诚实标注为局限**（要 A 级需换底层能控 DNS 的 HTTP 客户端）。

## 开关（env）

- `AGENT_HTTP_SSRF=0`：关 SSRF 校验（本地连 `localhost` 自测时用）。默认开。
- `AGENT_HTTP_ALLOWLIST=h1,h2`：可选白名单（防外泄），默认空。
- `AGENT_HTTP_TIMEOUT=30000`：请求超时 ms。

## 安全线全景（第 23→26 步）

| 出口 / 面 | 机制 | 步 |
|---|---|---|
| 文件路径（读写工具） | 路径沙箱（词法限 cwd） | 23 |
| shell 子进程 | 执行沙箱（OS 级:写限 cwd + 禁网） | 25 |
| **agent 自身 HTTP** | **SSRF 防护（解析后 IP 黑名单）** | **26** |
| 要不要执行 | 权限模式（问/拒/放） | 24 |

## 测试（`bun test`，离线）

[tests/ssrf.test.ts](../tests/ssrf.test.ts)：
- **纯函数**：`isPrivateIp` 各私有/保留段命中、公网放行、`::ffff:127.0.0.1`、认不出→保守拒;`isIpLiteral`。
- **`assertUrlAllowed`**（注入假 lookup + 显式 cfg，不碰网络/env）：域名解析到内网→拒、公网→放、多 IP 任一内网→拒、IP 字面量不经 DNS、非 http(s)→拒、SSRF 关闭仅剩协议校验、白名单命中/子域/未命中。
- **重定向逐跳复校**（mock fetch）：公网 URL `302` 跳内网 → 被拦，且内网那跳**没发出去**。

（`tools.test.ts` 的 http 用例测传输行为，设 `AGENT_HTTP_SSRF=0` 免真 DNS。）

## 下一步

- **DNS 重绑定的 A 级防护**（连接钉 IP，需换 HTTP 客户端）。
- **可配置沙箱策略档位**（workspace-write / read-only / full-access，与权限模式联动）。
- 路径沙箱的**符号链接逃逸防护**（第 23 步 TODO）。
