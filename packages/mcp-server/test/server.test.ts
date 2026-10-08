/**
 * Protocol tests for McpServer.handleLine and the start/stop read loop:
 * handshake shape, tools/list contract, dispatch, error mapping, ordering,
 * and crash-safety.
 */
import { describe, expect, it } from 'vitest';
import { McpServer } from '../src/server.js';
import { MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../src/version.js';

const EXPECTED_TOOLS = new Set([
  'discover_project',
  'analyze_risk',
  'list_relevant_tests',
  'generate_tests',
  'run_tests',
  'get_failure_evidence',
  'triage_failure',
  'propose_test_heal',
  'analyze_flake',
  'generate_quality_report',
  'evaluate_release',
  'verify_claim',
  'route_task',
]);

/** A server wired to an empty input and a capturing output (handleLine only). */
function makeServer(): { server: McpServer; written: string[] } {
  const written: string[] = [];
  const server = new McpServer({
    input: (async function* empty(): AsyncGenerator<string> {
      // ends immediately — start() is never called in these tests
    })(),
    output: { write(chunk: string) { written.push(chunk); } },
  });
  return { server, written };
}

/** Send a value through handleLine; returns the parsed response (or null). */
async function send(server: McpServer, message: unknown): Promise<Record<string, unknown> | null> {
  const line = typeof message === 'string' ? message : JSON.stringify(message);
  const raw = await server.handleLine(line);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

describe('McpServer.handleLine — handshake and protocol', () => {
  it('answers initialize with the documented handshake shape', async () => {
    const { server } = makeServer();
    const res = await send(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res).not.toBeNull();
    const result = res?.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.serverInfo).toEqual({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    expect(result.serverInfo).toEqual({ name: 'the-qa-skill-mcp', version: '0.1.0' });
    expect(result.instructions).toContain('deterministic-first QA tools');
    expect(result.instructions).toContain('xShredo.dev');
    expect(res?.id).toBe(1);
  });

  it('gives no response for notifications/initialized', async () => {
    const { server } = makeServer();
    expect(await server.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeNull();
  });

  it('ignores blank and whitespace-only lines', async () => {
    const { server } = makeServer();
    expect(await server.handleLine('')).toBeNull();
    expect(await server.handleLine('   \t  ')).toBeNull();
  });

  it('answers ping with an empty result', async () => {
    const { server } = makeServer();
    const res = await send(server, { jsonrpc: '2.0', id: 'p', method: 'ping' });
    expect(res?.result).toEqual({});
    expect(res?.id).toBe('p');
  });

  it('maps unknown methods to -32601 echoing the id', async () => {
    const { server } = makeServer();
    const res = await send(server, { jsonrpc: '2.0', id: 9, method: 'resources/list' });
    const err = res?.error as { code: number; message: string };
    expect(err.code).toBe(-32601);
    expect(err.message).toContain('resources/list');
    expect(res?.id).toBe(9);
  });

  it('maps malformed JSON lines to -32700 with null id', async () => {
    const { server } = makeServer();
    const res = await send(server, 'this is not json');
    const err = res?.error as { code: number; message: string };
    expect(err.code).toBe(-32700);
    expect(res?.id).toBeNull();
  });

  it('maps structurally invalid requests to -32600', async () => {
    const { server } = makeServer();
    const res = await send(server, { jsonrpc: '2.0', id: 3 });
    expect(((res?.error as { code: number }).code)).toBe(-32600);
  });

  it('responds on a single line (newline-delimited transport)', async () => {
    const { server } = makeServer();
    const raw = await server.handleLine('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('\n');
    expect(JSON.parse(raw as string).jsonrpc).toBe('2.0');
  });
});

describe('McpServer.handleLine — tools/list contract', () => {
  it('lists exactly the 13 documented tools with usable schemas', async () => {
    const { server } = makeServer();
    const res = await send(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (res?.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools).toHaveLength(13);
    expect(new Set(tools.map((t) => t.name))).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect((tool.description as string).length).toBeGreaterThan(20);
      const schema = tool.inputSchema as { type: string; properties: Record<string, unknown>; required: string[] };
      expect(schema.type).toBe('object');
      expect(Object.keys(schema.properties).length).toBeGreaterThan(0);
      expect(Array.isArray(schema.required)).toBe(true);
    }
  });
});

describe('McpServer.handleLine — tools/call dispatch', () => {
  it('returns -32602 for a missing tool name', async () => {
    const { server } = makeServer();
    const res = await send(server, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} });
    expect((res?.error as { code: number }).code).toBe(-32602);
  });

  it('returns -32602 for an unknown tool', async () => {
    const { server } = makeServer();
    const res = await send(server, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'not_a_tool' } });
    expect((res?.error as { code: number }).code).toBe(-32602);
    expect((res?.error as { message: string }).message).toContain('not_a_tool');
  });

  it('returns -32602 for non-object arguments', async () => {
    const { server } = makeServer();
    const res = await send(server, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ping_tool', arguments: 'nope' } });
    expect((res?.error as { code: number }).code).toBe(-32602);
  });

  it('turns tool failures into isError results and keeps serving', async () => {
    const { server } = makeServer();
    const failed = await send(server, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'analyze_flake', arguments: { input: { testId: 't1', outcomes: [{ status: 'exploded', timestamp: '2025-01-01T00:00:00Z' }] } } },
    });
    const failedResult = failed?.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(failedResult.isError).toBe(true);
    expect(failedResult.content[0].type).toBe('text');
    expect(failedResult.content[0].text).toContain('status');

    // The loop is still alive: the very next request succeeds.
    const next = await send(server, { jsonrpc: '2.0', id: 8, method: 'ping' });
    expect(next?.result).toEqual({});
  });
});

describe('McpServer start/stop — sequential read loop', () => {
  it('processes lines sequentially and preserves response order', async () => {
    const written: string[] = [];
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ];
    const server = new McpServer({
      input: [lines.map((l) => JSON.stringify(l)).join('\n')],
      output: { write(chunk: string) { written.push(chunk); } },
    });
    await server.start();
    expect(written).toHaveLength(3);
    expect(written.map((l) => JSON.parse(l).id)).toEqual([1, 2, 3]);
    expect(JSON.parse(written[1] as string).result.tools).toHaveLength(13);
    expect(server.isRunning).toBe(false);
  });

  it('reassembles partial-line chunks and skips blank lines inside the stream', async () => {
    const written: string[] = [];
    // One JSON line split across two chunks (no newline in between), followed
    // by a blank line and a second complete line.
    const server = new McpServer({
      input: ['{"jsonrpc":"2.0","id":1,', '  "method":"ping"}\n', '\n', '{"jsonrpc":"2.0","id":2,"method":"ping"}\n'],
      output: { write(chunk: string) { written.push(chunk); } },
    });
    await server.start();
    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0] as string).id).toBe(1);
    expect(JSON.parse(written[1] as string).id).toBe(2);
  });

  it('stop() ends start() early on a still-open input', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    async function* openInput(): AsyncGenerator<string> {
      yield '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';
      await gate;
    }
    const written: string[] = [];
    const server = new McpServer({
      input: openInput(),
      output: { write(chunk: string) { written.push(chunk); } },
    });
    const started = server.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(written).toHaveLength(1);
    expect(server.isRunning).toBe(true);

    const stopped = server.stop();
    release();
    await Promise.all([started, stopped]);
    expect(server.isRunning).toBe(false);
  });
});
