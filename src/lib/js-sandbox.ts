import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSRuntime,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten";

/**
 * Runs a snippet of USER-authored JavaScript in a QuickJS WebAssembly isolate —
 * a real security boundary, not Node's `vm` (which is trivially escapable).
 *
 * The isolate is a bare ECMAScript engine: no `require`, no `fetch`, no `fs`, no
 * `process`, no timers, no access to the host heap. The only thing that crosses
 * the boundary IN is `input` (the workflow context, injected as a JSON literal),
 * and the only thing that crosses OUT is the code's return value, serialised to
 * JSON. Nothing the user writes can touch the server it runs on.
 *
 * This is the single entry point for executing user JS anywhere in the app; the
 * Code node's executor is its only caller today. Keep all sandbox policy (limits,
 * marshalling, wrapping) here so there is exactly one hardened surface.
 */

/** Wall-clock budget. Past this the interpreter is interrupted mid-instruction. */
const DEFAULT_TIMEOUT_MS = 1_000;

/**
 * Heap ceiling for the isolate. Generous enough for ordinary data reshaping,
 * low enough that a runaway allocation (`[].fill(0, 0, 1e9)`) fails fast with a
 * clean out-of-memory rather than pressuring the host process.
 */
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;

/** Caps recursion depth so a `function f(){ return f() }` throws instead of hanging. */
const MAX_STACK_SIZE_BYTES = 1024 * 1024;

/**
 * A failure that originates from the user's code or its inputs — a syntax error,
 * a thrown exception, a timeout, non-serialisable input/output. Deterministic
 * given the same code and context, so the executor rethrows it as a
 * `NonRetriableError`: it will fail identically on retry.
 */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

export type RunUserCodeOptions = {
  /** Wall-clock budget in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
};

// Line/paragraph separators (U+2028/U+2029) are legal inside JSON strings but
// were line terminators in pre-ES2019 source. QuickJS is modern, but escaping
// them keeps the injected `input` literal robust regardless of engine quirks.
// Built via char codes so no literal separator ever sits in this source file —
// the editing tools here rewrite a literal U+2028/U+2029 escape into the raw
// character, which then IS the fragility this escaping guards against.
const JS_LINE_SEPARATORS = new RegExp(
  `[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  "g",
);

function escapeForJsLiteral(json: string): string {
  return json.replace(JS_LINE_SEPARATORS, (char) =>
    char.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029",
  );
}

/**
 * Serialises the workflow context for injection. `JSON.stringify` drops
 * `undefined`/functions and throws on cycles or `BigInt`; a context that can't
 * cross the boundary is a config-shaped failure the user must fix, so it surfaces
 * as a {@link SandboxError} rather than a raw throw.
 */
function serialiseInput(context: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(context);
  } catch (error) {
    throw new SandboxError(
      `The data coming into this step can't be read by code (${
        error instanceof Error ? error.message : "not serialisable"
      }).`,
    );
  }
  // `JSON.stringify` returns `undefined` (not the string "null") for a value it
  // can't represent at the top level — an `undefined`/function/symbol context —
  // so fall back to "null" for those. `input` is then simply `null`.
  return escapeForJsLiteral(json ?? "null");
}

/**
 * The user writes a function BODY (statements ending in `return`), not an
 * expression — matching how n8n's Code node and every "return a value" editor
 * behaves. We wrap it so `return` is legal, call it with `input`, and marshal the
 * result out as a JSON string. `"use strict"` is on so silent globals throw.
 *
 * A returned `undefined` (or a value `JSON.stringify` can't represent, e.g. a
 * function) becomes `null` rather than crashing the marshal step — the node
 * simply produced no data.
 */
function buildProgram(userCode: string, inputLiteral: string): string {
  return `(function () {
  "use strict";
  var input = (${inputLiteral});
  var __out = (function (input) {
${userCode}
  })(input);
  var __json = JSON.stringify(__out);
  return __json === undefined ? "null" : __json;
})()`;
}

/** Best-effort dispose so a thrown error mid-run never leaks the isolate. */
function disposeQuietly(vm: QuickJSContext, runtime: QuickJSRuntime): void {
  try {
    vm.dispose();
  } catch {}
  try {
    runtime.dispose();
  } catch {}
}

/**
 * Turns a dumped QuickJS error into a single human line. User throws surface as
 * `{ name, message }`; a bare thrown string (or number) dumps as itself.
 */
function describeThrown(detail: unknown): string {
  if (detail && typeof detail === "object") {
    const { name, message } = detail as { name?: unknown; message?: unknown };
    const text = typeof message === "string" ? message : "";
    const label = typeof name === "string" && name ? name : "Error";
    return text ? `${label}: ${text}` : label;
  }
  return typeof detail === "string" && detail
    ? detail
    : "Your code threw an error.";
}

/**
 * Executes `userCode` against `context` inside the isolate and returns whatever
 * it produced, already round-tripped through JSON (so the value handed back is
 * plain data safe to write into the workflow context).
 *
 * @throws {SandboxError} for any user-caused failure — syntax error, thrown
 *   exception, timeout, or non-serialisable input/output — each with a message
 *   fit to show a non-technical user.
 */
export async function runUserCode(
  userCode: string,
  context: unknown,
  options: RunUserCodeOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inputLiteral = serialiseInput(context);

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(MAX_STACK_SIZE_BYTES);

  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));

  const vm = runtime.newContext();

  try {
    const program = buildProgram(userCode, inputLiteral);
    const result = vm.evalCode(program);

    if (result.error) {
      const detail = vm.dump(result.error) as unknown;
      result.error.dispose();

      // The interrupt handler fires past the deadline; QuickJS reports it as an
      // InternalError whose message mentions "interrupted". Translate it into a
      // sentence a user can act on rather than an engine-internal one.
      if (Date.now() >= deadline) {
        throw new SandboxError(
          `Your code ran longer than ${timeoutMs}ms and was stopped. Check for an infinite loop.`,
        );
      }

      throw new SandboxError(describeThrown(detail));
    }

    const json = vm.getString(result.value);
    result.value.dispose();

    try {
      return JSON.parse(json);
    } catch {
      // buildProgram only ever returns a JSON string or "null", so this is not
      // reachable from user code — but parsing defensively beats trusting it.
      throw new SandboxError(
        "Your code returned a value that couldn't be read.",
      );
    }
  } finally {
    disposeQuietly(vm, runtime);
  }
}
