# Security Audit Report #10

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-06-13
> **Type:** Pre-release security gate for the **v0.6.0** `npm publish`.
> **Scope:** CLI setup targets (Codex + GitHub Copilot), token storage, stdio OAuth
> flow, the remote-transport OAuth 2.1 connector, and dependency supply chain.
> Files audited:
> - `src/cli/config-generators.ts` (`generateCodexCommand`, `generateCopilotCommand`, `shellQuote`)
> - `src/cli/setup.ts` (wizard, argv parsing, secret prompt)
> - `src/auth/token-store.ts` (dir `0o700` / file `0o600`)
> - `src/auth/oauth.ts` + `src/auth/callback-server.ts` (PKCE S256, state/CSRF, `openBrowser`)
> - `src/transport/oauth-connector.ts`, `src/transport/oauth-helpers.ts`, `src/transport/oauth-jwt.ts`
> - `package.json` (`files`, `dependencies`, `bin`), published-artifact composition
> **Dependencies:** `npm audit --omit=dev` → **0 vulnerabilities**. Full tree → **6
> (4 high, 2 critical)**, all confined to the `esbuild`/`vite`/`vitest`/`tsx` dev toolchain.
> **Secrets in history:** previous audits confirmed clean; no new secret-bearing files added.
>
> **Note on numbering:** `security-audit-9.md` was already committed (commit `5dae0af`)
> covering the v0.7.0 Task-15 caching work, so this v0.6.0 gate is filed as **#10** to
> avoid clobbering that report.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 2 |
| Info | 3 |

**Overall Assessment: PASS — APPROVE for v0.6.0 `npm publish`.**

The two headline risks for this release are fully mitigated:

1. **Shell/command injection via CLI setup commands (`codex`, `copilot`, `claude-code`)** —
   `shellQuote` implements the canonical POSIX single-quote escaping
   (`'` → `'\''`). It correctly neutralizes single quotes, `$(...)`, backticks,
   `;`, `&&`, `|`, and newlines. Equally important: the wizard **prints** these
   commands to stdout for the user to copy-paste — it never `exec`s them — so the
   tool itself has no command-injection sink. The Copilot path additionally routes
   the secret through `JSON.stringify` before `shellQuote`, so both the JSON and the
   shell layers are independently escaped.

2. **Dev-toolchain `npm audit` findings do not reach the published artifact.**
   `package.json` ships `files: ["dist"]` with exactly two runtime dependencies
   (`@modelcontextprotocol/sdk`, `zod`). `npm ls esbuild --omit=dev` returns an empty
   tree — `esbuild` is reachable only through `tsx`/`vitest`/`vite` (devDependencies),
   which are excluded from the tarball. Both advisories
   (GHSA-gv7w-rqvm-qjhr, GHSA-g7r4-m6w7-qqqr) require running the esbuild dev server /
   Deno dev tooling and therefore cannot affect end users of `whoop-ai-mcp`.

Token storage, the stdio OAuth flow, and the remote OAuth 2.1 connector all hold up.
The two Low findings are supply-chain hygiene and defense-in-depth items that do **not**
block the stdio release.

---

## Previous Audit Findings Status

| Finding | Status |
|---------|--------|
| Audit #8 IMPORTANT-2 (refresh tokens: no rotation/reuse detection) | **Resolved.** `exchangeRefreshToken` now requires a `jti`, rejects replays via `UsedJtiStore`, and mints a fresh `jti` per issued refresh token (`oauth-connector.ts`, `oauth-helpers.ts:generateJti`). |
| Audit #8 IMPORTANT-3 (resource indicator can be overwritten on refresh) | **Resolved.** Refresh now rejects any `resource` that does not exactly equal the original grant (`oauth-connector.ts` — "resource indicator does not match the original grant"). |
| Audit #8 IMPORTANT-1 (no anti-framing on connector password page) | Out of scope for the v0.6.0 stdio publish (http transport is opt-in). Carried forward — see INFO-3. |
| Audit #9 (v0.7.0 caching) LOW-1/LOW-2 | Out of scope — caching layer not part of this gate. |

---

## Scope Confirmations (as requested)

| Requirement | Verdict | Evidence |
|-------------|---------|----------|
| `shellQuote` neutralizes a hostile secret containing `'` | ✅ Confirmed | `'` → `'\''` (close-quote, escaped literal quote, reopen-quote) — the canonical POSIX idiom. `config-generators.ts` `shellQuote`. |
| …containing `$(...)`, backticks, `;`, newlines | ✅ Confirmed | All are literal inside single quotes; the only break-out character is `'`, which is escaped. Newlines remain literal (cosmetic line-wrap only — see INFO-1). |
| Codex command interpolation safe | ✅ Confirmed | `generateCodexCommand` wraps both env values with `shellQuote`; server name is a constant. |
| Copilot command interpolation safe | ✅ Confirmed | `generateCopilotCommand` builds the server def with `JSON.stringify`, then `shellQuote`s the entire JSON payload — double-escaped. |
| Tool never executes the generated commands | ✅ Confirmed | `setup.ts` writes them via `out.write(...)` for manual copy-paste; no `exec`/`spawn` of user strings. |
| Token dir `0o700`, file `0o600` | ✅ Confirmed | `saveTokens` → `mkdir(dir,{recursive:true,mode:0o700})`, `writeFile(...,{mode:0o600})`. |
| Token file path not leaked verbatim in logs | ✅ Confirmed | `redactHomePath` replaces `$HOME` with `~` before logging. |
| PKCE S256 | ✅ Confirmed | `generatePkcePair` → `randomBytes(32).base64url` verifier, `sha256` challenge, `code_challenge_method=S256`. |
| `openBrowser` uses `spawn` arg arrays (no shell) + scheme allowlist | ✅ Confirmed | Rejects non-`http(s)` schemes before `spawn(cmd, args, {detached, stdio:"ignore"})`; no `shell:true`. |
| OAuth callback CSRF / state validation | ✅ Confirmed | `callback-server.ts` rejects on `state !== expectedState`; callback HTML is `escapeHtml`-encoded with `X-Frame-Options: DENY` + `nosniff`. |
| Connector `redirect_uri` exact-match allowlist on `/authorize` AND `/token` | ✅ Confirmed | `authorize()` rejects unless `isAllowedRedirectUri` (exact `includes`); `exchangeAuthorizationCode` re-checks the stored `redirect_uri` equals the presented one AND is in the allowlist. |
| JWT alg pinned, issuer + token-type checked | ✅ Confirmed | `verifyToken` pins `algorithms:[HS256]`, enforces `issuer`, discriminates `typ` access/refresh; signing key is HKDF-derived (not the raw bearer token). |
| `npm audit` prod = 0 | ✅ Confirmed | `npm audit --omit=dev` → "found 0 vulnerabilities". |
| esbuild advisories excluded from artifact | ✅ Confirmed | `files:["dist"]`; `npm ls esbuild --omit=dev` → empty. |

---

## Findings

### [LOW-1] `express` and `jose` are imported by shipped `dist/` code but are not declared dependencies

- **Location:** `src/transport/oauth-connector.ts:18` (`import express ...`),
  `src/transport/oauth-jwt.ts:9` (`import { SignJWT, jwtVerify } from "jose"`);
  `package.json` `dependencies` = `{ @modelcontextprotocol/sdk, zod }` only.
- **Description:** The remote OAuth connector statically imports `express` and `jose`.
  These modules are compiled into `dist/` (which is published via `files:["dist"]`),
  yet neither is listed in `dependencies`, `peerDependencies`, or
  `optionalDependencies`. They resolve in this workspace only because they are hoisted
  transitive dependencies (`jose` via the MCP SDK; `express` likewise present in the dev
  tree).
- **Impact:**
  - **No impact on the default stdio publish.** `index.ts` loads the connector via a
    lazy `await import("./transport/oauth-connector.js")` **only** when
    `MCP_TRANSPORT=http|both`, so the missing deps are never touched in the default path.
  - **Supply-chain / dependency-confusion risk for http-mode users.** Because the
    versions of `express`/`jose` are not pinned in this package, the resolved version is
    whatever a consumer's tree happens to hoist — an uncontrolled, potentially
    attacker-influenceable version (classic transitive-dependency-confusion surface). In
    a clean install where the SDK stops pulling `jose`, `http` mode breaks outright.
- **Recommendation:** Declare the modules the published code imports, so versions are
  pinned and integrity-checked:
  ```jsonc
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1",
    "zod": "^4.4.3",
    "express": "^4.x",
    "jose": "^5.x"
  }
  ```
  Or, if remote transport should stay an advanced/optional feature, move them to
  `optionalDependencies` and surface a clear "install express + jose to enable
  MCP_TRANSPORT=http" error at the lazy-import site. **Does not block the v0.6.0 stdio
  publish.**

### [LOW-2] Setup wizard does not constrain credential charset before embedding in printed shell commands

- **Location:** `src/cli/setup.ts` (credential resolution — only `.trim()` +
  non-empty checks), consumed by `generateCodexCommand` / `generateCopilotCommand` /
  `generateClaudeCodeCommand`.
- **Description:** The wizard accepts arbitrary strings for `WHOOP_CLIENT_ID` /
  `WHOOP_CLIENT_SECRET` (flags, env, or interactive prompt) and passes them straight to
  the command generators. Safety relies entirely on `shellQuote` being correct.
- **Impact:** None today — `shellQuote` is correct, so even a maliciously crafted
  "secret" produces a safe single-quoted token, and the command is printed rather than
  executed. This is a defense-in-depth observation, not an exploitable path. Real WHOOP
  credentials are hex-like and contain no shell metacharacters.
- **Recommendation:** Optionally add a light format assertion (e.g. reject control
  characters / newlines, or warn if the value contains shell metacharacters) so a single
  future regression in `shellQuote` cannot silently become an injection sink. Keep
  `shellQuote` as the primary control. **Does not block.**

---

## Informational

### [INFO-1] Embedded newlines survive into the printed command (cosmetic)

- **Location:** `config-generators.ts` `shellQuote`.
- **Note:** A secret containing a literal newline stays a literal newline inside the
  single-quoted token, so the printed command wraps across lines. The shell treats it as
  part of the quoted string (not a command separator), so it is **safe** — only the
  copy-paste UX is affected. No action required.

### [INFO-2] Refresh-token reuse detection is in-memory (single-instance only)

- **Location:** `src/transport/oauth-helpers.ts` (`UsedJtiStore`), used by
  `exchangeRefreshToken`.
- **Note:** The `jti` replay-detection store lives in process memory. This fully
  protects a single-instance deployment (the documented model) and is a real improvement
  over Audit #8. If the connector is ever scaled horizontally, replay detection would
  need a shared store (Redis/DB) to remain effective. Out of scope for the stdio publish.

### [INFO-3] Dev-toolchain advisories — track, do not ship

- **Location:** `esbuild` via `tsx`@4.21.0 and `vite`@7.3.2 (`vitest`).
- **Note:** GHSA-gv7w-rqvm-qjhr (esbuild Deno `NPM_CONFIG_REGISTRY` RCE) and
  GHSA-g7r4-m6w7-qqqr (esbuild dev-server file read on Windows) both require running the
  esbuild dev server / Deno tooling. They affect only the local dev/test environment and
  are excluded from the published tarball. Recommend bumping `tsx`/`vitest` when upstream
  ships fixed esbuild ranges, as routine dev-environment hygiene. Carries Audit #8
  IMPORTANT-1 (connector password-page anti-framing) forward for whenever the http
  transport is hardened for production.

---

## Positive Observations

- **Correct, well-known shell escaping.** `shellQuote` uses the textbook POSIX
  single-quote technique and is the *only* trust boundary needed — and the commands are
  printed, never executed, giving a second independent layer of safety.
- **Defense in depth on the Copilot path.** `JSON.stringify` then `shellQuote` means the
  secret is escaped for both the JSON and shell grammars.
- **Tight token-file hygiene.** `0o700` dir, `0o600` file, home-path redaction in logs,
  and strict shape validation on load.
- **Solid stdio OAuth.** PKCE S256, 128-bit CSRF `state` enforced on the callback,
  scheme-allowlisted `openBrowser` via `spawn` arg arrays, HTML-escaped callback page
  with `X-Frame-Options: DENY` and `nosniff`.
- **Connector matured since Audit #8.** Exact-match `redirect_uri` allowlist on both
  endpoints, HS256 pinned with issuer + token-type checks, HKDF-separated signing key,
  refresh rotation with `jti` reuse detection, and exact resource-indicator binding.
- **Minimal, clean runtime supply chain.** Two prod deps; `npm audit --omit=dev` = 0;
  all audit noise confined to excluded dev tooling.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Low | `express`/`jose` imported by shipped `dist/` but undeclared | Declare them in `dependencies` (or `optionalDependencies` + clear lazy-import error). Non-blocking for stdio. |
| 2 | Low | Wizard does not constrain credential charset | Add a light control-char/newline assertion as defense-in-depth; keep `shellQuote` as primary control. |
| 3 | Info | Dev-toolchain esbuild advisories | Bump `tsx`/`vitest` when fixed esbuild ranges land. Not shipped. |
| 4 | Info | In-memory refresh-reuse store | Move to a shared store before any horizontal scaling of the http connector. |
