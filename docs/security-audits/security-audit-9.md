# Security Audit Report #9

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-06-13
> **Scope:** Task 15 (v0.7.0 performance/architecture) — uncommitted caching + token-refresh changes.
> Files audited:
> - `src/cache/memory-cache.ts` (new — LRU + TTL cache, in-flight dedup)
> - `src/api/client.ts` (opt-in per-request caching, `cacheKey`)
> - `src/index.ts` (app-level cache wiring + `cache.clear()` on token refresh)
> - `src/tools/write-safety.ts` (new — `withPreview` two-phase write helper)
> - `src/resources/index.ts`, `src/tools/get-today.ts` (cache consumers, reviewed for keying)
> **Dependencies:** `npm audit --omit=dev` → **0 vulnerabilities**.
> **Secrets in history:** `git log --all -- '*.env' 'tokens.json'` → none.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 2 |
| Info | 2 |

**Overall Assessment: PASS.** The caching layer is correctly designed for the
single-WHOOP-identity model. Cache keys are derived solely from the request path
and sorted query params — no Authorization token, client secret, or per-user
identifier is ever incorporated. The shared cache is cleared on every token
refresh, and a generation counter prevents an in-flight fetch from repopulating
the cache with pre-refresh data. TTLs are enforced lazily on every read, so no
value is ever served beyond its TTL. `withPreview` uses a CSPRNG
(`crypto.randomUUID`) and never invokes the write in preview mode. No secrets are
logged or persisted.

The two Low findings are defense-in-depth / future-proofing items, not
exploitable bugs in the current single-user design.

---

## Previous Audit Findings Status

Audit #8 covered the OAuth 2.1 connector (`src/transport/oauth-*`) — no overlap
with this caching scope. No previously-identified findings touch
`src/cache/`, `src/api/client.ts` caching, or `src/tools/write-safety.ts`.

---

## Scope Confirmations (as requested)

| Requirement | Verdict | Evidence |
|-------------|---------|----------|
| No auth tokens/secrets/per-user IDs in cache keys | ✅ Confirmed | `cacheKey(path)` (`src/api/client.ts:139-152`) takes only `path`; builds `GET:${base}?${sortedParams}`. Authorization header lives in `doFetch` and is never passed to keying. |
| Cached values cannot cross token boundaries | ✅ Confirmed | `cache.clear()` in `onTokenRefresh` empties the store before the new token serves any read. |
| Path-only keying acceptable (single-user) | ✅ Acceptable | One upstream WHOOP identity at a time; a refresh keeps the same WHOOP user. See LOW-1 for the multi-tenant caveat. |
| Cache cleared on token refresh | ✅ Confirmed | `src/index.ts:138` `cache.clear()` after `saveTokens`, before returning the new token. |
| Generation guard prevents stale repopulation | ✅ Confirmed | `getOrFetch` captures `gen` and only `set()`s if `this.generation === gen` (`src/cache/memory-cache.ts:154-167`); `clear()` bumps `generation`. |
| Preview mode never executes the write | ✅ Confirmed | `withPreview` returns before calling `options.write` when `confirm === false` (`src/tools/write-safety.ts:73-80`). |
| `idempotency_key` generation | ✅ Confirmed | `crypto.randomUUID()` — CSPRNG, not derived from any secret. |
| No secrets logged | ✅ Confirmed | `doFetch` logs `url` (base + path + query — no token) and `status`/`durationMs` only; Authorization header is never logged. |
| TTLs bound staleness | ✅ Confirmed | Lazy expiry check on every `get`/`has`; default 5 min, profile 1 hr, cycle 2 min. |
| No negative caching of failures | ✅ Confirmed | `getOrFetch` deletes the in-flight entry and rethrows on rejection — errors are never stored. |

---

## Findings

### [LOW-1] Path-only cache keying is safe only under the single-WHOOP-identity assumption

- **Location:** `src/api/client.ts:139-152` (`cacheKey`), `src/index.ts:124` (single process-wide `MemoryCache`)
- **Description:** The cache key omits any identity component because the server
  holds exactly one WHOOP token at a time. This is correct today. However, the
  server can also run in `http`/`both` transport mode where multiple MCP clients
  connect — they all map to the **same** server-owned WHOOP account, so the cache
  introduces no new cross-user exposure now. The risk is latent: if multi-tenancy
  (per-connection WHOOP tokens) is ever added, path-only keys would serve one
  user's cached data to another.
- **Impact:** None in the current single-identity design. Future multi-tenant
  data leak if the keying assumption is silently violated.
- **Recommendation:** Make the assumption explicit and self-documenting so a
  future change can't regress it silently. Either (a) add a code comment + a unit
  test asserting single-identity, or (b) namespace keys with a token/identity
  fingerprint when/if multiple identities become possible, e.g.:
  ```ts
  // when multi-identity is introduced:
  function cacheKey(path: string, identityFingerprint: string): string {
    // identityFingerprint = sha256(accessToken).slice(0, 16) — never the raw token
    return `${identityFingerprint}:GET:${base}?${query}`;
  }
  ```

### [LOW-2] `clear()` does not drop the in-flight map, so a pre-refresh request can still be shared post-clear

- **Location:** `src/cache/memory-cache.ts:127-130` (`clear`), `:145-170` (`getOrFetch`)
- **Description:** `clear()` empties `store` and bumps `generation` but leaves the
  `inflight` map intact. If a token refresh (`cache.clear()`) happens while a
  `getOrFetch` for key K is still in flight, a subsequent caller for K will join
  the **pre-refresh** in-flight promise. Because the upstream identity is the same
  WHOOP user, the returned data is not cross-user, and the generation guard
  prevents that result from being cached — so this is not exploitable today.
- **Impact:** None for confidentiality in the single-user model; a late joiner may
  receive data fetched moments before the refresh (already within TTL semantics).
- **Recommendation:** Clear in-flight tracking on invalidation for clean semantics:
  ```ts
  clear(): void {
    this.store.clear();
    this.inflight.clear();
    this.generation++;
  }
  ```
  The generation guard already prevents stale `set`; clearing `inflight` also stops
  late joiners from attaching to a pre-invalidation fetch.

---

## Informational

### [INFO-1] `withPreview` echoes `payload` and `summary` verbatim in the preview

- **Location:** `src/tools/write-safety.ts:73-80`
- **Note:** The preview object reflects the caller-supplied `payload`/`summary`
  back to the MCP client. If a future write tool places secrets in `payload`, they
  would surface in the preview output. The helper is currently an unused generic
  utility. When wiring real WHOOP write endpoints, ensure no credentials/PII go
  into `payload`. No action required now.

### [INFO-2] Cache bounds entries but not per-entry size

- **Location:** `src/cache/memory-cache.ts` (`maxEntries`, `evictIfNeeded`)
- **Note:** Memory is bounded by `maxEntries` (default 100) with LRU eviction —
  good DoS resistance for a single-user server. There is no per-value size cap, so
  100 very large responses could still grow memory. Acceptable for the current
  WHOOP response sizes; revisit if large/unbounded payloads are ever cached.

---

## Positive Observations

- **No identity material in keys or logs** — keys are path + sorted query only;
  the Bearer token never enters `cacheKey`, the cache, or any log line.
- **Correct invalidation on refresh** — `cache.clear()` runs before the rotated
  token serves any read; the generation counter blocks stale repopulation from
  in-flight fetches.
- **CSPRNG for idempotency keys** — `crypto.randomUUID()` (v4), not a predictable
  or secret-derived value.
- **Fail-safe preview** — the write function is provably never called in preview
  mode; confirm path reuses the same key for idempotent retries.
- **No negative caching** — transient fetch failures are not stored, avoiding
  cache-poisoned error states.
- **Lazy TTL enforcement** — every read validates expiry, so no value is served
  past its TTL even without a sweeper.
- **Clean supply chain** — `npm audit` reports 0 vulnerabilities; no secrets in
  git history.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Low | Path-only keying assumes single WHOOP identity | Document + test the assumption; namespace keys with an identity fingerprint before any multi-tenant change |
| 2 | Low | `inflight` not cleared on `clear()` | Add `this.inflight.clear()` to `clear()` for clean invalidation semantics |
