import { describe, it, expect, vi } from "vitest";
import { getCycleById } from "../../src/tools/get-cycle-by-id.js";
import { ENDPOINT_CYCLE } from "../../src/api/endpoints.js";
import type { Cycle } from "../../src/api/types.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schema (mirrors server.ts registration)
// ---------------------------------------------------------------------------

const numericIdSchema = z.object({
  id: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CYCLE_FIXTURE: Cycle = {
  id: 200,
  user_id: 12345,
  created_at: "2026-04-10T00:00:00.000Z",
  updated_at: "2026-04-10T23:59:59.000Z",
  start: "2026-04-10T00:00:00.000Z",
  end: "2026-04-10T23:59:59.000Z",
  timezone_offset: "-04:00",
  score_state: "SCORED",
  score: {
    strain: 12.5,
    kilojoule: 9500,
    average_heart_rate: 68,
    max_heart_rate: 182,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getCycleById", () => {
  it("calls the correct endpoint with the given ID", async () => {
    const getMock = vi.fn().mockResolvedValue(CYCLE_FIXTURE);
    const client = { get: getMock } as never;

    await getCycleById(client, 200);

    expect(getMock).toHaveBeenCalledWith(`${ENDPOINT_CYCLE}/200`);
  });

  it("returns the cycle record", async () => {
    const getMock = vi.fn().mockResolvedValue(CYCLE_FIXTURE);
    const client = { get: getMock } as never;

    const result = await getCycleById(client, 200);

    expect(result).toEqual(CYCLE_FIXTURE);
  });

  it("works with large numeric IDs", async () => {
    const getMock = vi.fn().mockResolvedValue(CYCLE_FIXTURE);
    const client = { get: getMock } as never;

    await getCycleById(client, 999999999);

    expect(getMock).toHaveBeenCalledWith(`${ENDPOINT_CYCLE}/999999999`);
  });

  it("propagates errors from the client", async () => {
    const { WhoopApiError } = await import("../../src/api/client.js");
    const getMock = vi.fn().mockRejectedValue(new WhoopApiError(404, "Not Found", {}));
    const client = { get: getMock } as never;

    await expect(getCycleById(client, 999)).rejects.toThrow(WhoopApiError);
  });
});

describe("cycle ID validation (Zod schema)", () => {
  it("rejects negative IDs", () => {
    expect(() => numericIdSchema.parse({ id: -1 })).toThrow();
  });

  it("rejects zero", () => {
    expect(() => numericIdSchema.parse({ id: 0 })).toThrow();
  });

  it("rejects floating point IDs", () => {
    expect(() => numericIdSchema.parse({ id: 3.14 })).toThrow();
  });

  it("rejects string IDs", () => {
    expect(() => numericIdSchema.parse({ id: "../../admin" })).toThrow();
  });

  it("accepts valid positive integers", () => {
    expect(numericIdSchema.parse({ id: 200 })).toEqual({ id: 200 });
    expect(numericIdSchema.parse({ id: 1 })).toEqual({ id: 1 });
  });
});
