# Code Review Checkpoint 13: Task 15 — Cache + Write-Safety (v0.7.0)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-06-13
> **Scope:** Task 15 — unified `MemoryCache` (LRU + TTL + stampede/generation guard) replacing `ResourceCache`, opt-in client caching, token-refresh invalidation, and the `withPreview()` write-safety pattern
> **Test suite:** 740 tests passing (37 files), typecheck clean, build clean, lint clean

---

## Verdict: ✅ APPROVE

**Overview:** A clean, well-factored performance/architecture increment. The new `MemoryCache` is a focused, dependency-free data structure with correct LRU eviction, lazy TTL expiry, in-flight deduplication, and — notably — a generation guard that closes the exact race flagged in checkpoint-9 (an in-flight fetch resolving after `invalidateAll()` could repopulate stale data). Cache is wired as opt-in middleware at `WhoopClient.get()`, keeping tools/resources transparent. The write-safety pattern is a correctly-typed, pure utility with no premature tool registration. No Critical or Important issues. A few Minor items and Nits below.

---

## Critical Issues

None.

---

## Important Issues

None.

---

## Minor Issues

### 1. `clear()` does not purge the in-flight map — a post-clear reader can receive pre-clear data

- **File:** `src/cache/memory-cache.ts:124-134` (`clear`), `:145-171` (`getOrFetch`)
- **Problem:** `clear()` empties `store` and bumps `generation`, but leaves `inflight` intact. A `getOrFetch(key)` issued *after* `clear()` but *before* the pre-clear fetch settles will hit the still-present `inflight` entry and resolve with the **pre-clear** value (returned once, not cached thanks to the generation guard). In the token-refresh path this means a request arriving immediately after `cache.clear()` can be served data fetched microseconds before the refresh.
- **Impact:** Benign under the documented single-user / single-WHOOP-account assumption — the value is the same authenticated user's own data and is never persisted. There is **no cross-user leakage** (cache keys carry no token; the client holds one WHOOP account). Flagging for correctness clarity, not security.
- **Fix:** Either purge in-flight promises on clear so post-clear readers re-fetch, or document the behavior explicitly:
  ```typescript
  clear(): void {
    this.store.clear();
    this.inflight.clear(); // post-clear readers start a fresh fetch
    this.generation++;
  }
  ```
  Note: purging `inflight` only detaches new readers; the original awaiter still receives its result (the generation guard already prevents caching it). If the current transient-share behavior is intentional, add a sentence to the `clear()` doc comment describing it.

### 2. TTL constants imported from `resources` into the `tools` layer

- **File:** `src/tools/get-today.ts:21` (`import { DYNAMIC_TTL_MS, CYCLE_TTL_MS } from "../resources/index.js"`)
- **Problem:** `get-today` (a tool) now depends on `resources/index.ts` purely for two TTL constants, creating a tools→resources coupling that doesn't reflect a real domain dependency. The cache TTL policy is cross-cutting, not resource-specific.
- **Fix:** Move the shared TTLs (`DYNAMIC_TTL_MS`, `CYCLE_TTL_MS`, `PROFILE_TTL_MS`) into a neutral home — e.g. `src/cache/memory-cache.ts` or a small `src/cache/ttl.ts` — and have both `resources/index.ts` and `tools/get-today.ts` import from there. Also collapses the duplicate 5-minute literal shared with `DEFAULT_TTL_MS`.

### 3. `invalidateAll()` is dead code in `src/`

- **File:** `src/cache/memory-cache.ts:131-133`
- **Problem:** `invalidateAll()` is an alias for `clear()` carried over from the removed `ResourceCache` API, but nothing in `src/` calls it — the only invalidation site (`src/index.ts` token refresh) calls `cache.clear()` directly. It survives only via its own unit test.
- **Fix:** Either remove the alias (and its test) to shrink the public surface, or, if kept for semantic readability at future call sites, point the token-refresh site at `invalidateAll()` so the alias earns its place.

---

## Nits

### 1. `getOrFetch` conflates a cached `undefined` value with a miss

- **File:** `src/cache/memory-cache.ts:148-151`
- `get()` returns `undefined` for both "absent" and "stored `undefined`", so a fetcher that legitimately resolves to `undefined` would never cache-hit. Harmless here (WHOOP responses are always objects), but a one-line comment noting the assumption would prevent surprise if the cache is reused for nullable values.

### 2. Mixed casing for the idempotency key

- **File:** `src/tools/write-safety.ts:11, 50`
- The wire field is `idempotency_key` (snake_case, MCP/JSON convention) while the option is `idempotencyKey` (camelCase). Intentional and defensible, but a brief note in the `WithPreviewOptions` doc comment would save a double-take.

---

## What's Done Well

- **Generation guard resolves the checkpoint-9 race.** The prior review (checkpoint-9, Important #2) flagged that `invalidateAll()` could be silently undone by an in-flight request completing afterward. The new `generation` counter captured before the fetch and re-checked before `set()` closes this precisely, and `tests/cache/memory-cache.test.ts` proves it ("clear() prevents a stale in-flight fetch from repopulating the cache").
- **No token leakage in cache keys.** `cacheKey()` derives keys solely from path + alphabetically-sorted query params; the Bearer token lives only in request headers. The `?a=1&b=2` ≡ `?b=2&a=1` normalization is tested at both the cache and client layers.
- **Opt-in middleware at the right seam.** Caching is a per-request option on `WhoopClient.get()` with `doGet()` cleanly extracted, so tools/resources inherit caching transparently and collections (large, param-varied) are correctly left uncached to avoid LRU churn.
- **Write-safety is genuinely future-proofing, not speculation.** Pure generic utility, `crypto.randomUUID()` for the key, type-safe discriminated union with compile-time narrowing verified in tests, and — per spec — no write tools registered.
- **Strong, behavior-focused tests.** 17 cache + 9 write-safety tests cover TTL expiry, LRU ordering (get-as-use, set-as-use), stampede dedup, clear-during-inflight, error non-caching, and idempotency-key reuse.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 740 passing (37 files); cache + write-safety + client/resource integration all exercised |
| Build verified | ✅ | `tsc --noEmit` clean, `tsc` build clean |
| Lint | ✅ | `eslint src/ tests/` clean |
| Security checked | ✅ | No token/auth data in cache keys; CSPRNG idempotency key; single-account assumption holds — no cross-user leak path |
| Coverage | ✅ | memory-cache 97.75%, write-safety 100% (per author report; new files exceed the ≥90% gate) |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Minor | `clear()` leaves `inflight` intact — post-clear reader can receive pre-clear data; purge or document | backlog |
| 2 | Minor | Move shared TTL constants out of `resources` into a neutral cache module (tools→resources coupling) | backlog |
| 3 | Minor | Remove or wire up the dead `invalidateAll()` alias | backlog |
| 4 | Nit | Comment `getOrFetch` undefined-value conflation assumption | backlog |
| 5 | Nit | Document mixed `idempotency_key` / `idempotencyKey` casing | backlog |
