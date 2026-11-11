/**
 * The signing keys of the Kinde tenant, kept in two places: this isolate's memory and the Cache API of the data center.
 * A key is used while the copy is younger than `refreshS`. After that the keys are read again from Kinde, and if Kinde
 * cannot be reached the old copy is still used until it is older than `maxStaleS`. An unknown key ID causes one new read,
 * and no more than one in `minRefetchS`, so a stream of forged tokens cannot turn into a stream of requests to Kinde.
 */

export interface Jwk {
  kid?: string;
  kty: string;
  [field: string]: unknown;
}

export interface Snapshot {
  keys: Jwk[];
  fetchedAt: number;
}

export interface KeyConfig {
  refreshS: number;
  maxStaleS: number;
  minRefetchS: number;
}

export interface KeyIO {
  fetchKeys(): Promise<Jwk[]>;
  readShared(): Promise<Snapshot | null>;
  writeShared(snapshot: Snapshot): Promise<void>;
  now(): number;
}

export type KeySource = "memory" | "shared" | "network" | "stale";

export class KeyUnavailable extends Error {
  constructor(readonly reason: "unknown-key" | "stale-limit" | "unreachable") {
    super(reason === "unknown-key" ? "The token was signed with a key this tenant does not publish." : reason === "stale-limit" ? "The signing keys are older than the allowed limit and Kinde could not be reached." : "There are no signing keys yet and Kinde could not be reached.");
  }
}

export class KeyStore {
  private snapshot: Snapshot | null = null;
  private lastAttempt = -Infinity;
  readonly stats = { network: 0, failed: 0 };

  constructor(private cfg: KeyConfig, private io: KeyIO) {}

  async key(kid: string | undefined, opts: { down?: boolean; maxStaleS?: number } = {}): Promise<{ jwk: Jwk; source: KeySource; ageMs: number }> {
    const maxStaleS = Math.min(this.cfg.maxStaleS, opts.maxStaleS ?? Infinity);
    const find = () => this.snapshot?.keys.find((k) => (kid === undefined ? true : k.kid === kid));
    const age = () => (this.snapshot ? this.io.now() - this.snapshot.fetchedAt : Infinity);

    if (find() && age() <= this.cfg.refreshS * 1000) return { jwk: find()!, source: "memory", ageMs: age() };

    const shared = await this.io.readShared();
    if (shared && (!this.snapshot || shared.fetchedAt > this.snapshot.fetchedAt)) this.snapshot = shared;
    if (find() && age() <= this.cfg.refreshS * 1000) return { jwk: find()!, source: "shared", ageMs: age() };

    if (this.io.now() - this.lastAttempt >= this.cfg.minRefetchS * 1000) {
      this.lastAttempt = this.io.now();
      try {
        if (opts.down) throw new Error("simulated outage");
        const keys = await this.io.fetchKeys();
        this.stats.network++;
        this.snapshot = { keys, fetchedAt: this.io.now() };
        await this.io.writeShared(this.snapshot);
        const found = find();
        if (found) return { jwk: found, source: "network", ageMs: 0 };
        throw new KeyUnavailable("unknown-key");
      } catch (error) {
        if (error instanceof KeyUnavailable) throw error;
        this.stats.failed++;
      }
    }

    const old = find();
    if (old && age() <= maxStaleS * 1000) return { jwk: old, source: "stale", ageMs: age() };
    throw new KeyUnavailable(old ? "stale-limit" : this.snapshot ? "unknown-key" : "unreachable");
  }
}
