import { expect, it } from 'vitest';
import { nextOrgTask, readOrgTasks } from '../../../src/core/parsers/org-tasks.js';

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
