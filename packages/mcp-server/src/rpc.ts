/**
 * Minimal JSON-RPC 2.0 codec for the The-QA-Skill MCP stdio transport.
 *
 * The wire format is newline-delimited JSON: one JSON-RPC message per line.
 * This module is a dependency-free hand-rolled codec (no MCP SDK) covering
 * exactly what the server needs: parse a line, render a success response,
 * render an error response.
 *
 * Error codes (JSON-RPC 2.0 / MCP):
 *   -32700  Parse error      — line is not valid JSON
 *   -32600  Invalid Request  — valid JSON but not a JSON-RPC 2.0 message
 *   -32601  Method not found — unknown method on a request with an id
 *   -32602  Invalid params   — malformed tools/call params or unknown tool
 *   -32603  Internal error   — unexpected server failure
 */

/** A JSON-RPC identifier: string, number, or null (for unknown ids). */
export type JsonRpcId = string | number | null;

/** A JSON-RPC request — carries an id and expects a response. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

/** A JSON-RPC notification — no id, never answered. */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** Any JSON-RPC 2.0 message the server understands. */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

/** Standard JSON-RPC 2.0 error codes used by this server. */
export const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** Result of parsing one newline-delimited message. */
export type ParseResult =
  | { valid: true; message: JsonRpcRequest | JsonRpcNotification }
  | { valid: false; error: { code: (typeof ERROR_CODES)['PARSE_ERROR'] | (typeof ERROR_CODES)['INVALID_REQUEST']; message: string } };

/**
 * Parse one newline-delimited JSON-RPC 2.0 message.
 *
 * - Syntactically invalid JSON → invalid with -32700 (parse error).
 * - Valid JSON that is not a JSON-RPC 2.0 message object (wrong jsonrpc
 *   version, missing/non-string method, non-object payload, malformed id)
 *   → invalid with -32600 (invalid request) so callers can answer honestly.
 * - A message with an `id` member is a request; without one, a notification.
 */
export function parseMessage(line: string): ParseResult {
  const trimmed = line.trim();
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    return {
      valid: false,
      error: { code: ERROR_CODES.PARSE_ERROR, message: `Parse error: invalid JSON (${errorMessageLocal(err)})` },
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error: { code: ERROR_CODES.INVALID_REQUEST, message: 'Invalid Request: expected a JSON-RPC 2.0 message object' } };
  }
  const obj = raw as Record<string, unknown>;
  if (obj['jsonrpc'] !== '2.0') {
    return { valid: false, error: { code: ERROR_CODES.INVALID_REQUEST, message: 'Invalid Request: "jsonrpc" must be exactly "2.0"' } };
  }
  if (typeof obj['method'] !== 'string' || obj['method'].length === 0) {
    return { valid: false, error: { code: ERROR_CODES.INVALID_REQUEST, message: 'Invalid Request: "method" must be a non-empty string' } };
  }
  if ('id' in obj) {
    const id = obj['id'];
    if (id !== null && typeof id !== 'string' && typeof id !== 'number') {
      return { valid: false, error: { code: ERROR_CODES.INVALID_REQUEST, message: 'Invalid Request: "id" must be a string, number, or null' } };
    }
    if (typeof id === 'number' && !Number.isFinite(id)) {
      return { valid: false, error: { code: ERROR_CODES.INVALID_REQUEST, message: 'Invalid Request: "id" must be a finite number' } };
    }
  }
  const params = obj['params'];
  if (params !== undefined && params !== null && typeof params !== 'object') {
    return { valid: false, error: { code: ERROR_CODES.INVALID_REQUEST, message: 'Invalid Request: "params" must be an object or array when present' } };
  }
  const message: JsonRpcMessage = 'id' in obj
    ? { jsonrpc: '2.0', id: (obj['id'] as JsonRpcId), method: obj['method'], params }
    : { jsonrpc: '2.0', method: obj['method'], params };
  return { valid: true, message };
}

/**
 * Render a success response as a single-line JSON string (newline-delimited
 * JSON transport — the caller appends the newline).
 */
export function renderResponse(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

/**
 * Render an error response as a single-line JSON string. `id` may be null
 * when the request id could not be determined (e.g. parse errors).
 */
export function renderError(id: JsonRpcId | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * True when the parsed message is a request (carries an `id` member) and
 * therefore expects a response. Notifications never get responses.
 */
export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'id' in message;
}

function errorMessageLocal(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
