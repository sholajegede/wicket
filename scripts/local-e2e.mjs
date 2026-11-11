// Runs the gate end to end on this computer against a fake Kinde and a fake site.
//   terminal 1: node scripts/fake-kinde.mjs
//   terminal 2: npx wrangler dev --port 8787 --var KINDE_DOMAIN:http://localhost:9999 --var KINDE_CLIENT_ID:test-client --var ALLOW_LOCAL_ORIGINS:1 --var MEMORY_WINDOW_MS:1500 --var CACHE_WINDOW_MS:3000 --var DENY_WINDOW_MS:300
//   terminal 3: node scripts/local-e2e.mjs
import { createServer } from "node:http";

const GATE = process.env.GATE ?? "http://localhost:8787";
const KINDE = "http://localhost:9999";
const seen = [];
createServer((req, res) => {
  seen.push(req.headers);
  res.writeHead(200, { "content-type": "text/html" }).end(`<h1>staging</h1><p>${req.url}</p>`);
}).listen(9998);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const token = async (q) => (await (await fetch(`${KINDE}/__issue?${q}`)).json()).token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const owner = { authorization: `Bearer ${await token("kind=access&org=org_11028f68ef58")}`, "content-type": "application/json" };
const api = (method, path, body) => fetch(`${GATE}${path}`, { method, headers: owner, body: body ? JSON.stringify(body) : undefined });
const open = async (slug, email, extra = {}) => fetch(`${GATE}/s/${slug}/hello`, { headers: { cookie: `wk_session=${await token(`email=${email}`)}`, accept: "text/html", ...extra } });

for (const s of await (await api("GET", "/api/sites")).json().then((b) => b.sites)) await api("DELETE", `/api/sites/${s.id}`);
await fetch(`${KINDE}/__limit?n=2`);

const a = await (await api("POST", "/api/sites", { origin: "http://localhost:9998", name: "fast one" })).json();
const b = await (await api("POST", "/api/sites", { origin: "http://localhost:9998", name: "strict one", mode: "strict" })).json();
check("two sites fit the plan", !!a.slug && !!b.slug, JSON.stringify(a).slice(0, 80));
const third = await api("POST", "/api/sites", { origin: "http://localhost:9998" });
check("a third site is refused with 402", third.status === 402);
const parallel = await Promise.all(Array.from({ length: 5 }, () => api("POST", "/api/sites", { origin: "http://localhost:9998" })));
check("five creates at the limit all refuse", parallel.every((r) => r.status === 402));

const none = await fetch(`${GATE}/s/${a.slug}/`, { headers: { accept: "text/html" }, redirect: "manual" });
check("no sign-in redirects to Kinde", none.status === 302 && none.headers.get("location")?.startsWith(`${KINDE}/oauth2/auth`));
const noneApi = await fetch(`${GATE}/s/${a.slug}/data`, { headers: { accept: "application/json" } });
check("a script without a session gets 401, not a redirect", noneApi.status === 401);

let r = await open(a.slug, "ada@acme.dev");
check("a person who is not invited gets 403", r.status === 403);
await api("POST", `/api/sites/${a.id}/clients`, { email: "ada@acme.dev" });
await sleep(400);
r = await open(a.slug, "ada@acme.dev");
check("an invited person gets in", r.status === 200 && (await r.text()).includes("staging"), r.headers.get("x-wicket-tier"));
const headers = seen.at(-1);
check("the site receives signed identity headers", headers["x-wicket-email"] === "ada@acme.dev" && !!headers["x-wicket-signature"] && !headers.cookie);
r = await open(a.slug, "ada@acme.dev");
check("the next request is answered from memory", r.headers.get("x-wicket-tier") === "memory", r.headers.get("x-wicket-tier"));

await api("DELETE", `/api/sites/${a.id}/clients/ada%40acme.dev`);
r = await open(a.slug, "ada@acme.dev");
check("fast site: right after a revoke the old answer may still be served", r.status === 200, `status ${r.status}, tier ${r.headers.get("x-wicket-tier")}`);
await sleep(3300);
r = await open(a.slug, "ada@acme.dev");
check("fast site: refused once the windows pass", r.status === 403);

await api("POST", `/api/sites/${b.id}/clients`, { email: "bo@acme.dev" });
r = await open(b.slug, "bo@acme.dev");
check("strict site: invited person gets in from the source", r.status === 200 && r.headers.get("x-wicket-tier") === "source");
await api("DELETE", `/api/sites/${b.id}/clients/bo%40acme.dev`);
r = await open(b.slug, "bo@acme.dev");
check("strict site: refused at once after a revoke", r.status === 403);

await api("POST", `/api/sites/${b.id}/clients`, { email: "cy@acme.dev", expires_in_s: 2 });
check("a grant with an end works before it", (await open(b.slug, "cy@acme.dev")).status === 200);
await sleep(2300);
check("a grant with an end stops at the end", (await open(b.slug, "cy@acme.dev")).status === 403);

await api("POST", `/api/sites/${b.id}/clients`, { email: "di@acme.dev" });
const bad = await fetch(`${GATE}/s/${b.slug}/`, { headers: { cookie: `wk_session=${await token("email=di@acme.dev&kid=zzz")}`, accept: "text/html" }, redirect: "manual" });
check("a token signed with an unknown key is not accepted", bad.status === 302);
const forged = await fetch(`${GATE}/s/${b.slug}/`, { headers: { cookie: `wk_session=${(await token("email=di@acme.dev")).slice(0, -6)}AAAAAA`, accept: "text/html" }, redirect: "manual" });
check("a token with a changed signature is not accepted", forged.status === 302);

r = await open(b.slug, "di@acme.dev", { "x-wicket-simulate": "kinde-down" });
check("with Kinde down and keys cached, the gate keeps working", r.status === 200, r.headers.get("x-wicket-key"));

const outsider = await fetch(`${GATE}/api/sites`, { headers: { authorization: `Bearer ${await token("email=x@y.co")}` } });
check("an ID token is not accepted as an owner token", outsider.status === 403 || outsider.status === 401, String(outsider.status));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
