import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  resolveRootForCommand,
  toRootOutput,
  withStoreFlag,
  type ResolvedOpenSpecRoot,
} from '../core/root-selection.js';
import { resolveSchemaForChange } from '../utils/change-metadata.js';
import { readOrgTaskProgress } from '../utils/task-progress.js';
import { resolveArtifactOutputPath, resolveSchema } from '../core/artifact-graph/index.js';
import type { OrgTask, OrgTaskNext } from '../core/parsers/org-tasks.js';
import {
  OrgTaskEditError,
  applyOrgTaskMutation,
  isStructuralOrgMutation,
  planOrgTaskMutation,
  type EditOrgTaskCustomSection,
  type OrgTaskMutation,
  type SplitOrgTaskPart,
} from '../core/org-task-editor.js';
import { confirmPrompt, isInteractive } from '../utils/interactive.js';
import { isPromptCancellationError } from './shared-output.js';
import { validateChangeExists } from './workflow/shared.js';

export type TaskAction = 'list' | 'show' | 'next';
export interface TaskOptions {
  change: string;
  json?: boolean;
  store?: string;
  storePath?: string;
  sections?: string;
}

export interface TaskMutationBaseOptions {
  change: string;
  json?: boolean;
  store?: string;
  storePath?: string;
  preview?: boolean;
  confirm?: boolean;
  previewHash?: string;
}

export interface TaskCreateOptions extends TaskMutationBaseOptions {
  id: string;
  title: string;
  description?: string;
  criteria?: string;
  dependsOn?: string;
  group?: string;
  position?: string;
  before?: string;
  after?: string;
}

export interface TaskEditOptions extends TaskMutationBaseOptions {
  title?: string;
  description?: string;
  criteria?: string;
  dependsOn?: string;
  custom?: string[];
}

export type TaskRemoveOptions = TaskMutationBaseOptions;
export type TaskReorderOptions = TaskMutationBaseOptions;

export interface TaskMoveOptions extends TaskMutationBaseOptions {
  group?: string;
  position?: string;
  before?: string;
  after?: string;
}

export interface TaskSplitOptions extends TaskMutationBaseOptions {
  into?: string[];
}

const sections = ['description', 'criteria', 'evidence', 'custom'] as const;

function selectSections(value?: string) {
  if (value === undefined) return new Set(['description', 'criteria']);
  const values = value.split(',').map((part) => part.trim());
  if (values.length === 1 && values[0] === 'all') return new Set<string>(sections);
  if (values.some((part) => !sections.some((section) => section === part))) {
    throw new Error(
      `Invalid --sections selection: ${JSON.stringify(value)}. Choose ${sections.join(', ')} (comma-separated) or all by itself.`
    );
  }
  return new Set(values);
}

function taskSummary({ id, title, state }: OrgTask) {
  return { id, title, state };
}

export function describeOrgTaskNext(next: OrgTaskNext): string {
  switch (next.state) {
    case 'empty':
      return 'No Org tasks have been defined.';
    case 'all_done':
      return 'All Org tasks are complete.';
    case 'ready':
      return `Next task: ${next.taskId}.`;
    case 'blocked': {
      const details = [
        next.incomplete.length ? `incomplete dependencies: ${next.incomplete.join(', ')}` : '',
        next.unknown.length ? `unknown dependencies: ${next.unknown.join(', ')}` : '',
      ].filter(Boolean);
      return `Task ${next.taskId} is blocked (${details.join('; ')}).`;
    }
  }
}

async function resolveOrgTaskContext(options: {
  change: string;
  json?: boolean;
  store?: string;
  storePath?: string;
}): Promise<{ root: ResolvedOpenSpecRoot; change: string; changeDir: string; sourcePath: string } | undefined> {
  const root = await resolveRootForCommand(options, { json: options.json });
  if (!root) return undefined;
  const change = await validateChangeExists(options.change, root.path, root.changesDir, {
    newChangeHint: withStoreFlag(root, 'openspec new change <name>'),
  });
  const changeDir = path.join(root.changesDir, change);
  const schemaName = resolveSchemaForChange(changeDir, undefined, root.path);
  if (schemaName !== 'spec-driven-org') {
    throw new Error(`Change '${change}' does not use the Org workflow (spec-driven-org).`);
  }
  const schema = resolveSchema(schemaName, root.path);
  const tracks = schema.apply?.tracks;
  const artifact =
    tracks != null
      ? schema.artifacts.find((item) => item.generates === tracks)
      : schema.artifacts.find((item) => item.id === 'tasks');
  if (!artifact || artifact.generates !== 'tasks.org') {
    throw new Error('The Org workflow must track tasks.org');
  }
  const sourcePath = resolveArtifactOutputPath(changeDir, artifact.generates);
  return { root, change, changeDir, sourcePath };
}

function parseDependsOnFlag(value?: string): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCustomSectionFlag(rawValues?: string[]): EditOrgTaskCustomSection[] | undefined {
  if (!rawValues || rawValues.length === 0) return undefined;
  return rawValues.map((raw) => {
    const eqIndex = raw.indexOf('=');
    if (eqIndex <= 0) {
      throw new OrgTaskEditError(
        `Invalid --custom value ${JSON.stringify(raw)}: expected <name>=<content>.`,
        'invalid_custom_section'
      );
    }
    return {
      title: raw.slice(0, eqIndex).trim(),
      content: raw.slice(eqIndex + 1),
    };
  });
}

function parseSplitIntoFlag(rawValues?: string[]): SplitOrgTaskPart[] {
  if (!rawValues || rawValues.length < 2) {
    throw new OrgTaskEditError(
      'task split requires at least two --into specifications.',
      'insufficient_split_parts',
      { fix: 'Pass --into "<id>=<title>" at least twice.' }
    );
  }
  return rawValues.map((raw) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new OrgTaskEditError(
          `Invalid JSON in --into: ${(error as Error).message}`,
          'invalid_split_spec'
        );
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new OrgTaskEditError('Invalid --into JSON object.', 'invalid_split_spec');
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record.id !== 'string' || typeof record.title !== 'string') {
        throw new OrgTaskEditError(
          'JSON --into specification must include string "id" and "title" fields.',
          'invalid_split_spec'
        );
      }
      return {
        id: record.id,
        title: record.title,
        ...(typeof record.description === 'string' ? { description: record.description } : {}),
        ...(typeof record.criteria === 'string' ? { criteria: record.criteria } : {}),
        ...(Array.isArray(record.dependsOn)
          ? { dependsOn: record.dependsOn.map((dep) => String(dep)) }
          : {}),
      };
    }

    const eqIndex = raw.indexOf('=');
    if (eqIndex <= 0) {
      throw new OrgTaskEditError(
        `Invalid --into value ${JSON.stringify(raw)}: expected <id>=<title> or JSON object.`,
        'invalid_split_spec'
      );
    }
    return {
      id: raw.slice(0, eqIndex).trim(),
      title: raw.slice(eqIndex + 1).trim(),
    };
  });
}

function parsePositionFlag(value?: string): 'start' | 'end' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'start' && value !== 'end') {
    throw new OrgTaskEditError(
      `Invalid --position '${value}': expected 'start' or 'end'.`,
      'invalid_position'
    );
  }
  return value;
}

export async function taskMutateCommand(
  mutation: OrgTaskMutation,
  options: TaskMutationBaseOptions
): Promise<void> {
  const context = await resolveOrgTaskContext(options);
  if (!context) return;
  const { root, change, sourcePath } = context;

  let currentContent: string;
  try {
    currentContent = await fs.readFile(sourcePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Missing Org tasks file: ${sourcePath}`);
    }
    throw error;
  }

  const plan = planOrgTaskMutation(currentContent, sourcePath, mutation);
  const rootOutput = options.json ? { root: toRootOutput(root) } : {};

  if (options.preview) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            change,
            operation: plan.operation,
            preview: true,
            applied: false,
            snapshotHash: plan.snapshotHash,
            previewHash: plan.previewHash,
            summary: plan.summary,
            diff: plan.preview,
            details: plan.details,
            sourcePath,
            ...rootOutput,
          },
          null,
          2
        )
      );
      return;
    }
    console.log(plan.summary);
    console.log(`Preview hash: ${plan.previewHash}`);
    console.log('');
    console.log(plan.preview);
    return;
  }

  if (options.previewHash !== undefined && options.previewHash !== plan.previewHash) {
    throw new OrgTaskEditError(
      `Preview hash mismatch for ${sourcePath}: the file or mutation parameters changed since preview.`,
      'preview_hash_mismatch',
      { fix: 'Re-run with --preview to inspect the current diff and obtain a fresh previewHash.' }
    );
  }

  const structural = isStructuralOrgMutation(mutation.type);
  let effectiveConfirm = Boolean(options.confirm);
  let effectivePreviewHash = options.previewHash;

  if (structural && !(effectiveConfirm && effectivePreviewHash)) {
    if (!options.json && isInteractive()) {
      console.log(plan.summary);
      console.log(`Preview hash: ${plan.previewHash}`);
      console.log('');
      console.log(plan.preview);
      console.log('');

      let confirmed: boolean;
      try {
        confirmed = await confirmPrompt({
          message: 'Apply these changes to tasks.org?',
          default: false,
        });
      } catch (error) {
        if (isPromptCancellationError(error)) {
          console.error('Cancelled.');
          process.exitCode = 130;
          return;
        }
        throw error;
      }

      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
      effectiveConfirm = true;
      effectivePreviewHash = plan.previewHash;
    } else {
      throw new OrgTaskEditError(
        `Structural Org task mutation '${mutation.type}' requires both --confirm and a matching --preview-hash in non-interactive mode.`,
        'confirmation_required',
        { fix: 'Run with --preview first, then re-run with --confirm --preview-hash <hash>.' }
      );
    }
  }

  const result = await applyOrgTaskMutation(sourcePath, mutation, {
    confirm: effectiveConfirm,
    previewHash: effectivePreviewHash,
    requireConfirmation: structural,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          change,
          operation: result.operation,
          preview: false,
          applied: true,
          snapshotHash: result.snapshotHash,
          previewHash: result.previewHash,
          summary: result.summary,
          details: result.details,
          sourcePath,
          ...rootOutput,
        },
        null,
        2
      )
    );
    return;
  }
  console.log(result.summary);
}

export async function taskCreateCommand(options: TaskCreateOptions): Promise<void> {
  await taskMutateCommand(
    {
      type: 'create',
      id: options.id,
      title: options.title,
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.criteria !== undefined ? { criteria: options.criteria } : {}),
      ...(options.dependsOn !== undefined ? { dependsOn: parseDependsOnFlag(options.dependsOn) } : {}),
      ...(options.group !== undefined ? { group: options.group } : {}),
      ...(options.position !== undefined ? { position: parsePositionFlag(options.position) } : {}),
      ...(options.before !== undefined ? { before: options.before } : {}),
      ...(options.after !== undefined ? { after: options.after } : {}),
    },
    options
  );
}

export async function taskEditCommand(taskId: string, options: TaskEditOptions): Promise<void> {
  await taskMutateCommand(
    {
      type: 'edit',
      taskId,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.criteria !== undefined ? { criteria: options.criteria } : {}),
      ...(options.dependsOn !== undefined ? { dependsOn: parseDependsOnFlag(options.dependsOn) } : {}),
      ...(options.custom && options.custom.length > 0
        ? { custom: parseCustomSectionFlag(options.custom) }
        : {}),
    },
    options
  );
}

export async function taskRemoveCommand(taskId: string, options: TaskRemoveOptions): Promise<void> {
  await taskMutateCommand({ type: 'remove', taskId }, options);
}

export async function taskReorderCommand(
  taskIds: string[],
  options: TaskReorderOptions
): Promise<void> {
  await taskMutateCommand({ type: 'reorder', taskIds }, options);
}

export async function taskMoveCommand(taskId: string, options: TaskMoveOptions): Promise<void> {
  await taskMutateCommand(
    {
      type: 'move',
      taskId,
      ...(options.group !== undefined ? { group: options.group } : {}),
      ...(options.position !== undefined ? { position: parsePositionFlag(options.position) } : {}),
      ...(options.before !== undefined ? { before: options.before } : {}),
      ...(options.after !== undefined ? { after: options.after } : {}),
    },
    options
  );
}

export async function taskSplitCommand(taskId: string, options: TaskSplitOptions): Promise<void> {
  await taskMutateCommand(
    {
      type: 'split',
      taskId,
      parts: parseSplitIntoFlag(options.into),
    },
    options
  );
}

export async function taskCommand(
  action: TaskAction,
  options: TaskOptions,
  taskId?: string
): Promise<void> {
  const selected = action === 'show' ? selectSections(options.sections) : new Set<string>();
  const root = await resolveRootForCommand(options, { json: options.json });
  if (!root) return;
  const change = await validateChangeExists(options.change, root.path, root.changesDir, {
    newChangeHint: withStoreFlag(root, 'openspec new change <name>'),
  });
  const changeDir = path.join(root.changesDir, change);
  const schemaName = resolveSchemaForChange(changeDir, undefined, root.path);
  if (schemaName !== 'spec-driven-org') {
    throw new Error(`Change '${change}' does not use the Org workflow (spec-driven-org).`);
  }
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
    ...taskSummary(found),
    dependencies: found.dependencies,
    sourcePath: result.sourcePath,
    line: found.line,
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
