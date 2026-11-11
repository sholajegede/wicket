import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { Verdict } from "./tiers";

export interface Grant {
  email: string;
  grantedAt: number;
  expiresAt: number | null;
}

/**
 * The grants of one site. This is the only place where "this person may open the site" is decided, and there is one
 * instance in the world for each site, so a revoke written here is true everywhere at once. Every copy of an answer
 * elsewhere is a guess that ends by its window.
 */
export class SiteDO extends DurableObject<Env> {
  async check(email: string): Promise<Verdict> {
    const now = Date.now();
    const grant = await this.ctx.storage.get<Grant>(`g:${email}`);
    const version = (await this.ctx.storage.get<number>("v")) ?? 0;
    const allowed = !!grant && (grant.expiresAt === null || grant.expiresAt > now);
    return { allowed, verifiedAt: now, expiresAt: allowed ? grant!.expiresAt : null, version };
  }

  async grant(email: string, expiresAt: number | null): Promise<Grant> {
    const grant: Grant = { email, grantedAt: Date.now(), expiresAt };
    const version = ((await this.ctx.storage.get<number>("v")) ?? 0) + 1;
    await this.ctx.storage.put({ [`g:${email}`]: grant, v: version });
    return grant;
  }

  async revoke(email: string): Promise<boolean> {
    const existed = await this.ctx.storage.delete(`g:${email}`);
    if (existed) await this.ctx.storage.put("v", ((await this.ctx.storage.get<number>("v")) ?? 0) + 1);
    return existed;
  }

  async list(): Promise<Grant[]> {
    const all = await this.ctx.storage.list<Grant>({ prefix: "g:" });
    return [...all.values()].sort((a, b) => a.grantedAt - b.grantedAt);
  }

  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
