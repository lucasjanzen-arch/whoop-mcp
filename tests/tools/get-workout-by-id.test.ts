import { describe, it, expect, vi } from "vitest";
import { getWorkoutById } from "../../src/tools/get-workout-by-id.js";
import { ENDPOINT_WORKOUT } from "../../src/api/endpoints.js";
import type { Workout } from "../../src/api/types.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schema (mirrors server.ts registration)
// ---------------------------------------------------------------------------

const stringIdSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKOUT_FIXTURE: Workout = {
  id: "workout-xyz-789",
  user_id: 12345,
  created_at: "2026-04-10T18:00:00.000Z",
  updated_at: "2026-04-10T19:00:00.000Z",
  start: "2026-04-10T17:00:00.000Z",
  end: "2026-04-10T18:00:00.000Z",
  timezone_offset: "-04:00",
  sport_name: "Running",
  score_state: "SCORED",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getWorkoutById", () => {
  it("calls the correct endpoint with the given ID", async () => {
    const getMock = vi.fn().mockResolvedValue(WORKOUT_FIXTURE);
    const client = { get: getMock } as never;

    await getWorkoutById(client, "workout-xyz-789");

    expect(getMock).toHaveBeenCalledWith(
      `${ENDPOINT_WORKOUT}/${encodeURIComponent("workout-xyz-789")}`
    );
  });

  it("returns the workout record", async () => {
    const getMock = vi.fn().mockResolvedValue(WORKOUT_FIXTURE);
    const client = { get: getMock } as never;

    const result = await getWorkoutById(client, "workout-xyz-789");

    expect(result).toEqual(WORKOUT_FIXTURE);
  });

  it("encodes special characters in the ID", async () => {
    const getMock = vi.fn().mockResolvedValue(WORKOUT_FIXTURE);
    const client = { get: getMock } as never;

    await getWorkoutById(client, "id_with-special");

    expect(getMock).toHaveBeenCalledWith(
      `${ENDPOINT_WORKOUT}/${encodeURIComponent("id_with-special")}`
    );
  });

  it("propagates errors from the client", async () => {
    const { WhoopApiError } = await import("../../src/api/client.js");
    const getMock = vi.fn().mockRejectedValue(new WhoopApiError(404, "Not Found", {}));
    const client = { get: getMock } as never;

    await expect(getWorkoutById(client, "nonexistent")).rejects.toThrow(WhoopApiError);
  });
});

describe("workout ID validation (Zod schema)", () => {
  it("rejects path traversal attempts", () => {
    expect(() => stringIdSchema.parse({ id: "../../admin" })).toThrow();
    expect(() => stringIdSchema.parse({ id: "foo/bar" })).toThrow();
  });

  it("accepts valid IDs", () => {
    expect(stringIdSchema.parse({ id: "workout-xyz-789" })).toEqual({ id: "workout-xyz-789" });
  });
});
