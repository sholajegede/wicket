import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { KeyStore } from "../src/keys";
import { SessionError, verifyAccess, verifySession } from "../src/session";

const DOMAIN = "https://example.kinde.com";
const CLIENT = "client123";

async function setup() {
  const a = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(a.publicKey)), kid: "a", alg: "RS256", use: "sig" };
  const store = new KeyStore({ refreshS: 300, maxStaleS: 3600, minRefetchS: 10 }, { now: () => Date.now(), fetchKeys: async () => [jwk as never], readShared: async () => null, writeShared: async () => undefined });
  const sign = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string; exp?: string; iat?: number; kid?: string } = {}) => {
    let t = new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "a" }).setIssuer(opts.iss ?? DOMAIN).setAudience(opts.aud ?? CLIENT).setExpirationTime(opts.exp ?? "1h");
    t = t.setIssuedAt(opts.iat);
    return t.sign(a.privateKey);
  };
  return { store, sign };
}
const o = { domain: DOMAIN, clientId: CLIENT, maxAgeS: 3600 };

describe("session", () => {
  it("accepts a good ID token and reads the email in lower case", async () => {
    const { store, sign } = await setup();
    const s = await verifySession(await sign({ sub: "kp_1", email: "Ada@Example.com" }), store, o);
    expect(s.email).toBe("ada@example.com");
  });

  it.each([
    ["wrong audience", { aud: "other" }, "invalid"],
    ["wrong issuer", { iss: "https://evil.example.com" }, "invalid"],
    ["unknown key", { kid: "nope" }, "invalid"],
    ["expired", { exp: "-1m" }, "expired"],
  ])("refuses a token with %s", async (_n, opts, reason) => {
    const { store, sign } = await setup();
    await expect(verifySession(await sign({ email: "a@b.co" }, opts as never), store, o)).rejects.toMatchObject({ reason });
  });

  it("refuses a token older than the age limit even though it has not expired", async () => {
    const { store, sign } = await setup();
    const old = Math.floor(Date.now() / 1000) - 7200;
    await expect(verifySession(await sign({ email: "a@b.co" }, { iat: old, exp: "2h" }), store, o)).rejects.toMatchObject({ reason: "too-old" });
  });

  it("refuses a token without an email", async () => {
    const { store, sign } = await setup();
    await expect(verifySession(await sign({ sub: "x" }), store, o)).rejects.toMatchObject({ reason: "no-email" });
  });

  it("refuses an unsigned or garbage token", async () => {
    const { store } = await setup();
    await expect(verifySession("not.a.jwt", store, o)).rejects.toBeInstanceOf(SessionError);
    await expect(verifySession(undefined, store, o)).rejects.toMatchObject({ reason: "no-token" });
  });

  it("fails closed when the keys cannot be had", async () => {
    const { sign } = await setup();
    const empty = new KeyStore({ refreshS: 300, maxStaleS: 3600, minRefetchS: 10 }, { now: () => Date.now(), fetchKeys: async () => { throw new Error("down"); }, readShared: async () => null, writeShared: async () => undefined });
    await expect(verifySession(await sign({ email: "a@b.co" }), empty, o)).rejects.toMatchObject({ reason: "keys-unavailable" });
  });

  it("reads the organization and permissions of an access token", async () => {
    const { store, sign } = await setup();
    const claims = await verifyAccess(await sign({ org_code: "org_1", permissions: ["manage:clients"] }), store, { domain: DOMAIN });
    expect(claims.org_code).toBe("org_1");
  });
});
