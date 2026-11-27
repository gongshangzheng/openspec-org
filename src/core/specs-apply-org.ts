/**
 * Native Org Specification Application Logic
 *
 * Applies Org delta specs (specs/<capability>/spec.org) to main Org specs
 * with line-slice fidelity, structural pre-checks, scenario-loss protection,
 * and whole-file unaccounted-content auditing for capability retirement.
 */

import { promises as fs } from 'fs';
import chalk from 'chalk';
import {
  OrgDocument,
  readOrgDelta,
  readOrgMainSpec,
  readOrgRequirement,
  type Heading,
} from './parsers/org-structure.js';
import {
  describeScenarioBalance,
  isUnrecognizedDeltaSection,
  type RequirementBlock,
  type ScenarioNameDiff,
} from './parsers/requirement-blocks.js';
import {
  MIN_PURPOSE_LENGTH,
  PURPOSE_PLACEHOLDER_PREFIX,
  PURPOSE_PLACEHOLDER_SUFFIX,
} from './validation/constants.js';
import { assertTrustedSpecPath, type SpecUpdate } from './specs-apply.js';

export interface OrgMainSpecStructureIssue {
  kind:
    | 'delta-header'
    | 'missing-requirements-section'
    | 'duplicate-requirements-section'
    | 'requirement-outside-requirements'
    | 'duplicate-requirement';
  line: number;
  header: string;
  message: string;
}

const ORG_DELTA_HEADER_RE = /^(ADDED|MODIFIED|REMOVED|RENAMED)[ \t]+Requirements$/i;
const ORG_REQUIREMENT_TITLE_RE = /^Requirement:[ \t]*(\S.*)$/i;
const ORG_REQUIREMENT_HEADER_RE = /^\*\*[ \t]+Requirement:[ \t]*(\S.*)$/i;
const ORG_SCENARIO_TITLE_RE = /^Scenario:[ \t]*(\S.*)$/i;
const ORG_LIST_ITEM_RE = /^([ \t]*(?:[-+]|\d+[.)])[ \t]+)/;
const ORG_BLOCK_OPEN_RE = /^[ \t]*#\+begin_(src|example)(?:[ \t]|$)/i;
const ORG_KEYWORD_OR_COMMENT_RE = /^[ \t]*#(?:[ \t]|\+[A-Za-z0-9_-]+:|$)/;

function normalizeOrgRequirementName(name: string): string {
  return name.trim();
}

function foldOrgRequirementName(name: string): string {
  return normalizeOrgRequirementName(name).toLowerCase().replace(/\s+/g, ' ');
}

function normalizeBlockRaw(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

function collectHeadings(headings: readonly Heading[]): Heading[] {
  const all: Heading[] = [];
  const visit = (list: readonly Heading[]): void => {
    for (const heading of list) {
      all.push(heading);
      visit(heading.children);
    }
  };
  visit(headings);
  return all;
}

/**
 * Inspect an existing main `spec.org` for structural defects that would
 * corrupt delta reconciliation or hide requirements.
 */
export function findOrgMainSpecStructureIssues(content: string): OrgMainSpecStructureIssue[] {
  const doc = new OrgDocument(content);
  const issues: OrgMainSpecStructureIssue[] = [];
  const allHeadings = collectHeadings(doc.roots);

  const requirementSections: Heading[] = [];
  for (const heading of allHeadings) {
    const header = doc.lines[heading.index].trim();
    if (ORG_DELTA_HEADER_RE.test(heading.title.trim())) {
      issues.push({
        kind: 'delta-header',
        line: heading.index + 1,
        header,
        message:
          `Main Org spec contains delta header "${header}". ` +
          'Delta headers are only valid inside openspec/changes/<name>/specs/<capability-path>/spec.org.',
      });
    }
    if (heading.level === 1 && heading.title.trim().toLowerCase() === 'requirements') {
      requirementSections.push(heading);
    }
  }

  for (const duplicate of requirementSections.slice(1)) {
    const header = doc.lines[duplicate.index].trim();
    issues.push({
      kind: 'duplicate-requirements-section',
      line: duplicate.index + 1,
      header,
      message:
        `Main Org spec contains duplicate "* Requirements" section (first declared on line ${requirementSections[0].index + 1}).`,
    });
  }

  const primaryReqSection = requirementSections[0];
  if (!primaryReqSection) {
    issues.push({
      kind: 'missing-requirements-section',
      line: 1,
      header: '',
      message: 'Main Org spec is missing a "* Requirements" section.',
    });
  }

  const primaryChildren = new Set(primaryReqSection?.children ?? []);
  const seenRequirements = new Map<string, number>();

  for (const heading of allHeadings) {
    const reqMatch = ORG_REQUIREMENT_TITLE_RE.exec(heading.title);
    if (!reqMatch) continue;
    const header = doc.lines[heading.index].trim();
    const insidePrimaryRequirements =
      heading.level === 2 && primaryChildren.has(heading);

    if (!insidePrimaryRequirements) {
      issues.push({
        kind: 'requirement-outside-requirements',
        line: heading.index + 1,
        header,
        message:
          `Requirement header "${header}" appears outside the main "* Requirements" section.`,
      });
      continue;
    }

    const name = normalizeOrgRequirementName(reqMatch[1]);
    const previousLine = seenRequirements.get(name);
    if (previousLine !== undefined) {
      issues.push({
        kind: 'duplicate-requirement',
        line: heading.index + 1,
        header,
        message:
          `Requirement header "${header}" duplicates the requirement declared on line ${previousLine}.`,
      });
    } else {
      seenRequirements.set(name, heading.index + 1);
    }
  }

  return issues;
}

function diffOrgScenarioNames(
  currentNames: readonly string[],
  incomingNames: readonly string[]
): ScenarioNameDiff {
  const unmatched = (names: readonly string[], against: readonly string[]): string[] => {
    const remaining = new Map<string, number>();
    for (const name of against) remaining.set(name, (remaining.get(name) ?? 0) + 1);

    const out: string[] = [];
    for (const name of names) {
      const left = remaining.get(name) ?? 0;
      if (left > 0) remaining.set(name, left - 1);
      else out.push(name);
    }
    return out;
  };

  return {
    missing: unmatched(currentNames, incomingNames),
    added: unmatched(incomingNames, currentNames),
    currentCount: currentNames.length,
    incomingCount: incomingNames.length,
  };
}

function extractOrgPurposeSection(content: string): string | undefined {
  const doc = new OrgDocument(content);
  const purpose = doc.section('Purpose');
  if (!purpose) return undefined;
  const visibleBody = doc.body(purpose);
  if (!visibleBody) return undefined;
  const rawBody = doc.lines
    .slice(purpose.index + 1, purpose.children[0]?.index ?? purpose.end)
    .join('\n')
    .trim();
  return rawBody || undefined;
}

export function buildOrgSpecSkeleton(
  specFolderName: string,
  changeName: string,
  purpose?: string
): string {
  const purposeBody =
    purpose?.trim() ||
    `${PURPOSE_PLACEHOLDER_PREFIX}${changeName}${PURPOSE_PLACEHOLDER_SUFFIX}`;
  return `#+TITLE: ${specFolderName} Specification\n\n* Purpose\n\n${purposeBody}\n\n* Requirements\n`;
}

function readableOrgOverview(skeleton: string, specName: string): string | null {
  if (findOrgMainSpecStructureIssues(skeleton).length > 0) return null;
  try {
    return readOrgMainSpec(skeleton, specName).spec.overview.trim() || null;
  } catch {
    return null;
  }
}

function contentColumn(prefix: string): number {
  let column = 0;
  for (const char of prefix) column += char === '\t' ? 4 - (column % 4) : 1;
  return column;
}

/**
 * Compute a per-line mask of lines inside `#+BEGIN_SRC` / `#+BEGIN_EXAMPLE`
 * blocks (including their `#+BEGIN_*` and `#+END_*` delimiters).
 */
function buildOrgBlockMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let activeBlock: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (activeBlock) {
      mask[i] = true;
      if (line.trim().toLowerCase() === `#+end_${activeBlock}`) {
        activeBlock = undefined;
      }
      continue;
    }
    const start = ORG_BLOCK_OPEN_RE.exec(line);
    if (start) {
      activeBlock = start[1].toLowerCase();
      mask[i] = true;
    }
  }
  return mask;
}

function auditOrgRequirementBlock(
  doc: OrgDocument,
  reqHeading: Heading,
  leftovers: string[]
): void {
  const blockLines = doc.lines.slice(reqHeading.index, reqHeading.end);
  const blockMask = buildOrgBlockMask(blockLines);

  // Anything before the first child heading (at level >= 3) is the requirement statement.
  const firstChildRel = reqHeading.children[0]
    ? reqHeading.children[0].index - reqHeading.index
    : blockLines.length;

  for (let i = 1; i < firstChildRel; i++) {
    // Statement prose, lists, and code/example blocks before the first scenario are expected.
    if (blockMask[i] || !blockLines[i].trim()) continue;
  }

  for (const child of reqHeading.children) {
    const childHeader = doc.lines[child.index].trim();
    const isScenario = child.level === 3 && ORG_SCENARIO_TITLE_RE.test(child.title);
    if (!isScenario || child.children.length > 0) {
      // Non-Scenario level-3 heading or nested subheadings inside a requirement
      // would be deleted silently upon retirement.
      if (!isScenario) {
        for (let lineIdx = child.index; lineIdx < child.end; lineIdx++) {
          const text = doc.lines[lineIdx].trim();
          if (text) leftovers.push(text);
        }
        continue;
      }
      // Deeper nested headings under a scenario are unaccounted.
      for (const nested of child.children) {
        for (let lineIdx = nested.index; lineIdx < nested.end; lineIdx++) {
          const text = doc.lines[lineIdx].trim();
          if (text) leftovers.push(text);
        }
      }
    }

    const bodyEnd = child.children[0]?.index ?? child.end;
    let inScenarioBullets = true;
    let bulletsSeen = false;
    let listContentIndent: number | null = null;
    let paragraphOpen = false;

    for (let lineIdx = child.index + 1; lineIdx < bodyEnd; lineIdx++) {
      const rel = lineIdx - reqHeading.index;
      const line = doc.lines[lineIdx];
      if (!line.trim()) {
        if (bulletsSeen) inScenarioBullets = false;
        listContentIndent = null;
        paragraphOpen = false;
        continue;
      }
      if (blockMask[rel]) {
        const indent = contentColumn(/^[ \t]*/.exec(line)![0]);
        if (listContentIndent !== null && indent < listContentIndent) {
          listContentIndent = null;
        }
        paragraphOpen = false;
        continue;
      }

      const indent = contentColumn(/^[ \t]*/.exec(line)![0]);
      const insideItem = listContentIndent !== null && indent >= listContentIndent;
      const lazilyContinuesBullet = paragraphOpen && inScenarioBullets && !ORG_LIST_ITEM_RE.test(line);

      if (insideItem || lazilyContinuesBullet) {
        paragraphOpen = !ORG_LIST_ITEM_RE.test(line);
        continue;
      }

      const bullet = ORG_LIST_ITEM_RE.exec(line);
      if (bullet && inScenarioBullets) {
        bulletsSeen = true;
        listContentIndent = contentColumn(bullet[1]);
        paragraphOpen = true;
        continue;
      }

      listContentIndent = null;
      paragraphOpen = false;
      leftovers.push(line.trim());
    }
  }
}

/**
 * Whole-file audit of an Org main spec before capability retirement.
 * Every non-blank line must belong to top-of-file Org keywords/comments,
 * `* Purpose`, `* Requirements`, or canonical `** Requirement:` blocks.
 */
function findOrgUnaccountedContent(content: string): string[] {
  const doc = new OrgDocument(content);
  const leftovers: string[] = [];

  const firstRootIndex = doc.roots[0]?.index ?? doc.lines.length;
  for (let i = 0; i < firstRootIndex; i++) {
    const line = doc.lines[i];
    if (!line.trim()) continue;
    if (ORG_KEYWORD_OR_COMMENT_RE.test(line)) continue;
    leftovers.push(line.trim());
  }

  for (const root of doc.roots) {
    if (root.level === 1 && root.title.trim().toLowerCase() === 'purpose') {
      // Child headings under * Purpose are not part of the Purpose overview.
      for (const child of root.children) {
        for (let i = child.index; i < child.end; i++) {
          const text = doc.lines[i].trim();
          if (text) leftovers.push(text);
        }
      }
      continue;
    }

    if (root.level === 1 && root.title.trim().toLowerCase() === 'requirements') {
      const firstChildIndex = root.children[0]?.index ?? root.end;
      for (let i = root.index + 1; i < firstChildIndex; i++) {
        const text = doc.lines[i].trim();
        if (text) leftovers.push(text);
      }

      for (const child of root.children) {
        const isReq = child.level === 2 && ORG_REQUIREMENT_TITLE_RE.test(child.title);
        if (!isReq) {
          for (let i = child.index; i < child.end; i++) {
            const text = doc.lines[i].trim();
            if (text) leftovers.push(text);
          }
          continue;
        }
        auditOrgRequirementBlock(doc, child, leftovers);
      }
      continue;
    }

    // Any other top-level heading (e.g. * Notes) or orphan level-2 heading.
    for (let i = root.index; i < root.end; i++) {
      const text = doc.lines[i].trim();
      if (text) leftovers.push(text);
    }
  }

  return [...new Set(leftovers)];
}

function splitContentAndTrailingBlanks(sliceLines: readonly string[]): {
  contentLines: string[];
  trailingBlanks: string[];
} {
  let end = sliceLines.length;
  while (end > 0 && sliceLines[end - 1].trim() === '') {
    end--;
  }
  return {
    contentLines: sliceLines.slice(0, end),
    trailingBlanks: sliceLines.slice(end),
  };
}

interface RequirementSlot {
  kind: 'req';
  key: string;
  name: string;
  rawLines: string[];
  trailingBlanks: string[];
  removed: boolean;
  added: boolean;
}

interface OtherSlot {
  kind: 'other';
  rawLines: string[];
  trailingBlanks: string[];
}

type SectionSlot = RequirementSlot | OtherSlot;

/**
 * Build an updated Org spec by applying Org delta operations with line-slice fidelity.
 */
export async function buildUpdatedOrgSpec(
  update: SpecUpdate,
  changeName: string,
  options: { silent?: boolean } = {}
): Promise<{
  rebuilt: string;
  counts: { added: number; modified: number; removed: number; renamed: number };
  warnings: string[];
  noRequirementBlocks: boolean;
  unaccountedContent: string[];
}> {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    if (!options.silent) {
      console.log(chalk.yellow(`⚠️  Warning: ${message}`));
    }
  };

  assertTrustedSpecPath(update.sourceRoot, update.source);
  const changeContent = await fs.readFile(update.source, 'utf-8');
  const plan = readOrgDelta(changeContent);
  const specName = update.id;

  if (plan.unpairedRenames.length > 0) {
    const first = plan.unpairedRenames[0];
    const missing = first.side === 'FROM' ? 'TO' : 'FROM';
    throw new Error(
      `${specName} validation failed - RENAMED entry on line ${first.line} has no matching ${missing}: ` +
        `for header "** Requirement: ${first.name}". ` +
        `Write each rename as a FROM: line followed immediately by its TO: line.`
    );
  }

  const misplaced = plan.orphanedRequirements.find((o) => isUnrecognizedDeltaSection(o.section));
  if (misplaced) {
    throw new Error(
      `${specName} validation failed - requirement "${misplaced.name}" (line ${misplaced.line}) is under ` +
        `"* ${misplaced.section}", which is not a delta section, so it would not be applied. ` +
        `Move it under ADDED/MODIFIED/REMOVED/RENAMED Requirements.`
    );
  }
  for (const orphan of plan.orphanedRequirements) {
    const where = orphan.section
      ? `under "* ${orphan.section}"`
      : 'above the first "* " section';
    warn(
      `${specName} - requirement "${orphan.name}" (line ${orphan.line}) is ${where}, ` +
        `which is not a delta section, so it was not applied. ` +
        `Move it under ADDED/MODIFIED/REMOVED/RENAMED Requirements.`
    );
  }

  // Pre-validate duplicates within sections
  const addedNames = new Set<string>();
  for (const add of plan.added) {
    const name = normalizeOrgRequirementName(add.name);
    if (addedNames.has(name)) {
      throw new Error(
        `${specName} validation failed - duplicate requirement in ADDED for header "** Requirement: ${add.name}"`
      );
    }
    addedNames.add(name);
  }

  const modifiedNames = new Set<string>();
  for (const mod of plan.modified) {
    const name = normalizeOrgRequirementName(mod.name);
    if (modifiedNames.has(name)) {
      throw new Error(
        `${specName} validation failed - duplicate requirement in MODIFIED for header "** Requirement: ${mod.name}"`
      );
    }
    modifiedNames.add(name);
  }

  const removedNamesSet = new Set<string>();
  for (const rem of plan.removed) {
    const name = normalizeOrgRequirementName(rem);
    if (removedNamesSet.has(name)) {
      throw new Error(
        `${specName} validation failed - duplicate requirement in REMOVED for header "** Requirement: ${rem}"`
      );
    }
    removedNamesSet.add(name);
  }

  const renamedFromSet = new Set<string>();
  const renamedToSet = new Set<string>();
  for (const { from, to } of plan.renamed) {
    const fromNorm = normalizeOrgRequirementName(from);
    const toNorm = normalizeOrgRequirementName(to);
    if (renamedFromSet.has(fromNorm)) {
      throw new Error(
        `${specName} validation failed - duplicate FROM in RENAMED for header "** Requirement: ${from}"`
      );
    }
    if (renamedToSet.has(toNorm)) {
      throw new Error(
        `${specName} validation failed - duplicate TO in RENAMED for header "** Requirement: ${to}"`
      );
    }
    renamedFromSet.add(fromNorm);
    renamedToSet.add(toNorm);
  }

  // Pre-validate cross-section conflicts
  const conflicts: Array<{ name: string; a: string; b: string }> = [];
  for (const n of modifiedNames) {
    if (removedNamesSet.has(n)) conflicts.push({ name: n, a: 'MODIFIED', b: 'REMOVED' });
    if (addedNames.has(n)) conflicts.push({ name: n, a: 'MODIFIED', b: 'ADDED' });
  }
  for (const n of addedNames) {
    if (removedNamesSet.has(n)) conflicts.push({ name: n, a: 'ADDED', b: 'REMOVED' });
  }

  for (const { from, to } of plan.renamed) {
    const fromNorm = normalizeOrgRequirementName(from);
    const toNorm = normalizeOrgRequirementName(to);
    const removedFoldMatch = [...removedNamesSet].find(
      (r) => foldOrgRequirementName(r) === foldOrgRequirementName(fromNorm)
    );
    if (removedFoldMatch !== undefined) {
      throw new Error(
        `${specName} validation failed - requirement present in multiple sections (RENAMED and REMOVED) for header "** Requirement: ${from}"` +
          (removedFoldMatch === fromNorm ? '' : ` (REMOVED spells it "${removedFoldMatch}")`)
      );
    }
    if (modifiedNames.has(fromNorm)) {
      throw new Error(
        `${specName} validation failed - when a rename exists, MODIFIED must reference the NEW header "** Requirement: ${to}"`
      );
    }
    if (addedNames.has(toNorm)) {
      throw new Error(
        `${specName} validation failed - RENAMED TO header collides with ADDED for "** Requirement: ${to}"`
      );
    }
  }
  if (conflicts.length > 0) {
    const c = conflicts[0];
    throw new Error(
      `${specName} validation failed - requirement present in multiple sections (${c.a} and ${c.b}) for header "** Requirement: ${c.name}"`
    );
  }

  const hasAnyDelta =
    plan.added.length + plan.modified.length + plan.removed.length + plan.renamed.length > 0;
  if (!hasAnyDelta) {
    throw new Error(
      `Delta parsing found no operations for ${update.id}. ` +
        `Provide ADDED/MODIFIED/REMOVED/RENAMED sections in change spec.`
    );
  }

  // Load or create base target content
  const deltaPurpose = extractOrgPurposeSection(changeContent);
  let targetContent: string;
  let isNewSpec = false;
  assertTrustedSpecPath(update.targetRoot, update.target);
  try {
    targetContent = await fs.readFile(update.target, 'utf-8');
    if (deltaPurpose) {
      const existingPurpose = extractOrgPurposeSection(targetContent);
      if (existingPurpose && existingPurpose !== deltaPurpose) {
        warn(
          `${specName} - delta Purpose ignored; ${specName} already has one. ` +
            `Edit ${update.target} directly to change it.`
        );
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    if (plan.modified.length > 0 || plan.renamed.length > 0) {
      throw new Error(
        `${specName}: target spec does not exist; only ADDED requirements are allowed for new specs. MODIFIED and RENAMED operations require an existing spec.`
      );
    }
    if (plan.removed.length > 0) {
      warn(
        `${specName} - ${plan.removed.length} REMOVED requirement(s) ignored for new spec (nothing to remove).`
      );
    }
    isNewSpec = true;
    targetContent = buildOrgSpecSkeleton(specName, changeName, deltaPurpose);
    const overview = deltaPurpose ? readableOrgOverview(targetContent, specName) : null;
    if (deltaPurpose && !overview) {
      targetContent = buildOrgSpecSkeleton(specName, changeName);
      warn(
        `${specName} - delta Purpose ignored (it would leave the new spec unreadable); wrote the placeholder Purpose instead.`
      );
    } else if (overview && overview.length < MIN_PURPOSE_LENGTH) {
      warn(
        `${specName} - carried Purpose is under ${MIN_PURPOSE_LENGTH} characters; ` +
          `openspec validate --strict reports it as too brief.`
      );
    }
  }

  const structureIssues = findOrgMainSpecStructureIssues(targetContent);
  if (structureIssues.length > 0) {
    const details = structureIssues
      .map((issue) => `line ${issue.line}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `${specName}: target spec is structurally invalid and cannot be updated until fixed:\n${details}`
    );
  }

  const doc = new OrgDocument(targetContent);
  const requirementsSection = doc.section('Requirements')!;
  const beforeLines = doc.lines.slice(0, requirementsSection.index);
  const reqHeaderLine = doc.lines[requirementsSection.index];
  const firstChildIndex = requirementsSection.children[0]?.index ?? requirementsSection.end;
  const preambleLines = doc.lines.slice(requirementsSection.index + 1, firstChildIndex);
  const afterLines = doc.lines.slice(requirementsSection.end);

  const originalSlots: SectionSlot[] = [];
  const nameToSlot = new Map<string, RequirementSlot>();

  for (const child of requirementsSection.children) {
    const slice = doc.lines.slice(child.index, child.end);
    const { contentLines, trailingBlanks } = splitContentAndTrailingBlanks(slice);
    const reqMatch = child.level === 2 ? ORG_REQUIREMENT_TITLE_RE.exec(child.title) : null;
    if (reqMatch) {
      const key = normalizeOrgRequirementName(reqMatch[1]);
      const slot: RequirementSlot = {
        kind: 'req',
        key,
        name: key,
        rawLines: contentLines,
        trailingBlanks,
        removed: false,
        added: false,
      };
      originalSlots.push(slot);
      nameToSlot.set(key, slot);
    } else {
      originalSlots.push({
        kind: 'other',
        rawLines: contentLines,
        trailingBlanks,
      });
    }
  }

  // RENAMED
  let renamedApplied = 0;
  for (const r of plan.renamed) {
    const from = normalizeOrgRequirementName(r.from);
    const to = normalizeOrgRequirementName(r.to);
    const slot = nameToSlot.get(from);
    if (!slot) {
      if (nameToSlot.has(to)) {
        const nearMiss = [...nameToSlot.keys()].find(
          (k) => k !== to && foldOrgRequirementName(k) === foldOrgRequirementName(from)
        );
        if (nearMiss !== undefined) {
          throw new Error(
            `${specName} RENAMED failed for header "** Requirement: ${r.from}" - source not found, but "** Requirement: ${nameToSlot.get(nearMiss)!.name}" exists; fix the header to match it exactly`
          );
        }
        continue;
      }
      throw new Error(
        `${specName} RENAMED failed for header "** Requirement: ${r.from}" - source not found`
      );
    }
    if (nameToSlot.has(to)) {
      throw new Error(
        `${specName} RENAMED failed for header "** Requirement: ${r.to}" - target already exists`
      );
    }
    const targetNearMiss = [...nameToSlot.keys()].find(
      (k) => k !== from && foldOrgRequirementName(k) === foldOrgRequirementName(to)
    );
    if (targetNearMiss !== undefined) {
      throw new Error(
        `${specName} RENAMED failed for header "** Requirement: ${r.to}" - "** Requirement: ${nameToSlot.get(targetNearMiss)!.name}" already exists and differs only in case or spacing; choose a distinct name`
      );
    }

    slot.rawLines = [`** Requirement: ${to}`, ...slot.rawLines.slice(1)];
    slot.name = to;
    slot.key = to;
    nameToSlot.delete(from);
    nameToSlot.set(to, slot);
    renamedApplied++;
  }

  // REMOVED
  let removedApplied = 0;
  for (const name of plan.removed) {
    const key = normalizeOrgRequirementName(name);
    const slot = nameToSlot.get(key);
    if (!slot) {
      if (!isNewSpec) {
        const nearMiss = [...nameToSlot.keys()].find(
          (k) => foldOrgRequirementName(k) === foldOrgRequirementName(key)
        );
        if (nearMiss !== undefined) {
          throw new Error(
            `${specName} REMOVED failed for header "** Requirement: ${name}" - not found, but "** Requirement: ${nameToSlot.get(nearMiss)!.name}" exists; fix the header to match it exactly`
          );
        }
        warn(
          `${specName} - REMOVED requirement "${name}" is not in the current spec; treating it as already removed.`
        );
      }
      continue;
    }
    slot.removed = true;
    nameToSlot.delete(key);
    removedApplied++;
  }

  // MODIFIED
  let modifiedApplied = 0;
  for (const mod of plan.modified) {
    const key = normalizeOrgRequirementName(mod.name);
    const slot = nameToSlot.get(key);
    if (!slot) {
      throw new Error(
        `${specName} MODIFIED failed for header "** Requirement: ${mod.name}" - not found`
      );
    }
    const modLines = mod.raw.replace(/\r\n?/g, '\n').trimEnd().split('\n');
    const modHeaderMatch = ORG_REQUIREMENT_HEADER_RE.exec(modLines[0]);
    if (!modHeaderMatch || normalizeOrgRequirementName(modHeaderMatch[1]) !== key) {
      throw new Error(
        `${specName} MODIFIED failed for header "** Requirement: ${mod.name}" - header mismatch in content`
      );
    }

    const currentScenarios = readOrgRequirement(slot.rawLines.join('\n')).scenarios.map((s) => s.name);
    const incomingScenarios = readOrgRequirement(mod.raw).scenarios.map((s) => s.name);
    const scenarioDiff = diffOrgScenarioNames(currentScenarios, incomingScenarios);
    if (scenarioDiff.missing.length > 0) {
      throw new Error(
        `${specName} MODIFIED failed for header "** Requirement: ${mod.name}" - current spec contains scenario(s) not present in the modified block: ${scenarioDiff.missing.map((n) => `"${n}"`).join(', ')}. ${describeScenarioBalance(scenarioDiff)} Refresh the change spec before syncing to avoid dropping scenarios.`
      );
    }

    if (normalizeBlockRaw(slot.rawLines.join('\n')) !== normalizeBlockRaw(modLines.join('\n'))) {
      modifiedApplied++;
      slot.rawLines = modLines;
    }
  }

  // ADDED
  let addedApplied = 0;
  const addedSlots: RequirementSlot[] = [];
  for (const add of plan.added) {
    const key = normalizeOrgRequirementName(add.name);
    const existing = nameToSlot.get(key);
    if (existing) {
      if (normalizeBlockRaw(existing.rawLines.join('\n')) === normalizeBlockRaw(add.raw)) {
        continue;
      }
      throw new Error(
        `${specName} ADDED failed for header "** Requirement: ${add.name}" - already exists`
      );
    }
    const nearMiss = [...nameToSlot.keys()].find(
      (k) => foldOrgRequirementName(k) === foldOrgRequirementName(key)
    );
    if (nearMiss !== undefined) {
      throw new Error(
        `${specName} ADDED failed for header "** Requirement: ${add.name}" - "** Requirement: ${nameToSlot.get(nearMiss)!.name}" already exists and differs only in case or spacing; use MODIFIED with that exact header to change it, or choose a distinct name`
      );
    }

    const addLines = add.raw.replace(/\r\n?/g, '\n').trimEnd().split('\n');
    const slot: RequirementSlot = {
      kind: 'req',
      key,
      name: key,
      rawLines: addLines,
      trailingBlanks: [],
      removed: false,
      added: true,
    };
    nameToSlot.set(key, slot);
    addedSlots.push(slot);
    addedApplied++;
  }

  // Reassemble preserving slices outside and inside * Requirements
  const activeOriginalSlots = originalSlots.filter(
    (slot) => slot.kind === 'other' || !slot.removed
  );
  const activeSlots: SectionSlot[] = [...activeOriginalSlots, ...addedSlots];
  const hasAfter = afterLines.length > 0;

  const outLines: string[] = [...beforeLines, reqHeaderLine];
  if (activeSlots.length === 0) {
    if (hasAfter) {
      outLines.push(...preambleLines, ...afterLines);
    } else {
      const { contentLines } = splitContentAndTrailingBlanks(preambleLines);
      outLines.push(...contentLines);
    }
  } else {
    outLines.push(...preambleLines);
    for (let i = 0; i < activeSlots.length; i++) {
      const slot = activeSlots[i];
      const isLast = i === activeSlots.length - 1;
      const nextIsAdded = !isLast && activeSlots[i + 1].kind === 'req' && (activeSlots[i + 1] as RequirementSlot).added;
      outLines.push(...slot.rawLines);

      if (!isLast) {
        if (slot.trailingBlanks.length > 0) {
          outLines.push(...slot.trailingBlanks);
        } else if (nextIsAdded || (slot.kind === 'req' && slot.added)) {
          outLines.push('');
        }
      } else if (hasAfter) {
        if (slot.trailingBlanks.length > 0) {
          outLines.push(...slot.trailingBlanks);
        } else {
          outLines.push('');
        }
      }
    }
    if (hasAfter) {
      outLines.push(...afterLines);
    }
  }

  // Normalize final EOF to a single trailing newline while preserving internal slices verbatim
  while (outLines.length > 0 && outLines[outLines.length - 1] === '') {
    outLines.pop();
  }
  const rebuilt = `${outLines.join('\n')}\n`;

  const remainingReqCount = activeSlots.filter((slot) => slot.kind === 'req').length;

  return {
    rebuilt,
    counts: {
      added: addedApplied,
      modified: modifiedApplied,
      removed: removedApplied,
      renamed: renamedApplied,
    },
    warnings,
    noRequirementBlocks: remainingReqCount === 0,
    unaccountedContent: findOrgUnaccountedContent(targetContent),
  };
}
