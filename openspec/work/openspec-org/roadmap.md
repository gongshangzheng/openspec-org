# OpenSpec Markdown 与 Org 路线图

[Goal and release evidence](goal.md)。本路线图用于协调可审查的独立 change，本身不是可执行的任务队列。每个 change 只有在范围与前置依赖明确后，才编写并批准各自的规划制品。

## 1. 可选的原生 Org 制品工作流

参考 [adopt-native-org-workflow](../../changes/adopt-native-org-workflow/proposal.md)。该阶段保留上游默认 Markdown 工作流，并通过已有的 `schema:` 配置项引入平行的 `spec-driven-org` schema。它复用既有的制品依赖图、capability 路径、CLI 入口以及 planning-home 解析逻辑。

这一阶段同时新增原生 Org 模板与读取器，保留源文中的行内标记，并严格按选定工作流显式解析文件路径。双格式均需在状态查询、指令输出和严格校验中通过验收，并覆盖 Windows 嵌套路径与 CRLF。阶段 1–2 明确限定仅支持内建 `spec-driven-org` schema；将扩展支持通过 `openspec schema fork spec-driven-org` 派生的自定义 Org schema 推迟到阶段 3。在任务写入与归档闭环未落地前，不对外宣称 Org 生命周期已完整可用。

## 2. CLI 任务生命周期

在制品契约固定之后，CLI 仅从旧 Tangwen 工作流迁移有用的 Org 任务模型与操作，由 CLI 自身统一拥有变更列表进度、任务读取、写入、证据与就绪状态。下面按串行切片推进，直到共享契约稳定。

### 切片划分

- **切片 2a（当前：[read-native-org-tasks](../../changes/read-native-org-tasks/proposal.md)）**：只交付原生 `tasks.org` 只读解析器、`openspec task list/show/next`、变更列表任务进度和 Org apply 指令，供后续写操作复用。
- **切片 2b（任务文本与结构写入）**：集中实现跨平台文件锁（包含锁超时与陈旧锁信息，避免 Windows 文件重命名冲突）、不可变快照校验、预览与真实确认边界以及安全原子写。在此基础上提供任务新建、文本编辑、移除、同组重排、跨组移动、拆分和依赖约束检查，并将 `schemas/spec-driven-org/templates/tasks.org` 与默认生成样式统一。
- **切片 2c（验收证据与完成门禁）**：实现追加式 `验收结果`、`CRITERIA_SHA256` 规范化与变更失效判定、受控 `TODO`/`DONE` 状态流转，以及供阶段 3 消费的归档就绪检查。

### 任务模型与子节契约

Org change 的任务全部保留在各自的 `tasks.org` 中，使用原生 `TODO`/`DONE` 标题和稳定的 `:TASK_ID:` 属性，不生成 `tasks.md` 投影，也不做格式回退。Markdown change 继续沿用既有 checkbox 行为。CLI 不增加兼容包装层，也不拆分独立任务包。

任务标题只承载状态和简短标题，说明正文可以直接写在标题下方或放在描述子节中。新建任务时默认生成中文规范子节标题，但不强制手写文件必须包含描述子节，也不自动搬移既有段落。

为避免后续写入与证据校验出现歧义，结构子节遵循统一的命名与诊断契约。写操作默认生成中文规范标题 `描述`、`验收标准` 与 `验收结果`，读取器同时兼容固定英文别名 `Description`、`Acceptance Criteria` 与 `Evidence`。同一个任务下若出现重复的特殊子节（例如两个 `验收标准` 或两个 `验收结果`），CLI 必须明确报错，不得静默覆盖。此外，分组标题允许嵌套，但 `TODO`/`DONE` 任务标题下不再嵌套子 `TODO`/`DONE` 任务，每条任务子树作为原子单元处理。

### 写入、移除与确认契约

所有结构变更（新建、移除、同组重排、跨组移动、拆分）都必须先生成真实预览，并在获得真实用户确认后才允许落盘。CLI 边界必须将预览生成与确认执行明确分离，绝不能把 `previewHash` 本身等同于用户同意。任何预览操作、过期预览或校验报错都不得修改磁盘文件。

移除任务（remove）属于结构变更，除需预览与真实确认外，还遵守严格的保护规则。禁止移除状态为 `DONE` 的任务，也禁止移除 `验收结果` 中已存在历史证据的任务。如果还有其他任务通过 `DEPENDS_ON` 引用目标任务的 `:TASK_ID:`，CLI 必须拒绝移除并列出引用方任务 ID，绝不自动改写依赖。对于会改变 ID 的操作（例如拆分），必须保留历史证据并同步更新当前活跃引用。

### 重排与跨组移动

- **同组重排**不要求任务连续，未选中的任务保持原有相对顺序。**跨组移动**必须明确目标分组与插入位置，例如将 `1.2` 移到验证组并放在 `3.1` 之前；不沿用旧扩展对连续同级任务的限制，也不修改旧扩展。
- **目标分组寻址**按分组标题或路径（例如 `验证` 或 `父组/子组`）定位。遇到重名分组时 CLI 直接报错，要求改用完整路径或锚点任务定位；插入位置支持组首、组尾或锚点任务前后（例如 `--before <id>`、`--after <id>`）。
- **整棵子树搬移**以任务子树为单位调整结构所需的标题级别，完整保留 `:TASK_ID:`、`TODO`/`DONE` 状态、正文、验收标准、依赖引用和历史证据，不自动重编号或重写历史证据。
- **文档顺序与硬依赖**决定推进次序：CLI 默认按 `tasks.org` 的文档顺序推进，`:TASK_ID:` 仅作稳定引用，`org-num-mode` 仅用于显示标题编号。显式依赖是硬约束，若重排或移动后任务排在其前置任务之前，CLI 拒绝操作并指出冲突，不自动修改依赖或顺序。现有 Markdown 工作流保持不变。
- **结构预览与验收**展示任务原位置、目标分组、插入位置及调整后的执行顺序。验收需覆盖同组非连续重排、跨组移动后 `next` 的选择、任务内容与证据保留，以及依赖冲突、取消操作和过期预览均不落盘。

### 证据与完成门禁

验收标准存放在任务的 `验收标准`（或 `Acceptance Criteria`）子节中，验收证据以只追加方式记录在 `验收结果`（或 `Evidence`）子节下。完成度与归档就绪性必须基于当前规范化标准计算的 `CRITERIA_SHA256` 进行判定。因此，修改验收标准会让旧的通过记录失去对当前标准的放行效力，但所有历史证据原文仍完整保留。

## 3. 单项目规格同步与归档

该阶段复用既有的 delta 语义与归档目录布局。`sync` 只更新主规格并保持 change 处于活跃状态；`archive` 作为收尾步骤合并必需的 delta，且不强制先执行 `sync`。两者尽可能共用同一套 delta 对账路径，并按各自格式调用原生读写器。在写入主规格前，若 change 与目标主规格格式不一致，CLI 必须直接拒绝写入。

### 切片划分

- **切片 `3a`（Org `spec.org` 保真写回与 `sync`）**：围绕 `specs/**/spec.org` 的 delta 对账与保真写回，只依赖阶段 1 的 Org 规格解析器，文件归属与任务写入互不重叠，可在独立分支或 worktree 上与切片 `2b` / `2c` 并行推进。写回 `spec.org` 时，仅更新受影响的 requirement 块，保留文件头（如 `#+TITLE:`、`#+STARTUP:`）、未改动的 requirement 原文、行内标记和原换行符（LF/CRLF）。
- **切片 `3b`（Org `archive` 证据门禁接入与派生 Org schema 泛化）**：待切片 `2c` 与 `3a` 均落地后合流，将 Org `archive` 的任务就绪检查接入切片 `2c` 基于证据验证的就绪结果（而非仅看原始 `DONE` 数量），同时保持 `--no-validate`、警告与阻断边界清晰。从这一步起，将工作流判定从字面量 `spec-driven-org` 泛化为按 schema 声明的 `.org` 产物识别，从而一致支持通过 `openspec schema fork spec-driven-org` 派生的自定义 Org schema。验收需验证先 `sync` 后 `archive`（含已应用 delta 与冲突场景），并在保留 Markdown 回归的前提下完整演示一次从脚手架、任务证据到归档的端到端 Org 生命周期。

## 4. 项目级宿主与编辑器适配

适配器层始终以现有 CLI 作为状态、预览与校验的唯一所有者。产品本身不包含 Git worktree 工作流、worktree 预检工具、远端操作或子代理编排；CLI 仅检查规划目录、会话与文件快照。工作流指引放在生成的 skills、OPSX prompts 和指令模板中，不使用 hooks 或动态规则注入。各宿主均须保留既有信任规则，写入变更前要求真实用户确认（所有宿主共享同一确认契约，绝不把 `previewHash` 等同于同意），且不改动无关配置与用户级全局配置。以下源码目录在此作为建议提出，实际新增前须在对应 change 的 `design` 中确认。

### 切片划分与并行结构

- **切片 `4a`（共享适配契约与项目级开关）**：先串行定下预览/确认协议与保存在已解析 planning home 的 `openspec/config.yaml` 中的项目级开关，由 `init` 和 `update` 统一读取。各宿主安装后默认启用所选工具入口，并允许项目关闭它而不影响 CLI 或 skills。
- **Pi 适配器（`4a` 定型后并行）**：位于建议路径 `src/integrations/pi`，安装到项目 `.pi/extensions/`。
- **唯一一份标准 stdio OpenSpec MCP 服务（`4a` 定型后并行）**：位于建议路径 `src/integrations/mcp`（例如通过统一 CLI 入口 `openspec mcp` 启动），同时服务于 `Codex`、`Antigravity CLI` 以及 `Magpie` 等外部 MCP 管理器，不按宿主拆成两套 MCP 实现。支持在 `openspec/config.yaml` 中关闭宿主项目级自动写入，避免与 Magpie 托管的实例重复注册；同时为未安装 Magpie 的用户提供可选的项目级宿主配置写入（Codex 为 `.codex/config.toml`；Antigravity CLI 须先对照 [official Antigravity CLI MCP documentation](https://antigravity.google/docs/mcp/#antigravity-cli) 并实测确认项目级发现路径，而不直接假设 `.agents/mcp_config.json`）。
- **Emacs 适配器（`4a` 定型后并行；CLI 接口在 `2b`/`2c` 稳定后即可提前启动）**：位于建议路径 `editors/emacs/`，同样调用上述 CLI，仅将 `openspec.el` 作为交互参考而非源码来源。

每个已交付宿主都须验证启停开关、拒绝或取消操作、过期预览阻断以及无关配置保留。

## 5. 共享 Store 与跨项目验收

复用 v2.2.0 的 `store` 承担共享规划、`references` 提供只读规格上下文、`workset` 组织开发者日常同时打开的多个目录，不引入任务分发或第二套项目/worktree 管理器。在单项目生命周期走通后，搭建包含一个 Org planning store 与两个组件项目的测试夹具，并保留 Markdown 回归覆盖。

读写边界均需验证：change 与主规格落入解析后的所有者目录并遵循其配置的工作流，只读参考保持只读，兄弟项目与只读参考目录均不发生写入。此外，须专门验证从组件项目（包括本地没有 `openspec/` 目录的组件项目）带 `--store <id>` 调用 `openspec task` 及其他 Org 命令时，能正确解析 store 中 `openspec/config.yaml` 声明的 `schema: spec-driven-org` 且仅写入该 store。上述边界先在 CLI 层测通，再通过各已交付宿主适配器做冒烟验证。

## 6. 评审节奏与验证纪律

每个 change 都必须写明复用什么、引入什么、移除什么，并明确文件归属、串行依赖与可观测验证。在共享契约稳定前保持 change 串行；只有后续 proposal 明确指出互不依赖的工作并给出各自独立验证证据时，才可拆出并行步骤。本路线图识别出的两处跨 change 并行机会分别是 `2b/2c ∥ 3a` 以及 `4a` 定型后的 `Pi ∥ MCP ∥ Emacs`（每条线仍须先各自完成并批准自身的规划制品后再实施）。

每当修改 CLI 命令、参数或 `--store` 适用清单时，提交或推送前必须在本地执行补全注册表与生成器测试（`test/core/completions/`）、模板一致性测试（`test/core/templates/`）、四种壳层补全脚本生成（`bash`、`zsh`、`fish`、`powershell`）以及完整的本地 `pnpm test`。同时保持仓库整洁：已合入且全部完成的 change（如 `adopt-native-org-workflow`）应及时归档，不得提交生成的 `tasks.md` 投影文件。此路线图中的任何步骤均不构成实施、安装依赖或创建 worktree 的授权。
