import { describe, expect, it } from 'vitest';
import { CliProgram, UsageError, parseArgsSemantics } from '../src/args.js';
import { createProgram, runCommand } from '../src/index.js';

describe('args parser', () => {
  it('parses the command, positionals, boolean flags, and --flag=value', () => {
    const program = createProgram();
    const parsed = program.parse(['generate', '--spec', 'spec.json', '--dry-run', '--out=out/gen', 'extra']);
    expect(parsed.command).toBe('generate');
    expect(parsed.positionals).toEqual(['extra']);
    expect(parsed.flags['spec']).toBe('spec.json');
    expect(parsed.flags['dry-run']).toBe(true);
    expect(parsed.flags['out']).toBe('out/gen');
  });

  it('supports global flags before the command', () => {
    const program = createProgram();
    const parsed = program.parse(['--json', '--verbose', 'doctor']);
    expect(parsed.command).toBe('doctor');
    expect(parsed.flags['json']).toBe(true);
    expect(parsed.flags['verbose']).toBe(true);
  });

  it('treats everything after -- as positional', () => {
    const program = createProgram();
    const parsed = program.parse(['review', '--', '--not-a-flag', 'x']);
    expect(parsed.command).toBe('review');
    expect(parsed.positionals).toEqual(['--not-a-flag', 'x']);
  });

  it('rejects short flags with a hint', () => {
    const program = createProgram();
    expect(() => program.parse(['-j'])).toThrow(UsageError);
    expect(() => program.parse(['-j'])).toThrow(/long flags/);
  });

  it('rejects unknown commands and unknown flags with usage errors', () => {
    const program = createProgram();
    expect(() => program.parse(['nope'])).toThrow(/unknown command "nope"/);
    expect(() => program.parse(['risk', '--bogus'])).toThrow(/unknown flag --bogus/);
    expect(() => program.parse(['risk', '--range', 'a..b'])).not.toThrow();
  });

  it('rejects boolean flags given values and empty values', () => {
    const program = createProgram();
    expect(() => program.parse(['init', '--force=true'])).toThrow(/does not take a value/);
    expect(() => program.parse(['risk', '--range='])).toThrow(/non-empty value/);
  });

  it('throws when a value flag has no value token', () => {
    const program = createProgram();
    expect(() => program.parse(['generate', '--spec'])).toThrow(/requires a value/);
  });

  it('syntactic core: bare flags default to boolean until command value flags register', () => {
    const raw = parseArgsSemantics(['triage', '--evidence', 'failures.json', '--json']);
    expect(raw.flags['evidence']).toBe('failures.json');
    expect(raw.flags['json']).toBe(true);
  });

  it('createProgram registers exactly the 16 documented commands', () => {
    const program = createProgram();
    expect(program.commands().map((c) => c.name)).toEqual([
      'init', 'discover', 'plan', 'risk', 'impact', 'generate', 'review', 'test',
      'triage', 'heal', 'flake', 'coverage', 'release', 'report', 'doctor', 'explain',
    ]);
  });

  it('usage text lists every command and help renders per-command flags', () => {
    const program = createProgram();
    const usage = program.usageText('qa');
    for (const name of ['init', 'impact', 'triage', 'heal', 'doctor', 'explain']) {
      expect(usage).toContain(name);
    }
    const help = program.commandHelp(program.get('generate')!);
    expect(help).toContain('--spec <value>');
    expect(help).toContain('--force');
  });

  it('CliProgram refuses duplicate registration', () => {
    const program = new CliProgram();
    program.register({ name: 'x', summary: '', usage: 'qa x', positionals: [], flags: [], run: async () => ({ ok: true, data: 0, label: 'OBSERVED' }) });
    expect(() => program.register({ name: 'x', summary: '', usage: 'qa x', positionals: [], flags: [], run: async () => ({ ok: true, data: 0, label: 'OBSERVED' }) })).toThrow(/twice/);
  });

  it('bare invocation prints usage and exits 2; --help exits 0; --version exits 0', async () => {
    const out: string[] = [];
    const code0 = await runCommand([], { io: { stdout: { write: (t) => void out.push(t) }, stderr: process.stderr } });
    expect(code0).toBe(2);
    expect(out.join('')).toContain('Commands:');
    const codeHelp = await runCommand(['risk', '--help'], { io: { stdout: { write: (t) => void out.push(t) }, stderr: process.stderr } });
    expect(codeHelp).toBe(0);
    const codeVer = await runCommand(['--version'], { io: { stdout: { write: (t) => void out.push(t) }, stderr: process.stderr } });
    expect(codeVer).toBe(0);
  });
});
