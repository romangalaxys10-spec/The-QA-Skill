/** One test case extracted from JUnit XML. */
export interface JUnitCase {
  /** Case name (the `name` attribute of `<testcase>`). */
  name: string;
  /** Class or file the case belongs to (`classname`/`className` attribute). */
  className: string;
  /** Terminal status derived from child elements (`<failure>`/`<error>` → failed, `<skipped>` → skipped). */
  status: 'passed' | 'failed' | 'skipped';
  /** Duration in milliseconds (from the `time` attribute, seconds in JUnit). */
  durationMs: number;
  /** `type` attribute of `<failure>`/`<error>` when present. */
  errorType?: string;
  /** `message` attribute of `<failure>`/`<error>`, else the first line of its body. */
  errorMessage?: string;
  /** Full captured body of `<failure>`/`<error>` (the stack trace). */
  errorStack?: string;
}

/** One `<testsuite>` (or the whole document's suite collection). */
export interface JUnitSuite {
  name: string;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  /** Suite-level `time` attribute in seconds as written by JUnit. */
  timeSec: number;
  cases: JUnitCase[];
  /**
   * Recovery notes produced while parsing THIS suite. The parser never throws:
   * malformed input parses best-effort and every repair is reported here.
   */
  warnings: string[];
}

/** Document-level parse result: suites plus warnings that belong to no suite. */
export interface JUnitParseResult {
  suites: JUnitSuite[];
  /** Warnings about the document as a whole (unterminated tags, no suite found...). */
  warnings: string[];
}
