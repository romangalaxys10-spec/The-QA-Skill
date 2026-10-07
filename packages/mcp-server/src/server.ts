/**
 * The-QA-Skill MCP stdio server.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over any readable stream or
 * string async-iterable (stdin in production). Lines are processed strictly
 * sequentially — responses are written in request order, and a failing tool
 * can never crash the loop: tool errors become `isError: true` results and
 * unexpected errors become -32603 protocol errors.
 */
import { createInterface } from 'node:readline';
import { resolve as resolvePath } from 'node:path';
import type { Readable as NodeReadable } from 'node:stream';
import { createLogger } from '@the-qa-skill/core';
import type { Logger } from '@the-qa-skill/core';
import { scrubSecrets } from '@the-qa-skill/core';
import { ERROR_CODES, isRequest, parseMessage, renderError, renderResponse } from './rpc.js';
import type { JsonRpcId, JsonRpcMessage, ParseResult } from './rpc.js';
import { errorMessage } from './errors.js';
import { TOOL_HANDLERS } from './handlers.js';
import { TOOLS } from './tools.js';
import { MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_SERVER_VERSION } from './version.js';

/**
 * Scrub every string in a payload (deep) with core scrubSecrets before it is
 * serialized. Deep-first matters: JSON.stringify escapes quotes (\"), which
 * would hide quote-anchored token patterns from the regexes if we only
 * scrubbed the serialized text.
 */
function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = scrubDeep(val);
    return out;
  }
  return value;
}

/** Result of the MCP `initialize` handshake (static — nothing here is secret). */
const INITIALIZE_RESULT = {
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: { tools: { listChanged: false } },
  serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
  instructions: 'The-QA-Skill QA operating system — deterministic-first QA tools. Sponsored by xShredo.dev',
} as const;

/** Options for {@link McpServer}. */
export interface McpServerOptions {
  /** Where JSON-RPC lines come from: a Node stream or an async iterable of strings. */
  input: NodeJS.ReadableStream | AsyncIterable<string>;
  /** Sink for newline-terminated JSON-RPC responses (stdout in production). */
  output: { write(chunk: string): void };
  /** Default project root for tools; defaults to process.cwd(). */
  root?: string;
  /** Logger (stderr-only by default — stdout carries the protocol). */
  logger?: Logger;
}

/**
 * The MCP server. {@link handleLine} is pure with respect to transport state
 * and exposed for tests; {@link start} runs the sequential read loop.
 */
export class McpServer {
  private readonly output: { write(chunk: string): void };
  private readonly root: string;
  private readonly logger: Logger;
  private readonly input: NodeJS.ReadableStream | AsyncIterable<string>;

  private running = false;
  private stopped = false;
  private completion: Promise<void> = Promise.resolve();
  private currentIterator: AsyncIterableIterator<string> | null = null;

  constructor(opts: McpServerOptions) {
    this.input = opts.input;
    this.output = opts.output;
    this.root = resolvePath(opts.root ?? process.cwd());
    this.logger = opts.logger ?? createLogger({ quiet: true, json: true });
  }

  /** Absolute default project root used by tool handlers. */
  get serverRoot(): string {
    return this.root;
  }

  /** True while the read loop is alive. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Run the server until the input ends or {@link stop} is called. Resolves
   * when the loop exits. Throws if the server is already running.
   */
  async start(): Promise<void> {
    if (this.running) throw new Error('McpServer.start() called while already running');
    this.running = true;
    this.stopped = false;
    this.completion = this.readLoop();
    await this.completion;
  }

  /** Signal the loop to stop and wait for it to drain. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    try {
      await this.currentIterator?.return?.(undefined);
    } catch {
      // input already closed — nothing to drain
    }
    await this.completion.catch(() => undefined);
  }

  /**
   * Handle one raw input line and return the response line to write, or null
   * when the line produces no response (blank line, notification, or a
   * notification-shaped message). Never throws: every failure mode is mapped
   * to a JSON-RPC error response.
   */
  async handleLine(line: string): Promise<string | null> {
    const trimmed = line.trim();
    if (trimmed === '') return null; // blank lines are ignored

    let parsed: ParseResult;
    try {
      parsed = parseMessage(trimmed);
    } catch (err) {
      return renderError(null, ERROR_CODES.PARSE_ERROR, `Parse error: ${errorMessage(err)}`);
    }
    if (!parsed.valid) {
      return renderError(null, parsed.error.code, parsed.error.message);
    }
    const message: JsonRpcMessage = parsed.message;
    if (!isRequest(message)) return null; // notifications never get responses

    const id = message.id;
    try {
      switch (message.method) {
        case 'initialize':
          return renderResponse(id, INITIALIZE_RESULT);
        case 'notifications/initialized':
          // The spec sends this as a notification; if a client asks with an
          // id anyway, answering {} is friendlier than a protocol error.
          return renderResponse(id, {});
        case 'tools/list':
          return renderResponse(id, { tools: TOOLS });
        case 'ping':
          return renderResponse(id, {});
        case 'tools/call':
          return await this.handleToolCall(id, message.params);
        default:
          return renderError(id, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${message.method}`);
      }
    } catch (err) {
      return renderError(id, ERROR_CODES.INTERNAL_ERROR, `Internal error: ${errorMessage(err)}`);
    }
  }

  /**
   * Dispatch tools/call. Protocol-level problems (bad params, unknown tool)
   * are JSON-RPC -32602 errors; handler failures become isError tool results
   * so the server always keeps serving.
   */
  private async handleToolCall(id: JsonRpcId, params: unknown): Promise<string> {
    if (!isRecord(params) || typeof params['name'] !== 'string') {
      return renderError(
        id,
        ERROR_CODES.INVALID_PARAMS,
        'Invalid params: tools/call requires params.name (string) and optional params.arguments (object)',
      );
    }
    const name = params['name'];
    const handler = TOOL_HANDLERS[name];
    if (handler === undefined) {
      return renderError(id, ERROR_CODES.INVALID_PARAMS, `Unknown tool: ${name}`);
    }
    const args = params['arguments'] ?? {};
    if (!isRecord(args)) {
      return renderError(id, ERROR_CODES.INVALID_PARAMS, `Invalid params: arguments for tool "${name}" must be an object`);
    }
    try {
      const payload = await handler(args, { serverRoot: this.root, logger: this.logger });
      const text = scrubSecrets(JSON.stringify(scrubDeep(payload ?? {}), null, 2));
      return renderResponse(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      const message = errorMessage(err);
      this.logger.error(`tool "${name}" failed: ${message}`);
      return renderResponse(id, { content: [{ type: 'text', text: scrubSecrets(message) }], isError: true });
    }
  }

  /** Sequential read loop: one line fully handled before the next is read. */
  private async readLoop(): Promise<void> {
    const iterator = this.buildLineIterator();
    this.currentIterator = iterator;
    try {
      while (!this.stopped) {
        let next: IteratorResult<string, undefined>;
        try {
          next = await iterator.next();
        } catch (err) {
          this.logger.error(`input stream error: ${errorMessage(err)}`);
          break;
        }
        if (next.done === true) break;
        let response: string | null;
        try {
          response = await this.handleLine(next.value);
        } catch (err) {
          // Absolute safety net — handleLine maps every known failure itself.
          this.logger.error(`unexpected handler failure: ${errorMessage(err)}`);
          response = renderError(null, ERROR_CODES.INTERNAL_ERROR, 'Internal error');
        }
        if (response !== null) this.emit(response);
      }
    } finally {
      this.running = false;
      this.currentIterator = null;
    }
  }

  /** Write one response line (newline-delimited JSON). */
  private emit(line: string): void {
    try {
      this.output.write(line + '\n');
    } catch (err) {
      this.logger.error(`output write failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Normalize the configured input into an async iterator of lines.
   * Node streams go through readline; string iterables (sync or async) are
   * split on newlines with buffering for partial chunks.
   */
  private buildLineIterator(): AsyncIterableIterator<string> {
    const input = this.input;
    if (isNodeStream(input)) {
      const rl = createInterface({ input, crlfDelay: Infinity });
      return rl[Symbol.asyncIterator]();
    }
    if (typeof (input as AsyncIterable<string>)[Symbol.asyncIterator] === 'function') {
      return splitLines(input as AsyncIterable<string>);
    }
    if (typeof (input as unknown as Iterable<string>)[Symbol.iterator] === 'function') {
      return splitLinesFromSync((input as unknown as Iterable<string>)[Symbol.iterator]());
    }
    throw new Error('McpServer input must be a NodeJS.ReadableStream or an (async) iterable of strings');
  }
}

/** Split an async iterable of string chunks into newline-delimited lines. */
async function* splitLines(source: AsyncIterable<string>): AsyncIterableIterator<string> {
  let buffer = '';
  for await (const chunk of source) {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      yield buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) yield buffer;
}

/** Same as {@link splitLines} for synchronous iterables (e.g. arrays). */
async function* splitLinesFromSync(source: Iterator<string>): AsyncIterableIterator<string> {
  let buffer = '';
  for (;;) {
    const next = source.next();
    if (next.done === true) break;
    buffer += next.value;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      yield buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) yield buffer;
}

/** Narrow unknown input to a Node readable stream (readline-compatible). */
function isNodeStream(value: unknown): value is NodeReadable {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { on?: unknown })['on'] === 'function' &&
    typeof (value as { read?: unknown })['read'] === 'function'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
