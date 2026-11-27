import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildUpdatedOrgSpec,
  findOrgMainSpecStructureIssues,
} from '../../src/core/specs-apply-org.js';
import { findSpecUpdates } from '../../src/core/specs-apply.js';
import { Validator } from '../../src/core/validation/validator.js';
import { VALIDATION_MESSAGES } from '../../src/core/validation/constants.js';

describe('specs-apply-org', () => {
  let tempDir: string;
  let changeDir: string;
  let mainSpecsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-specs-apply-org-'));
    changeDir = path.join(tempDir, 'openspec', 'changes', 'org-sync-test');
    mainSpecsDir = path.join(tempDir, 'openspec', 'specs');
    await fs.mkdir(path.join(changeDir, 'specs', 'auth'), { recursive: true });
    await fs.mkdir(mainSpecsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeDelta(content: string, capability = 'auth'): Promise<void> {
    const file = path.join(changeDir, 'specs', capability, 'spec.org');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf-8');
  }

  async function writeMain(content: string, capability = 'auth'): Promise<string> {
    const file = path.join(mainSpecsDir, capability, 'spec.org');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf-8');
    return file;
  }

  it('creates a new Org main spec reusing delta Purpose or falling back to placeholder', async () => {
    await writeDelta([
      '#+TITLE: Spec Delta',
      '',
      '* Purpose',
      'Authenticate callers using signed session tokens with short expiry windows.',
      '',
      '* ADDED Requirements',
      '** Requirement: Issue session token',
      'The system SHALL issue signed tokens with *strict* expiry and ~sha256~ digests.',
      '',
      '*** Scenario: Valid credentials',
      '- *WHEN* valid credentials are submitted',
      '- *THEN* a signed token is returned',
    ].join('\n'));

    const [update] = await findSpecUpdates(changeDir, mainSpecsDir, 'org');
    const built = await buildUpdatedOrgSpec(update, 'org-sync-test', { silent: true });

    expect(built.counts).toEqual({ added: 1, modified: 0, removed: 0, renamed: 0 });
    expect(built.warnings).toEqual([]);
    expect(built.rebuilt).toContain('#+TITLE: auth Specification');
    expect(built.rebuilt).toContain('* Purpose\n\nAuthenticate callers using signed session tokens with short expiry windows.');
    expect(built.rebuilt).toContain('* Requirements\n\n** Requirement: Issue session token');
    expect(built.rebuilt).toContain('*strict* expiry and ~sha256~ digests');

    const report = await new Validator(true).validateSpecContent('auth', built.rebuilt, {
      format: 'org',
    });
    expect(report.valid).toBe(true);

    // Comment-only Purpose falls back to placeholder
    await writeDelta([
      '* Purpose',
      '# Include Purpose only for a new capability.',
      '',
      '* ADDED Requirements',
      '** Requirement: Placeholder check',
      'The system SHALL write a placeholder purpose.',
      '',
      '*** Scenario: Created',
      '- *WHEN* created without Purpose prose',
      '- *THEN* placeholder is written',
    ].join('\n'));

    const [update2] = await findSpecUpdates(changeDir, mainSpecsDir, 'org');
    const built2 = await buildUpdatedOrgSpec(update2, 'org-sync-test', { silent: true });
    expect(built2.rebuilt).toContain('TBD - created by archiving change org-sync-test.');
  });

  it('preserves headers, untouched blocks, inline markup, code/example blocks, and trailing sections on local slice updates', async () => {
    const untouchedBlock = [
      '** Requirement: Audit trail',
      'The system SHALL log *bold*, /italic/, ~code~, and =verbatim= payloads.',
      '',
      '#+BEGIN_SRC json',
      '{"event":"login","ok":true}',
      '#+END_SRC',
      '',
      '*** Scenario: Successful audit',
      '- *WHEN* an action completes',
      '- *THEN* the JSON block is recorded',
      '',
      '#+BEGIN_EXAMPLE',
      '* Not a heading',
      '** Requirement: Decoy inside example',
      '#+END_EXAMPLE',
    ].join('\n');

    await writeMain([
      '#+TITLE: Auth Spec Custom',
      '#+STARTUP: overview',
      '# Preserved top-level comment',
      '',
      '* Purpose',
      'Custom purpose with /emphasis/ and ~tokens~.',
      '',
      '* Requirements',
      untouchedBlock,
      '',
      '** Requirement: Legacy login',
      'The system SHALL support password login.',
      '',
      '*** Scenario: Password accepted',
      '- *WHEN* password matches',
      '- *THEN* user signs in',
      '',
      '** Requirement: Obsolete flow',
      'The system SHALL drop old flow.',
      '',
      '*** Scenario: Removed',
      '- *WHEN* called',
      '- *THEN* rejected',
      '',
      '* Appendix',
      'Keep this trailing section intact.',
    ].join('\n'));

    await writeDelta([
      '* RENAMED Requirements',
      '- FROM: Legacy login',
      '- TO: Password login',
      '',
      '* REMOVED Requirements',
      '** Requirement: Obsolete flow',
      '',
      '* MODIFIED Requirements',
      '** Requirement: Password login',
      'The system SHALL enforce rate limits on password login.',
      '',
      '*** Scenario: Password accepted',
      '- *WHEN* password matches',
      '- *THEN* user signs in',
      '',
      '*** Scenario: Rate limited',
      '- *WHEN* too many attempts occur',
      '- *THEN* login is throttled',
      '',
      '* ADDED Requirements',
      '** Requirement: MFA verification',
      'The system SHALL verify TOTP codes.',
      '',
      '*** Scenario: Valid code',
      '- *WHEN* a valid TOTP code is submitted',
      '- *THEN* access is granted',
    ].join('\n'));

    const [update] = await findSpecUpdates(changeDir, mainSpecsDir, 'org');
    const built = await buildUpdatedOrgSpec(update, 'org-sync-test', { silent: true });

    expect(built.counts).toEqual({ added: 1, modified: 1, removed: 1, renamed: 1 });
    expect(built.rebuilt).toContain('#+TITLE: Auth Spec Custom\n#+STARTUP: overview\n# Preserved top-level comment');
    expect(built.rebuilt).toContain(untouchedBlock);
    expect(built.rebuilt).toContain('** Requirement: Password login\nThe system SHALL enforce rate limits');
    expect(built.rebuilt).not.toContain('** Requirement: Legacy login');
    expect(built.rebuilt).not.toContain('** Requirement: Obsolete flow');
    expect(built.rebuilt).toContain('** Requirement: MFA verification');
    expect(built.rebuilt).toContain('* Appendix\nKeep this trailing section intact.');
  });

  it('renames only the heading line for RENAMED when not modified', async () => {
    await writeMain([
      '#+TITLE: Auth Spec',
      '',
      '* Purpose',
      'Manage auth.',
      '',
      '* Requirements',
      '** Requirement: Old name',
      'The system SHALL keep *exact* body spacing  and ~inline~ markup.',
      '',
      '*** Scenario: Preserved',
      '- *WHEN* triggered',
      '- *THEN* body stays verbatim',
    ].join('\n'));

    await writeDelta([
      '* RENAMED Requirements',
      '- FROM: Old name',
      '- TO: New name',
    ].join('\n'));

    const [update] = await findSpecUpdates(changeDir, mainSpecsDir, 'org');
    const built = await buildUpdatedOrgSpec(update, 'org-sync-test', { silent: true });

    expect(built.counts).toEqual({ added: 0, modified: 0, removed: 0, renamed: 1 });
    expect(built.rebuilt).toContain(
      '** Requirement: New name\nThe system SHALL keep *exact* body spacing  and ~inline~ markup.\n\n*** Scenario: Preserved'
    );
  });

  it('applies deltas idempotently on repeated runs', async () => {
    const syncedMain = [
      '#+TITLE: auth Specification',
      '',
      '* Purpose',
      'Manage authentication safely and reliably across sessions.',
      '',
      '* Requirements',
      '** Requirement: New name',
      'The system SHALL support MFA.',
      '',
      '*** Scenario: Verified',
      '- *WHEN* code matches',
      '- *THEN* session starts',
    ].join('\n') + '\n';

    await writeMain(syncedMain);
    await writeDelta([
      '* RENAMED Requirements',
      '- FROM: Old name',
      '- TO: New name',
      '',
      '* REMOVED Requirements',
      '** Requirement: Already gone',
      '',
      '* MODIFIED Requirements',
      '** Requirement: New name',
      'The system SHALL support MFA.',
      '',
      '*** Scenario: Verified',
      '- *WHEN* code matches',
      '- *THEN* session starts',
      '',
      '* ADDED Requirements',
      '** Requirement: New name',
      'The system SHALL support MFA.',
      '',
      '*** Scenario: Verified',
      '- *WHEN* code matches',
      '- *THEN* session starts',
    ].join('\n'));

    // Note: MODIFIED + ADDED on same name is normally rejected in cross-section check;
    // test separate idempotent operations cleanly:
    await writeDelta([
      '* RENAMED Requirements',
      '- FROM: Old name',
      '- TO: New name',
      '',
      '* REMOVED Requirements',
      '** Requirement: Already gone',
      '',
      '* MODIFIED Requirements',
      '** Requirement: New name',
      'The system SHALL support MFA.',
      '',
      '*** Scenario: Verified',
      '- *WHEN* code matches',
      '- *THEN* session starts',
    ].join('\n'));

    const [update] = await findSpecUpdates(changeDir, mainSpecsDir, 'org');
    const built = await buildUpdatedOrgSpec(update, 'org-sync-test', { silent: true });
    expect(built.counts).toEqual({ added: 0, modified: 0, removed: 0, renamed: 0 });
    expect(built.rebuilt).toBe(syncedMain);
  });

  it('blocks MODIFIED when scenarios are dropped (including multiplicity-aware duplicate names)', async () => {
    await writeMain([
      '* Purpose',
      'Test scenario loss guard.',
      '',
      '* Requirements',
      '** Requirement: Guarded',
      'The system SHALL guard scenarios.',
      '',
      '*** Scenario: Repeated',
      '- *WHEN* case 1',
      '- *THEN* ok 1',
      '',
      '*** Scenario: Repeated',
      '- *WHEN* case 2',
      '- *THEN* ok 2',
    ].join('\n'));

    await writeDelta([
      '* MODIFIED Requirements',
      '** Requirement: Guarded',
      'The system SHALL guard scenarios.',
      '',
      '*** Scenario: Repeated',
      '- *WHEN* case 1',
      '- *THEN* ok 1',
    ].join('\n'));

    const [update] = await findSpecUpdates(changeDir, mainSpecsDir, 'org');
    await expect(buildUpdatedOrgSpec(update, 'org-sync-test', { silent: true })).rejects.toThrow(
      /current spec contains scenario\(s\) not present in the modified block: "Repeated"/
    );
  });

  it('rejects structurally invalid main spec.org files', () => {
    expect(
      findOrgMainSpecStructureIssues(
        '* Purpose\nValid.\n* Requirements\n* ADDED Requirements\n** Requirement: A\nBody.\n'
      ).map((i) => i.kind)
    ).toContain('delta-header');

    expect(
      findOrgMainSpecStructureIssues(
        '* Purpose\n** Requirement: Outside\nBody.\n* Requirements\n'
      ).map((i) => i.kind)
    ).toContain('requirement-outside-requirements');

    expect(
      findOrgMainSpecStructureIssues(
        '* Purpose\nValid.\n* Requirements\n* Requirements\n'
      ).map((i) => i.kind)
    ).toContain('duplicate-requirements-section');

    expect(
      findOrgMainSpecStructureIssues(
        '* Purpose\nValid.\n* Requirements\n** Requirement: Dup\nOne.\n** Requirement: Dup\nTwo.\n'
      ).map((i) => i.kind)
    ).toContain('duplicate-requirement');
  });

  it('audits whole-file unaccounted content for capability retirement', async () => {
    await writeDelta([
      '* REMOVED Requirements',
      '** Requirement: Only req',
    ].join('\n'));

    // Clean spec.org -> unaccountedContent is empty
    await writeMain([
      '#+TITLE: Auth Specification',
      '#+STARTUP: overview',
      '# Header comment',
      '',
      '* Purpose',
      'Clean purpose that is long enough to validate cleanly in strict mode.',
      '',
      '* Requirements',
      '** Requirement: Only req',
      'The system SHALL work.',
      '',
      '*** Scenario: Works',
      '- *WHEN* called',
      '- *THEN* works',
    ].join('\n'));

    const [cleanUpdate] = await findSpecUpdates(changeDir, mainSpecsDir, 'org');
    const cleanBuilt = await buildUpdatedOrgSpec(cleanUpdate, 'org-sync-test', { silent: true });
    expect(cleanBuilt.noRequirementBlocks).toBe(true);
    expect(cleanBuilt.unaccountedContent).toEqual([]);

    // Spec with trailing * Notes and loose prose below scenario -> unaccountedContent non-empty
    await writeMain([
      '#+TITLE: Auth Specification',
      '* Purpose',
      'Clean purpose.',
      '',
      '* Requirements',
      '** Requirement: Only req',
      'The system SHALL work.',
      '',
      '*** Scenario: Works',
      '- *WHEN* called',
      '- *THEN* works',
      '',
      'Hand-written note after scenario.',
      '',
      '* Notes',
      'Keep this note.',
    ].join('\n'));

    const [dirtyUpdate] = await findSpecUpdates(changeDir, mainSpecsDir, 'org');
    const dirtyBuilt = await buildUpdatedOrgSpec(dirtyUpdate, 'org-sync-test', { silent: true });
    expect(dirtyBuilt.noRequirementBlocks).toBe(true);
    expect(dirtyBuilt.unaccountedContent).toEqual([
      'Hand-written note after scenario.',
      '* Notes',
      'Keep this note.',
    ]);
  });

  it('supports format option in Validator.validateSpecContent while keeping markdown default', async () => {
    const validator = new Validator(true);
    const mdSpec = [
      '# demo Specification',
      '',
      '## Purpose',
      'This specification describes the markdown default behavior for validation.',
      '',
      '## Requirements',
      '### Requirement: Default markdown',
      'The system SHALL validate markdown by default.',
      '',
      '#### Scenario: Default',
      '- **WHEN** called without format',
      '- **THEN** markdown validation runs',
    ].join('\n');
    expect((await validator.validateSpecContent('demo', mdSpec)).valid).toBe(true);

    const orgSpec = [
      '#+TITLE: demo Specification',
      '',
      '* Purpose',
      'This specification describes the Org mode behavior for content validation.',
      '',
      '* Requirements',
      '** Requirement: Explicit org',
      'The system SHALL validate Org specs when format is org.',
      '',
      '*** Scenario: Org',
      '- *WHEN* format is org',
      '- *THEN* Org validation runs',
    ].join('\n');
    expect((await validator.validateSpecContent('demo', orgSpec, { format: 'org' })).valid).toBe(
      true
    );

    const emptyOrgSpec = [
      '#+TITLE: demo Specification',
      '',
      '* Purpose',
      'This specification has enough purpose text to trigger only SPEC_NO_REQUIREMENTS.',
      '',
      '* Requirements',
    ].join('\n');
    const emptyReport = await validator.validateSpecContent('demo', emptyOrgSpec, {
      format: 'org',
    });
    expect(emptyReport.valid).toBe(false);
    expect(emptyReport.issues.some((i) => i.message === VALIDATION_MESSAGES.SPEC_NO_REQUIREMENTS)).toBe(
      true
    );
  });
});
