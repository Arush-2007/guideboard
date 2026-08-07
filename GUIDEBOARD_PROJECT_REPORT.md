# Guideboard — Project Overview Report

**Generated:** March 30, 2026
**Codebase Location:** `C:\Users\Arav jain\guideboard`
**Git Status:** Not yet initialized as a git repository

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Tech Stack](#3-tech-stack)
4. [Database Schema](#4-database-schema)
5. [Authentication & Authorization](#5-authentication--authorization)
6. [Routing & Pages](#6-routing--pages)
7. [API Surface](#7-api-surface)
8. [Workflow Engine (Inngest)](#8-workflow-engine-inngest)
9. [Node System — Triggers & Actions](#9-node-system--triggers--actions)
10. [Feature Inventory](#10-feature-inventory)
11. [Credential / OAuth Integrations](#11-credential--oauth-integrations)
12. [UI & Theming](#12-ui--theming)
13. [Testing & Linting](#13-testing--linting)
14. [Environment Variables](#14-environment-variables)
15. [What Is Complete](#15-what-is-complete)
16. [What Is Partially Implemented](#16-what-is-partially-implemented)
17. [What Is Missing / Needs Work](#17-what-is-missing--needs-work)
18. [Dev Workflow & Commands](#18-dev-workflow--commands)
19. [Directory Structure](#19-directory-structure)
20. [Dependency List](#20-dependency-list)

---

## 1. Executive Summary

**Guideboard** is a visual workflow automation platform built with **Next.js 15 (App Router + Turbopack)**, **React 19**, and **React Flow**. Users create multi-step workflows by dragging trigger nodes (manual, webhooks, social media events) and action nodes (AI text generation, API calls, social media replies, messaging) onto a canvas, connecting them, and executing them via **Inngest** (a durable, event-driven function runner).

The app currently supports:
- **Instagram** (OAuth, comment triggers, automated replies, AI-generated replies)
- **YouTube** (OAuth, comment triggers, automated replies)
- **Google Forms** (webhook triggers)
- **AI providers** — OpenAI, Anthropic (Claude), Google Gemini, xAI (Grok)
- **Messaging** — Discord, Slack
- **HTTP requests** — generic REST calls

Billing (Polar) was previously integrated and has been cleanly removed; the `premiumProcedure` is now aliased to `protectedProcedure` (auth-only gating).

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          BROWSER (React 19)                        │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │  Auth Pages  │  │  Dashboard  │  │ Workflow     │  │ Settings │ │
│  │  (login,     │  │  (workflows,│  │ Editor       │  │ (Insta   │ │
│  │   signup)    │  │  credentials│  │ (React Flow) │  │  config) │ │
│  │             │  │  executions)│  │              │  │          │ │
│  └─────────────┘  └─────────────┘  └──────────────┘  └──────────┘ │
│                                                                     │
│  State: Jotai (editor) | TanStack Query (server) | nuqs (URL)     │
│  HTTP: tRPC (mutations/queries) | ky (OAuth/webhooks)              │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ tRPC over fetch (/api/trpc/[trpc])
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     NEXT.JS SERVER (App Router)                     │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  tRPC Routers    │  │  API Routes      │  │  Server Actions  │  │
│  │  - workflows     │  │  - /api/auth/*   │  │  - save node     │  │
│  │  - credentials   │  │  - /api/webhooks │  │    config        │  │
│  │  - executions    │  │  - /api/inngest  │  │  - get realtime  │  │
│  │  - instagramSet  │  │                  │  │    tokens        │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
│           │                     │                      │            │
│           ▼                     ▼                      ▼            │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                     PRISMA (PostgreSQL)                      │   │
│  │  User, Session, Account, Verification                       │   │
│  │  Workflow, Node, Connection, Execution                      │   │
│  │  Credential, InstagramCredential, YoutubeCredential         │   │
│  │  InstagramSettings                                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    INNGEST (Durable Functions)               │   │
│  │  Event: workflows/execute.workflow                          │   │
│  │  → Topological sort nodes → Run executors sequentially      │   │
│  │  → Realtime status updates via 14 channels                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                           │
          External APIs    ▼
   ┌───────────┬───────────┬───────────┬──────────┬──────────┐
   │ Instagram │  YouTube  │  OpenAI   │ Discord  │  Google  │
   │ Graph API │  Data API │  + xAI    │ Webhook  │  Forms   │
   │           │           │  + Gemini │          │          │
   │           │           │  + Claude │  Slack   │          │
   │           │           │           │ Webhook  │          │
   └───────────┴───────────┴───────────┴──────────┴──────────┘
```

### Data Flow for a Typical Execution

1. **Trigger fires** — e.g., an Instagram webhook POSTs to `/api/webhooks/instagram`
2. **Webhook handler** filters by configured `postId`/`keywordFilter`, then calls `sendWorkflowExecution({ workflowId, initialData: { commentId, commentText, commenterName, postId } })`
3. **Inngest** picks up the `workflows/execute.workflow` event
4. **`executeWorkflow`** creates an `Execution` row (status: RUNNING), topologically sorts the workflow's nodes, then runs each node's executor in order
5. Each **executor** publishes realtime status updates (loading → success/error) via Inngest realtime channels, and passes an enriched `context` object downstream
6. On completion, the `Execution` is marked SUCCESS with the final context as output

---

## 3. Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Framework** | Next.js (App Router + Turbopack) | 15.5.4 |
| **Language** | TypeScript | ^5 |
| **UI Library** | React | 19.1.0 |
| **Visual Workflow Canvas** | @xyflow/react (React Flow) | ^12.8.6 |
| **Component Library** | shadcn/ui (Radix UI primitives) | New York variant |
| **Styling** | Tailwind CSS v4 (CSS-first config) | ^4 |
| **State (client)** | Jotai (editor atoms), TanStack Query (server state), nuqs (URL params) | ^2.15 / ^5.90 / ^2.7 |
| **Forms** | React Hook Form + Zod | ^7.64 / ^4.1 |
| **API Layer** | tRPC v11 (over fetch) | ^11.6 |
| **Authentication** | Better Auth (email/password, GitHub, Google OAuth) | ^1.3.26 |
| **Database** | PostgreSQL via Prisma ORM | Prisma ^6.16 |
| **Workflow Engine** | Inngest (durable functions + realtime) | ^3.44 |
| **AI SDKs** | Vercel AI SDK (`ai`), `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google` | ^5.0 / ^2.0 |
| **HTTP Client** | ky | ^1.12 |
| **Encryption** | cryptr (AES-256-CTR) | ^6.4 |
| **Template Engine** | Handlebars (for dynamic reply messages) | ^4.7 |
| **Linting** | Biome | 2.2.0 |
| **Testing** | Vitest | ^3.2 |
| **Toasts** | Sonner | ^2.0 |
| **Theme** | next-themes (system/light/dark) | ^0.4 |
| **Dev Runner** | mprocs (Next + Inngest + ngrok) | ^0.7 |

---

## 4. Database Schema

### Models (12)

| Model | Purpose | Key Relations |
|-------|---------|--------------|
| `User` | Core user entity | Has many: Session, Account, Workflow, Credential, InstagramCredential, YoutubeCredential. Has one: InstagramSettings |
| `Session` | Auth sessions (Better Auth managed) | Belongs to User |
| `Account` | OAuth provider accounts (Better Auth) | Belongs to User |
| `Verification` | Email verification tokens | Standalone |
| `Credential` | API keys (OpenAI, Anthropic, Gemini, xAI, Instagram) — encrypted values | Belongs to User; referenced by Node |
| `InstagramCredential` | Instagram OAuth token (long-lived, encrypted) | Belongs to User |
| `InstagramSettings` | Per-user Instagram AI context (accountDescription, replyTone, replyGoal) | Belongs to User (1:1 via unique userId) |
| `YoutubeCredential` | YouTube OAuth tokens (access + refresh, both encrypted) | Belongs to User |
| `Workflow` | Named workflow container | Belongs to User; has many Node, Connection, Execution |
| `Node` | Single step in a workflow (trigger or action) | Belongs to Workflow; optionally links to Credential; has Connection edges |
| `Connection` | Directed edge between two nodes | Belongs to Workflow; references fromNode → toNode |
| `Execution` | One run of a workflow | Belongs to Workflow; tracks status, output, error |

### Enums

| Enum | Values |
|------|--------|
| `CredentialType` | `OPENAI`, `ANTHROPIC`, `GEMINI`, `INSTAGRAM`, `XAI` |
| `NodeType` | `INITIAL`, `MANUAL_TRIGGER`, `HTTP_REQUEST`, `GOOGLE_FORM_TRIGGER`, `INSTAGRAM_COMMENT_TRIGGER`, `INSTAGRAM_REPLY_COMMENT`, `YOUTUBE_COMMENT_TRIGGER`, `YOUTUBE_REPLY_COMMENT`, `AI_REPLY_GENERATOR`, `ANTHROPIC`, `GEMINI`, `OPENAI`, `DISCORD`, `SLACK` |
| `ExecutionStatus` | `RUNNING`, `SUCCESS`, `FAILED` |

---

## 5. Authentication & Authorization

| Component | Implementation |
|-----------|---------------|
| **Auth library** | Better Auth (`src/lib/auth.ts`) with Prisma adapter |
| **Providers** | Email/password (built-in), GitHub OAuth, Google OAuth (both conditionally enabled based on env vars) |
| **Session access (server)** | `auth.api.getSession({ headers: await headers() })` |
| **Session access (client)** | `authClient` from `src/lib/auth-client.ts` (Better Auth React client) |
| **Route guards** | `requireAuth()` / `requireUnauth()` helpers in `src/lib/auth-utils.ts` — used in every server page |
| **tRPC guards** | `protectedProcedure` (checks session, attaches `ctx.auth`) — all data-mutating routes use this |
| **Premium gates** | `premiumProcedure` is currently aliased to `protectedProcedure` (billing removed) |
| **Middleware** | None — no Next.js middleware file exists |
| **API route: Better Auth** | `/api/auth/[...all]/route.ts` — catches all Better Auth internal routes |

---

## 6. Routing & Pages

| URL | Page File | Description |
|-----|-----------|-------------|
| `/` | *(redirects to `/workflows` via `next.config.ts`)* | Home redirect |
| `/login` | `(auth)/login/page.tsx` | Login form (guarded by `requireUnauth`) |
| `/signup` | `(auth)/signup/page.tsx` | Registration form (guarded by `requireUnauth`) |
| `/workflows` | `(dashboard)/(rest)/workflows/page.tsx` | Workflow list with search + pagination |
| `/workflows/[workflowId]` | `(dashboard)/(editor)/workflows/[workflowId]/page.tsx` | Full-screen React Flow editor |
| `/credentials` | `(dashboard)/(rest)/credentials/page.tsx` | Credential list + Instagram/YouTube OAuth sections |
| `/credentials/new` | `(dashboard)/(rest)/credentials/new/page.tsx` | Create new API key credential |
| `/credentials/[credentialId]` | `(dashboard)/(rest)/credentials/[credentialId]/page.tsx` | View/edit single credential |
| `/executions` | `(dashboard)/(rest)/executions/page.tsx` | Execution history list |
| `/executions/[executionId]` | `(dashboard)/(rest)/executions/[executionId]/page.tsx` | Single execution detail (status, output, error) |
| `/settings` | `(dashboard)/(rest)/settings/page.tsx` | Instagram Settings form (AI reply context) |

### Layouts

| Layout | Purpose |
|--------|---------|
| `app/layout.tsx` | Root: ThemeProvider, TRPCReactProvider, NuqsAdapter, Jotai Provider, Sonner Toaster |
| `(auth)/layout.tsx` | Centered auth card layout |
| `(dashboard)/layout.tsx` | Sidebar + header shell |
| `(dashboard)/(rest)/layout.tsx` | Standard content area for non-editor pages |
| `(dashboard)/(editor)/` | No separate layout — editor pages are full-screen |

### Error Boundaries

| File | Scope |
|------|-------|
| `app/error.tsx` | Global app-level error UI |
| `app/global-error.tsx` | Unrecoverable global errors |
| `app/(dashboard)/error.tsx` | Dashboard-specific error UI |
| `app/not-found.tsx` | Custom 404 page |

---

## 7. API Surface

### tRPC Routes (`/api/trpc/[trpc]`)

| Router | Procedures |
|--------|-----------|
| `workflows` | `create` (mutation), `remove` (mutation), `update` (mutation — saves nodes+edges), `updateName` (mutation), `execute` (mutation — triggers Inngest), `getOne` (query — returns nodes+edges for React Flow), `getMany` (query — paginated list) |
| `credentials` | `create` (mutation — encrypts value), `remove` (mutation), `update` (mutation), `getOne` (query — decrypts for edit), `getMany` (query — paginated), `getByType` (query — for node dialogs), `getInstagram` (query), `disconnectInstagram` (mutation), `getYoutube` (query), `disconnectYoutube` (mutation) |
| `executions` | `getOne` (query), `getMany` (query — paginated) |
| `instagramSettings` | `get` (query), `save` (mutation — upserts) |

### REST API Routes

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/auth/[...all]` | GET, POST | Better Auth handler |
| `/api/auth/instagram` | GET | Initiate Instagram OAuth |
| `/api/auth/instagram/callback` | GET | Instagram OAuth callback → upsert `InstagramCredential` |
| `/api/auth/youtube` | GET | Initiate YouTube (Google) OAuth |
| `/api/auth/youtube/callback` | GET | YouTube OAuth callback → upsert `YoutubeCredential` |
| `/api/inngest` | GET, POST, PUT | Inngest function serve endpoint |
| `/api/webhooks/instagram` | GET (verify), POST (events) | Meta webhook subscription + comment event processing |
| `/api/webhooks/youtube` | GET (verify), POST (events) | PubSubHubbub verification + Atom XML notifications |
| `/api/webhooks/google-form` | POST | Google Form submission → trigger workflow |

---

## 8. Workflow Engine (Inngest)

### Setup

- **Client:** `src/inngest/client.ts` — Inngest instance with `realtimeMiddleware()`
- **Functions:** `src/inngest/functions.ts` — registers `executeWorkflow` on event `workflows/execute.workflow`, plus the pollers and the pruner
- **The run itself:** `src/execution/run-execution.ts` — `runExecution`, the runtime-neutral body `executeWorkflow` calls. Everything between "a run was requested" and "the row says SUCCESS" lives here, with no knowledge of which runtime invoked it; failure is `src/execution/failure.ts`.
- **Serve:** `/api/inngest` — registers the functions with Inngest's HTTP adapter

> ℹ️ The split exists because a self-hosted execution runtime (a Postgres job
> queue + a long-lived worker, in `src/queue/` and `src/worker/`) is being built
> to replace Inngest. The extraction is what lets both execute byte-identical
> runs.
>
> The worker is complete and runnable (`npm run worker:dev`): it claims jobs,
> holds them with a fenced heartbeat, resumes a reclaimed job from its stored
> steps, and shuts down gracefully. **Routing now exists too** —
> `sendWorkflowExecution` (`src/inngest/utils.ts`) reads
> `Workflow.executionRuntime` and sends a run to one runtime or the other.
>
> **Every production run today is still Inngest**, because that column is NULL
> on every workflow and NULL means Inngest. Nothing moves until a row is
> deliberately flipped; see DEPLOYMENT.md's "Moving a workflow between
> runtimes", which also carries the rollback runbook. The worker is not yet
> deployed anywhere — that is the next step.

### Execution Flow

```
Event received → Create Execution (RUNNING)
     → Topological sort workflow nodes
     → For each node (in order):
         → Look up executor from registry
         → Publish "loading" status on node's realtime channel
         → Run executor logic (step.run for durability)
         → Publish "success" or "error" status
         → Pass enriched context to next node
     → Update Execution (SUCCESS + output)
     → On failure: Update Execution (FAILED + error)
```

### Realtime Channels (14)

Each node type has a dedicated Inngest realtime channel for pushing status updates to the browser:

`ai-reply-generator`, `anthropic`, `discord`, `gemini`, `google-form-trigger`, `http-request`, `instagram-comment-trigger`, `instagram-reply-comment`, `manual-trigger`, `openai`, `slack`, `youtube-comment-trigger`, `youtube-reply-comment`

### Retry Policy

- **Production:** 3 retries
- **Development:** 0 retries

---

## 9. Node System — Triggers & Actions

Every node type follows a consistent 4-file pattern:

```
<node-type>/
├── actions.ts    — Server actions (save config, get realtime token)
├── executor.ts   — Inngest executor function (runs during workflow execution)
├── node.tsx      — React Flow visual node component
└── dialog.tsx    — Configuration dialog (form with settings)
```

### Trigger Nodes (start a workflow)

| Node Type | Location | Description | Webhook Source |
|-----------|----------|-------------|----------------|
| `MANUAL_TRIGGER` | `triggers/manual-trigger/` | Click-to-run trigger | None (user-initiated) |
| `GOOGLE_FORM_TRIGGER` | `triggers/google-form-trigger/` | Fires on form submission | `/api/webhooks/google-form` |
| `INSTAGRAM_COMMENT_TRIGGER` | `triggers/instagram-comment-trigger/` | Fires on Instagram comments, filterable by `postId` + `keywordFilter` | `/api/webhooks/instagram` |
| `YOUTUBE_COMMENT_TRIGGER` | `triggers/youtube-comment-trigger/` | Fires on YouTube comments, filterable by `videoId` + `keywordFilter` | `/api/webhooks/youtube` |

### Action Nodes (do something)

| Node Type | Location | Description |
|-----------|----------|-------------|
| `HTTP_REQUEST` | `executions/http-request/` | Generic REST API call |
| `OPENAI` | `executions/openai/` | Generate text with OpenAI API |
| `ANTHROPIC` | `executions/anthropic/` | Generate text with Anthropic/Claude |
| `GEMINI` | `executions/gemini/` | Generate text with Google Gemini |
| `DISCORD` | `executions/discord/` | Send a Discord webhook message |
| `SLACK` | `executions/slack/` | Send a Slack webhook message |
| `INSTAGRAM_REPLY_COMMENT` | `executions/instagram-reply-comment/` | Reply to an Instagram comment via Graph API |
| `YOUTUBE_REPLY_COMMENT` | `executions/youtube-reply-comment/` | Reply to a YouTube comment via YouTube Data API |
| `AI_REPLY_GENERATOR` | `executions/ai-reply-generator/` | Universal AI reply generator with keyword routing, credential fallback (xAI → Gemini → OpenAI), and configurable prompts |

### AI Reply Generator — Special Node

This is the most complex action node. It:
1. Checks if the incoming comment contains a configured **keyword** (case-insensitive)
2. Routes to either `keywordPrompt` or `defaultPrompt` based on match
3. Can silently skip (no AI call, no credits burned) if the matching toggle is OFF
4. Fetches `InstagramSettings` for global AI context (account description, reply tone, reply goal)
5. Tries credentials in order: **xAI → Gemini → OpenAI** (first available wins)
6. Uses Vercel AI SDK's `generateText()` with provider-specific base URLs and models
7. Returns `{ [variableName]: { text: "..." } }` in the workflow context

---

## 10. Feature Inventory

| Feature Folder | Contents |
|----------------|----------|
| `features/auth/` | Login form, register form, auth layout |
| `features/credentials/` | CRUD for API credentials, Instagram/YouTube OAuth sections, encrypted storage |
| `features/editor/` | React Flow canvas, add-node button, editor header, execute workflow button, Jotai atoms |
| `features/executions/` | Execution list/detail views, all action node implementations (9 node types), executor registry, node status hooks |
| `features/instagram-settings/` | Settings form + tRPC router for AI reply context |
| `features/subscriptions/` | `useSubscription` hook — currently a stub (billing removed) |
| `features/triggers/` | Base trigger node component, all trigger node implementations (5 node types) |
| `features/workflows/` | Workflow list/detail views, tRPC router (CRUD + execute) |

---

## 11. Credential / OAuth Integrations

### API Key Credentials (stored encrypted in `Credential` table)

| Type | Display Name | Model Used (if AI) |
|------|-------------|-------------------|
| `OPENAI` | OpenAI | gpt-4o-mini |
| `ANTHROPIC` | Anthropic | claude-3-5-sonnet-20241022 |
| `GEMINI` | Gemini | gemini-2.0-flash |
| `XAI` | xAI (Grok) | grok-3-mini |
| `INSTAGRAM` | Instagram | N/A (stores accessToken + accountId as encrypted JSON) |

### OAuth Integrations (separate credential tables)

| Platform | Table | OAuth Flow | Token Storage |
|----------|-------|-----------|---------------|
| **Instagram** | `InstagramCredential` | Instagram Basic Display → Long-lived token exchange | `encrypt(accessToken)` — single encrypted string |
| **YouTube** | `YoutubeCredential` | Google OAuth 2.0 with `youtube.force-ssl` scope | `encrypt(accessToken)` + `encrypt(refreshToken)` separately |
| **GitHub** | `Account` (Better Auth managed) | Standard GitHub OAuth | Managed by Better Auth |
| **Google** | `Account` (Better Auth managed) | Standard Google OAuth | Managed by Better Auth |

---

## 12. UI & Theming

- **Design system:** shadcn/ui (New York variant) with 50+ Radix UI-based components
- **CSS:** Tailwind CSS v4 (CSS-first config via `globals.css`, no `tailwind.config.js`)
- **Theme:** Dual-mode (light + dark) via `next-themes`, with OS preference detection
  - Light: White/blue palette (`oklch(0.54 0.175 255.3)` primary)
  - Dark: Black/blue palette (`oklch(0.56 0.22 256.5)` primary)
- **Font:** Geist Sans + Geist Mono (Google Fonts)
- **Logo:** Custom SVG at `public/logos/logo.svg`
- **Icons:** Lucide React + custom SVGs per integration (`/logos/instagram.svg`, etc.)
- **Sidebar:** Collapsible, with Workspace nav group (Workflows, Credentials, Settings, Executions) + sign-out
- **Header:** Sidebar trigger, search bar (read-only placeholder), theme toggle, notification bell
- **Toasts:** Sonner
- **Editor Background:** CSS Lines pattern (React Flow Background)

---

## 13. Testing & Linting

| Tool | Config | Status |
|------|--------|--------|
| **Biome** | `biome.json` — formatter + linter | Active; `npm run lint` |
| **Vitest** | `vitest.config.ts` — Node env, `@` alias | Active; `npm test` |
| **TypeScript** | `tsconfig.json` — strict mode | `npx tsc --noEmit` passes cleanly |
| **Test files** | `src/lib/webhook-verify.test.ts` (signature verification for Instagram, Typeform & Telegram) | Only webhook-verify has tests |

---

## 14. Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ENCRYPTION_KEY` | Yes | Cryptr secret for encrypting credentials |
| `NEXT_PUBLIC_APP_URL` | Yes | Public-facing URL |
| `BETTER_AUTH_SECRET` | Yes | Better Auth session signing |
| `BETTER_AUTH_URL` | Yes | Better Auth base URL |
| `GITHUB_CLIENT_ID` / `_SECRET` | No | GitHub OAuth (conditional) |
| `GOOGLE_CLIENT_ID` / `_SECRET` | No | Google OAuth (conditional) |
| `INNGEST_APP_ID` | Yes | Inngest app identifier |
| `INSTAGRAM_APP_ID` / `_SECRET` | No | Instagram OAuth |
| `INSTAGRAM_REDIRECT_URI` | No | Instagram callback URL |
| `INSTAGRAM_VERIFY_TOKEN` | No | Instagram webhook verification token |
| `YOUTUBE_VERIFY_TOKEN` | No | YouTube PubSubHubbub verification |
| `YOUTUBE_CLIENT_ID` / `_SECRET` | No | YouTube/Google OAuth |
| `YOUTUBE_REDIRECT_URI` | No | YouTube callback URL |
| `NGROK_URL` | No | ngrok tunnel for webhook dev |

---

## 15. What Is Complete

These features are fully implemented and type-checked (zero `tsc` errors):

- [x] **Authentication** — Email/password, GitHub, Google OAuth via Better Auth; login/signup pages; session guards on all routes
- [x] **Workflow CRUD** — Create (random slug name), rename, delete, list with search/pagination
- [x] **Visual Workflow Editor** — React Flow canvas with drag-and-drop nodes, edge connections, save/load to DB, topological sort execution
- [x] **Node System** — 15 node types across 5 triggers + 9 actions + INITIAL, each with executor, dialog, visual component, and server actions
- [x] **Execution Engine** — Inngest-powered durable execution with realtime status broadcasting, error handling, retry policy, execution history
- [x] **Credential Management** — Encrypted CRUD for API keys (OpenAI, Anthropic, Gemini, xAI, Instagram), paginated list with search
- [x] **Instagram OAuth** — Full flow: initiation → callback → long-lived token → encrypted storage → connect/disconnect UI
- [x] **YouTube OAuth** — Full flow: initiation → callback → channel info fetch → encrypted storage → connect/disconnect UI
- [x] **Instagram Comment Webhook** — Signature-verified webhook handler with postId/keyword filtering → Inngest workflow trigger
- [x] **YouTube Webhook** — PubSubHubbub verification + Atom XML parsing → Inngest workflow trigger
- [x] **Google Form Webhook** — JSON webhook → workflow trigger
- [x] **Instagram Reply Action** — Handlebars-compiled reply → Graph API POST
- [x] **YouTube Reply Action** — Handlebars-compiled reply → YouTube Data API POST with Bearer auth
- [x] **AI Reply Generator** — Keyword routing, credential fallback (xAI → Gemini → OpenAI), InstagramSettings context, skip logic
- [x] **AI Text Generation** — OpenAI, Anthropic, Gemini nodes with credential selection
- [x] **Discord / Slack Actions** — Webhook message posting
- [x] **HTTP Request Action** — Generic REST calls
- [x] **Instagram Settings** — Per-user AI context (accountDescription, replyTone, replyGoal) with upsert
- [x] **Theme System** — Light/dark/system via next-themes, OS-preference-aware
- [x] **Error Boundaries** — Global, dashboard-level, and per-page error/loading/not-found handling
- [x] **Webhook Security** — HMAC signature verification for Instagram, Typeform, and Telegram, with unit tests
- [x] **Hydration Safety** — SSR-safe hooks (`useIsMobile`, `SidebarMenuSkeleton`)

---

## 16. What Is Partially Implemented

| Item | Status | What's Missing |
|------|--------|----------------|
| **YouTube Comment Trigger (webhook-based)** | ~80% | The webhook handler receives PubSubHubbub Atom XML (new-video notifications), NOT direct comment events. YouTube doesn't push comments via PubSubHubbub. The `commentText`, `commenterName`, and `commentId` fields arrive empty. Real-time comment detection requires **polling** the YouTube Data API's `commentThreads` endpoint, which is not yet implemented. |
| **YouTube Webhook Security** | ~50% | `YOUTUBE_VERIFY_TOKEN` is in `.env.example` but is **not referenced** in the webhook route code. Google PubSubHubbub doesn't use token-based verification (it uses challenge-response), so the env var is unused. However, the route has no HMAC/signature verification — Google PubSubHubbub doesn't sign payloads, so this is partially by design. |
| **Google Form Trigger Webhook** | ~70% | No authentication/signature verification on the webhook endpoint. Anyone who knows the URL + `workflowId` can trigger workflows. Should add a shared secret header check. |
| **Subscriptions / Billing** | Removed | Polar was cleanly removed. `premiumProcedure` is aliased to `protectedProcedure`. `features/subscriptions/hooks/use-subscription.ts` exists as a stub. If billing is needed in the future, a new provider must be integrated. |
| **Search (Header)** | UI only | The header search bar is a `readOnly` `<Input>` — no actual search functionality is wired. |
| **Notifications (Bell icon)** | UI only | The bell icon in the header is a non-functional button. |
| **Instagram Settings scope** | Naming concern | The `/settings` page and `InstagramSettings` model are specifically for Instagram AI context, but the page title / sidebar says "Settings" generically. If YouTube or other platform settings are added, the model and page should be generalized. |

---

## 17. What Is Missing / Needs Work

| Priority | Item | Details |
|----------|------|---------|
| **HIGH** | **YouTube comment polling** | PubSubHubbub only notifies about new videos, not comments. Need a polling mechanism (Inngest cron function) that periodically fetches `commentThreads` for monitored videos and triggers workflows for new comments. |
| **HIGH** | **Git repository** | The project is NOT a git repo. Should `git init`, create `.gitignore` (already exists), and make initial commit. |
| **HIGH** | **YouTube token refresh** | YouTube access tokens expire (1 hour). The refresh token is stored but there's no automatic refresh logic. When the access token expires, YouTube API calls will fail with 401. Need a `refreshYoutubeToken()` utility. |
| **MEDIUM** | **Instagram token refresh** | Long-lived Instagram tokens expire in 60 days. No automatic refresh or expiry warning is implemented. |
| **MEDIUM** | **Google Form webhook security** | No shared-secret verification. Add a `?secret=...` query param check or header-based auth. |
| **MEDIUM** | **Rate limiting** | No rate limiting on any API route or webhook endpoint. |
| **MEDIUM** | **Execution cleanup** | No mechanism to prune old execution records. Consider a cron job or TTL. |
| **LOW** | **Real search** | Header search bar is non-functional. Wire to existing `search` params on workflows/credentials/executions queries. |
| **LOW** | **Notifications** | Bell icon is purely decorative. Could integrate with execution failures or webhook errors. |
| **LOW** | **YouTube Settings** | Currently, AI Reply Generator pulls context from `InstagramSettings` regardless of platform. Should generalize to a platform-agnostic `AiReplySettings` or add `YoutubeSettings`. |
| **LOW** | **Test coverage** | Only `webhook-verify.ts` has tests. No integration tests, no component tests, no executor tests. |
| **LOW** | **Workspace concept** | Sidebar shows "Automation Hub" as a static workspace name. Multi-workspace support is not implemented. |
| **LOW** | **Node deletion** | Users can remove nodes from the canvas, but there's no undo. |

---

## 18. Dev Workflow & Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start Next.js dev server (Turbopack) |
| `npm run dev:all` | Start Next.js + Inngest + ngrok via mprocs |
| `npm run build` | Production build (Turbopack) |
| `npm run start` | Start production server |
| `npm run lint` | Biome check |
| `npm run format` | Biome format (auto-fix) |
| `npm test` | Vitest run (single pass) |
| `npm run test:watch` | Vitest watch mode |
| `npx prisma migrate dev` | Apply DB migrations |
| `npx prisma generate` | Regenerate Prisma client |
| `npx prisma studio` | Open Prisma Studio (DB GUI) |
| `npx tsc --noEmit` | Type-check without building |

### Local Development Setup

1. Copy `.env.example` → `.env` and fill in values
2. `npm install`
3. `npx prisma migrate dev` (requires running PostgreSQL)
4. `npm run dev:all` (starts Next.js + Inngest dev server + ngrok for webhooks)

---

## 19. Directory Structure

```
guideboard/
├── prisma/
│   ├── schema.prisma              # 12 models, 3 enums
│   └── migrations/                # SQL migration history
├── public/
│   └── logos/                     # SVG logos (13 files)
├── src/
│   ├── app/
│   │   ├── layout.tsx             # Root layout (providers)
│   │   ├── globals.css            # Tailwind v4 theme
│   │   ├── error.tsx              # Global error boundary
│   │   ├── not-found.tsx          # 404 page
│   │   ├── (auth)/                # Login, Signup
│   │   ├── (dashboard)/
│   │   │   ├── (rest)/            # Workflows, Credentials, Executions, Settings
│   │   │   └── (editor)/          # Workflow editor (React Flow)
│   │   └── api/
│   │       ├── auth/              # Better Auth + Instagram/YouTube OAuth
│   │       ├── inngest/           # Inngest serve endpoint
│   │       ├── trpc/              # tRPC adapter
│   │       └── webhooks/          # Instagram, YouTube, Google Form
│   ├── components/
│   │   ├── ui/                    # 50+ shadcn/ui components
│   │   ├── react-flow/            # Base node/handle components
│   │   ├── app-sidebar.tsx        # Main navigation
│   │   ├── app-header.tsx         # Top bar
│   │   ├── node-selector.tsx      # Add-node sheet
│   │   ├── theme-provider.tsx     # next-themes wrapper
│   │   └── theme-toggle.tsx       # Light/Dark/System toggle
│   ├── config/
│   │   ├── constants.ts           # Pagination defaults
│   │   └── node-components.ts     # NodeType → React component map
│   ├── features/
│   │   ├── auth/                  # Auth UI components
│   │   ├── credentials/           # CRUD + OAuth sections
│   │   ├── editor/                # React Flow canvas + controls
│   │   ├── executions/            # Execution views + 9 action nodes
│   │   ├── instagram-settings/    # AI reply context config
│   │   ├── subscriptions/         # Stub (billing removed)
│   │   ├── triggers/              # 5 trigger node types
│   │   └── workflows/             # Workflow CRUD views
│   ├── generated/prisma/          # Auto-generated Prisma client
│   ├── hooks/                     # useIsMobile, useEntitySearch, useUpgradeModal
│   ├── execution/                 # Runtime-neutral run body (see §8)
│   │   ├── run-execution.ts       # runExecution — items 1-6 of a run
│   │   ├── failure.ts             # settleFailedExecution + the alert email
│   │   ├── fan-out-dispatch.ts    # fan-out dispatcher + chain advance
│   │   ├── node-recorder.ts       # Prisma-backed NodeExecution recorder
│   │   ├── topological-sort.ts    # topologicalSort
│   │   ├── passthrough-step.ts    # the non-memoizing ExecutorStep shim
│   │   └── payload.ts             # WorkflowExecutionPayload
│   ├── inngest/
│   │   ├── client.ts              # Inngest instance
│   │   ├── functions.ts           # executeWorkflow + pollers + pruner
│   │   ├── run-workflow.ts        # the node-execution engine
│   │   ├── utils.ts               # sendWorkflowExecution
│   │   └── channels/              # 14 realtime channel definitions
│   ├── queue/                     # Postgres job queue (built, not wired)
│   │   ├── jobs.ts                # enqueue/claim/heartbeat/complete/fail/reclaim
│   │   ├── step-store.ts          # StepResult — the durable-step guarantee
│   │   └── metrics.ts             # queue depth, oldest-claimable age, fences
│   ├── worker/                    # Self-hosted worker process (not wired)
│   │   ├── main.ts                # boot, claim loop, reaper, shutdown
│   │   ├── run-job.ts             # one job: heartbeat, fence, failure triage
│   │   ├── config.ts              # worker id, concurrency, its own boot check
│   │   ├── db.ts                  # the separate control-plane Prisma pool
│   │   ├── worker-step.ts         # createWorkerStep — the ExecutorStep impl
│   │   └── fenced-error.ts        # FencedError + its four reasons
│   ├── lib/
│   │   ├── auth.ts                # Better Auth server config
│   │   ├── auth-client.ts         # Better Auth React client
│   │   ├── auth-utils.ts          # requireAuth / requireUnauth
│   │   ├── db.ts                  # Prisma singleton
│   │   ├── encryption.ts          # encrypt / decrypt (Cryptr)
│   │   ├── utils.ts               # cn() helper (clsx + tailwind-merge)
│   │   ├── webhook-verify.ts      # HMAC verification (Instagram, Typeform, Telegram)
│   │   └── webhook-verify.test.ts # Vitest unit tests
│   └── trpc/
│       ├── client.tsx             # React tRPC client + QueryClient
│       ├── init.ts                # tRPC server setup + procedures
│       ├── query-client.ts        # TanStack Query client factory
│       ├── server.tsx             # Server-side tRPC caller + HydrateClient
│       └── routers/_app.ts        # Root router (4 sub-routers)
├── biome.json
├── components.json                # shadcn/ui config
├── mprocs.yaml                    # Multi-process dev runner
├── next.config.ts
├── package.json
├── postcss.config.mjs
├── tsconfig.json
├── vitest.config.ts
├── .env.example
└── .gitignore
```

---

## 20. Dependency List

### Runtime Dependencies (52 packages)

| Package | Version | Purpose |
|---------|---------|---------|
| `@ai-sdk/anthropic` | ^2.0.23 | Anthropic Claude provider |
| `@ai-sdk/google` | ^2.0.17 | Google Gemini provider |
| `@ai-sdk/openai` | ^2.0.44 | OpenAI / xAI provider |
| `@hookform/resolvers` | ^5.2.2 | Zod resolver for react-hook-form |
| `@inngest/realtime` | ^0.4.4 | Inngest realtime channels |
| `@paralleldrive/cuid2` | ^2.2.2 | CUID2 ID generation |
| `@prisma/client` | ^6.16.3 | Database ORM client |
| `@radix-ui/*` | Various | UI primitives (20+ packages) |
| `@tanstack/react-query` | ^5.90.2 | Server state management |
| `@trpc/client` | ^11.6.0 | tRPC client |
| `@trpc/server` | ^11.6.0 | tRPC server |
| `@trpc/tanstack-react-query` | ^11.6.0 | tRPC + React Query integration |
| `@xyflow/react` | ^12.8.6 | React Flow (visual workflow canvas) |
| `ai` | ^5.0.60 | Vercel AI SDK core |
| `better-auth` | ^1.3.26 | Authentication library |
| `class-variance-authority` | ^0.7.1 | Variant-based class management |
| `client-only` | ^0.0.1 | Client-only import marker |
| `clsx` | ^2.1.1 | Conditional class joining |
| `cmdk` | ^1.1.1 | Command palette component |
| `cryptr` | ^6.4.0 | AES-256-CTR encryption |
| `date-fns` | ^4.1.0 | Date utilities |
| `embla-carousel-react` | ^8.6.0 | Carousel component |
| `handlebars` | ^4.7.8 | Template engine for dynamic messages |
| `html-entities` | ^2.6.0 | HTML entity decode (for Handlebars output) |
| `inngest` | ^3.44.1 | Durable function execution |
| `input-otp` | ^1.4.2 | OTP input component |
| `jotai` | ^2.15.0 | Atomic state management |
| `ky` | ^1.12.0 | HTTP client |
| `lucide-react` | ^0.544.0 | Icon library |
| `next` | 15.5.4 | React framework |
| `next-themes` | ^0.4.6 | Theme management |
| `nuqs` | ^2.7.1 | URL search params state |
| `random-word-slugs` | ^0.1.7 | Random name generation for workflows |
| `react` | 19.1.0 | UI library |
| `react-day-picker` | ^9.11.0 | Date picker |
| `react-dom` | 19.1.0 | React DOM renderer |
| `react-error-boundary` | ^6.0.0 | Error boundary components |
| `react-hook-form` | ^7.64.0 | Form management |
| `react-resizable-panels` | ^3.0.6 | Resizable panel layouts |
| `recharts` | ^2.15.4 | Chart components |
| `server-only` | ^0.0.1 | Server-only import marker |
| `sonner` | ^2.0.7 | Toast notifications |
| `superjson` | ^2.2.2 | JSON serialization for tRPC |
| `tailwind-merge` | ^3.3.1 | Tailwind class deduplication |
| `toposort` | ^2.0.2 | Topological sort (workflow node ordering) |
| `vaul` | ^1.1.2 | Drawer component |
| `zod` | ^4.1.11 | Schema validation |

### Dev Dependencies (14 packages)

| Package | Version | Purpose |
|---------|---------|---------|
| `@biomejs/biome` | 2.2.0 | Linter + formatter |
| `@tailwindcss/postcss` | ^4 | Tailwind PostCSS plugin |
| `@types/node` | ^20 | Node.js types |
| `@types/react` | ^19 | React types |
| `@types/react-dom` | ^19 | React DOM types |
| `@types/toposort` | ^2.0.7 | Toposort types |
| `dotenv-cli` | ^10.0.0 | Load .env for CLI commands |
| `inngest-cli` | ^1.12.1 | Inngest dev server |
| `mprocs` | ^0.7.3 | Multi-process runner |
| `prisma` | ^6.16.3 | Prisma CLI |
| `tailwindcss` | ^4 | CSS framework |
| `tsx` | ^4.20.6 | TypeScript execution |
| `tw-animate-css` | ^1.4.0 | Tailwind animation utilities |
| `typescript` | ^5 | TypeScript compiler |
| `vitest` | ^3.2.4 | Test runner |

---

*End of report. All information is derived directly from the codebase as of March 30, 2026.*
