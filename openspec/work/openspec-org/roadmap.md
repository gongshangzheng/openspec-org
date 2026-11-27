# OpenSpec Markdown and Org Roadmap

[Goal and release evidence](goal.md). This roadmap coordinates reviewable changes; it is not an executable task queue. Only the first change is scaffolded. Each later change gets its own approved planning artifacts when its scope and dependencies are ready.

## 1. Opt-in Org artifact workflow

[adopt-native-org-workflow](../../changes/adopt-native-org-workflow/proposal.md). Keep the upstream Markdown workflow and add a sibling `spec-driven-org` schema, selected through the existing `schema:` setting. Reuse the artifact graph, capability paths, CLI entry points, and planning-home resolver. Add native Org templates and readers, preserve native inline markup, and resolve paths explicitly by workflow. Verify both formats for status, instructions, and validation, including nested paths on Windows. Do not advertise a complete Org lifecycle at this stage.

## 2. CLI task lifecycle

After the artifact contract is set, migrate only the useful Org task model and operations from the old Tangwen workflow. Keep `tasks.org` in the change with native TODO/DONE headings and stable `:TASK_ID:` properties. A heading carries status and a short title; prose can live directly below it or under a description heading. Prefer generating a description heading by default, without requiring it, multiline prose, or checkbox-friendly wording. Confirm template/config details in this change; do not automatically move existing paragraphs.

Expose CLI-owned change listing and task progress, task list/read/next, creation, editing, reordering, splitting, dependencies, evidence, status transitions, and archive readiness. Keep criteria in their task's acceptance section; evidence is append-only and completion is evaluated against the current criteria. Preserve completed tasks and historic evidence on edits. A structural change must present the actual preview and get real confirmation before writing. Centralize locking, immutable snapshot checks, validation, and safe writes in the CLI; previews and errors must not mutate task data. Keep Markdown checkbox behavior for Markdown changes. An Org change reads and writes its own `tasks.org` without a Markdown projection or fallback. Do not add a wrapper or separate task package.

Review slices can separate read/progress from writes, and writes from evidence/readiness, after the shared task model is established. Verify a stale preview cannot write, criteria changes invalidate old acceptance for readiness, and reordering or splitting retains evidence and updates current references.

## 3. Single-project spec sync and archive

Reuse existing delta semantics and archive layout. `sync` writes only main specifications and leaves the change active. `archive` applies required deltas as part of closeout and does not require a prior sync. Both use one delta reconciliation path where possible, with native readers and writers for each format. Keep Markdown behavior; reject a format mismatch between change and target before writing. Verify that sync followed by archive behaves correctly, including already-applied deltas and conflicts. Demonstrate the whole opt-in Org lifecycle from scaffold through accepted task evidence to archive, alongside Markdown regression tests.

## 4. Project-scoped host and editor adapters

Use the existing CLI as the owner of state, preview, and validation. Target a thin Pi adapter in `src/integrations/pi`, installed via project `.pi/extensions/`, and one thin OpenSpec MCP tool implementation in `src/integrations/mcp` for Codex (`.codex/config.toml`) and Antigravity CLI (`.agents/mcp_config.json`). Check the [official Antigravity CLI MCP documentation](https://antigravity.google/docs/mcp/#antigravity-cli) when specifying that adapter. These repository paths are proposed here; confirm new source directories in the relevant change design before adding them.

Enable the selected host's tool entry point by default and let projects disable it without disabling CLI or skills. Preserve the host's trust rules, require actual approval for mutations, do not equate a `previewHash` with consent, and leave unrelated and user-level config untouched. Put guidance in generated skills, OPSX prompts, and instructions, not hooks or dynamic rule injection. Keep Git worktree workflows, worktree preflight tools, remote operations, and subagent orchestration out of the product; the CLI checks the planning directory, session, and file snapshots. An Emacs adapter under proposed `editors/emacs/` calls the same CLI and uses `openspec.el` only as interaction reference, not source code.

Separate the shared adapter contract, individual host installs, and Emacs integration as needed. Verify enable/disable, refusal/cancel, stale previews, and preservation of unrelated settings for each shipped host.

## 5. Shared store and cross-project acceptance

Reuse v2.2.0 `store` for shared planning, `references` for read-only specification context, and `workset` for organizing directories a person opens together. Do not introduce task distribution or a second project/worktree manager. After single-project behavior works, exercise an Org planning store and two component projects, with Markdown regression coverage. Check both reads and writes: the change and main spec land in the resolved owner and follow its configured workflow, references remain read-only, and neither a sibling project nor a read-only reference receives a write. Test these boundaries at the CLI, then smoke-test them through the shipped adapters.

## Review rhythm

For each change, state what it reuses, brings in, and removes; name file ownership, dependencies, and observable verification. Keep changes serial until shared contracts are stable. If a later proposal identifies independent work, say exactly which steps can run in parallel and with what evidence. No step in this roadmap authorizes implementation, dependency installation, or worktree creation.
