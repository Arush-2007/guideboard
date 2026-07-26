import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTrustedOrigin, trustedOrigins } from "./trusted-origins";

const withHeaders = (headers: Record<string, string>) =>
  new Request("https://app.guideboard.test/api/profile/avatar", {
    method: "POST",
    headers,
  });

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.guideboard.test";
  delete process.env.NGROK_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("trustedOrigins", () => {
  it("includes the app URL and drops unset entries", () => {
    expect(trustedOrigins()).toEqual(["https://app.guideboard.test"]);
  });

  it("includes the ngrok tunnel when set", () => {
    process.env.NGROK_URL = "https://abc.ngrok.app";
    expect(trustedOrigins()).toContain("https://abc.ngrok.app");
  });
});

describe("isTrustedOrigin", () => {
  it("allows a same-origin browser request", () => {
    expect(
      isTrustedOrigin(withHeaders({ origin: "https://app.guideboard.test" })),
    ).toBe(true);
  });

  // The attack this exists to stop: a multipart POST is CORS-simple, so the
  // browser sends it cross-origin with the session cookie and no preflight.
  it("rejects a cross-origin request carrying the session cookie", () => {
    expect(
      isTrustedOrigin(withHeaders({ origin: "https://evil.example" })),
    ).toBe(false);
  });

  it("falls back to Referer when Origin is absent", () => {
    expect(
      isTrustedOrigin(
        withHeaders({ referer: "https://evil.example/attack.html" }),
      ),
    ).toBe(false);
    expect(
      isTrustedOrigin(
        withHeaders({ referer: "https://app.guideboard.test/profile" }),
      ),
    ).toBe(true);
  });

  it("allows a request with neither header (non-browser client)", () => {
    // A browser always sends one for the requests this guards, so an absent
    // header is a server-to-server caller, not the attack.
    expect(isTrustedOrigin(withHeaders({}))).toBe(true);
  });

  it("treats an unparseable Referer as absent rather than trusted-by-accident", () => {
    expect(isTrustedOrigin(withHeaders({ referer: "not a url" }))).toBe(true);
  });
});
