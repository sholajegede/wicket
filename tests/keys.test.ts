import { describe, expect, it } from "vitest";
import { KeyStore, KeyUnavailable, type Jwk, type Snapshot } from "../src/keys";

const k = (kid: string): Jwk => ({ kid, kty: "RSA", n: "x", e: "AQAB" });

function setup(cfg = { refreshS: 300, maxStaleS: 3600, minRefetchS: 10 }) {
  let t = 0;
  let remote: Jwk[] = [k("a")];
  let down = false;
  let shared: Snapshot | null = null;
  const calls = { fetch: 0 };
  const store = new KeyStore(cfg, {
    now: () => t,
    async fetchKeys() {
      calls.fetch++;
      if (down) throw new Error("down");
      return remote;
    },
    readShared: async () => shared,
    writeShared: async (s) => void (shared = s),
  });
  return { store, calls, at: (ms: number) => void (t = ms), rotate: (keys: Jwk[]) => void (remote = keys), outage: (v: boolean) => void (down = v), get shared() { return shared; } };
}

describe("key store", () => {
  it("reads the keys once and then serves from memory", async () => {
    const s = setup();
    expect((await s.store.key("a")).source).toBe("network");
    s.at(60_000);
    expect((await s.store.key("a")).source).toBe("memory");
    expect(s.calls.fetch).toBe(1);
  });

  it("another isolate in the same data center starts from the shared copy", async () => {
    const s = setup();
    await s.store.key("a");
    const other = new KeyStore({ refreshS: 300, maxStaleS: 3600, minRefetchS: 10 }, { now: () => 1000, fetchKeys: async () => { throw new Error("not needed"); }, readShared: async () => s.shared, writeShared: async () => undefined });
    expect((await other.key("a")).source).toBe("shared");
  });

  it("reads once more when a token names a key it does not have, and finds the rotated key", async () => {
    const s = setup();
    await s.store.key("a");
    s.rotate([k("a"), k("b")]);
    s.at(20_000);
    expect((await s.store.key("b")).source).toBe("network");
    expect(s.calls.fetch).toBe(2);
  });

  it("does not read again for a stream of unknown keys inside the minimum gap", async () => {
    const s = setup();
    await s.store.key("a");
    s.at(20_000);
    await expect(s.store.key("zzz")).rejects.toBeInstanceOf(KeyUnavailable);
    s.at(25_000);
    await expect(s.store.key("yyy")).rejects.toBeInstanceOf(KeyUnavailable);
    expect(s.calls.fetch).toBe(2);
  });

  it("keeps using the old keys when Kinde is down, until the stale limit", async () => {
    const s = setup();
    await s.store.key("a");
    s.outage(true);
    s.at(400_000);
    expect((await s.store.key("a")).source).toBe("stale");
    s.at(3_599_000);
    expect((await s.store.key("a")).source).toBe("stale");
    s.at(3_700_000);
    await expect(s.store.key("a")).rejects.toMatchObject({ reason: "stale-limit" });
  });

  it("a rotated-out key keeps verifying only while the old copy is inside the refresh window", async () => {
    const s = setup();
    await s.store.key("a");
    s.rotate([k("b")]);
    s.at(100_000);
    expect((await s.store.key("a")).source).toBe("memory");
    s.at(301_000);
    await expect(s.store.key("a")).rejects.toMatchObject({ reason: "unknown-key" });
  });
});
