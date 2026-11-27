import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCLI } from '../helpers/run-cli.js';

it.each(['markdown', 'org'] as const)('plans and validates a nested capability using %s', async (format) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-format-journey-'));
  const org = format === 'org';
  const extension = org ? 'org' : 'md';
  const name = 'retain-session';
  const capability = 'platform/session';
  const run = (args: string[]) => runCLI(args, { cwd });
  const json = async (args: string[]) => {
    const result = await run([...args, '--json']);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };

  try {
    const init = await run(['init', '--tools', 'none']);
    expect(init.exitCode, init.stdout + init.stderr).toBe(0);
    if (org) await fs.writeFile(path.join(cwd, 'openspec', 'config.yaml'), 'schema: spec-driven-org\n');
    const created = await json(['new', 'change', name]);
    expect(created.change.schema).toBe(org ? 'spec-driven-org' : 'spec-driven');
    const changeDir = created.change.path;
    const status = () => json(['status', '--change', name]);
    expect((await status()).artifacts.map(({ status }: { status: string }) => status)).toEqual(['ready', 'blocked', 'blocked', 'blocked']);

    const heading = (level: number) => org ? '*'.repeat(level) : '#'.repeat(level + 1);
    const bold = org ? '*' : '**';
    const body = org ? 'The system SHALL retain ~state~.' : 'The system SHALL retain `state`.';
    const requirement = [
      `${heading(2)} Requirement: Retain session`, body,
      `${heading(3)} Scenario: Resume`, `- ${bold}WHEN${bold} reopening`, `- ${bold}THEN${bold} state returns`,
    ];
    const eol = org ? '\r\n' : '\n';
    const proposal = [
      `${heading(1)} Why`, 'Users lose session state when reopening, so they need to resume their work.',
      `${heading(1)} What Changes`, 'Retain session state across restarts.',
    ].join(eol);
    await fs.writeFile(path.join(changeDir, `proposal.${extension}`), proposal);
    const deltaDir = path.join(changeDir, 'specs', 'platform', 'session');
    const mainDir = path.join(cwd, 'openspec', 'specs', 'platform', 'session');
    await fs.mkdir(deltaDir, { recursive: true });
    await fs.mkdir(mainDir, { recursive: true });
    const deltaPath = path.join(deltaDir, `spec.${extension}`);
    await fs.writeFile(deltaPath, [`${heading(1)} ADDED Requirements`, ...requirement].join(eol));
    if (org) await fs.writeFile(path.join(deltaDir, 'spec.md'), '## ADDED Requirements\n### Requirement: Markdown decoy\n');
    await fs.writeFile(path.join(mainDir, `spec.${extension}`), [
      `${heading(1)} Purpose`, 'Help users resume their previous session after reopening the application.',
      `${heading(1)} Requirements`, ...requirement,
    ].join(eol));

    const planned = await status();
    expect(planned.artifactPaths.specs.existingOutputPaths).toEqual([deltaPath]);
    expect(planned.artifactPaths.tasks.outputPath).toBe(`tasks.${extension}`);
    expect((await json(['list', '--specs'])).specs).toEqual([{ id: capability, requirementCount: 1 }]);
    expect((await json(['show', capability])).requirements[0].text).toBe(body);
    expect((await json(['show', name])).deltas).toMatchObject([{ spec: capability, operation: 'ADDED' }]);
    const raw = await run(['show', name]);
    expect(raw.exitCode).toBe(0);
    expect(raw.stdout.trimEnd()).toBe(proposal);
    await json(['validate', name, '--strict']);
    await json(['validate', capability, '--strict']);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
