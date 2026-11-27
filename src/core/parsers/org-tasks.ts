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

export function readOrgTasks(content: string, sourcePath: string): OrgTask[] {
  const doc = new OrgDocument(content);
  // The structural scanner normalizes line endings. Keep source slices for
  // evidence and custom sections so viewing them does not rewrite their text.
  const rawLines = content.replace(/^\uFEFF/, '').match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  const rawBody = (heading: Heading) => rawLines.slice(heading.index + 1, heading.end).join('');
  const tasks = new Map<string, OrgTask>();

  function visit(headings: Heading[]): void {
    for (const heading of headings) {
      const match = /^(TODO|DONE)(?:[ \t]+(.+))?$/.exec(heading.title);
      if (!match) {
        visit(heading.children);
        continue;
      }
      const directEnd = heading.children[0]?.index ?? heading.end;
      let start = heading.index + 1;
      while (start < directEnd && /^\s*(?:(?:CLOSED|SCHEDULED|DEADLINE):.*)?$/.test(doc.lines[start])) start++;
      const properties = new Map<string, string>();
      if (start < directEnd && /^\s*:PROPERTIES:\s*$/i.test(doc.visible[start])) {
        start++;
        while (start < directEnd && !/^\s*:END:\s*$/i.test(doc.visible[start])) {
          const property = /^\s*:([\w_-]+):[ \t]*(.*)$/.exec(doc.visible[start]);
          if (property) properties.set(property[1].toUpperCase(), property[2].trim());
          start++;
        }
        if (start === directEnd) throw new Error(`${sourcePath}:${heading.index + 1}: unclosed PROPERTIES drawer`);
        start++;
      }
      const id = properties.get('TASK_ID');
      const line = heading.index + 1;
      if (!id) throw new Error(`${sourcePath}:${line}: ${match[1]} heading is missing TASK_ID`);
      const previous = tasks.get(id);
      if (previous) throw new Error(`${sourcePath}:${line}: duplicate TASK_ID ${id} (first defined at line ${previous.line})`);

      const task: OrgTask = {
        id,
        title: match[2] ?? '',
        state: match[1] === 'DONE' ? 'DONE' : 'TODO',
        dependencies: [...new Set((properties.get('DEPENDS_ON') ?? '').split(',').map((value) => value.trim()).filter(Boolean))],
        line,
        description: doc.lines.slice(start, directEnd).join('\n').trim(),
        criteria: '',
        custom: [],
      };
      for (const child of heading.children) {
        switch (child.title) {
          case '描述':
            task.description = [task.description, rawBody(child).trim()].filter(Boolean).join('\n\n');
            break;
          case '验收标准': task.criteria = rawBody(child).trim(); break;
          case '验收结果': task.evidence = rawBody(child); break;
          default: task.custom.push({ title: child.title, content: rawBody(child) });
        }
      }
      tasks.set(id, task);
    }
  }

  visit(doc.roots);
  return [...tasks.values()];
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
