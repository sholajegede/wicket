// A stand-in for Kinde on this computer, so the gate can be run end to end without a network.
// It publishes one signing key, issues tokens for the emails you ask for, and answers the plan lookup.
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const PORT = Number(process.env.FAKE_KINDE_PORT ?? 9999);
const DOMAIN = `http://localhost:${PORT}`;
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
let sitesLimit = 2;
const hits = { jwks: 0 };

const issue = (claims, opts = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" }).setIssuer(DOMAIN).setAudience(opts.aud ?? "test-client").setIssuedAt().setExpirationTime(opts.exp ?? "30m").sign(privateKey);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, DOMAIN);
  const json = (body, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (url.pathname === "/.well-known/jwks") {
    hits.jwks++;
    return json({ keys: [jwk] });
  }
  if (url.pathname === "/oauth2/token") return json({ access_token: await issue({ aud: `${DOMAIN}/api` }), expires_in: 3600 });
  if (url.pathname === "/api/v1/billing/entitlements") return json({ entitlements: [{ feature_code: "protected_sites", entitlement_limit_max: sitesLimit }] });
  if (url.pathname === "/__issue") {
    const kind = url.searchParams.get("kind");
    const token = kind === "access"
      ? await issue({ org_code: url.searchParams.get("org") ?? "org_test", permissions: ["manage:clients"] }, { aud: "ignored" })
      : await issue({ sub: "kp_test", email: url.searchParams.get("email") }, { kid: url.searchParams.get("kid") ?? "k1" });
    return json({ token });
  }
  if (url.pathname === "/__limit") return json({ limit: (sitesLimit = Number(url.searchParams.get("n"))) });
  if (url.pathname === "/__hits") return json(hits);
  json({ error: "not found" }, 404);
});
server.listen(PORT, () => console.log(`fake kinde on ${DOMAIN}`));
