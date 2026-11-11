import type { Env } from "./env";
import { maxSitesFromKinde } from "./limits";

let token: { value: string; expiresAt: number } | null = null;

async function accessToken(env: Env): Promise<string> {
  if (token && Date.now() < token.expiresAt - 30_000) return token.value;
  const res = await fetch(`${env.KINDE_DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.KINDE_M2M_CLIENT_ID,
      client_secret: env.KINDE_M2M_CLIENT_SECRET,
      audience: `${env.KINDE_DOMAIN}/api`,
    }),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return token.value;
}

export function customerFor(env: Env, org: string): string | null {
  try {
    return (JSON.parse(env.CUSTOMERS_JSON || "{}") as Record<string, string>)[org] ?? null;
  } catch {
    return null;
  }
}

/** The most sites the plan of this organization allows. null means no maximum. */
export async function fetchSiteLimit(env: Env, org: string): Promise<number | null> {
  const customer = customerFor(env, org);
  if (!customer) throw new Error(`no billing customer is mapped for ${org}`);
  const url = new URL(`${env.KINDE_DOMAIN}/api/v1/billing/entitlements`);
  url.searchParams.set("customer_id", customer);
  url.searchParams.set("page_size", "100");
  const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken(env)}` } });
  if (!res.ok) throw new Error(`entitlements request failed: ${res.status}`);
  return maxSitesFromKinde(await res.json(), env.FEATURE_CODE ?? "protected_sites");
}
