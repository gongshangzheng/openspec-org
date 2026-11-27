import type { Change, Requirement, Spec } from '../schemas/index.js';
import type { DeltaPlan, RequirementBlock } from './requirement-blocks.js';

interface Heading {
  level: number;
  title: string;
  index: number;
  end: number;
  children: Heading[];
}

const operations = ['added', 'modified', 'removed', 'renamed'] as const;
const requirementName = (title: string) => /^Requirement:[ \t]*(\S.*)$/i.exec(title)?.[1];
const scenarioName = (title: string) => /^Scenario:[ \t]*(\S.*)$/i.exec(title)?.[1];

class OrgDocument {
  readonly lines: string[];
  readonly visible: string[] = [];
  readonly roots: Heading[] = [];

  constructor(content: string) {
    this.lines = content.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    const stack: Heading[] = [];
    let block: string | undefined;
    for (const [index, line] of this.lines.entries()) {
      if (block) {
        if (line.trim().toLowerCase() === `#+end_${block}`) block = undefined;
        this.visible.push('');
        continue;
      }
      const start = /^[ \t]*#\+begin_(src|example)(?:[ \t]|$)/i.exec(line);
      if (start) block = start[1].toLowerCase();
      const hidden = start || /^[ \t]*#(?:[ \t]|\+|$)/.test(line);
      this.visible.push(hidden ? '' : line);
      if (hidden) continue;
      const heading = /^(\*+)[ \t]+(\S.*)$/.exec(line);
      if (!heading) continue;
      const level = heading[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop()!.end = index;
      }
      const item = { level, index, title: heading[2].trimEnd(), end: this.lines.length, children: [] };
      (stack.length ? stack[stack.length - 1].children : this.roots).push(item);
      stack.push(item);
    }
  }

  section(name: string): Heading | undefined {
    return this.roots.find((heading) => heading.level === 1 && heading.title.toLowerCase() === name.toLowerCase());
  }

  body(heading: Heading, lines = this.visible): string {
    return lines.slice(heading.index + 1, heading.children[0]?.index ?? heading.end).join('\n').trim();
  }

  raw(heading: Heading): string {
    return this.lines.slice(heading.index, heading.end).join('\n').trimEnd();
  }

  requirements(section: Heading): OrgRequirementBlock[] {
    return section.children.flatMap((heading) => {
      const name = heading.level === 2 ? requirementName(heading.title) : undefined;
      return name ? [{ name, headerLine: this.lines[heading.index], raw: this.raw(heading), line: heading.index + 1 }] : [];
    });
  }
}

interface OrgRequirementBlock extends RequirementBlock { line: number }

export function readOrgRequirement(raw: string) {
  const doc = new OrgDocument(raw);
  const heading = doc.roots[0];
  if (!heading) throw new Error('Org requirement block must start with a heading');
  const scenarios = heading.children.flatMap((child) => {
    const name = child.level === 3 ? scenarioName(child.title) : undefined;
    const steps = doc.visible.slice(child.index + 1, child.end);
    if (!name || !steps.some((step) => step.trim())) return [];
    return [{
      name,
      line: child.index + 1,
      rawText: doc.lines.slice(child.index + 1, child.end).join('\n').trim(),
      hasTrigger: steps.some((step) => /^[ \t]*[-+][ \t]+\*(?:WHEN|GIVEN)\*[ \t]+\S/i.test(step)),
      hasOutcome: steps.some((step) => /^[ \t]*[-+][ \t]+\*THEN\*[ \t]+\S/i.test(step)),
    }];
  });
  return { text: doc.body(heading), scenarios };
}

export function orgBlockToRequirement(block: RequirementBlock): Requirement {
  const { text, scenarios } = readOrgRequirement(block.raw);
  return { name: block.name, text, scenarios: scenarios.map(({ name, rawText }) => ({ name, rawText })) };
}

export function readOrgMainSpec(content: string, name: string) {
  const doc = new OrgDocument(content);
  const purpose = doc.section('Purpose');
  const overview = purpose && doc.body(purpose);
  if (!overview) throw new Error('Spec must have a Purpose section');
  const section = doc.section('Requirements');
  if (!section) throw new Error('Spec must have a Requirements section');
  const blocks = doc.requirements(section);
  const spec: Spec = {
    name,
    overview,
    requirements: blocks.map(orgBlockToRequirement),
    metadata: { version: '1.0.0', format: 'openspec' },
  };
  return { spec, blocks, purposeLine: purpose.index + 1 };
}

export function readOrgProposal(content: string, name: string): Change {
  const doc = new OrgDocument(content);
  const whySection = doc.section('Why');
  const whatSection = doc.section('What Changes');
  const why = whySection && doc.body(whySection);
  const whatChanges = whatSection && doc.body(whatSection);
  if (!why) throw new Error('Change must have a Why section');
  if (!whatChanges) throw new Error('Change must have a What Changes section');
  return { name, why, whatChanges, deltas: [], metadata: { version: '1.0.0', format: 'openspec-change' } };
}

export function readOrgDelta(content: string): DeltaPlan & {
  added: OrgRequirementBlock[];
  modified: OrgRequirementBlock[];
  removedBlocks: OrgRequirementBlock[];
} {
  const doc = new OrgDocument(content);
  const plan: ReturnType<typeof readOrgDelta> = {
    added: [], modified: [], removed: [], removedBlocks: [], renamed: [],
    unpairedRenames: [], orphanedRequirements: [], unappliedContent: [],
    skippedHeaders: [], hasFrontmatter: false,
    sectionPresence: { added: false, modified: false, removed: false, renamed: false },
  };
  for (const section of doc.roots) {
    const operation = section.level === 1 && operations.find((key) => section.title.toLowerCase() === `${key} requirements`);
    if (!operation) {
      const orphaned = section.level === 1 ? doc.requirements(section) : [];
      const name = section.level === 2 ? requirementName(section.title) : undefined;
      if (name) plan.orphanedRequirements.push({ name, section: null, line: section.index + 1 });
      for (const block of orphaned) {
        plan.orphanedRequirements.push({ name: block.name, section: section.title, line: block.line });
      }
      continue;
    }
    plan.sectionPresence[operation] = true;
    if (operation === 'renamed') {
      let pending: { side: 'FROM'; name: string; line: number } | undefined;
      for (let index = section.index + 1; index < section.end; index++) {
        const match = /^[ \t]*[-+][ \t]+(FROM|TO):[ \t]*(\S.*)$/i.exec(doc.visible[index]);
        if (!match) continue;
        const name = match[2].trim().replace(/^([~=])(.*)\1$/, '$2').replace(/^\*\*[ \t]+Requirement:[ \t]*/i, '');
        if (match[1].toUpperCase() === 'FROM') {
          if (pending) plan.unpairedRenames.push(pending);
          pending = { side: 'FROM', name, line: index + 1 };
        } else if (pending) {
          plan.renamed.push({ from: pending.name, to: name });
          pending = undefined;
        } else {
          plan.unpairedRenames.push({ side: 'TO', name, line: index + 1 });
        }
      }
      if (pending) plan.unpairedRenames.push(pending);
      continue;
    }
    const blocks = doc.requirements(section);
    for (const child of section.children) {
      if (child.level === 2 && !requirementName(child.title)) {
        plan.skippedHeaders.push({ header: child.title, section: section.title, line: child.index + 1 });
      }
    }
    if (operation === 'removed') {
      plan.removedBlocks.push(...blocks);
      plan.removed.push(...blocks.map(({ name }) => name));
    } else {
      plan[operation].push(...blocks);
    }
  }
  return plan;
}
