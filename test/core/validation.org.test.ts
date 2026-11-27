import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChangeParser } from '../../src/core/parsers/change-parser.js';
import { Validator } from '../../src/core/validation/validator.js';

let root: string;
let delta: string;
const validator = new Validator(true);
const body = 'The system SHALL retain the native artifact text.';
const steps = '*** Scenario: Retained\n- *WHEN* reading ~source~\n- *THEN* it keeps *markup* and /emphasis/';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-validate-org-'));
  delta = path.join(root, 'specs', 'platform', 'session', 'spec.org');
  await fs.mkdir(path.dirname(delta), { recursive: true });
});

afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('validates the selected Org delta and reports the true requirement line', async () => {
  await fs.writeFile(path.join(path.dirname(delta), 'spec.md'), '## ADDED Requirements\n### Requirement: Decoy\n');
  await fs.writeFile(delta, [
    '* ADDED Requirements', '** Requirement: Real', body,
    '#+BEGIN_EXAMPLE', '*** Scenario: Decoy', '- *WHEN* quoted', '- *THEN* quoted', '#+END_EXAMPLE',
  ].join('\r\n'));
  const report = await validator.validateChangeDeltaSpecs(root, { format: 'org' });
  expect(report.valid).toBe(false);
  expect(report.issues).toEqual([expect.objectContaining({
    path: path.join('platform', 'session', 'spec.org'), line: 2,
    message: 'ADDED "Real" must include at least one scenario',
  })]);
  await fs.appendFile(delta, `\r\n${steps}\r\n`);
  expect((await validator.validateChangeDeltaSpecs(root, { format: 'org' })).issues).toEqual([]);
  await fs.rm(delta);
  const missing = await validator.validateChangeDeltaSpecs(root, { format: 'org' });
  expect(missing.valid).toBe(false);
  expect(missing.issues).toHaveLength(1);
  expect(missing.issues[0].message).toMatch(/at least one delta/i);
});

it('validates a CRLF Org proposal and represents all four operations in its change', async () => {
  const proposal = path.join(root, 'proposal.org');
  const content = '* Why\r\nWe need to keep native Org markup and validate all four delta operations.\r\n* What Changes\r\nUse native Org files.\r\n';
  await fs.writeFile(proposal, content);
  await fs.writeFile(delta, [
    '* ADDED Requirements', '** Requirement: Added', body, steps,
    '* MODIFIED Requirements', '** Requirement: Modified', body, steps,
    '* REMOVED Requirements', '** Requirement: Removed', '- *Reason* unused',
    '* RENAMED Requirements', '- FROM: Old', '- TO: New',
  ].join('\n'));
  expect((await validator.validateChange(proposal, 'org')).issues).toEqual([]);
  expect((await validator.validateChangeDeltaSpecs(root, { format: 'org' })).issues).toEqual([]);
  const change = await new ChangeParser(content, root, 'org').parseChangeWithDeltas('org-change');
  expect(change.deltas.map(({ operation }) => operation)).toEqual(['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED']);
  expect(change.deltas[0].requirement?.scenarios[0].rawText).toContain('~source~');
});

it('reports duplicate requirements and missing steps in a main Org spec at their source lines', async () => {
  const spec = path.join(root, 'spec.org');
  await fs.writeFile(spec, [
    '* Purpose', 'Define how the workflow preserves native artifact text when it is read.',
    '* Requirements', '** Requirement: Repeated', body, steps,
    '** Requirement: Repeated', body, '*** Scenario: No outcome', '- *WHEN* reading',
  ].join('\n'));
  const report = await validator.validateSpec(spec, 'org');
  expect(report.valid).toBe(false);
  expect(report.issues).toEqual([
    expect.objectContaining({ path: spec, line: 9, message: 'Duplicate requirement: "Repeated"' }),
    expect.objectContaining({ path: spec, line: 11, message: expect.stringContaining('needs a trigger') }),
  ]);
});
