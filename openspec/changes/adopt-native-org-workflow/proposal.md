## Why

Keep the default OpenSpec workflow aligned with upstream so existing projects and future upstream merges do not pay for an Org migration. Projects that prefer Org should be able to opt in and edit native Org files that the CLI reads and validates directly.

## What Changes

- Keep Markdown `spec-driven`, its templates, and its existing parser as the default. Add `spec-driven-org` as a built-in opt-in, selected through the existing `schema:` setting in the planning home's `openspec/config.yaml`.
- The Org workflow produces `proposal.org`, `design.org`, `tasks.org`, and delta `specs/<capability-path>/spec.org`. Main specifications use `spec.org` under `openspec/specs/`. Both workflows keep the existing artifact roles, graph, and planning-home selection.
- Read and validate native Org proposals, main specs, and deltas. Preserve inline markup and report findings against the source file. Select the reader from the configured workflow and artifact kind, not by probing for whichever extension exists.
- Leave existing upstream Markdown planning files untouched. The formats are alternatives for a planning home, not two editable sources for the same artifact. No automatic conversion, Markdown projection from Org, or legacy CLI wrapper.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `openspec-conventions`: Defines the Org file layout and behavioral spec syntax alongside existing Markdown conventions.
- `cli-artifact-workflow`: An Org opt-in reports Org paths and templates; the default and existing Markdown paths stay unchanged.
- `cli-validate`: Validates Org source with native diagnostics while preserving existing Markdown validation.

## Impact

Adds a sibling built-in schema and templates under `schemas/` without replacing `schemas/spec-driven/`. Extends planning and spec readers in `src/core/` and affected commands in `src/commands/`; existing Markdown coverage remains in place.

This is the first change in the [Markdown and Org roadmap](../../work/openspec-org/roadmap.md). Native task operations, spec sync/archive, host and editor adapters, and multi-project verification are separate changes. The Org workflow is not ready to release until its single-project lifecycle passes end to end.
