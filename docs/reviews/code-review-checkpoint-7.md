# Code Review Checkpoint 7: Task 11c — Individual Record Lookup Tools

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-05-29
> **Scope:** Task 11c — 3 new by-ID tools (`get_sleep_by_id`, `get_workout_by_id`, `get_cycle_by_id`) + server registration + tests
> **Test suite:** 293 tests passing (19 files), typecheck clean, build clean, lint clean

---

## Verdict: ✅ APPROVE — 0 Critical, 2 Important, 3 Suggestions

**Overview:** Clean, minimal implementation of 3 individual-record lookup tools that follow existing project patterns precisely. Security posture is strong — Zod regex rejects path traversal at the input boundary, `encodeURIComponent()` provides defense-in-depth on string IDs, and numeric cycle IDs prevent injection by type. Two important gaps: (1) missing URL prefix assertion after construction (a spec acceptance criterion), and (2) no test proving path traversal IDs are actually rejected by the Zod schema.

---

## Critical Issues

None.

---

## Important Issues

### 1. Missing URL prefix assertion after construction (spec acceptance criterion #6)

- **File:** `src/tools/get-sleep-by-id.ts:20`, `src/tools/get-workout-by-id.ts:20`, `src/tools/get-cycle-by-id.ts:19`
- **Problem:** The spec explicitly requires: *"URL prefix assertion after construction (`url.pathname.startsWith(expectedBase)`)"*. This defense-in-depth measure ensures that even if the Zod regex or `encodeURIComponent` is bypassed (e.g., via a future refactor that loosens validation), the constructed URL is verified to start with the expected API path before being sent to the client. Currently, the tool handlers construct the URL and pass it directly without this check.
- **Practical risk:** Near zero today — the Zod regex `/^[a-zA-Z0-9_-]+$/` blocks all path traversal characters (`.`, `/`, `\`, `%`). However, this was an explicit spec acceptance criterion and provides a safety net against future validation changes.
- **Fix (example for `get-sleep-by-id.ts`):**
  ```typescript
  export async function getSleepById(client: WhoopClient, id: string): Promise<Sleep> {
    const path = `${ENDPOINT_SLEEP}/${encodeURIComponent(id)}`;
    if (!path.startsWith(ENDPOINT_SLEEP + "/")) {
      throw new Error(`Invalid path constructed: ${path}`);
    }
    return client.get<Sleep>(path);
  }
  ```
  Apply the same pattern to `get-workout-by-id.ts` and `get-cycle-by-id.ts`.

### 2. No test verifying that path traversal IDs are rejected by Zod schema

- **File:** `tests/server.test.ts`
- **Problem:** The spec explicitly states *"Path traversal attempts (e.g., `../../admin`) rejected at Zod layer"* as an acceptance criterion. While the Zod regex `stringIdSchema` clearly blocks `../../admin` (both `.` and `/` are outside the `[a-zA-Z0-9_-]` character class), there is no test proving this. The server schema tests verify the schema shape but not rejection behavior. A test would:
  1. Document that path traversal prevention is intentional, not accidental
  2. Guard against future regressions if someone loosens the regex
  3. Directly verify the spec acceptance criterion
- **Fix:** Add schema rejection tests (either in `server.test.ts` or as a standalone test):
  ```typescript
  describe("ID schema security", () => {
    it("rejects path traversal in string ID", async () => {
      const result = await client.callTool({
        name: "get_sleep_by_id",
        arguments: { id: "../../admin" },
      });
      expect(result.isError).toBe(true);
    });

    it("rejects IDs with slashes", async () => {
      const result = await client.callTool({
        name: "get_workout_by_id",
        arguments: { id: "foo/bar" },
      });
      expect(result.isError).toBe(true);
    });

    it("rejects negative cycle IDs", async () => {
      const result = await client.callTool({
        name: "get_cycle_by_id",
        arguments: { id: -1 },
      });
      expect(result.isError).toBe(true);
    });

    it("rejects zero cycle ID", async () => {
      const result = await client.callTool({
        name: "get_cycle_by_id",
        arguments: { id: 0 },
      });
      expect(result.isError).toBe(true);
    });

    it("rejects float cycle IDs", async () => {
      const result = await client.callTool({
        name: "get_cycle_by_id",
        arguments: { id: 1.5 },
      });
      expect(result.isError).toBe(true);
    });
  });
  ```

---

## Suggestions

### 1. Spec requires dedicated endpoint constants — not added

- **File:** `src/api/endpoints.ts`
- The spec acceptance criterion states: *"`ENDPOINT_SLEEP_BY_ID`, `ENDPOINT_WORKOUT_BY_ID`, `ENDPOINT_CYCLE_BY_ID` constants added"*. These are absent. The tool handlers reuse the collection endpoint constants (`ENDPOINT_SLEEP`, `ENDPOINT_WORKOUT`, `ENDPOINT_CYCLE`) and append `/${id}`. This is arguably cleaner than redundant constants (e.g., `ENDPOINT_SLEEP_BY_ID = "/v2/activity/sleep"` would duplicate `ENDPOINT_SLEEP`), but it's a deviation from the plan. Consider either adding the constants or updating the plan to reflect the decision.

### 2. "Encodes special characters" test names are misleading

- **File:** `tests/tools/get-sleep-by-id.test.ts:42`, `tests/tools/get-workout-by-id.test.ts:42`
- The tests named `"encodes special characters in the ID"` use IDs like `"id-with_underscore"` and `"id_with-special"` — these contain only characters from the Zod-allowed set `[a-zA-Z0-9_-]`. `encodeURIComponent()` is a no-op on these values. The test proves `encodeURIComponent` is called, but doesn't demonstrate actual encoding behavior. Since the Zod regex rightly prevents any character that *would* be encoded, the test behavior is correct — but the name implies something that doesn't happen. Consider renaming to `"applies encodeURIComponent to the ID"` or `"passes ID through encodeURIComponent"`.

### 3. Cycle `getCycleById` does not use `encodeURIComponent` — worth a comment

- **File:** `src/tools/get-cycle-by-id.ts:19`
- The cycle tool constructs the path as `` `${ENDPOINT_CYCLE}/${id}` `` without `encodeURIComponent`, while the sleep and workout tools both use it. The cycle ID is a Zod-validated positive integer, so encoding is unnecessary (number-to-string conversion produces only digits). This is correct behavior, but a brief code comment explaining *why* encoding is omitted (compared to the string-ID tools) would prevent future reviewers from flagging it as an oversight:
  ```typescript
  // Cycle IDs are Zod-validated positive integers — no encoding needed
  return client.get<Cycle>(`${ENDPOINT_CYCLE}/${id}`);
  ```

---

## What's Done Well

- **Minimal, focused tool implementations.** Each file is <25 lines, does exactly one thing, and follows the established pattern (import client + type + endpoint → construct URL → return `client.get<T>(path)`). No over-engineering.
- **Correct type differentiation for IDs.** Sleep and Workout IDs are `string` in the WHOOP API types; Cycle IDs are `number`. The Zod schemas match: `stringIdSchema` for sleep/workout, `numericIdSchema` for cycle. This type fidelity prevents subtle bugs.
- **Zod regex is security-correct.** The allowlist regex `/^[a-zA-Z0-9_-]+$/` blocks all dangerous characters (`/`, `.`, `\`, `%`, null bytes, spaces) at the input boundary — the strongest possible position. This is the right approach: reject at the gate, not sanitize downstream.
- **Server registration is clean and consistent.** The 3 new tool registrations follow the exact same block-comment + `registerTool` + `safeTool` wrapper pattern as the existing 6 tools. The shared `stringIdSchema` and `numericIdSchema` avoid duplication.
- **Mock client update is well-designed.** The `ID_LOOKUP_PREFIXES` array with prefix-matching in the mock client is a clean pattern that correctly routes by-ID requests without breaking existing exact-match collection routing.
- **Test coverage is structurally complete.** Each tool has 4 tests (correct endpoint, return value, encoding, error propagation). Server tests verify all 9 tools listed, handler behavior for all 3 new tools, and schema shapes. Total new test count: 12 unit + 6 server integration = 18 tests.
- **`readOnlyHint` annotation on all new tools.** Correctly marks lookup operations as read-only, matching the existing tools.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 18 new tests across 3 unit test files + server.test.ts — all structurally complete |
| Build verified | ✅ | `tsc` and `tsc --noEmit` both clean |
| Security checked | ✅ | Zod regex blocks path traversal; `encodeURIComponent` defense-in-depth; numeric IDs type-safe |
| Lint clean | ✅ | ESLint passes |
| Coverage | ⚠️ | Happy path + error propagation covered. Missing: path traversal rejection test (Important #2) |
| Spec conformance | ⚠️ | 2 acceptance criteria not met: URL prefix assertion, endpoint constants (Important #1, Suggestion #1) |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | Add URL prefix assertion after path construction in all 3 tool handlers | Task 11c patch |
| 2 | Important | Add tests proving path traversal IDs are rejected by Zod schema | Task 11c patch |
| 3 | Suggestion | Add dedicated endpoint constants to `endpoints.ts` or update plan to reflect omission | Backlog |
| 4 | Suggestion | Rename "encodes special characters" tests to reflect actual behavior | Backlog |
| 5 | Suggestion | Add comment to `getCycleById` explaining why `encodeURIComponent` is omitted | Backlog |
