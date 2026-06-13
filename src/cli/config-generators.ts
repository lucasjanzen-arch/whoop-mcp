/**
 * Pure functions for generating MCP client configuration.
 *
 * No I/O — all functions take inputs and return objects/strings. The wizard
 * (src/cli/setup.ts) handles file reads, writes, and prompting.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClientTarget = "claude-desktop" | "claude-code" | "codex" | "copilot";

export interface ServerEnv {
  readonly WHOOP_CLIENT_ID: string;
  readonly WHOOP_CLIENT_SECRET: string;
}

export interface ClaudeDesktopServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: ServerEnv;
}

export interface ClaudeDesktopConfig {
  mcpServers?: Record<string, ClaudeDesktopServerEntry>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Config paths
// ---------------------------------------------------------------------------

/**
 * OS-specific path to Claude Desktop's `claude_desktop_config.json`.
 *
 * - macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 * - Windows: %APPDATA%/Claude/claude_desktop_config.json
 * - Linux:   ~/.config/Claude/claude_desktop_config.json
 */
export function claudeDesktopConfigPath(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32": {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "Claude", "claude_desktop_config.json");
    }
    default:
      return join(home, ".config", "Claude", "claude_desktop_config.json");
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const SERVER_NAME = "whoop";

/**
 * Build the server entry for Claude Desktop's `mcpServers` map.
 * Uses `npx -y whoop-ai-mcp` so users don't need a global install.
 */
export function generateClaudeDesktopEntry(env: ServerEnv): ClaudeDesktopServerEntry {
  return {
    command: "npx",
    args: ["-y", "whoop-ai-mcp"],
    env: {
      WHOOP_CLIENT_ID: env.WHOOP_CLIENT_ID,
      WHOOP_CLIENT_SECRET: env.WHOOP_CLIENT_SECRET,
    },
  };
}

/**
 * Merge a new whoop server entry into an existing Claude Desktop config,
 * preserving any other configured MCP servers and top-level keys.
 */
export function mergeClaudeDesktopConfig(
  existing: ClaudeDesktopConfig | null,
  entry: ClaudeDesktopServerEntry,
  serverName: string = SERVER_NAME
): ClaudeDesktopConfig {
  const base: ClaudeDesktopConfig = existing ? { ...existing } : {};
  base.mcpServers = {
    ...(base.mcpServers ?? {}),
    [serverName]: entry,
  };
  return base;
}

/**
 * Generate the `claude mcp add` shell command for Claude Code.
 * Single-quoted env values; values are validated by the wizard before reaching here.
 */
export function generateClaudeCodeCommand(env: ServerEnv): string {
  const id = shellQuote(env.WHOOP_CLIENT_ID);
  const secret = shellQuote(env.WHOOP_CLIENT_SECRET);
  return `claude mcp add ${SERVER_NAME} -- npx -y whoop-ai-mcp -e WHOOP_CLIENT_ID=${id} -e WHOOP_CLIENT_SECRET=${secret}`;
}

/**
 * Generate the `codex mcp add` shell command for the OpenAI Codex CLI.
 * Registers the server in `~/.codex/config.toml` under `[mcp_servers.whoop]`.
 * Single-quoted env values; values are validated by the wizard before reaching here.
 */
export function generateCodexCommand(env: ServerEnv): string {
  const id = shellQuote(env.WHOOP_CLIENT_ID);
  const secret = shellQuote(env.WHOOP_CLIENT_SECRET);
  return `codex mcp add ${SERVER_NAME} --env WHOOP_CLIENT_ID=${id} --env WHOOP_CLIENT_SECRET=${secret} -- npx -y whoop-ai-mcp`;
}

/**
 * Generate the `code --add-mcp` shell command for GitHub Copilot in VS Code.
 * The flag accepts a JSON server definition; the JSON is single-quoted for the
 * shell. Values are validated by the wizard before reaching here.
 */
export function generateCopilotCommand(env: ServerEnv): string {
  const payload = JSON.stringify({
    name: SERVER_NAME,
    command: "npx",
    args: ["-y", "whoop-ai-mcp"],
    env: {
      WHOOP_CLIENT_ID: env.WHOOP_CLIENT_ID,
      WHOOP_CLIENT_SECRET: env.WHOOP_CLIENT_SECRET,
    },
  });
  return `code --add-mcp ${shellQuote(payload)}`;
}

/**
 * Single-quote a value for safe inclusion in a POSIX shell command,
 * escaping any embedded single quotes.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
