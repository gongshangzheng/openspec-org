# Spec Delta

## Purpose

让 Markdown 和 Org 工作流都能通过 `openspec sync` CLI 把变更 delta 安全、幂等地同步到主规格，在写入前拦截跨格式不匹配，并完整保留原生 `spec.org` 的文件头、未改动条款和排版。

## ADDED Requirements

### Requirement: CLI 同步变更 delta 到主规格

CLI SHALL 提供 `openspec sync [change-name]`（支持 `--json` 与 `--store <id>`），按变更所属工作流将 `specs/` delta 合并到 `openspec/specs/` 并保持变更目录处于活跃状态。

#### Scenario: 同步新建与更新的规格并保持变更活跃

- **GIVEN** 活跃变更包含针对新 capability 或已有 capability 的合法 delta 规格
- **WHEN** 用户运行 `openspec sync <change-name>`（可选 `--json` 与 `--store <id>`）
- **THEN** CLI 依次应用 `RENAMED`、`REMOVED`、`MODIFIED`、`ADDED` 变更到解析后的主规格目录
- **AND** 变更目录仍保留在活跃变更中不被归档或删除

#### Scenario: 幂等重复同步与缺省参数报错

- **GIVEN** 同一变更已经执行过一次 `openspec sync`
- **WHEN** 用户再次运行 `openspec sync <change-name>`，或指定不存在的变更/缺少 delta 的变更
- **THEN** 重复同步保持主规格一致、不产生重复 requirement
- **AND** 变更不存在或不含任何 delta 时明确报错退出，不修改任何主规格

### Requirement: 原生 Org 规格保真写回

在同步 Org change 时，CLI SHALL 以原生 `spec.org` 形式创建或局部更新主规格，保留文件头、未改动条款、行内标记和原换行符，并阻断不安全的修改与退场。

#### Scenario: 创建新 Org 主规格与局部修改已有条款

- **GIVEN** Org delta 指向尚未存在的主规格或已包含 `#+TITLE:`、`#+STARTUP:` 及多个 `** Requirement:` 的主 `spec.org`
- **WHEN** CLI 同步 `ADDED`、`MODIFIED` 或 `RENAMED` 操作
- **THEN** 新建主规格时写入 Org 标题、`* Purpose` 与 `* Requirements`
- **AND** 更新已有主规格时仅改写受影响的条款块，未改动条款、文件头、注释、代码块与 Org 行内标记保持原文不变

#### Scenario: 阻止不安全的 Org 修改、结构损坏或退场

- **GIVEN** `MODIFIED` 块遗漏原有场景、主 `spec.org` 结构非法，或 `REMOVED` 后清空所有条款但未声明 `retire_capabilities: true` 或仍残留未归类正文
- **WHEN** CLI 准备同步该 capability
- **THEN** CLI 拒绝写入该主规格并报告具体阻断原因，不对主规格做局部落盘

#### Scenario: 声明退场标记时安全删除空 Org 主规格

- **GIVEN** 变更元数据声明 `retire_capabilities: true`，且 `REMOVED` 后 `spec.org` 仅余文件头、`* Purpose` 与空的 `* Requirements`
- **WHEN** CLI 同步该变更
- **THEN** 删除对应的 `spec.org` 与空父目录，并报告退场结果与被移除的 `* Purpose`

### Requirement: 写入前拒绝跨格式不匹配

CLI SHALL 在任何写入前校验变更工作流与目标主规格目录格式一致，拒绝跨格式合并且不回退读取另一种扩展名。

#### Scenario: 工作流配置不匹配或存在对立格式文件

- **GIVEN** Org change 试图同步到默认 Markdown 规划目录、Markdown change 试图同步到 `spec-driven-org` 规划目录，或目标目录已存在另一种格式的主规格文件
- **WHEN** 用户执行 `openspec sync`
- **THEN** CLI 在写入任何文件前直接报错拒绝，指出变更格式与主规格目标格式冲突
- **AND** 不读取、不改写也不删除任何 `spec.md` 或 `spec.org`

### Requirement: Windows 与跨平台路径同步

CLI SHALL 在 Windows、macOS 与 Linux 上正确处理嵌套 capability 路径、CRLF 换行和路径越界保护。

#### Scenario: Windows 嵌套路径与 CRLF 同步

- **GIVEN** Windows 仓库从子目录运行，或通过 `--store <id>` 指向含 CRLF `spec.org` 的共享 store，且 delta 位于多级子目录 `specs/a/b/spec.org`
- **WHEN** 用户执行 `openspec sync <change-name>`
- **THEN** 主规格按相同的相对 capability 路径写入解析后的规划主目录，既有 CRLF 换行得以保留
- **AND** 任何越出 `openspec/specs/` 边界的路径引用在写入前被拦截
