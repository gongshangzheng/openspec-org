import { expect, it } from 'vitest';
import {
  nextOrgTask,
  parseOrgTasksDocument,
  readOrgTasks,
} from '../../../src/core/parsers/org-tasks.js';

const task = (id: string, state = 'TODO', dependencies?: string) => [
  `** ${state} Task ${id}`, ':PROPERTIES:', `:TASK_ID: ${id}`,
  ...(dependencies ? [`:DEPENDS_ON: ${dependencies}`] : []), ':END:',
].join('\n');

it('reads grouped tasks, direct and named descriptions, and preserves their source text', () => {
  const source = [
    '#+STARTUP: num', '* Group', task('3.2'), '*bold* /italic/ ~code~',
    '*** 验收标准', 'Keep =literal=.', '*** 验收结果', '**** TODO Quoted evidence heading',
    ':PROPERTIES:', ':RESULT: pass', ':END:', '  evidence ~*~',
    '*** Notes', '  custom notes', '**** Nested notes', 'Keep this.',
    task('1.1', 'DONE'), '*** 描述', 'A named section', '',
  ].join('\n').replace(/\n/g, '\r\n');
  expect(readOrgTasks(source, 'tasks.org')).toEqual([
    { id: '3.2', state: 'TODO', title: 'Task 3.2', line: 3, dependencies: [],
      description: '*bold* /italic/ ~code~', criteria: 'Keep =literal=.',
      evidence: '**** TODO Quoted evidence heading\r\n:PROPERTIES:\r\n:RESULT: pass\r\n:END:\r\n  evidence ~*~\r\n',
      custom: [{ title: 'Notes', content: '  custom notes\r\n**** Nested notes\r\nKeep this.\r\n' }] },
    { id: '1.1', state: 'DONE', title: 'Task 1.1', line: 20, dependencies: [],
      description: 'A named section', criteria: '', custom: [] },
  ]);
});

it('reports a duplicate task at its actual source line', () => {
  expect(() => readOrgTasks(`${task('1.1')}\n${task('1.1')}`, 'tasks.org'))
    .toThrow('tasks.org:5: duplicate TASK_ID 1.1 (first defined at line 1)');
});

it('uses document order, treating declared dependencies as hard constraints', () => {
  const blocked = `${task('3.2', 'TODO', '1.1, 9.9')}\n${task('1.1')}\n${task('2.1')}`;
  expect(nextOrgTask(readOrgTasks(blocked, 'tasks.org'))).toEqual({
    state: 'blocked', taskId: '3.2', incomplete: ['1.1'], unknown: ['9.9'],
  });
  const ready = `${task('2.1', 'DONE')}\n${task('3.2', 'TODO', '2.1')}\n${task('1.1')}`;
  expect(nextOrgTask(readOrgTasks(ready, 'tasks.org'))).toEqual({ state: 'ready', taskId: '3.2' });
});

it('distinguishes an empty plan from a completed plan and ignores headings in examples', () => {
  expect(nextOrgTask(readOrgTasks(`#+BEGIN_EXAMPLE\n${task('1.1')}\n#+END_EXAMPLE`, 'tasks.org'))).toEqual({ state: 'empty' });
  expect(nextOrgTask(readOrgTasks(task('1.1', 'DONE'), 'tasks.org'))).toEqual({ state: 'all_done' });
});

it('supports English special section aliases while preserving raw inline markup and evidence', () => {
  const source = [
    '* TODO English task',
    ':PROPERTIES:',
    ':TASK_ID: 2.1',
    ':END:',
    '** Description',
    'Keep *bold* and ~code~.',
    '** Acceptance Criteria',
    'Check =result=.',
    '** Evidence',
    '*** DONE Recorded check',
    '  raw evidence line',
    '',
  ].join('\n');

  expect(readOrgTasks(source, 'tasks.org')).toEqual([
    {
      id: '2.1',
      title: 'English task',
      state: 'TODO',
      dependencies: [],
      line: 1,
      description: 'Keep *bold* and ~code~.',
      criteria: 'Check =result=.',
      evidence: '*** DONE Recorded check\n  raw evidence line\n',
      custom: [],
    },
  ]);
});

it('rejects duplicate acceptance criteria or evidence sections with source path and line', () => {
  const duplicateCriteria = [
    task('1.1'),
    '*** 验收标准',
    'First criteria',
    '*** Acceptance Criteria',
    'Second criteria',
  ].join('\n');
  expect(() => readOrgTasks(duplicateCriteria, 'change/tasks.org')).toThrow(
    'change/tasks.org:7: duplicate acceptance criteria section (Acceptance Criteria) in task 1.1 (first defined at line 5)'
  );

  const duplicateEvidence = [
    task('1.2'),
    '*** Evidence',
    'First evidence',
    '*** 验收结果',
    'Second evidence',
  ].join('\n');
  expect(() => readOrgTasks(duplicateEvidence, 'change/tasks.org')).toThrow(
    'change/tasks.org:7: duplicate evidence section (验收结果) in task 1.2 (first defined at line 5)'
  );
});

it('rejects nested TODO or DONE headings outside evidence and code/example blocks', () => {
  const directNested = [
    '* TODO Parent',
    ':PROPERTIES:',
    ':TASK_ID: 1.1',
    ':END:',
    '** TODO Child subtask',
    ':PROPERTIES:',
    ':TASK_ID: 1.1.1',
    ':END:',
  ].join('\n');
  expect(() => readOrgTasks(directNested, 'tasks.org')).toThrow(
    'tasks.org:5: nested TODO heading inside task 1.1 (line 1) is not allowed outside evidence sections'
  );

  const nestedInCustom = [
    '* TODO Parent',
    ':PROPERTIES:',
    ':TASK_ID: 1.2',
    ':END:',
    '** Notes',
    '*** DONE Hidden subtask',
  ].join('\n');
  expect(() => readOrgTasks(nestedInCustom, 'tasks.org')).toThrow(
    'tasks.org:6: nested DONE heading inside task 1.2 (line 1) is not allowed outside evidence sections'
  );

  const allowedSrcAndEvidence = [
    '* TODO Parent',
    ':PROPERTIES:',
    ':TASK_ID: 1.3',
    ':END:',
    '#+BEGIN_SRC org',
    '** TODO Example inside src',
    '#+END_SRC',
    '** Evidence',
    '*** DONE Verified inside evidence',
  ].join('\n');
  expect(readOrgTasks(allowedSrcAndEvidence, 'tasks.org')).toHaveLength(1);
});

it('exports structural model with BOM, dominant EOL, group paths, drawer spans, and raw line slices', () => {
  const source =
    '\uFEFF' +
    [
      '#+STARTUP: num',
      '* Parent',
      '** Child',
      '*** TODO Nested group task',
      ':PROPERTIES:',
      ':TASK_ID: 1.1',
      ':DEPENDS_ON: 0.9',
      ':END:',
      '**** 描述',
      'Body',
      '**** 验收标准',
      'Done',
    ].join('\r\n');

  const doc = parseOrgTasksDocument(source, 'tasks.org');
  expect(doc.hasBom).toBe(true);
  expect(doc.eol).toBe('\r\n');
  expect(doc.trailingNewline).toBe(false);
  expect(doc.groups[0]).toMatchObject({ title: 'Parent', path: ['Parent'], level: 1 });
  expect(doc.groups[0].children[0]).toMatchObject({
    title: 'Child',
    path: ['Parent', 'Child'],
    level: 2,
  });
  expect(doc.tasks).toHaveLength(1);
  expect(doc.tasks[0]).toMatchObject({
    level: 3,
    groupPath: ['Parent', 'Child'],
    startLine: 3,
    endLine: 12,
    propertyDrawer: {
      startLine: 4,
      endLine: 7,
      properties: [
        { key: 'TASK_ID', value: '1.1', line: 5 },
        { key: 'DEPENDS_ON', value: '0.9', line: 6 },
      ],
    },
  });
  expect(doc.tasks[0].sections.map((section) => section.kind)).toEqual(['description', 'criteria']);
});
