import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCLI } from '../helpers/run-cli.js';

describe('openspec task editing CLI commands', () => {
  let cwd: string;
  let changeDir: string;
  let sourcePath: string;
  const initialSource = [
    '#+TITLE: Tasks',
    '#+STARTUP: num',
    '',
    '* Build',
    '** DONE Base setup',
    ':PROPERTIES:',
    ':TASK_ID: 1.1',
    ':END:',
    '*** 描述',
    'Base description',
    '*** 验收标准',
    'Base ready',
    '*** 验收结果',
    '**** DONE Recorded verification',
    '  kept verbatim',
    '',
    '** TODO Core work',
    ':PROPERTIES:',
    ':TASK_ID: 1.2',
    ':DEPENDS_ON: 1.1',
    ':END:',
    '*** 描述',
    'Core work',
    '*** 验收标准',
    'Core passes',
    '',
    '** TODO Downstream',
    ':PROPERTIES:',
    ':TASK_ID: 1.3',
    ':DEPENDS_ON: 1.2',
    ':END:',
    '*** 描述',
    'Depends on 1.2',
    '*** 验收标准',
    'Downstream passes',
    '',
  ].join('\n');

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-org-task-edit-cmd-'));
    changeDir = path.join(cwd, 'openspec', 'changes', 'demo');
    await fs.mkdir(changeDir, { recursive: true });
    await fs.writeFile(path.join(changeDir, '.openspec.yaml'), 'schema: spec-driven-org\n');
    sourcePath = path.join(changeDir, 'tasks.org');
    await fs.writeFile(sourcePath, initialSource, 'utf-8');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('requires both --confirm and matching --preview-hash for non-interactive structural writes and never writes on preview', async () => {
    const createArgs = [
      'task',
      'create',
      '--change',
      'demo',
      '--id',
      '1.4',
      '--title',
      'New check',
      '--group',
      'Build',
      '--depends-on',
      '1.3',
      '--json',
    ];

    // Preview does not mutate disk.
    const previewRes = await runCLI([...createArgs, '--preview'], { cwd });
    expect(previewRes.exitCode, previewRes.stderr + previewRes.stdout).toBe(0);
    const previewJson = JSON.parse(previewRes.stdout);
    expect(previewJson.preview).toBe(true);
    expect(previewJson.applied).toBe(false);
    expect(typeof previewJson.previewHash).toBe('string');
    expect(await fs.readFile(sourcePath, 'utf-8')).toBe(initialSource);

    // Missing both flags -> rejected, disk unchanged.
    const noConfirmRes = await runCLI(createArgs, { cwd });
    expect(noConfirmRes.exitCode).toBe(1);
    expect(JSON.parse(noConfirmRes.stdout).status[0].code).toBe('confirmation_required');
    expect(await fs.readFile(sourcePath, 'utf-8')).toBe(initialSource);

    // Only --preview-hash without --confirm -> rejected, disk unchanged.
    const hashOnlyRes = await runCLI([...createArgs, '--preview-hash', previewJson.previewHash], { cwd });
    expect(hashOnlyRes.exitCode).toBe(1);
    expect(JSON.parse(hashOnlyRes.stdout).status[0].code).toBe('confirmation_required');
    expect(await fs.readFile(sourcePath, 'utf-8')).toBe(initialSource);

    // Only --confirm without --preview-hash -> rejected, disk unchanged.
    const confirmOnlyRes = await runCLI([...createArgs, '--confirm'], { cwd });
    expect(confirmOnlyRes.exitCode).toBe(1);
    expect(JSON.parse(confirmOnlyRes.stdout).status[0].code).toBe('confirmation_required');
    expect(await fs.readFile(sourcePath, 'utf-8')).toBe(initialSource);

    // Stale/wrong --preview-hash -> rejected, disk unchanged.
    const staleRes = await runCLI(
      [...createArgs, '--confirm', '--preview-hash', 'deadbeef'],
      { cwd }
    );
    expect(staleRes.exitCode).toBe(1);
    expect(JSON.parse(staleRes.stdout).status[0].code).toBe('preview_hash_mismatch');
    expect(await fs.readFile(sourcePath, 'utf-8')).toBe(initialSource);

    // Matching --confirm and --preview-hash -> writes atomically.
    const applyRes = await runCLI(
      [...createArgs, '--confirm', '--preview-hash', previewJson.previewHash],
      { cwd }
    );
    expect(applyRes.exitCode, applyRes.stderr + applyRes.stdout).toBe(0);
    const applyJson = JSON.parse(applyRes.stdout);
    expect(applyJson.applied).toBe(true);
    const listRes = await runCLI(['task', 'list', '--change', 'demo', '--json'], { cwd });
    expect(JSON.parse(listRes.stdout).tasks.map((t: { id: string }) => t.id)).toEqual([
      '1.1',
      '1.2',
      '1.3',
      '1.4',
    ]);
  });

  it('supports edit without structural confirm and preserves DONE status and raw evidence', async () => {
    const editRes = await runCLI(
      [
        'task',
        'edit',
        '1.1',
        '--change',
        'demo',
        '--title',
        'Updated base setup',
        '--custom',
        'Notes=Added context',
        '--json',
      ],
      { cwd }
    );
    expect(editRes.exitCode, editRes.stderr + editRes.stdout).toBe(0);
    const showRes = await runCLI(
      ['task', 'show', '1.1', '--change', 'demo', '--sections', 'all', '--json'],
      { cwd }
    );
    const task = JSON.parse(showRes.stdout).task;
    expect(task.state).toBe('DONE');
    expect(task.title).toBe('Updated base setup');
    expect(task.evidence).toContain('**** DONE Recorded verification\n  kept verbatim');
    expect(task.custom).toEqual([{ title: 'Notes', content: 'Added context\n\n' }]);
  });

  it('rejects non-spec-driven-org changes and failed mutations without mutating files', async () => {
    const mdDir = path.join(cwd, 'openspec', 'changes', 'md-change');
    await fs.mkdir(mdDir, { recursive: true });
    await fs.writeFile(path.join(mdDir, '.openspec.yaml'), 'schema: spec-driven\n');
    await fs.writeFile(path.join(mdDir, 'tasks.md'), '- [ ] Markdown task\n');

    const mdRes = await runCLI(
      ['task', 'edit', '1.1', '--change', 'md-change', '--title', 'Nope'],
      { cwd }
    );
    expect(mdRes.exitCode).toBe(1);
    expect(mdRes.stderr + mdRes.stdout).toContain('does not use the Org workflow');
    expect(await fs.readFile(path.join(mdDir, 'tasks.md'), 'utf-8')).toBe('- [ ] Markdown task\n');
    await expect(fs.stat(path.join(mdDir, 'tasks.org'))).rejects.toMatchObject({ code: 'ENOENT' });

    // Failed dependency inversion leaves tasks.org untouched.
    const previewRes = await runCLI(
      ['task', 'reorder', '1.3', '1.2', '--change', 'demo', '--preview', '--json'],
      { cwd }
    );
    expect(previewRes.exitCode).toBe(1);
    expect(JSON.parse(previewRes.stdout).status[0].code).toBe('dependency_conflict');
    expect(await fs.readFile(sourcePath, 'utf-8')).toBe(initialSource);
  });

  it('prompts in interactive TTY mode, cancels cleanly on decline, and exits 130 on Ctrl-C', async () => {
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      // 1. Ctrl-C cancellation -> exitCode 130, zero mutation.
      {
        vi.resetModules();
        process.exitCode = undefined;
        const sigintError = new Error('User force closed the prompt with SIGINT');
        sigintError.name = 'ExitPromptError';
        vi.doMock('../../src/utils/interactive.js', async () => {
          const actual = await vi.importActual<typeof import('../../src/utils/interactive.js')>(
            '../../src/utils/interactive.js'
          );
          return {
            ...actual,
            isInteractive: () => true,
            confirmPrompt: vi.fn().mockRejectedValue(sigintError),
          };
        });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { taskCreateCommand } = await import('../../src/commands/task.js');

        await taskCreateCommand({
          change: 'demo',
          id: '1.9',
          title: 'Cancelled task',
        });

        expect(process.exitCode).toBe(130);
        expect(errorSpy).toHaveBeenCalledWith('Cancelled.');
        expect(await fs.readFile(sourcePath, 'utf-8')).toBe(initialSource);
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }

      // 2. User declines prompt -> zero mutation.
      {
        vi.resetModules();
        process.exitCode = undefined;
        vi.doMock('../../src/utils/interactive.js', async () => {
          const actual = await vi.importActual<typeof import('../../src/utils/interactive.js')>(
            '../../src/utils/interactive.js'
          );
          return {
            ...actual,
            isInteractive: () => true,
            confirmPrompt: vi.fn().mockResolvedValue(false),
          };
        });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { taskCreateCommand } = await import('../../src/commands/task.js');

        await taskCreateCommand({
          change: 'demo',
          id: '1.9',
          title: 'Declined task',
        });

        expect(logSpy).toHaveBeenCalledWith('Cancelled.');
        expect(await fs.readFile(sourcePath, 'utf-8')).toBe(initialSource);
        logSpy.mockRestore();
      }

      // 3. User confirms prompt -> writes to disk.
      {
        vi.resetModules();
        process.exitCode = undefined;
        vi.doMock('../../src/utils/interactive.js', async () => {
          const actual = await vi.importActual<typeof import('../../src/utils/interactive.js')>(
            '../../src/utils/interactive.js'
          );
          return {
            ...actual,
            isInteractive: () => true,
            confirmPrompt: vi.fn().mockResolvedValue(true),
          };
        });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { taskCreateCommand } = await import('../../src/commands/task.js');

        await taskCreateCommand({
          change: 'demo',
          id: '1.9',
          title: 'Confirmed task',
          group: 'Build',
        });

        const updated = await fs.readFile(sourcePath, 'utf-8');
        expect(updated).toContain(':TASK_ID: 1.9');
        expect(updated).toContain('** TODO Confirmed task');
        logSpy.mockRestore();
      }
    } finally {
      process.exitCode = undefined;
      process.chdir(previousCwd);
    }
  });
});
