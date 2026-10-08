#!/usr/bin/env node
/**
 * Skill contract linter — enforces the 13-section enterprise contract and
 * the frontmatter schema for every skills/<skill>/SKILL.md.
 *
 * Sections required (case-insensitive headings, in any order):
 *   Purpose · When to activate · Inputs · Preconditions · Decision rules ·
 *   Workflow · Anti-patterns · Failure handling · Evidence requirements ·
 *   Safety constraints · Output contract · Examples · Verification checklist
 *
 * Frontmatter requires: name, description, version, license.
 * Content floors: ≥120 lines for qa-* skills; ≥1 fenced schema block
 * (```json/```yaml/```ts) in Output contract or Examples.
 *
 * Exit 0 when every skill passes; exit 1 with a violation report otherwise.
 * This is CI-enforced: a skill that drifts from the contract breaks the build.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SECTIONS = [
  'purpose', 'when to activate', 'inputs', 'preconditions', 'decision rules',
  'workflow', 'anti-patterns', 'failure handling', 'evidence requirements',
  'safety constraints', 'output contract', 'examples', 'verification checklist',
];

const REQUIRED_FRONTMATTER = ['name', 'description', 'version', 'license'];

function fail(msg) {
  console.error(`LINT ERROR: ${msg}`);
  process.exitCode = 1;
}

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (m === null) return { frontmatter: null, body: text };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

function headings(body) {
  const out = [];
  for (const line of body.split('\n')) {
    const m = /^#{1,4}\s+(.*)$/.exec(line.trim());
    if (m !== null) out.push(m[1].toLowerCase().replace(/[:*#]/g, '').trim());
  }
  return out;
}

const skillsRoot = join(process.cwd(), 'skills');
if (!existsSync(skillsRoot)) {
  fail('skills/ directory not found — run from the repository root');
  process.exit(process.exitCode ?? 1);
}

const dirs = readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
let checked = 0;
let flagged = 0;

for (const dir of dirs) {
  const file = join(skillsRoot, dir, 'SKILL.md');
  if (!existsSync(file)) {
    fail(`${dir}/SKILL.md missing`);
    flagged += 1;
    continue;
  }
  checked += 1;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').length;
  const { frontmatter, body } = parseFrontmatter(text);
  const problems = [];

  if (frontmatter === null) {
    problems.push('missing frontmatter block');
  } else {
    for (const key of REQUIRED_FRONTMATTER) {
      if (typeof frontmatter[key] !== 'string' || frontmatter[key].length === 0) problems.push(`frontmatter "${key}" missing`);
    }
  }

  const heads = headings(body);
  for (const section of SECTIONS) {
    const found = heads.some((h) => h === section || h.startsWith(section) || h.includes(section));
    if (!found) problems.push(`missing section: ${section}`);
  }

  const isQaSkill = dir.startsWith('qa-');
  if (isQaSkill && lines < 120) problems.push(`content floor: ${lines} lines < 120 for qa-* skills`);

  // Output contract or Examples must include a machine-readable schema block.
  const hasSchema = /```(json|yaml|ts|typescript)/.test(body);
  if (!hasSchema) problems.push('no fenced schema block (json/yaml/ts) in Output contract or Examples');

  if (problems.length > 0) {
    flagged += 1;
    console.error(`✗ ${dir}/SKILL.md (${lines} lines)`);
    for (const p of problems) console.error(`    - ${p}`);
  } else {
    console.log(`✓ ${dir}/SKILL.md (${lines} lines)`);
  }
}

console.log(`\n${checked} skill(s) checked, ${flagged} flagged`);
if (flagged > 0) process.exit(1);
