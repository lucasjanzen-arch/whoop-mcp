import { describe, it, expect, vi } from "vitest";
import {
  withPreview,
  type WritePreview,
  type WriteReceipt,
  type WriteResult,
} from "../../src/tools/write-safety.js";

// A representative payload + server result for a hypothetical future write tool.
interface JournalPayload {
  date: string;
  note: string;
}

interface JournalRecord {
  id: number;
  date: string;
  note: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("withPreview", () => {
  describe("preview mode (confirm: false)", () => {
    it("returns a WritePreview without calling the write function", async () => {
      const write = vi.fn<(p: JournalPayload, key: string) => Promise<JournalRecord>>();
      const result = await withPreview({
        confirm: false,
        summary: "Create a journal note for 2026-04-12",
        payload: { date: "2026-04-12", note: "felt great" },
        write,
      });

      expect(result.preview).toBe(true);
      expect(write).not.toHaveBeenCalled();
    });

    it("includes the summary and payload in the preview", async () => {
      const result = await withPreview({
        confirm: false,
        summary: "Create a journal note",
        payload: { date: "2026-04-12", note: "hello" },
        write: async () => ({ id: 1, date: "2026-04-12", note: "hello" }),
      });

      if (!result.preview) throw new Error("expected preview");
      expect(result.summary).toBe("Create a journal note");
      expect(result.payload).toEqual({ date: "2026-04-12", note: "hello" });
    });

    it("generates a UUID v4 idempotency_key", async () => {
      const result = await withPreview({
        confirm: false,
        summary: "x",
        payload: { date: "2026-04-12", note: "n" },
        write: async () => ({ id: 1, date: "2026-04-12", note: "n" }),
      });

      expect(result.idempotency_key).toMatch(UUID_V4);
    });

    it("generates a unique idempotency_key per call", async () => {
      const make = (): Promise<WriteResult<JournalPayload, JournalRecord>> =>
        withPreview({
          confirm: false,
          summary: "x",
          payload: { date: "2026-04-12", note: "n" },
          write: async () => ({ id: 1, date: "2026-04-12", note: "n" }),
        });

      const [a, b] = await Promise.all([make(), make()]);
      expect(a.idempotency_key).not.toBe(b.idempotency_key);
    });
  });

  describe("confirm mode (confirm: true)", () => {
    it("executes the write and returns a WriteReceipt", async () => {
      const write = vi.fn(async (p: JournalPayload) => ({
        id: 42,
        date: p.date,
        note: p.note,
      }));

      const result = await withPreview({
        confirm: true,
        summary: "Create a journal note",
        payload: { date: "2026-04-12", note: "felt great" },
        write,
      });

      expect(result.preview).toBe(false);
      if (result.preview) throw new Error("expected receipt");
      expect(result.result).toEqual({ id: 42, date: "2026-04-12", note: "felt great" });
      expect(write).toHaveBeenCalledTimes(1);
    });

    it("passes the payload and idempotency_key to the write function", async () => {
      const write = vi.fn(async (p: JournalPayload) => ({ id: 1, date: p.date, note: p.note }));

      const result = await withPreview({
        confirm: true,
        summary: "x",
        payload: { date: "2026-04-12", note: "n" },
        write,
      });

      if (result.preview) throw new Error("expected receipt");
      expect(write).toHaveBeenCalledWith({ date: "2026-04-12", note: "n" }, result.idempotency_key);
    });

    it("reuses a supplied idempotency_key (safe retry)", async () => {
      const key = "11111111-1111-4111-8111-111111111111";
      const write = vi.fn(async (p: JournalPayload) => ({ id: 1, date: p.date, note: p.note }));

      const result = await withPreview({
        confirm: true,
        summary: "x",
        payload: { date: "2026-04-12", note: "n" },
        idempotencyKey: key,
        write,
      });

      expect(result.idempotency_key).toBe(key);
      expect(write).toHaveBeenCalledWith({ date: "2026-04-12", note: "n" }, key);
    });

    it("propagates errors thrown by the write function", async () => {
      const write = vi.fn(async () => {
        throw new Error("write failed");
      });

      await expect(
        withPreview({
          confirm: true,
          summary: "x",
          payload: { date: "2026-04-12", note: "n" },
          write,
        })
      ).rejects.toThrow("write failed");
    });
  });

  describe("type narrowing", () => {
    it("narrows to WritePreview / WriteReceipt via the preview discriminant", async () => {
      const result: WriteResult<JournalPayload, JournalRecord> = await withPreview({
        confirm: false,
        summary: "x",
        payload: { date: "2026-04-12", note: "n" },
        write: async () => ({ id: 1, date: "2026-04-12", note: "n" }),
      });

      if (result.preview) {
        const preview: WritePreview<JournalPayload> = result;
        expect(preview.payload.note).toBe("n");
      } else {
        const receipt: WriteReceipt<JournalRecord> = result;
        expect(receipt.result.id).toBeGreaterThan(0);
      }
    });
  });
});
