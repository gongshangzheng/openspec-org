import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCLI } from '../helpers/run-cli.js';

let cwd: string;
let changeDir: string;
let sourcePath: string;
const options = ['--change', 'demo'];
const evidence = '**** [PASS] Archived review\r\n  source =literal=\r\n';
const source = [
  '* Group', '** TODO Pending title', ':PROPERTIES:', ':TASK_ID: 3.2', ':DEPENDS_ON: 1.1, 7.2', ':END:',
  'Unselected description ~value~', '*** 验收标准', 'Selected criterion', '*** 验收结果',
].join('\r\n') + '\r\n' + evidence + [
  '*** Rollback notes', 'Unselected notes', '** TODO Precondition', ':PROPERTIES:', ':TASK_ID: 1.1', ':END:', '',
].join('\r\n');

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-org-task-command-'));
  changeDir = path.join(cwd, 'openspec', 'changes', 'demo');
  await fs.mkdir(changeDir, { recursive: true });
  await fs.writeFile(path.join(changeDir, '.openspec.yaml'), 'schema: spec-driven-org\n');
  sourcePath = path.join(changeDir, 'tasks.org');
  await fs.writeFile(sourcePath, source);
});
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

async function run(args: string[]) {
  const result = await runCLI(args, { cwd });
  expect(result.exitCode, result.stderr + result.stdout).toBe(0);
  return result.stdout;
}

it('shares section selection between text and JSON without writing any task artifacts', async () => {
  const show = ['task', 'show', '3.2', ...options];
  const metadata = { id: '3.2', title: 'Pending title', state: 'TODO', dependencies: ['1.1', '7.2'],
    sourcePath: await fs.realpath(sourcePath), line: 2 };
  expect(JSON.parse(await run([...show, '--json'])).task).toEqual({ ...metadata,
    description: 'Unselected description ~value~', criteria: 'Selected criterion' });
  const selected = ['--sections', 'criteria,evidence'];
  expect(JSON.parse(await run([...show, ...selected, '--json'])).task).toEqual({ ...metadata,
    criteria: 'Selected criterion', evidence });
  const rendered = await run([...show, ...selected]);
  expect(rendered).toContain('3.2 TODO Pending title');
  expect(rendered).toContain(`${metadata.sourcePath}:2`);
  expect(rendered).toContain('Dependencies: 1.1, 7.2');
  expect(rendered).toContain('Selected criterion');
  expect(rendered).toContain(evidence);
  expect(rendered).not.toMatch(/Unselected/);
  expect(await run(show)).not.toContain('Archived review');
  expect(JSON.parse(await run([...show, '--sections', 'all', '--json'])).task).toEqual({ ...metadata,
    description: 'Unselected description ~value~', criteria: 'Selected criterion', evidence,
    custom: [{ title: 'Rollback notes', content: 'Unselected notes\r\n' }],
  });
  expect(JSON.parse(await run(['task', 'list', ...options, '--json'])).tasks).toEqual([
    { id: '3.2', state: 'TODO', title: 'Pending title' }, { id: '1.1', state: 'TODO', title: 'Precondition' },
  ]);
  expect(await fs.readFile(sourcePath, 'utf8')).toBe(source);
  await expect(fs.stat(path.join(changeDir, 'tasks.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reports a blocked first task and rejects unknown section names', async () => {
  expect(JSON.parse(await run(['task', 'next', ...options, '--json'])).next).toEqual({
    state: 'blocked', taskId: '3.2', incomplete: ['1.1'], unknown: ['7.2'],
  });
  expect(await run(['task', 'next', ...options])).toContain('incomplete dependencies: 1.1; unknown dependencies: 7.2');
  for (const value of ['bogus', 'all,criteria']) {
    const invalid = await runCLI(['task', 'show', '3.2', ...options, '--sections', value, '--json'], { cwd });
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout).status[0].message).toContain('Invalid --sections selection');
  }
});

it('reports a missing Org file and rejects a Markdown change without rewriting either', async () => {
  await fs.rm(sourcePath);
  const markdown = path.join(changeDir, 'tasks.md');
  await fs.writeFile(markdown, '- [ ] Decoy\n');
  const missing = await runCLI(['task', 'list', ...options], { cwd });
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr + missing.stdout).toContain('Missing Org tasks file:');
  await fs.writeFile(path.join(changeDir, '.openspec.yaml'), 'schema: spec-driven\n');
  const unsupported = await runCLI(['task', 'list', ...options], { cwd });
  expect(unsupported.exitCode).toBe(1);
  expect(unsupported.stderr + unsupported.stdout).toContain('does not use the Org workflow');
  expect(await fs.readFile(markdown, 'utf8')).toBe('- [ ] Decoy\n');
});
