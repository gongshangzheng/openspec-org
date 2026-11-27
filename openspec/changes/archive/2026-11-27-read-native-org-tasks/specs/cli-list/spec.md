# Spec Delta

## MODIFIED Requirements

### Requirement: Task Counting

变更列表 SHALL 根据各 change 所选工作流计算任务进度。Markdown 继续使用 checkbox；Org 直接读取 `tasks.org` 的任务状态。

#### Scenario: Counting tasks in tasks.md

- **WHEN** Markdown change 的 `tasks.md` 被读取
- **THEN** 沿用现有 checkbox 解析，分别计算完成和未完成的任务数
- **AND** 总数等于两者之和，Markdown 的文本与 JSON 进度表现不变

#### Scenario: 统计 Org 任务而不读取投影

- **GIVEN** 一个 Org change 的 `tasks.org` 中有一条 `DONE` 和两条 `TODO`，旁边还存在 Markdown 清单
- **WHEN** 列出变更
- **THEN** 该 change 的进度为 1/3，且不读取或刷新 Markdown 清单

#### Scenario: 找不到 Org 任务文件

- **GIVEN** 一个 Org change 尚未创建 `tasks.org`
- **WHEN** 列出变更
- **THEN** change 仍可见并显示没有任务，不从其他格式补算进度
