import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCLI } from '../helpers/run-cli.js';

let root: string;
const capability = 'platform/session';
const purpose = 'Persist session state so clients can resume their work after reopening.';
const orgRequirement = '** Requirement: Org session\nThe system SHALL preserve ~state~.\n*** Scenario: Resume\n- *WHEN* reopening\n- *THEN* the previous state returns';
const mdRequirement = '### Requirement: Markdown session\nThe system SHALL retain state.\n#### Scenario: Resume\n- **WHEN** reopening\n- **THEN** the previous state returns';

async function write(relativePath: string[], content: string) {
  const file = path.join(root, 'openspec', ...relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

async function json(args: string[]) {
  const result = await runCLI([...args, '--json'], { cwd: root });
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-org-cli-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('lists, shows and validates only the configured main spec format', async () => {
  const orgFile = await write(['specs', 'platform', 'session', 'spec.org'], `* Purpose\n${purpose}\n* Requirements\n${orgRequirement}`);
  await write(['specs', 'platform', 'session', 'spec.md'], `## Purpose\n${purpose}\n## Requirements\n${mdRequirement}`);
  await write(['specs', 'only-org', 'spec.org'], `* Purpose\n${purpose}\n* Requirements\n${orgRequirement}`);
  const defaultList = await json(['list', '--specs']);
  expect(defaultList.specs).toEqual([{ id: capability, requirementCount: 1 }]);
  expect((await json(['show', capability])).requirements[0].name).toBe('Markdown session');
  await json(['validate', capability, '--strict']);

  await write(['config.yaml'], 'schema: spec-driven-org\n');
  const selected = await json(['list', '--specs']);
  expect(selected.specs).toEqual([{ id: 'only-org', requirementCount: 1 }, { id: capability, requirementCount: 1 }]);
  expect((await json(['show', capability])).requirements[0]).toMatchObject({ name: 'Org session', text: 'The system SHALL preserve ~state~.' });
  await json(['validate', capability, '--strict']);
  await json(['validate', '--specs', '--strict']);

  await fs.rm(orgFile);
  const absent = await runCLI(['show', capability, '--type', 'spec'], { cwd: root });
  expect(absent.exitCode).toBe(1);
  expect(absent.stderr).toContain('spec.org');
  const invalid = await runCLI(['validate', capability, '--type', 'spec', '--strict'], { cwd: root });
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stderr + invalid.stdout).toContain('spec.org');
  expect((await json(['list', '--specs'])).specs).toEqual([{ id: 'only-org', requirementCount: 1 }]);
});

it('uses the change schema for proposal and delta even when the project defaults to Markdown', async () => {
  const change = ['changes', 'org-change'];
  await write([...change, '.openspec.yaml'], 'schema: spec-driven-org\n');
  const orgProposal = await write([...change, 'proposal.org'], '#+TITLE: Org change\n* Why\nUse Org.\n* What Changes\nRead native artifacts.\n');
  await write([...change, 'proposal.md'], '# Other title\n');
  const orgDelta = await write([...change, 'specs', 'platform', 'session', 'spec.org'], `* ADDED Requirements\n${orgRequirement}`);
  await write([...change, 'specs', 'platform', 'session', 'spec.md'], `## ADDED Requirements\n${mdRequirement}`);
  const shown = await json(['show', 'org-change']);
  expect(shown.title).toBe('Org change');
  expect(shown.deltas).toMatchObject([{ spec: capability, requirement: { name: 'Org session' } }]);
  expect((await json(['list'])).changes.map(({ name }: { name: string }) => name)).toContain('org-change');
  expect((await json(['change', 'list']))[0]).toMatchObject({ title: 'Org change', deltaCount: 1 });
  await json(['validate', 'org-change', '--strict']);
  await fs.rm(orgDelta);
  expect((await json(['show', 'org-change'])).deltas).toEqual([]);
  const noDeltas = await runCLI(['validate', 'org-change', '--strict'], { cwd: root });
  expect(noDeltas.exitCode).toBe(1);
  expect(noDeltas.stderr + noDeltas.stdout).toMatch(/at least one delta/i);
  await fs.rm(orgProposal);
  const noProposal = await runCLI(['show', 'org-change'], { cwd: root });
  expect(noProposal.exitCode).toBe(1);
  expect(noProposal.stderr).toContain('proposal.org');
});
