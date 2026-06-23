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

### The node system is a triple registry

Every node type is an enum member in `NodeType` (Prisma schema) plus three parallel registrations that **must all be kept in sync** when adding or removing a node:

1. **`src/config/node-components.ts`** — maps `NodeType` → the React Flow canvas component (the visual node).
2. **`src/config/node-schemas.ts`** — maps `NodeType` → a Zod schema validating that node's `data` JSON. `parseNodeConfig(type, data)` is the single validation entry point, called by executors at runtime. Schemas are `.passthrough()` by default; field names must match the dialog forms exactly.
3. **`src/features/executions/lib/executor-registry.ts`** — maps `NodeType` → its server-side `NodeExecutor`. `getExecutor(type)` throws if a type is unregistered.

For executors that emit realtime status, there are two more registrations:
1. The node type → channel/token mapping in **`src/features/executions/lib/node-status-registry.ts`** (consumed by the editor's `<NodeStatusSubscriber>`s and `useNodeStatus`).
2. A per-user channel file in `src/inngest/channels/`. Channels are **parameterized by `userId`** (e.g. `channel((userId) => \`anthropic-execution:${userId}\`)`) so each user's status stream is isolated. Executors publish with `xChannel(userId).status({ nodeId, status })`, and the `fetch*RealtimeToken` server action mints a session-scoped token via `mintUserStatusToken(xChannel)` (`src/inngest/channels/mint-status-token.ts`).

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

**Templating:** action executors render user-authored fields (message bodies, etc.) through Handlebars against the `context`, so users reference upstream output with `{{some_node_output.field}}`. A `json` helper is registered.

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
