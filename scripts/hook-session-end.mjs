#!/usr/bin/env node
/**
 * SessionEnd hook — records an honest session footprint.
 *
 * Reads the hook payload (JSON on stdin), extracts a minimal, secret-free
 * footprint (transcript basename, turn count when present, duration), and
 * appends one DRAFT record to .theqa/sessions.jsonl in the current project
 * (or $HOME/.theqa/sessions.jsonl when no project root is evident).
 *
 * Design rules (mirroring the platform's honesty contract):
 *   - Never writes to the learning store directly — drafts are opt-in data.
 *   - Never embeds user content: paths are basenames, messages are counts.
 *   - Failures exit 0: a telemetry hook must never break a session.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  let payload = {};
  try {
    const raw = readStdin();
    if (raw.length > 0) payload = JSON.parse(raw);
  } catch {
    payload = {};
  }

  const transcript = typeof payload.transcript_path === 'string' ? basename(payload.transcript_path) : null;
  const durationMs = typeof payload.duration_ms === 'number' ? payload.duration_ms : null;
  const turns = typeof payload.turn_count === 'number' ? payload.turn_count : null;
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? resolve(payload.cwd) : process.cwd();

  const record = {
    ts: new Date().toISOString(),
    kind: 'session-end-draft',
    project: basename(cwd),
    transcript: transcript ?? 'unknown',
    turns,
    durationMs,
    note: 'draft record — review before promoting into the learning store',
  };

  const target = existsSync(join(cwd, '.theqa')) ? join(cwd, '.theqa', 'sessions.jsonl') : join(homedir(), '.theqa', 'sessions.jsonl');
  try {
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // Telemetry must never break a session.
  }
  process.exit(0);
}

main();
