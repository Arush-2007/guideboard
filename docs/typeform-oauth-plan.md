# Next-session plan: Typeform OAuth2 ("Connect Typeform" one-click)

> Hand-off from the session that built the **generic, auto-wiring Typeform trigger on a Personal Access Token (PAT)**. That work was deliberately architected so OAuth swaps in with minimal change. This doc is the plan to do that swap. Branch context: `Refining_Execution_Page`. Related memory: `hr-recruitment-workflow.md`.

## Goal
Replace "paste a Personal Access Token" with a one-click **Connect Typeform** OAuth2 flow (like the existing Instagram/YouTube/Google connects), so non-technical users never generate or paste a token. Everything else about the node stays as-is.

## The key fact that makes this small
The PAT build put **all Typeform auth behind one seam**: `getTypeformToken(credentialId, userId)` in `src/features/credentials/server/routers.ts`. The three procedures (`getTypeforms`, `getTypeformFields`, `registerTypeformWebhook`) and the trigger executor only ever ask that helper for a token. **OAuth changes that helper (and how the token is stored/obtained) — not the procedures, the dialog, the webhook handler, or the executor.** So ~80% of the node is already done.

## Reuse the existing platform-OAuth pattern (do NOT invent a new one)
This codebase already does third-party OAuth with refresh for Google, Instagram, and YouTube. Mirror it exactly:
- **Dedicated token table + refresh helper**, like `GoogleCredential` + `src/lib/google-token.ts` (`refreshGoogleTokenIfNeeded`) and `src/lib/youtube-token.ts`. Create `TypeformCredential` (userId, accessToken, refreshToken, expiresAt, scopes — encrypted via `src/lib/encryption.ts`) + `src/lib/typeform-token.ts` exporting `refreshTypeformTokenIfNeeded(userId)`.
- **Connect / callback / disconnect** flow, like the Instagram/YouTube connect buttons and `credentials.getInstagram`/`disconnectInstagram` (`src/features/credentials/server/routers.ts`) + their settings UI. Add a "Connect Typeform" button and a `disconnectTypeform`.

## Build steps
1. **Typeform OAuth app** (you, in Typeform admin → Developer apps): create an app, get `client_id` + `client_secret`, set the redirect URI to `${APP_URL}/api/oauth/typeform/callback`. Add `TYPEFORM_CLIENT_ID` / `TYPEFORM_CLIENT_SECRET` to `.env` (+ `.env.example`).
   - **Verify against current Typeform OAuth docs** (don't assume): exact authorize URL (`https://admin.typeform.com/oauth/authorize`) vs token URL (`https://api.typeform.com/oauth/token`); exact scope names (need at least `forms:read`, `webhooks:read`, `webhooks:write`); and whether a refresh token requires an extra scope (e.g. `offline`) or is returned by default. Public distribution may require Typeform **app review** — fine for dev with your own app.
2. **Prisma:** add `model TypeformCredential` (mirror `GoogleCredential`). `npx prisma migrate dev`. (Windows: stop `dev:all` first so `prisma generate` can swap the query-engine DLL — the recurring EPERM.)
3. **OAuth routes** under `src/app/api/oauth/typeform/`:
   - `start` (or a server action): redirect to Typeform authorize with `state` (CSRF) + redirect_uri.
   - `callback/route.ts`: exchange `code` → tokens at the token URL; upsert `TypeformCredential` (encrypt tokens); redirect back to credentials/settings.
4. **`src/lib/typeform-token.ts`:** `refreshTypeformTokenIfNeeded(userId)` — return a valid access token, refreshing via the token URL when expired (copy the structure of `refreshGoogleTokenIfNeeded`).
5. **Swap the seam:** change `getTypeformToken(credentialId, userId)` → resolve the user's `TypeformCredential` and call `refreshTypeformTokenIfNeeded`. (Decide: keep `credentialId` param for signature stability, or switch the 3 procedures to look up by `userId` like the Google ones. The Google form procedures use `userId` only — simplest to match that. The dialog would then drop the credential dropdown in favor of a "Connect Typeform" state, mirroring how Google forms needs no credential picker.)
6. **Dialog update** (`src/features/triggers/components/typeform-trigger/dialog.tsx`): replace the credential `<Select>` with a "Connect Typeform" button + connected state (mirror the Instagram/YouTube settings UI). The form dropdown + Load fields + Activate webhook stay unchanged.
7. **Migration/compat:** keep PAT (`CredentialType.TYPEFORM`) working as a fallback, or write a one-time note that existing PAT users reconnect. Don't silently break saved PAT credentials.

## Carryover cleanups (cheap, do alongside)
- **Delete the orphan webhook** `phoenix:...` (no `workflowId`) left on forms from old manual testing.
- **Webhook lifecycle:** delete the `guideboard-{workflowId}` webhook when the node is removed or the form changes (currently only created, never cleaned up). Typeform: `DELETE /forms/{id}/webhooks/{tag}`.
- **Per-webhook secret** instead of the shared `TYPEFORM_WEBHOOK_SECRET` (store a generated secret per registration; verify against it) — real multi-tenant hardening.

## Verification
1. Stop/restart `dev:all`; browse localhost.
2. Click **Connect Typeform** → authorize → redirected back, `TypeformCredential` row created.
3. Open the Typeform node → form dropdown populates (now via the OAuth token) → Load fields → Activate webhook → confirm via `GET /forms/{id}/webhooks` (use the diagnostic from the PAT session).
4. Submit a real response → workflow runs. Token refresh: artificially expire `expiresAt`, trigger a procedure, confirm it refreshes transparently.
5. `npx tsc --noEmit` clean, `npx biome check` clean on changed files, `npx vitest run src/lib` green.

## Out of scope
Per-form OAuth scoping; Typeform app public review (external process); changing the webhook handler or signature verification.
