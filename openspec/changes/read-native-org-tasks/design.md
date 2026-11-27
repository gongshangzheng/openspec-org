# Design

## Context

上一轮已提供 `spec-driven-org` 和 Org 规格读取。`src/utils/task-progress.ts` 能按 schema 解析追踪文件，但只计算 Markdown checkbox，找不到文件时还会用 `tasks.md` 补算。apply 指令在 `src/commands/workflow/instructions.ts` 单独解析 checkbox。若两处各自增加 Org 解析，进度和下一项可能相互矛盾。

## Goals / Non-Goals

本轮只读 `tasks.org`，让 CLI 的任务查询、变更列表和 apply 指令共享任务状态和顺序。不添加任务写操作、持久化依赖变更、重排、验收证据判定、归档或宿主适配；源文件中的 `DONE` 用于显示进度，不等同于后续写入或归档验收通过。

## Decisions

### 原生读取，不做投影

在已存在的 `src/core/parsers/` 新增 `org-tasks.ts`，对应测试放在 `test/core/parsers/org-tasks.test.ts`。用最小的 Org 标题和属性读取能力识别任务、直属子节和原始行号；与 `org-structure.ts` 共用能直接复用的结构能力，避免重写规格解析。只读参考旧 Tangwen 的 `parse.ts`，不迁入宿主绑定、结构写入或兼容层。

任务用标题状态和 `:TASK_ID:` 标识；支持分组、直接正文、描述子节和直属 `验收标准`。读取器也保留直属 `验收结果` 的原文以及自定义小节的标题和正文；不会把证据区中的子标题算成任务，也不会判定证据有效性。`DEPENDS_ON` 沿用现有以逗号分隔的 ID 表示。保持文档顺序和行内标记；不为标题或 `org-num-mode` 显示编号补写 ID。重复 ID 报告冲突，不挑一个继续；缺失的依赖 ID 在查询下一项时明确报告。

### 文档顺序决定候选项

读取 `next` 时先找文档中第一条不是 `DONE` 的任务。对该任务检查显式依赖，未完成或未知的前置 ID 导致 `blocked`，不跳到后面的任务。没有条目是空清单；有条目且全部 `DONE` 才是 `all_done`。后续移动操作将用同一顺序规则验证结构，这次不实现移动。

### 接入既有的 planning home 和 CLI

在 `src/utils/task-progress.ts` 复用现有 schema 选择和 artifact 输出解析，增加 Org 任务读取入口：调用方拿到同一份任务、进度和下一项结果。Org 不走缺文件时的 Markdown 回退。保留 Markdown 路径和接口；接入 `src/core/list.ts`、`src/commands/change.ts` 的列表读取及 `src/commands/workflow/instructions.ts` 的 apply 读取。归档的任务门禁本轮不接入新行为；它仍由后续 change 定义。

在 `src/commands/task.ts` 新增只读入口，通过 `src/cli/index.ts` 挂载 `openspec task list --change <id>`、`openspec task show <task-id> --change <id>` 和 `openspec task next --change <id>`。沿用现有 `--json`、`--store` 和 root 解析惯例；对非 Org change 说明此入口只用于 Org，不做推断或转换。内建 apply 在保留现有制品缺失门禁的前提下，返回与 `task next` 一致的 Org 判断。

只在 `task show` 提供 `--sections`。未指定时选择 `description,criteria`；显式指定时选择对应的小节，`all` 单独使用。先校验选项，再构造一份筛选后的详情供文本和 JSON 共用，排除未选中的小节；固定的任务信息不参与筛选。`task list` 继续返回摘要，不把证据带进列表。

使用 Node `path` 和已有的路径约束解析路径。源位置走已解析的 artifact 路径与 1-based 行号；CRLF 不改变行号或 ID。保持默认 Markdown 的输出字段、checkbox 识别和行为不变。

## Verification and File Ownership

严格串行：进度和 CLI 查询共用第 1 步的任务模型；apply 需要第 2 步的 schema 感知读取。此轮不设并行任务。

1. `src/core/parsers/{org-tasks,org-structure}.ts` 与 `test/core/parsers/org-tasks.test.ts`：核对分组、两种正文形式、验收标准、证据原文和自定义小节，以及 ID/依赖和源行号；验证重复 ID、文档顺序、阻塞、空列表和全部完成。
2. `src/utils/task-progress.ts`、`src/core/list.ts`、`src/commands/change.ts` 和 `test/utils/task-progress.test.ts`：验证同一项目中 Markdown 与 Org change 都按选定文件计算，缺失 Org 文件时不采用 Markdown 清单，现有 Markdown 输出不变。
3. `src/cli/index.ts`、`src/commands/task.ts`、`src/commands/workflow/instructions.ts`，以及 `test/commands/org-task-reading.test.ts` 和 `test/commands/apply-instructions-tasks.test.ts`：用实际 CLI 核对列表、单项、下一项与 apply 的文本和 JSON；覆盖默认详情、选定小节、`all`、非法选项与固定元数据，并断言无写入。
4. `test/cli-e2e/org-task-reading.test.ts` 和现有 `.github/workflows/ci.yml`：用 Windows 与 Unix 的同一套旅程验证 CRLF、子目录定位和 Markdown 回归，记录两端 CI 证据。

## Risks / Trade-offs

- 读取 `DONE` 只表明文件的状态，不证明当前标准已有合格证据。避免把只读进度用于放行 Org 归档。
- 任务能出现数字顺序与文件顺序不一致。输出保留原 ID，验证显式依赖不被数字排序替代。

## Migration Plan

不迁移已有文件，不改 Markdown 项目配置。Org change 在本轮之后可使用只读 CLI，无须 `tasks.md` 投影；原生写入另行交付。
