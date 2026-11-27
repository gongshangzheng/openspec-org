import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as nodeFs } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireFileLock, releaseFileLock } from '../../src/core/file-state.js';
import { readOrgTasks } from '../../src/core/parsers/org-tasks.js';
import {
  OrgTaskEditError,
  applyOrgTaskMutation,
  computePreviewHash,
  computeSnapshotHash,
  planOrgTaskMutation,
} from '../../src/core/org-task-editor.js';

describe('org-task-editor', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-org-editor-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('computes deterministic snapshot and preview hashes and rejects drift or missing confirmation', async () => {
    const sourcePath = path.join(tempDir, 'tasks.org');
    const initial = [
      '#+TITLE: Tasks',
      '',
      '* TODO Existing',
      ':PROPERTIES:',
      ':TASK_ID: 1.1',
      ':END:',
      '** 描述',
      'Initial work',
      '** 验收标准',
      'Works',
      '',
    ].join('\n');
    await nodeFs.writeFile(sourcePath, initial, 'utf-8');

    const mutation = {
      type: 'create' as const,
      id: '1.2',
      title: 'Follow up',
      description: 'Second task',
      criteria: 'Verified',
      dependsOn: ['1.1'],
    };
    const planA = planOrgTaskMutation(initial, sourcePath, mutation);
    const planB = planOrgTaskMutation(initial, sourcePath, mutation);
    expect(planA.snapshotHash).toBe(computeSnapshotHash(initial));
    expect(planA.previewHash).toBe(planB.previewHash);
    expect(planA.previewHash).toBe(
      computePreviewHash(planA.snapshotHash, { ...mutation, title: '  Follow up  ' })
    );

    // Missing confirmation or previewHash alone never writes.
    await expect(
      applyOrgTaskMutation(sourcePath, mutation, { previewHash: planA.previewHash })
    ).rejects.toMatchObject({ name: 'OrgTaskEditError', diagnostic: { code: 'confirmation_required' } });
    expect(await nodeFs.readFile(sourcePath, 'utf-8')).toBe(initial);

    // Concurrent external modification invalidates previewHash before write.
    await nodeFs.writeFile(sourcePath, initial + '# external edit\n', 'utf-8');
    await expect(
      applyOrgTaskMutation(sourcePath, mutation, {
        confirm: true,
        previewHash: planA.previewHash,
      })
    ).rejects.toMatchObject({ name: 'OrgTaskEditError', diagnostic: { code: 'preview_hash_mismatch' } });
    expect(await nodeFs.readFile(sourcePath, 'utf-8')).toBe(initial + '# external edit\n');
  });

  it('creates tasks with canonical Chinese sections, target groups, anchors, and unique ID checks', () => {
    const source = [
      '#+STARTUP: num',
      '',
      '* Build',
      '** TODO First',
      ':PROPERTIES:',
      ':TASK_ID: 1.1',
      ':END:',
      '*** 描述',
      'First body',
      '*** 验收标准',
      'First done',
      '',
      '* Verify',
      '',
    ].join('\n');

    const created = planOrgTaskMutation(source, 'tasks.org', {
      type: 'create',
      id: '1.2',
      title: 'Middle check',
      description: 'Check build output',
      criteria: 'All checks pass',
      dependsOn: ['1.1'],
      group: 'Verify',
      position: 'start',
    });

    const parsed = readOrgTasks(created.nextContent, 'tasks.org');
    expect(parsed.map((t) => [t.id, t.state, t.dependencies])).toEqual([
      ['1.1', 'TODO', []],
      ['1.2', 'TODO', ['1.1']],
    ]);
    expect(created.nextContent).toContain('** TODO Middle check\n:PROPERTIES:\n:TASK_ID: 1.2\n:DEPENDS_ON: 1.1\n:END:\n*** 描述\nCheck build output\n*** 验收标准\nAll checks pass');

    expect(() =>
      planOrgTaskMutation(created.nextContent, 'tasks.org', {
        type: 'create',
        id: '1.2',
        title: 'Duplicate ID',
      })
    ).toThrow(/already exists/);
  });

  it('edits title, description, criteria, dependencies, and custom sections while preserving DONE state and raw evidence', () => {
    const evidence = [
      '*** Evidence',
      '**** DONE Verified earlier',
      '  raw ~evidence~ preserved',
      '',
    ].join('\n');
    const source = [
      '* Group',
      '** DONE Original title',
      ':PROPERTIES:',
      ':TASK_ID: 1.1',
      ':CUSTOM_PROP: keep-me',
      ':END:',
      '*** 描述',
      'Old *desc*',
      '*** 验收标准',
      'Old criteria',
      evidence.trimEnd(),
      '*** Notes',
      'Old note',
      '',
    ].join('\n');

    const edited = planOrgTaskMutation(source, 'tasks.org', {
      type: 'edit',
      taskId: '1.1',
      title: 'Updated title',
      description: 'New *desc*',
      criteria: 'New criteria',
      custom: [
        { title: 'Notes', content: 'Updated note' },
        { title: 'Links', content: 'https://example.com' },
      ],
    });

    const tasks = readOrgTasks(edited.nextContent, 'tasks.org');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: '1.1',
      state: 'DONE',
      title: 'Updated title',
      description: 'New *desc*',
      criteria: 'New criteria',
      custom: [
        { title: 'Notes', content: 'Updated note\n' },
        { title: 'Links', content: 'https://example.com\n' },
      ],
    });
    expect(tasks[0].evidence).toContain('**** DONE Verified earlier\n  raw ~evidence~ preserved');
    expect(edited.nextContent).toContain(':CUSTOM_PROP: keep-me');
  });

  it('blocks removal of DONE tasks, tasks with evidence, and tasks referenced by DEPENDS_ON', () => {
    const source = [
      '* DONE Completed',
      ':PROPERTIES:',
      ':TASK_ID: 1.0',
      ':END:',
      '* TODO With evidence',
      ':PROPERTIES:',
      ':TASK_ID: 1.1',
      ':END:',
      '** 验收结果',
      'Recorded proof',
      '* TODO Referenced base',
      ':PROPERTIES:',
      ':TASK_ID: 1.2',
      ':END:',
      '* TODO Dependent',
      ':PROPERTIES:',
      ':TASK_ID: 1.3',
      ':DEPENDS_ON: 1.2',
      ':END:',
      '* TODO Isolated removable',
      ':PROPERTIES:',
      ':TASK_ID: 1.4',
      ':END:',
      '',
    ].join('\n');

    expect(() =>
      planOrgTaskMutation(source, 'tasks.org', { type: 'remove', taskId: '1.0' })
    ).toThrow(/DONE/);

    expect(() =>
      planOrgTaskMutation(source, 'tasks.org', { type: 'remove', taskId: '1.1' })
    ).toThrow(/验收结果\/Evidence/);

    expect(() =>
      planOrgTaskMutation(source, 'tasks.org', { type: 'remove', taskId: '1.2' })
    ).toThrow(/1\.3/);

    const removed = planOrgTaskMutation(source, 'tasks.org', { type: 'remove', taskId: '1.4' });
    expect(readOrgTasks(removed.nextContent, 'tasks.org').map((t) => t.id)).toEqual([
      '1.0',
      '1.1',
      '1.2',
      '1.3',
    ]);
  });

  it('reorders non-continuous tasks within the same group while keeping unselected tasks in place', () => {
    const source = [
      '* Implementation',
      '** TODO A',
      ':PROPERTIES:',
      ':TASK_ID: A',
      ':END:',
      '** TODO B',
      ':PROPERTIES:',
      ':TASK_ID: B',
      ':END:',
      '** TODO C',
      ':PROPERTIES:',
      ':TASK_ID: C',
      ':END:',
      '** TODO D',
      ':PROPERTIES:',
      ':TASK_ID: D',
      ':END:',
      '** TODO E',
      ':PROPERTIES:',
      ':TASK_ID: E',
      ':END:',
      '',
    ].join('\n');

    const reordered = planOrgTaskMutation(source, 'tasks.org', {
      type: 'reorder',
      taskIds: ['D', 'A'],
    });
    expect(readOrgTasks(reordered.nextContent, 'tasks.org').map((t) => t.id)).toEqual([
      'D',
      'B',
      'C',
      'A',
      'E',
    ]);
  });

  it('moves task subtrees across groups with path resolution, ambiguity checks, and star-level shifts', () => {
    const source = [
      '\uFEFF#+TITLE: Tasks',
      '#+STARTUP: num',
      '',
      '* ParentA',
      '** Shared',
      '*** TODO Task A',
      ':PROPERTIES:',
      ':TASK_ID: A',
      ':END:',
      '**** 描述',
      'Keep *inline* ~markup~.',
      '**** 验收结果',
      '***** TODO Quoted evidence',
      '#+BEGIN_SRC org',
      '* Not a heading inside src',
      '#+END_SRC',
      '* ParentB',
      '** Shared',
      '** UniqueTarget',
      '*** TODO Task B',
      ':PROPERTIES:',
      ':TASK_ID: B',
      ':END:',
      '',
    ].join('\r\n');

    // Ambiguous short group name fails loudly.
    expect(() =>
      planOrgTaskMutation(source, 'tasks.org', {
        type: 'move',
        taskId: 'A',
        group: 'Shared',
      })
    ).toThrow(/ParentA\/Shared, ParentB\/Shared/);

    // Move A from level 3 (ParentA/Shared) to top-level ('/') at start -> level 1!
    const movedToRoot = planOrgTaskMutation(source, 'tasks.org', {
      type: 'move',
      taskId: 'A',
      group: '/',
      position: 'start',
    });
    expect(movedToRoot.nextContent.startsWith('\uFEFF#+TITLE: Tasks\r\n')).toBe(true);
    expect(movedToRoot.nextContent).toContain('\r\n* TODO Task A\r\n');
    expect(movedToRoot.nextContent).toContain('\r\n** 描述\r\nKeep *inline* ~markup~.\r\n');
    expect(movedToRoot.nextContent).toContain('\r\n** 验收结果\r\n*** TODO Quoted evidence\r\n');
    expect(movedToRoot.nextContent).toContain('\r\n* Not a heading inside src\r\n');

    // Move A into ParentB/Shared using full path -> level 3!
    const movedToPath = planOrgTaskMutation(source, 'tasks.org', {
      type: 'move',
      taskId: 'A',
      group: 'ParentB/Shared',
      position: 'end',
    });
    expect(readOrgTasks(movedToPath.nextContent, 'tasks.org').map((t) => t.id)).toEqual(['A', 'B']);
    expect(movedToPath.nextContent).toContain('*** TODO Task A\r\n');
    expect(movedToPath.nextContent).toContain('***** TODO Quoted evidence\r\n');
  });

  it('rejects dependency inversions on create, edit, reorder, and move without rewriting dependencies', () => {
    const source = [
      '* TODO Base',
      ':PROPERTIES:',
      ':TASK_ID: 1.1',
      ':END:',
      '* TODO Consumer',
      ':PROPERTIES:',
      ':TASK_ID: 1.2',
      ':DEPENDS_ON: 1.1',
      ':END:',
      '',
    ].join('\n');

    expect(() =>
      planOrgTaskMutation(source, 'tasks.org', {
        type: 'reorder',
        taskIds: ['1.2', '1.1'],
      })
    ).toThrow(/Dependency conflict.*1\.2.*1\.1/);

    expect(() =>
      planOrgTaskMutation(source, 'tasks.org', {
        type: 'move',
        taskId: '1.2',
        before: '1.1',
      })
    ).toThrow(/Dependency conflict/);

    expect(() =>
      planOrgTaskMutation(source, 'tasks.org', {
        type: 'edit',
        taskId: '1.1',
        dependsOn: ['1.2'],
      })
    ).toThrow(/Dependency conflict/);

    expect(() =>
      planOrgTaskMutation(source, 'tasks.org', {
        type: 'create',
        id: '1.0',
        title: 'Too early',
        dependsOn: ['1.2'],
        before: '1.1',
      })
    ).toThrow(/Dependency conflict/);
  });

  it('splits TODO tasks, inherits dependencies & evidence on first task, updates downstream DEPENDS_ON, and rejects DONE', () => {
    const source = [
      '* TODO Setup',
      ':PROPERTIES:',
      ':TASK_ID: 1.0',
      ':END:',
      '* TODO Build core',
      ':PROPERTIES:',
      ':TASK_ID: 1.2',
      ':DEPENDS_ON: 1.0',
      ':END:',
      '** 描述',
      'Original combined scope',
      '** 验收标准',
      'Original criteria',
      '** 验收结果',
      '*** TODO Partial check',
      '  kept evidence',
      '* TODO Integrate',
      ':PROPERTIES:',
      ':TASK_ID: 2.1',
      ':DEPENDS_ON: 1.0, 1.2',
      ':END:',
      '* DONE Already done',
      ':PROPERTIES:',
      ':TASK_ID: 3.0',
      ':END:',
      '',
    ].join('\n');

    expect(() =>
      planOrgTaskMutation(source, 'tasks.org', {
        type: 'split',
        taskId: '3.0',
        parts: [
          { id: '3.0a', title: 'Part A' },
          { id: '3.0b', title: 'Part B' },
        ],
      })
    ).toThrow(/DONE/);

    const split = planOrgTaskMutation(source, 'tasks.org', {
      type: 'split',
      taskId: '1.2',
      parts: [
        { id: '1.2a', title: 'Build parser', description: 'Parser', criteria: 'Parser passes' },
        {
          id: '1.2b',
          title: 'Build writer',
          description: 'Writer',
          criteria: 'Writer passes',
          dependsOn: ['1.2a'],
        },
      ],
    });

    const tasks = readOrgTasks(split.nextContent, 'tasks.org');
    expect(tasks.map((t) => [t.id, t.dependencies])).toEqual([
      ['1.0', []],
      ['1.2a', ['1.0']],
      ['1.2b', ['1.2a']],
      ['2.1', ['1.0', '1.2a', '1.2b']],
      ['3.0', []],
    ]);
    expect(tasks[1].evidence).toContain('kept evidence');
    expect(tasks[2].evidence).toBeUndefined();
  });

  it('writes atomically under .tasks.org.lock, preserves file permissions, and reports lock holder metadata on timeout', async () => {
    const sourcePath = path.join(tempDir, 'tasks.org');
    const lockPath = path.join(tempDir, '.tasks.org.lock');
    const initial = [
      '* TODO Initial',
      ':PROPERTIES:',
      ':TASK_ID: 1.1',
      ':END:',
      '',
    ].join('\n');
    await nodeFs.writeFile(sourcePath, initial, 'utf-8');
    if (process.platform !== 'win32') {
      await nodeFs.chmod(sourcePath, 0o644);
    }

    const editResult = await applyOrgTaskMutation(sourcePath, {
      type: 'edit',
      taskId: '1.1',
      title: 'Updated via lock',
    });
    expect(editResult.applied).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(sourcePath).mode & 0o777).toBe(0o644);
    }

    const held = await acquireFileLock({
      lockPath,
      errorFor: () => new Error('unexpected'),
    });
    try {
      await expect(
        applyOrgTaskMutation(
          sourcePath,
          { type: 'edit', taskId: '1.1', title: 'Blocked' },
          { lockTimeoutMs: 60 }
        )
      ).rejects.toThrow(new RegExp(`PID ${process.pid}`));
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      await releaseFileLock(held, lockPath);
    }
  });
});
