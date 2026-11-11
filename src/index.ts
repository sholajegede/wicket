import { Hono } from "hono";
import type { Context } from "hono";
import { mayOpen } from "./access";
import { siteConfig } from "./config";
import { clear, cookie, parseCookies } from "./cookies";
import { type Env, num } from "./env";
import { KeyStore, type Jwk, type Snapshot } from "./keys";
import { mayManage, normalizeEmail } from "./limits";
import { denied, notFound, page, paused } from "./pages";
import { challengeFor, random, safePath } from "./gate";
import { edgeCache, type Ctx } from "./edge-cache";
import { forward, isOpenPath } from "./proxy";
import { SessionError, verifyAccess, verifySession } from "./session";

export { OrgDO } from "./org-do";
export { SiteDO } from "./site-do";

const app = new Hono<{ Bindings: Env }>();

// ---- signing keys: this isolate's memory, then the Cache API of the data center, then Kinde ----------------------------

let store: KeyStore | null = null;
const jwksRequest = new Request("https://wicket.internal/jwks");

function keys(env: Env, ctx: Ctx): KeyStore {
  if (store) return store;
  const maxStaleS = num(env.JWKS_MAX_STALE_S, 86_400);
  store = new KeyStore(
    { refreshS: num(env.JWKS_REFRESH_S, 300), maxStaleS, minRefetchS: 10 },
    {
      now: () => Date.now(),
      async fetchKeys(): Promise<Jwk[]> {
        const res = await fetch(`${env.KINDE_DOMAIN}/.well-known/jwks`);
        if (!res.ok) throw new Error(`jwks request failed: ${res.status}`);
        return ((await res.json()) as { keys: Jwk[] }).keys;
      },
      async readShared(): Promise<Snapshot | null> {
        try {
          const res = await edgeCache().match(jwksRequest);
          return res ? ((await res.json()) as Snapshot) : null;
        } catch {
          return null;
        }
      },
      async writeShared(snapshot: Snapshot) {
        ctx.waitUntil(edgeCache().put(jwksRequest, new Response(JSON.stringify(snapshot), { headers: { "cache-control": `max-age=${maxStaleS}` } })).catch(() => undefined));
      },
    },
  );
  return store;
}

const simulatedOutage = (c: Context<{ Bindings: Env }>) => c.env.ALLOW_SIMULATION === "1" && c.req.header("x-wicket-simulate") === "kinde-down";

// ---- helpers ----------------------------------------------------------------------------------------------------------

const orgStub = (env: Env, org: string) => env.ORG.get(env.ORG.idFromName(org));


// ---- sign-in for the people a site is shared with ---------------------------------------------------------------------

async function startLogin(c: Context<{ Bindings: Env }>, slug: string, path: string, prompt = false): Promise<Response> {
  const verifier = random();
  const state = random();
  const challenge = await challengeFor(verifier);
  const url = new URL(`${c.env.KINDE_DOMAIN}/oauth2/auth`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: c.env.KINDE_CLIENT_ID,
    redirect_uri: `${new URL(c.req.url).origin}/_wicket/callback`,
    scope: "openid profile email",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...(prompt ? { prompt: "login" } : {}),
  }).toString();
  const res = c.redirect(url.toString(), 302);
  res.headers.append("set-cookie", cookie("wk_pkce", JSON.stringify({ state, verifier, slug, path }), 600));
  res.headers.set("cache-control", "no-store");
  return res;
}

app.get("/_wicket/login", (c) => startLogin(c, c.req.query("site") ?? "", safePath(c.req.query("path")), c.req.query("switch") === "1"));

app.get("/_wicket/callback", async (c) => {
  const saved = (() => {
    try {
      return JSON.parse(parseCookies(c.req.header("cookie")).wk_pkce ?? "null") as { state: string; verifier: string; slug: string; path: string } | null;
    } catch {
      return null;
    }
  })();
  if (!saved || !c.req.query("code") || c.req.query("state") !== saved.state) return page(400, "The sign-in could not be", "checked", "Open the link you were sent and sign in again.");
  const tokenRes = await fetch(`${c.env.KINDE_DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: c.env.KINDE_CLIENT_ID,
      code: c.req.query("code")!,
      code_verifier: saved.verifier,
      redirect_uri: `${new URL(c.req.url).origin}/_wicket/callback`,
    }),
  });
  if (!tokenRes.ok) return page(400, "Kinde did not accept the", "sign-in", "Open the link you were sent and sign in again.");
  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  try {
    const session = await verifySession(id_token, keys(c.env, c.executionCtx), { domain: c.env.KINDE_DOMAIN, clientId: c.env.KINDE_CLIENT_ID, maxAgeS: num(c.env.MAX_TOKEN_AGE_S, 3600) });
    const maxAge = Math.max(60, Math.min(session.exp - Math.floor(Date.now() / 1000), num(c.env.MAX_TOKEN_AGE_S, 3600)));
    const res = c.redirect(`/s/${encodeURIComponent(saved.slug)}${safePath(saved.path)}`, 302);
    res.headers.append("set-cookie", cookie("wk_session", id_token!, maxAge));
    res.headers.append("set-cookie", cookie("wk_site", saved.slug, 60 * 60 * 8));
    res.headers.append("set-cookie", clear("wk_pkce"));
    return res;
  } catch {
    return page(400, "The sign-in could not be", "verified", "Open the link you were sent and sign in again.");
  }
});

app.get("/_wicket/logout", (c) => {
  const res = page(200, "You are signed", "out", "Close this tab, or open the link again to sign in.");
  res.headers.append("set-cookie", clear("wk_session"));
  res.headers.append("set-cookie", clear("wk_site"));
  return res;
});

app.get("/app", (c) => {
  const u = new URL(c.req.url);
  u.pathname = "/app";
  return c.env.ASSETS.fetch(new Request(u, c.req.raw));
});

app.get("/_wicket/health", (c) => c.json({ ok: true }));

/** The page that describes this gate to a person who has no link. */
app.get("/_wicket/ui/*", (c) => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace("/_wicket/ui", "").replace(/\.html$/, "") || "/";
  return c.env.ASSETS.fetch(new Request(u, c.req.raw));
});

// ---- the owner's side: sites and who may open them --------------------------------------------------------------------

app.use("/api/*", async (c, next) => {
  try {
    const claims = await verifyAccess((c.req.header("authorization") ?? "").replace(/^Bearer /i, ""), keys(c.env, c.executionCtx), { domain: c.env.KINDE_DOMAIN });
    const allowed = mayManage(claims, c.env.REQUIRED_PERMISSION ?? "");
    if (!allowed.ok) return c.json({ error: allowed.error }, allowed.status);
    c.set("org" as never, allowed.org as never);
  } catch (error) {
    return c.json({ error: error instanceof SessionError && error.reason === "keys-unavailable" ? "Sign-in checks are paused. Try again in a minute." : "Sign in again." }, error instanceof SessionError && error.reason === "keys-unavailable" ? 503 : 401);
  }
  await next();
});

const orgOf = (c: Context<{ Bindings: Env }>) => (c as unknown as { get(k: string): string }).get("org");

app.get("/api/sites", async (c) => {
  const org = orgOf(c);
  const stub = orgStub(c.env, org);
  const [sites, limit] = await Promise.all([stub.list(), stub.limit(org)]);
  const origin = new URL(c.req.url).origin;
  return c.json({ limit: limit ? limit.max : undefined, sites: sites.map((s) => ({ ...s, address: `${origin}/s/${s.slug}/` })) });
});

app.post("/api/sites", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { origin?: string; name?: string; mode?: "fast" | "strict"; open?: string[] } | null;
  const url = new URL(c.req.url);
  const result = await orgStub(c.env, orgOf(c)).create(orgOf(c), { origin: body?.origin ?? "", name: body?.name, mode: body?.mode, open: body?.open }, url.hostname);
  if (!result.ok) return c.json({ error: result.error, limit: result.limit }, result.status as 400);
  return c.json({ ...result.site, address: `${url.origin}/s/${result.site.slug}/` }, 201);
});

app.patch("/api/sites/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { mode?: "fast" | "strict"; open?: string[]; name?: string } | null;
  const site = await orgStub(c.env, orgOf(c)).update(orgOf(c), c.req.param("id"), body ?? {});
  return site ? c.json(site) : c.json({ error: "Not found." }, 404);
});

app.delete("/api/sites/:id", async (c) => ((await orgStub(c.env, orgOf(c)).remove(c.req.param("id"))) ? c.body(null, 204) : c.json({ error: "Not found." }, 404)));

async function ownedSite(c: Context<{ Bindings: Env }>) {
  const site = await orgStub(c.env, orgOf(c)).find(c.req.param("id") ?? "");
  return site ? { site, stub: c.env.SITE.get(c.env.SITE.idFromName(site.id)) } : null;
}

app.get("/api/sites/:id/clients", async (c) => {
  const owned = await ownedSite(c);
  return owned ? c.json(await owned.stub.list()) : c.json({ error: "Not found." }, 404);
});

app.post("/api/sites/:id/clients", async (c) => {
  const owned = await ownedSite(c);
  if (!owned) return c.json({ error: "Not found." }, 404);
  const body = (await c.req.json().catch(() => null)) as { email?: string; expires_in_s?: number } | null;
  const email = normalizeEmail(body?.email);
  if (!email) return c.json({ error: "Give an email address." }, 400);
  const expiresAt = typeof body?.expires_in_s === "number" && body.expires_in_s > 0 ? Date.now() + body.expires_in_s * 1000 : null;
  return c.json(await owned.stub.grant(email, expiresAt), 201);
});

app.delete("/api/sites/:id/clients/:email", async (c) => {
  const owned = await ownedSite(c);
  const email = normalizeEmail(decodeURIComponent(c.req.param("email")));
  if (!owned || !email) return c.json({ error: "Not found." }, 404);
  const started = Date.now();
  const existed = await owned.stub.revoke(email);
  return existed ? c.json({ revoked: true, ms: Date.now() - started }) : c.json({ error: "Not found." }, 404);
});

/** What the command line tool needs to start a sign-in. Neither value is secret. */
app.get("/cli/config", (c) => c.json({ domain: c.env.KINDE_DOMAIN, clientId: c.env.KINDE_CLIENT_ID }));

// ---- the gate ---------------------------------------------------------------------------------------------------------

async function serve(c: Context<{ Bindings: Env }>, slug: string, path: string, dry = false): Promise<Response> {
  const started = Date.now();
  const url = new URL(c.req.url);
  const { config, tier: configTier } = await siteConfig(c.env, slug);
  if (!config) return notFound();
  const stamp = (res: Response, extra: Record<string, string>) => {
    const out = new Response(res.body, res);
    out.headers.set("x-wicket-config", configTier);
    for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
    out.headers.set("x-wicket-ms", String(Date.now() - started));
    return out;
  };

  if (isOpenPath(config.open, path)) return stamp(await forward(c.req.raw, config, slug, path, url.search, c.env.SIGNING_SECRET, null), { "x-wicket-tier": "open" });

  const wantsPage = !dry && c.req.method === "GET" && (c.req.header("accept") ?? "").includes("text/html");
  let session;
  try {
    session = await verifySession(parseCookies(c.req.header("cookie")).wk_session, keys(c.env, c.executionCtx), {
      domain: c.env.KINDE_DOMAIN,
      clientId: c.env.KINDE_CLIENT_ID,
      maxAgeS: num(c.env.MAX_TOKEN_AGE_S, 3600),
      down: simulatedOutage(c),
      maxStaleS: simulatedOutage(c) ? Number(c.req.header("x-wicket-stale-limit")) || undefined : undefined,
    });
  } catch (error) {
    const reason = error instanceof SessionError ? error.reason : "invalid";
    if (reason === "keys-unavailable") return stamp(paused(), { "x-wicket-tier": "refused-keys" });
    if (!wantsPage) return stamp(c.json({ error: "Sign in required." }, 401), { "x-wicket-tier": `refused-${reason}` });
    return stamp(await startLogin(c, slug, path + url.search), { "x-wicket-tier": `login-${reason}` });
  }

  const { verdict, tier } = await mayOpen(c.env, c.executionCtx, config, session.email);
  if (!verdict.allowed) return stamp(wantsPage ? denied(session.email, slug) : c.json({ error: "Not shared with this email." }, 403), { "x-wicket-tier": `denied-${tier}`, "x-wicket-key": session.keySource, "x-wicket-key-age": String(Math.round(session.keyAgeMs)) });
  const info = { "x-wicket-tier": tier, "x-wicket-key": session.keySource, "x-wicket-key-age": String(Math.round(session.keyAgeMs)), "x-wicket-age": String(Date.now() - verdict.verifiedAt) };
  if (dry) return stamp(c.json({ allowed: true, tier }), info);
  const res = await forward(c.req.raw, config, slug, path, url.search, c.env.SIGNING_SECRET, session.email);
  return stamp(res, info);
}

/** The same check as the gate, answered without opening the site. The measurement scripts use it so the time of the site itself is not counted. */
app.get("/_wicket/check/:slug", (c) => serve(c, c.req.param("slug"), "/", true));

app.all("/s/:slug", (c) => c.redirect(`/s/${c.req.param("slug")}/`, 301));
app.all("/s/:slug/*", (c) => {
  const slug = c.req.param("slug");
  const prefix = `/s/${slug}`;
  return serve(c, slug, new URL(c.req.url).pathname.slice(prefix.length) || "/");
});

/** The protected site's own pages ask for absolute paths such as /assets/app.js. The cookie set at sign-in tells which site they belong to. */
app.all("*", (c) => {
  const url = new URL(c.req.url);
  const slug = parseCookies(c.req.header("cookie")).wk_site;
  if (slug) return serve(c, slug, url.pathname);
  if (url.pathname === "/" || url.pathname === "/index.html") return c.env.ASSETS.fetch(new Request(new URL("/", url), c.req.raw));
  return c.text("Not found", 404);
});

export default app;
