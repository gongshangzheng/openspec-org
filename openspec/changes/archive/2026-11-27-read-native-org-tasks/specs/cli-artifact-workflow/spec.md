# Spec Delta

## ADDED Requirements

### Requirement: Org apply 指令使用原生任务

Org change 的 apply 指令 SHALL 从 schema 追踪的 `tasks.org` 返回任务和进度，并按与任务查询相同的规则报告下一项。任务进度和规划制品是否齐全是不同的状态。

#### Scenario: 返回进度与下一项

- **GIVEN** Org change 已具备 apply 所需制品，`tasks.org` 有已完成和未完成的任务
- **WHEN** 用户执行 `openspec instructions apply --change <id>`
- **THEN** 指令列出任务、进度和下一项，与只读任务命令的结果一致
- **AND** JSON 指出原生 `tasks.org` 路径，即使目录中同时存在 Markdown 文件也不读取它

#### Scenario: 候选任务受依赖阻塞

- **GIVEN** Org change 已具备 apply 所需制品，但第一条未完成任务有未满足的依赖
- **WHEN** 用户请求 apply 指令
- **THEN** 输出报告被阻塞的任务和前置任务 ID，而不是推荐后项开始执行

#### Scenario: 缺少原生任务文件

- **GIVEN** Org change 缺少 `tasks.org`
- **WHEN** 用户请求 apply 指令
- **THEN** 现有的制品缺失检查保持生效，返回阻塞及预期的 Org 路径

#### Scenario: Markdown apply 保持原样

- **GIVEN** change 使用既有 Markdown 工作流
- **WHEN** 用户请求 apply 指令
- **THEN** 现有 checkbox 进度、输出结构和状态规则不变
