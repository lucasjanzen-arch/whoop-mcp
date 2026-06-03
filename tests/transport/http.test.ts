/**
 * Tests for HTTP transport layer (Task 13a).
 *
 * Covers: bearer auth, safeTokenCompare, health endpoint,
 * connection limiting, CORS, graceful shutdown.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { safeTokenCompare, createHttpServer, type HttpServerOptions } from "../../src/transport/http.js";

// ---------------------------------------------------------------------------
// Helper: make HTTP requests to the test server
// ---------------------------------------------------------------------------

function request(
  server: http.Server,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      reject(new Error("Server not listening"));
      return;
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// safeTokenCompare
// ---------------------------------------------------------------------------

describe("safeTokenCompare", () => {
  it("returns true for matching tokens", () => {
    expect(safeTokenCompare("my-secret-token", "my-secret-token")).toBe(true);
  });

  it("returns false for non-matching tokens", () => {
    expect(safeTokenCompare("my-secret-token", "wrong-token")).toBe(false);
  });

  it("returns false for empty provided token", () => {
    expect(safeTokenCompare("", "my-secret-token")).toBe(false);
  });

  it("returns false for empty expected token", () => {
    expect(safeTokenCompare("my-secret-token", "")).toBe(false);
  });

  it("returns false when both are empty", () => {
    expect(safeTokenCompare("", "")).toBe(false);
  });

  it("handles tokens of different lengths", () => {
    expect(safeTokenCompare("short", "a-much-longer-token-value")).toBe(false);
  });

  it("handles unicode tokens", () => {
    expect(safeTokenCompare("tökën-🔑", "tökën-🔑")).toBe(true);
    expect(safeTokenCompare("tökën-🔑", "tökën-🔒")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP Server: Health endpoint
// ---------------------------------------------------------------------------

describe("HTTP Server", () => {
  let server: http.Server;
  let cleanup: (() => Promise<void>) | null = null;

  const defaultOptions: HttpServerOptions = {
    authToken: "test-token-abc123",
    port: 0, // dynamic port
  };

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  describe("/health endpoint", () => {
    beforeEach(async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;
    });

    it("returns { status: 'ok' } without auth", async () => {
      const res = await request(server, "/health");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status: string };
      expect(body.status).toBe("ok");
      // Should NOT include detailed info without auth
      expect(body).not.toHaveProperty("uptime");
    });

    it("returns detailed health with valid bearer token", async () => {
      const res = await request(server, "/health", {
        headers: { authorization: "Bearer test-token-abc123" },
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status: string; uptime: number };
      expect(body.status).toBe("ok");
      expect(body).toHaveProperty("uptime");
      expect(typeof body.uptime).toBe("number");
    });

    it("returns basic health with invalid bearer token", async () => {
      const res = await request(server, "/health", {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status: string };
      expect(body.status).toBe("ok");
      expect(body).not.toHaveProperty("uptime");
    });
  });

  // ---------------------------------------------------------------------------
  // Bearer auth on /mcp
  // ---------------------------------------------------------------------------

  describe("/mcp authentication", () => {
    beforeEach(async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;
    });

    it("returns 401 without authorization header", async () => {
      const res = await request(server, "/mcp", { method: "POST" });
      expect(res.status).toBe(401);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 401 with invalid bearer token", async () => {
      const res = await request(server, "/mcp", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 with non-Bearer scheme", async () => {
      const res = await request(server, "/mcp", {
        method: "POST",
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      });
      expect(res.status).toBe(401);
    });

    it("passes auth with valid bearer token (POST)", async () => {
      // Valid token should reach the transport handler (which may return 400
      // for invalid MCP payload, but NOT 401)
      const res = await request(server, "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token-abc123",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
      });
      // Transport will process it — should not be 401
      expect(res.status).not.toBe(401);
    });

    it("passes auth with valid bearer token (GET for SSE)", async () => {
      const res = await request(server, "/mcp", {
        method: "GET",
        headers: { authorization: "Bearer test-token-abc123" },
      });
      // Should not be 401 (may be 400 if no session established)
      expect(res.status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Connection limiting
  // ---------------------------------------------------------------------------

  describe("connection limiting", () => {
    it("returns 503 when max connections exceeded", async () => {
      // maxConnections=0 means ALL requests get rejected immediately
      const result = await createHttpServer({
        ...defaultOptions,
        maxConnections: 0,
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token-abc123",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(503);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("Service Unavailable");
    });
  });

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------

  describe("CORS", () => {
    it("denies CORS for unknown origins", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        allowedOrigins: ["https://allowed.example.com"],
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example.com" },
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("allows CORS for configured origins", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        allowedOrigins: ["https://allowed.example.com"],
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        method: "OPTIONS",
        headers: { origin: "https://allowed.example.com" },
      });
      expect(res.headers["access-control-allow-origin"]).toBe("https://allowed.example.com");
    });

    it("denies all origins when no allowedOrigins configured", async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        method: "OPTIONS",
        headers: { origin: "https://any.example.com" },
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  describe("graceful shutdown", () => {
    it("close() resolves and stops accepting connections", async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;

      // Server should be listening
      expect(server.listening).toBe(true);

      // Close should resolve
      await result.close();

      // Server should no longer be listening
      expect(server.listening).toBe(false);

      // Set cleanup to null since we already closed
      cleanup = null;
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown routes
  // ---------------------------------------------------------------------------

  describe("unknown routes", () => {
    beforeEach(async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;
    });

    it("returns 404 for unknown paths", async () => {
      const res = await request(server, "/unknown");
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Missing auth token at startup
  // ---------------------------------------------------------------------------

  describe("startup validation", () => {
    it("throws if authToken is empty", async () => {
      await expect(
        createHttpServer({ ...defaultOptions, authToken: "" })
      ).rejects.toThrow(/MCP_AUTH_TOKEN/);
    });
  });
});
