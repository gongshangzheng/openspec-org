import { promises as fs } from 'fs';
import path from 'path';
import chalk from 'chalk';
import {
  assertCompatibleSpecFormat,
  buildUpdatedSpec,
  findSpecUpdates,
  retireSpec,
  writeUpdatedSpec,
  type SpecFormat,
  type SpecUpdate,
} from '../core/specs-apply.js';
import {
  isStoreSelectedRoot,
  resolveRootForCommand,
  toRootOutput,
  withStoreFlag,
} from '../core/root-selection.js';
import { Validator } from '../core/validation/validator.js';
import { VALIDATION_MESSAGES } from '../core/validation/constants.js';
import {
  METADATA_FILENAME,
  readRetireCapabilitiesMarker,
  readSkipSpecsMarker,
} from '../utils/change-metadata.js';
import { specFilenameFor } from '../utils/change-utils.js';
import {
  discoverSpecFiles,
  findUnreadDeltaFiles,
  hasAnyFileUnder,
} from '../utils/spec-discovery.js';
import { OrgDocument } from '../core/parsers/org-structure.js';
import { validateChangeExists } from './workflow/shared.js';

export interface SyncOptions {
  json?: boolean;
  store?: string;
  storePath?: string;
}

type SpecOutcome = 'write' | 'retire' | 'skip';

interface SyncSpecResult {
  id: string;
  action: 'created' | 'updated' | 'retired' | 'unchanged' | 'skipped';
  path: string;
  counts: { added: number; modified: number; removed: number; renamed: number };
  retiredPurpose?: string;
}

const UNACCOUNTED_LINE_MAX = 200;

function describeUnaccountedContent(lines: readonly string[]): string {
  const shown = lines
    .slice(0, 3)
    .map((line) => {
      const safe = [...line.replace(/[\u0000-\u001f\u007f]/g, '?')];
      const clipped = safe.slice(0, UNACCOUNTED_LINE_MAX).join('');
      return `"${safe.length > UNACCOUNTED_LINE_MAX ? `${clipped}\u2026` : clipped}"`;
    })
    .join(', ');
  const rest = lines.length > 3 ? `, and ${lines.length - 3} more line(s)` : '';
  return `${shown}${rest}`;
}

async function isRetirableSpecForFormat(
  specName: string,
  rebuilt: string,
  format: SpecFormat
): Promise<boolean> {
  const report = await new Validator().validateSpecContent(specName, rebuilt, { format });
  if (report.valid) return false;
  const errors = report.issues.filter((issue) => issue.level === 'ERROR');
  return (
    errors.length > 0 &&
    errors.every((issue) => issue.message === VALIDATION_MESSAGES.SPEC_NO_REQUIREMENTS)
  );
}

async function readPurposeTextForRetirement(
  targetPath: string,
  format: SpecFormat
): Promise<string | undefined> {
  try {
    const content = await fs.readFile(targetPath, 'utf-8');
    if (format === 'org') {
      const doc = new OrgDocument(content);
      const purpose = doc.section('Purpose');
      return purpose ? doc.body(purpose) || undefined : undefined;
    }
    const match = /^##[ \t]+Purpose[ \t]*\r?\n([\s\S]*?)(?=^##[ \t]+|\Z)/im.exec(content);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function syncCommand(
  changeName: string | undefined,
  options: SyncOptions = {}
): Promise<void> {
  const json = Boolean(options.json);
  const root = await resolveRootForCommand(options, {
    json,
    failurePayload: { change: changeName ?? null, synced: false, specs: [], root: null },
    allowImplicitRoot: false,
  });
  if (!root) {
    return;
  }

  const resolvedChangeName = await validateChangeExists(
    changeName,
    root.path,
    root.changesDir,
    { newChangeHint: withStoreFlag(root, 'openspec new change <name>') }
  );

  const changeDir = path.join(root.changesDir, resolvedChangeName);
  const changeSpecsDir = path.join(changeDir, 'specs');
  const mainSpecsDir = root.specsDir;

  // Pre-write workflow format compatibility check (no fallback, no disk write)
  const changeFormat = assertCompatibleSpecFormat(root.path, changeDir);
  const specFilename = specFilenameFor(changeFormat);
  const oppositeFormat: SpecFormat = changeFormat === 'org' ? 'markdown' : 'org';
  const oppositeFilename = specFilenameFor(oppositeFormat);

  const skipMarker = readSkipSpecsMarker(changeDir);
  if (skipMarker.invalidReason) {
    throw new Error(
      `Invalid skip_specs in ${METADATA_FILENAME}: ${skipMarker.invalidReason}`
    );
  }
  if (skipMarker.declared) {
    if (await hasAnyFileUnder(changeSpecsDir)) {
      throw new Error(VALIDATION_MESSAGES.CHANGE_SKIP_SPECS_CONFLICT);
    }
    throw new Error(
      `Change '${resolvedChangeName}' declares skip_specs: true and has no delta specs to sync.`
    );
  }

  const rootLevelDeltaStat = await fs
    .stat(path.join(changeSpecsDir, specFilename))
    .catch(() => null);
  if (rootLevelDeltaStat?.isFile()) {
    throw new Error(
      `Delta spec found at specs/${specFilename}. Delta specs must live under a capability path (e.g. specs/<capability-path>/${specFilename}).`
    );
  }

  if (changeFormat === 'markdown') {
    const unread = await findUnreadDeltaFiles(changeSpecsDir);
    if (unread.length > 0) {
      throw new Error(
        `Delta spec found at specs/${unread[0].path}. Delta specs must be named spec.md inside a capability folder (expected specs/${unread[0].expected}).`
      );
    }
  }

  const specUpdates = await findSpecUpdates(changeDir, mainSpecsDir, changeFormat);
  if (specUpdates.length === 0) {
    const oppositeDeltas = await discoverSpecFiles(changeSpecsDir, oppositeFilename);
    if (oppositeDeltas.length > 0) {
      throw new Error(
        `Cross-format spec sync rejected: change '${resolvedChangeName}' uses ${changeFormat} (${specFilename}), ` +
          `but found ${oppositeFormat} delta spec(s) (${oppositeFilename}) under ${changeSpecsDir}.`
      );
    }
    throw new Error(
      `No delta specs found for change '${resolvedChangeName}' under ${changeSpecsDir}.`
    );
  }

  const retirementMarker = readRetireCapabilitiesMarker(changeDir);
  const retirementDeclared = retirementMarker.declared;
  const validator = new Validator();
  const warnings: string[] = [];

  const prepared: Array<{
    update: SpecUpdate;
    rebuilt: string;
    counts: { added: number; modified: number; removed: number; renamed: number };
    outcome: SpecOutcome;
    retiredPurpose?: string;
  }> = [];

  for (const update of specUpdates) {
    const built = await buildUpdatedSpec(update, resolvedChangeName, {
      silent: true,
      format: changeFormat,
    });
    warnings.push(...built.warnings);

    let outcome: SpecOutcome = 'write';
    const retirable =
      built.noRequirementBlocks &&
      (await isRetirableSpecForFormat(update.id, built.rebuilt, changeFormat));

    if (retirable) {
      if (!retirementDeclared) {
        if (built.unaccountedContent.length === 0) {
          throw new Error(
            `This change removes the last requirement '${update.id}' has. To retire the capability and delete its ${specFilename}, add \`retire_capabilities: true\` to ${METADATA_FILENAME}, then rerun.` +
              (retirementMarker.invalidReason
                ? ` The marker present now cannot be honored (${retirementMarker.invalidReason}).`
                : '')
          );
        }
        throw new Error(
          `This change removes the last requirement '${update.id}' has, and retirement is refused while the spec holds unaccounted content: ${describeUnaccountedContent(built.unaccountedContent)}.` +
            (retirementMarker.invalidReason
              ? ` The marker present now cannot be honored (${retirementMarker.invalidReason}).`
              : '')
        );
      }

      if (built.unaccountedContent.length > 0) {
        throw new Error(
          `'${update.id}' declares retire_capabilities, but the spec holds content the merge cannot safely account for and deleting the file would take with it: ${describeUnaccountedContent(built.unaccountedContent)}.`
        );
      }

      if (!update.exists) {
        outcome = 'skip';
      } else if (built.counts.removed > 0) {
        outcome = 'retire';
      }
    }

    if (outcome === 'write') {
      const report = await validator.validateSpecContent(update.id, built.rebuilt, {
        format: changeFormat,
      });
      if (!report.valid) {
        const errors = report.issues
          .filter((issue) => issue.level === 'ERROR')
          .map((issue) => issue.message)
          .join('; ');
        throw new Error(
          `Validation errors in rebuilt spec for '${update.id}' (no files were changed): ${errors}`
        );
      }
    }

    const retiredPurpose =
      outcome === 'retire'
        ? await readPurposeTextForRetirement(update.target, changeFormat)
        : undefined;

    prepared.push({
      update,
      rebuilt: built.rebuilt,
      counts: built.counts,
      outcome,
      retiredPurpose,
    });
  }

  if (!json) {
    for (const warning of warnings) {
      console.log(chalk.yellow(`⚠️  Warning: ${warning}`));
    }
  }

  const totals = { added: 0, modified: 0, removed: 0, renamed: 0 };
  const results: SyncSpecResult[] = [];
  let wroteAny = false;

  for (const item of prepared) {
    const { update, rebuilt, counts, outcome, retiredPurpose } = item;
    if (outcome === 'skip') {
      results.push({
        id: update.id,
        action: 'skipped',
        path: update.target,
        counts,
      });
      continue;
    }

    if (outcome === 'retire') {
      const retired = await retireSpec(update, mainSpecsDir, {
        silent: json,
        format: changeFormat,
        ...(isStoreSelectedRoot(root) ? { displayPath: update.target } : {}),
      });
      if (retired.retired) {
        wroteAny = true;
        totals.added += counts.added;
        totals.modified += counts.modified;
        totals.removed += counts.removed;
        totals.renamed += counts.renamed;
        const purposeLabel = changeFormat === 'org' ? '* Purpose' : '## Purpose';
        const retiredNote =
          `${update.id} - capability retired; deleted ${retired.resolvedPath ?? update.target}. ` +
          `Removed ${purposeLabel}${retiredPurpose ? ` (${retiredPurpose})` : ''}.`;
        warnings.push(retiredNote);
        if (!json) {
          console.log(`  Removed ${purposeLabel}${retiredPurpose ? `: ${retiredPurpose}` : ''}`);
        }
        results.push({
          id: update.id,
          action: 'retired',
          path: retired.resolvedPath ?? update.target,
          counts,
          ...(retiredPurpose ? { retiredPurpose } : {}),
        });
      } else {
        results.push({
          id: update.id,
          action: 'skipped',
          path: update.target,
          counts,
        });
      }
      continue;
    }

    const totalChanges = counts.added + counts.modified + counts.removed + counts.renamed;
    if (totalChanges === 0) {
      results.push({
        id: update.id,
        action: 'unchanged',
        path: update.target,
        counts,
      });
      continue;
    }

    await writeUpdatedSpec(update, rebuilt, counts, {
      silent: json,
      format: changeFormat,
      ...(isStoreSelectedRoot(root) ? { displayPath: update.target } : {}),
    });
    wroteAny = true;
    totals.added += counts.added;
    totals.modified += counts.modified;
    totals.removed += counts.removed;
    totals.renamed += counts.renamed;
    results.push({
      id: update.id,
      action: update.exists ? 'updated' : 'created',
      path: update.target,
      counts,
    });
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          change: resolvedChangeName,
          format: changeFormat,
          synced: true,
          specsUpdated: wroteAny,
          changeActive: true,
          totals,
          specs: results,
          warnings,
          root: toRootOutput(root),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `Totals: + ${totals.added}, ~ ${totals.modified}, - ${totals.removed}, → ${totals.renamed}`
  );
  console.log(
    wroteAny
      ? `Synced ${results.length} spec(s) for change '${resolvedChangeName}'. Change remains active.`
      : `Specs already in sync for change '${resolvedChangeName}'; no files changed. Change remains active.`
  );
}
