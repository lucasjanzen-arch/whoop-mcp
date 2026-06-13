# Code Review Checkpoint 14: Codex & GitHub Copilot setup-wizard support

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-06-13
> **Scope:** Working-tree diff adding `codex` and `copilot` targets to the `whoop-ai-mcp setup` wizard — `src/cli/config-generators.ts`, `src/cli/setup.ts`, `tests/cli/setup.test.ts`, plus docs (`README.md`, `CHANGELOG.md`, `site/index.html`).
> **Test suite:** 748 tests passing, typecheck clean, build clean, lint clean (per author report; not re-run by reviewer per instruction).

---

## Verdict: ✅ APPROVE

**Overview:** Two new pure generators (`generateCodexCommand`, `generateCopilotCommand`) and matching wizard branches extend the existing claude-code pattern cleanly. Generated commands are correct, shell-quoting is applied to all user-controlled values, and there is **no command-injection vector**. Findings are all Minor/Nit.

---

## Critical Issues

None.

## Important Issues

None.

## Suggestions

### 1. Strengthen the Copilot escaping test with a full round-trip
- **File:** `tests/cli/setup.test.ts:159-167`
- The escape test only asserts the command `toContain('\\'')`. Since the Copilot path embeds creds via `JSON.stringify` and then shell-quotes the entire payload, a stronger test would simulate shell single-quote unwrapping (`replace("'\\''", "'")`, strip outer quotes) and `JSON.parse` the result, asserting `env.WHOOP_CLIENT_SECRET === "weird's secret"`. This proves the apostrophe survives both the JSON and shell layers intact, not merely that an escape sequence appears somewhere.
- **Fix:**
  ```ts
  const inner = cmd.slice(cmd.indexOf("'") + 1, cmd.lastIndexOf("'"));
  const unshell = inner.replace(/'\\''/g, "'");
  const parsed = JSON.parse(unshell) as { env: { WHOOP_CLIENT_SECRET: string } };
  expect(parsed.env.WHOOP_CLIENT_SECRET).toBe("weird's secret");
  ```

### 2. Remind users that the printed command contains a plaintext secret
- **File:** `src/cli/setup.ts` (codex/copilot/claude-code emission branches)
- The emitted `codex mcp add` / `code --add-mcp` / `claude mcp add` commands embed the client secret in cleartext; pasting them lands the secret in shell history. This is consistent with the pre-existing claude-code path (not a regression), but a one-line note ("this command contains your client secret — your shell may record it in history") would help security-conscious users. Applies to all three printed-command targets.

### 3. Optional: collapse the three printed-command branches
- **File:** `src/cli/setup.ts` (the `claude-code` / `codex` / `copilot` `if` blocks)
- The three branches are near-identical (label + generator + `out.write`). A small `Record<ClientTarget, () => string>` lookup would remove duplication, though the current explicit form is readable and matches existing style. Optional.

## What's Done Well

- **Security is correct.** `shellQuote` (single-quote wrap + `'\''` escaping) is applied to every user-controlled value: per-env-var for Codex, and the entire `JSON.stringify` payload for Copilot. A malicious secret such as `'; rm -rf ~ #` is rendered as a single literal argument — no injection path exists for either new target.
- **Pure/impure separation maintained.** Generators stay I/O-free in `config-generators.ts`; the wizard owns all prompting and emission. `ClientTarget` extension, `CLIENT_TARGETS` array, and the `isClientTarget` type guard are a clean, single-source-of-truth validation seam reused by both `parseSetupArgs` and `runSetup`.
- **Conventions honored.** Explicit return types, named exports, no `any`, `SCREAMING_SNAKE_CASE` const, accurate doc comments (incl. the `~/.codex/config.toml` and `code --add-mcp` JSON-shape notes). Error message enumerates all four valid targets.
- **Generated commands match the target CLIs.** Codex `--env KEY=VALUE ... -- npx -y whoop-ai-mcp` and the Copilot `{name, command, args, env}` JSON shape are correct, and the Copilot JSON parses (verified by the test that `JSON.parse`s the stripped payload).

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 6 new tests: 2 per generator (basic + quote-escape), arg-parse accept/reject, and 2 wizard-output integration tests. Mirrors the claude-code coverage shape. |
| Build verified | ✅ | Per author report (748 tests, typecheck/build/lint clean); not re-run per instruction. |
| Security checked | ✅ | `shellQuote` applied to all user values incl. the full Copilot JSON payload; manual injection trace confirms no break-out for either target. |
| Coverage | ✅ | Both generators and both wizard branches exercised; only gap is the round-trip depth of the Copilot escape test (Suggestion #1). |

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Suggestion | Strengthen Copilot escaping test to a full shell+JSON round-trip | backlog |
| 2 | Suggestion | Print a "command contains your secret" note on all printed-command targets | backlog |
| 3 | Suggestion | Optionally collapse the three printed-command branches into a lookup | backlog |
