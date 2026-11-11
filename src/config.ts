import type { Env } from "./env";
import type { SiteConfig } from "./org-do";

const memory = new Map<string, { value: SiteConfig | null; at: number }>();
const HIT_MS = 10_000;
const MISS_MS = 5_000;

/** The settings of a site by slug: this isolate's memory first, then KV. A change can take a minute or more to reach every location. */
export async function siteConfig(env: Env, slug: string, now = Date.now()): Promise<{ config: SiteConfig | null; tier: "memory" | "kv" }> {
  const hit = memory.get(slug);
  if (hit && now - hit.at < (hit.value ? HIT_MS : MISS_MS)) return { config: hit.value, tier: "memory" };
  const value = (await env.SITES.get(`site:${slug}`, { type: "json", cacheTtl: 60 })) as SiteConfig | null;
  if (memory.size > 1000) memory.clear();
  memory.set(slug, { value, at: now });
  return { config: value, tier: "kv" };
}
