# Design

## Context

`src/core/specs-apply.ts` 已经从 `src/core/archive.ts` 中抽离出完整的 delta 对账逻辑，但目前全部写死为 Markdown（`spec.md`、`parseDeltaSpec`、`MarkdownParser`、`collapseBlankRunsOutsideFences`）。另一方面，阶段 1 已交付 `src/core/parsers/org-structure.ts`（`OrgDocument`、`readOrgMainSpec`、`readOrgDelta`）和 `src/utils/change-utils.ts` 的格式判定辅助函数。

本切片（`3a`）的目标是在不触碰 `tasks.org` 读写路径和 `org-structure.ts` 既有 API 的前提下，交付 `openspec sync` CLI 命令以及原生 Org 规格保真写回能力，并与切片 `2b` 并行开发。

## Goals / Non-Goals

- 新增 `openspec sync [change-name]` CLI 命令，支持 `--json`、`--store <id>`，保持 change 活跃。
- 将 `src/core/specs-apply.ts` 扩展为显式接受工作流格式（默认 `'markdown'`，保持 `archive.ts` 现有行为完全不变），并新增 `src/core/specs-apply-org.ts` 处理 Org 规格对账与写回。
- 写回 `spec.org` 时按行切片保真重建，仅改动目标 requirement 块，保留文件头（`#+TITLE:`、`#+STARTUP:`）、未改条款、行内标记和 LF/CRLF。
- 写入前严格拦截 Org↔Markdown 格式冲突。
- 不实现 Org `archive` 的任务证据门禁与自定义派生 Org schema 泛化（留待切片 `3b`）；不改动 `org-structure.ts` 核心解析器以避免与切片 `2b` 冲突。

## Decisions

### 新增独立的 Org 规格对账与保真写回模块

新增 `src/core/specs-apply-org.ts`（只读导入 `OrgDocument`、`readOrgMainSpec`、`readOrgDelta`、`readOrgRequirement`）：

- **结构预检**：校验已有主 `spec.org` 不得包含 `* ADDED/MODIFIED/REMOVED/RENAMED Requirements` 等 delta 标题、不在 `* Requirements` 下的 `** Requirement:`、重复 `* Requirements` 节或重复同名 `** Requirement:`。
- **按切片保真重建**：通过原始换行正则提取每行原始切片，保留 `lines.slice(0, requirementsSection.index)`（涵盖 `#+TITLE:`、`#+STARTUP:`、顶层注释与 `* Purpose`）以及 `lines.slice(requirementsSection.end)`；对未改动的 `** Requirement:` 块按原行切片拼接；对 `RENAMED` 仅替换该条款标题行 `** Requirement: <to>`，保留原有正文与场景；对 `MODIFIED` 校验保留原有场景集合（按场景名多重集计数对比，防止漏掉场景）后替换为 delta 块原文；对 `REMOVED` 删除对应切片；对 `ADDED` 追加在 `* Requirements` 末尾。
- **新建主规格与退场审计**：新 capability 使用 Org 骨架（`#+TITLE: <capability> Specification`、`* Purpose`、`* Requirements`），复用 delta 自带的 `* Purpose` 正文或简短占位；capability 退场（`retire_capabilities: true`）通过 Org 原生全文件行级审计确认所有非空行均属于文件头关键字/注释、`* Purpose`、`* Requirements` 或被移除条款后，再执行安全删除。
- **行尾与校验**：复用 `src/utils/line-endings.ts` 的 `matchLineEnding` 保留已有文件 LF/CRLF（新建文件默认 LF）；扩展 `Validator.validateSpecContent(specName, content, { format })` 支持用 `validateOrgSpec` 校验重构后的 `spec.org`。

### 共享对账入口与跨格式防护

- 在 `src/core/specs-apply.ts` 为 `findSpecUpdates`、`buildUpdatedSpec`、`writeUpdatedSpec`、`retireSpec` 等入口增加可选 `format: SpecFormat`（默认 `'markdown'`），复用 `specFilenameFor(format)`、`resolveTrustedSpecPath` 与 `assertSpecFileWithin`；`archive.ts` 现有无参调用全部保持默认 Markdown 行为不变。
- 新增 `src/commands/sync.ts`，通过 `resolveRootForCommand`、`validateChangeExists` 与 `changeArtifactFormat` / `mainSpecFormat` 在读取和写入前检查格式一致性：若变更格式与规划目录主规格格式不一致，或目标 capability 目录中存在对立格式文件（例如 Org 同步遇到已有 `spec.md`），在任何写入前直接抛出明确错误。
- 在 `src/cli/index.ts` 注册 `sync [change-name]` 命令，并同步更新 `src/core/completions/command-registry.ts`、`src/core/templates/workflows/store-selection.ts`、`test/core/completions/command-registry.test.ts`、`skills/` 及 `test/core/templates/skill-templates-parity.test.ts`。

## Verification and File Ownership

本 change 内部按 4 步串行实施；核心模块与测试文件与切片 `2b`（`edit-native-org-tasks`）完全独立，仅 CLI 注册、补全清单与技能模板哈希文件会在两线合流时触发机械重生成冲突。

1. `src/core/specs-apply-org.ts`、`src/core/validation/validator.ts`、`test/core/specs-apply-org.test.ts`：验证 Org 新建、`ADDED`/`MODIFIED`/`REMOVED`/`RENAMED` 切片保真、文件头/行内标记/代码块保留、场景丢失拦截、退场审计以及 `validateSpecContent` Org 模式。
2. `src/core/specs-apply.ts`、`test/core/specs-apply.test.ts`：验证显式格式分发、跨格式拒绝（Org→Markdown、Markdown→Org 及对立扩展名存在）、幂等重复应用以及 Markdown 既有对账行为无回归。
3. `src/commands/sync.ts`、`src/cli/index.ts`、`src/core/completions/command-registry.ts`、`src/core/templates/workflows/store-selection.ts`、`skills/`、`test/commands/sync.test.ts`、`test/core/completions/command-registry.test.ts`、`test/core/templates/skill-templates-parity.test.ts`：验证 `openspec sync` 的文本/JSON、`--store`、保持变更活跃、缺少 delta 报错，以及补全与技能同步、四种壳层补全脚本生成。
4. `test/cli-e2e/sync-native-org-specs.test.ts` 与 `.github/workflows/ci.yml`：在 Windows 与 Unix CI 矩阵验证从子目录及 `--store` 同步嵌套 `specs/**/spec.org`（含 CRLF 保真与 Markdown 回归），确保越界路径与跨格式冲突均无写入。

## Risks / Trade-offs

- 为 `openspec sync` 挂载 `--store` 会更新 12 个技能文件里的 `STORE_SELECTION_GUIDANCE`；与切片 `2b` 合流时须重新运行 `generate-skillssh.mjs` 和 `regen-parity-hashes.mjs` 统一生成。
- 复用 `src/core/templates/workflows/sync-specs.ts` 的现有 skill 描述暂保持不变（本轮聚焦 CLI `openspec sync` 与底层对账引擎），避免把无关技能文案重构拉入切片 `3a`。

## Migration Plan

不改变既有 Markdown 规格、归档或 `/opsx:sync` 技能的行为；用户与 agent 可随时对 Markdown 或 Org 变更直接运行 `openspec sync <change-name>`。
