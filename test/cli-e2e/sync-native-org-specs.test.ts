import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCLI } from '../helpers/run-cli.js';

describe('CLI E2E: sync-native-org-specs', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-e2e-sync-org-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function isolatedEnv(home: string): NodeJS.ProcessEnv {
    return {
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_DATA_HOME: path.join(home, 'data'),
      XDG_STATE_HOME: path.join(home, 'state'),
      XDG_CACHE_HOME: path.join(home, 'cache'),
      OPENSPEC_TELEMETRY: '0',
    };
  }

  it('syncs nested Org specs from a subdirectory and via --store with CRLF preservation, idempotency, and guards', async () => {
    const storeRoot = path.join(tempRoot, 'org-store');
    const localRepo = path.join(tempRoot, 'local-repo');
    const nestedCwd = path.join(localRepo, 'packages', 'app', 'src');
    const env = isolatedEnv(path.join(tempRoot, 'home'));

    await fs.mkdir(storeRoot, { recursive: true });
    await fs.mkdir(nestedCwd, { recursive: true });

    // Initialize a registered Org store
    expect(
      (await runCLI(['store', 'setup', 'org-store', '--path', storeRoot, '--no-init-git', '--json'], {
        cwd: tempRoot,
        env,
      })).exitCode
    ).toBe(0);
    await fs.writeFile(
      path.join(storeRoot, 'openspec', 'config.yaml'),
      'schema: spec-driven-org\n'
    );

    const created = await runCLI(
      ['new', 'change', 'nested-org-sync', '--store', 'org-store', '--json'],
      { cwd: nestedCwd, env }
    );
    expect(created.exitCode, created.stdout + created.stderr).toBe(0);
    const changeDir = JSON.parse(created.stdout).change.path;

    // Pre-existing CRLF main spec at nested capability path a/b
    const mainSpec = path.join(storeRoot, 'openspec', 'specs', 'a', 'b', 'spec.org');
    await fs.mkdir(path.dirname(mainSpec), { recursive: true });
    const untouchedBlock = [
      '** Requirement: Retain formatting',
      'The system SHALL keep *bold*, /italic/, ~code~, and =verbatim= intact.',
      '',
      '#+BEGIN_SRC ts',
      'export const keep = true;',
      '#+END_SRC',
      '',
      '*** Scenario: Preserved',
      '- *WHEN* syncing sibling requirements',
      '- *THEN* untouched requirements stay identical',
    ].join('\r\n');
    await fs.writeFile(
      mainSpec,
      [
        '#+TITLE: a/b Specification',
        '#+STARTUP: content',
        '# File header comment',
        '',
        '* Purpose',
        'Coordinate nested ~a/b~ capabilities across platforms.',
        '',
        '* Requirements',
        untouchedBlock,
        '',
        '** Requirement: Legacy rule',
        'The system SHALL apply legacy behavior.',
        '',
        '*** Scenario: Legacy case',
        '- *WHEN* legacy runs',
        '- *THEN* legacy succeeds',
        '',
      ].join('\r\n')
    );

    const deltaSpec = path.join(changeDir, 'specs', 'a', 'b', 'spec.org');
    await fs.mkdir(path.dirname(deltaSpec), { recursive: true });
    await fs.writeFile(
      deltaSpec,
      [
        '* RENAMED Requirements',
        '- FROM: Legacy rule',
        '- TO: Modern rule',
        '',
        '* MODIFIED Requirements',
        '** Requirement: Modern rule',
        'The system SHALL apply modern cross-platform behavior.',
        '',
        '*** Scenario: Legacy case',
        '- *WHEN* legacy runs',
        '- *THEN* legacy succeeds',
        '',
        '*** Scenario: Windows path',
        '- *WHEN* synced from a nested working directory',
        '- *THEN* CRLF endings and relative capability paths are preserved',
        '',
        '* ADDED Requirements',
        '** Requirement: Verify audit',
        'The system SHALL verify new additions cleanly.',
        '',
        '*** Scenario: Added check',
        '- *WHEN* added',
        '- *THEN* validated',
      ].join('\n')
    );

    // Sync from nested subdirectory using --store
    const firstSync = await runCLI(
      ['sync', 'nested-org-sync', '--store', 'org-store', '--json'],
      { cwd: nestedCwd, env }
    );
    expect(firstSync.exitCode, firstSync.stdout + firstSync.stderr).toBe(0);
    const firstJson = JSON.parse(firstSync.stdout);
    expect(firstJson).toMatchObject({
      change: 'nested-org-sync',
      format: 'org',
      synced: true,
      specsUpdated: true,
      changeActive: true,
      totals: { added: 1, modified: 1, removed: 0, renamed: 1 },
    });
    expect(realpathSync.native(firstJson.specs[0].path)).toBe(realpathSync.native(mainSpec));

    // Verify CRLF preservation and verbatim slices
    const updatedMain = await fs.readFile(mainSpec, 'utf-8');
    expect(updatedMain.match(/\r\n/g)?.length).toBeGreaterThan(0);
    expect(updatedMain.match(/(?<!\r)\n/g)).toBeNull();
    expect(updatedMain).toContain('#+TITLE: a/b Specification\r\n#+STARTUP: content\r\n# File header comment');
    expect(updatedMain).toContain(untouchedBlock);
    expect(updatedMain).toContain('** Requirement: Modern rule');
    expect(updatedMain).toContain('** Requirement: Verify audit');
    expect(updatedMain).not.toContain('** Requirement: Legacy rule');

    // Change stays active and no .md projections were written
    expect((await fs.stat(changeDir)).isDirectory()).toBe(true);
    await expect(fs.stat(path.join(changeDir, 'tasks.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(storeRoot, 'openspec', 'specs', 'a', 'b', 'spec.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // Idempotent repeat sync
    const repeatSync = await runCLI(
      ['sync', 'nested-org-sync', '--store', 'org-store', '--json'],
      { cwd: nestedCwd, env }
    );
    expect(repeatSync.exitCode, repeatSync.stdout + repeatSync.stderr).toBe(0);
    expect(JSON.parse(repeatSync.stdout)).toMatchObject({
      synced: true,
      specsUpdated: false,
      totals: { added: 0, modified: 0, removed: 0, renamed: 0 },
    });
    expect(await fs.readFile(mainSpec, 'utf-8')).toBe(updatedMain);

    // Path-traversal rejection
    const traversal = await runCLI(
      ['sync', '../escape', '--store', 'org-store', '--json'],
      { cwd: nestedCwd, env }
    );
    expect(traversal.exitCode).toBe(1);
    expect(JSON.parse(traversal.stdout).status[0].message).toContain('Invalid change name');

    // Cross-format rejection in local Markdown repo with zero writes
    expect((await runCLI(['init', '--tools', 'none'], { cwd: localRepo, env })).exitCode).toBe(0);
    const mdChange = JSON.parse(
      (await runCLI(['new', 'change', 'md-ok', '--json'], { cwd: localRepo, env })).stdout
    ).change;
    const mdDelta = path.join(mdChange.path, 'specs', 'core', 'spec.md');
    await fs.mkdir(path.dirname(mdDelta), { recursive: true });
    await fs.writeFile(
      mdDelta,
      [
        '## Purpose',
        'Provide core Markdown regression coverage.',
        '',
        '## ADDED Requirements',
        '### Requirement: Keep markdown working',
        'The system SHALL keep Markdown sync working.',
        '',
        '#### Scenario: Markdown sync',
        '- **WHEN** syncing a Markdown change',
        '- **THEN** spec.md is written',
      ].join('\n')
    );

    const mdSync = await runCLI(['sync', 'md-ok', '--json'], { cwd: nestedCwd, env });
    expect(mdSync.exitCode, mdSync.stdout + mdSync.stderr).toBe(0);
    expect(
      await fs.readFile(path.join(localRepo, 'openspec', 'specs', 'core', 'spec.md'), 'utf-8')
    ).toContain('Keep markdown working');

    // Org change against local Markdown repo is rejected before any write
    const badOrg = JSON.parse(
      (
        await runCLI(
          ['new', 'change', 'bad-org', '--schema', 'spec-driven-org', '--json'],
          { cwd: localRepo, env }
        )
      ).stdout
    ).change;
    await fs.mkdir(path.join(badOrg.path, 'specs', 'core'), { recursive: true });
    await fs.writeFile(
      path.join(badOrg.path, 'specs', 'core', 'spec.org'),
      '* ADDED Requirements\n** Requirement: Bad\nThe system SHALL fail.\n*** Scenario: S\n- *WHEN* run\n- *THEN* blocked\n'
    );
    const blockedCross = await runCLI(['sync', 'bad-org', '--json'], { cwd: nestedCwd, env });
    expect(blockedCross.exitCode).toBe(1);
    expect(JSON.parse(blockedCross.stdout).status[0].message).toContain('Cross-format spec sync rejected');
    await expect(
      fs.stat(path.join(localRepo, 'openspec', 'specs', 'core', 'spec.org'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);
});
