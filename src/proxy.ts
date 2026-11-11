import { sign } from "./context";
import type { SiteConfig } from "./org-do";

/** Cookies the gate owns are never passed on to the protected site. */
function stripGateCookies(header: string | null): string | null {
  if (!header) return null;
  const kept = header.split(";").map((c) => c.trim()).filter((c) => c && !c.startsWith("wk_"));
  return kept.length ? kept.join("; ") : null;
}

export async function forward(req: Request, config: SiteConfig, slug: string, path: string, search: string, secret: string, identity: string | null): Promise<Response> {
  const headers = new Headers(req.headers);
  for (const name of ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto", "x-wicket-site", "x-wicket-email", "x-wicket-ts", "x-wicket-signature"]) headers.delete(name);
  const cookies = stripGateCookies(req.headers.get("cookie"));
  if (cookies) headers.set("cookie", cookies);
  else headers.delete("cookie");
  if (identity) for (const [k, v] of Object.entries(await sign(secret, { site: config.id, email: identity, ts: Date.now() }))) headers.set(k, v);

  const upstream = await fetch(config.origin + path + search, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });

  const out = new Headers(upstream.headers);
  const location = out.get("location");
  if (location && location.startsWith(config.origin)) out.set("location", `/s/${slug}${location.slice(config.origin.length) || "/"}`);
  else if (location && location.startsWith("/")) out.set("location", `/s/${slug}${location}`);
  out.set("cache-control", out.get("cache-control")?.includes("public") ? "private, max-age=0" : out.get("cache-control") ?? "private, no-store");
  out.set("x-robots-tag", "noindex, nofollow");
  out.append("vary", "Cookie");
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export function isOpenPath(open: string[], path: string): boolean {
  return open.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`));
}
