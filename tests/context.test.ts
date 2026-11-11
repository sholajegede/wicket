import { describe, expect, it } from "vitest";
import { sign, verifyHeaders } from "../src/context";
import { isOpenPath } from "../src/proxy";

describe("signed headers", () => {
  it("a site that shares the secret can verify them", async () => {
    const h = await sign("s3cret", { site: "s1", email: "a@b.co", ts: 1000 });
    expect(await verifyHeaders("s3cret", (n) => h[n] ?? null, 1500)).toEqual({ site: "s1", email: "a@b.co", ts: 1000 });
  });
  it("refuses another secret, a changed email, and an old request", async () => {
    const h = await sign("s3cret", { site: "s1", email: "a@b.co", ts: 1000 });
    expect(await verifyHeaders("other", (n) => h[n] ?? null, 1500)).toBeNull();
    expect(await verifyHeaders("s3cret", (n) => (n === "x-wicket-email" ? "z@b.co" : h[n] ?? null), 1500)).toBeNull();
    expect(await verifyHeaders("s3cret", (n) => h[n] ?? null, 90_000)).toBeNull();
  });
});

describe("open paths", () => {
  it("matches a path and what is under it, and nothing that only starts with the same letters", () => {
    expect(isOpenPath(["/health", "/public/"], "/health")).toBe(true);
    expect(isOpenPath(["/health", "/public/"], "/public/logo.png")).toBe(true);
    expect(isOpenPath(["/health"], "/healthy")).toBe(false);
    expect(isOpenPath([], "/")).toBe(false);
  });
});
