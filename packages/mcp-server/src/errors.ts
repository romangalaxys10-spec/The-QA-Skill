/**
 * Error type thrown by MCP tool handlers. A thrown ToolError is always
 * converted into a tool result with `isError: true` — it never crashes the
 * server loop or surfaces as a protocol-level failure.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
