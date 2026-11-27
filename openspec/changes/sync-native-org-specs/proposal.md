# Proposal

## Why

当前 OpenSpec 没有 `openspec sync` CLI 命令，只能靠 agent 依照技能模板手工编辑 `spec.md`，而且内置的 [specs-apply.ts](file:///Users/zhengxinyu/code/openspec-org/src/core/specs-apply.ts) 只支持 Markdown，无法把 Org change 的 `specs/**/spec.org` delta 写回主规格，也不能在写入前拦截跨格式混用。

## What Changes

- 新增 `openspec sync [change-name]` CLI 命令（支持 `--json` 与 `--store <id>`），把当前变更的 delta 同步到 `openspec/specs/` 并保持变更处于活跃状态，同时支持幂等重复执行。
- 扩展 `src/core/specs-apply.ts` 的 delta 对账路径，使其按显式传入的格式分发；新增原生 Org 规格写回模块 `src/core/specs-apply-org.ts`，在新建、`ADDED`、`MODIFIED`、`REMOVED`、`RENAMED` 与 capability 退场时保留文件头（`#+TITLE:`、`#+STARTUP:`）、未改动条款原文、行内标记、代码块与原换行符（LF/CRLF）。
- 扩展 `Validator.validateSpecContent` 支持 Org 规格内容校验，并在写入主规格前严格校验变更工作流与目标主规格工作流的一致性，跨格式不匹配或存在对立格式目标文件时直接拒绝写入。
- 同步更新命令补全注册表、`STORE_SELECTION_GUIDANCE`、`skills/` 及对应校验哈希。
- 本轮不接入 Org `archive` 基于切片 2c 证据的完成门禁，也不把字面量 `spec-driven-org` 泛化为自定义派生 Org schema（均留待切片 3b）；不改动 `tasks.org` 读写路径。

## Capabilities

### New Capabilities

- `cli-sync`：提供 `openspec sync` CLI 命令及格式感知的 delta 对账、原生 Org 保真写回与跨格式写入保护。

## Impact

复用阶段 1 的 `org-structure` 解析器、规划目录与路径包容校验，以及既有的 `specs-apply.ts` delta 语义。本切片文件归属与切片 2b（`edit-native-org-tasks`）的核心任务模块互不重叠，可在独立 worktree 上与 2b 并行推进，为后续切片 3b 复用同一套 Org delta 对账与写回路径打好基础。
