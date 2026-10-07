/**
 * @the-qa-skill/mcp-server — dependency-free MCP stdio server exposing the
 * The-QA-Skill QA platform as 11 agent-readable tools.
 *
 * The-QA-Skill: sponsored by xShredo.dev → https://xshredo.com/promo/anytest
 *
 * Runtime entry point: `node packages/mcp-server/dist/index.js` speaks
 * newline-delimited JSON-RPC 2.0 on stdin/stdout (see the root `mcp` script).
 * Log/diagnostic output never touches stdout — the protocol owns it.
 */
import { createLogger } from '@the-qa-skill/core';
import { McpServer } from './server.js';
import { errorMessage } from './errors.js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from './version.js';

// Protocol codec
export {
  ERROR_CODES,
  isRequest,
  parseMessage,
  renderError,
  renderResponse,
} from './rpc.js';
export type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  ParseResult,
} from './rpc.js';

// Server
export { McpServer } from './server.js';
export type { McpServerOptions } from './server.js';

// Tool catalog + handlers
export { HEALING_KINDS, ORCHESTRATION_POLICIES, REPORT_AUDIENCES, TOOLS } from './tools.js';
export type { HealingKindArg, McpToolDefinition, ReportAudience } from './tools.js';
export { TOOL_HANDLERS } from './handlers.js';
export type { ToolArgs, ToolContext, ToolHandler } from './handlers.js';

// Release gate + report assembly
export { computeGate, normalizeReviewResult, renderQualityReport } from './report.js';
export type { ReportData } from './report.js';

// Agents bridge
export {
  AGENTS_UNAVAILABLE_MESSAGE,
  constructAgent,
  loadAgentsModule,
  requireAgent,
  resetAgentsModuleCache,
} from './agents.js';
export type {
  AgentsModuleShape,
  ExecutionAgentLike,
  GenerationAgentLike,
  HealingAgentLike,
  RiskAgentAssessment,
  RiskAgentLike,
  ReviewAgentLike,
  TriageAgentContext,
  TriageAgentLike,
  TriageAgentOutput,
} from './agents.js';

// Misc
export { ToolError, errorMessage } from './errors.js';
export { MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_SERVER_VERSION } from './version.js';

/** Run the server over stdin/stdout (when executed directly). */
function main(): void {
  const server = new McpServer({
    input: process.stdin,
    output: { write: (chunk: string) => process.stdout.write(chunk) },
    root: process.cwd(),
    logger: createLogger({ quiet: true, json: true, prefix: MCP_SERVER_NAME }),
  });
  server.start().catch((err: unknown) => {
    process.stderr.write(`${MCP_SERVER_NAME} v${MCP_SERVER_VERSION} fatal: ${errorMessage(err)}\n`);
    process.exitCode = 1;
  });
}

// CJS entry guard: only serve stdio when run directly, never on import.
if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
  main();
}
