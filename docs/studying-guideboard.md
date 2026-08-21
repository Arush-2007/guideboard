# Studying Guideboard

A reading plan for understanding this codebase from scratch, plus the
technologies you need before you start.

> Written 2026-08-08 against branch `ArchitechtureXFeatures`. File paths and
> line counts were verified at that point; the structure is stable but exact
> sizes will drift.

---

## Prerequisites

Tiered by *when it blocks you*, not by importance.

### Tier 0 — before day 1 (non-negotiable)

| Skill | The specific bit this repo demands |
|---|---|
| **TypeScript** | generics, discriminated unions, `Record<K,V>`, `Pick<>`, `import type`, and **branded types via `unique symbol`** — `src/features/executions/types.ts` uses all of these on page one |
| **React 19 + hooks** | function components, `useState`/`useEffect`/`useMemo`, controlled forms |
| **async/await** | promise composition, `try/finally`, error subclassing |
| **Relational SQL** | joins, indexes, transactions, nullability. You'll read raw SQL in `src/queue/jobs.ts` |

### Tier 1 — week one, learned alongside the code

- **Next.js 15 App Router** — server vs. client components, route groups, route
  handlers, `"use server"` actions. This is the single biggest source of
  confusion for newcomers.
- **Prisma** — schema syntax, relations, migrations, generated client.
  ⚠️ Generated to `src/generated/prisma`, *not* `node_modules`.
- **Zod v4** — object schemas, `.passthrough()`, `.refine()`, inferred types.
- **React Flow (`@xyflow/react` v12)** — nodes, edges, handles, `onNodesChange`.
- **tRPC v11 + TanStack Query v5** — procedures, context, `useQuery`/`useMutation`.

### Tier 2 — just-in-time, when you hit Phase 5–6

- **Inngest** — durable steps, step memoization, `concurrency` keys, crons,
  `NonRetriableError`
- **Postgres concurrency** — `FOR UPDATE SKIP LOCKED`, **partial unique
  indexes**, advisory locks, isolation levels
- **Distributed-systems vocabulary** — leases, **fencing tokens**, idempotency
  keys, at-least-once delivery, poison messages
- **Better Auth**, **Jotai**, **nuqs**, **Handlebars**, **Tailwind v4 + Radix**

### Tier 3 — recognize, never study

`toposort`, `cryptr`, `quickjs-emscripten`, `@aws-sdk/client-s3`, Sentry,
CloudConvert, `ky`, and each provider's REST API (Google Sheets, Graph,
Telegram…). Read these only when a task lands on one.

---

## The reading plan

**Scale check:** 457 non-test source files, 110 test files, an 878-line schema.
**Never read linearly.** And never open `src/generated/prisma/index.d.ts` — it's
50,070 generated lines.

**The one habit that matters:** this codebase carries unusually long "why"
comments — `src/queue/jobs.ts`, `src/inngest/utils.ts`,
`src/inngest/direct-publish.ts` all explain the *bug that forced the design*.
Read the comments as primary text, not decoration. Much of what follows is
unlearnable from the code alone.

---

### Phase 0 — Make it run *(half a session)*

```bash
docker compose up -d          # Postgres on :5433
npx prisma migrate dev
npm run dev                   # terminal 1
npm run inngest:dev           # terminal 2  ← without this, nothing executes
```

Then, in the UI: build **Manual Trigger → HTTP Request**, run it, open the
execution detail page.

> **Exit test:** you've seen a node get added, configured, executed, and its
> output rendered. Every abstraction later is a generalization of this.

---

### Phase 1 — The domain model *(1 session)*

Read `prisma/schema.prisma` in **this order**, not top to bottom:

1. `Workflow` → `Node` → `Connection` — the graph
2. `NodeType` enum (36 members) — the entire product surface in one list
3. `Execution` → `NodeExecution` — the run record
4. `Credential` + the per-provider token tables
5. **Skip for now:** `WorkflowJob`, `StepResult`, `FanOutSource/Item`,
   `NodeInputSnapshot`

> **Exit test:** Where is a node's user configuration stored? *(Answer:
> `Node.data`, untyped JSON — which is exactly why `node-schemas.ts` exists.)*

---

### Phase 2 — One vertical slice *(1–2 sessions) ← the highest-leverage phase*

Trace **one** node through all its registrations. Use HTTP Request; it's small
and has no external auth.

| Order | File | What it tells you |
|---|---|---|
| 1 | `src/config/node-options.ts` | label/icon — without it the node can't be added |
| 2 | `src/config/node-components.ts` | the canvas component |
| 3 | `src/features/executions/components/http-request/dialog.tsx` | the config form |
| 4 | `src/config/node-schemas.ts` | the Zod schema — `parseNodeConfig` is the one validation entry point |
| 5 | `src/features/executions/components/http-request/executor.ts` | the server-side work |
| 6 | `src/features/executions/lib/executor-registry.ts` | type → executor |
| 7 | `src/config/node-outputs.ts` | what downstream nodes can reference |

Then read `CLAUDE.md`'s "node system is a set of parallel registries" section.
**It will now make sense**, and it won't before.

> **Exit test:** name the 3 registries that are compile-errors-if-missing and
> the 5 that fail silently. That asymmetry is the #1 source of half-broken
> nodes.

---

### Phase 3 — The engine *(2 sessions)*

1. `src/features/executions/types.ts` — **the contract.** `NodeExecutor`,
   `ExecutorStep`, and the `routed()` / `fanOut()` branded outcomes.
2. `src/execution/topological-sort.ts` — graph → ordered list
3. `src/execution/run-execution.ts` — the runtime-neutral run body
4. `src/inngest/run-workflow.ts` (921 lines) — `runWorkflowNodes`, the actual
   loop. **The hardest file in the repo.** Budget a full session.
5. `src/execution/failure.ts` — `settleFailedExecution`

> **Exit test:** why does `ExecutorStep` expose only `run` and `ai`, and not
> `sleep` or `sendEvent`? *(Batching: contiguous nodes share one `step.run`, and
> steps can't nest.)*

---

### Phase 4 — How nodes talk to each other *(1 session)*

This is Guideboard's real product differentiator and it's spread across five
files:

- `src/lib/templating.ts` + `src/lib/template-token.ts` — `@<path>@` and legacy
  `{{...}}`
- `src/lib/node-ref.ts` — stable human-readable keys (`AI_TEXT_1`)
- `src/lib/upstream-fields.ts` + `src/components/variable-picker.tsx` — what the
  UI offers
- `src/lib/dangling-refs.ts` + `src/config/node-references.ts` — broken-reference
  detection

> **Exit test:** why does the Calculator resolve each token individually instead
> of rendering the whole string once? *(`2 * @<x>@` where `x = "1+1"` → an
> upstream **value** rewriting the expression's **structure**.)*

---

### Phase 5 — Triggers and the outside world *(1 session)*

- `src/lib/webhook-verify.ts` — the module's only export; owns "unset secret ⇒
  503, never allow"
- Any two routes under `src/app/api/webhooks/`
- `src/inngest/functions.ts` — `pollTriggers` + one `handle*Poll`. Skim the
  Sheets one (`sheets-poll-diff.ts` is 745 lines of hashing).

> **Exit test:** which trigger types need Inngest and which don't? *(Webhooks
> call the enqueue seam directly; only polling + schedule triggers structurally
> require it.)*

---

### Phase 6 — The two runtimes *(2 sessions) — current active work*

1. `src/inngest/utils.ts` — `sendWorkflowExecution`, **the single routing seam.**
   Read the `RETRYABLE_ENQUEUE_CODES` comment in full.
2. `src/queue/jobs.ts` (1,056 lines) — claim, lease, heartbeat, fence, backoff,
   reclaim
3. `src/worker/main.ts` — four concurrent loops
4. `src/worker/run-job.ts` — where realtime is a `noopPublish` today
5. `src/queue/step-store.ts` — the worker's answer to step memoization
6. `DEPLOYMENT.md` → "Moving a workflow between runtimes"

> **Exit test:** why must `sendWorkflowExecution` never fall back from worker to
> Inngest? *(Each runtime enforces one-run-per-workflow by a mechanism the other
> can't see — split-brain concurrency.)*

---

### Phase 7 — Frontend *(1–2 sessions)*

`src/features/editor/store/atoms.ts` → `editor.tsx` (917 lines) →
`src/trpc/init.ts` + `routers/_app.ts` → one feature's `server/prefetch.ts` +
`hooks/`.

Read `src/features/executions/components/execution.tsx` (1,604) only when you
need it.

---

### Phase 8 — Cross-cutting *(1 session)*

`src/lib/auth.ts` · `src/lib/encryption.ts` · `src/lib/production-config.ts`
(+ `src/worker/config.ts`) · `src/execution/retention.ts`

---

## Two accelerators

**Tests are the spec.** 110 test files sit next to their subjects. When a file
confuses you, open its `.test.ts` — `src/execution/run-execution.integration.test.ts`
teaches crash-resume better than the source does. Integration tests spin real
Postgres via testcontainers: `npm run test:integration`.

**Defer these four files** until a task forces them:
`google-sheets-action/executor.ts` (1,937), `google-sheets-action/dialog.tsx`
(1,677), `execution.tsx` (1,604), `sheets-poll-diff.ts` (745). They're deep,
provider-specific, and teach nothing structural.

---

**Realistic budget:** ~10–12 focused sessions to genuine fluency. Phases 0–3
(~5 sessions) get you to *productively adding a node*, which is most day-to-day
work. Phase 6 is the one that needs prior distributed-systems comfort — if
leases and fencing tokens are new, read
[Designing Data-Intensive Applications](https://dataintensive.net) ch. 8–9
first; it'll save you more time than it costs.
