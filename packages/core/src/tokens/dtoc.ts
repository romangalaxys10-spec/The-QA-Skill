/**
 * Token-efficiency utilities — Dynamic Tool Output Compression (DTOC) caps.
 *
 * Agent context windows are working memory, not a junk drawer. Verbose tool
 * output (listings, logs, diffs, configs) is truncated to documented caps
 * before it enters a report, a journal, or a subagent prompt — with the
 * truncation always visible, never silent.
 */

export type DtocKind = 'ls' | 'logs' | 'diff' | 'config' | 'search';

export const DTOC_CAPS: Readonly<Record<DtocKind, number>> = {
  ls: 20,
  logs: 30,
  diff: 100,
  config: 80,
  search: 40,
};

/** Rough token estimate (chars/4) — the same heuristic the router uses. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface DtocResult {
  kind: DtocKind;
  originalLines: number;
  keptLines: number;
  truncated: boolean;
  /** Human-readable truncation marker appended when lines were dropped. */
  marker?: string;
  text: string;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Compress text to the documented cap for its kind.
 * - logs / search: keep the TAIL (recent lines matter most)
 * - ls / config / diff: keep the HEAD (structure matters most)
 */
export function compressText(kind: DtocKind, text: string): DtocResult {
  const cap = DTOC_CAPS[kind];
  const lines = text.split('\n');
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
  const content = trailingNewline ? lines.slice(0, -1) : lines;
  const tokensBefore = estimateTokens(text);

  if (content.length <= cap) {
    return {
      kind,
      originalLines: content.length,
      keptLines: content.length,
      truncated: false,
      text,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  const dropped = content.length - cap;
  const marker = `[… DTOC: ${dropped} of ${content.length} lines truncated (cap ${cap} for ${kind}) …]`;
  const keep = kind === 'logs' || kind === 'search' ? content.slice(-cap) : content.slice(0, cap);
  const out = kind === 'logs' || kind === 'search' ? [marker, ...keep] : [...keep, marker];

  return {
    kind,
    originalLines: content.length,
    keptLines: cap,
    truncated: true,
    marker,
    text: out.join('\n'),
    tokensBefore,
    tokensAfter: estimateTokens(out.join('\n')),
  };
}
