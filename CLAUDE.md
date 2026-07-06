# CLAUDE.md

Claude Code 在本仓库工作时的项目指引。说中文。

## Agent skills

### 复杂任务

请多开几个子agent并行开发。

### Issue 跟踪器

issue 和 PRD 以本地 markdown 形式存放在 `.scratch/<feature-slug>/` 下。详见 `docs/agents/issue-tracker.md`。

### 分诊标签

五个标准角色，使用默认名称（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。详见 `docs/agents/triage-labels.md`。

### 领域文档

单上下文：根目录的 `CONTEXT.md` + `docs/adr/`。详见 `docs/agents/domain.md`。
