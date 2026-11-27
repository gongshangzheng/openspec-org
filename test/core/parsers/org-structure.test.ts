import { describe, expect, it } from 'vitest';
import { readOrgDelta, readOrgMainSpec, readOrgProposal, readOrgRequirement } from '../../../src/core/parsers/org-structure.js';

const body = 'The system SHALL retain *bold*, /italic/, ~code~, and =verbatim=.';
const scenario = '*** Scenario: Preserved\n- *WHEN* reading ~source~\n- *THEN* it retains /formatting/';

it.each(['\n', '\r\n', '\r'])('reads structural headings and source markup across line endings %j', (eol) => {
  const content = [
    '#+TITLE: Spec', '* Purpose', 'Specify how native artifact markup is retained during reads.',
    '* Requirements', '** Requirement: Literal ###', '#+BEGIN_SRC org',
    '*** Scenario: Source example', '#+END_SRC', body, scenario,
  ].join('\n').replace(/\n/g, eol);
  const { spec, blocks } = readOrgMainSpec(content, 'markup');
  expect(blocks[0]).toMatchObject({ name: 'Literal ###', line: 5 });
  expect(blocks[0].raw).toContain('#+BEGIN_SRC org\n*** Scenario: Source example');
  expect(spec.requirements).toEqual([{ name: 'Literal ###', text: body, scenarios: [{
    name: 'Preserved', rawText: '- *WHEN* reading ~source~\n- *THEN* it retains /formatting/',
  }] }]);
  expect(readOrgProposal(['* Why', '*bold* is not a heading', '* What Changes', '/Native/ Org.'].join(eol), 'change'))
    .toMatchObject({ why: '*bold* is not a heading', whatChanges: '/Native/ Org.' });
});

describe('Org deltas', () => {
  it('reads all four operations with no Markdown name normalization', () => {
    const plan = readOrgDelta([
      '* ADDED Requirements', '** Requirement: New', body, scenario,
      '* MODIFIED Requirements', '** Requirement: Existing', body, scenario,
      '* REMOVED Requirements', '** Requirement: Obsolete', '- *Reason* It is unused.',
      '* RENAMED Requirements', '- FROM: ~** Requirement: Old ###~', '- TO: ~** Requirement: Renamed~',
    ].join('\n'));
    expect(plan.added).toMatchObject([{ name: 'New', line: 2 }]);
    expect(plan.modified).toMatchObject([{ name: 'Existing', line: 8 }]);
    expect(plan.removed).toEqual(['Obsolete']);
    expect(plan.removedBlocks[0].raw).toContain('*Reason*');
    expect(plan.renamed).toEqual([{ from: 'Old ###', to: 'Renamed' }]);
  });

  it('does not count an outcome quoted in an example or pair renames across sections', () => {
    const requirement = readOrgRequirement([
      '** Requirement: Example', body, '*** Scenario: Incomplete', '- *GIVEN* a request',
      '#+begin_example', '- *THEN* a quoted outcome', '#+end_example',
    ].join('\n'));
    expect(requirement.scenarios).toMatchObject([{ name: 'Incomplete', hasTrigger: true, hasOutcome: false }]);
    const plan = readOrgDelta('* RENAMED Requirements\n- FROM: Old\n* RENAMED Requirements\n- TO: New');
    expect(plan.renamed).toEqual([]);
    expect(plan.unpairedRenames).toEqual([{ side: 'FROM', name: 'Old', line: 2 }, { side: 'TO', name: 'New', line: 4 }]);
  });
});
