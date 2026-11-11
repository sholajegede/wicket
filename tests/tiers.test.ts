import { describe, expect, it } from "vitest";
import { lookup, type Layer, type Verdict } from "../src/tiers";

function layer(name: Layer["name"], windowMs: number, denyWindowMs = 2000) {
  const map = new Map<string, Verdict>();
  const l: Layer & { map: Map<string, Verdict> } = { name, windowMs, denyWindowMs, map, get: (k) => map.get(k), put: (k, v) => void map.set(k, v) };
  return l;
}
const verdict = (over: Partial<Verdict> = {}): Verdict => ({ allowed: true, verifiedAt: 0, expiresAt: null, version: 1, ...over });

describe("tiered lookup", () => {
  it("asks the source on a cold start and fills every layer", async () => {
    const mem = layer("memory", 5000);
    const cache = layer("cache", 30000);
    let calls = 0;
    const r = await lookup("k", [mem, cache], async () => (calls++, verdict({ verifiedAt: 100 })), () => 100);
    expect(r.tier).toBe("source");
    expect(calls).toBe(1);
    expect(mem.map.has("k") && cache.map.has("k")).toBe(true);
  });

  it("serves from memory inside its window and does not ask the source", async () => {
    const mem = layer("memory", 5000);
    mem.map.set("k", verdict({ verifiedAt: 1000 }));
    const r = await lookup("k", [mem], async () => { throw new Error("asked"); }, () => 5999);
    expect(r.tier).toBe("memory");
  });

  it("ignores a memory copy after its window and falls to the next layer", async () => {
    const mem = layer("memory", 5000);
    const cache = layer("cache", 30000);
    mem.map.set("k", verdict({ verifiedAt: 0 }));
    cache.map.set("k", verdict({ verifiedAt: 0 }));
    const r = await lookup("k", [mem, cache], async () => { throw new Error("asked"); }, () => 6000);
    expect(r.tier).toBe("cache");
  });

  it("keeps the original time when it refills a nearer layer, so an old answer never looks new", async () => {
    const mem = layer("memory", 5000);
    const cache = layer("cache", 30000);
    cache.map.set("k", verdict({ verifiedAt: 0 }));
    await lookup("k", [mem, cache], async () => verdict(), () => 20000);
    expect(mem.map.get("k")?.verifiedAt).toBe(0);
    // a few seconds later the memory copy is older than its window, even though it was only just copied
    const r = await lookup("k", [mem, cache], async () => verdict({ allowed: false, verifiedAt: 26000 }), () => 26000);
    expect(r.tier).toBe("cache");
    const again = await lookup("k", [mem, cache], async () => verdict({ allowed: false, verifiedAt: 31000 }), () => 31000);
    expect(again.tier).toBe("source");
    expect(again.verdict.allowed).toBe(false);
  });

  it("stops serving an allowed answer once the grant has ended, even inside the window", async () => {
    const mem = layer("memory", 5000);
    mem.map.set("k", verdict({ verifiedAt: 1000, expiresAt: 2000 }));
    const r = await lookup("k", [mem], async () => verdict({ allowed: false, verifiedAt: 2500 }), () => 2500);
    expect(r.tier).toBe("source");
  });

  it("keeps a denied answer for a shorter time than an allowed one", async () => {
    const mem = layer("memory", 5000, 2000);
    mem.map.set("k", verdict({ allowed: false, verifiedAt: 0 }));
    expect((await lookup("k", [mem], async () => verdict({ verifiedAt: 3000 }), () => 1500)).tier).toBe("memory");
    expect((await lookup("k", [mem], async () => verdict({ verifiedAt: 3000 }), () => 3000)).tier).toBe("source");
  });

  it("a strict site has no layers and always asks the source", async () => {
    let calls = 0;
    await lookup("k", [], async () => (calls++, verdict()));
    await lookup("k", [], async () => (calls++, verdict()));
    expect(calls).toBe(2);
  });
});
