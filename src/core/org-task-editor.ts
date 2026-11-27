import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  acquireFileLock,
  releaseFileLock,
  writeFileAtomically,
  type FileLockErrorInfo,
  type FileLockErrorKind,
} from './file-state.js';
import {
  parseOrgTasksDocument,
  type OrgGroupStructure,
  type OrgLine,
  type OrgTaskStructure,
  type OrgTasksDocument,
} from './parsers/org-tasks.js';
import type { StoreDiagnostic } from './store/errors.js';

export class OrgTaskEditError extends Error {
  readonly diagnostic: StoreDiagnostic;

  constructor(
    message: string,
    code: string,
    options: { target?: string; fix?: string } = {}
  ) {
    super(message);
    this.name = 'OrgTaskEditError';
    this.diagnostic = {
      severity: 'error',
      code,
      message,
      ...options,
    };
  }
}

export interface CreateOrgTaskMutation {
  type: 'create';
  id: string;
  title: string;
  description?: string;
  criteria?: string;
  dependsOn?: string[];
  group?: string;
  position?: 'start' | 'end';
  before?: string;
  after?: string;
}

export interface EditOrgTaskCustomSection {
  title: string;
  content: string;
}

export interface EditOrgTaskMutation {
  type: 'edit';
  taskId: string;
  title?: string;
  description?: string;
  criteria?: string;
  dependsOn?: string[];
  custom?: EditOrgTaskCustomSection[];
}

export interface RemoveOrgTaskMutation {
  type: 'remove';
  taskId: string;
}

export interface ReorderOrgTasksMutation {
  type: 'reorder';
  taskIds: string[];
}

export interface MoveOrgTaskMutation {
  type: 'move';
  taskId: string;
  group?: string;
  position?: 'start' | 'end';
  before?: string;
  after?: string;
}

export interface SplitOrgTaskPart {
  id: string;
  title: string;
  description?: string;
  criteria?: string;
  dependsOn?: string[];
}

export interface SplitOrgTaskMutation {
  type: 'split';
  taskId: string;
  parts: SplitOrgTaskPart[];
}

export type OrgTaskMutation =
  | CreateOrgTaskMutation
  | EditOrgTaskMutation
  | RemoveOrgTaskMutation
  | ReorderOrgTasksMutation
  | MoveOrgTaskMutation
  | SplitOrgTaskMutation;

export interface OrgTaskMutationPlan {
  operation: OrgTaskMutation['type'];
  snapshotHash: string;
  previewHash: string;
  nextContent: string;
  summary: string;
  preview: string;
  details: Record<string, unknown>;
}

export interface ApplyOrgTaskMutationOptions {
  confirm?: boolean;
  previewHash?: string;
  requireConfirmation?: boolean;
  lockTimeoutMs?: number;
}

export interface OrgTaskMutationResult extends OrgTaskMutationPlan {
  applied: boolean;
}

const RESERVED_SECTION_TITLES = new Set([
  '描述',
  'Description',
  '验收标准',
  'Acceptance Criteria',
  '验收结果',
  'Evidence',
]);

export function isStructuralOrgMutation(operation: OrgTaskMutation['type']): boolean {
  return operation !== 'edit';
}

export function computeSnapshotHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeIds(ids: string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function normalizeMutation(mutation: OrgTaskMutation): OrgTaskMutation {
  switch (mutation.type) {
    case 'create':
      return {
        type: 'create',
        id: mutation.id.trim(),
        title: mutation.title.trim(),
        ...(mutation.description !== undefined ? { description: mutation.description } : {}),
        ...(mutation.criteria !== undefined ? { criteria: mutation.criteria } : {}),
        ...(mutation.dependsOn !== undefined ? { dependsOn: normalizeIds(mutation.dependsOn) } : {}),
        ...(mutation.group !== undefined ? { group: mutation.group.trim() } : {}),
        ...(mutation.position !== undefined ? { position: mutation.position } : {}),
        ...(mutation.before !== undefined ? { before: mutation.before.trim() } : {}),
        ...(mutation.after !== undefined ? { after: mutation.after.trim() } : {}),
      };
    case 'edit':
      return {
        type: 'edit',
        taskId: mutation.taskId.trim(),
        ...(mutation.title !== undefined ? { title: mutation.title.trim() } : {}),
        ...(mutation.description !== undefined ? { description: mutation.description } : {}),
        ...(mutation.criteria !== undefined ? { criteria: mutation.criteria } : {}),
        ...(mutation.dependsOn !== undefined ? { dependsOn: normalizeIds(mutation.dependsOn) } : {}),
        ...(mutation.custom !== undefined
          ? {
              custom: mutation.custom.map((item) => ({
                title: item.title.trim(),
                content: item.content,
              })),
            }
          : {}),
      };
    case 'remove':
      return {
        type: 'remove',
        taskId: mutation.taskId.trim(),
      };
    case 'reorder':
      return {
        type: 'reorder',
        taskIds: mutation.taskIds.map((id) => id.trim()),
      };
    case 'move':
      return {
        type: 'move',
        taskId: mutation.taskId.trim(),
        ...(mutation.group !== undefined ? { group: mutation.group.trim() } : {}),
        ...(mutation.position !== undefined ? { position: mutation.position } : {}),
        ...(mutation.before !== undefined ? { before: mutation.before.trim() } : {}),
        ...(mutation.after !== undefined ? { after: mutation.after.trim() } : {}),
      };
    case 'split':
      return {
        type: 'split',
        taskId: mutation.taskId.trim(),
        parts: mutation.parts.map((part) => ({
          id: part.id.trim(),
          title: part.title.trim(),
          ...(part.description !== undefined ? { description: part.description } : {}),
          ...(part.criteria !== undefined ? { criteria: part.criteria } : {}),
          ...(part.dependsOn !== undefined ? { dependsOn: normalizeIds(part.dependsOn) } : {}),
        })),
      };
  }
}

export function computePreviewHash(snapshotHash: string, mutation: OrgTaskMutation): string {
  const normalized = normalizeMutation(mutation);
  return createHash('sha256')
    .update(stableStringify({ snapshotHash, mutation: normalized }), 'utf8')
    .digest('hex');
}

function makeLine(text: string, eol: string): OrgLine {
  return { text, eol, raw: text + eol };
}

function textToLines(content: string, eol: string): OrgLine[] {
  if (content === '') return [];
  const trimmed = content.replace(/(?:\r\n|\r|\n)$/, '');
  if (trimmed === '') return [];
  return trimmed.split(/\r\n|\r|\n/).map((line) => makeLine(line, eol));
}

function serializeDocument(
  lines: OrgLine[],
  options: { hasBom: boolean; eol: '\r\n' | '\n'; trailingNewline: boolean; wasEmpty: boolean }
): string {
  if (lines.length === 0) {
    return options.hasBom ? '\uFEFF' : '';
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    out.push(line.text + (line.eol || options.eol));
  }
  const last = lines[lines.length - 1];
  const keepTrailingNewline = options.trailingNewline || options.wasEmpty;
  out.push(keepTrailingNewline ? last.text + (last.eol || options.eol) : last.text);
  return (options.hasBom ? '\uFEFF' : '') + out.join('');
}

function validateTaskIdValue(id: string, label = 'TASK_ID'): void {
  if (!id || /[,\r\n]/.test(id)) {
    throw new OrgTaskEditError(
      `Invalid ${label} '${id}': must be non-empty and must not contain commas or line breaks.`,
      'invalid_task_id'
    );
  }
}

function validateSingleLineTitle(title: string, label = 'title'): void {
  if (!title || /[\r\n]/.test(title)) {
    throw new OrgTaskEditError(
      `Invalid ${label}: must be non-empty and single-line.`,
      'invalid_task_title'
    );
  }
}

function findTask(doc: OrgTasksDocument, taskId: string): OrgTaskStructure {
  const found = doc.tasks.find((entry) => entry.task.id === taskId);
  if (!found) {
    throw new OrgTaskEditError(
      `Task '${taskId}' not found in ${doc.sourcePath}.`,
      'task_not_found'
    );
  }
  return found;
}

function flattenGroups(groups: OrgGroupStructure[]): OrgGroupStructure[] {
  const flat: OrgGroupStructure[] = [];
  for (const group of groups) {
    flat.push(group, ...flattenGroups(group.children));
  }
  return flat;
}

function resolveTargetGroup(doc: OrgTasksDocument, groupSpec: string): OrgGroupStructure {
  const allGroups = flattenGroups(doc.groups);
  if (groupSpec.includes('/')) {
    const segments = groupSpec
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      throw new OrgTaskEditError(`Invalid group path '${groupSpec}'.`, 'invalid_group_path');
    }
    const matches = allGroups.filter(
      (group) =>
        group.path.length === segments.length &&
        group.path.every((part, index) => part === segments[index])
    );
    if (matches.length === 0) {
      throw new OrgTaskEditError(
        `Group path '${segments.join('/')}' not found in ${doc.sourcePath}.`,
        'group_not_found'
      );
    }
    if (matches.length > 1) {
      throw new OrgTaskEditError(
        `Group path '${segments.join('/')}' matches multiple groups in ${doc.sourcePath}.`,
        'ambiguous_group'
      );
    }
    return matches[0];
  }

  const matches = allGroups.filter((group) => group.title === groupSpec);
  if (matches.length === 0) {
    throw new OrgTaskEditError(
      `Group '${groupSpec}' not found in ${doc.sourcePath}.`,
      'group_not_found'
    );
  }
  if (matches.length > 1) {
    const paths = matches.map((group) => group.path.join('/')).join(', ');
    throw new OrgTaskEditError(
      `Group name '${groupSpec}' is ambiguous (matches: ${paths}). Specify the full group path.`,
      'ambiguous_group',
      { fix: `Re-run with --group using one of: ${paths}` }
    );
  }
  return matches[0];
}

function resolvePlacement(
  doc: OrgTasksDocument,
  options: { group?: string; position?: 'start' | 'end'; before?: string; after?: string }
): {
  targetParentGroupStartLine: number | null;
  targetGroupLabel: string;
  targetLevel: number;
  insertAt: number;
} {
  if (options.before && options.after) {
    throw new OrgTaskEditError('Cannot combine --before and --after.', 'conflicting_position');
  }
  if (options.position && (options.before || options.after)) {
    throw new OrgTaskEditError(
      'Cannot combine --position with --before or --after.',
      'conflicting_position'
    );
  }
  if (options.position && options.position !== 'start' && options.position !== 'end') {
    throw new OrgTaskEditError(
      `Invalid --position '${options.position}': expected 'start' or 'end'.`,
      'invalid_position'
    );
  }

  const anchorId = options.before ?? options.after;
  const anchorTask = anchorId ? findTask(doc, anchorId) : undefined;
  const explicitGroup = options.group !== undefined;
  const resolvedGroup =
    options.group !== undefined && options.group !== '/'
      ? resolveTargetGroup(doc, options.group)
      : undefined;

  let targetParentGroupStartLine: number | null;
  let targetGroupLabel: string;
  let targetLevel: number;

  if (options.group === '/') {
    targetParentGroupStartLine = null;
    targetGroupLabel = '/';
    targetLevel = 1;
  } else if (resolvedGroup) {
    targetParentGroupStartLine = resolvedGroup.startLine;
    targetGroupLabel = resolvedGroup.path.join('/');
    targetLevel = resolvedGroup.level + 1;
  } else if (anchorTask) {
    targetParentGroupStartLine = anchorTask.parentGroupStartLine;
    targetGroupLabel = anchorTask.groupPath.length ? anchorTask.groupPath.join('/') : '/';
    targetLevel = anchorTask.level;
  } else {
    targetParentGroupStartLine = null;
    targetGroupLabel = '/';
    targetLevel = 1;
  }

  if (anchorTask && explicitGroup && anchorTask.parentGroupStartLine !== targetParentGroupStartLine) {
    throw new OrgTaskEditError(
      `Anchor task '${anchorTask.task.id}' belongs to group '${anchorTask.groupPath.join('/') || '/'}', not '${targetGroupLabel}'.`,
      'anchor_group_mismatch'
    );
  }

  let insertAt: number;
  if (anchorTask) {
    insertAt = options.before ? anchorTask.startLine : anchorTask.endLine;
  } else if (resolvedGroup) {
    insertAt = (options.position ?? 'end') === 'start' ? resolvedGroup.directEndLine : resolvedGroup.endLine;
  } else {
    insertAt = (options.position ?? 'end') === 'start' ? doc.firstHeadingLine : doc.lines.length;
  }

  return { targetParentGroupStartLine, targetGroupLabel, targetLevel, insertAt };
}

function buildTaskLines(
  level: number,
  eol: '\r\n' | '\n',
  task: {
    id: string;
    title: string;
    description?: string;
    criteria?: string;
    dependsOn?: string[];
    evidenceLines?: OrgLine[];
  }
): OrgLine[] {
  const stars = '*'.repeat(level);
  const subStars = '*'.repeat(level + 1);
  const lines: OrgLine[] = [
    makeLine(`${stars} TODO ${task.title}`, eol),
    makeLine(':PROPERTIES:', eol),
    makeLine(`:TASK_ID: ${task.id}`, eol),
  ];
  if (task.dependsOn && task.dependsOn.length > 0) {
    lines.push(makeLine(`:DEPENDS_ON: ${task.dependsOn.join(', ')}`, eol));
  }
  lines.push(makeLine(':END:', eol));
  lines.push(makeLine(`${subStars} 描述`, eol));
  lines.push(...textToLines(task.description ?? '', eol));
  lines.push(makeLine(`${subStars} 验收标准`, eol));
  lines.push(...textToLines(task.criteria ?? '', eol));
  if (task.evidenceLines && task.evidenceLines.length > 0) {
    lines.push(...task.evidenceLines);
  }
  return lines;
}

function updateDependsOnInLines(
  lines: OrgLine[],
  task: OrgTaskStructure,
  newDeps: string[],
  eol: '\r\n' | '\n'
): OrgLine[] {
  const drawer = task.propertyDrawer;
  if (!drawer) {
    if (newDeps.length === 0) return lines;
    const inserted = [
      makeLine(':PROPERTIES:', eol),
      makeLine(`:TASK_ID: ${task.task.id}`, eol),
      makeLine(`:DEPENDS_ON: ${newDeps.join(', ')}`, eol),
      makeLine(':END:', eol),
    ];
    return [
      ...lines.slice(0, task.planningEndLine),
      ...inserted,
      ...lines.slice(task.planningEndLine),
    ];
  }

  const existingDep = drawer.properties.find((prop) => prop.key === 'DEPENDS_ON');
  if (existingDep) {
    if (newDeps.length === 0) {
      return [...lines.slice(0, existingDep.line), ...lines.slice(existingDep.line + 1)];
    }
    const indent = /^([ \t]*)/.exec(lines[existingDep.line].text)?.[1] ?? '';
    const updatedLine = makeLine(
      `${indent}:DEPENDS_ON: ${newDeps.join(', ')}`,
      lines[existingDep.line].eol || eol
    );
    return [
      ...lines.slice(0, existingDep.line),
      updatedLine,
      ...lines.slice(existingDep.line + 1),
    ];
  }

  if (newDeps.length === 0) return lines;
  const indent = /^([ \t]*)/.exec(lines[drawer.endLine].text)?.[1] ?? '';
  const insertedLine = makeLine(`${indent}:DEPENDS_ON: ${newDeps.join(', ')}`, eol);
  return [
    ...lines.slice(0, drawer.endLine),
    insertedLine,
    ...lines.slice(drawer.endLine),
  ];
}

function replaceLineSpan(
  lines: OrgLine[],
  start: number,
  end: number,
  replacement: OrgLine[]
): OrgLine[] {
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
}

function validateDependencyOrder(content: string, sourcePath: string): OrgTasksDocument {
  const nextDoc = parseOrgTasksDocument(content, sourcePath);
  const indexById = new Map<string, number>();
  nextDoc.tasks.forEach((entry, index) => indexById.set(entry.task.id, index));

  for (let index = 0; index < nextDoc.tasks.length; index++) {
    const task = nextDoc.tasks[index].task;
    for (const depId of task.dependencies) {
      if (depId === task.id) {
        throw new OrgTaskEditError(
          `Dependency conflict: task '${task.id}' cannot depend on itself.`,
          'dependency_conflict'
        );
      }
      const depIndex = indexById.get(depId);
      if (depIndex !== undefined && depIndex > index) {
        throw new OrgTaskEditError(
          `Dependency conflict: task '${task.id}' (order ${index + 1}) depends on '${depId}' (order ${depIndex + 1}), which appears later in document order.`,
          'dependency_conflict',
          { fix: `Ensure '${depId}' appears before '${task.id}' in ${sourcePath}.` }
        );
      }
    }
  }
  return nextDoc;
}

function buildDiffPreview(before: string, after: string): string {
  const beforeLines = before.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const afterLines = after.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const contextBefore = beforeLines.slice(Math.max(0, prefix - 2), prefix).map((line) => `  ${line}`);
  const contextAfter = afterLines
    .slice(afterLines.length - suffix, afterLines.length - suffix + 2)
    .map((line) => `  ${line}`);
  return [
    `--- a/tasks.org`,
    `+++ b/tasks.org`,
    `@@ line ${prefix + 1} @@`,
    ...contextBefore,
    ...removed.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`),
    ...contextAfter,
  ].join('\n');
}

function applyCreate(
  doc: OrgTasksDocument,
  mutation: CreateOrgTaskMutation
): { nextLines: OrgLine[]; summary: string; details: Record<string, unknown> } {
  validateTaskIdValue(mutation.id);
  validateSingleLineTitle(mutation.title);
  const existing = doc.tasks.find((entry) => entry.task.id === mutation.id);
  if (existing) {
    throw new OrgTaskEditError(
      `TASK_ID '${mutation.id}' already exists in ${doc.sourcePath} at line ${existing.task.line}.`,
      'duplicate_task_id'
    );
  }
  const deps = mutation.dependsOn ?? [];
  for (const dep of deps) validateTaskIdValue(dep, 'DEPENDS_ON');

  const placement = resolvePlacement(doc, mutation);
  const newLines = buildTaskLines(placement.targetLevel, doc.eol, {
    id: mutation.id,
    title: mutation.title,
    description: mutation.description,
    criteria: mutation.criteria,
    dependsOn: deps,
  });

  // Separate with a blank line when inserting before an existing line, or after a non-blank line.
  const insertChunks: OrgLine[] = [...newLines];
  if (placement.insertAt < doc.lines.length && doc.lines[placement.insertAt].text !== '') {
    insertChunks.push(makeLine('', doc.eol));
  }
  if (
    placement.insertAt > 0 &&
    doc.lines[placement.insertAt - 1].text !== '' &&
    !/^\*+[ \t]+/.test(doc.lines[placement.insertAt - 1].text)
  ) {
    insertChunks.unshift(makeLine('', doc.eol));
  }

  const nextLines = replaceLineSpan(doc.lines, placement.insertAt, placement.insertAt, insertChunks);
  return {
    nextLines,
    summary: `Create task '${mutation.id}' (${mutation.title}) in group '${placement.targetGroupLabel}'`,
    details: {
      taskId: mutation.id,
      group: placement.targetGroupLabel,
      level: placement.targetLevel,
    },
  };
}

function trailingBlankLinesCount(lines: OrgLine[], start: number, end: number): number {
  let count = 0;
  for (let i = end - 1; i >= start; i--) {
    if (lines[i].text === '') count++;
    else break;
  }
  return count;
}

function applyEdit(
  doc: OrgTasksDocument,
  mutation: EditOrgTaskMutation
): { nextLines: OrgLine[]; summary: string; details: Record<string, unknown> } {
  const hasAnyUpdate =
    mutation.title !== undefined ||
    mutation.description !== undefined ||
    mutation.criteria !== undefined ||
    mutation.dependsOn !== undefined ||
    (mutation.custom !== undefined && mutation.custom.length > 0);
  if (!hasAnyUpdate) {
    throw new OrgTaskEditError(
      'No edits specified. Pass at least one of --title, --description, --criteria, --depends-on, or --custom.',
      'no_edits_specified'
    );
  }
  if (mutation.title !== undefined) validateSingleLineTitle(mutation.title);
  if (mutation.dependsOn !== undefined) {
    for (const dep of mutation.dependsOn) validateTaskIdValue(dep, 'DEPENDS_ON');
  }
  if (mutation.custom) {
    for (const section of mutation.custom) {
      validateSingleLineTitle(section.title, 'custom section title');
      if (RESERVED_SECTION_TITLES.has(section.title)) {
        throw new OrgTaskEditError(
          `Section '${section.title}' is a reserved task section and cannot be modified via --custom.`,
          'reserved_section_title'
        );
      }
    }
  }

  const target = findTask(doc, mutation.taskId);
  const offset = target.startLine;
  let slice = doc.lines.slice(target.startLine, target.endLine);

  const reparseSlice = (): OrgTaskStructure => {
    const temp = serializeDocument(slice, {
      hasBom: false,
      eol: doc.eol,
      trailingNewline: true,
      wasEmpty: false,
    });
    const parsed = parseOrgTasksDocument(temp, doc.sourcePath);
    return parsed.tasks[0];
  };

  if (mutation.title !== undefined) {
    const headingLine = slice[0];
    slice[0] = makeLine(
      `${'*'.repeat(target.level)} ${target.task.state} ${mutation.title}`,
      headingLine.eol || doc.eol
    );
  }

  if (mutation.dependsOn !== undefined) {
    const current = reparseSlice();
    slice = updateDependsOnInLines(slice, current, mutation.dependsOn, doc.eol);
  }

  if (mutation.description !== undefined) {
    const current = reparseSlice();
    const descSections = current.sections.filter((section) => section.kind === 'description');
    const newBodyLines = textToLines(mutation.description, doc.eol);

    if (descSections.length > 0) {
      // Remove extra description sections from bottom to top first, preserving the first one.
      for (let i = descSections.length - 1; i >= 1; i--) {
        slice = replaceLineSpan(slice, descSections[i].startLine, descSections[i].endLine, []);
      }
      const refreshed = reparseSlice();
      const firstDesc = refreshed.sections.find((section) => section.kind === 'description')!;
      const trailingBlanks = trailingBlankLinesCount(slice, firstDesc.contentStartLine, firstDesc.endLine);
      const preservedTail =
        trailingBlanks > 0 ? slice.slice(firstDesc.endLine - trailingBlanks, firstDesc.endLine) : [];
      slice = replaceLineSpan(slice, firstDesc.contentStartLine, firstDesc.endLine, [
        ...newBodyLines,
        ...preservedTail,
      ]);

      // Clear any non-empty direct body prose before the first child section so the edited description matches cleanly.
      const afterDescEdit = reparseSlice();
      const directHasText = slice
        .slice(afterDescEdit.directBodyStartLine, afterDescEdit.directBodyEndLine)
        .some((line) => line.text.trim() !== '');
      if (directHasText) {
        slice = replaceLineSpan(
          slice,
          afterDescEdit.directBodyStartLine,
          afterDescEdit.directBodyEndLine,
          []
        );
      }
    } else {
      const directHasText = slice
        .slice(current.directBodyStartLine, current.directBodyEndLine)
        .some((line) => line.text.trim() !== '');
      if (directHasText) {
        const trailingBlanks = trailingBlankLinesCount(
          slice,
          current.directBodyStartLine,
          current.directBodyEndLine
        );
        const preservedTail =
          trailingBlanks > 0
            ? slice.slice(current.directBodyEndLine - trailingBlanks, current.directBodyEndLine)
            : [];
        slice = replaceLineSpan(slice, current.directBodyStartLine, current.directBodyEndLine, [
          ...newBodyLines,
          ...preservedTail,
        ]);
      } else {
        const subStars = '*'.repeat(target.level + 1);
        const insertAt = current.sections[0]?.startLine ?? slice.length - trailingBlankLinesCount(slice, 0, slice.length);
        slice = replaceLineSpan(slice, insertAt, insertAt, [
          makeLine(`${subStars} 描述`, doc.eol),
          ...newBodyLines,
        ]);
      }
    }
  }

  if (mutation.criteria !== undefined) {
    const current = reparseSlice();
    const criteriaSection = current.sections.find((section) => section.kind === 'criteria');
    const newBodyLines = textToLines(mutation.criteria, doc.eol);
    if (criteriaSection) {
      const trailingBlanks = trailingBlankLinesCount(
        slice,
        criteriaSection.contentStartLine,
        criteriaSection.endLine
      );
      const preservedTail =
        trailingBlanks > 0
          ? slice.slice(criteriaSection.endLine - trailingBlanks, criteriaSection.endLine)
          : [];
      slice = replaceLineSpan(slice, criteriaSection.contentStartLine, criteriaSection.endLine, [
        ...newBodyLines,
        ...preservedTail,
      ]);
    } else {
      const subStars = '*'.repeat(target.level + 1);
      const evidenceOrCustom = current.sections.find(
        (section) => section.kind === 'evidence' || section.kind === 'custom'
      );
      const insertAt =
        evidenceOrCustom?.startLine ?? slice.length - trailingBlankLinesCount(slice, 0, slice.length);
      slice = replaceLineSpan(slice, insertAt, insertAt, [
        makeLine(`${subStars} 验收标准`, doc.eol),
        ...newBodyLines,
      ]);
    }
  }

  if (mutation.custom) {
    for (const customUpdate of mutation.custom) {
      const current = reparseSlice();
      const existingSection = current.sections.find(
        (section) => section.kind === 'custom' && section.title === customUpdate.title
      );
      const newBodyLines = textToLines(customUpdate.content, doc.eol);
      if (existingSection) {
        const trailingBlanks = trailingBlankLinesCount(
          slice,
          existingSection.contentStartLine,
          existingSection.endLine
        );
        const preservedTail =
          trailingBlanks > 0
            ? slice.slice(existingSection.endLine - trailingBlanks, existingSection.endLine)
            : [];
        slice = replaceLineSpan(slice, existingSection.contentStartLine, existingSection.endLine, [
          ...newBodyLines,
          ...preservedTail,
        ]);
      } else {
        const subStars = '*'.repeat(target.level + 1);
        const insertAt = slice.length - trailingBlankLinesCount(slice, 0, slice.length);
        slice = replaceLineSpan(slice, insertAt, insertAt, [
          makeLine(`${subStars} ${customUpdate.title}`, doc.eol),
          ...newBodyLines,
        ]);
      }
    }
  }

  const nextLines = replaceLineSpan(doc.lines, offset, target.endLine, slice);
  const editedFields = [
    mutation.title !== undefined ? 'title' : '',
    mutation.description !== undefined ? 'description' : '',
    mutation.criteria !== undefined ? 'criteria' : '',
    mutation.dependsOn !== undefined ? 'dependsOn' : '',
    mutation.custom?.length ? `custom(${mutation.custom.map((c) => c.title).join(', ')})` : '',
  ].filter(Boolean);

  return {
    nextLines,
    summary: `Edit task '${mutation.taskId}' (${editedFields.join(', ')})`,
    details: { taskId: mutation.taskId, editedFields },
  };
}

function applyRemove(
  doc: OrgTasksDocument,
  mutation: RemoveOrgTaskMutation
): { nextLines: OrgLine[]; summary: string; details: Record<string, unknown> } {
  const target = findTask(doc, mutation.taskId);
  if (target.task.state === 'DONE') {
    throw new OrgTaskEditError(
      `Cannot remove task '${target.task.id}': completed (DONE) tasks are protected from removal.`,
      'cannot_remove_done'
    );
  }
  if (target.task.evidence !== undefined) {
    throw new OrgTaskEditError(
      `Cannot remove task '${target.task.id}': tasks with existing 验收结果/Evidence are protected from removal.`,
      'cannot_remove_with_evidence'
    );
  }
  const referrers = doc.tasks
    .filter((entry) => entry.task.id !== target.task.id && entry.task.dependencies.includes(target.task.id))
    .map((entry) => entry.task.id);
  if (referrers.length > 0) {
    throw new OrgTaskEditError(
      `Cannot remove task '${target.task.id}' because it is referenced in DEPENDS_ON by: ${referrers.join(', ')}.`,
      'cannot_remove_referenced',
      { fix: `Update DEPENDS_ON on ${referrers.join(', ')} before removing '${target.task.id}'.` }
    );
  }

  const nextLines = replaceLineSpan(doc.lines, target.startLine, target.endLine, []);
  const groupLabel = target.groupPath.length ? target.groupPath.join('/') : '/';
  return {
    nextLines,
    summary: `Remove task '${target.task.id}' (${target.task.title}) from group '${groupLabel}' at line ${target.task.line}`,
    details: {
      taskId: target.task.id,
      group: groupLabel,
      line: target.task.line,
    },
  };
}

function applyReorder(
  doc: OrgTasksDocument,
  mutation: ReorderOrgTasksMutation
): { nextLines: OrgLine[]; summary: string; details: Record<string, unknown> } {
  if (mutation.taskIds.length < 2) {
    throw new OrgTaskEditError(
      'task reorder requires at least two task IDs.',
      'insufficient_tasks'
    );
  }
  const seen = new Set<string>();
  for (const id of mutation.taskIds) {
    if (seen.has(id)) {
      throw new OrgTaskEditError(
        `Duplicate task ID '${id}' in reorder list.`,
        'duplicate_reorder_id'
      );
    }
    seen.add(id);
  }

  const requestedTasks = mutation.taskIds.map((id) => findTask(doc, id));
  const groupKey = requestedTasks[0].parentGroupStartLine;
  const groupLabel = requestedTasks[0].groupPath.length ? requestedTasks[0].groupPath.join('/') : '/';
  for (const entry of requestedTasks.slice(1)) {
    if (entry.parentGroupStartLine !== groupKey) {
      const otherLabel = entry.groupPath.length ? entry.groupPath.join('/') : '/';
      throw new OrgTaskEditError(
        `All reordered tasks must share the same direct parent group ('${requestedTasks[0].task.id}' is in '${groupLabel}', but '${entry.task.id}' is in '${otherLabel}').`,
        'cross_group_reorder',
        { fix: 'Use "openspec task move" to move tasks across groups.' }
      );
    }
  }

  const beforeGroupOrder = doc.tasks
    .filter((entry) => entry.parentGroupStartLine === groupKey)
    .map((entry) => entry.task.id);

  // Slots in current document order; unselected sibling tasks remain untouched.
  const slots = [...requestedTasks].sort((a, b) => a.startLine - b.startLine);
  const slicesByRequestedOrder = requestedTasks.map((entry) =>
    doc.lines.slice(entry.startLine, entry.endLine)
  );

  // Apply slot replacements from bottom to top so earlier line indices never shift.
  let nextLines = [...doc.lines];
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i];
    nextLines = replaceLineSpan(nextLines, slot.startLine, slot.endLine, slicesByRequestedOrder[i]);
  }

  const selectedSet = new Set(mutation.taskIds);
  let cursor = 0;
  const afterGroupOrder = beforeGroupOrder.map((id) =>
    selectedSet.has(id) ? mutation.taskIds[cursor++] : id
  );

  return {
    nextLines,
    summary: `Reorder tasks in '${groupLabel}': [${beforeGroupOrder.join(', ')}] -> [${afterGroupOrder.join(', ')}]`,
    details: {
      group: groupLabel,
      beforeOrder: beforeGroupOrder,
      afterOrder: afterGroupOrder,
    },
  };
}

function shiftTaskSliceStarLevels(
  doc: OrgTasksDocument,
  task: OrgTaskStructure,
  targetLevel: number
): OrgLine[] {
  const delta = targetLevel - task.level;
  const headingLineIndices = new Set([
    task.headingLine,
    ...task.subheadings.map((sub) => sub.line),
  ]);
  const shifted: OrgLine[] = [];
  for (let lineIdx = task.startLine; lineIdx < task.endLine; lineIdx++) {
    const line = doc.lines[lineIdx];
    if (delta !== 0 && headingLineIndices.has(lineIdx)) {
      const starsMatch = /^(\*+)(.*)$/.exec(line.text);
      if (starsMatch) {
        const nextStars = '*'.repeat(starsMatch[1].length + delta);
        shifted.push(makeLine(`${nextStars}${starsMatch[2]}`, line.eol));
        continue;
      }
    }
    shifted.push(line);
  }
  return shifted;
}

function applyMove(
  doc: OrgTasksDocument,
  mutation: MoveOrgTaskMutation
): { nextLines: OrgLine[]; summary: string; details: Record<string, unknown> } {
  const sourceTask = findTask(doc, mutation.taskId);
  const anchorId = mutation.before ?? mutation.after;
  if (anchorId === sourceTask.task.id) {
    throw new OrgTaskEditError(
      `Cannot move task '${sourceTask.task.id}' relative to itself.`,
      'self_anchor'
    );
  }

  const placement = resolvePlacement(doc, mutation);
  const shiftedSlice = shiftTaskSliceStarLevels(doc, sourceTask, placement.targetLevel);
  const removedCount = sourceTask.endLine - sourceTask.startLine;
  const withoutSource = replaceLineSpan(doc.lines, sourceTask.startLine, sourceTask.endLine, []);
  const adjustedInsertAt =
    placement.insertAt >= sourceTask.endLine
      ? placement.insertAt - removedCount
      : placement.insertAt;
  const nextLines = replaceLineSpan(withoutSource, adjustedInsertAt, adjustedInsertAt, shiftedSlice);

  const fromGroup = sourceTask.groupPath.length ? sourceTask.groupPath.join('/') : '/';
  return {
    nextLines,
    summary: `Move task '${sourceTask.task.id}' from '${fromGroup}' (level ${sourceTask.level}) to '${placement.targetGroupLabel}' (level ${placement.targetLevel})`,
    details: {
      taskId: sourceTask.task.id,
      fromGroup,
      toGroup: placement.targetGroupLabel,
      fromLevel: sourceTask.level,
      toLevel: placement.targetLevel,
    },
  };
}

function applySplit(
  doc: OrgTasksDocument,
  mutation: SplitOrgTaskMutation
): { nextLines: OrgLine[]; summary: string; details: Record<string, unknown> } {
  const sourceTask = findTask(doc, mutation.taskId);
  if (sourceTask.task.state === 'DONE') {
    throw new OrgTaskEditError(
      `Cannot split task '${sourceTask.task.id}': completed (DONE) tasks cannot be split.`,
      'cannot_split_done'
    );
  }
  if (mutation.parts.length < 2) {
    throw new OrgTaskEditError(
      'task split requires at least two replacement tasks.',
      'insufficient_split_parts'
    );
  }

  const newIds = new Set<string>();
  const otherExistingIds = new Set(
    doc.tasks.filter((entry) => entry.task.id !== sourceTask.task.id).map((entry) => entry.task.id)
  );
  for (const part of mutation.parts) {
    validateTaskIdValue(part.id);
    validateSingleLineTitle(part.title);
    if (newIds.has(part.id)) {
      throw new OrgTaskEditError(
        `Duplicate new TASK_ID '${part.id}' in split specification.`,
        'duplicate_task_id'
      );
    }
    if (otherExistingIds.has(part.id)) {
      throw new OrgTaskEditError(
        `New TASK_ID '${part.id}' conflicts with an existing task in ${doc.sourcePath}.`,
        'duplicate_task_id'
      );
    }
    for (const dep of part.dependsOn ?? []) {
      validateTaskIdValue(dep, 'DEPENDS_ON');
    }
    newIds.add(part.id);
  }

  const evidenceSection = sourceTask.sections.find((section) => section.kind === 'evidence');
  const evidenceLines = evidenceSection
    ? doc.lines.slice(evidenceSection.startLine, evidenceSection.endLine)
    : undefined;

  // Update downstream/other tasks referencing old ID (1-for-1 line updates preserve line indices).
  let workingLines = [...doc.lines];
  const updatedDownstreamIds: string[] = [];
  const allNewIds = mutation.parts.map((part) => part.id);
  const otherTasksBottomUp = doc.tasks
    .filter((entry) => entry.task.id !== sourceTask.task.id)
    .sort((a, b) => b.startLine - a.startLine);

  for (const other of otherTasksBottomUp) {
    if (!other.task.dependencies.includes(sourceTask.task.id)) continue;
    const expandedDeps: string[] = [];
    for (const dep of other.task.dependencies) {
      if (dep === sourceTask.task.id) {
        expandedDeps.push(...allNewIds);
      } else {
        expandedDeps.push(dep);
      }
    }
    const dedupedDeps = [...new Set(expandedDeps)];
    workingLines = updateDependsOnInLines(workingLines, other, dedupedDeps, doc.eol);
    updatedDownstreamIds.unshift(other.task.id);
  }

  // Re-locate sourceTask in workingLines in case any task BEFORE sourceTask changed line count
  // (though valid dependencies should only be AFTER sourceTask).
  const refreshedSource =
    parseOrgTasksDocument(
      serializeDocument(workingLines, {
        hasBom: false,
        eol: doc.eol,
        trailingNewline: doc.trailingNewline,
        wasEmpty: doc.lines.length === 0,
      }),
      doc.sourcePath
    ).tasks.find((entry) => entry.task.id === sourceTask.task.id)!;

  const replacementLines: OrgLine[] = [];
  mutation.parts.forEach((part, index) => {
    const inheritedDeps = index === 0 ? sourceTask.task.dependencies : [];
    const mergedDeps = [...new Set([...inheritedDeps, ...(part.dependsOn ?? [])])];
    replacementLines.push(
      ...buildTaskLines(refreshedSource.level, doc.eol, {
        id: part.id,
        title: part.title,
        description: part.description,
        criteria: part.criteria,
        dependsOn: mergedDeps,
        evidenceLines: index === 0 ? evidenceLines : undefined,
      })
    );
  });

  // Preserve trailing blank line separator if the original task had one.
  const trailingBlanks = trailingBlankLinesCount(
    workingLines,
    refreshedSource.startLine,
    refreshedSource.endLine
  );
  for (let i = 0; i < trailingBlanks; i++) {
    replacementLines.push(makeLine('', doc.eol));
  }

  const nextLines = replaceLineSpan(
    workingLines,
    refreshedSource.startLine,
    refreshedSource.endLine,
    replacementLines
  );

  return {
    nextLines,
    summary: `Split task '${sourceTask.task.id}' into [${allNewIds.join(', ')}]${updatedDownstreamIds.length ? ` (updated DEPENDS_ON on: ${updatedDownstreamIds.join(', ')})` : ''}`,
    details: {
      taskId: sourceTask.task.id,
      newTaskIds: allNewIds,
      updatedDependenciesOn: updatedDownstreamIds,
    },
  };
}

export function planOrgTaskMutation(
  content: string,
  sourcePath: string,
  mutation: OrgTaskMutation
): OrgTaskMutationPlan {
  const normalized = normalizeMutation(mutation);
  const snapshotHash = computeSnapshotHash(content);
  const previewHash = computePreviewHash(snapshotHash, normalized);
  const doc = parseOrgTasksDocument(content, sourcePath);

  let applied: { nextLines: OrgLine[]; summary: string; details: Record<string, unknown> };
  switch (normalized.type) {
    case 'create':
      applied = applyCreate(doc, normalized);
      break;
    case 'edit':
      applied = applyEdit(doc, normalized);
      break;
    case 'remove':
      applied = applyRemove(doc, normalized);
      break;
    case 'reorder':
      applied = applyReorder(doc, normalized);
      break;
    case 'move':
      applied = applyMove(doc, normalized);
      break;
    case 'split':
      applied = applySplit(doc, normalized);
      break;
  }

  const nextContent = serializeDocument(applied.nextLines, {
    hasBom: doc.hasBom,
    eol: doc.eol,
    trailingNewline: doc.trailingNewline,
    wasEmpty: content.replace(/^\uFEFF/, '') === '',
  });
  validateDependencyOrder(nextContent, sourcePath);

  return {
    operation: normalized.type,
    snapshotHash,
    previewHash,
    nextContent,
    summary: applied.summary,
    preview: buildDiffPreview(content, nextContent),
    details: applied.details,
  };
}

function makeOrgTaskLockError(kind: FileLockErrorKind, info: FileLockErrorInfo): OrgTaskEditError {
  if (kind === 'create-failed') {
    const code = (info.cause as NodeJS.ErrnoException | undefined)?.code ?? String(info.cause);
    return new OrgTaskEditError(
      `Cannot create Org tasks lock file ${info.lockPath} (${code}).`,
      'tasks_lock_create_failed',
      { fix: `Check permissions on ${path.dirname(info.lockPath)}.` }
    );
  }

  if (info.owner) {
    return new OrgTaskEditError(
      `Org tasks lock ${info.lockPath} is held by PID ${info.owner.pid} on ${info.owner.hostname} (created at ${info.owner.createdAt}).`,
      'tasks_lock_timeout',
      { fix: `Retry shortly; if PID ${info.owner.pid} exited unexpectedly, delete ${info.lockPath}.` }
    );
  }

  return new OrgTaskEditError(
    `Org tasks lock ${info.lockPath} is busy (timed out waiting for lock).`,
    'tasks_lock_timeout',
    { fix: `Retry shortly; if this persists, delete the stale lock file ${info.lockPath}.` }
  );
}

export async function applyOrgTaskMutation(
  sourcePath: string,
  mutation: OrgTaskMutation,
  options: ApplyOrgTaskMutationOptions = {}
): Promise<OrgTaskMutationResult> {
  const requireConfirmation = options.requireConfirmation ?? isStructuralOrgMutation(mutation.type);
  if (requireConfirmation) {
    if (!options.confirm || !options.previewHash) {
      throw new OrgTaskEditError(
        `Structural Org task mutation '${mutation.type}' requires both --confirm and a matching --preview-hash in non-interactive mode.`,
        'confirmation_required',
        { fix: 'Run with --preview first, then re-run with --confirm --preview-hash <hash>.' }
      );
    }
  }

  const lockPath = path.join(path.dirname(sourcePath), '.tasks.org.lock');
  const lock = await acquireFileLock({
    lockPath,
    timeoutMs: options.lockTimeoutMs,
    errorFor: makeOrgTaskLockError,
  });

  try {
    const currentContent = await fs.readFile(sourcePath, 'utf-8');
    const plan = planOrgTaskMutation(currentContent, sourcePath, mutation);
    if (options.previewHash !== undefined && plan.previewHash !== options.previewHash) {
      throw new OrgTaskEditError(
        `Preview hash mismatch for ${sourcePath}: the file or mutation parameters changed since preview.`,
        'preview_hash_mismatch',
        { fix: 'Re-run with --preview to inspect the current diff and obtain a fresh previewHash.' }
      );
    }

    await writeFileAtomically(sourcePath, plan.nextContent, { mode: 'preserve' });
    return { ...plan, applied: true };
  } finally {
    await releaseFileLock(lock, lockPath);
  }
}
