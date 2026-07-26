import { describe, expect, it } from "vitest";
import { describeUserAgent } from "./user-agent";

// Real strings copied from the browsers they name — the whole point of the
// helper is disambiguating agents that impersonate each other, so synthetic
// fixtures would test nothing.
const AGENTS = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  operaMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  firefoxLinux:
    "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  curl: "curl/8.7.1",
};

describe("describeUserAgent", () => {
  it("reads a plain desktop browser", () => {
    expect(describeUserAgent(AGENTS.chromeWindows)).toMatchObject({
      browser: "Chrome",
      os: "Windows",
      label: "Chrome on Windows",
    });
  });

  it.each([
    ["Edge, which also claims Chrome", AGENTS.edgeWindows, "Edge", "Windows"],
    ["Opera, which also claims Chrome", AGENTS.operaMac, "Opera", "macOS"],
    [
      "Chrome, which also claims Safari",
      AGENTS.chromeAndroid,
      "Chrome",
      "Android",
    ],
    ["real Safari", AGENTS.safariMac, "Safari", "macOS"],
    ["Chrome on iOS (CriOS)", AGENTS.chromeIphone, "Chrome", "iOS"],
    // iPadOS reports "like Mac OS X"; the iPad token has to win.
    ["an iPad posing as a Mac", AGENTS.safariIpad, "Safari", "iPadOS"],
    ["Firefox on Linux", AGENTS.firefoxLinux, "Firefox", "Linux"],
  ])("disambiguates %s", (_name, ua, browser, os) => {
    expect(describeUserAgent(ua)).toMatchObject({ browser, os });
  });

  it("labels a non-browser client without an OS", () => {
    expect(describeUserAgent(AGENTS.curl)).toMatchObject({
      browser: "Command line",
      os: "Unknown",
      label: "Command line",
    });
  });

  it.each([[null], [undefined], [""], ["   "]])(
    "falls back for a missing agent (%s)",
    (ua) => {
      expect(describeUserAgent(ua)).toMatchObject({ label: "Unknown device" });
    },
  );

  it("falls back for an unrecognised agent rather than guessing", () => {
    expect(describeUserAgent("SomeUnknownBot/1.0")).toEqual({
      browser: "Unknown",
      os: "Unknown",
      label: "Unknown device",
    });
  });
});
