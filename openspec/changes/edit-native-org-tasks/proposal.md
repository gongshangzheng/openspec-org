# Proposal

## Why

当前 Org 工作流已能只读查看任务、进度和下一项，但仍缺乏原生任务写入能力。用户和 agent 在调整范围、补充条目、清理冗余任务、调整执行顺序或拆分任务时，只能手改 `tasks.org`，缺少文件锁、快照校验、依赖防呆与预览确认机制，容易破坏已有证据或打乱依赖顺序。

## What Changes

- 扩展 Org 任务读取契约：识别英文特殊子节别名（`Description`、`Acceptance Criteria`、`Evidence`），对同一任务下的重复特殊子节以及非证据区内的直接嵌套 `TODO`/`DONE` 子任务给出明确报错。
- 在 CLI 中建立跨平台文件锁、不可变原始快照校验、预览与真实确认分离，以及安全原子写机制，确保预览、取消与报错均不修改磁盘，并保留 BOM、换行符（LF/CRLF）、文件头、行内标记和历史证据。
- 新增原生任务写命令：`openspec task create`、`edit`、`remove`、`reorder`、`move` 与 `split`（均支持 `--change`、`--json`、`--store`），统一支持分组路径寻址、同组非连续重排、跨组子树级移动、依赖顺序校验与受保护的移除和拆分。
- 将 `schemas/spec-driven-org/templates/tasks.org` 对齐为默认生成 `** 描述` 与 `** 验收标准`，并同步更新命令补全注册表、`STORE_SELECTION_GUIDANCE`、`skills/` 及对应校验哈希。
- 本轮不做追加式验收证据写入、`CRITERIA_SHA256` 门禁或 `TODO`/`DONE` 状态切换（留待切片 2c），不做 `sync`/`archive`、宿主适配，也不泛化自定义派生 Org schema（阶段 1–2 仅支持内建 `spec-driven-org`）。

## Capabilities

### New Capabilities

- `org-task-editing`：提供原生 `tasks.org` 的加锁原子写、预览确认，以及任务的创建、编辑、受保护移除、同组重排、跨组移动和拆分。

### Modified Capabilities

- `org-task-reading`：兼容英文特殊子节别名，并在读取阶段拒绝任务内重复特殊子节与直接嵌套子任务。

## Impact

复用切片 2a 的 `org-tasks` 读取模型与现有的文件状态、交互确认基础能力。新增集中的任务写入与预览引擎，接入 `src/commands/task.ts` 与 CLI 补全/技能同步链路，并为后续切片 2c 的证据与状态门禁提供同一套锁、快照与原子写底座。
