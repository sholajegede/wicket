const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const CSS = `
@font-face{font-family:"Instrument Serif";font-style:italic;src:url(/_wicket/ui/fonts/instrument-serif-italic.woff2) format("woff2");font-display:swap}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fafafa;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;padding:24px}
main{max-width:440px;width:100%}h1{font-size:30px;line-height:1.15;font-weight:500;letter-spacing:-.02em;margin:0 0 14px}h1 em{font-family:"Instrument Serif",Georgia,serif;font-weight:400}
p{color:#a1a1aa;margin:0 0 22px}a.btn{display:inline-block;background:#fafafa;color:#000;text-decoration:none;font-weight:500;border-radius:8px;padding:10px 16px}a.sub{color:#a1a1aa;margin-left:14px;font-size:14px}
code{color:#fafafa;background:#18181b;border-radius:5px;padding:1px 6px}`;

export function page(status: number, title: string, accent: string, body: string, links = "", headers: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main><h1>${esc(title)} <em>${esc(accent)}</em></h1><p>${body}</p>${links}</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
}

export const notFound = () => page(404, "No site is shared", "here", "This address does not match a protected site. Check the link you were sent.");

export const denied = (email: string, slug: string) =>
  page(
    403,
    "This site is not shared with",
    "you",
    `You are signed in as <code>${esc(email)}</code>, and that address does not have access. Ask the person who sent you the link to add it, or sign in with another email.`,
    `<a class="btn" href="/_wicket/login?site=${encodeURIComponent(slug)}&amp;switch=1">Use another email</a>`,
  );

export const paused = () =>
  page(503, "Sign-in checks are", "paused", "The gate cannot confirm who you are right now, so it is not letting anyone in. Try again in a minute.", "", { "retry-after": "30" });
