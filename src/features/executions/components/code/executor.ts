import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { runUserCode, SandboxError } from "@/lib/js-sandbox";

type CodeData = {
  code?: string;
};

type CodeOutput = {
  /**
   * Whatever the user's code returned, round-tripped through JSON. Referenced
   * downstream as `@<CODE_1.result>@` for the whole value, or `.result.<field>`
   * for a nested one.
   */
  result: unknown;
};

export const codeExecutor: NodeExecutor<CodeData> = async ({
  data,
  nodeId,
  outputKey,
  userId,
  context,
  publish,
}) => {
  await publish(
    nodeStatusChannel(userId).status({ nodeId, status: "loading" }),
  );

  try {
    const config = parseNodeConfig(NodeType.CODE, data) as CodeData;
    const code = config.code ?? "";

    // The whole workflow context is the node's `input`. Deliberately NOT
    // templated through `renderTemplate` first: the code is real JavaScript, so
    // a `@<...>@` pass would let an upstream string VALUE rewrite the program's
    // STRUCTURE (the same injection the Calculator guards against). Instead the
    // context crosses the sandbox boundary as data — `input` — and the user
    // reads it with ordinary property access.
    const result = await runUserCode(code, context);

    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "success" }),
    );

    return {
      ...context,
      [outputKey]: { result } satisfies CodeOutput,
    };
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );

    if (error instanceof NonRetriableError) throw error;

    // A SandboxError is a user-code failure (syntax, a thrown exception, a
    // timeout, unserialisable data) — deterministic given the same code and
    // input, with no side effect and no network call, so a retry would fail
    // identically. Surface its already-friendly message as non-retriable.
    if (error instanceof SandboxError) {
      throw new NonRetriableError(`Code: ${error.message}`);
    }
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Code failed to run",
    );
  }
};
