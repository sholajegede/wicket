import type { OrgDO } from "./org-do";
import type { SiteDO } from "./site-do";

export interface Env {
  ORG: DurableObjectNamespace<OrgDO>;
  SITE: DurableObjectNamespace<SiteDO>;
  SITES: KVNamespace;
  ASSETS: Fetcher;
  KINDE_DOMAIN: string;
  KINDE_CLIENT_ID: string;
  KINDE_M2M_CLIENT_ID: string;
  KINDE_M2M_CLIENT_SECRET: string;
  /** organization code to Kinde billing customer ID, as JSON */
  CUSTOMERS_JSON: string;
  /** signs the headers the gate sends to the protected site */
  SIGNING_SECRET: string;
  FEATURE_CODE?: string;
  REQUIRED_PERMISSION?: string;
  MEMORY_WINDOW_MS?: string;
  CACHE_WINDOW_MS?: string;
  DENY_WINDOW_MS?: string;
  JWKS_REFRESH_S?: string;
  JWKS_MAX_STALE_S?: string;
  MAX_TOKEN_AGE_S?: string;
  /** "1" lets a request ask the gate to behave as if Kinde were unreachable. It can only make that request fail. */
  ALLOW_SIMULATION?: string;
  /** "1" lets a site be http or on localhost. Only for the local test. */
  ALLOW_LOCAL_ORIGINS?: string;
  AUDIENCE?: string;
}

export const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback;
};
