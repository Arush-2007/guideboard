# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Guideboard (package name `workflow-automation-app`) is an n8n-style visual workflow automation builder. Users compose workflows on a React Flow canvas from trigger and action nodes, and an Inngest background function executes them. Workflows can also be generated through a conversational AI builder.

## Commands

```bash
npm run dev          # Next.js dev server (Turbopack) on :3000
npm run dev:all      # Runs ngrok + inngest dev + next concurrently via mprocs (needs .env)
npm run inngest:dev  # Inngest dev server (required for any workflow execution locally)
npm run ngrok:dev    # Tunnel :3000 (required for inbound webhooks: Typeform, Telegram, etc.)
npm run build        # next build --turbopack
npm run lint         # biome check
npm run format       # biome format --write
npm test             # vitest run (one-shot)
npm run test:watch   # vitest watch
npx vitest run src/lib/rate-limit.test.ts   # run a single test file
```

Tests live next to their subjects as `*.test.ts` under `src/` and run in a Node environment (`vitest.config.ts`). The `@/*` path alias maps to `src/*` everywhere (tsconfig + vitest).

**Local execution requires both the Next dev server and the Inngest dev server running.** Without `inngest:dev`, triggering a workflow does nothing. Webhook-based triggers additionally need an ngrok tunnel.

## Prisma

The Prisma client is generated to `src/generated/prisma` (not the default `node_modules` location) — always import types and the client from there (e.g. `import { NodeType } from "@/generated/prisma"`). After editing `prisma/schema.prisma`, run `npx prisma generate` and `npx prisma migrate dev`. `src/lib/db.ts` exports a singleton client; import it as the default export.

## Architecture

### The node system is a set of parallel registries

Every node type is an enum member in `NodeType` (Prisma schema) plus a set of parallel registrations that **must all be kept in sync** when adding or removing a node.

Three are typed as a total `Record<NodeType, ...>`, so missing one is a **compile error**:

1. **`src/config/node-components.ts`** — maps `NodeType` → the React Flow canvas component (the visual node).
2. **`src/config/node-schemas.ts`** — maps `NodeType` → a Zod schema validating that node's `data` JSON. `parseNodeConfig(type, data)` is the single validation entry point, called by executors at runtime. Schemas are `.passthrough()` by default; field names must match the dialog forms exactly.
3. **`src/features/executions/lib/executor-registry.ts`** — maps `NodeType` → its server-side `NodeExecutor`. `getExecutor(type)` throws if a type is unregistered.

Four more are **partial** — an array, a `Set`, or a `Partial<Record<...>>` — so omitting one compiles cleanly and passes the test suite while shipping a node that is broken in the UI. There is no compiler backstop here; these have to be done from the checklist:

4. **`src/config/node-options.ts`** — label, description and icon. **Without this the node cannot be added from the node selector at all.** Brand icons come from the integrations registry; Lucide icons for utility nodes are imported here.
5. **`src/config/node-outputs.ts`** — the fields the node writes into `context`. **Without this the node's output never appears in the variable picker, so no downstream node can reference it** — the node runs, but nothing can consume its result.
6. **`src/lib/node-output-summary.ts`** — the one-line "what happened" summary for the execution page's Friendly view. Returning `null`, or having no entry, falls back to the raw output table.
7. **`src/features/executions/lib/node-status-registry.ts`** — the `STATUS_EMITTING_NODE_TYPES` allowlist, for nodes whose executor publishes realtime status (see below).

`src/config/node-kinds.ts` (`TRIGGER_NODE_TYPES`) needs an entry **only for triggers**; `node-kinds.test.ts` asserts it matches the `_TRIGGER`-suffixed enum members exactly, so a trigger left out fails the build. The conversational builder needs nothing — its allowlist derives from `Object.values(NodeType)` (`src/lib/workflow-persistence.ts`).

On realtime status, two further notes:
1. The status-emitting `NodeType` allowlist (`STATUS_EMITTING_NODE_TYPES`) in **`src/features/executions/lib/node-status-registry.ts`**, consumed by the editor's `<NodeStatusSubscriber>`. When you add a node whose executor streams status, add its `NodeType` here.
2. All node statuses share **one** per-user channel, `src/inngest/channels/node-status.ts` — `channel((userId) => \`node-status:${userId}\`)`, parameterized by `userId` so each user's stream is isolated. Executors publish with `nodeStatusChannel(userId).status({ nodeId, status })`; the single `fetchNodeStatusRealtimeToken` action (`src/features/executions/lib/node-status-token.ts`) mints a session-scoped token via `mintUserStatusToken(nodeStatusChannel)` (`src/inngest/channels/mint-status-token.ts`). The editor opens exactly one subscription regardless of node-type count — do **not** add a channel file per node.

Realtime `publish` is provided by `realtimeMiddleware()` on the Inngest client (`src/inngest/client.ts`); there is **no** `channels: [...]` array to maintain on `executeWorkflow`.

A single node feature is split across two locations by convention:
- **Triggers** live in `src/features/triggers/components/<node>/` (node.tsx, dialog.tsx, executor.ts, actions.ts).
- **Actions** live in `src/features/executions/components/<node>/` with the same file layout.

`actions.ts` files are Next.js `"use server"` actions that mint Inngest realtime subscription tokens so the client can stream node status.

### Workflow execution (Inngest)

`src/inngest/functions.ts` is the engine. `executeWorkflow` is triggered by the `workflows/execute.workflow` event (sent via `sendWorkflowExecution` in `src/inngest/utils.ts`). It:
1. Creates an `Execution` row (with optional `idempotencyKey` dedup — used heavily by pollers).
2. Loads the workflow's nodes + connections and `topologicalSort`s them (cycles throw).
3. Runs each node's executor **sequentially**, threading a `context` object (`WorkflowContext = Record<string, unknown>`) from one node to the next. Each executor returns the next context, conventionally writing its output under a key like `<nodetype>_<nodeId>`.
4. Marks the `Execution` SUCCESS/FAILED; `onFailure` records the error. Retries are 3 in production, 0 in dev.

A `NodeExecutor` (`src/features/executions/types.ts`) receives `{ data, nodeId, userId, context, step, publish }`. Use `step.run(...)` for any side-effecting work so Inngest can checkpoint it, and `publish(channel(userId).status({ nodeId, status }))` to stream UI status (channels are user-scoped — see the registration notes above). Throw `NonRetriableError` for config/validation failures so Inngest doesn't retry them.

**Templating:** action executors render user-authored fields (message bodies, etc.) against the `context` through **`renderTemplate` (`src/lib/templating.ts`)** — never by calling Handlebars directly. It resolves two syntaxes:

- `@<path>@` — the primary, user-facing placeholder, inserted by the variable picker and carrying a canonical context path (`@<AI_TEXT_1.output>@`). Resolved by direct substitution, so it never collides with JSON braces. Its grammar lives in one place, `PLACEHOLDER_RE` (`src/lib/template-token.ts`), shared by the resolver and the ref-rename rewriter.
- `{{...}}` — legacy Handlebars, still honoured for back-compat and power users. The `json` helper is registered once, inside `templating.ts`.

A node may narrow this. The Calculator (`components/calculator/executor.ts`) rejects `{{...}}` outright and resolves each `@<path>@` token **individually**, because there a rendered value is substituted into an expression that then gets parsed: a single-pass whole-string render would let an upstream *value* rewrite the expression's *structure* (`2 * @<x>@` with `x = "1+1"` evaluating to 3, not 4). Any executor that parses what it renders needs the same treatment.

**Polling triggers:** Gmail, Google Sheets, and YouTube comment triggers are not webhooks — they're cron Inngest functions (`pollGmail`, `pollGoogleSheets`, `pollYoutubeComments`, every 5 min) that diff external state against `*Poll` tables and emit workflow executions with idempotency keys. `pruneOldExecutions` deletes executions older than 30 days. All four functions are registered in `src/app/api/inngest/route.ts` — new Inngest functions must be added there to be served.

### API layer (tRPC)

tRPC v11 with superjson. Routers are composed in `src/trpc/routers/_app.ts` from per-feature routers under `src/features/*/server/routers.ts`. `src/trpc/init.ts` defines `protectedProcedure` (requires a Better Auth session, attaches `ctx.auth`). `premiumProcedure` is currently an alias for `protectedProcedure` (Polar billing is disabled). Server components prefetch via `src/trpc/server.tsx`; client uses TanStack Query via `src/trpc/client.tsx`.

### Auth & credentials

Auth is **Better Auth** (`src/lib/auth.ts`) with email/password + GitHub/Google OAuth, backed by the Prisma adapter. The Google provider requests Sheets/Gmail/Drive scopes; on account create/update a database hook mirrors the OAuth tokens into the `GoogleCredential` table (encrypted). Catch-all route handler at `src/app/api/auth/[...all]/route.ts`.

Third-party secrets (API keys, OAuth tokens) are encrypted at rest with `cryptr` via `src/lib/encryption.ts` (`encrypt`/`decrypt`, keyed by `ENCRYPTION_KEY`). Never store these plaintext. User-provided integration credentials live in the `Credential` table (typed by `CredentialType`); platform OAuth tokens (Instagram, YouTube, Google) have dedicated tables with refresh helpers in `src/lib/*-token.ts`.

### Webhooks

Inbound webhooks are Next route handlers under `src/app/api/webhooks/<provider>/`. Each verifies a provider-specific shared secret/signature (see `src/lib/webhook-verify.ts` and the `*_WEBHOOK_SECRET` / `*_VERIFY_TOKEN` env vars in `.env.example`), then calls `sendWorkflowExecution`.

### Conversational builder

`src/features/conversations/server/router.ts` drives a phased chat (GATHERING → CONFIRMING → BUILDING) that calls the Anthropic Messages API directly (`ANTHROPIC_API_KEY`) with a system prompt instructing the model to emit workflow JSON. The generated JSON is strictly validated (Zod, node-type allowlist, edge/id integrity) before being persisted as a `Workflow` + `Node`s + `Connection`s in a transaction, and trigger poll rows are synced. The chat UI is `src/features/editor/components/chat-panel.tsx`.

## Frontend conventions

- Next.js 15 App Router, React 19. Route groups: `(auth)`, `(dashboard)`. UI is shadcn/ui (`src/components/ui`) + Tailwind v4 + Radix; `components.json` configures shadcn.
- The canvas uses `@xyflow/react`. React Flow editor state lives in a jotai atom (`src/features/editor/store/atoms.ts`).
- URL search-param state uses `nuqs` (see each feature's `params.ts` + `params-loader.ts`).
- Data fetching follows a prefetch-on-server / suspense-on-client pattern per feature (`server/prefetch.ts` + `hooks/`).

## Formatting

Biome (not ESLint/Prettier): 2-space indent, organize-imports on, Next + React lint domains enabled. Run `npm run lint` / `npm run format`.
