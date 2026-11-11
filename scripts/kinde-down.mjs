// What the gate does when it cannot reach Kinde. The request carries a header that makes the gate behave as if
// Kinde were unreachable for that request only. It cannot let anyone in; it can only make a request fail.
//   node scripts/kinde-down.mjs [limit_seconds]
import { client, credentials, sandboxSites, sleep } from "./lib.mjs";

const limitS = Number(process.argv[2] ?? 60);
const creds = await credentials();
const c = client(creds);
const { fast } = await sandboxSites(c, creds.email);
await c.api("POST", `/api/sites/${fast.id}/clients`, { email: creds.email });
await sleep(2500);

const warm = await c.check(fast.slug, { "x-wicket-simulate": "kinde-down", "x-wicket-stale-limit": "86400" });
const startAge = Number(warm.headers.get("x-wicket-key-age"));
const refreshMs = 300_000; // JWKS_REFRESH_S: a copy younger than this is used without any check
const dueIn = Math.max(0, refreshMs - startAge) / 1000;
console.log(`keys are ${(startAge / 1000).toFixed(0)} s old when Kinde goes away; they are due for a refresh in ${dueIn.toFixed(0)} s, and the gate may use the old copy for ${limitS} s after that\n`);
const stop = refreshMs + limitS * 1000;
const expectedS = dueIn + limitS;
let switched = null;
const started = performance.now();
while (performance.now() - started < (expectedS + 40) * 1000) {
  const r = await c.check(fast.slug, { "x-wicket-simulate": "kinde-down", "x-wicket-stale-limit": String(Math.ceil(stop / 1000)) });
  await r.arrayBuffer();
  const at = ((performance.now() - started) / 1000).toFixed(0).padStart(3);
  console.log(`${at} s  ${r.status}  keys from ${r.headers.get("x-wicket-key") ?? r.headers.get("x-wicket-tier")}`);
  if (r.status !== 200 && switched === null) switched = (performance.now() - started) / 1000;
  if (switched !== null && performance.now() / 1000 - started / 1000 > switched + 10) break;
  await sleep(5000);
}
console.log(switched === null ? "\nThe gate kept letting people in past the limit." : `\nThe gate stopped letting people in after ${switched.toFixed(0)} s; expected about ${expectedS.toFixed(0)} s (refresh due at ${dueIn.toFixed(0)} s + ${limitS} s stale limit).`);
await c.api("DELETE", `/api/sites/${fast.id}`);
