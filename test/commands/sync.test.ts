import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCLI } from '../helpers/run-cli.js';

describe('openspec sync command', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-sync-cmd-'));
    const init = await runCLI(['init', '--tools', 'none'], { cwd: root });
    expect(init.exitCode, init.stdout + init.stderr).toBe(0);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('syncs a Markdown change in text and JSON modes while keeping the change active', async () => {
    const created = await runCLI(['new', 'change', 'md-sync', '--json'], { cwd: root });
    expect(created.exitCode).toBe(0);
    const changeDir = JSON.parse(created.stdout).change.path;

    const deltaPath = path.join(changeDir, 'specs', 'billing', 'spec.md');
    await fs.mkdir(path.dirname(deltaPath), { recursive: true });
    await fs.writeFile(
      deltaPath,
      [
        '## Purpose',
        'Process invoices and billing statements cleanly.',
        '',
        '## ADDED Requirements',
        '### Requirement: Issue invoice',
        'The system SHALL issue numbered invoices.',
        '',
        '#### Scenario: Invoice created',
        '- **WHEN** a charge settles',
        '- **THEN** an invoice is issued',
      ].join('\n')
    );

    const first = await runCLI(['sync', 'md-sync', '--json'], { cwd: root });
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    const firstPayload = JSON.parse(first.stdout);
    expect(firstPayload).toMatchObject({
      change: 'md-sync',
      format: 'markdown',
      synced: true,
      specsUpdated: true,
      changeActive: true,
      totals: { added: 1, modified: 0, removed: 0, renamed: 0 },
    });
    expect(firstPayload.specs[0].action).toBe('created');

    // Change directory remains active
    expect((await fs.stat(changeDir)).isDirectory()).toBe(true);
    const mainSpec = path.join(root, 'openspec', 'specs', 'billing', 'spec.md');
    expect(await fs.readFile(mainSpec, 'utf-8')).toContain('Issue invoice');

    // Repeat sync in human mode is idempotent
    const second = await runCLI(['sync', 'md-sync'], { cwd: root });
    expect(second.exitCode, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain('already in sync');
    expect(second.stdout).toContain('Change remains active');
  });

  it('syncs an Org change, supports retirement with retire_capabilities, and blocks unsafe retirement', async () => {
    await fs.writeFile(path.join(root, 'openspec', 'config.yaml'), 'schema: spec-driven-org\n');
    const created = await runCLI(['new', 'change', 'org-sync', '--json'], { cwd: root });
    expect(created.exitCode).toBe(0);
    const changeDir = JSON.parse(created.stdout).change.path;

    const mainSpec = path.join(root, 'openspec', 'specs', 'auth', 'spec.org');
    await fs.mkdir(path.dirname(mainSpec), { recursive: true });
    const originalMain = [
      '#+TITLE: Auth Specification',
      '#+STARTUP: overview',
      '',
      '* Purpose',
      'Manage authentication tokens safely across sessions.',
      '',
      '* Requirements',
      '** Requirement: Token check',
      'The system SHALL verify ~JWT~ tokens.',
      '',
      '*** Scenario: Valid token',
      '- *WHEN* token is valid',
      '- *THEN* access succeeds',
      '',
    ].join('\n');
    await fs.writeFile(mainSpec, originalMain);

    const deltaPath = path.join(changeDir, 'specs', 'auth', 'spec.org');
    await fs.mkdir(path.dirname(deltaPath), { recursive: true });
    await fs.writeFile(
      deltaPath,
      [
        '* REMOVED Requirements',
        '** Requirement: Token check',
      ].join('\n')
    );

    // Without retire_capabilities: true, refuse and leave main spec untouched
    const blocked = await runCLI(['sync', 'org-sync', '--json'], { cwd: root });
    expect(blocked.exitCode).toBe(1);
    expect(JSON.parse(blocked.stdout).status[0].message).toContain('retire_capabilities: true');
    expect(await fs.readFile(mainSpec, 'utf-8')).toBe(originalMain);

    // With retire_capabilities: true, retire cleanly and report * Purpose
    await fs.writeFile(
      path.join(changeDir, '.openspec.yaml'),
      'schema: spec-driven-org\ncreated: 2026-11-27\nretire_capabilities: true\n'
    );
    const retired = await runCLI(['sync', 'org-sync', '--json'], { cwd: root });
    expect(retired.exitCode, retired.stdout + retired.stderr).toBe(0);
    const payload = JSON.parse(retired.stdout);
    expect(payload.specs[0]).toMatchObject({
      id: 'auth',
      action: 'retired',
      retiredPurpose: 'Manage authentication tokens safely across sessions.',
    });
    expect(payload.warnings.join('\n')).toContain('* Purpose');
    await expect(fs.stat(mainSpec)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects missing change, missing deltas, cross-format mismatch, and --store-path', async () => {
    const missing = await runCLI(['sync', 'does-not-exist', '--json'], { cwd: root });
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout).status[0].message).toContain("Change 'does-not-exist' not found");

    const empty = await runCLI(['new', 'change', 'empty-change', '--json'], { cwd: root });
    expect(empty.exitCode).toBe(0);
    const noDeltas = await runCLI(['sync', 'empty-change', '--json'], { cwd: root });
    expect(noDeltas.exitCode).toBe(1);
    expect(JSON.parse(noDeltas.stdout).status[0].message).toContain('No delta specs found');

    const storePath = await runCLI(['sync', 'empty-change', '--store-path', root, '--json'], {
      cwd: root,
    });
    expect(storePath.exitCode).toBe(1);
    expect(JSON.parse(storePath.stdout).status[0].code).toBe('store_path_not_supported');

    const cross = await runCLI(
      ['new', 'change', 'org-in-md', '--schema', 'spec-driven-org', '--json'],
      { cwd: root }
    );
    expect(cross.exitCode).toBe(0);
    const crossDir = JSON.parse(cross.stdout).change.path;
    await fs.mkdir(path.join(crossDir, 'specs', 'auth'), { recursive: true });
    await fs.writeFile(
      path.join(crossDir, 'specs', 'auth', 'spec.org'),
      '* ADDED Requirements\n** Requirement: X\nThe system SHALL x.\n*** Scenario: S\n- *WHEN* x\n- *THEN* y\n'
    );

    const mismatch = await runCLI(['sync', 'org-in-md', '--json'], { cwd: root });
    expect(mismatch.exitCode).toBe(1);
    expect(JSON.parse(mismatch.stdout).status[0].message).toContain('Cross-format spec sync rejected');
    await expect(fs.stat(path.join(root, 'openspec', 'specs', 'auth'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
