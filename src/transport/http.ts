/**
 * HTTP transport for the WHOOP MCP server.
 *
 * Provides bearer-token authenticated HTTP access to the MCP server
 * using the SDK's StreamableHTTPServerTransport.
 *
 * All logging goes to stderr — stdout is reserved for stdio MCP channel.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpServerOptions {
  /** Bearer token required for /mcp routes */
  authToken: string;
  /** Port to listen on (0 = dynamic, used in tests) */
  port: number;
  /** Hostname to bind to (default: 0.0.0.0) */
  host?: string;
  /** Maximum concurrent connections (default: 5) */
  maxConnections?: number;
  /** Allowed CORS origins (default: deny all) */
  allowedOrigins?: string[];
  /** Whether to trust proxy headers (default: false) */
  trustProxy?: boolean;
}

export interface HttpServerResult {
  server: Server;
  transport: StreamableHTTPServerTransport;
  /** Gracefully close the server and drain connections */
  close: () => Promise<void>;
}

export interface HealthResponse {
  status: "ok";
  uptime?: number;
  version?: string;
}

// ---------------------------------------------------------------------------
// safeTokenCompare — SHA-256 hash comparison (no length oracle)
// ---------------------------------------------------------------------------

/**
 * Compare two tokens using SHA-256 hashing + timing-safe comparison.
 * Hashing first ensures constant-time comparison regardless of token length.
 * Returns false for empty strings (avoids vacuous truth).
 */
export function safeTokenCompare(provided: string, expected: string): boolean {
  if (!provided || !expected) {
    return false;
  }
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  return parts[1] ?? null;
}

// ---------------------------------------------------------------------------
// CORS handling
// ---------------------------------------------------------------------------

function handleCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: string[]
): boolean {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(origin && allowedOrigins.includes(origin) ? 204 : 403);
    res.end();
    return true; // request fully handled
  }

  return false; // not a preflight, continue processing
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Body parser (reads raw body for POST requests)
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1024 * 1024; // 1MB limit

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// createHttpServer
// ---------------------------------------------------------------------------

/**
 * Create an HTTP server with bearer-token auth for the MCP transport.
 *
 * The server exposes:
 * - POST /mcp — MCP protocol (requires bearer token)
 * - GET /mcp — SSE stream (requires bearer token)
 * - DELETE /mcp — Session termination (requires bearer token)
 * - GET /health — Health check (public: basic, authed: detailed)
 *
 * @throws Error if authToken is empty
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerResult> {
  const {
    authToken,
    port,
    host = "0.0.0.0",
    maxConnections = 5,
    allowedOrigins = [],
  } = options;

  if (!authToken) {
    throw new Error(
      "MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http or MCP_TRANSPORT=both. " +
        "Set it to a secure random string (32+ characters recommended)."
    );
  }

  // Track active connections for limiting
  let activeConnections = 0;
  const startTime = Date.now();

  // Create the SDK transport (stateful with session IDs)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // Create HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // CORS handling
    if (handleCors(req, res, allowedOrigins)) {
      return; // preflight handled
    }

    // Route: /health
    if (pathname === "/health") {
      const token = extractBearerToken(req);
      const isAuthed = token !== null && safeTokenCompare(token, authToken);

      const health: HealthResponse = { status: "ok" };
      if (isAuthed) {
        health.uptime = Math.floor((Date.now() - startTime) / 1000);
      }
      sendJson(res, 200, health);
      return;
    }

    // Route: /mcp (all methods)
    if (pathname === "/mcp") {
      // Auth check
      const token = extractBearerToken(req);
      if (!token || !safeTokenCompare(token, authToken)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      // Connection limit check
      if (activeConnections >= maxConnections) {
        sendJson(res, 503, { error: "Service Unavailable", message: "Maximum connections reached" });
        return;
      }

      // Track connection
      activeConnections++;
      res.on("close", () => {
        activeConnections--;
      });

      // Parse body for POST requests
      let parsedBody: unknown = undefined;
      if (req.method === "POST") {
        try {
          const rawBody = await readBody(req);
          parsedBody = JSON.parse(rawBody) as unknown;
        } catch {
          sendJson(res, 400, { error: "Bad Request", message: "Invalid JSON body" });
          return;
        }
      }

      // Delegate to SDK transport
      try {
        await transport.handleRequest(req, res, parsedBody);
      } catch (error: unknown) {
        // If response hasn't been sent yet
        if (!res.headersSent) {
          const message = error instanceof Error ? error.message : "Internal server error";
          sendJson(res, 500, { error: "Internal Server Error", message });
        }
      }
      return;
    }

    // Unknown routes
    sendJson(res, 404, { error: "Not Found" });
  });

  // Start listening
  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      resolve();
    });
  });

  // Graceful shutdown
  const close = async (): Promise<void> => {
    await transport.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return { server, transport, close };
}
