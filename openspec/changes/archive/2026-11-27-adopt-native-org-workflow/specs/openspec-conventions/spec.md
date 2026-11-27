## ADDED Requirements

### Requirement: Org planning artifact conventions

A planning home configured for the built-in Org workflow SHALL use Org planning artifacts. The existing Markdown workflow keeps its file layout and conventions.

#### Scenario: Creating an Org change

- **GIVEN** the planning home selects the Org workflow
- **WHEN** a user or agent creates its planning artifacts
- **THEN** the change uses `proposal.org`, `design.org`, and `tasks.org` in the change directory
- **AND** its deltas use `changes/<change-id>/specs/<capability-path>/spec.org` and its main specs use `specs/<capability-path>/spec.org`, relative to the OpenSpec directory

#### Scenario: Emacs 显示任务标题编号

- **GIVEN** 作者使用内置 Org 模板创建 `tasks.org`
- **WHEN** 用户在 Emacs 中打开任务文件
- **THEN** 文件通过 `#+STARTUP: num` 启用标题编号，无须修改用户配置
- **AND** `:TASK_ID:` 仍标识任务，不随标题的显示编号改变

#### Scenario: A file in another format is not a substitute

- **GIVEN** an Org planning artifact is missing and a Markdown file exists at the corresponding path
- **WHEN** OpenSpec checks the Org artifact
- **THEN** it does not count the Markdown file as satisfying the Org artifact
- **AND** it leaves the Markdown file untouched

### Requirement: Org behavioral specification syntax

Org specifications SHALL use Org headings for requirements and scenarios and retain the existing behavioral meanings of main specs and delta operations.

#### Scenario: Writing requirements and scenarios

- **WHEN** an author writes a behavioral spec in Org
- **THEN** `** Requirement: <name>` is a child of `* Requirements` in a main spec or of the appropriate level-one delta operation in a delta
- **AND** `*** Scenario: <name>` is a child of a requirement with list steps including a trigger and outcome

#### Scenario: Authoring a delta

- **WHEN** an author specifies additions, modifications, removals, or renames
- **THEN** the delta uses the corresponding level-one Org operation headings and preserves full capability paths
- **AND** names and complete requirement bodies retain the same meaning as in the Markdown workflow without sharing its markup rules

#### Scenario: Writing inline markup in body text

- **WHEN** an author uses native Org inline markup such as emphasis, code, or verbatim text in artifact prose
- **THEN** reading or validating the artifact preserves those source markers and does not mistake them for headings
