import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import { KeyStore, KeyUnavailable, type KeySource } from "./keys";

export interface Session {
  email: string;
  sub: string;
  exp: number;
  keySource: KeySource;
  /** how old the copy of the signing keys was when this token was checked */
  keyAgeMs: number;
}

export type SessionFailure = "no-token" | "invalid" | "expired" | "too-old" | "no-email" | "keys-unavailable";

export class SessionError extends Error {
  constructor(readonly reason: SessionFailure) {
    super(reason);
  }
}

/**
 * Checks a Kinde ID token on this server: signature against the cached keys, issuer, audience, expiry, and an age limit
 * of our own. The email claim is the identity the grants are matched against.
 */
export async function verifySession(
  token: string | undefined,
  keys: KeyStore,
  opts: { domain: string; clientId: string; maxAgeS: number; down?: boolean; maxStaleS?: number; now?: () => number },
): Promise<Session> {
  if (!token) throw new SessionError("no-token");
  const now = opts.now ?? Date.now;
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new SessionError("invalid");
  }
  let found;
  try {
    found = await keys.key(kid, { down: opts.down, maxStaleS: opts.maxStaleS });
  } catch (error) {
    throw new SessionError(error instanceof KeyUnavailable && error.reason === "unknown-key" ? "invalid" : "keys-unavailable");
  }
  try {
    const key = await importJWK(found.jwk as JWK, "RS256");
    const { payload } = await jwtVerify(token, key, { issuer: opts.domain, audience: opts.clientId, algorithms: ["RS256"], currentDate: new Date(now()) });
    if (typeof payload.iat === "number" && now() / 1000 - payload.iat > opts.maxAgeS) throw new SessionError("too-old");
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email) throw new SessionError("no-email");
    return { email, sub: String(payload.sub ?? ""), exp: payload.exp ?? 0, keySource: found.source, keyAgeMs: found.ageMs };
  } catch (error) {
    if (error instanceof SessionError) throw error;
    const code = (error as { code?: string }).code;
    throw new SessionError(code === "ERR_JWT_EXPIRED" ? "expired" : "invalid");
  }
}

/** Checks a Kinde access token of a person managing sites. The organization and permission claims come from it. */
export async function verifyAccess(token: string | undefined, keys: KeyStore, opts: { domain: string; now?: () => number }): Promise<Record<string, unknown>> {
  if (!token) throw new SessionError("no-token");
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new SessionError("invalid");
  }
  let found;
  try {
    found = await keys.key(kid);
  } catch (error) {
    throw new SessionError(error instanceof KeyUnavailable && error.reason === "unknown-key" ? "invalid" : "keys-unavailable");
  }
  try {
    const key = await importJWK(found.jwk as JWK, "RS256");
    const { payload } = await jwtVerify(token, key, { issuer: opts.domain, algorithms: ["RS256"], currentDate: new Date((opts.now ?? Date.now)()) });
    return payload as Record<string, unknown>;
  } catch (error) {
    throw new SessionError((error as { code?: string }).code === "ERR_JWT_EXPIRED" ? "expired" : "invalid");
  }
}
