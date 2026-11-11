/** Rules that need no network, so each can be tested alone. */

/** Kinde reports an unmetered feature as this value. */
const UNMETERED = 2147483647;

/** The most sites a plan allows. null means no maximum. */
export function maxSitesFromKinde(body: unknown, featureCode: string): number | null {
  const list = (body as { entitlements?: unknown } | null)?.entitlements;
  if (!Array.isArray(list)) return 0;
  let seen = false;
  let best: number | null = 0;
  for (const item of list) {
    const e = item as Record<string, unknown> | null;
    if (!e || e.feature_code !== featureCode) continue;
    const raw = e.entitlement_limit_max;
    const max = typeof raw === "number" && raw < UNMETERED ? raw : null;
    best = !seen ? max : best === null || max === null ? null : Math.max(best, max);
    seen = true;
  }
  return seen ? best : 0;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? v : null;
}

/** The permission context of an owner token. An empty requirement means any member of the organization may manage sites. */
export function mayManage(claims: { org_code?: unknown; permissions?: unknown }, required: string): { ok: true; org: string } | { ok: false; status: 403; error: string } {
  const org = typeof claims.org_code === "string" ? claims.org_code : "";
  if (!org) return { ok: false, status: 403, error: "The token has no organization." };
  if (required) {
    const have = Array.isArray(claims.permissions) ? (claims.permissions as unknown[]) : [];
    if (!have.includes(required)) return { ok: false, status: 403, error: `This action needs the ${required} permission.` };
  }
  return { ok: true, org };
}

/** A site address a person types. The gate refuses to protect itself or anything that is not https. */
export function parseOrigin(value: unknown, selfHost: string, allowLocal = false): { ok: true; origin: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: "Give the address of the site to protect." };
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return { ok: false, error: "That is not a valid address." };
  }
  if (allowLocal) return { ok: true, origin: u.origin + u.pathname.replace(/\/$/, "") };
  if (u.protocol !== "https:") return { ok: false, error: "The site must use https." };
  if (u.hostname === selfHost) return { ok: false, error: "A gate cannot protect itself." };
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname) || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(":")) return { ok: false, error: "Use a public host name." };
  return { ok: true, origin: u.origin + u.pathname.replace(/\/$/, "") };
}

export function slugFor(origin: string, random: string): string {
  const host = new URL(origin).hostname.replace(/^www\./, "").split(".")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
  return `${host.slice(0, 24)}-${random}`;
}
