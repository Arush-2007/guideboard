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

Per the triggers actually in use: `TYPEFORM_WEBHOOK_SECRET`,
`TELEGRAM_WEBHOOK_SECRET`. Add an AI provider key only if a live workflow
contains an AI node.

Google Form triggers need **no** environment variable — each is issued its own
webhook token + signing secret when its workflow is saved.
`GOOGLE_FORM_WEBHOOK_SECRET` is no longer read anywhere and can be deleted from
any environment that still sets it.

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

Four things are not protected by Vercel's atomic deploys:

1. **Schema and code ship separately.** Only ever add columns; never drop one in
   the same release that stops using it, or the old deployment breaks mid-swap.
2. **In-flight Inngest runs.** Deploying while a run is mid-execution can fail it
   if step ids or their order changed. Deploy when nothing significant is running.
3. **Node registry changes break saved client workflows.** Their workflows are
   database rows referencing `NodeType` values and field names in your code.
   Renaming a field in `node-schemas.ts` makes every saved node with the old name
   fail `parseNodeConfig`.
4. **`ENCRYPTION_KEY`** — see above.

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
