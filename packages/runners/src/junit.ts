import type { JUnitParseResult, JUnitCase, JUnitSuite } from './junit-types.js';

export type { JUnitParseResult, JUnitCase, JUnitSuite };

/**
 * Decode the XML entities the JUnit format actually uses.
 *
 * Order matters: numeric and the visible named entities are decoded first and
 * `&amp;` last, so doubly-escaped input (`&amp;lt;`) stays correctly escaped
 * instead of being decoded twice. `&#x27;` and `&#39;` both decode to `'`.
 */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCode(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeFromCode(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

interface RawAttrs {
  [key: string]: string;
}

/**
 * Attribute parser robust to attributes in any order, single or double quotes,
 * extra whitespace, and `<` inside quoted values. Unknown shapes are skipped,
 * never thrown on.
 */
function parseAttrs(raw: string): RawAttrs {
  const attrs: RawAttrs = {};
  const re = /([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1];
    if (key === undefined) continue;
    const value = m[2] ?? m[3] ?? '';
    attrs[key] = decodeEntities(value);
  }
  return attrs;
}

/** Find the closing `>` of a start tag, skipping quoted sections. */
function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return xml.length;
}

function num(value: string | undefined): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse JUnit XML (the `<testsuites>`/`<testsuite>`/`<testcase>` dialect) into
 * structured suites and cases.
 *
 * Design constraints, deliberately:
 * - Hand-rolled regex tokenizer — no XML dependency, no entity-expansion bombs.
 * - Attributes may appear in any order; single or double quoted.
 * - CDATA sections are tolerated: the wrapper is stripped and the inner text is
 *   kept verbatim (CDATA content cannot contain entities by XML definition).
 * - Malformed input NEVER throws: whatever parsed is returned, and every
 *   recovery is recorded in the returned `warnings` arrays (suite-level and
 *   document-level). Missing/blank input yields an empty result with a warning.
 */
export function parseJUnitXmlDetailed(xml: string): JUnitParseResult {
  const docWarnings: string[] = [];
  const suites: JUnitSuite[] = [];

  if (xml.trim().length === 0) {
    docWarnings.push('empty input — nothing to parse');
    return { suites, warnings: docWarnings };
  }

  interface OpenCase extends JUnitCase {
    capture: '' | 'failure' | 'error' | 'skipped';
    captureBuf: string[];
  }

  // Mutable parser state — held in one object because the tokenizer callbacks
  // below close over it. Property access (unlike a bare `let`) keeps the
  // declared type across function boundaries under strict narrowing rules.
  const stack: string[] = [];
  const state: { suite: JUnitSuite | null; openCase: OpenCase | null } = {
    suite: null,
    openCase: null,
  };

  const finalizeCase = (): void => {
    const openCase = state.openCase;
    const suite = state.suite;
    if (!openCase || !suite) return;
    const c: JUnitCase = {
      name: openCase.name,
      className: openCase.className,
      status: openCase.status,
      durationMs: openCase.durationMs,
    };
    if (openCase.errorType !== undefined) c.errorType = openCase.errorType;
    if (openCase.errorMessage !== undefined) c.errorMessage = openCase.errorMessage;
    if (openCase.errorStack !== undefined) c.errorStack = openCase.errorStack;
    suite.cases.push(c);
    state.openCase = null;
  };

  const finalizeSuite = (): void => {
    const suite = state.suite;
    if (!suite) return;
    if (state.openCase) {
      suite.warnings.push('unterminated <testcase> closed implicitly at end of element');
      finalizeCase();
    }
    suites.push(suite);
    state.suite = null;
  };

  const onStart = (name: string, attrs: RawAttrs, selfClosing: boolean): void => {
    if (name === 'testsuite') {
      if (state.suite) {
        docWarnings.push('nested <testsuite> encountered — implicit close of previous suite');
        finalizeSuite();
      }
      state.suite = {
        name: attrs['name'] ?? '',
        tests: num(attrs['tests']),
        failures: num(attrs['failures']),
        errors: num(attrs['errors']),
        skipped: num(attrs['skipped']),
        timeSec: num(attrs['time']),
        cases: [],
        warnings: [],
      };
      if (selfClosing) finalizeSuite();
      return;
    }
    if (name === 'testcase') {
      if (state.openCase) {
        if (state.suite) state.suite.warnings.push('nested <testcase> encountered — implicit close of previous case');
        finalizeCase();
      }
      state.openCase = {
        name: attrs['name'] ?? '',
        className: attrs['classname'] ?? attrs['className'] ?? '',
        status: 'passed',
        durationMs: Math.round(num(attrs['time']) * 1000),
        capture: '',
        captureBuf: [],
      };
      if (selfClosing) finalizeCase();
      return;
    }
    if ((name === 'failure' || name === 'error') && state.openCase) {
      const openCase = state.openCase;
      openCase.status = 'failed';
      openCase.capture = name;
      openCase.captureBuf = [];
      const type = attrs['type'];
      const message = attrs['message'];
      if (type !== undefined) openCase.errorType = type;
      if (message !== undefined) openCase.errorMessage = message;
      return;
    }
    if (name === 'skipped' && state.openCase) {
      state.openCase.status = 'skipped';
      state.openCase.capture = 'skipped';
      state.openCase.captureBuf = [];
      return;
    }
    // Unknown elements (<system-out>, <properties>, ...) are tracked for
    // structure but never interpreted.
    stack.push(name);
  };

  const onText = (text: string, cdata: boolean): void => {
    const openCase = state.openCase;
    if (!openCase || openCase.capture === '' || text.length === 0) return;
    openCase.captureBuf.push(cdata ? text : decodeEntities(text));
  };

  const onEnd = (name: string): void => {
    const openCase = state.openCase;
    if ((name === 'failure' || name === 'error') && openCase && openCase.capture === name) {
      const captured = openCase.captureBuf.join('').trim();
      if (captured.length > 0) {
        if (openCase.errorMessage === undefined) openCase.errorMessage = captured.split('\n')[0];
        openCase.errorStack = captured;
      }
      openCase.capture = '';
      openCase.captureBuf = [];
      return;
    }
    if (name === 'skipped' && openCase && openCase.capture === 'skipped') {
      openCase.capture = '';
      openCase.captureBuf = [];
      return;
    }
    if (name === 'testcase') {
      if (state.openCase) finalizeCase();
      else if (state.suite) state.suite.warnings.push('stray </testcase> without an open case');
      return;
    }
    if (name === 'testsuite') {
      finalizeSuite();
      return;
    }
    if (name === 'testsuites') return; // pure container
    // Unknown element — pop if it matches the structural stack.
    const top = stack[stack.length - 1];
    if (top === name) stack.pop();
    else docWarnings.push(`unmatched end tag </${name}> ignored`);
  };

  // ---- tokenizer -----------------------------------------------------------
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      onText(xml.slice(i), false);
      break;
    }
    if (lt > i) onText(xml.slice(i, lt), false);

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) {
        docWarnings.push('unterminated comment — ignored to end of input');
        i = xml.length;
      } else {
        i = end + 3;
      }
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const raw = end === -1 ? xml.slice(lt + 9) : xml.slice(lt + 9, end);
      if (end === -1) docWarnings.push('unterminated CDATA section — kept to end of input');
      onText(raw, true);
      i = end === -1 ? xml.length : end + 3;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end === -1 ? xml.length : end + 2;
    } else if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      i = end === -1 ? xml.length : end + 1;
    } else if (xml.startsWith('</', lt)) {
      const end = xml.indexOf('>', lt);
      if (end === -1) {
        docWarnings.push('unterminated end tag — ignored to end of input');
        i = xml.length;
        continue;
      }
      const name = xml.slice(lt + 2, end).trim();
      onEnd(name);
      i = end + 1;
    } else {
      const end = findTagEnd(xml, lt);
      if (end >= xml.length && xml[xml.length - 1] !== '>') {
        docWarnings.push('unterminated start tag — ignored to end of input');
        i = xml.length;
        continue;
      }
      const inner = xml.slice(lt + 1, end);
      const selfClosing = inner.endsWith('/');
      const nameMatch = /^([^\s/>]+)/.exec(inner);
      const name = nameMatch?.[1] ?? '';
      if (name.length === 0) {
        docWarnings.push('malformed start tag without a name — skipped');
        i = end + 1;
        continue;
      }
      onStart(name, parseAttrs(inner.slice(name.length)), selfClosing);
      i = end + 1;
    }
  }

  if (state.openCase) {
    const target = state.suite?.warnings ?? docWarnings;
    target.push('unexpected end of input inside <testcase> — case finalized best-effort');
    finalizeCase();
  }
  if (state.suite) {
    state.suite.warnings.push('unexpected end of input inside <testsuite> — suite finalized best-effort');
    finalizeSuite();
  }
  if (suites.length === 0 && docWarnings.every((w) => w !== 'empty input — nothing to parse')) {
    docWarnings.push('no <testsuite> element found — input is not JUnit XML');
  }

  // Reconcile per-suite counts with observed cases when attributes are missing.
  for (const s of suites) {
    if (s.tests === 0 && s.cases.length > 0) s.tests = s.cases.length;
    const failed = s.cases.filter((c) => c.status === 'failed').length;
    const skipped = s.cases.filter((c) => c.status === 'skipped').length;
    if (s.failures === 0 && failed > 0) s.failures = failed;
    if (s.skipped === 0 && skipped > 0) s.skipped = skipped;
  }

  return { suites, warnings: docWarnings };
}

/**
 * Parse JUnit XML into suites. Never throws: malformed input returns whatever
 * parsed; per-suite recoveries are recorded in `JUnitSuite.warnings` and
 * document-level problems surface via {@link parseJUnitXmlDetailed}.
 */
export function parseJUnitXml(xml: string): JUnitSuite[] {
  return parseJUnitXmlDetailed(xml).suites;
}
