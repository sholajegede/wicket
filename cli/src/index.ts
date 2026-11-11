#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const PORT = 8976;
const REDIRECT = `http://localhost:${PORT}/callback`;
const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "wicket");
const file = join(dir, "credentials.json");

interface Saved {
  url: string;
  token: string;
  id_token?: string;
  expires_at: number;
}

interface Site {
  id: string;
  slug: string;
  name: string;
  origin: string;
  mode: "fast" | "strict";
  address: string;
}

const b64 = (buf: Buffer) => buf.toString("base64url");
const claims = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { org_code?: string; email?: string; exp?: number };

async function load(): Promise<Saved | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Saved;
  } catch {
    return null;
  }
}

function openBrowser(url: string) {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? 'start ""' : "xdg-open";
  exec(`${cmd} "${url}"`, () => undefined);
}

/** Signs in through the browser with the same Kinde flow as the dashboard. The tool never sees a password. */
async function login(args: string[]) {
  const flag = args.indexOf("--url");
  const url = (flag >= 0 ? args[flag + 1] : process.env.WICKET_URL ?? (await load())?.url ?? "").replace(/\/$/, "");
  if (!url) throw new Error("Pass the address of your Wicket: wicket login --url https://your-wicket.example");
  const org = args.find((a, i) => a.startsWith("org_") && args[i - 1] !== "--url");

  const cfgRes = await fetch(`${url}/cli/config`);
  if (!cfgRes.ok) throw new Error(`Could not read the sign-in settings from ${url} (${cfgRes.status}).`);
  const { domain, clientId } = (await cfgRes.json()) as { domain: string; clientId: string };

  const verifier = b64(randomBytes(32));
  const state = b64(randomBytes(16));
  const challenge = b64(createHash("sha256").update(verifier).digest());
  const auth = new URL(`${domain}/oauth2/auth`);
  auth.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "openid profile email",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    prompt: "login",
    ...(org ? { org_code: org } : {}),
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", REDIRECT);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
      res.writeHead(ok ? 200 : 400, { "content-type": "text/plain" }).end(ok ? "Signed in. You can close this tab." : "Sign-in failed. Run wicket login again.");
      server.close();
      ok ? resolve(u.searchParams.get("code") as string) : reject(new Error(u.searchParams.get("error_description") ?? "The sign-in could not be checked."));
    });
    server.on("error", (e) => reject(new Error(`Could not listen on port ${PORT}: ${(e as Error).message}`)));
    server.listen(PORT, "127.0.0.1", () => {
      console.log("Opening your browser to sign in. If it does not open, go to:\n" + auth.toString());
      openBrowser(auth.toString());
    });
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 5 minutes."));
    }, 300_000).unref();
  });

  const tokenRes = await fetch(`${domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT }),
  });
  if (!tokenRes.ok) throw new Error("Kinde did not accept the sign-in.");
  const body = (await tokenRes.json()) as { access_token: string; id_token?: string };
  const exp = claims(body.access_token).exp ?? 0;
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ url, token: body.access_token, id_token: body.id_token, expires_at: exp * 1000 } satisfies Saved), { mode: 0o600 });
  console.log(`Signed in to ${claims(body.access_token).org_code ?? "your organization"}.`);
}

async function session(): Promise<{ url: string; token: string }> {
  const saved = await load();
  const url = (process.env.WICKET_URL ?? saved?.url ?? "").replace(/\/$/, "");
  const token = process.env.WICKET_TOKEN ?? saved?.token ?? "";
  if (!url || !token) throw new Error("You are not signed in. Run: wicket login --url https://your-wicket.example");
  if (!process.env.WICKET_TOKEN && saved && saved.expires_at < Date.now()) throw new Error("Your sign-in has expired. Run: wicket login");
  return { url, token };
}

async function call(method: string, path: string, body?: unknown) {
  const { url, token } = await session();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) throw new Error("Your sign-in is not valid any more. Run: wicket login");
  if (!res.ok) throw new Error(data?.error ?? `request failed: ${res.status}`);
  return data;
}

/** A site is named by its slug, its id, or the start of its name. */
async function find(ref: string): Promise<Site> {
  const { sites } = (await call("GET", "/api/sites")) as { sites: Site[] };
  const hit = sites.find((s) => s.slug === ref || s.id === ref) ?? sites.filter((s) => s.name.toLowerCase().startsWith(ref.toLowerCase()))[0];
  if (!hit) throw new Error(`No site matches "${ref}". Run: wicket list`);
  return hit;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}


const [command, ...args] = process.argv.slice(2);

try {
  if (command === "login") {
    await login(args);
  } else if (command === "logout") {
    await rm(file, { force: true });
    console.log("Signed out.");
  } else if (command === "whoami") {
    const { token, url } = await session();
    const c = claims(token);
    console.log(`${c.org_code ?? "no organization"} at ${url}, signed in until ${new Date((c.exp ?? 0) * 1000).toISOString()}`);
  } else if (command === "protect" && args[0]) {
    const open = args.flatMap((a, i) => (args[i - 1] === "--open" ? [a] : []));
    const site = (await call("POST", "/api/sites", { origin: args[0], name: option(args, "--name"), mode: args.includes("--strict") ? "strict" : "fast", open })) as Site;
    console.log(`${site.name} is protected (${site.mode}).\nShare this address: ${site.address}\nInvite someone: wicket invite ${site.slug} client@example.com`);
  } else if (command === "list") {
    const { limit, sites } = (await call("GET", "/api/sites")) as { limit?: number | null; sites: Site[] };
    console.log(`${sites.length} of ${limit === undefined ? "an unknown number of" : limit ?? "unlimited"} sites`);
    for (const s of sites) console.log(`${s.mode.padEnd(7)} ${s.name.padEnd(24)} ${s.address}`);
  } else if (command === "people" && args[0]) {
    const site = await find(args[0]);
    const grants = (await call("GET", `/api/sites/${site.id}/clients`)) as Array<{ email: string; expiresAt: number | null }>;
    console.log(`${grants.length} ${grants.length === 1 ? "person" : "people"} can open ${site.name}`);
    for (const g of grants) console.log(`${g.email.padEnd(32)} ${g.expiresAt ? `until ${new Date(g.expiresAt).toISOString()}` : "no end"}`);
  } else if (command === "invite" && args[0] && args[1]) {
    const site = await find(args[0]);
    const hours = Number(option(args, "--hours"));
    await call("POST", `/api/sites/${site.id}/clients`, { email: args[1], expires_in_s: hours > 0 ? hours * 3600 : undefined });
    console.log(`${args[1]} can open ${site.address}${hours > 0 ? ` for ${hours} ${hours === 1 ? "hour" : "hours"}` : ""}`);
  } else if (command === "revoke" && args[0] && args[1]) {
    const site = await find(args[0]);
    const r = (await call("DELETE", `/api/sites/${site.id}/clients/${encodeURIComponent(args[1])}`)) as { ms: number };
    console.log(`${args[1]} removed from ${site.name}${site.mode === "strict" ? ". The site is closed to them now." : ". Copies of the old answer last up to 30 seconds."}`);
  } else if (command === "remove" && args[0]) {
    const site = await find(args[0]);
    await call("DELETE", `/api/sites/${site.id}`);
    console.log(`${site.name} is no longer protected by this gate.`);
  } else {
    console.log("Usage: wicket login [org_code] --url <address> | logout | whoami\n       wicket protect <url> [--name <name>] [--strict] [--open <path>]\n       wicket list | people <site> | invite <site> <email> [--hours <n>] | revoke <site> <email> | remove <site>");
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
