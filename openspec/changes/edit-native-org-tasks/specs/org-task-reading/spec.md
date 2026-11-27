# Spec Delta

## MODIFIED Requirements

### Requirement: 原生 Org 任务读取

CLI SHALL 按变更选定的工作流定位 `tasks.org`，并提供只读的任务列举和按 `TASK_ID` 查看功能。文本和 JSON 输出都不得写入任务文件或生成 Markdown 投影。

#### Scenario: 查看分组下的任务

- **GIVEN** `tasks.org` 有分组、`TODO` 和 `DONE` 任务、正文和直属验收标准
- **WHEN** 用户列出任务或按 ID 查看其中一项
- **THEN** 列表按文档顺序返回任务 ID、状态和标题
- **AND** 查看单项时默认返回任务正文和验收标准，以及依赖 ID 和源位置
- **AND** 正文既可直接写在任务标题下，也可放在描述子节；源文本的 Org 行内标记不被改写

#### Scenario: 缺少选定的任务文件

- **GIVEN** 一个 Org change 只有 `tasks.md`，没有 `tasks.org`
- **WHEN** 用户列举或查看 Org 任务
- **THEN** CLI 明确报告缺少 `tasks.org`，不读取 `tasks.md`，也不创建任何文件

#### Scenario: 任务 ID 无法唯一定位

- **GIVEN** 两个任务使用相同的 `TASK_ID`
- **WHEN** 用户按该 ID 查看任务
- **THEN** CLI 报告 ID 冲突及源位置，不任意选择其中一项

#### Scenario: Windows 上定位任务来源

- **GIVEN** 一个 Windows 项目的 Org 任务文件使用 CRLF，且命令从仓库子目录运行
- **WHEN** 用户查看任务详情
- **THEN** CLI 报告所属 change 的任务文件路径和正确行号
- **AND** macOS 或 Linux 上用等价文件可得到相同的任务 ID、状态和行号

#### Scenario: 兼容英文结构子节别名

- **GIVEN** 任务使用 `Description`、`Acceptance Criteria` 或 `Evidence` 作为直属子节标题
- **WHEN** 用户读取或查看该任务
- **THEN** CLI 按与 `描述`、`验收标准`、`验收结果` 相同的语义映射它们，并保留原始行内标记和证据原文

#### Scenario: 拒绝重复的特殊子节

- **GIVEN** 同一任务下包含两个 `验收标准`/`Acceptance Criteria` 或两个 `验收结果`/`Evidence` 子节
- **WHEN** CLI 读取该任务文件
- **THEN** CLI 报告重复子节诊断与源行号，不静默覆盖前者

#### Scenario: 拒绝任务下直接嵌套子任务

- **GIVEN** 某条任务下在非证据区且非源码/示例区块内包含子级 `TODO` 或 `DONE` 标题
- **WHEN** CLI 读取该任务文件
- **THEN** CLI 报告嵌套任务冲突与源行号，不把它当作独立任务或自定义小节
- **AND** 位于 `验收结果` 或 `Evidence` 子节内的记录标题仍按历史证据原文保留
