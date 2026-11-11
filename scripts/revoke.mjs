// How long a person keeps access after you remove them, per mode.
//   node scripts/revoke.mjs [rounds]
import { client, credentials, sandboxSites, sleep, stats } from "./lib.mjs";

const rounds = Number(process.argv[2] ?? 8);
const creds = await credentials();
const c = client(creds);
const { fast, strict } = await sandboxSites(c, creds.email);

async function round(site) {
  await c.api("POST", `/api/sites/${site.id}/clients`, { email: creds.email });
  await sleep(2500);
  for (let i = 0; i < 4; i++) {
    const r = await c.check(site.slug);
    await r.arrayBuffer();
    if (r.status !== 200) throw new Error(`the person could not open the site before the revoke (${r.status})`);
  }
  const del = await c.api("DELETE", `/api/sites/${site.id}/clients/${encodeURIComponent(creds.email)}`);
  const t0 = performance.now();
  await del.arrayBuffer();
  let lastTier = "";
  for (;;) {
    const r = await c.check(site.slug);
    await r.arrayBuffer();
    if (r.status !== 200) return { ms: performance.now() - t0, lastTier };
    lastTier = r.headers.get("x-wicket-tier");
    if (performance.now() - t0 > 90_000) return { ms: Infinity, lastTier };
    await sleep(100);
  }
}

for (const [label, site] of [["strict", strict], ["fast", fast]]) {
  const times = [];
  const tiers = [];
  for (let i = 0; i < rounds; i++) {
    const r = await round(site);
    times.push(r.ms);
    tiers.push(r.lastTier);
    console.log(`${label} round ${i + 1}: refused after ${r.ms === Infinity ? "more than 90 s" : `${(r.ms / 1000).toFixed(2)} s`} (last allowed answer came from ${r.lastTier || "nowhere, refused at once"})`);
  }
  const s = stats(times);
  console.log(`${label}: median ${(s.median / 1000).toFixed(2)} s, p95 ${(s.p95 / 1000).toFixed(2)} s, longest ${(s.max / 1000).toFixed(2)} s\n`);
}
for (const s of [fast, strict]) await c.api("DELETE", `/api/sites/${s.id}`);
