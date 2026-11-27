import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertCompatibleSpecFormat,
  buildUpdatedSpec,
  findSpecUpdates,
  retireSpec,
  writeUpdatedSpec,
} from '../../src/core/specs-apply.js';

const itWithSymlinks = it.skipIf(process.platform === 'win32');

describe('format-aware specs-apply', () => {
  let tempDir: string;
  let projectRoot: string;
  let changeDir: string;
  let mainSpecsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-specs-apply-format-'));
    projectRoot = path.join(tempDir, 'repo');
    changeDir = path.join(projectRoot, 'openspec', 'changes', 'demo-change');
    mainSpecsDir = path.join(projectRoot, 'openspec', 'specs');
    await fs.mkdir(path.join(changeDir, 'specs', 'widgets'), { recursive: true });
    await fs.mkdir(mainSpecsDir, { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('dispatches markdown by default and org when format is explicit, preserving CRLF', async () => {
    await fs.writeFile(path.join(projectRoot, 'openspec', 'config.yaml'), 'schema: spec-driven-org\n');
    await fs.writeFile(
      path.join(changeDir, '.openspec.yaml'),
      'schema: spec-driven-org\ncreated: 2026-11-27\n'
    );

    const deltaPath = path.join(changeDir, 'specs', 'widgets', 'spec.org');
    await fs.writeFile(
      deltaPath,
      [
        '* MODIFIED Requirements',
        '** Requirement: Render widget',
        'The system SHALL render widgets with /updated/ Org emphasis.',
        '',
        '*** Scenario: Render',
        '- *WHEN* rendered',
        '- *THEN* output is updated',
      ].join('\n')
    );

    const mainTarget = path.join(mainSpecsDir, 'widgets', 'spec.org');
    await fs.mkdir(path.dirname(mainTarget), { recursive: true });
    await fs.writeFile(
      mainTarget,
      [
        '#+TITLE: widgets Specification',
        '',
        '* Purpose',
        'Render widgets cleanly.',
        '',
        '* Requirements',
        '** Requirement: Render widget',
        'The system SHALL render widgets.',
        '',
        '*** Scenario: Render',
        '- *WHEN* rendered',
        '- *THEN* output is shown',
        '',
      ].join('\r\n')
    );

    const format = assertCompatibleSpecFormat(projectRoot, changeDir);
    expect(format).toBe('org');

    const updates = await findSpecUpdates(changeDir, mainSpecsDir, format);
    expect(updates).toHaveLength(1);
    expect(updates[0].target).toBe(path.join(await fs.realpath(mainSpecsDir), 'widgets', 'spec.org'));

    const built = await buildUpdatedSpec(updates[0], 'demo-change', { silent: true, format });
    expect(built.counts).toEqual({ added: 0, modified: 1, removed: 0, renamed: 0 });
    await writeUpdatedSpec(updates[0], built.rebuilt, built.counts, { silent: true, format });

    const written = await fs.readFile(mainTarget, 'utf-8');
    expect(written).toContain('/updated/ Org emphasis');
    expect(written.match(/\r\n/g)?.length).toBeGreaterThan(0);
    expect(written.match(/(?<!\r)\n/g)).toBeNull();

    // Repeat is idempotent
    const repeat = await buildUpdatedSpec(updates[0], 'demo-change', { silent: true, format });
    expect(repeat.counts).toEqual({ added: 0, modified: 0, removed: 0, renamed: 0 });
  });

  it('retires spec.org and prunes empty directories', async () => {
    const mainTarget = path.join(mainSpecsDir, 'nested', 'widgets', 'spec.org');
    await fs.mkdir(path.dirname(mainTarget), { recursive: true });
    await fs.writeFile(mainTarget, '* Purpose\nWidgets.\n* Requirements\n');
    await fs.mkdir(path.join(changeDir, 'specs', 'nested', 'widgets'), { recursive: true });
    await fs.writeFile(
      path.join(changeDir, 'specs', 'nested', 'widgets', 'spec.org'),
      '* REMOVED Requirements\n** Requirement: Old\n'
    );

    const [update] = await findSpecUpdates(changeDir, mainSpecsDir, 'org');
    const res = await retireSpec(update, mainSpecsDir, { silent: true, format: 'org' });
    expect(res.retired).toBe(true);
    await expect(fs.stat(mainTarget)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(mainSpecsDir, 'nested'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects cross-format workflows and opposite-format target files with zero mutation', async () => {
    // Org change vs Markdown project config
    await fs.writeFile(
      path.join(changeDir, '.openspec.yaml'),
      'schema: spec-driven-org\ncreated: 2026-11-27\n'
    );
    expect(() => assertCompatibleSpecFormat(projectRoot, changeDir)).toThrow(
      /Cross-format spec sync rejected/
    );

    // Markdown change vs Org project config
    await fs.writeFile(path.join(projectRoot, 'openspec', 'config.yaml'), 'schema: spec-driven-org\n');
    await fs.writeFile(
      path.join(changeDir, '.openspec.yaml'),
      'schema: spec-driven\ncreated: 2026-11-27\n'
    );
    expect(() => assertCompatibleSpecFormat(projectRoot, changeDir)).toThrow(
      /Cross-format spec sync rejected/
    );

    // Org delta hitting existing spec.md
    const existingMd = path.join(mainSpecsDir, 'widgets', 'spec.md');
    await fs.mkdir(path.dirname(existingMd), { recursive: true });
    await fs.writeFile(existingMd, '# widgets Specification\n\n## Purpose\nKeep untouched.\n');
    await fs.writeFile(
      path.join(changeDir, 'specs', 'widgets', 'spec.org'),
      '* ADDED Requirements\n** Requirement: X\nThe system SHALL x.\n*** Scenario: S\n- *WHEN* x\n- *THEN* y\n'
    );
    await expect(findSpecUpdates(changeDir, mainSpecsDir, 'org')).rejects.toThrow(
      /Cross-format spec conflict/
    );
    expect(await fs.readFile(existingMd, 'utf-8')).toContain('Keep untouched.');

    // Markdown delta hitting existing spec.org
    await fs.rm(existingMd);
    const existingOrg = path.join(mainSpecsDir, 'widgets', 'spec.org');
    await fs.writeFile(existingOrg, '* Purpose\nKeep org untouched.\n* Requirements\n');
    await fs.writeFile(
      path.join(changeDir, 'specs', 'widgets', 'spec.md'),
      '## ADDED Requirements\n### Requirement: X\nThe system SHALL x.\n#### Scenario: S\n- **WHEN** x\n- **THEN** y\n'
    );
    await expect(findSpecUpdates(changeDir, mainSpecsDir, 'markdown')).rejects.toThrow(
      /Cross-format spec conflict/
    );
    expect(await fs.readFile(existingOrg, 'utf-8')).toContain('Keep org untouched.');
  });

  itWithSymlinks('blocks escaping symlinks for spec.org', async () => {
    const outsideDir = path.join(tempDir, 'outside');
    await fs.mkdir(outsideDir, { recursive: true });
    const outsideOrg = path.join(outsideDir, 'spec.org');
    await fs.writeFile(outsideOrg, 'outside sentinel');
    await fs.symlink(outsideOrg, path.join(changeDir, 'specs', 'widgets', 'spec.org'));

    await expect(findSpecUpdates(changeDir, mainSpecsDir, 'org')).rejects.toThrow(
      'Path is outside the allowed directory'
    );
    expect(await fs.readFile(outsideOrg, 'utf-8')).toBe('outside sentinel');
  });
});
