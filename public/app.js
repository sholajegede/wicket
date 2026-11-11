const { domain, clientId, orgs } = window.WICKET;
const redirect = `${location.origin}/app`;
const $ = (id) => document.getElementById(id);

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));

async function login(orgCode) {
  const verifier = random();
  const state = random();
  const challenge = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  sessionStorage.setItem("wk_pkce", JSON.stringify({ verifier, state }));
  const url = new URL(`${domain}/oauth2/auth`);
  url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, scope: "openid profile email", code_challenge: challenge, code_challenge_method: "S256", state, org_code: orgCode, prompt: "login" });
  location.assign(url);
}

async function finishLogin(code, state) {
  const saved = JSON.parse(sessionStorage.getItem("wk_pkce") || "null");
  sessionStorage.removeItem("wk_pkce");
  history.replaceState(null, "", "/app");
  if (!saved || saved.state !== state) throw new Error("The sign-in could not be checked. Try again.");
  const res = await fetch(`${domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: saved.verifier, redirect_uri: redirect }),
  });
  if (!res.ok) throw new Error("Kinde did not accept the sign-in.");
  sessionStorage.setItem("wk_token", (await res.json()).access_token);
}

const claims = (t) => JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${sessionStorage.getItem("wk_token")}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    sessionStorage.removeItem("wk_token");
    location.reload();
  }
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  kids.forEach((k) => n.append(k));
  return n;
};
const open = new Set();
const until = (g) => (g.expiresAt ? `until ${new Date(g.expiresAt).toLocaleString()}` : "no end");

async function clientsBlock(site) {
  const list = await api("GET", `/api/sites/${site.id}/clients`);
  const box = el("div", { className: "clients" });
  if (!list.length) box.append(el("p", { className: "none", textContent: "Nobody has access yet." }));
  for (const g of list) {
    const rm = el("button", { className: "mini danger", textContent: "Remove", onclick: async () => { await api("DELETE", `/api/sites/${site.id}/clients/${encodeURIComponent(g.email)}`); draw(); } });
    box.append(el("div", { className: "client" }, el("span", { className: "e", textContent: g.email }), el("span", { className: "until", textContent: until(g) }), rm));
  }
  const email = el("input", { type: "email", placeholder: "client@example.com", required: true });
  const span = el("select", {}, ...[["", "No end"], ["3600", "1 hour"], ["86400", "1 day"], ["604800", "7 days"]].map(([v, t]) => el("option", { value: v, textContent: t })));
  const form = el("form", { className: "invite", onsubmit: async (e) => {
    e.preventDefault();
    try { await api("POST", `/api/sites/${site.id}/clients`, { email: email.value, expires_in_s: span.value ? Number(span.value) : undefined }); } catch (err) { $("msg").textContent = err.message; }
    draw();
  } }, email, span, el("button", { className: "btn", type: "submit", textContent: "Invite" }));
  box.append(form);
  return box;
}

async function draw() {
  $("msg").textContent = "";
  const { limit, sites } = await api("GET", "/api/sites");
  $("usage").textContent = `${sites.length} of ${limit === undefined ? "?" : limit ?? "unlimited"} sites`;
  const nodes = [];
  for (const s of sites) {
    const copy = el("button", { className: "mini", textContent: "Copy", onclick: () => navigator.clipboard.writeText(s.address) });
    const toggle = el("button", { className: "mini", textContent: open.has(s.id) ? "Hide people" : "People", onclick: () => { open.has(s.id) ? open.delete(s.id) : open.add(s.id); draw(); } });
    const mode = el("button", { className: "mini", textContent: s.mode === "strict" ? "Make fast" : "Make strict", onclick: async () => { await api("PATCH", `/api/sites/${s.id}`, { mode: s.mode === "strict" ? "fast" : "strict" }); draw(); } });
    const del = el("button", { className: "mini danger", textContent: "Delete", onclick: async () => { if (confirm(`Delete ${s.name}? Everyone loses access.`)) { await api("DELETE", `/api/sites/${s.id}`); draw(); } } });
    const card = el("li", { className: "site" },
      el("div", { className: "top" }, el("span", { className: "name", textContent: s.name }), el("span", { className: `pill ${s.mode}`, textContent: s.mode }), el("span", { className: "origin", textContent: s.origin }), toggle, mode, del),
      el("div", { className: "addr" }, el("code", { textContent: s.address }), copy));
    if (open.has(s.id)) card.append(await clientsBlock(s));
    nodes.push(card);
  }
  $("sites").replaceChildren(...nodes);
}

function show(token) {
  const c = claims(token);
  $("who").textContent = orgs.find((o) => o.code === c.org_code)?.name ?? c.org_code;
  $("out").hidden = false;
  $("board").hidden = false;
  $("out").onclick = () => { sessionStorage.removeItem("wk_token"); location.assign(`${domain}/logout?redirect=${encodeURIComponent(location.origin + "/")}`); };
  $("add").onsubmit = async (e) => {
    e.preventDefault();
    try { await api("POST", "/api/sites", { origin: $("origin").value, name: $("name").value, mode: $("mode").value }); $("origin").value = $("name").value = ""; await draw(); } catch (err) { $("msg").textContent = err.message; }
  };
  draw();
}

const params = new URLSearchParams(location.search);
try {
  if (params.get("code")) await finishLogin(params.get("code"), params.get("state"));
} catch (err) {
  $("signin").hidden = false;
  $("signin").insertAdjacentText("afterbegin", err.message);
}
const token = sessionStorage.getItem("wk_token");
if (token) show(token);
else {
  $("signin").hidden = false;
  $("orgs").replaceChildren(...orgs.map((o) => el("button", { textContent: o.name, onclick: () => login(o.code) })));
}
