## ADDED Requirements

### Requirement: Native Org validation

Validation SHALL read Org proposals, main specs, and deltas as Org when selected by the artifact's workflow. Existing Markdown artifacts retain their current validation rules and paths.

#### Scenario: Org proposal with CRLF line endings

- **GIVEN** `proposal.org` has CRLF line endings and contains `* Why` and `* What Changes`
- **WHEN** a user validates the Org change
- **THEN** validation recognizes both sections without reporting line-ending-related findings

#### Scenario: Headings inside Org examples are not structural

- **GIVEN** a requirement's only `*** Scenario:` line is inside an Org source or example block
- **WHEN** the user runs strict validation on a change or main spec
- **THEN** validation reports the requirement as missing a scenario

#### Scenario: Report a nested delta issue on Windows

- **GIVEN** a nested Org delta on Windows has a requirement without a real scenario
- **WHEN** a user validates the change
- **THEN** the finding identifies the native `spec.org` path and the offending requirement location without conversion
- **AND** validation on macOS or Linux reports the same finding in the corresponding native path format

#### Scenario: Markdown diagnostics are unchanged

- **GIVEN** a project uses the default Markdown workflow and has an invalid Markdown spec
- **WHEN** the user validates the spec
- **THEN** the existing Markdown diagnostics and source path are returned
- **AND** the CLI does not substitute an Org spec at the same capability path
