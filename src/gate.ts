/** Small helpers for the sign-in of the people a site is shared with. */

export function safePath(value: string | null | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));

export async function challengeFor(verifier: string): Promise<string> {
  return b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}
