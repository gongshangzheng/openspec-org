# OpenSpec Org Goal

## Destination

Extend upstream OpenSpec v2.2.0 with a native Org workflow while keeping Markdown as the default. A person or agent can opt in to Org and create, review, implement, sync, and archive a change using Org files, whether the planning home lives in the project or in a shared store.

Proposal explains why and where the change stops; specification describes observable behavior; design records implementation choices; tasks define verifiable work. A task need not correspond one-to-one with a requirement or scenario.

## Boundaries

- Keep upstream's MIT license and attribution, source and test layout, artifact graph, planning-home model, and delta semantics where they apply.
- Keep the upstream Markdown schema, templates, and parser. Org is a separate workflow selected by configuration, not a fallback or duplicate source. Native Markdown projects keep their `tasks.md`; Org projects do not project one from `tasks.org`. Do not add a legacy CLI wrapper or a separate task-tools package. Host `SKILL.md`, OPSX prompts, and instructions are not planning artifacts.
- Leave existing upstream Markdown artifacts and Git history alone. No migration is required for Markdown projects. An agent or maintainer may convert artifacts when intentionally switching a planning home to Org; the CLI does not automate it.
- Refer to the old Tangwen Org implementation read-only. Do not migrate the checkout or bundle its worktree, branch, Orca, remote, or subagent workflows. Do not copy GPL-3.0 Emacs Lisp into this MIT fork.

## Release Evidence

1. The default Markdown workflow passes its existing regression suite. A separate opt-in Org fixture completes a single-project change from scaffold to archive, with task evidence and independent spec sync demonstrated.
2. Project-scoped host installs default to the tool entry point, honor its off switch, and preserve real user approval. CLI and skills still work with the tool entry point disabled.
3. A shared store and two component projects demonstrate target resolution, read-only reference context, and no writes to a sibling project or reference.

See [roadmap.md](roadmap.md) for the proposed change sequence.
