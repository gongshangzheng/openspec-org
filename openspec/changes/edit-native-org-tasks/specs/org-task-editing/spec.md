# Spec Delta

## Purpose

让 Org 工作流通过 CLI 安全地新建、编辑、移除、重排、跨组移动和拆分原生任务，在保留文件格式、历史证据和依赖约束的前提下，确保结构变更经过真实预览与用户确认才落盘。

## ADDED Requirements

### Requirement: 原生 Org 任务安全写入与预览确认

CLI SHALL 对 `tasks.org` 写操作实施文件锁、原始快照校验与原子写；结构变更必须经过真实预览与确认后才能写入，且 `previewHash` 本身不构成用户同意。

#### Scenario: 预览与文本/结构编辑分离

- **GIVEN** Org change 已存在 `tasks.org`
- **WHEN** 用户对文本编辑或结构变更（`create`、`remove`、`reorder`、`move`、`split`）传入 `--preview`
- **THEN** CLI 返回拟更改内容、变更摘要和当前快照对应的 `previewHash`
- **AND** 不获取写锁也不改写磁盘文件

#### Scenario: 结构变更必须经真实确认后落盘

- **GIVEN** 用户执行结构变更命令但未传入 `--preview`
- **WHEN** 运行处于交互式 TTY 且用户在提示中确认，或处于非交互模式且同时提供显式确认参数与匹配的 `--preview-hash`
- **THEN** CLI 持锁复核磁盘快照未漂移后原子写入 `tasks.org`
- **AND** 若仅提供 `--preview-hash` 而缺少确认参数、用户取消提示或文件自预览后被改动，CLI 拒绝写入并保持文件字节不变

#### Scenario: 持有超时锁与跨平台原子替换

- **GIVEN** 任务锁已被占用超过超时时间，或在 Windows 上使用含 CRLF 与 BOM 的 `tasks.org`
- **WHEN** 用户执行任务写入
- **THEN** 锁超时时 CLI 明确报错并附带锁持有者与创建时间信息，不强行删锁
- **AND** 写入成功后保留原 BOM、主导换行符与文件头，仅改动目标任务片段，且拒绝用于非 `spec-driven-org` change

### Requirement: 新建与编辑原生 Org 任务

CLI SHALL 提供 `task create` 与 `task edit`，默认生成中文规范子节，并在编辑时完整保留任务的完成状态与历史证据。

#### Scenario: 新建任务与默认结构

- **GIVEN** 用户调用 `openspec task create --change <id>` 指定标题、唯一 `:TASK_ID:`、可选目标分组、插入位置与依赖
- **WHEN** 经过预览并确认写入
- **THEN** CLI 在目标位置插入 `TODO` 任务，包含 `:PROPERTIES:`、`** 描述` 与 `** 验收标准`
- **AND** 校验 `:TASK_ID:` 唯一性及依赖先后顺序，且工作流模板 `tasks.org` 与该默认结构保持一致

#### Scenario: 编辑文本与依赖而不破坏证据

- **GIVEN** 一条已有历史 `验收结果`、自定义小节或处于 `DONE` 状态的任务
- **WHEN** 用户调用 `task edit` 更新标题、描述、验收标准、依赖或自定义小节
- **THEN** CLI 更新对应区域并校验依赖顺序合法性
- **AND** 任务的 `TODO`/`DONE` 状态、其他未改小节以及既有 `验收结果` 原文保持不变

### Requirement: 受保护的任务移除

CLI SHALL 提供 `task remove` 移除指定任务，并阻断删除已完成任务、含历史证据的任务或被其他任务依赖的任务。

#### Scenario: 禁止移除已完成或含证据的任务

- **GIVEN** 目标任务状态为 `DONE`，或其 `验收结果`/`Evidence` 子节已有记录
- **WHEN** 用户尝试预览或执行 `task remove`
- **THEN** CLI 明确拒绝移除并说明原因，不对文件做任何修改

#### Scenario: 阻断被其他任务依赖的移除

- **GIVEN** 任务 `B` 在 `DEPENDS_ON` 中引用了待移除任务 `A` 的 `:TASK_ID:`
- **WHEN** 用户尝试移除任务 `A`
- **THEN** CLI 拒绝移除并列出引用方任务 ID（如 `B`），不自动改写其他任务的依赖

#### Scenario: 移除孤立待办任务

- **GIVEN** 目标任务为 `TODO`、无任何 `验收结果` 记录且不被任何任务依赖
- **WHEN** 用户预览并确认 `task remove`
- **THEN** 预览展示待移除任务及其所在位置，确认后从文档中整块移除该任务子树

### Requirement: 同组非连续重排与跨组子树移动

CLI SHALL 提供 `task reorder` 与 `task move`，以整棵任务子树为单位调整文档位置，并拒绝违反显式依赖顺序的调整。

#### Scenario: 同组非连续重排

- **GIVEN** 同一分组下存在多条任务，用户仅选中其中两条非连续任务传入 `task reorder`
- **WHEN** 预览并确认重排
- **THEN** 被选中的任务按指定新顺序排列，同组内未被选中的任务保持原有相对顺序
- **AND** 预览展示调整前后的组内位置与执行顺序

#### Scenario: 跨组移动与目标分组寻址

- **GIVEN** 任务位于原分组，目标分组以标题或路径（如 `验证`、`父组/子组`，或 `--group /` 移至顶层）并配合组首/组尾或 `--before`/`--after` 锚点指定
- **WHEN** 目标分组唯一匹配且用户确认预览
- **THEN** CLI 将整棵任务子树（含直属子节与证据区子标题）调整至目标层级并插入指定位置
- **AND** 保留 `:TASK_ID:`、状态、正文、验收标准、依赖与历史证据，不自动重编号；若分组名称重名则报错并提示改用完整路径

#### Scenario: 阻断导致依赖倒置的顺序变更

- **GIVEN** 任务 `B` 显式依赖前置任务 `A`
- **WHEN** 重排或移动后的文档顺序使 `B` 排在 `A` 之前
- **THEN** CLI 拒绝写入并指出冲突的任务与前置依赖，不自动改写依赖或顺序

### Requirement: 保留历史证据的任务拆分

CLI SHALL 提供 `task split` 将未完成任务拆分为至少两条新任务，保留历史证据并同步更新下游依赖引用。

#### Scenario: 拆分待办任务并更新引用

- **GIVEN** 待办任务 `1.2` 带有前置依赖 `1.0` 和历史 `验收结果`，且下游任务 `2.1` 的 `DEPENDS_ON` 包含 `1.2`
- **WHEN** 用户通过 `task split` 将 `1.2` 拆分为新任务 `1.2a` 与 `1.2b` 并确认预览
- **THEN** 新任务在原位置以同级替换 `1.2`；首条新任务 `1.2a` 继承原 `DEPENDS_ON`（`1.0`）与历史 `验收结果`
- **AND** 下游任务 `2.1` 的 `DEPENDS_ON` 中 `1.2` 被更新为同时引用全部新任务 ID（`1.2a, 1.2b`），且新任务 ID 无重复冲突

#### Scenario: 拒绝拆分已完成任务

- **GIVEN** 目标任务当前状态为 `DONE`
- **WHEN** 用户尝试预览或执行 `task split`
- **THEN** CLI 拒绝拆分并提示已完成任务不可拆分，原任务和文件保持不变
