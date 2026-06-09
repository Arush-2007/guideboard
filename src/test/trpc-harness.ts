import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import prisma from "@/lib/db";
import { createCallerFactory } from "@/trpc/init";
import { appRouter } from "@/trpc/routers/_app";

/**
 * Shared helpers for tRPC integration tests that run against the Postgres
 * container provisioned by `src/test/integration-setup.ts`.
 *
 * Auth is mocked per test file (see the `vi.mock("@/lib/auth")` blocks in the
 * `*.integration.test.ts` files); these helpers only deal with the database
 * and the caller, which are independent of how the session is faked.
 */

export function createCaller() {
  return createCallerFactory(appRouter)({});
}

export type TestCaller = ReturnType<typeof createCaller>;

export async function createTestUser() {
  const id = randomUUID();
  return prisma.user.create({
    data: {
      id,
      name: "Test User",
      email: `${id}@example.com`,
      emailVerified: true,
    },
  });
}

/**
 * Deleting users cascades to workflows, nodes, connections, poll rows and
 * conversations (see `onDelete: Cascade` in the schema), so this fully resets
 * the tables these tests touch.
 */
export async function cleanupDb() {
  await prisma.user.deleteMany({});
}

type AnthropicCall = { url: string; body: unknown };

/**
 * Replaces `global.fetch` with a stub that answers the Anthropic Messages API
 * with `text` as the single content block. Returns the captured calls so tests
 * can assert what was sent. Restore with `vi.unstubAllGlobals()`.
 */
export function mockAnthropic(text: string): AnthropicCall[] {
  const calls: AnthropicCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text }] }),
        text: async () => text,
      } as Response;
    }),
  );
  return calls;
}
