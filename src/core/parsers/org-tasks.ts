import { OrgDocument, type Heading } from './org-structure.js';

export interface OrgTask {
  id: string;
  title: string;
  state: 'TODO' | 'DONE';
  dependencies: string[];
  line: number;
  description: string;
  criteria: string;
  evidence?: string;
  custom: Array<{ title: string; content: string }>;
}

export type OrgTaskNext =
  | { state: 'empty' | 'all_done' }
  | { state: 'ready'; taskId: string }
  | { state: 'blocked'; taskId: string; incomplete: string[]; unknown: string[] };

export type OrgTaskSectionKind = 'description' | 'criteria' | 'evidence' | 'custom';

export interface OrgLine {
  text: string;
  eol: string;
  raw: string;
}

export interface OrgTaskSectionSpan {
  kind: OrgTaskSectionKind;
  title: string;
  level: number;
  startLine: number;
  endLine: number;
  contentStartLine: number;
}

export interface OrgPropertyEntry {
  key: string;
  value: string;
  line: number;
}

export interface OrgTaskStructure {
  task: OrgTask;
  level: number;
  groupPath: string[];
  parentGroupStartLine: number | null;
  startLine: number;
  endLine: number;
  headingLine: number;
  planningEndLine: number;
  propertyDrawer?: {
    startLine: number;
    endLine: number;
    properties: OrgPropertyEntry[];
  };
  directBodyStartLine: number;
  directBodyEndLine: number;
  sections: OrgTaskSectionSpan[];
  subheadings: Array<{ line: number; level: number; title: string }>;
}

export interface OrgGroupStructure {
  title: string;
  path: string[];
  level: number;
  startLine: number;
  endLine: number;
  directEndLine: number;
  children: OrgGroupStructure[];
}

export interface OrgTasksDocument {
  sourcePath: string;
  hasBom: boolean;
  eol: '\r\n' | '\n';
  trailingNewline: boolean;
  firstHeadingLine: number;
  lines: OrgLine[];
  groups: OrgGroupStructure[];
  tasks: OrgTaskStructure[];
}

const TASK_HEADING_PATTERN = /^(TODO|DONE)(?:[ \t]+(.+))?$/;

const SPECIAL_SECTION_ALIASES = new Map<string, Exclude<OrgTaskSectionKind, 'custom'>>([
  ['描述', 'description'],
  ['Description', 'description'],
  ['验收标准', 'criteria'],
  ['Acceptance Criteria', 'criteria'],
  ['验收结果', 'evidence'],
  ['Evidence', 'evidence'],
]);

function classifySection(title: string): OrgTaskSectionKind {
  return SPECIAL_SECTION_ALIASES.get(title) ?? 'custom';
}

function splitRawLines(withoutBom: string): {
  lines: OrgLine[];
  eol: '\r\n' | '\n';
  trailingNewline: boolean;
} {
  const parts = withoutBom.split(/(\r\n|\r|\n)/);
  let crlfCount = 0;
  let lfCount = 0;
  const allLines: OrgLine[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? '';
    const eol = parts[i + 1] ?? '';
    if (eol === '\r\n') crlfCount++;
    else if (eol === '\n') lfCount++;
    allLines.push({ text, eol, raw: text + eol });
  }
  const trailingNewline = /(?:\r\n|\r|\n)$/.test(withoutBom);
  const lines = trailingNewline ? allLines.slice(0, -1) : allLines;
  const eol: '\r\n' | '\n' = crlfCount > lfCount ? '\r\n' : '\n';
  return { lines, eol, trailingNewline };
}

function collectSubheadings(
  headings: Heading[],
  out: Array<{ line: number; level: number; title: string }>
): void {
  for (const h of headings) {
    out.push({ line: h.index, level: h.level, title: h.title });
    collectSubheadings(h.children, out);
  }
}

function assertNoNestedTasks(
  headings: Heading[],
  sourcePath: string,
  ownerTaskId: string,
  ownerLine: number
): void {
  for (const child of headings) {
    const match = TASK_HEADING_PATTERN.exec(child.title);
    if (match) {
      throw new Error(
        `${sourcePath}:${child.index + 1}: nested ${match[1]} heading inside task ${ownerTaskId} (line ${ownerLine}) is not allowed outside evidence sections`
      );
    }
    assertNoNestedTasks(child.children, sourcePath, ownerTaskId, ownerLine);
  }
}

export function parseOrgTasksDocument(content: string, sourcePath: string): OrgTasksDocument {
  const hasBom = content.startsWith('\uFEFF');
  const withoutBom = hasBom ? content.slice(1) : content;
  const doc = new OrgDocument(content);
  const { lines, eol, trailingNewline } = splitRawLines(withoutBom);
  const logicalLineCount = lines.length;
  const clampEnd = (end: number) => Math.min(end, logicalLineCount);
  const rawBody = (heading: Heading) =>
    lines
      .slice(heading.index + 1, clampEnd(heading.end))
      .map((line) => line.raw)
      .join('');

  const taskById = new Map<string, OrgTask>();
  const tasks: OrgTaskStructure[] = [];
  const groups: OrgGroupStructure[] = [];

  function visit(
    headings: Heading[],
    groupPath: string[],
    parentGroupStartLine: number | null,
    targetGroups: OrgGroupStructure[]
  ): void {
    for (const heading of headings) {
      const match = TASK_HEADING_PATTERN.exec(heading.title);
      if (!match) {
        const currentPath = [...groupPath, heading.title];
        const groupNode: OrgGroupStructure = {
          title: heading.title,
          path: currentPath,
          level: heading.level,
          startLine: heading.index,
          endLine: clampEnd(heading.end),
          directEndLine: clampEnd(heading.children[0]?.index ?? heading.end),
          children: [],
        };
        targetGroups.push(groupNode);
        visit(heading.children, currentPath, heading.index, groupNode.children);
        continue;
      }

      const taskEnd = clampEnd(heading.end);
      const directEnd = clampEnd(heading.children[0]?.index ?? heading.end);
      let start = heading.index + 1;
      while (start < directEnd && /^\s*(?:(?:CLOSED|SCHEDULED|DEADLINE):.*)?$/.test(doc.lines[start])) {
        start++;
      }
      const planningEndLine = start;
      const properties = new Map<string, string>();
      let propertyDrawer: OrgTaskStructure['propertyDrawer'];
      if (start < directEnd && /^\s*:PROPERTIES:\s*$/i.test(doc.visible[start])) {
        const drawerStart = start;
        const propEntries: OrgPropertyEntry[] = [];
        start++;
        while (start < directEnd && !/^\s*:END:\s*$/i.test(doc.visible[start])) {
          const property = /^\s*:([\w_-]+):[ \t]*(.*)$/.exec(doc.visible[start]);
          if (property) {
            const key = property[1].toUpperCase();
            const value = property[2].trim();
            properties.set(key, value);
            propEntries.push({ key, value, line: start });
          }
          start++;
        }
        if (start === directEnd) {
          throw new Error(`${sourcePath}:${heading.index + 1}: unclosed PROPERTIES drawer`);
        }
        propertyDrawer = { startLine: drawerStart, endLine: start, properties: propEntries };
        start++;
      }

      const id = properties.get('TASK_ID');
      const line = heading.index + 1;
      if (!id) throw new Error(`${sourcePath}:${line}: ${match[1]} heading is missing TASK_ID`);
      const previous = taskById.get(id);
      if (previous) {
        throw new Error(`${sourcePath}:${line}: duplicate TASK_ID ${id} (first defined at line ${previous.line})`);
      }

      const task: OrgTask = {
        id,
        title: match[2] ?? '',
        state: match[1] === 'DONE' ? 'DONE' : 'TODO',
        dependencies: [
          ...new Set(
            (properties.get('DEPENDS_ON') ?? '')
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          ),
        ],
        line,
        description: doc.lines.slice(start, directEnd).join('\n').trim(),
        criteria: '',
        custom: [],
      };

      const sections: OrgTaskSectionSpan[] = [];
      let seenCriteriaLine: number | undefined;
      let seenEvidenceLine: number | undefined;

      for (const child of heading.children) {
        const childLine = child.index + 1;
        const nestedTaskMatch = TASK_HEADING_PATTERN.exec(child.title);
        if (nestedTaskMatch) {
          throw new Error(
            `${sourcePath}:${childLine}: nested ${nestedTaskMatch[1]} heading inside task ${id} (line ${line}) is not allowed outside evidence sections`
          );
        }

        const kind = classifySection(child.title);
        if (kind !== 'evidence') {
          assertNoNestedTasks(child.children, sourcePath, id, line);
        }

        if (kind === 'criteria') {
          if (seenCriteriaLine !== undefined) {
            throw new Error(
              `${sourcePath}:${childLine}: duplicate acceptance criteria section (${child.title}) in task ${id} (first defined at line ${seenCriteriaLine})`
            );
          }
          seenCriteriaLine = childLine;
          task.criteria = rawBody(child).trim();
        } else if (kind === 'evidence') {
          if (seenEvidenceLine !== undefined) {
            throw new Error(
              `${sourcePath}:${childLine}: duplicate evidence section (${child.title}) in task ${id} (first defined at line ${seenEvidenceLine})`
            );
          }
          seenEvidenceLine = childLine;
          task.evidence = rawBody(child);
        } else if (kind === 'description') {
          task.description = [task.description, rawBody(child).trim()].filter(Boolean).join('\n\n');
        } else {
          task.custom.push({ title: child.title, content: rawBody(child) });
        }

        sections.push({
          kind,
          title: child.title,
          level: child.level,
          startLine: child.index,
          endLine: clampEnd(child.end),
          contentStartLine: child.index + 1,
        });
      }

      const subheadings: Array<{ line: number; level: number; title: string }> = [];
      collectSubheadings(heading.children, subheadings);

      taskById.set(id, task);
      tasks.push({
        task,
        level: heading.level,
        groupPath,
        parentGroupStartLine,
        startLine: heading.index,
        endLine: taskEnd,
        headingLine: heading.index,
        planningEndLine,
        ...(propertyDrawer ? { propertyDrawer } : {}),
        directBodyStartLine: start,
        directBodyEndLine: directEnd,
        sections,
        subheadings,
      });
    }
  }

  visit(doc.roots, [], null, groups);

  return {
    sourcePath,
    hasBom,
    eol,
    trailingNewline,
    firstHeadingLine: doc.roots[0]?.index ?? logicalLineCount,
    lines,
    groups,
    tasks,
  };
}

export function readOrgTasks(content: string, sourcePath: string): OrgTask[] {
  return parseOrgTasksDocument(content, sourcePath).tasks.map((entry) => entry.task);
}

export function nextOrgTask(tasks: readonly OrgTask[]): OrgTaskNext {
  if (tasks.length === 0) return { state: 'empty' };
  const candidate = tasks.find((task) => task.state === 'TODO');
  if (!candidate) return { state: 'all_done' };
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const incomplete: string[] = [];
  const unknown: string[] = [];
  for (const id of candidate.dependencies) {
    const dependency = byId.get(id);
    if (!dependency) unknown.push(id);
    else if (dependency.state !== 'DONE') incomplete.push(id);
  }
  return incomplete.length || unknown.length
    ? { state: 'blocked', taskId: candidate.id, incomplete, unknown }
    : { state: 'ready', taskId: candidate.id };
}
