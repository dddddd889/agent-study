# 分诊标签（Triage Labels）

各个 skill 用五个「标准分诊角色」来描述一个 issue 的状态。本文件把这些角色映射到本仓库 issue 跟踪器里实际使用的标签字符串。

| skill 中的角色      | 本仓库的标签        | 含义                         |
| ------------------- | ------------------- | ---------------------------- |
| `needs-triage`      | `needs-triage`      | 维护者需要评估这个 issue     |
| `needs-info`        | `needs-info`        | 等待提交者补充更多信息       |
| `ready-for-agent`   | `ready-for-agent`   | 已完整描述，可交给 AFK agent |
| `ready-for-human`   | `ready-for-human`   | 需要人来实现                 |
| `wontfix`           | `wontfix`           | 不予处理                     |

当某个 skill 提到一个角色时（例如「打上 AFK-ready 分诊标签」），就使用上表里对应的标签字符串。

对于本仓库的「本地 markdown」跟踪器，「标签」写成每个 issue 文件顶部附近的一行 `Status:`。右侧一列可按你实际使用的词汇自行修改。
