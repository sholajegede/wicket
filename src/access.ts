import type { Env } from "./env";
import { num } from "./env";
import type { SiteConfig } from "./org-do";
import { edgeCache, type Ctx } from "./edge-cache";
import { lookup, type Layer, type Tier, type Verdict } from "./tiers";

const memory = new Map<string, Verdict>();

function cacheRequest(key: string) {
  return new Request(`https://wicket.internal/grant/${encodeURIComponent(key)}`);
}

function layers(env: Env, ctx: Ctx): Layer[] {
  const windowMs = num(env.MEMORY_WINDOW_MS, 5000);
  const cacheWindowMs = num(env.CACHE_WINDOW_MS, 30_000);
  const denyWindowMs = num(env.DENY_WINDOW_MS, 2000);
  return [
    {
      name: "memory",
      windowMs,
      denyWindowMs,
      get: (k) => memory.get(k),
      put: (k, v) => {
        if (memory.size > 5000) memory.clear();
        memory.set(k, v);
      },
    },
    {
      name: "cache",
      windowMs: cacheWindowMs,
      denyWindowMs,
      get: async (k) => {
        try {
          const res = await edgeCache().match(cacheRequest(k));
          return res ? ((await res.json()) as Verdict) : undefined;
        } catch {
          return undefined;
        }
      },
      put: (k, v) => {
        ctx.waitUntil(
          edgeCache()
            .put(cacheRequest(k), new Response(JSON.stringify(v), { headers: { "cache-control": `max-age=${Math.max(1, Math.ceil(cacheWindowMs / 1000))}` } }))
            .catch(() => undefined),
        );
      },
    },
  ];
}

/**
 * May this email open this site? A "fast" site is answered from this isolate, then from the data center cache, and only
 * then from the Durable Object. A "strict" site is answered by the Durable Object every time.
 */
export async function mayOpen(env: Env, ctx: Ctx, site: SiteConfig, email: string): Promise<{ verdict: Verdict; tier: Tier }> {
  const stub = env.SITE.get(env.SITE.idFromName(site.id));
  return lookup(`${site.id}|${email}`, site.mode === "strict" ? [] : layers(env, ctx), () => stub.check(email));
}

/** Drops this isolate's copy. The one data center that served the revoke is the only place this reaches. */
export function forget(siteId: string, email: string) {
  memory.delete(`${siteId}|${email}`);
}
