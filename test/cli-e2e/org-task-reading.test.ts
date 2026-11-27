import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCLI } from '../helpers/run-cli.js';

it('reads Org tasks from a nested working directory without changing the Markdown workflow', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-task-journey-'));
  const nested = path.join(root, 'src', 'feature');
  const run = async (args: string[], cwd = nested) => {
    const result = await runCLI([...args, '--json'], { cwd });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    const init = await runCLI(['init', '--tools', 'none'], { cwd: root });
    expect(init.exitCode, init.stdout + init.stderr).toBe(0);
    await fs.mkdir(nested, { recursive: true });
    const markdown = (await run(['new', 'change', 'markdown-change'], root)).change;
    const org = (await run(['new', 'change', 'org-change', '--schema', 'spec-driven-org'], root)).change;
    const markdownTasks = path.join(markdown.path, 'tasks.md');
    await fs.writeFile(markdownTasks, '- [ ] Markdown task\n');
    const orgTasks = path.join(org.path, 'tasks.org');
    const content = ['#+STARTUP: num', '* Deployment', '** DONE Setup', ':PROPERTIES:', ':TASK_ID: 1.1', ':END:',
      '** TODO Validate', ':PROPERTIES:', ':TASK_ID: 3.2', ':DEPENDS_ON: 1.1', ':END:', 'Check ~state~.',
      '*** 验收标准', 'The state is retained.', ''].join('\r\n');
    await fs.writeFile(orgTasks, content);

    const target = ['--change', 'org-change'];
    const summary = await run(['task', 'list', ...target]);
    expect(summary.tasks.map(({ id, state }: { id: string; state: string }) => [id, state])).toEqual([['1.1', 'DONE'], ['3.2', 'TODO']]);
    const sourcePath = await fs.realpath(orgTasks);
    expect((await run(['task', 'show', '3.2', ...target])).task).toMatchObject({ id: '3.2', sourcePath, line: 7,
      description: 'Check ~state~.', criteria: 'The state is retained.' });
    const next = (await run(['task', 'next', ...target])).next;
    expect(next).toEqual({ state: 'ready', taskId: '3.2' });
    expect(await run(['instructions', 'apply', ...target])).toMatchObject({ state: 'ready', next,
      orgTaskPath: sourcePath, progress: { total: 2, complete: 1, remaining: 1 } });

    const changes = (await run(['list', '--sort', 'name'])).changes;
    expect(changes).toMatchObject([
      { name: 'markdown-change', completedTasks: 0, totalTasks: 1 },
      { name: 'org-change', completedTasks: 1, totalTasks: 2 },
    ]);
    const apply = await run(['instructions', 'apply', '--change', 'markdown-change']);
    expect(apply).toMatchObject({ state: 'ready', tasks: [{ description: 'Markdown task', done: false }] });
    expect(apply).not.toHaveProperty('next');
    expect(await fs.readFile(markdownTasks, 'utf8')).toBe('- [ ] Markdown task\n');
    expect(await fs.readFile(orgTasks, 'utf8')).toBe(content);
    await expect(fs.stat(path.join(org.path, 'tasks.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);
