import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { fetchSiteLimit } from "./kinde";
import { parseOrigin, slugFor } from "./limits";

export type Mode = "fast" | "strict";

export interface SiteRecord {
  id: string;
  slug: string;
  name: string;
  origin: string;
  mode: Mode;
  open: string[];
  createdAt: number;
}

/** What the gate reads for every request. It lives in KV because it changes rarely and may be a minute old. */
export interface SiteConfig {
  id: string;
  org: string;
  origin: string;
  mode: Mode;
  open: string[];
}

type Result<T> = ({ ok: true } & T) | { ok: false; status: number; error: string; limit?: number | null };

const LIMIT_MAX_AGE_MS = 30_000;

/** The sites of one organization. One instance for each organization, so the count against the plan cannot race. */
export class OrgDO extends DurableObject<Env> {
  async list(): Promise<SiteRecord[]> {
    const all = await this.ctx.storage.list<SiteRecord>({ prefix: "site:" });
    return [...all.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async find(id: string): Promise<SiteRecord | undefined> {
    return this.ctx.storage.get<SiteRecord>(`site:${id}`);
  }

  async limit(org: string): Promise<{ max: number | null } | null> {
    const cached = await this.ctx.storage.get<{ max: number | null; at: number }>("limit");
    if (cached && Date.now() - cached.at < LIMIT_MAX_AGE_MS) return { max: cached.max };
    try {
      const max = await fetchSiteLimit(this.env, org);
      await this.ctx.storage.put("limit", { max, at: Date.now() });
      return { max };
    } catch (error) {
      console.error(`limit lookup failed for ${org}: ${error instanceof Error ? error.message : error}`);
      return cached ? { max: cached.max } : null;
    }
  }

  async create(org: string, input: { origin: string; name?: string; mode?: Mode; open?: string[] }, selfHost: string): Promise<Result<{ site: SiteRecord }>> {
    const parsed = parseOrigin(input.origin, selfHost, this.env.ALLOW_LOCAL_ORIGINS === "1");
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    const limit = await this.limit(org);
    if (!limit) return { ok: false, status: 503, error: "The plan could not be checked right now. Try again." };
    // From here to the write there is no network call, so no other request can run in between.
    const count = (await this.ctx.storage.list({ prefix: "site:" })).size;
    if (limit.max !== null && count >= limit.max) return { ok: false, status: 402, error: `Your plan allows ${limit.max} protected ${limit.max === 1 ? "site" : "sites"}.`, limit: limit.max };
    const id = crypto.randomUUID();
    const site: SiteRecord = {
      id,
      slug: slugFor(parsed.origin, id.slice(0, 6)),
      name: input.name?.trim() || new URL(parsed.origin).hostname,
      origin: parsed.origin,
      mode: input.mode === "strict" ? "strict" : "fast",
      open: (input.open ?? []).filter((p) => typeof p === "string" && p.startsWith("/")).slice(0, 20),
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(`site:${id}`, site);
    try {
      await this.publish(org, site);
    } catch (error) {
      await this.ctx.storage.delete(`site:${id}`);
      return { ok: false, status: 503, error: "The gate could not be published. Try again." };
    }
    return { ok: true, site };
  }

  async update(org: string, id: string, patch: { mode?: Mode; open?: string[]; name?: string }): Promise<SiteRecord | null> {
    const site = await this.find(id);
    if (!site) return null;
    if (patch.mode === "fast" || patch.mode === "strict") site.mode = patch.mode;
    if (Array.isArray(patch.open)) site.open = patch.open.filter((p) => typeof p === "string" && p.startsWith("/")).slice(0, 20);
    if (typeof patch.name === "string" && patch.name.trim()) site.name = patch.name.trim();
    await this.ctx.storage.put(`site:${id}`, site);
    await this.publish(org, site);
    return site;
  }

  async remove(id: string): Promise<boolean> {
    const site = await this.find(id);
    if (!site) return false;
    await this.ctx.storage.delete(`site:${id}`);
    await this.env.SITES.delete(`site:${site.slug}`);
    await this.env.SITE.get(this.env.SITE.idFromName(id)).wipe();
    return true;
  }

  private async publish(org: string, site: SiteRecord): Promise<void> {
    const config: SiteConfig = { id: site.id, org, origin: site.origin, mode: site.mode, open: site.open };
    await this.env.SITES.put(`site:${site.slug}`, JSON.stringify(config));
  }
}
