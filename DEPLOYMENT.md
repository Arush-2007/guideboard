# Deployment

How Guideboard runs in production, what is already set up, and what is left.

No secrets live in this file. Connection strings are in `.env.production.local`
(gitignored, laptop only, used solely to run migrations); everything the app
reads at runtime lives in Vercel's environment variables.

## The stack

| Piece | Where | Notes |
|---|---|---|
| App | Vercel, project `guideboard-43vu` | deploys from `main` |
| Functions | region `iad1` (Washington DC) | Vercel's default |
| Database | Neon `guideboard-prod-us`, AWS `us-east-1` | same region as the functions, deliberately |
| Execution engine | Inngest Cloud, Production environment | keys provisioned by the Inngest Vercel integration |
| Email | Resend | password resets + workflow-failure notices |
| Errors | Sentry | optional; needs `SENTRY_*` to upload source maps |

Functions and database are co-located on purpose: every Prisma query would
otherwise cross an ocean. If you ever move one, move the other.

## Current state

Live at **https://guideboard-43vu.vercel.app** — a temporary Vercel URL, not the
real domain.

Working and verified end to end: Google sign-in, Neon writes, tRPC, Inngest
dispatch, workflow execution, per-node execution records.

Not done yet: everything under [Remaining steps](#remaining-steps).

## Remaining steps

Work top to bottom. Steps 1–3 must be in this order; the rest are independent.

### 1. Domain

Buy it (Cloudflare Registrar or Namecheap; a free `.app` may be available via the
GitHub Student Developer Pack). Auto-renew **on** — a lapsed domain takes the
whole service down and breaks OAuth simultaneously.

The app goes at `app.<domain>`, leaving the apex free for a marketing site.

Vercel → Settings → Domains → add it, then create the CNAME Vercel shows you at
your registrar. **If you use Cloudflare DNS, set the record to "DNS only" (grey
cloud)** — proxying in front of Vercel causes redirect loops.

Wait for the certificate to go green before continuing.

### 2. Vercel Pro

Settings → Billing → Upgrade. $20/mo.

Required by Vercel's [fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage):
the Hobby plan is non-commercial use only, and this deployment is paid client
work. It is a terms requirement, not a performance one — Hobby also caps Active
CPU at 4 CPU-hours/month and *pauses the feature for 30 days* when exhausted.

Leave the function region at **`iad1`**. It already matches the database.

### 3. Point the app at the domain

Vercel → Settings → Environment Variables, Production scope:

```
BETTER_AUTH_URL=https://app.<domain>
NEXT_PUBLIC_APP_URL=https://app.<domain>
```

No trailing slash. **Delete and re-add rather than edit** — editing has
repeatedly preserved stray characters. Neither value may contain quotes; Vercel
stores values literally, unlike a `.env` file.

Redeploy with **build cache unchecked**. `NEXT_PUBLIC_*` is compiled into the
client bundle at build time, so a cached build serves the old value while the
dashboard shows the new one.

### 4. Google OAuth

[console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
→ your OAuth 2.0 Client ID. Keep the existing localhost and `vercel.app` entries
and add:

- Authorized JavaScript origins: `https://app.<domain>`
- Authorized redirect URIs: `https://app.<domain>/api/auth/callback/google`

The callback path is Better Auth's default; there is no custom `basePath`.

Then **publish the consent screen** (Google Auth Platform → Audience → Publish).
This is not cosmetic: while the app is in *Testing*, Google expires every refresh
token after **7 days**, so Sheets and Gmail triggers would silently die weekly.
Publishing removes that. Unverified-but-published shows a one-time warning screen
and is capped at ~100 users, which is irrelevant here.

Confirm these APIs are enabled: Sheets, Gmail, Drive, Forms.

**Verification is a separate, slow track.** The app requests `gmail.modify` and
`drive.readonly`, both *restricted* scopes, which require a third-party CASA
security assessment. Submit it and forget it — it only removes the warning
screen and does not block launch. Worth revisiting whether those two scopes are
actually needed; dropping them would reduce verification to a normal review.

### 5. Resend

Add and verify `<domain>` in Resend, then set:

```
EMAIL_FROM=Guideboard <noreply@<domain>>
```

Until the domain is verified, Resend's sandbox sender only delivers to your own
address — meaning clients would never receive the workflow-failure emails that
`src/features/executions/lib/failure-email.ts` sends.

### 6. Verify in production

Do all of these against the real domain before onboarding anyone:

- [ ] Sign up, sign out, sign in with email/password
- [ ] Sign in with Google, no consent errors
- [ ] Password reset email arrives at an external address
- [ ] Create a workflow, refresh, it persists
- [ ] **Run a real Google Sheets workflow** — proves OAuth token refresh works in
      production, which nothing else does
- [ ] Break a node deliberately → Execution goes FAILED **and the email arrives**
- [ ] Trigger the same event twice → idempotency collapses it to one execution
- [ ] Inngest dashboard shows no retries or dead-letter entries
- [ ] Sentry receives a test error with a readable stack trace

### 7. Onboard clients

Each client signs in with Google themselves and grants Sheets access — this
cannot be done on their behalf.

**Rebuild their workflows through the production UI.** Do not dump and restore:
`Workflow`, `Node` and `Connection` rows reference `userId` and credential ids
that do not exist in production, and the trigger poll rows must be re-synced. A
raw copy produces workflows that look correct and silently never fire.

### 8. Operations

- Sentry → alert on any new production issue
- Inngest → alert on function failure
- Inngest → **usage alert at 35,000 executions/month** (the free tier *stops
  executing* when exhausted rather than billing you)
- Neon → confirm history retention, and upgrade to Launch for point-in-time
  restore before real client data accumulates
- Uptime monitor on `https://app.<domain>`

## Loose ends

- [ ] **Rotate the Inngest signing key** — the current one was exposed in a chat
      transcript. Manage → Signing Key → Rotate; the Vercel integration pushes
      the new value automatically.
- [ ] Confirm both `poll-triggers` and `poll-schedules` show `*/5 * * * *` in
      Inngest. If `poll-schedules` shows `* * * * *`, `SCHEDULE_POLL_CRON` is not
      taking effect and ~43,000 executions/month are being burned on empty ticks.
- [ ] Remove the temporary tRPC timing instrumentation in `src/trpc/init.ts`
      once its numbers have been read.
- [ ] Delete the old Singapore Neon project.
- [ ] Fix the `ENCRYPTION_KEY.` typo (stray trailing period) in
      `.env.production.local`.

## Environment variables

Required in Vercel, Production scope:

```
DATABASE_URL              Neon POOLED  (host contains -pooler)
DIRECT_URL                Neon DIRECT  (no -pooler; migrations only)
BETTER_AUTH_SECRET
ENCRYPTION_KEY
BETTER_AUTH_URL           https://app.<domain>
NEXT_PUBLIC_APP_URL       https://app.<domain>
INNGEST_APP_ID            workflow-automation-app
INNGEST_EVENT_KEY         provisioned by the Inngest Vercel integration
INNGEST_SIGNING_KEY       provisioned by the Inngest Vercel integration
SCHEDULE_POLL_CRON        */5 * * * *
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
RESEND_API_KEY
EMAIL_FROM
```

Per the triggers actually in use: `GOOGLE_FORM_WEBHOOK_SECRET`,
`TYPEFORM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_SECRET`. Add an AI provider key only
if a live workflow contains an AI node.

Optional: `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN`.

Not needed — no workflow uses the Convert node: `R2_*`, `CLOUDCONVERT_API_KEY`.

**Never set `NGROK_URL` in production.** It is a trusted origin
(`src/lib/trusted-origins.ts`); a stale ngrok domain there is a live CSRF hole.

**`ENCRYPTION_KEY` can never be rotated.** Every `Credential`, `GoogleCredential`
and OAuth token is encrypted with it. Losing or changing it means every client
re-authorises every integration. Back it up in two places.

`POLL_CONCURRENCY` defaults to 5, the Inngest Hobby ceiling. Inngest validates
this at **sync** time and refuses to register a function declaring more, so a
value above the plan limit fails the whole deploy. Raise it only after upgrading.

### The self-hosted worker

Not deployed yet. **No workflow routes to it until a row is deliberately
flipped** — `Workflow.executionRuntime` is NULL on every existing workflow, and
NULL means Inngest. The switch itself now exists (see "Moving a workflow
between runtimes" below); what has not happened yet is any workflow being moved.

The worker is a long-lived container, not a Vercel function: it claims
`WorkflowJob` rows from Postgres and executes them itself. It must run in
**AWS us-east-1** next to Neon, for the same reason the app does — it is far
more query-chatty than the app, so an ocean between it and the database is paid
on every step. Host: **Fly.io `iad`** to begin with, moving to **AWS ECS
Fargate** when the stack consolidates on AWS.

⚠️ **Running the worker requires Neon's Launch plan. This is a correctness
requirement, not a budget preference.**

The worker polls the queue every 250 ms–2 s, reaps every 30 s and reports gauges
every 60 s, so Neon's compute **never sees the 5 idle minutes autosuspend
needs** — there is no poll interval that is both a working queue and lets the
compute sleep. On the Free plan that is not merely more expensive, it is a hard
stop: 100 CU-hours/project/month is roughly **400 hours against a 730-hour
month**, so the allowance runs out around **day 16** and Neon **suspends the
project's compute**. `DATABASE_URL` points at that same project, so the whole
application loses its database for the rest of the month — with no traffic at
all, because the worker's own heartbeat spent the budget.

**Set the autoscaling MINIMUM to 0.25 CU.** With autosuspend permanently out of
reach the bill is `min CU × 730 hours`, so the floor is what you actually pay:
~$19/month at 0.25 CU against ~$77/month at a 1 CU floor, for identical work.

⚠️ **Pin the replica count and disable autoscaling on whatever host.** Extra
replicas are safe for correctness — one running job per workflow is guaranteed
by a database index, not by there being one worker — but each multiplies
connections against Neon's ceiling.

It refuses to start without real values for the first two
(`assertWorkerConfig`, `src/worker/config.ts`):

```
DATABASE_URL              same database, but append
                          ?connection_limit=10&pool_timeout=20
                          and NOT pgbouncer=true
ENCRYPTION_KEY            the same value the app uses — see the warning above
```

⚠️ **Three more are NOT asserted and the worker degrades silently without each.
Set all three.** Nothing crashes; the worker simply stops doing things you
would assume it does:

```
NODE_ENV=production       Without it: Sentry is initialised DISABLED
                          (`enabled: NODE_ENV === "production"`) AND
                          `logger.error` skips `captureException` on its own
                          production gate — so every reaper error, poison job
                          and thrown run is console-only, and calling
                          initSentry() before the boot check achieves nothing.
                          It ALSO halves the retry budget: `enqueueWorkflowJob`
                          defaults `maxAttempts` from `resolveWorkflowRetries()`,
                          which reads NODE_ENV, so fan-out links the worker
                          enqueues get dev retries in production.
RESEND_API_KEY            Without it: a failed run marks the Execution FAILED
                          and the owner is NEVER TOLD. `sendEmail` throws, and
                          `settleFailedExecution` catches and logs it — which,
                          without NODE_ENV above, does not even reach Sentry.
BETTER_AUTH_URL           Without it: the failure email's link to the run is
                          malformed, so the alert arrives unactionable.
```

These are unasserted because `assertWorkerConfig` was scoped to secrets that are
security-critical, and none of these three is. That reasoning holds for the boot
check; it does not make them optional in production.

It deliberately does **not** need `BETTER_AUTH_SECRET` or
`INNGEST_SIGNING_KEY`: it serves no HTTP and signs no cookies, so demanding
them would be asking an operator to invent secrets for surface that does not
exist there.

⚠️ **The worker host is production-secret-bearing.** It decrypts every stored
third-party API key and OAuth token it touches, so its image, its logs and its
shell access are as sensitive as the app's.

Optional: `WORKER_CONCURRENCY` (default 4) and `WORKER_ID`. Leave `WORKER_ID`
unset — the default already appends a random suffix to hostname and pid, and
that suffix is load-bearing: a container restarting with the same hostname would
otherwise inherit the identity of the worker that just died, while that worker's
jobs are still leased to it.

`SENTRY_DSN` is worth setting. The worker calls `Sentry.init` itself, because
`instrumentation.ts` is a Next hook it never runs — without a DSN every worker
error is console-only.

### Moving a workflow between runtimes

One column decides, per workflow: `Workflow.executionRuntime`. NULL (the
default, and every existing row) means Inngest; `'WORKER'` means the
self-hosted worker. It is a Postgres enum, so a typo is rejected rather than
silently falling back to Inngest.

```sql
-- Move one workflow onto the worker.
UPDATE "Workflow" SET "executionRuntime" = 'WORKER' WHERE id = '<workflowId>';
```

Takes effect on the **next trigger** — there is no deploy and no cache. Runs
already in flight are unaffected, and a fan-out chain finishes on the runtime it
started on whatever the column says by then (that pin is a correctness measure,
not lineage: see `FanOutChain.runtime`).

⚠️ **Do not flip a workflow while one of its runs is executing.** It is safe for
ordinary runs, but there is no guard, and the fan-out pin only protects chains
that have already dispatched their first item.

#### Rolling back

```sql
-- 1. Stop new runs going to the worker.
UPDATE "Workflow" SET "executionRuntime" = NULL WHERE "executionRuntime" = 'WORKER';

-- 2. Stop runs ALREADY QUEUED. Statement 1 does not do this: a PENDING
--    WorkflowJob row is still claimed and run by the worker afterwards.
--    `fanOutChain IS NULL` is load-bearing — cancelling a chain link strands
--    every remaining item of that fan-out with nothing recording the
--    truncation, which is worse than letting the chain drain.
--    `idempotencyKey` is nulled because a cancelled job has no Execution row
--    beside it, so while the row survives it would be the only thing
--    deduplicating that key — silently dropping a redelivery Inngest would run.
--    The payload keeps the original key for forensics.
UPDATE "WorkflowJob"
   SET status = 'CANCELLED', "idempotencyKey" = NULL, "updatedAt" = now()
 WHERE status = 'PENDING' AND payload->'fanOutChain' IS NULL;
```

**Jobs already RUNNING are deliberately left alone.** They finish on the worker,
and their `Execution` rows are correct either way — killing them mid-run is what
the lease and the fencing exist to make survivable, not something to do by hand.

⚠️ **Rollback STOPS queued runs; it does not move them.** A cancelled PENDING
job has no `Execution` row yet, so that trigger is dropped with no record it
ever fired. Acceptable while one or two canary workflows are on the worker;
before any meaningful volume moves, a drain script (read each PENDING job's
payload, re-send it through Inngest, then cancel the row) should replace
statement 2 — it is safe to re-send because `Execution`'s unique constraint
dedups the keyed ones.

Both runtimes write the same rows to the same tables, so there is nothing to
migrate in either direction and no reconciliation to run. The Inngest functions
stay registered and `/api/inngest` keeps serving throughout, which is why this
is a database change rather than a deploy.

## Releasing a change

`main` is what clients run. Develop on branches; merge only what you are willing
to have live within three minutes.

```bash
# 1. Tests and build green
npm test && npm run build

# 2. If prisma/schema.prisma changed, migrate FIRST
npx dotenv -e .env.production.local -- npx prisma migrate deploy

# 3. Push — Vercel deploys automatically
git push origin main

# 4. If an Inngest function was added or removed, re-sync:
curl -s -X PUT https://app.<domain>/api/inngest
```

Migrate before pushing, never after: the reverse order runs new code against an
old schema.

Five things are not protected by Vercel's atomic deploys:

1. **Schema and code ship separately.** Only ever add columns; never drop one in
   the same release that stops using it, or the old deployment breaks mid-swap.
2. **In-flight Inngest runs.** Deploying while a run is mid-execution can fail it
   if step ids or their order changed. Deploy when nothing significant is running.
3. **Node registry changes break saved client workflows.** Their workflows are
   database rows referencing `NodeType` values and field names in your code.
   Renaming a field in `node-schemas.ts` makes every saved node with the old name
   fail `parseNodeConfig`.
4. **`ENCRYPTION_KEY`** — see above.
5. **The worker ships separately from the app.** Once any workflow is routed to
   it, the worker image is a second deployable that Vercel knows nothing about:
   the same migrate-before-code rule applies to it, and a release changing the
   engine has to reach both or the two runtimes execute different code against
   one database. Its own in-flight runs are covered by graceful shutdown — a
   `SIGTERM`ed worker stops claiming and finishes what it holds.

## Known issue: execution latency

Inngest Cloud dispatches roughly **one step every ~4 seconds**, and the engine
currently spends two steps per node (the executor, plus the `node-record` write).
Inngest have confirmed their Pro plan does not change this.

Measured: a two-node workflow took 19–39s wall clock while its nodes did **1ms**
of actual work. Projected from live workflows:

```
 60 nodes | ~125 steps | ~8.5 min | Mahindra-1
 18 nodes | ~ 41 steps | ~2.7 min | Mahindra-2
```

This is not a database, Vercel, or cold-start problem — the app responds in under
a second on every invocation. It is queueing between Inngest dispatches.

**This blocks client onboarding** and is being handled as separate work. The two
levers are fewer round trips (run contiguous nodes inside one `step.run` instead
of one step per node) and cheaper round trips (self-host Inngest, which removes
the queueing and the Pro question entirely).

Helpfully, every Mahindra workflow contains **zero non-idempotent nodes** — all
Sheets, Code, Calculator, Switch and Condition — so coarser checkpointing is safe
for exactly the workflows that need it. The HR workflow's 6 side-effecting nodes
are the ones that need to keep their own steps.
