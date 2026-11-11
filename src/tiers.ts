/**
 * A lookup through copies of one answer, nearest first. Every copy keeps the time the source gave the answer
 * (`verifiedAt`), and a copy is served only while that time is inside the window of the layer holding it.
 * A copy refilled from a farther layer keeps the original time, so an old answer cannot look new by being copied.
 */

export interface Verdict {
  allowed: boolean;
  /** when the source of truth gave this answer */
  verifiedAt: number;
  /** when the grant ends, or null for no end */
  expiresAt: number | null;
  /** counts every change to the grants of the site */
  version: number;
}

export type Tier = "memory" | "cache" | "source";

export interface Layer {
  name: Tier;
  /** how long an "allowed" answer may be served from this layer */
  windowMs: number;
  /** how long a "denied" answer may be served from this layer */
  denyWindowMs: number;
  get(key: string): Promise<Verdict | undefined> | Verdict | undefined;
  put(key: string, verdict: Verdict): Promise<void> | void;
}

export function fresh(v: Verdict, layer: Pick<Layer, "windowMs" | "denyWindowMs">, now: number): boolean {
  if (v.expiresAt !== null && now >= v.expiresAt) return false;
  return now - v.verifiedAt <= (v.allowed ? layer.windowMs : layer.denyWindowMs);
}

export async function lookup(
  key: string,
  layers: Layer[],
  source: () => Promise<Verdict>,
  now: () => number = Date.now,
): Promise<{ verdict: Verdict; tier: Tier }> {
  for (let i = 0; i < layers.length; i++) {
    const hit = await layers[i].get(key);
    if (hit && fresh(hit, layers[i], now())) {
      await Promise.all(layers.slice(0, i).map((l) => l.put(key, hit)));
      return { verdict: hit, tier: layers[i].name };
    }
  }
  const verdict = await source();
  await Promise.all(layers.map((l) => l.put(key, verdict)));
  return { verdict, tier: "source" };
}
