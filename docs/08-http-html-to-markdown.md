# 第 8 步：http_request 把 HTML 转成 Markdown

> 这是对第 3 步 [`http_request`](03-builtin-tools.md) 工具的增强。
> 起因:`http_request` 原样返回网页 HTML —— 满屏 `<div>`、`<script>`、内联样式,既是噪音又费 token。这一步让它**自动判断响应类型,是 HTML 就先转成 Markdown 再返回**。

## 行为

| 响应 `Content-Type` | 处理 | 返回 |
|---|---|---|
| 含 `text/html` | HTML → Markdown | `HTTP 200 (已转为 Markdown)\n\n# 标题…` |
| 其它(JSON / 纯文本 …) | 原样 | `HTTP 200\n\n{...}` |

判断只看响应头:`(content-type ?? "").includes("text/html")`。绝大多数站点都老实返回 `text/html; charset=...`,够用;嗅探 body 作为兜底价值有限,没做。

## 转换:极简、零依赖([src/tools.ts](../src/tools.ts) `htmlToMarkdown`)

本项目的招牌是**零运行时依赖**(README:「直接用原生 fetch」)。所以没引入 `turndown` 之类的库,也没用 Bun 专有的 `HTMLRewriter`(那会绑死 Bun、失去 Node 兼容),而是手写一个几十行的正则转换器。流程:

1. **删噪音**:HTML 注释、`<script>` / `<style>` / `<head>`。
2. **结构转 markdown**:`<h1-6>`→`#`、`<a href>`→`[文本](链接)`、`<li>`→`- `、`<p>/<div>/<br>`→换行、`<strong>/<b>`→`**`、`<pre>/<code>`→代码块/行内码。
3. **剥掉其余所有标签**。
4. **解码常见实体**(`&amp; &lt; &gt; &quot; &#39; &nbsp;`)——在剥完标签之后做,避免把 `&lt;` 误当成标签。
5. **压空白**:行尾空白去掉、连续 3+ 空行压成 2。

### 诚实地说清局限

正则解析 HTML 天生脆,对嵌套深 / 畸形的页面会有瑕疵;而且**没做正文提取**(readability)—— 导航、页脚、广告仍会混进结果。但对"砍掉网页噪音、省 token"这个目标,已经能去掉一大半垃圾。

## 先转后截

工具结果统一截断到 ~10k 字符。顺序是**先转 markdown、再截断** —— 这样 10k 额度装的是"干货 markdown"而不是"半截 HTML",同样额度能塞进多得多的有效内容。

## 测试(`bun test`)

[tests/tools.test.ts](../tests/tools.test.ts):

- `htmlToMarkdown` 纯函数单测:标题/链接转换、删 `<script>/<style>`、解码实体、列表与加粗。
- `http_request`:`text/html` → 返回 markdown(带「已转为 Markdown」标记、不含原始标签、script 被删);`application/json` → **原样返回**,不转换、不加标记。

> 也用真实页面验证过:抓 `https://example.com` → 返回 `# Example Domain` + `[Learn more](…)` 的干净 markdown。

## 留下的 TODO

1. **正文提取(readability)**:去掉导航/页脚/广告,只留主内容 —— 质量提升的大头。
2. 用 `turndown`(加依赖)或 Bun `HTMLRewriter`(绑 Bun)做**健壮解析**,替代脆弱的正则。
3. 表格 / 图片(`<img>`→`![alt](src)`)等精细处理。
4. (延续第 7 步)`http_request` 超时。

## 下一步

1. **持久化**:把 `history` 存盘,跨进程续聊
2. **摘要压缩**:上下文管理从"截断"升级为"先摘要再丢"
