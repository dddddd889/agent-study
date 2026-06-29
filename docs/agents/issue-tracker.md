# Issue 跟踪器：本地 Markdown

本仓库的 issue 和 PRD 都以 markdown 文件形式存放在 `.scratch/` 目录下。

## 约定

- 一个功能一个目录：`.scratch/<feature-slug>/`
- PRD 文件为 `.scratch/<feature-slug>/PRD.md`
- 实现用的 issue 为 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号
- 分诊状态记录在每个 issue 文件顶部附近的一行 `Status:`（角色字符串见 `triage-labels.md`）
- 评论与对话历史追加到文件底部的 `## Comments` 标题下

## 当某个 skill 说「发布到 issue 跟踪器」时

在 `.scratch/<feature-slug>/` 下新建一个文件（目录不存在则先创建）。

## 当某个 skill 说「拉取相关工单」时

读取所引用路径的文件。通常用户会直接给出文件路径或 issue 编号。
