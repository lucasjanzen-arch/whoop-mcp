# Code Review Checkpoint 12: Task 13a — HTTP Transport + Auth Middleware

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-06-03
> **Scope:** Task 13a — HTTP transport with bearer-token auth, health endpoint, connection limiting, CORS, graceful shutdown
> **Test suite:** 524 tests passing (28 files), typecheck clean, build clean, lint clean

---

## Verdict: ✅ APPROVE with 1 Important issue

**Overview:** Clean, well-structured implementation that correctly uses raw `node:http` + SDK's `StreamableHTTPServerTransport` instead of adding an Express dependency. The security-critical `safeTokenCompare` is correctly implemented with SHA-256 hashing. One connection-tracking bug needs fixing before this code is deployed to production.

---

## Critical Issues

None.

---

## Important Issues

### 1. Double decrement of `activeConnections` on body parse failure

- **File:** `src/transport/http.ts:237-244`
- **Problem:** When JSON body parsing fails (invalid JSON or body too large), the code explicitly decrements `activeConnections` AND the previously-registered `res.on("close")` handler will also decrement it when the response ends. This double-decrement drives the counter negative over time, effectively disabling connection limiting.

  Scenario: A client sends 5 malformed requests → `activeConnections` becomes `-5` → the next 10 clients bypass the limit (need to reach `maxConnections` from `-5` instead of `0`).

- **Fix:** Remove the explicit `activeConnections--` in the catch block. The `res.on("close")` handler already handles cleanup for all code paths:

  ```typescript
  } catch {
    sendJson(res, 400, { error: "Bad Request", message: "Invalid JSON body" });
    // Don't decrement here — res.on("close") handles it
    return;
  }
  ```

  Alternatively, move the `res.on("close")` registration to AFTER the body parse succeeds, but that complicates the flow. Relying on the single `close` handler is simpler and guarantees exactly-once decrement.

---

## Suggestions

### 1. `trustProxy` stores IP but never uses it

- **File:** `src/transport/http.ts:184-187`
- The `_realIp` is stored on the request but never logged or used for rate limiting. This is dead code currently, though it makes sense as prep for Task 13b (structured logging). Consider adding a comment noting the intent, or defer the implementation to 13b.

### 2. No integration test proving MCP tools work over HTTP

- **File:** `tests/transport/http.test.ts`
- The tests verify auth, CORS, limits, and routing, but don't test that an actual MCP `initialize` → `tools/call` sequence works end-to-end. The acceptance criteria include "All 14 tools work identically over HTTP." Fair to defer to Task 13g (full verification), but worth noting.

### 3. CORS preflight returns 403 for unknown origins

- **File:** `src/transport/http.ts:99`
- Returning 403 on OPTIONS for unknown origins is valid but non-standard. Most servers return 204 without CORS headers (the browser handles denial). This works correctly either way — the browser will block the response regardless. No change needed.

---

## What's Done Well

- **`safeTokenCompare` is textbook-correct:** SHA-256 hash before `timingSafeEqual`, rejects empty strings, tested with unicode and differing lengths.
- **Clean separation of concerns:** CORS, auth, body parsing, and routing are each their own isolated function/block. Easy to understand and modify.
- **No Express dependency added:** Using raw `node:http` keeps the dependency tree minimal (project convention). The SDK transport does the heavy lifting.
- **Test coverage is thorough:** 22 tests cover auth, health, CORS, connection limits, graceful shutdown, unknown routes, and startup validation. All use port 0 as specified.
- **Defensive body size limit (1MB):** Prevents memory exhaustion attacks without adding a dependency.
- **`stdio.ts` extraction is minimal and correct:** 20 lines, clear single responsibility.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 22 tests, all passing, cover acceptance criteria |
| Build verified | ✅ | typecheck, lint, build all clean |
| Security checked | ✅ | SHA-256 token comparison, body size limit, CORS default-deny, auth on all /mcp |
| Coverage | ⚠️ | No integration test for full MCP flow over HTTP (deferred to 13g) |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | Double decrement of `activeConnections` on body parse error | Fix before merge |
| 2 | Suggestion | `trustProxy` _realIp is dead code — add comment or defer to 13b | Backlog |
| 3 | Suggestion | Add end-to-end MCP tool integration test over HTTP | Task 13g |
| 4 | Suggestion | CORS preflight 403 vs 204 for unknown origins | Backlog (no-op) |
