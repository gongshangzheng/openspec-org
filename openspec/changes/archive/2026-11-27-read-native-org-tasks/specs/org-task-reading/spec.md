# Spec Delta

## Purpose

让使用 Org 工作流的人和 agent 直接读取原生任务清单，通过稳定的任务 ID 查到任务细节，并知道按文档顺序接下来该执行哪一项、是哪条依赖挡住了推进。

## ADDED Requirements

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

### Requirement: 选择任务详情的小节

`task show` SHALL 支持 `--sections`，在文本和 JSON 中应用相同的筛选规则。任务 ID、标题、状态、依赖和源位置始终返回，不受小节选择影响。

#### Scenario: 不指定小节

- **WHEN** 用户运行 `task show` 且未提供 `--sections`
- **THEN** 除固定的任务信息外，只返回描述和验收标准

#### Scenario: 只看验收标准和历史证据

- **GIVEN** 任务含描述、验收标准、验收结果和自定义小节
- **WHEN** 用户传入 `--sections criteria,evidence`
- **THEN** 仅返回所选小节和固定的任务信息
- **AND** 已有证据按原文返回，不判断它是否符合当前验收标准

#### Scenario: 查看所有小节

- **WHEN** 用户传入 `--sections all`
- **THEN** 返回描述、验收标准、已有验收结果及自定义小节
- **AND** 自定义小节保留原来的标题和正文

#### Scenario: 选项不合法

- **WHEN** `--sections` 含 `description`、`criteria`、`evidence`、`custom` 以外的值，且不是单独的 `all`
- **THEN** CLI 报告无效选择，列出可用值，不静默忽略

### Requirement: 下一项遵循文档和依赖顺序

CLI SHALL 以文件中第一条未完成的 Org 任务作为下一项候选。`TASK_ID` 仅用于引用；依赖未满足时不得跳过候选任务推进后项。

#### Scenario: 文档位置优先于 ID

- **GIVEN** 未完成的 `3.2` 在未完成的 `1.1` 前，且 `3.2` 没有未满足的依赖
- **WHEN** 用户查询下一项
- **THEN** CLI 返回 `3.2`，不按 ID 数字重新排序

#### Scenario: 前置任务阻塞推进

- **GIVEN** 第一条未完成任务依赖一个尚未完成的任务
- **WHEN** 用户查询下一项
- **THEN** CLI 报告 `blocked`，标明候选任务和未完成的前置任务 ID
- **AND** 不推荐后面任何任务；若引用的 ID 不存在，明确说明它不存在

#### Scenario: 清单已完成

- **GIVEN** 有任务的清单中所有任务均为 `DONE`
- **WHEN** 用户查询下一项
- **THEN** CLI 报告 `all_done`，不返回下一项

#### Scenario: 清单尚无任务

- **GIVEN** 原生任务文件存在但没有任务条目
- **WHEN** 用户查询下一项
- **THEN** CLI 报告清单为空，不把它当作已完成的任务计划
