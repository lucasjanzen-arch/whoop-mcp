# Code Review Checkpoint 9: Task 11e — MCP Resources

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-05-29
> **Scope:** Task 11e — MCP Resources implementation (ResourceCache, 4 resource definitions, registration, integration)
> **Test suite:** 372 tests passing (21 files), typecheck clean, build clean, lint clean

---

## Verdict: ✅ APPROVE — 0 Critical, 2 Important, 3 Suggestions

**Overview:** Clean, well-structured implementation of MCP Resources with in-memory cache, TTL, and in-flight deduplication. The `ResourceCache` class is generic and reusable, resource definitions are declarative, and the integration with the existing server and entry point is minimal and non-disruptive. The 24 unit tests + 9 integration tests cover the key behaviors well. Two important gaps: missing test coverage for cache invalidation on token refresh, and a subtle race where `invalidateAll()` can be "undone" by an in-flight request completing afterward.

---

## Critical Issues

None.

---

## Important Issues

### 1. `invalidateAll()` does not cancel in-flight requests — stale data can re-populate a cleared cache

- **File:** `src/resources/index.ts:81-84`
- **Problem:** When `invalidateAll()` is called (on token refresh), it clears `this.cache` but intentionally leaves `this.inflight` untouched. If an in-flight request was already issued before the invalidation, its `.then()` callback will execute `this.cache.set(key, { data, expiry: Date.now() + ttlMs })`, repopulating the just-cleared cache with data that may have been fetched before the token refresh.

  **Practical risk assessment:** Low in the current system because:
  1. Token refresh means the *authentication* changed, not the user identity — data from the old token is identical to data from the new token (same user).
  2. The WHOOP API client handles 401 internally (retry with new token), so if the in-flight request got a 401, it would retry with the new token before resolving — the data stored would actually be fresh.
  3. If the old token was still valid during the request, the data is correct regardless.

  However, the **cache invariant** ("`invalidateAll()` ensures next read fetches fresh data") is violated when an in-flight request completes after invalidation. This could surprise future maintainers.

- **Fix (recommended):** Track a generation counter to discard results from pre-invalidation fetches:
  ```typescript
  export class ResourceCache {
    private cache = new Map<string, CacheEntry<unknown>>();
    private inflight = new Map<string, Promise<unknown>>();
    private generation = 0;

    async getOrFetch<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
      const entry = this.cache.get(key);
      if (entry && Date.now() < entry.expiry) {
        return entry.data as T;
      }

      const existing = this.inflight.get(key);
      if (existing) {
        return existing as Promise<T>;
      }

      const fetchGeneration = this.generation;
      const promise = fetcher().then((data) => {
        // Only cache if no invalidation occurred since fetch started
        if (this.generation === fetchGeneration) {
          this.cache.set(key, { data, expiry: Date.now() + ttlMs });
        }
        this.inflight.delete(key);
        return data;
      }).catch((error: unknown) => {
        this.inflight.delete(key);
        throw error;
      });

      this.inflight.set(key, promise);
      return promise;
    }

    invalidateAll(): void {
      this.cache.clear();
      this.generation++;
    }
  }
  ```
  This adds 3 lines of code and makes the invalidation semantics airtight without cancelling in-flight requests (callers still get their data).

### 2. No test coverage for cache invalidation on token refresh

- **File:** `tests/index.test.ts`
- **Problem:** The `setupHappyPath()` helper sets `mockCreateWhoopServer.mockReturnValue({ server: mockServer, resourceCache: null })` — the `resourceCache` is always `null` in tests. This means the `resourceCacheRef?.invalidateAll()` line in the `onTokenRefresh` callback (src/index.ts:78) is never exercised. The feature's primary integration point — "token refresh invalidates the resource cache" — has zero test coverage.

- **Fix:** Add a test that provides a mock `resourceCache` and verifies `invalidateAll()` is called during token refresh:
  ```typescript
  it("invalidates resource cache on token refresh", async () => {
    const mockInvalidateAll = vi.fn();
    const mockServer = { connect: mockConnect };
    mockCreateWhoopServer.mockReturnValue({
      server: mockServer,
      resourceCache: { invalidateAll: mockInvalidateAll },
    });
    mockConnect.mockResolvedValue(undefined);
    MockStdioServerTransport.mockReturnValue(mockStdioTransportInstance);
    mockAuthenticate.mockResolvedValue("test-access-token");
    mockCreateWhoopClient.mockReturnValue({ get: vi.fn() });

    const storedTokens = {
      access_token: "old", refresh_token: "refresh-tok",
      expires_at: Date.now() - 1000, token_type: "Bearer",
    };
    mockLoadTokens.mockResolvedValue(storedTokens);
    mockRefreshAccessToken.mockResolvedValue({
      access_token: "new", expires_in: 3600, token_type: "Bearer", scope: "read:recovery",
    });
    mockToOAuthTokens.mockReturnValue({ ...storedTokens, access_token: "new" });
    mockSaveTokens.mockResolvedValue(undefined);

    const { main } = await importMain();
    await main();

    const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
      onTokenRefresh: () => Promise<string>;
    };
    await clientOptions.onTokenRefresh();

    expect(mockInvalidateAll).toHaveBeenCalledOnce();
  });
  ```

---

## Suggestions

### 1. No test for `WHOOP_MCP_DISABLE_RESOURCES=1` env var in `index.test.ts`

- **File:** `tests/index.test.ts`
- The `disableResources` option is derived from `process.env.WHOOP_MCP_DISABLE_RESOURCES === "1"` in `src/index.ts:86`, and the server integration test in `tests/server.test.ts` verifies the option works. However, there's no test in `index.test.ts` that sets the env var and asserts `createWhoopServer` is called with `{ disableResources: true }`. Consider adding:
  ```typescript
  it("passes disableResources: true when env var is set", async () => {
    setupHappyPath();
    process.env.WHOOP_MCP_DISABLE_RESOURCES = "1";
    const { main } = await importMain();
    await main();
    expect(mockCreateWhoopServer).toHaveBeenCalledWith(expect.anything(), { disableResources: true });
  });
  ```

### 2. Resource fetchers use `unknown[]` type assertion — consider reusing API types

- **File:** `src/resources/index.ts:108-111`
- The collection resource fetchers cast the API response as `{ records: unknown[] }`:
  ```typescript
  const result = await client.get<{ records: unknown[] }>("/v2/recovery?limit=1");
  ```
  The project already has typed `RecoveryCollection`, `SleepCollection`, etc. in `src/api/types.ts`. Using those types would provide compile-time safety that the resource fetchers stay in sync with the API response shape:
  ```typescript
  const result = await client.get<RecoveryCollection>("/v2/recovery?limit=1");
  ```
  This is optional since the data flows through JSON serialization anyway, but it would catch endpoint/type drift at compile time.

### 3. Consider adding a test for concurrent reads where the first errors — second caller also gets the error

- **File:** `tests/resources/index.test.ts`
- The existing test "propagates fetcher errors and cleans up inflight" verifies that a single caller gets the error and the inflight is cleaned up. But the dedup test only covers the success path. Consider adding a test where two concurrent callers share an in-flight request that rejects — both should receive the rejection:
  ```typescript
  it("propagates errors to all concurrent callers sharing an in-flight request", async () => {
    const cache = new ResourceCache();
    let rejectPromise: (err: Error) => void;
    const fetcher = vi.fn().mockImplementation(
      () => new Promise((_, reject) => { rejectPromise = reject; })
    );
    const p1 = cache.getOrFetch("key1", 5000, fetcher);
    const p2 = cache.getOrFetch("key1", 5000, fetcher);
    rejectPromise!(new Error("boom"));
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");
  });
  ```

---

## What's Done Well

- **Clean architecture:** `ResourceCache` is a focused, generic utility with no WHOOP-specific logic. Resource definitions are declarative data. `registerResources` is the thin wiring layer. This separation makes testing easy and the design extensible (adding a 5th resource = one object in the array).

- **In-flight deduplication is elegant:** Sharing the same Promise for concurrent reads to the same key is the textbook pattern for this problem. The cleanup in both `.then()` and `.catch()` prevents memory leaks and stale in-flight entries.

- **Non-throwing resource reads:** Returning `{ error: message }` instead of throwing ensures that one broken resource doesn't crash the MCP server or break other resources. This follows the MCP SDK's expectation that `resources/read` returns content (not exceptions).

- **Error logging to stderr:** `console.error(...)` in the catch block provides observability without polluting stdout (which is the MCP stdio channel). This is a pattern the project consistently follows.

- **`disableResources` escape hatch:** The env var and option allow users to opt out of resource registration without code changes — useful for debugging, backwards compatibility, and environments where resource reads would fail (e.g., no network).

- **Integration test completeness:** The `tests/server.test.ts` resource tests use the real MCP SDK Client+InMemoryTransport, verifying the full resource registration → list → read flow. This catches SDK integration issues that unit tests with mock servers would miss.

- **Breaking API change handled correctly:** `createWhoopServer` now returns `WhoopServer { server, resourceCache }` — all callers (tests, index.ts) are updated. The `server.test.ts` destructures with `const { server } = createWhoopServer(...)` showing minimal disruption.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 24 unit tests (cache, definitions, registration) + 9 integration tests (MCP SDK Client). Good coverage of success, error, cache hit, TTL expiry, dedup, and disable paths. |
| Build verified | ✅ | `tsc` clean, no errors |
| Typecheck verified | ✅ | `tsc --noEmit` clean |
| Lint verified | ✅ | ESLint clean |
| Security checked | ✅ | No new input boundaries. Resources use existing authenticated client. No secrets exposed. |
| Performance checked | ✅ | 4-key cache bounded by design. In-flight dedup prevents thundering herd. TTLs appropriate (5 min dynamic, 1 hr profile). |
| Coverage | ⚠️ | Cache invalidation on token refresh path untested (Important #2). Concurrent error propagation untested (Suggestion #3). |
| Race condition analysis | ⚠️ | invalidateAll + in-flight completion race is theoretically present but practically safe (Important #1). |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | `invalidateAll()` can be undone by in-flight completion — add generation counter | Task 11e patch |
| 2 | Important | No test for cache invalidation on token refresh in index.test.ts | Task 11e patch |
| 3 | Suggestion | No test for `WHOOP_MCP_DISABLE_RESOURCES=1` env var in index.test.ts | Backlog |
| 4 | Suggestion | Resource fetchers use `unknown[]` — could use typed API response types | Backlog |
| 5 | Suggestion | Add concurrent error propagation test for in-flight dedup | Backlog |
