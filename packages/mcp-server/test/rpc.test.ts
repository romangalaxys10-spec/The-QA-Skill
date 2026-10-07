/**
 * Tests for the hand-rolled JSON-RPC 2.0 codec (src/rpc.ts).
 */
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, isRequest, parseMessage, renderError, renderResponse } from '../src/rpc.js';

describe('parseMessage', () => {
  it('parses a valid request with id, method, and params', () => {
    const result = parseMessage('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ping"}}');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(isRequest(result.message)).toBe(true);
    if (!isRequest(result.message)) return;
    expect(result.message.id).toBe(7);
    expect(result.message.method).toBe('tools/call');
    expect(result.message.params).toEqual({ name: 'ping' });
  });

  it('parses a notification (no id member)', () => {
    const result = parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(isRequest(result.message)).toBe(false);
    expect(result.message.method).toBe('notifications/initialized');
  });

  it('accepts string ids and null ids (both are requests)', () => {
    for (const line of [
      '{"jsonrpc":"2.0","id":"abc","method":"ping"}',
      '{"jsonrpc":"2.0","id":null,"method":"ping"}',
    ]) {
      const result = parseMessage(line);
      expect(result.valid).toBe(true);
      if (result.valid) expect(isRequest(result.message)).toBe(true);
    }
  });

  it('rejects syntactically invalid JSON with -32700', () => {
    const result = parseMessage('{jsonrpc:2.0');
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe(ERROR_CODES.PARSE_ERROR);
    expect(result.error.message).toContain('Parse error');
  });

  it('rejects non-object payloads with -32600', () => {
    for (const line of ['42', '"hello"', 'true', 'null', '[1,2,3]']) {
      const result = parseMessage(line);
      expect(result.valid).toBe(false);
      if (result.valid) continue;
      expect(result.error.code).toBe(ERROR_CODES.INVALID_REQUEST);
    }
  });

  it('rejects wrong jsonrpc version with -32600', () => {
    const result = parseMessage('{"jsonrpc":"1.0","id":1,"method":"ping"}');
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe(ERROR_CODES.INVALID_REQUEST);
  });

  it('rejects a missing or non-string method with -32600', () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":1}').valid).toBe(false);
    expect(parseMessage('{"jsonrpc":"2.0","id":1,"method":42}').valid).toBe(false);
    const result = parseMessage('{"jsonrpc":"2.0","id":1,"method":""}');
    expect(result.valid).toBe(false);
  });

  it('rejects malformed ids with -32600', () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":{"deep":1},"method":"ping"}').valid).toBe(false);
    expect(parseMessage('{"jsonrpc":"2.0","id":[1],"method":"ping"}').valid).toBe(false);
  });

  it('rejects primitive params with -32600', () => {
    const result = parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping","params":42}');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe(ERROR_CODES.INVALID_REQUEST);
  });
});

describe('renderResponse / renderError', () => {
  it('renders a single-line response preserving id and result', () => {
    const line = renderResponse('abc', { tools: [] });
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ jsonrpc: '2.0', id: 'abc', result: { tools: [] } });
  });

  it('renders errors with code and message, id may be null', () => {
    const line = renderError(null, ERROR_CODES.PARSE_ERROR, 'Parse error: nope');
    expect(JSON.parse(line)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error: nope' },
    });
  });

  it('uses the documented JSON-RPC error codes', () => {
    expect(ERROR_CODES.PARSE_ERROR).toBe(-32700);
    expect(ERROR_CODES.INVALID_REQUEST).toBe(-32600);
    expect(ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
    expect(ERROR_CODES.INVALID_PARAMS).toBe(-32602);
    expect(ERROR_CODES.INTERNAL_ERROR).toBe(-32603);
  });

  it('isRequest separates requests from notifications', () => {
    const request = parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    const notification = parseMessage('{"jsonrpc":"2.0","method":"ping"}');
    expect(request.valid && isRequest(request.message)).toBe(true);
    expect(notification.valid && !isRequest(notification.message)).toBe(true);
  });
});
