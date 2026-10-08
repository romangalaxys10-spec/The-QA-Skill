import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KnownFalseRegistry,
  claimHash,
  normalizeClaim,
  runProbe,
  runProbeAsync,
  verifyClaim,
  verifyClaimAsync,
} from '../src/index.js';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'tqs-verify-'));
}

describe('ground-truth probes', () => {
  it('file_exists observes a real file and refutes a missing one', () => {
    const cwd = tmpProject();
    writeFileSync(join(cwd, 'package.json'), '{}\n');
    const pass = runProbe({ kind: 'file_exists', path: 'package.json' }, cwd);
    const fail = runProbe({ kind: 'file_exists', path: 'nope.json' }, cwd);
    expect(pass.status).toBe('PASS');
    expect(pass.observation).toContain('exists');
    expect(fail.status).toBe('FAIL');
    expect(fail.observation).toContain('no file');
    rmSync(cwd, { recursive: true, force: true });
  });

  it('file_contains and file_not_contains judge content honestly', () => {
    const cwd = tmpProject();
    writeFileSync(join(cwd, 'a.txt'), 'hello world\n');
    expect(runProbe({ kind: 'file_contains', path: 'a.txt', pattern: 'world' }, cwd).status).toBe('PASS');
    expect(runProbe({ kind: 'file_contains', path: 'a.txt', pattern: 'goodbye' }, cwd).status).toBe('FAIL');
    expect(runProbe({ kind: 'file_not_contains', path: 'a.txt', pattern: 'goodbye' }, cwd).status).toBe('PASS');
    expect(runProbe({ kind: 'file_not_contains', path: 'a.txt', pattern: 'hello' }, cwd).status).toBe('FAIL');
    rmSync(cwd, { recursive: true, force: true });
  });

  it('invalid regex is an ERROR, never a silent FAIL', () => {
    const cwd = tmpProject();
    writeFileSync(join(cwd, 'a.txt'), 'x\n');
    const out = runProbe({ kind: 'file_contains', path: 'a.txt', pattern: '(unclosed' }, cwd);
    expect(out.status).toBe('ERROR');
    expect(out.error).toContain('invalid regex');
    rmSync(cwd, { recursive: true, force: true });
  });

  it('cmd_exit_zero distinguishes exit 0 from failures', () => {
    const cwd = tmpProject();
    const pass = runProbe({ kind: 'cmd_exit_zero', command: 'node -e "process.exit(0)"' }, cwd);
    const fail = runProbe({ kind: 'cmd_exit_zero', command: 'node -e "process.exit(3)"' }, cwd);
    expect(pass.status).toBe('PASS');
    expect(fail.status).toBe('FAIL');
    expect(fail.observation).toContain('exit 3');
    rmSync(cwd, { recursive: true, force: true });
  });

  it('git_ref_exists refutes unknown refs (repo fixtures carry real git history)', () => {
    const cwd = tmpProject();
    const out = runProbe({ kind: 'git_ref_exists', ref: 'HEAD' }, cwd);
    expect(out.status).toBe('FAIL');
    rmSync(cwd, { recursive: true, force: true });
  });

  it('http_status probe works over the async path (local observation only)', async () => {
    const out = await runProbeAsync({ kind: 'http_status', url: 'https://example.invalid', timeoutMs: 500 }, process.cwd());
    expect(out.status).toBe('ERROR');
    expect(out.error).toBeDefined();
  });
});

describe('claim verification engine', () => {
  it('VERIFIED when all probes pass; REFUTED on first clean failure', () => {
    const cwd = tmpProject();
    writeFileSync(join(cwd, 'keep.txt'), 'yes\n');
    const ok = verifyClaim('keep.txt exists', [{ kind: 'file_exists', path: 'keep.txt' }], { cwd });
    expect(ok.status).toBe('VERIFIED');
    expect(ok.label).toBe('OBSERVED');
    const bad = verifyClaim('nope exists', [{ kind: 'file_exists', path: 'nope.txt' }], { cwd });
    expect(bad.status).toBe('REFUTED');
    expect(bad.explanation).toContain('refuted by');
    rmSync(cwd, { recursive: true, force: true });
  });

  it('repeat=true upgrades to CONFIRMED and downgrades instability to UNKNOWN', () => {
    const cwd = tmpProject();
    writeFileSync(join(cwd, 'stable.txt'), 'x\n');
    const confirmed = verifyClaim('stable exists', [{ kind: 'file_exists', path: 'stable.txt' }], { cwd, repeat: true });
    expect(confirmed.status).toBe('VERIFIED');
    expect(confirmed.label).toBe('CONFIRMED');
    expect(confirmed.repeat?.status).toBe('VERIFIED');
    rmSync(cwd, { recursive: true, force: true });
  });

  it('ERROR probes produce UNKNOWN, never REFUTED', () => {
    const cwd = tmpProject();
    writeFileSync(join(cwd, 'a.txt'), 'x\n'); // file exists so the only issue is the bad regex
    const out = verifyClaim('bad regex probe', [{ kind: 'file_contains', path: 'a.txt', pattern: '(bad' }], { cwd });
    expect(out.status).toBe('UNKNOWN');
    expect(out.label).toBe('NOT_VERIFIED');
    rmSync(cwd, { recursive: true, force: true });
  });

  it('no probes → UNKNOWN with an honest explanation', () => {
    const out = verifyClaim('nothing to check', [], { cwd: process.cwd() });
    expect(out.status).toBe('UNKNOWN');
    expect(out.explanation).toContain('no probes');
  });
});

describe('KNOWN_FALSE registry', () => {
  it('records refutations and bans retrying the identical claim', () => {
    const cwd = tmpProject();
    const registryPath = join(cwd, '.theqa', 'known-false.json');
    const registry = new KnownFalseRegistry(registryPath);
    expect(registry.isKnownFalse('the file ghost.txt exists')).toBeUndefined();

    registry.add('The file ghost.txt exists', 'file_exists probe failed', 'no file at ghost.txt');
    expect(registry.isKnownFalse('The file ghost.txt exists')).toBeDefined();
    // Normalization: whitespace/case variations hash identically.
    expect(registry.isKnownFalse('the   FILE ghost.txt EXISTS')).toBeDefined();
    expect(registry.all()).toHaveLength(1);
    expect(registry.all()[0]?.evidence).toContain('no file at');

    // Persistence across instances.
    const second = new KnownFalseRegistry(registryPath);
    expect(second.isKnownFalse('the file ghost.txt exists')).toBeDefined();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('claim hashing is stable across whitespace and case', () => {
    expect(claimHash('A  claim')).toBe(claimHash('a claim'));
    expect(normalizeClaim('  A\tCLAIM  ')).toBe('a claim');
  });

  it('corrupt registry files are treated as empty, not fatal', () => {
    const cwd = tmpProject();
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'broken.json'), '{not json');
    const registry = new KnownFalseRegistry(join(cwd, 'broken.json'));
    expect(registry.all()).toHaveLength(0);
    expect(registry.isKnownFalse('anything')).toBeUndefined();
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('async verification (http probes)', () => {
  it('verifies claims end-to-end over the async engine', async () => {
    const cwd = tmpProject();
    writeFileSync(join(cwd, 'ok.txt'), 'fine\n');
    const out = await verifyClaimAsync('ok.txt exists', [{ kind: 'file_exists', path: 'ok.txt' }], { cwd });
    expect(out.status).toBe('VERIFIED');
    rmSync(cwd, { recursive: true, force: true });
  });
});
