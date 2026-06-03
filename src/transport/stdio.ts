/**
 * Stdio transport setup.
 *
 * Extracted from index.ts to allow transport selection (stdio vs http vs both).
 * This module handles the stdio MCP transport connection.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Connect the MCP server to the stdio transport (stdin/stdout).
 *
 * stdout is reserved for the MCP protocol — all logging must go to stderr.
 */
export async function connectStdioTransport(server: McpServer): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}
