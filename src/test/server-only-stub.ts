// Test stub for the `server-only` package. In production `server-only` throws if
// imported outside a React Server Component; under vitest (a plain Node env)
// that guard is meaningless, so we alias the import to this no-op (see
// vitest.config.ts). Lets tests import server-side modules (blob, media-convert,
// the executor registry that pulls them in) without per-file mocks.
export {};
