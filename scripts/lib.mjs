import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function credentials() {
  const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "wicket", "credentials.json");
  let saved;
  try {
    saved = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error("Run `wicket login --url <your gate>` first. The scripts use that sign-in.");
  }
  if (!saved.id_token) throw new Error("The saved sign-in has no ID token. Run `wicket login` again.");
  const email = JSON.parse(Buffer.from(saved.id_token.split(".")[1], "base64url").toString()).email;
  return { url: process.env.GATE ?? saved.url, access: saved.token, id: saved.id_token, email };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  const at = (p) => v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
  return { n: v.length, median: at(50), p95: at(95), p99: at(99), max: v[v.length - 1] };
}

export const fmt = (s) => `n=${s.n}  median ${s.median.toFixed(0)} ms  p95 ${s.p95.toFixed(0)} ms  p99 ${s.p99.toFixed(0)} ms  max ${s.max.toFixed(0)} ms`;

export function client({ url, access, id }) {
  const owner = { authorization: `Bearer ${access}`, "content-type": "application/json" };
  const api = (method, path, body) => fetch(`${url}${path}`, { method, headers: owner, body: body ? JSON.stringify(body) : undefined });
  const check = (slug, headers = {}) => fetch(`${url}/_wicket/check/${slug}`, { headers: { cookie: `wk_session=${id}`, ...headers } });
  return { api, check, url };
}

/** Makes one fast and one strict site pointing at the gate's own health page, and removes any older ones this script made. */
export async function sandboxSites(c, email) {
  const list = await (await c.api("GET", "/api/sites")).json();
  for (const s of list.sites ?? []) if (s.name.startsWith("measure-")) await c.api("DELETE", `/api/sites/${s.id}`);
  const make = async (name, mode) => {
    const res = await c.api("POST", "/api/sites", { origin: "https://example.com", name: `measure-${name}`, mode });
    const body = await res.json();
    if (!res.ok) throw new Error(`${name}: ${body.error}. Delete a site in the dashboard or use a plan with room for two more.`);
    return body;
  };
  return { fast: await make("fast", "fast"), strict: await make("strict", "strict") };
}
