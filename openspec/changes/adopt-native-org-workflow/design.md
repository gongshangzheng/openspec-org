## Context

See [proposal.md](proposal.md) and the [roadmap](../../work/openspec-org/roadmap.md). Upstream `spec-driven` keeps its defaults, Markdown files, and parsing behavior. The schema already drives status and instructions, but several readers hardcode artifact filenames, so an Org schema by itself would not make the whole read path work.

## Goals / Non-Goals

- Offer native Org files and diagnostics without changing the default Markdown workflow.
- Reuse the artifact graph, change metadata, planning-home resolution, and validation rules where their behavior is format-independent.
- Do not add automatic conversion, per-artifact format picking, a rendering engine, or the later task editing and sync/archive changes here.

## Decisions

### Add a sibling schema with four Org templates

Keep `schemas/spec-driven/schema.yaml` and its four Markdown templates in `schemas/spec-driven/templates/` unchanged. Add `schemas/spec-driven-org/schema.yaml` and `schemas/spec-driven-org/templates/{proposal,design,spec,tasks}.org`, preserving artifact IDs and dependency edges. These are native Org templates, not generated conversions from Markdown. Use the existing schema resolver in `src/core/artifact-graph/`; do not add a second `format:` setting that can disagree with `schema:`.

A project or store opts in with `schema: spec-driven-org` in the resolved planning home's `openspec/config.yaml`. With no setting or with `schema: spec-driven`, Markdown remains the default. For an existing change, honor the schema recorded in its `.openspec.yaml`; changing the project default does not rewrite or reinterpret that change. Resolve main specs from the owning planning home's configured workflow. A change and its target main specs must use the same format to merge; the follow-up sync/archive change will enforce that before writing. Do not scan both formats or fall back to whichever file exists. This change does not enable mixed-format merge.

`tasks.org` 模板包含 `#+STARTUP: num`，在 Emacs 中打开时自动启用 `org-num-mode`。标题编号是显示效果；CLI 仍以 `:TASK_ID:` 标识任务，不从显示编号推断或改写 ID。

### Parse structural Org markup, preserve author text

Add `src/core/parsers/org-structure.ts` and `test/core/parsers/org-structure.test.ts`. Recognize the headings, blocks, and scenario step labels needed for the workflow. A scenario heading inside an Org source or example block must not count. Read native Org emphasis, for example `*required*` and `/optional/`, and code or verbatim spans as author text; do not strip or escape their delimiters. A heading requires its own Org heading syntax, not just a leading asterisk in prose. Where validation inspects a structural token such as `- *WHEN*`, recognize the token without altering the stored or returned source. Emacs or another Org viewer handles display. Existing Markdown readers keep their own formatting rules.

Reuse the result types and format-independent validation in `src/core/validation/validator.ts`; select the Org reader before parsing instead of going through a Markdown intermediate. Add Org branches at the shared change and spec reader boundaries in `src/core/parsers/`. Keep original text, path, heading, and line information available to diagnostics and source-oriented outputs.

### Route discovery and commands by the resolved workflow

Use the existing artifact graph for schema output and update the affected consumers in `src/commands/workflow/`, `src/commands/{change,show,spec,validate}.ts`, `src/core/list.ts`, and `src/utils/{change-utils,spec-discovery}.ts`. Keep non-format behavior and custom-schema handling intact; do not require existing custom Markdown schemas to opt into the new workflow. Update relevant instructions under `src/core/templates/workflows/` to use resolved paths and to give examples in the selected format. If generated files need updates, track them by exact name rather than sweeping by extension.

Use Node's `path.join`, `path.resolve`, and existing containment checks for filesystem paths. Keep capability IDs platform-independent. Verify nested paths and CRLF using the Windows and Unix jobs already present in `.github/workflows/ci.yml`.

## Verification and File Ownership

Keep the steps serial. The schema defines the source fixtures; command integration depends on the same Org reader working in validation. No separate write lanes are needed.

1. Schema and templates: `schemas/spec-driven-org/`, `src/core/artifact-graph/`, `src/commands/workflow/`, and `test/commands/artifact-workflow.test.ts`. Verify Markdown is still the default and Org opt-in returns four Org template paths, native instructions, and the same artifact graph; existing change metadata still selects its own schema. 另用 Emacs `-Q` 验证任务模板和当前任务文件自动开启 `org-num-mode`，任务 ID 保持不变。
2. 原生读取和验证：`src/core/parsers/`、`src/core/validation/`、`src/utils/spec-discovery.ts`、`test/core/parsers/` 和 `test/core/validation*.test.ts`。底层查找接受调用方指定的规格文件名；Markdown 调用保留既有行为。覆盖四种 delta 操作、换行、源位置、区块内的伪标题及行内标记，并运行 Markdown 回归测试。
3. CLI 接入：`src/commands/{change,show,spec,validate}.ts`、`src/core/list.ts`、`src/utils/change-utils.ts`、`src/core/templates/workflows/` 和相关 `test/commands/` 测试。复用 1.2 的文件发现能力，把已解析的工作流传到读取和验证入口。验证两种格式并列时选择正确的文件，且缺少目标文件时不回退。
4. Cross-platform verification: `test/cli-e2e/` and the existing `.github/workflows/ci.yml` matrix. Record passing Windows and Unix runs of both the unchanged default Markdown workflow and the opt-in Org workflow through artifact resolution and strict validation.

## Risks / Trade-offs

- Copying the artifact structure into a sibling schema makes upstream Markdown updates easier to merge, but the schemas can drift. Check that their artifact IDs, dependency edges, and semantic roles agree; allow their native syntax and task layouts to differ.
- Hardcoded paths can make commands disagree about the selected format. Exercise the same fixture through multiple commands, with both extensions present, before completing this change.
- Having Org templates is not the same as having an Org write lifecycle. Wait for native tasks and sync/archive to pass end to end before advertising that lifecycle as ready.

## Migration Plan

No migration is necessary for current projects or this Markdown change. Prefer opt-in on a new planning home. To switch an existing home, an agent or maintainer can convert the artifacts they still need and review the result before using the Org workflow. OpenSpec does not do that conversion or merge deltas across formats. Existing upstream Markdown files and Git history are not rewritten.
