/**
 * Tests for the `whoop-ai-mcp setup` wizard and config generators.
 *
 * Pure-function tests run without I/O. End-to-end wizard tests inject a
 * stub filesystem + auth, so nothing touches the real disk or network.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "node:os";

import {
  claudeDesktopConfigPath,
  generateClaudeCodeCommand,
  generateClaudeDesktopEntry,
  mergeClaudeDesktopConfig,
} from "../../src/cli/config-generators.js";
import { parseSetupArgs, runSetup } from "../../src/cli/setup.js";

// ---------------------------------------------------------------------------
// config-generators
// ---------------------------------------------------------------------------

describe("claudeDesktopConfigPath", () => {
  it("returns a path containing 'Claude' under the home dir", () => {
    const path = claudeDesktopConfigPath();
    expect(path.startsWith(homedir())).toBe(true);
    expect(path).toMatch(/Claude/);
    expect(path.endsWith("claude_desktop_config.json")).toBe(true);
  });
});

describe("generateClaudeDesktopEntry", () => {
  it("uses npx + whoop-ai-mcp and embeds env", () => {
    const entry = generateClaudeDesktopEntry({
      WHOOP_CLIENT_ID: "id-123",
      WHOOP_CLIENT_SECRET: "secret-xyz",
    });
    expect(entry).toEqual({
      command: "npx",
      args: ["-y", "whoop-ai-mcp"],
      env: { WHOOP_CLIENT_ID: "id-123", WHOOP_CLIENT_SECRET: "secret-xyz" },
    });
  });
});

describe("mergeClaudeDesktopConfig", () => {
  const entry = generateClaudeDesktopEntry({
    WHOOP_CLIENT_ID: "id",
    WHOOP_CLIENT_SECRET: "s",
  });

  it("creates mcpServers when none exist", () => {
    const merged = mergeClaudeDesktopConfig(null, entry);
    expect(merged.mcpServers?.whoop).toEqual(entry);
  });

  it("preserves other MCP servers", () => {
    const existing = {
      mcpServers: {
        github: { command: "node", args: ["x"], env: { TOKEN: "t" } },
      },
    } as Parameters<typeof mergeClaudeDesktopConfig>[0];
    const merged = mergeClaudeDesktopConfig(existing, entry);
    expect(merged.mcpServers?.github).toBeDefined();
    expect(merged.mcpServers?.whoop).toEqual(entry);
  });

  it("preserves unrelated top-level keys", () => {
    const existing = { theme: "dark" } as unknown as Parameters<
      typeof mergeClaudeDesktopConfig
    >[0];
    const merged = mergeClaudeDesktopConfig(existing, entry);
    expect((merged as { theme?: string }).theme).toBe("dark");
  });

  it("replaces an existing whoop entry rather than duplicating", () => {
    const existing = {
      mcpServers: {
        whoop: { command: "old", args: [], env: { WHOOP_CLIENT_ID: "old", WHOOP_CLIENT_SECRET: "old" } },
      },
    } as Parameters<typeof mergeClaudeDesktopConfig>[0];
    const merged = mergeClaudeDesktopConfig(existing, entry);
    expect(merged.mcpServers?.whoop).toEqual(entry);
    expect(Object.keys(merged.mcpServers ?? {})).toEqual(["whoop"]);
  });
});

describe("generateClaudeCodeCommand", () => {
  it("emits a `claude mcp add` command with quoted env values", () => {
    const cmd = generateClaudeCodeCommand({
      WHOOP_CLIENT_ID: "id-123",
      WHOOP_CLIENT_SECRET: "secret-xyz",
    });
    expect(cmd).toContain("claude mcp add whoop");
    expect(cmd).toContain("npx -y whoop-ai-mcp");
    expect(cmd).toContain("-e WHOOP_CLIENT_ID='id-123'");
    expect(cmd).toContain("-e WHOOP_CLIENT_SECRET='secret-xyz'");
  });

  it("escapes single quotes in secrets", () => {
    const cmd = generateClaudeCodeCommand({
      WHOOP_CLIENT_ID: "ok",
      WHOOP_CLIENT_SECRET: "weird's secret",
    });
    expect(cmd).toContain(`'weird'\\''s secret'`);
  });
});

// ---------------------------------------------------------------------------
// parseSetupArgs
// ---------------------------------------------------------------------------

describe("parseSetupArgs", () => {
  it("returns empty options for empty argv", () => {
    expect(parseSetupArgs([])).toEqual({});
  });

  it("parses --flag=value form", () => {
    const opts = parseSetupArgs([
      "--client-id=abc",
      "--client-secret=xyz",
      "--client=claude-desktop",
      "--verify",
    ]);
    expect(opts).toEqual({
      clientId: "abc",
      clientSecret: "xyz",
      client: "claude-desktop",
      verify: true,
    });
  });

  it("parses --flag value form (space-separated)", () => {
    const opts = parseSetupArgs(["--client-id", "abc", "--client", "claude-code"]);
    expect(opts.clientId).toBe("abc");
    expect(opts.client).toBe("claude-code");
  });

  it("rejects invalid --client values", () => {
    expect(() => parseSetupArgs(["--client=bogus"])).toThrow(/Invalid --client/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseSetupArgs(["--nope=1"])).toThrow(/Unknown flag/);
  });

  it("rejects --flag with no value", () => {
    expect(() => parseSetupArgs(["--client-id"])).toThrow(/Missing value/);
  });

  it("treats a following flag as 'no value'", () => {
    expect(() => parseSetupArgs(["--client-id", "--verify"])).toThrow(/Missing value/);
  });

  it("captures --config-path", () => {
    expect(parseSetupArgs(["--config-path=/tmp/c.json"]).configPath).toBe(
      "/tmp/c.json"
    );
  });
});

// ---------------------------------------------------------------------------
// runSetup — non-interactive, with stub fs + auth
// ---------------------------------------------------------------------------

interface FakeFs {
  files: Map<string, string>;
  fs: {
    readFile: (path: string, encoding: "utf8") => Promise<string>;
    writeFile: (path: string, data: string) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
    mkdir: (path: string, opts: { recursive: true }) => Promise<void>;
  };
}

function makeFakeFs(seed: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(seed));
  const fakeFs = {
    readFile: async (path: string): Promise<string> => {
      const v = files.get(path);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    writeFile: async (path: string, data: string): Promise<void> => {
      files.set(path, data);
    },
    rename: async (from: string, to: string): Promise<void> => {
      const v = files.get(from);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.delete(from);
      files.set(to, v);
    },
    mkdir: async (): Promise<void> => {
      // no-op for the in-memory fs
    },
  };
  return { files, fs: fakeFs };
}

function makeIo(): { io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }; output: () => string } {
  let captured = "";
  const writable: NodeJS.WritableStream = {
    write: (chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  // input is unused in non-interactive mode but must be present
  const input = { on: () => undefined, off: () => undefined } as unknown as NodeJS.ReadableStream;
  return { io: { input, output: writable }, output: () => captured };
}

describe("runSetup — non-interactive", () => {
  beforeEach(() => {
    delete process.env.WHOOP_CLIENT_ID;
    delete process.env.WHOOP_CLIENT_SECRET;
  });

  it("writes a fresh Claude Desktop config when none exists", async () => {
    const { io, output } = makeIo();
    const fake = makeFakeFs();

    await runSetup(
      {
        clientId: "id-1",
        clientSecret: "secret-1",
        client: "claude-desktop",
        configPath: "/fake/config.json",
      },
      { io, fs: fake.fs }
    );

    const written = fake.files.get("/fake/config.json");
    expect(written).toBeDefined();
    const parsed = JSON.parse(written ?? "{}") as {
      mcpServers: Record<string, { env: { WHOOP_CLIENT_ID: string } }>;
    };
    expect(parsed.mcpServers.whoop.env.WHOOP_CLIENT_ID).toBe("id-1");
    expect(fake.files.has("/fake/config.json.bak")).toBe(false);
    expect(output()).toContain("Claude Desktop config written");
  });

  it("backs up an existing config before overwriting", async () => {
    const { io } = makeIo();
    const original = JSON.stringify({ mcpServers: { other: { command: "x", args: [], env: {} } } });
    const fake = makeFakeFs({ "/fake/config.json": original });

    await runSetup(
      {
        clientId: "id-2",
        clientSecret: "secret-2",
        client: "claude-desktop",
        configPath: "/fake/config.json",
      },
      { io, fs: fake.fs }
    );

    expect(fake.files.get("/fake/config.json.bak")).toBe(original);
    const merged = JSON.parse(fake.files.get("/fake/config.json") ?? "{}") as {
      mcpServers: Record<string, unknown>;
    };
    expect(merged.mcpServers.other).toBeDefined();
    expect(merged.mcpServers.whoop).toBeDefined();
  });

  it("restores from .bak if the rename of the tmp file fails", async () => {
    const { io } = makeIo();
    const original = JSON.stringify({ mcpServers: { other: { command: "x", args: [], env: {} } } });
    const fake = makeFakeFs({ "/fake/config.json": original });
    let renameCount = 0;
    const wrappedRename = fake.fs.rename;
    fake.fs.rename = async (from: string, to: string): Promise<void> => {
      renameCount++;
      // First rename = tmp -> config.json (fail it).
      // Second rename = bak -> config.json (let it succeed = restore).
      if (renameCount === 1) throw new Error("disk full");
      return wrappedRename(from, to);
    };

    await expect(
      runSetup(
        {
          clientId: "id",
          clientSecret: "s",
          client: "claude-desktop",
          configPath: "/fake/config.json",
        },
        { io, fs: fake.fs }
      )
    ).rejects.toThrow(/Failed to write Claude Desktop config/);

    // Original content restored from backup
    expect(fake.files.get("/fake/config.json")).toBe(original);
  });

  it("refuses to overwrite a corrupt config file", async () => {
    const { io } = makeIo();
    const fake = makeFakeFs({ "/fake/config.json": "{not valid json" });

    await expect(
      runSetup(
        {
          clientId: "id",
          clientSecret: "s",
          client: "claude-desktop",
          configPath: "/fake/config.json",
        },
        { io, fs: fake.fs }
      )
    ).rejects.toThrow(/Refusing to overwrite/);

    // Original untouched
    expect(fake.files.get("/fake/config.json")).toBe("{not valid json");
  });

  it("prints the claude mcp add command for claude-code target", async () => {
    const { io, output } = makeIo();
    const fake = makeFakeFs();

    await runSetup(
      {
        clientId: "id",
        clientSecret: "secret",
        client: "claude-code",
      },
      { io, fs: fake.fs }
    );

    expect(output()).toContain("claude mcp add whoop");
    expect(output()).toContain("WHOOP_CLIENT_ID='id'");
    // No file should have been written for the claude-code path
    expect(fake.files.size).toBe(0);
  });

  it("--verify runs authenticate + fetchProfile and prints success", async () => {
    const { io, output } = makeIo();
    const fake = makeFakeFs();
    const authenticate = vi.fn(async () => "access-token-abc");
    const fetchProfile = vi.fn(async () => ({ user_id: 42 }));

    await runSetup(
      {
        clientId: "id",
        clientSecret: "secret",
        client: "claude-code",
        verify: true,
      },
      { io, fs: fake.fs, authenticate, fetchProfile }
    );

    expect(authenticate).toHaveBeenCalledWith({
      clientId: "id",
      clientSecret: "secret",
    });
    expect(fetchProfile).toHaveBeenCalledWith("access-token-abc");
    expect(output()).toContain("Verifying credentials");
    expect(output()).toContain("Profile OK");
  });

  it("--verify surfaces a clear error if authenticate fails", async () => {
    const { io } = makeIo();
    const fake = makeFakeFs();
    const authenticate = vi.fn(async () => {
      throw new Error("invalid_grant");
    });
    const fetchProfile = vi.fn();

    await expect(
      runSetup(
        {
          clientId: "id",
          clientSecret: "wrong",
          client: "claude-code",
          verify: true,
        },
        { io, fs: fake.fs, authenticate, fetchProfile }
      )
    ).rejects.toThrow(/Verification failed during OAuth.*invalid_grant/);

    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it("--verify surfaces a clear error if fetchProfile fails", async () => {
    const { io } = makeIo();
    const fake = makeFakeFs();
    const authenticate = vi.fn(async () => "tok");
    const fetchProfile = vi.fn(async () => {
      throw new Error("401 Unauthorized");
    });

    await expect(
      runSetup(
        {
          clientId: "id",
          clientSecret: "s",
          client: "claude-code",
          verify: true,
        },
        { io, fs: fake.fs, authenticate, fetchProfile }
      )
    ).rejects.toThrow(/Verification failed fetching profile.*401/);
  });

  it("rejects an empty client id", async () => {
    const { io } = makeIo();
    const fake = makeFakeFs();
    await expect(
      runSetup(
        { clientId: "   ", clientSecret: "s", client: "claude-code" },
        { io, fs: fake.fs }
      )
    ).rejects.toThrow(/WHOOP_CLIENT_ID is required/);
  });
});
