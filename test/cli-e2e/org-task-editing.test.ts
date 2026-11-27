import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCLI } from '../helpers/run-cli.js';

it('completes the cross-platform Org task editing journey from nested cwd and --store without affecting Markdown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-task-edit-e2e-'));
  const nested = path.join(root, 'packages', 'feature');
  const outsideCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-task-edit-outside-'));
  const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-task-edit-store-'));
  const xdgConfig = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-task-edit-xdg-cfg-'));
  const xdgData = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-task-edit-xdg-data-'));

  const sharedEnv = {
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
  };

  const runJson = async (args: string[], cwd = nested, env?: NodeJS.ProcessEnv) => {
    const res = await runCLI([...args, '--json'], { cwd, env: { ...sharedEnv, ...env } });
    expect(res.exitCode, `${args.join(' ')}\n${res.stdout}\n${res.stderr}`).toBe(0);
    return JSON.parse(res.stdout);
  };

  const confirmMutation = async (args: string[], cwd = nested) => {
    const preview = await runJson([...args, '--preview'], cwd);
    expect(preview.preview).toBe(true);
    expect(preview.applied).toBe(false);
    const applied = await runJson(
      [...args, '--confirm', '--preview-hash', preview.previewHash],
      cwd
    );
    expect(applied.applied).toBe(true);
    return applied;
  };

  try {
    expect((await runCLI(['init', '--tools', 'none'], { cwd: root, env: sharedEnv })).exitCode).toBe(0);
    await fs.mkdir(nested, { recursive: true });

    const mdChange = (await runJson(['new', 'change', 'md-change'], root)).change;
    const mdTasksPath = path.join(mdChange.path, 'tasks.md');
    await fs.writeFile(mdTasksPath, '- [ ] Markdown item\n', 'utf-8');

    const orgChange = (
      await runJson(['new', 'change', 'org-change', '--schema', 'spec-driven-org'], root)
    ).change;
    const templates = await runJson(['templates', '--schema', 'spec-driven-org'], root);
    const templateContent = await fs.readFile(templates.tasks.path, 'utf-8');
    expect(templateContent).toContain('** 描述');
    expect(templateContent).toContain('** 验收标准');

    // Write CRLF + UTF-8 BOM fixture scaffolded from template conventions.
    const orgTasksPath = path.join(orgChange.path, 'tasks.org');
    const crlfBomInitial =
      '\uFEFF' +
      [
        '#+TITLE: Tasks',
        '#+STARTUP: num',
        '',
        '* Build',
        '** DONE Bootstrap environment',
        ':PROPERTIES:',
        ':TASK_ID: 1.0',
        ':END:',
        '*** 描述',
        'Setup workspace with ~pnpm~.',
        '*** 验收标准',
        'Environment ready.',
        '*** 验收结果',
        '**** DONE Checked on runner',
        '  passed',
        '',
        '** TODO Build module',
        ':PROPERTIES:',
        ':TASK_ID: 1.1',
        ':DEPENDS_ON: 1.0',
        ':END:',
        '*** 描述',
        'Build *core* module.',
        '*** 验收标准',
        'Core builds.',
        '*** 验收结果',
        '**** TODO Pending review',
        '  draft log',
        '',
        '** TODO Extra cleanup',
        ':PROPERTIES:',
        ':TASK_ID: 1.2',
        ':END:',
        '*** 描述',
        'Temporary item.',
        '*** 验收标准',
        'Clean.',
        '',
        '* Verify',
        '** Integration',
        '*** TODO Verify integration',
        ':PROPERTIES:',
        ':TASK_ID: 2.1',
        ':DEPENDS_ON: 1.1',
        ':END:',
        '*** 描述',
        'Run E2E.',
        '*** 验收标准',
        'All green.',
        '',
      ].join('\r\n');
    await fs.writeFile(orgTasksPath, crlfBomInitial, 'utf-8');

    // 1. Create a task inside Build (from nested cwd).
    await confirmMutation([
      'task',
      'create',
      '--change',
      'org-change',
      '--id',
      '1.3',
      '--title',
      'Lint module',
      '--description',
      'Run linter.',
      '--criteria',
      'Zero warnings.',
      '--depends-on',
      '1.0',
      '--group',
      'Build',
      '--position',
      'end',
    ]);

    // 2. Edit text without losing DONE state or evidence.
    await runJson([
      'task',
      'edit',
      '1.0',
      '--change',
      'org-change',
      '--title',
      'Bootstrap build environment',
    ]);
    const shown10 = (
      await runJson(['task', 'show', '1.0', '--change', 'org-change', '--sections', 'all'])
    ).task;
    expect(shown10.state).toBe('DONE');
    expect(shown10.sourcePath).toBe(fsSync.realpathSync.native(orgTasksPath));
    expect(shown10.evidence).toContain('Checked on runner');

    // 3. Protected remove rejects DONE, evidence-bearing, and referenced tasks without mutating disk.
    const beforeProtectedRemove = await fs.readFile(orgTasksPath, 'utf-8');
    for (const protectedId of ['1.0', '1.1']) {
      const res = await runCLI(['task', 'remove', protectedId, '--change', 'org-change', '--preview', '--json'], {
        cwd: nested,
        env: sharedEnv,
      });
      expect(res.exitCode).toBe(1);
    }
    expect(await fs.readFile(orgTasksPath, 'utf-8')).toBe(beforeProtectedRemove);

    // Remove isolated TODO task 1.2 after preview + confirm.
    await confirmMutation(['task', 'remove', '1.2', '--change', 'org-change']);

    // 4. Non-continuous reorder in Build: [1.0, 1.1, 1.3] -> select (1.3, 1.1) -> [1.0, 1.3, 1.1]
    // First verify dependency conflict leaves file unchanged (moving 1.1 before 1.0 fails).
    const beforeConflict = await fs.readFile(orgTasksPath, 'utf-8');
    const conflictRes = await runCLI(
      ['task', 'reorder', '1.1', '1.0', '--change', 'org-change', '--preview', '--json'],
      { cwd: nested, env: sharedEnv }
    );
    expect(conflictRes.exitCode).toBe(1);
    expect(JSON.parse(conflictRes.stdout).status[0].code).toBe('dependency_conflict');
    expect(await fs.readFile(orgTasksPath, 'utf-8')).toBe(beforeConflict);

    await confirmMutation(['task', 'reorder', '1.3', '1.1', '--change', 'org-change']);

    // 5. Cross-group move of 1.3 into Verify/Integration (before 2.1).
    await confirmMutation([
      'task',
      'move',
      '1.3',
      '--change',
      'org-change',
      '--group',
      'Verify/Integration',
      '--before',
      '2.1',
    ]);

    // 6. Split 1.1 into 1.1a and 1.1b (1.1a inherits DEPENDS_ON: 1.0 and evidence; 2.1 updates to 1.1a, 1.1b).
    await confirmMutation([
      'task',
      'split',
      '1.1',
      '--change',
      'org-change',
      '--into',
      '1.1a=Build parser',
      '--into',
      JSON.stringify({ id: '1.1b', title: 'Build serializer', dependsOn: ['1.1a'] }),
    ]);

    const finalList = (await runJson(['task', 'list', '--change', 'org-change'])).tasks;
    expect(finalList.map((t: { id: string }) => t.id)).toEqual([
      '1.0',
      '1.1a',
      '1.1b',
      '1.3',
      '2.1',
    ]);

    const shown21 = (await runJson(['task', 'show', '2.1', '--change', 'org-change'])).task;
    expect(shown21.dependencies).toEqual(['1.1a', '1.1b']);

    // 7. Verify next task selection reflects mutated document order.
    expect((await runJson(['task', 'next', '--change', 'org-change'])).next).toEqual({
      state: 'ready',
      taskId: '1.1a',
    });

    // Verify BOM & CRLF preserved and zero tasks.md projection created.
    const finalBytes = await fs.readFile(orgTasksPath, 'utf-8');
    expect(finalBytes.startsWith('\uFEFF#+TITLE: Tasks\r\n')).toBe(true);
    expect(finalBytes).toContain('\r\n');
    expect(finalBytes).not.toMatch(/[^\r]\n/);
    await expect(fs.stat(path.join(orgChange.path, 'tasks.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(mdTasksPath, 'utf-8')).toBe('- [ ] Markdown item\n');

    // 8. Verify --store cross-directory writes from an unrelated cwd.
    expect(
      (
        await runCLI(
          ['store', 'setup', 'orgstore', '--path', storeRoot, '--no-init-git', '--json'],
          { cwd: outsideCwd, env: sharedEnv }
        )
      ).exitCode
    ).toBe(0);
    const storeChange = (
      await runJson(
        ['new', 'change', 'remote-org', '--schema', 'spec-driven-org', '--store', 'orgstore'],
        outsideCwd
      )
    ).change;
    const storeTasksPath = path.join(storeChange.path, 'tasks.org');
    await fs.writeFile(storeTasksPath, templateContent, 'utf-8');
    await confirmMutation(
      [
        'task',
        'create',
        '--change',
        'remote-org',
        '--id',
        '1.2',
        '--title',
        'Store task',
        '--depends-on',
        '1.1',
        '--store',
        'orgstore',
      ],
      outsideCwd
    );
    const storeList = (
      await runJson(['task', 'list', '--change', 'remote-org', '--store', 'orgstore'], outsideCwd)
    ).tasks;
    expect(storeList.map((t: { id: string }) => t.id)).toEqual(['1.1', '1.2']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideCwd, { recursive: true, force: true });
    await fs.rm(storeRoot, { recursive: true, force: true });
    await fs.rm(xdgConfig, { recursive: true, force: true });
    await fs.rm(xdgData, { recursive: true, force: true });
  }
}, 90_000);
