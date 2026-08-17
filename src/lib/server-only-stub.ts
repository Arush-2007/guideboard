// A no-op stand-in for the `server-only` package.
//
// `server-only` exists to stop a module reaching the CLIENT bundle: its main
// entry throws, and only Next's `react-server` export condition resolves to the
// harmless one. That guard is exactly right for the Next app and meaningless —
// actively wrong — in a plain Node process, where it throws on import and takes
// the process down.
//
// Three runtimes alias `server-only` here, and all three are servers:
//   - vitest.config.ts            (unit tests)
//   - vitest.integration.config.ts (integration tests)
//   - tsconfig.worker.json        (the self-hosted worker)
//
// ⚠️ It lives in `src/lib/`, not `src/test/`, because of that third one. Named
// as a test fixture it read as "only tests need this", which is how the worker
// came to be written against a module graph that throws on boot: `@/lib/email`,
// `@/lib/blob` and `@/lib/media-convert` all carry the guard and are all
// reachable from a running workflow. The two vitest aliases hid it, because
// they had already stubbed it out.
export {};
