/** The headers the gate adds to every request it sends to the protected site, signed so the site can trust them. */

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

export interface Context {
  site: string;
  email: string;
  ts: number;
}

export async function sign(secret: string, ctx: Context): Promise<Record<string, string>> {
  return {
    "x-wicket-site": ctx.site,
    "x-wicket-email": ctx.email,
    "x-wicket-ts": String(ctx.ts),
    "x-wicket-signature": await hmac(secret, `${ctx.site}.${ctx.email}.${ctx.ts}`),
  };
}

/** What the protected site runs on each request. Refuse a request older than a minute. */
export async function verifyHeaders(secret: string, get: (name: string) => string | null, now = Date.now()): Promise<Context | null> {
  const site = get("x-wicket-site");
  const email = get("x-wicket-email");
  const ts = Number(get("x-wicket-ts"));
  const sig = get("x-wicket-signature");
  if (!site || !email || !sig || !Number.isFinite(ts) || Math.abs(now - ts) > 60_000) return null;
  const expected = await hmac(secret, `${site}.${email}.${ts}`);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { site, email, ts } : null;
}
