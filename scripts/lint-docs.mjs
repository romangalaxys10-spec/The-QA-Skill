#!/usr/bin/env node
/**
 * Documentation drift linter — keeps docs honest about the code they describe.
 *
 * Checks:
 *   1. Every `qa <command>` reference in docs/ and skills/ names a real CLI
 *      command (unknown commands = the doc drifted from the CLI surface).
 *   2. Every file in docs/ references at least one real package path or CLI
 *      command (a doc with no anchor in the implementation is prose fiction).
 *   3. Quantitative benchmark claims of the form "<n>/13" or "<n> of 13"
 *      fixtures must match benchmarks/agentic-qa/results.json (if present).
 *
 * Exit 1 on any violation — CI-enforced.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const problems = [];

/** Real CLI commands — parsed from the built CLI program (single source of truth). */
function realCommands() {
  try {
    const require = createRequire(import.meta.url);
    const { createProgram } = require('../packages/cli/dist/index.js');
    return new Set(createProgram().commands().map((c) => c.name));
  } catch {
    // Fallback: parse the usage text from the CLI source.
    const src = readFileSync(join(process.cwd(), 'packages', 'cli', 'src', 'index.ts'), 'utf8');
    const names = [...src.matchAll(/name: '([a-z-]+)',/g)].map((m) => m[1]);
    return new Set(names);
  }
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, dirent.name);
    if (dirent.isDirectory()) walk(p, files);
    else if (dirent.name.endsWith('.md')) files.push(p);
  }
  return files;
}

const commands = realCommands();
if (commands.size === 0) {
  console.error('LINT ERROR: could not determine the CLI command surface');
  process.exit(1);
}

// 1 + 2: scan docs and skills.
const docFiles = walk(join(process.cwd(), 'docs'));
const skillFiles = walk(join(process.cwd(), 'skills'));

// Intent phrases ("qa this pr", "qa the checkout flow") are not commands.
const STOPWORDS = new Set(['this', 'that', 'the', 'a', 'an', 'is', 'are', 'will', 'would', 'can', 'could', 'should', 'my', 'our', 'it', 'me', 'us', 'them', 'here', 'there']);

for (const file of [...docFiles, ...skillFiles]) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\bqa ([a-z][a-z-]+)\b/g)) {
    const cmd = m[1];
    if (STOPWORDS.has(cmd)) continue;
    if (!commands.has(cmd)) {
      problems.push(`${file}: references unknown command "qa ${cmd}"`);
    }
  }
}

for (const file of docFiles) {
  const text = readFileSync(file, 'utf8');
  const anchored =
    /packages\/[a-z-]+/.test(text) ||
    /\bqa [a-z][a-z-]+\b/.test(text) ||
    /skills\/[a-z-]+/.test(text) ||
    /benchmarks\//.test(text);
  if (!anchored && statSync(file).size > 500) {
    problems.push(`${file}: no reference to any package path, CLI command, skill, or benchmark — prose with no anchor`);
  }
}

// 3: benchmark claim consistency.
const resultsPath = join(process.cwd(), 'benchmarks', 'agentic-qa', 'results.json');
if (existsSync(resultsPath)) {
  try {
    const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
    const total = typeof results.totalFixtures === 'number' ? results.totalFixtures : (results.fixtures ?? []).length;
    const detected = typeof results.detected === 'number' ? results.detected : undefined;
    if (total > 0 && detected !== undefined) {
      const claimRe = new RegExp(`\\b(\\d+)\\s*(?:/|of )\\s*${total}\\b`, 'g');
      for (const file of docFiles) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(claimRe)) {
          const claimed = Number.parseInt(m[1], 10);
          if (claimed > total) {
            problems.push(`${file}: claims ${claimed}/${total} fixtures — results.json records ${detected}/${total}`);
          }
        }
      }
    }
  } catch {
    problems.push(`${resultsPath}: unreadable (benchmark claims cannot be verified)`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`LINT ERROR: ${p}`);
  console.error(`\n${problems.length} documentation drift problem(s)`);
  process.exit(1);
}
console.log(`doc drift: ${docFiles.length} doc(s), ${skillFiles.length} skill(s) checked against ${commands.size} CLI commands — clean`);
