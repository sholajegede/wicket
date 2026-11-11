import { describe, expect, it } from "vitest";
import { mayManage, maxSitesFromKinde, normalizeEmail, parseOrigin, slugFor } from "../src/limits";

const ent = (...items: Array<[string, number]>) => ({ entitlements: items.map(([feature_code, entitlement_limit_max]) => ({ feature_code, entitlement_limit_max })) });

describe("plan limits", () => {
  it("reads the site maximum", () => expect(maxSitesFromKinde(ent(["protected_sites", 10]), "protected_sites")).toBe(10));
  it("reads an unmetered feature as no maximum", () => expect(maxSitesFromKinde(ent(["protected_sites", 2147483647]), "protected_sites")).toBeNull());
  it("a plan without the feature allows none", () => expect(maxSitesFromKinde(ent(["other", 5]), "protected_sites")).toBe(0));
  it("takes the highest of two plans", () => expect(maxSitesFromKinde(ent(["protected_sites", 1], ["protected_sites", 10]), "protected_sites")).toBe(10));
  it("an unreadable body allows none", () => expect(maxSitesFromKinde(null, "protected_sites")).toBe(0));
});

describe("permission context", () => {
  it("needs an organization", () => expect(mayManage({}, "")).toMatchObject({ ok: false }));
  it("any member may manage when no permission is required", () => expect(mayManage({ org_code: "org_1" }, "")).toEqual({ ok: true, org: "org_1" }));
  it("refuses a member without the required permission", () => expect(mayManage({ org_code: "org_1", permissions: ["view:sites"] }, "manage:clients")).toMatchObject({ ok: false, status: 403 }));
  it("allows a member with it", () => expect(mayManage({ org_code: "org_1", permissions: ["manage:clients"] }, "manage:clients")).toMatchObject({ ok: true }));
});

describe("input", () => {
  it("normalizes an email", () => expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com"));
  it("refuses a bad email", () => expect(normalizeEmail("ada")).toBeNull());
  it("accepts a public https site", () => expect(parseOrigin("https://staging.acme.dev/app/", "wicket.x.workers.dev")).toEqual({ ok: true, origin: "https://staging.acme.dev/app" }));
  it("refuses http, itself and private hosts", () => {
    expect(parseOrigin("http://a.dev", "g.dev").ok).toBe(false);
    expect(parseOrigin("https://g.dev", "g.dev").ok).toBe(false);
    expect(parseOrigin("https://localhost", "g.dev").ok).toBe(false);
    expect(parseOrigin("https://10.0.0.1", "g.dev").ok).toBe(false);
  });
  it("makes a readable slug", () => expect(slugFor("https://staging.acme.dev", "a1b2c3")).toBe("staging-a1b2c3"));
});
