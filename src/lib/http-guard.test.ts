import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "tinyglobby";
import { describe, expect, it } from "vitest";

/**
 * The guard that keeps the timeout policy from rotting.
 *
 * Every outbound call must go through the shared client in `src/lib/http.ts`, which
 * is the only place a timeout number lives. A bare `ky` import silently inherits
 * ky's undocumented 10s default (the bug that started all this), and a bare `fetch`
 * has NO timeout at all — it hangs until the platform kills the invocation, which
 * surfaces as an opaque platform error rather than a node failure.
 *
 * This test is not theatre: writing it surfaced a second unbounded Anthropic `fetch`
 * in `workflows/server/routers.ts` that the manual sweep had missed.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The one module allowed to reach for ky itself. */
const HTTP_MODULE = "lib/http.ts";

/**
 * Files allowed to call `fetch` directly, each for a reason ky cannot serve.
 * ADDING TO THIS LIST IS A DECISION — the call must still pass `timeoutSignal(...)`,
 * which the second test below enforces.
 */
const FETCH_ALLOWLIST = new Set([
  // Streaming download + multipart upload to a presigned form.
  "lib/media-convert.ts",
  // Streams an arbitrary user-supplied URL.
  "lib/resume-fetch.ts",
  // Anthropic Messages API, called directly rather than through the AI SDK.
  "features/conversations/server/router.ts",
  "features/workflows/server/routers.ts",
]);

/** Client-side code: these `fetch`es go to our own origin, not a third party. */
const CLIENT_GLOBS = [
  "**/hooks/**",
  "**/prefetch.ts",
  "**/components/**/*.tsx",
  "trpc/**",
];

async function serverSourceFiles(): Promise<string[]> {
  const files = await glob(["**/*.ts"], {
    cwd: SRC,
    ignore: [
      "**/*.test.ts",
      "**/*.integration.test.ts",
      "generated/**",
      "test/**",
      ...CLIENT_GLOBS,
    ],
  });
  return files.map((f) => f.replaceAll("\\", "/")).sort();
}

const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

describe("no bare ky client outside the shared module", () => {
  it("nothing imports ky's DEFAULT export except src/lib/http.ts", async () => {
    // It is ky's default export — the CLIENT — that carries the 10s default timeout.
    // Named imports (`HTTPError`, `TimeoutError`, `type Options`) are error classes
    // and types used for `instanceof` checks and signatures; they cannot make a
    // request, so they cannot inherit a timeout. Banning those would just push the
    // error mappers into contortions for no safety gain.
    const offenders: string[] = [];

    for (const rel of await serverSourceFiles()) {
      if (rel === HTTP_MODULE) continue;

      for (const line of read(rel).split("\n")) {
        if (!/from ["']ky["']/.test(line)) continue;
        // `import type ...` is erased at compile time.
        if (/^\s*import\s+type\s/.test(line)) continue;
        // A default import is any binding BEFORE the `{`: `import ky, { X } from`
        // or `import ky from`. A pure named import starts with `import {`.
        if (/^\s*import\s*\{/.test(line)) continue;

        offenders.push(`${rel}: ${line.trim()}`);
      }
    }

    expect(
      offenders,
      "Import { http } from '@/lib/http' instead — a bare ky client silently uses " +
        "ky's 10s default timeout, which is the bug this module exists to prevent.",
    ).toEqual([]);
  });
});

describe("no unbounded fetch", () => {
  it("only allowlisted files call fetch directly", async () => {
    const offenders: string[] = [];

    for (const rel of await serverSourceFiles()) {
      if (rel === HTTP_MODULE || FETCH_ALLOWLIST.has(rel)) continue;

      for (const line of read(rel).split("\n")) {
        // Real call sites only: `await fetch(`, `= fetch(`, `return fetch(`.
        // Not `UrlFetchApp.fetch(` (inside a generated Apps Script string) and not
        // the word "fetch" in prose.
        if (!/(?:^|[\s=(])fetch\s*\(/.test(line)) continue;
        if (/\.fetch\s*\(/.test(line)) continue;
        if (/^\s*(\/\/|\*)/.test(line)) continue;

        offenders.push(`${rel}: ${line.trim()}`);
      }
    }

    expect(
      offenders,
      "A raw fetch has NO timeout — it hangs until the platform kills the " +
        "invocation. Use the `http` client from '@/lib/http', or add the file to " +
        "FETCH_ALLOWLIST and pass `signal: timeoutSignal(...)`.",
    ).toEqual([]);
  });

  it("every allowlisted fetch file actually bounds its calls", async () => {
    // The allowlist is an escape hatch from ky, NOT from having a timeout.
    for (const rel of FETCH_ALLOWLIST) {
      const source = read(rel);
      const fetchCalls = source
        .split("\n")
        .filter(
          (l) => /(?:^|[\s=(])fetch\s*\(/.test(l) && !/\.fetch\s*\(/.test(l),
        );
      const signals = source
        .split("\n")
        .filter((l) => /timeoutSignal\(/.test(l));

      expect(
        signals.length,
        `${rel} has ${fetchCalls.length} fetch call(s) but ${signals.length} ` +
          `timeoutSignal(...) — every allowlisted fetch must be bounded.`,
      ).toBeGreaterThanOrEqual(fetchCalls.length);
    }
  });
});
