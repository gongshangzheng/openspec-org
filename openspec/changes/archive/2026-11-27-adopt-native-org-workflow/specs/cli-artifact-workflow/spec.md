## ADDED Requirements

### Requirement: Opt-in workflow resolves Org artifacts

OpenSpec SHALL offer a built-in `spec-driven-org` workflow selectable by existing project schema configuration. `spec-driven` SHALL remain the Markdown default.

#### Scenario: Default workflow stays Markdown

- **GIVEN** a planning home has no explicit schema or selects `spec-driven`
- **WHEN** a user creates a change and requests its artifact instructions
- **THEN** the CLI uses the existing Markdown artifact paths, templates, and dependencies

#### Scenario: Org instructions and templates

- **GIVEN** the planning home selects `spec-driven-org`
- **WHEN** a user creates a change and requests artifact instructions or template paths
- **THEN** the CLI identifies the Org templates and destinations
- **AND** examples in the instructions use native Org markup for that artifact

#### Scenario: Status detects only selected artifacts

- **GIVEN** a `spec-driven-org` change contains `proposal.org` and only a Markdown design file
- **WHEN** a user requests change status
- **THEN** status marks the proposal complete and does not mark design complete
- **AND** apply tracks `tasks.org`, not the Markdown checklist

#### Scenario: A new default does not reinterpret an existing change

- **GIVEN** an existing change records `spec-driven` in its metadata and the planning home changes its default to `spec-driven-org`
- **WHEN** the user requests status for that change or creates a new change without a schema override
- **THEN** status for the existing change still uses Markdown paths
- **AND** the new change uses Org paths

#### Scenario: Resolve a nested capability on Windows

- **GIVEN** an Org change on Windows has a delta under a nested capability path
- **WHEN** a user requests JSON status and specification instructions
- **THEN** the CLI preserves the full capability path and resolves the delta inside the change root using native filesystem paths
- **AND** the same artifact and dependency states are reported for an equivalent project on macOS or Linux
