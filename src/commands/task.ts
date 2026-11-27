import path from 'node:path';
import { resolveRootForCommand, toRootOutput, withStoreFlag } from '../core/root-selection.js';
import { resolveSchemaForChange } from '../utils/change-metadata.js';
import { readOrgTaskProgress } from '../utils/task-progress.js';
import type { OrgTask, OrgTaskNext } from '../core/parsers/org-tasks.js';
import { validateChangeExists } from './workflow/shared.js';

export type TaskAction = 'list' | 'show' | 'next';
export interface TaskOptions {
  change: string;
  json?: boolean;
  store?: string;
  storePath?: string;
  sections?: string;
}

const sections = ['description', 'criteria', 'evidence', 'custom'] as const;

function selectSections(value?: string) {
  if (value === undefined) return new Set(['description', 'criteria']);
  const values = value.split(',').map((part) => part.trim());
  if (values.length === 1 && values[0] === 'all') return new Set<string>(sections);
  if (values.some((part) => !sections.some((section) => section === part))) {
    throw new Error(`Invalid --sections selection: ${JSON.stringify(value)}. Choose ${sections.join(', ')} (comma-separated) or all by itself.`);
  }
  return new Set(values);
}

function taskSummary({ id, title, state }: OrgTask) {
  return { id, title, state };
}

export function describeOrgTaskNext(next: OrgTaskNext): string {
  switch (next.state) {
    case 'empty': return 'No Org tasks have been defined.';
    case 'all_done': return 'All Org tasks are complete.';
    case 'ready': return `Next task: ${next.taskId}.`;
    case 'blocked': {
      const details = [
        next.incomplete.length ? `incomplete dependencies: ${next.incomplete.join(', ')}` : '',
        next.unknown.length ? `unknown dependencies: ${next.unknown.join(', ')}` : '',
      ].filter(Boolean);
      return `Task ${next.taskId} is blocked (${details.join('; ')}).`;
    }
  }
}

export async function taskCommand(action: TaskAction, options: TaskOptions, taskId?: string): Promise<void> {
  const selected = action === 'show' ? selectSections(options.sections) : new Set<string>();
  const root = await resolveRootForCommand(options, { json: options.json });
  if (!root) return;
  const change = await validateChangeExists(options.change, root.path, root.changesDir, {
    newChangeHint: withStoreFlag(root, 'openspec new change <name>'),
  });
  const changeDir = path.join(root.changesDir, change);
  const schemaName = resolveSchemaForChange(changeDir, undefined, root.path);
  if (schemaName !== 'spec-driven-org') throw new Error(`Change '${change}' does not use the Org workflow (spec-driven-org).`);
  const result = await readOrgTaskProgress(changeDir, root.path, schemaName);
  if (result.missing) throw new Error(`Missing Org tasks file: ${result.sourcePath}`);
  const rootOutput = options.json ? { root: toRootOutput(root) } : {};

  if (action === 'list') {
    const tasks = result.tasks.map(taskSummary);
    if (options.json) console.log(JSON.stringify({ change, tasks, ...rootOutput }, null, 2));
    else if (!tasks.length) console.log('No Org tasks have been defined.');
    else for (const task of tasks) console.log(`${task.id} ${task.state} ${task.title}`);
    return;
  }
  if (action === 'next') {
    if (options.json) console.log(JSON.stringify({ change, next: result.next, ...rootOutput }, null, 2));
    else console.log(describeOrgTaskNext(result.next));
    return;
  }

  const found = result.tasks.find((task) => task.id === taskId);
  if (!found) throw new Error(`Task '${taskId}' not found in ${result.sourcePath}`);
  const task = {
    ...taskSummary(found), dependencies: found.dependencies, sourcePath: result.sourcePath, line: found.line,
    ...(selected.has('description') ? { description: found.description } : {}),
    ...(selected.has('criteria') ? { criteria: found.criteria } : {}),
    ...(selected.has('evidence') && found.evidence !== undefined ? { evidence: found.evidence } : {}),
    ...(selected.has('custom') ? { custom: found.custom } : {}),
  };
  if (options.json) {
    console.log(JSON.stringify({ change, task, ...rootOutput }, null, 2));
    return;
  }
  console.log(`${task.id} ${task.state} ${task.title}`);
  console.log(`Source: ${task.sourcePath}:${task.line}`);
  console.log(`Dependencies: ${task.dependencies.join(', ') || 'none'}`);
  if (task.description !== undefined) console.log(`\n描述\n${task.description}`);
  if (task.criteria !== undefined) console.log(`\n验收标准\n${task.criteria}`);
  if (task.evidence !== undefined) {
    console.log('\n验收结果');
    process.stdout.write(task.evidence);
    if (!/[\r\n]$/.test(task.evidence)) process.stdout.write('\n');
  }
  for (const section of task.custom ?? []) console.log(`\n${section.title}\n${section.content}`);
}
