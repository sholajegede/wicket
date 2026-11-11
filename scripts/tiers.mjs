// How long one access check takes, by where the answer came from.
//   node scripts/tiers.mjs            about 1 minute
//   node scripts/tiers.mjs --long     adds a run that waits out every window, about 8 minutes
import { client, credentials, fmt, sandboxSites, sleep, stats } from "./lib.mjs";

const creds = await credentials();
const c = client(creds);
const { fast, strict } = await sandboxSites(c, creds.email);
for (const s of [fast, strict]) await c.api("POST", `/api/sites/${s.id}/clients`, { email: creds.email });
await sleep(2500);

const byTier = new Map();
const note = (tier, total, server) => {
  if (!byTier.has(tier)) byTier.set(tier, { total: [], server: [] });
  byTier.get(tier).total.push(total);
  byTier.get(tier).server.push(server);
};
async function one(slug) {
  const t = performance.now();
  const res = await c.check(slug);
  await res.arrayBuffer();
  const total = performance.now() - t;
  if (res.status !== 200) throw new Error(`check refused: ${res.status} ${res.headers.get("x-wicket-tier")}. Sign in again with wicket login.`);
  note(res.headers.get("x-wicket-tier"), total, Number(res.headers.get("x-wicket-ms") ?? 0));
  return res.headers.get("x-wicket-tier");
}

const base = [];
for (let i = 0; i < 40; i++) {
  const t = performance.now();
  await (await fetch(`${creds.url}/_wicket/health`)).arrayBuffer();
  base.push(performance.now() - t);
}
console.log(`round trip to the gate with no check (health page): ${fmt(stats(base))}\n`);

console.log("fast site, back to back");
for (let i = 0; i < 150; i++) await one(fast.slug);
console.log("fast site, one request every 7 seconds (inside the 30 second window, outside the 5 second one)");
for (let i = 0; i < 12; i++) {
  await one(fast.slug);
  await sleep(7000);
}
console.log("strict site, back to back");
for (let i = 0; i < 100; i++) await one(strict.slug);
if (process.argv.includes("--long")) {
  console.log("fast site, one request every 35 seconds (every answer has to come from the source)");
  for (let i = 0; i < 8; i++) {
    await one(fast.slug);
    await sleep(35_000);
  }
}

console.log("\nanswered from       round trip from this computer                                   time inside the gate");
for (const [tier, v] of [...byTier].sort()) console.log(`${tier.padEnd(18)} ${fmt(stats(v.total))}   |  median ${stats(v.server).median} ms`);
const cacheSeen = byTier.has("cache");
console.log(`\nThe data center cache ${cacheSeen ? "served answers" : "never served an answer. On this address it does not keep entries, so the 7 second run fell through to the source."}`);

for (const s of [fast, strict]) await c.api("DELETE", `/api/sites/${s.id}`);
