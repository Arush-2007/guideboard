/**
 * Turns the raw `Session.userAgent` string into something a person can
 * recognise in the profile's session list ("Chrome on Windows"). This is a
 * deliberately small, dependency-free reading of the UA string: it only needs
 * to be good enough for someone to spot *which* of their devices a row is, so
 * an unrecognised agent degrades to "Unknown" rather than guessing.
 *
 * Order matters in both tables — the checks are first-match-wins and several
 * agents impersonate each other (Edge and Opera both contain "Chrome"; Chrome
 * contains "Safari"; iPadOS reports "Mac OS X"), so the more specific brand
 * must be tested before the one it borrows from.
 */

export type DeviceDescription = {
  browser: string;
  os: string;
  /** `"Chrome on Windows"`, or a single half when the other is unknown. */
  label: string;
};

const UNKNOWN = "Unknown";

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\b(?:OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\//, "Chrome"],
  [/\bChrome\/|\bChromium\//, "Chrome"],
  [/\bSafari\//, "Safari"],
  [/\bcurl\/|\bwget\//i, "Command line"],
  [/\bPostmanRuntime\//, "Postman"],
];

const OPERATING_SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/\bWindows NT\b|\bWindows\b/, "Windows"],
  [/\bAndroid\b/, "Android"],
  // iPadOS 13+ masquerades as desktop Safari, so iPad must precede Mac OS X.
  [/\biPad\b/, "iPadOS"],
  [/\biPhone\b|\biPod\b/, "iOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

const firstMatch = (
  table: ReadonlyArray<[RegExp, string]>,
  ua: string,
): string => table.find(([pattern]) => pattern.test(ua))?.[1] ?? UNKNOWN;

export function describeUserAgent(
  userAgent: string | null | undefined,
): DeviceDescription {
  if (!userAgent?.trim()) {
    return { browser: UNKNOWN, os: UNKNOWN, label: "Unknown device" };
  }

  const browser = firstMatch(BROWSERS, userAgent);
  const os = firstMatch(OPERATING_SYSTEMS, userAgent);

  if (browser === UNKNOWN && os === UNKNOWN) {
    return { browser, os, label: "Unknown device" };
  }
  if (browser === UNKNOWN) return { browser, os, label: os };
  if (os === UNKNOWN) return { browser, os, label: browser };

  return { browser, os, label: `${browser} on ${os}` };
}
