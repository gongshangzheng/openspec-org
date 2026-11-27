# Design

## Context

切片 2a 已提供只读 `readOrgTasks` 和 `openspec task list/show/next`。现阶段需要为 `tasks.org` 建立可靠的 CLI 写路径，覆盖创建、文本编辑、受保护移除、同组重排、跨组移动与拆分，并为后续切片 2c 的证据追加与状态门禁提供同一套锁、快照与原子写底座。

仓库内 `src/core/file-state.ts` 已经为 `store` 和 `workset` 实现了基于排他锁文件的锁获取、释放和原子写，但当前写死了 `0o600` 权限、5 秒超时，且未携带陈旧锁元数据或 Windows 临时重命名重试。本轮将在不破坏现有私有状态文件契约的前提下扩展它。

## Goals / Non-Goals

- 集中提供跨平台文件锁、原始文件 SHA-256 快照校验、预览/真实确认分离以及原子写。
- 完成任务文本与结构变更命令，严格遵守文档顺序推进与显式 `DEPENDS_ON` 硬约束。
- 保留未更改任务的原文、行内标记、文件头（如 `#+STARTUP: num`）、BOM 与原换行符（LF/CRLF）。
- 不实现追加式 `验收结果` 写入、`CRITERIA_SHA256` 校验与 `TODO`/`DONE` 状态流转（留待切片 2c）；不修改 `sync`/`archive` 或宿主适配器。

## Decisions

### 读取契约对齐与子树边界

扩展 `src/core/parsers/org-tasks.ts`：

- 结构子节映射表同时识别中文规范标题与固定英文别名：`描述`/`Description`、`验收标准`/`Acceptance Criteria`、`验收结果`/`Evidence`（精确匹配这些规范名称），写入时默认输出中文规范标题。
- 同一任务下若出现多个 `验收标准`/`Acceptance Criteria` 或多个 `验收结果`/`Evidence`，立即抛出带源路径与行号的诊断错误，不再静默覆盖。
- 扫描任务直属子节时（忽略 `验收结果`/`Evidence` 内部及 `#+BEGIN_SRC`/`#+BEGIN_EXAMPLE` 区块），若发现嵌套的 `TODO` 或 `DONE` 标题，明确报错并指出行号。
- 为编辑器导出内部结构模型（包含 BOM、主导换行符、尾随换行、组路径、标题星号层级、属性抽屉行范围及整棵任务子树的精确行切片），确保未触及片段按原始切片原样保留。

### 跨平台锁、快照与原子写

扩展 `src/core/file-state.ts`（保留 `store` / `workset` 现有的 `0o600` 与错误格式测试不变），或在其之上提供可选配置：

- 锁文件位于同目录的 `<changeDir>/.tasks.org.lock`，写入 JSON 元数据 `{ token, pid, hostname, createdAt }`。释放时校验 `token` 并先关闭句柄再删锁；超时报错时解析并展示锁持有者 PID 与创建时间，绝不按时长自动删锁。
- 原子写支持可配置 `mode`（对于 `tasks.org` 保留既有文件权限或系统默认新建权限，不使用 `0o600`），写入临时文件后调用 `sync()`（忽略 `EINVAL`/`ENOTSUP`/`ENOSYS`），并在 Windows `EPERM`/`EACCES`/`EBUSY` 瞬态冲突时做短退避重命名重试。
- 快照校验基于修改前 `tasks.org` 的完整原始 UTF-8 内容计算 SHA-256；`previewHash` 同时绑定源快照哈希与规范化操作载荷，持锁写入前再次重读文件核对快照哈希，不匹配即拒绝落盘。

### 编辑、移除、重排、移动与拆分算法

在 `src/core/org-task-editor.ts` 实现纯变换与预览生成：

- **预览与确认契约**：文本编辑（`edit`）与所有结构变更（`create`、`remove`、`reorder`、`move`、`split`）均支持 `--preview`（不拿锁、不写入、返回预览文本、`previewHash` 与结构摘要）。结构变更未传 `--preview` 时：若处于交互式 TTY（复用 `src/utils/interactive.ts` 的 `confirmPrompt`），先打印真实预览并等待用户输入 `y/N` 确认；若处于非交互模式或 `--json` 模式，必须**同时**传入 `--confirm` 与匹配的 `--preview-hash <hash>`，缺少任一参数或哈希过期均拒绝写入（Ctrl-C 取消通过 `isPromptCancellationError` 返回退出码 `130`）。
- **任务移除（`remove`）**：前置检查任一命中即拒：`state === 'DONE'`、`evidence !== undefined`（即存在 `验收结果`/`Evidence` 子节）、或任何其他任务的 `DEPENDS_ON` 包含目标 ID（列出引用方任务 ID）。
- **同组重排（`reorder`）与跨组移动（`move`）**：以任务所在直接父分组为同组范围；`reorder` 接收同组内部分任务 ID 的目标次序，将其按新次序填回原选中槽位，未选中任务相对位置不动。`move` 通过组标题或路径（例如 `验证`、`父组/子组`；`--group /` 或省略表示顶层无父分组）定位目标组；重名组名直接报错要求完整路径；位置由 `--position start|end` 或 `--before <id>` / `--after <id>` 指定。整棵子树移动时按目标任务层级差值平移任务标题及其所有子标题（含 `验收结果` 内的证据标题）的星号数量，保留全部内容、状态与 `:TASK_ID:`。
- **依赖顺序校验**：每次变换后按文档顺序扫描全量任务，确认每条任务的 `DEPENDS_ON` 中所有已存在的前置任务均位于其文档位置之前（自依赖或前置任务位于其后均报错指出冲突；未定义的前置 ID 仍按读取契约处理，不在移动时静默删除或改写依赖）。
- **任务拆分（`split`）**：禁止拆分 `DONE` 任务。用至少两条新 `TODO` 任务在原位置同级替换原任务：首条新任务继承原任务 `DEPENDS_ON` 与历史 `验收结果` 原文；其余任务下所有 `DEPENDS_ON` 中的原 ID 替换为全部新任务 ID（保持去重与原顺序风格），随后运行唯一 ID 与依赖顺序校验。

### CLI、模板对齐与补全/技能同步

- 将 `src/cli/index.ts` 中内联注册的 `task` 命令群抽离到 `src/cli/commands/task.ts`（沿用 `store` / `workset` 的大命令分组习惯），在 `src/commands/task.ts` 接入 `create`、`edit`、`remove`、`reorder`、`move`、`split`，复用 `resolveRootForCommand`、`validateChangeExists` 与 `spec-driven-org` 校验。
- 更新 `schemas/spec-driven-org/templates/tasks.org` 与 `schemas/spec-driven-org/schema.yaml` 描述，使其默认携带 `** 描述` 与 `** 验收标准`。
- 同步更新 `src/core/completions/command-registry.ts`、`src/core/templates/workflows/store-selection.ts`、`test/core/completions/command-registry.test.ts`，并通过 `scripts/generate-skillssh.mjs` 与 `scripts/regen-parity-hashes.mjs` 刷新 `skills/` 及 `test/core/templates/skill-templates-parity.test.ts`。

## Verification and File Ownership

本 change 内部按 4 步串行执行（`tasks.org` 写入必须依赖锁与结构模型，CLI 接入依赖编辑器引擎）；与并行推进的切片 `3a`（`sync-native-org-specs`）在核心实现和任务测试上完全隔离，仅在最后的 CLI 注册与技能哈希文件（`src/cli/index.ts`、`src/core/completions/command-registry.ts`、`src/core/templates/workflows/store-selection.ts`、`skills/`、`test/core/completions/command-registry.test.ts`、`test/core/templates/skill-templates-parity.test.ts`）存在合流后重新生成的机械交集。

1. `src/core/file-state.ts`、`src/core/parsers/org-tasks.ts`、`test/core/file-state.test.ts`、`test/core/parsers/org-tasks.test.ts`：验证锁超时诊断与陈旧锁信息、保留权限的原子写与 Windows 重试、英文别名识别、重复特殊子节报错及禁止非证据区嵌套任务。
2. `src/core/org-task-editor.ts`、`test/core/org-task-editor.test.ts`：验证快照防漂移、`previewHash` 校验、新建/编辑、移除三类保护、同组非连续重排、跨组路径移动与子树星级平移、依赖倒置拒写、拆分继承与引用更新，以及 BOM/CRLF/行内标记保真。
3. `src/cli/commands/task.ts`、`src/cli/index.ts`、`src/commands/task.ts`、`schemas/spec-driven-org/{schema.yaml,templates/tasks.org}`、`src/core/completions/command-registry.ts`、`src/core/templates/workflows/store-selection.ts`、`skills/`、`test/commands/{org-task-editing,artifact-workflow}.test.ts`、`test/core/completions/command-registry.test.ts`、`test/core/templates/skill-templates-parity.test.ts`：验证 CLI 交互/非交互确认、`--preview`、取消退出码 130、错误非改写、模板对齐与补全/技能同步，以及四种壳层补全脚本生成。
4. `test/cli-e2e/org-task-editing.test.ts` 与 `.github/workflows/ci.yml`：在 Windows 与 Unix CI 矩阵验证从新模板脚手架到新建、编辑、移除、非连续重排、跨组移动、拆分、`next` 选择及 `--store` 跨目录写入的全程回归，确保 Markdown 工作流不受影响且不生成 `tasks.md` 投影。

## Risks / Trade-offs

- 给 6 个写子命令挂载 `--store` 会更新所有 12 个工作流技能里的 `STORE_SELECTION_GUIDANCE` 文本；合流时需同步重新运行 `generate-skillssh.mjs` 和 `regen-parity-hashes.mjs`。
- 禁止任务下直接嵌套 `TODO`/`DONE` 后，手写 `tasks.org` 需用分组标题（`* 分组`）加同级任务（`** TODO`）组织层级；已有的 `test/core/parsers/org-tasks.test.ts` 中证据区内的 `**** TODO` 仍受豁免保留。

## Migration Plan

不自动迁移现有 `tasks.org` 中的既有段落；既有无 `** 描述` 子节的手写任务文件继续可读、可编辑，新建任务与新生成的 `tasks.org` 默认携带 `** 描述` 与 `** 验收标准`。
