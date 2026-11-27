# Proposal

## Why

可选 Org 工作流已经能发现和校验 Org 规划制品，但任务进度仍依赖 Markdown checkbox。用户和 agent 需要直接从同一份 `tasks.org` 查看内容、进度和下一步，不能靠生成另一份清单才能工作。

## What Changes

- 新增 Org 任务的只读 CLI 入口：列举任务、按 `:TASK_ID:` 查看任务，以及查询下一项；提供文本和 JSON 输出。查看单项时可用 `--sections` 选择描述、验收标准、历史证据或自定义小节。
- 让变更列表与 apply 指令复用同一套 Org 任务读取结果。按 change 自身的 schema 读取，不用另一种格式补缺；默认 Markdown 行为和输出保持不变。
- Org 按文档顺序推进，不按 `TASK_ID` 的数字排序。不跳过前面的未完成任务；显式依赖没满足时，报告阻塞和前置任务 ID。
- 不做任务文件写入、重排、跨组移动、拆分、验收证据的写入或完成门禁；不改 sync/archive 和宿主适配。

## Capabilities

### New Capabilities

- `org-task-reading`：从原生任务文件读出任务、依赖与源位置，并给出只读的下一项判断。

### Modified Capabilities

- `cli-list`：按工作流为 change 列表计算进度。
- `cli-artifact-workflow`：Org apply 指令公开原生任务、进度和下一步，不依赖 Markdown 投影。

## Impact

复用现有 schema 和任务文件定位。新增 Org 任务读取器和只读 CLI 入口，接入已有变更列表与 apply 指令，并补充两种工作流的回归测试。后续写操作使用同一任务模型；本轮不引入锁或写入接口，也不修改旧扩展。
