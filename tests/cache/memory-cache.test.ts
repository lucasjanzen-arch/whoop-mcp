import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryCache } from "../../src/cache/memory-cache.js";

describe("MemoryCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // get / set / has / size / clear
  // -------------------------------------------------------------------------

  it("returns undefined for a missing key", () => {
    const cache = new MemoryCache<number>();
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.has("missing")).toBe(false);
  });

  it("stores and retrieves a value", () => {
    const cache = new MemoryCache<{ score: number }>();
    cache.set("a", { score: 85 });
    expect(cache.get("a")).toEqual({ score: 85 });
    expect(cache.has("a")).toBe(true);
  });

  it("tracks size as entries are added and cleared", () => {
    const cache = new MemoryCache<number>();
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("overwrites an existing key without growing size", () => {
    const cache = new MemoryCache<number>();
    cache.set("a", 1);
    cache.set("a", 2);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe(2);
  });

  it("deletes a key", () => {
    const cache = new MemoryCache<number>();
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.has("a")).toBe(false);
    expect(cache.delete("a")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TTL expiry
  // -------------------------------------------------------------------------

  it("expires an entry after the default TTL", () => {
    const cache = new MemoryCache<number>({ defaultTtlMs: 5000 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    vi.advanceTimersByTime(5001);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.has("a")).toBe(false);
  });

  it("honours a per-set TTL override", () => {
    const cache = new MemoryCache<number>({ defaultTtlMs: 60_000 });
    cache.set("a", 1, 1000);
    vi.advanceTimersByTime(1001);
    expect(cache.get("a")).toBeUndefined();
  });

  it("lazily removes expired entries from size on access", () => {
    const cache = new MemoryCache<number>({ defaultTtlMs: 1000 });
    cache.set("a", 1);
    vi.advanceTimersByTime(1001);
    // has() observes expiry and prunes
    expect(cache.has("a")).toBe(false);
    expect(cache.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // LRU eviction
  // -------------------------------------------------------------------------

  it("evicts the least-recently-used entry when maxEntries is exceeded", () => {
    const cache = new MemoryCache<number>({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts "a" (LRU)
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("treats a get() as a use, protecting the entry from eviction", () => {
    const cache = new MemoryCache<number>({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // "a" is now most-recently-used
    cache.set("c", 3); // evicts "b" instead of "a"
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  it("treats a set() on an existing key as a use", () => {
    const cache = new MemoryCache<number>({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10); // refresh "a"
    cache.set("c", 3); // evicts "b"
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // getOrFetch — dedup + generation invalidation
  // -------------------------------------------------------------------------

  it("getOrFetch returns fetched data on a miss and caches it", async () => {
    const cache = new MemoryCache();
    const fetcher = vi.fn().mockResolvedValue({ score: 85 });

    const first = await cache.getOrFetch("k", 5000, fetcher);
    const second = await cache.getOrFetch("k", 5000, fetcher);

    expect(first).toEqual({ score: 85 });
    expect(second).toEqual({ score: 85 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("getOrFetch re-fetches after TTL expiry", async () => {
    const cache = new MemoryCache();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ score: 85 })
      .mockResolvedValueOnce({ score: 90 });

    await cache.getOrFetch("k", 5000, fetcher);
    vi.advanceTimersByTime(5001);
    const result = await cache.getOrFetch("k", 5000, fetcher);

    expect(result).toEqual({ score: 90 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("getOrFetch deduplicates concurrent in-flight requests (stampede prevention)", async () => {
    const cache = new MemoryCache();
    let resolve!: (v: unknown) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise((r) => (resolve = r)));

    const p1 = cache.getOrFetch("k", 5000, fetcher);
    const p2 = cache.getOrFetch("k", 5000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolve({ score: 85 });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ score: 85 });
    expect(r2).toEqual({ score: 85 });
  });

  it("clear() prevents a stale in-flight fetch from repopulating the cache", async () => {
    const cache = new MemoryCache();
    let resolveFirst!: (v: unknown) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce({ score: 99 });

    const p1 = cache.getOrFetch("k", 5000, fetcher);
    cache.clear(); // invalidate mid-flight
    resolveFirst({ score: 85 });
    await p1;

    // The in-flight result must NOT have been cached → next call re-fetches
    const result = await cache.getOrFetch("k", 5000, fetcher);
    expect(result).toEqual({ score: 99 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("clear() drops the in-flight entry so a new caller starts a fresh fetch", async () => {
    const cache = new MemoryCache();
    let resolveFirst!: (v: unknown) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce({ score: 7 });

    const p1 = cache.getOrFetch("k", 5000, fetcher);
    cache.clear(); // purges the in-flight map

    // A caller arriving after clear must NOT join the pre-clear fetch.
    const p2 = cache.getOrFetch("k", 5000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);

    resolveFirst({ score: 1 });
    await p1;
    await expect(p2).resolves.toEqual({ score: 7 });
  });

  it("invalidateAll() is an alias for clear()", async () => {
    const cache = new MemoryCache<number>();
    cache.set("a", 1);
    cache.invalidateAll();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("getOrFetch propagates fetch errors and does not cache them", async () => {
    const cache = new MemoryCache();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true });

    await expect(cache.getOrFetch("k", 5000, fetcher)).rejects.toThrow("boom");
    const result = await cache.getOrFetch("k", 5000, fetcher);
    expect(result).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
