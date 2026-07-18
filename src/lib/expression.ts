/**
 * A small, self-contained arithmetic evaluator — the engine behind the
 * Calculator node.
 *
 * **Keep this module dependency-free.** The Calculator dialog imports it to
 * preview a result as the user types, so it runs in the BROWSER. It must never
 * reach for `templating.ts` (which pulls in Handlebars) or anything server-side;
 * `node-schemas.ts` documents the same constraint where it imports
 * `http-budget` rather than `http`. Resolving `@<path>@` references to numbers
 * happens one layer up, in the executor, before the expression gets here.
 *
 * Grammar (recursive descent, standard precedence):
 *
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/' | '%') unary)*
 *   unary      := ('+' | '-') unary | primary
 *   primary    := NUMBER | '(' expression ')' | FUNC '(' expression (',' expression)? ')'
 *   FUNC       := round | floor | ceil | abs
 *
 * `%` is MODULO (the remainder operator, as in code) — not a percentage. So
 * `10 % 3` is `1`, and a percentage is written the long way, `price * 18 / 100`.
 */

/** A malformed or unevaluable expression. Carries a user-facing message. */
export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

/**
 * Significant digits kept in the final result. Binary floating point cannot
 * represent 0.1 or 0.2 exactly, so `0.1 + 0.2` lands on 0.30000000000000004;
 * rounding the result absorbs that so the calculator prints `0.3` like every
 * calculator a user has ever held.
 *
 * 15 is the highest value that still does this, and it must not be lowered.
 * A double carries ~15-17 significant digits, and the noise always appears in
 * the last 1-2 — so 15 removes it while leaving every 15-digit integer intact.
 * This was 12, which silently corrupted large values: `1234567890123 + 1`
 * returned 1234567890120, and `999999999999999` became 1000000000000000. No
 * error, just a wrong total — the worst possible failure for a calculator.
 */
const SIGNIFICANT_DIGITS = 15;

/**
 * Multiplies `value` by 10^exp by rewriting its DECIMAL exponent rather than
 * doing the arithmetic, which is what makes `roundTo` exact.
 *
 * Splitting on "e" first means a value already in exponential form (`1e-7`)
 * shifts correctly instead of producing the nonsense string `1e-7e2`.
 */
function shiftExponent(value: number, exp: number): number {
  const [mantissa, currentExp] = value.toString().split("e");
  return Number(`${mantissa}e${(currentExp ? Number(currentExp) : 0) + exp}`);
}

type UnaryFn = (value: number) => number;

/** Single-argument functions. `round` is handled separately — it takes two. */
const UNARY_FUNCTIONS: Record<string, UnaryFn> = {
  floor: Math.floor,
  ceil: Math.ceil,
  abs: Math.abs,
};

/** Every name `primary` will accept before a `(`. */
const FUNCTION_NAMES = new Set([...Object.keys(UNARY_FUNCTIONS), "round"]);

type TokenType =
  | "number"
  | "operator"
  | "lparen"
  | "rparen"
  | "comma"
  | "function";

type Token = {
  type: TokenType;
  value: string;
  /** Index into the ORIGINAL string, so error messages can point at it. */
  pos: number;
};

/**
 * The keypad prints typographic glyphs (`×`, `÷`, `−`) because that is what a
 * calculator looks like, but the parser only speaks ASCII. Users also paste
 * expressions containing en/em dashes. Normalise all of it up front.
 */
const GLYPH_REPLACEMENTS: Record<string, string> = {
  "×": "*", // × multiplication sign
  "÷": "/", // ÷ division sign
  "−": "-", // − minus sign
  "–": "-", // – en dash
  "—": "-", // — em dash
};

const isDigit = (char: string) => char >= "0" && char <= "9";
const isLetter = (char: string) =>
  (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const raw = input[i];

    if (raw === " " || raw === "\t" || raw === "\n" || raw === "\r") {
      i += 1;
      continue;
    }

    const char = GLYPH_REPLACEMENTS[raw] ?? raw;

    if (isDigit(char) || char === ".") {
      const start = i;
      let seenDot = false;
      while (i < input.length && (isDigit(input[i]) || input[i] === ".")) {
        if (input[i] === ".") {
          if (seenDot) {
            throw new ExpressionError(
              `That number has more than one decimal point (position ${i + 1}).`,
            );
          }
          seenDot = true;
        }
        i += 1;
      }
      const value = input.slice(start, i);
      // "." on its own is a lone decimal point, not a number.
      if (value === ".") {
        throw new ExpressionError(
          `There's a stray decimal point at position ${start + 1}.`,
        );
      }
      tokens.push({ type: "number", value, pos: start });
      continue;
    }

    if (isLetter(char)) {
      const start = i;
      while (i < input.length && isLetter(input[i])) i += 1;
      const name = input.slice(start, i).toLowerCase();
      if (!FUNCTION_NAMES.has(name)) {
        throw new ExpressionError(
          `"${input.slice(start, i)}" isn't something this calculator knows. Available: ${[
            ...FUNCTION_NAMES,
          ]
            .sort()
            .join(", ")}.`,
        );
      }
      tokens.push({ type: "function", value: name, pos: start });
      continue;
    }

    if (
      char === "+" ||
      char === "-" ||
      char === "*" ||
      char === "/" ||
      char === "%"
    ) {
      tokens.push({ type: "operator", value: char, pos: i });
      i += 1;
      continue;
    }

    if (char === "(") {
      tokens.push({ type: "lparen", value: char, pos: i });
      i += 1;
      continue;
    }

    if (char === ")") {
      tokens.push({ type: "rparen", value: char, pos: i });
      i += 1;
      continue;
    }

    if (char === ",") {
      tokens.push({ type: "comma", value: char, pos: i });
      i += 1;
      continue;
    }

    throw new ExpressionError(
      `"${raw}" isn't something this calculator can use (position ${i + 1}).`,
    );
  }

  return tokens;
}

/**
 * Recursive-descent parser that evaluates as it goes. There is no separate AST
 * step — the expressions are small and single-use, so building one would buy
 * nothing.
 */
class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token | undefined {
    return this.tokens[this.index++];
  }

  private expect(type: TokenType, description: string): Token {
    const token = this.peek();
    if (!token || token.type !== type) {
      throw new ExpressionError(`Expected ${description}.`);
    }
    this.index += 1;
    return token;
  }

  /** Entry point: parse a whole expression and assert nothing is left over. */
  parse(): number {
    const value = this.parseExpression();
    const leftover = this.peek();
    if (leftover) {
      if (leftover.type === "rparen") {
        throw new ExpressionError(
          "There's a closing bracket with no opening bracket to match it.",
        );
      }
      throw new ExpressionError(
        `Unexpected "${leftover.value}" at position ${leftover.pos + 1}.`,
      );
    }
    return value;
  }

  private parseExpression(): number {
    let left = this.parseTerm();
    for (;;) {
      const token = this.peek();
      if (
        !token ||
        token.type !== "operator" ||
        (token.value !== "+" && token.value !== "-")
      ) {
        return left;
      }
      this.index += 1;
      const right = this.parseTerm();
      left = token.value === "+" ? left + right : left - right;
    }
  }

  private parseTerm(): number {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (
        !token ||
        token.type !== "operator" ||
        (token.value !== "*" && token.value !== "/" && token.value !== "%")
      ) {
        return left;
      }
      this.index += 1;
      const right = this.parseUnary();

      if (token.value === "*") {
        left *= right;
        continue;
      }
      // Division and modulo by zero yield Infinity/NaN in JS rather than
      // throwing. Neither is a meaningful answer to give a user, and letting
      // NaN propagate would surface as a confusing "not a finite number" at the
      // very end, pointing nowhere. Fail here, where we know the cause.
      if (right === 0) {
        throw new ExpressionError(
          token.value === "/"
            ? "Can't divide by zero."
            : "Can't take a remainder with zero.",
        );
      }
      left = token.value === "/" ? left / right : left % right;
    }
  }

  private parseUnary(): number {
    const token = this.peek();
    if (
      token &&
      token.type === "operator" &&
      (token.value === "+" || token.value === "-")
    ) {
      this.index += 1;
      const value = this.parseUnary();
      return token.value === "-" ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.next();

    if (!token) {
      throw new ExpressionError("The expression ends unexpectedly.");
    }

    if (token.type === "number") {
      return Number(token.value);
    }

    if (token.type === "lparen") {
      const value = this.parseExpression();
      if (!this.peek()) {
        throw new ExpressionError("There's an unclosed bracket.");
      }
      this.expect("rparen", "a closing bracket");
      return value;
    }

    if (token.type === "function") {
      this.expect("lparen", `an opening bracket after ${token.value}`);
      const first = this.parseExpression();

      let second: number | undefined;
      if (this.peek()?.type === "comma") {
        this.index += 1;
        second = this.parseExpression();
      }

      if (!this.peek()) {
        throw new ExpressionError(`${token.value}( is never closed.`);
      }
      this.expect("rparen", `a closing bracket after ${token.value}(`);

      return applyFunction(token.value, first, second);
    }

    if (token.type === "operator") {
      throw new ExpressionError(
        `"${token.value}" at position ${token.pos + 1} is missing a number to work on.`,
      );
    }

    throw new ExpressionError(
      `Unexpected "${token.value}" at position ${token.pos + 1}.`,
    );
  }
}

function applyFunction(
  name: string,
  first: number,
  second: number | undefined,
): number {
  if (name === "round") {
    if (second === undefined) return Math.round(first);
    if (!Number.isInteger(second) || second < 0 || second > 100) {
      throw new ExpressionError(
        "round()'s second argument is how many decimal places to keep, so it has to be a whole number from 0 to 100.",
      );
    }
    // Shift the decimal exponent instead of multiplying by a power of ten.
    // Multiplying reintroduces binary error at exactly the digit being rounded:
    // `1.005 * 100` is 100.49999999999999, so `round(1.005, 2)` came out as 1
    // where every spreadsheet — and the user — says 1.01.
    const shifted = shiftExponent(first, second);

    // Shifting a value near the top of the double range overflows to Infinity,
    // and shifting Infinity back yields NaN — which surfaced as a bogus "too
    // large to represent" for a number that was perfectly representable and
    // needed no rounding. Anything that big is already integral at this scale,
    // so there is nothing for `round` to do.
    if (!Number.isFinite(shifted)) return first;

    return shiftExponent(Math.round(shifted), -second);
  }

  if (second !== undefined) {
    throw new ExpressionError(`${name}() takes just one number.`);
  }

  const fn = UNARY_FUNCTIONS[name];
  if (!fn) {
    // Unreachable: the tokenizer already rejected unknown names.
    throw new ExpressionError(
      `${name}() isn't a function this calculator has.`,
    );
  }
  return fn(first);
}

/**
 * Evaluates a fully-resolved arithmetic expression. Any `@<path>@` references
 * must already have been substituted with numbers — this function knows nothing
 * about the workflow context.
 *
 * @throws {ExpressionError} with a message written for a non-technical user.
 */
export function evaluateExpression(expression: string): number {
  if (typeof expression !== "string" || expression.trim() === "") {
    throw new ExpressionError("There's nothing to calculate yet.");
  }

  const result = new Parser(tokenize(expression)).parse();
  const rounded = Number(result.toPrecision(SIGNIFICANT_DIGITS));

  // Checked AFTER rounding, not before. Rounding can push a value that was
  // finite over the edge — `Number(Number.MAX_VALUE.toPrecision(15))` is
  // Infinity — and an Infinity returned from here reaches the executor, where
  // `JSON.stringify({result: Infinity})` is `{"result":null}`. That wrote a
  // silent null into the run output while the node reported success.
  if (!Number.isFinite(rounded)) {
    throw new ExpressionError(
      "That works out to a number too large to represent.",
    );
  }

  return rounded;
}

/**
 * Renders a number in plain decimal, never exponential notation.
 *
 * JavaScript switches to exponential form for magnitudes at or beyond 1e21 and
 * below 1e-6, which breaks this module in two places:
 *
 *  - Substituting an upstream value: the executor writes resolved numbers back
 *    into the expression, and `1e-7` would then hit the tokenizer's letter
 *    branch and fail with "e isn't something this calculator knows" — on input
 *    that was a perfectly good number.
 *  - Display: `= 1e-7` is not what a calculator shows.
 *
 * Expands the exponent by moving the decimal point, so the result is the
 * SHORTEST plain form that still parses back to the identical double
 * (`1e-7` → `0.0000001`, not the 100-digit exact binary expansion `toFixed`
 * would give).
 */
export function toPlainDecimal(value: number): string {
  const text = String(value);
  const match = text.match(/^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i);
  if (!match) return text;

  const sign = match[1];
  const intPart = match[2];
  const fracPart = match[3] ?? "";
  const exponent = Number(match[4]);
  const digits = intPart + fracPart;
  const pointPosition = intPart.length + exponent;

  if (pointPosition <= 0) {
    return `${sign}0.${"0".repeat(-pointPosition)}${digits}`;
  }
  if (pointPosition >= digits.length) {
    return sign + digits + "0".repeat(pointPosition - digits.length);
  }
  return `${sign}${digits.slice(0, pointPosition)}.${digits.slice(pointPosition)}`;
}

export type ExpressionAttempt =
  | { value: number; error: null }
  | { value: null; error: string };

/**
 * Non-throwing companion to `evaluateExpression`, for live validation as the
 * user types. Returns the value, or the message explaining why there isn't one.
 *
 * Returns the value rather than just a boolean so a caller that needs both —
 * the dialog shows the error OR the answer — gets them from ONE evaluation.
 * Reporting validity alone forced callers to evaluate a second time to get the
 * number, which doubled the work on every keystroke and quietly relied on both
 * calls being given identical input.
 *
 * Catches EVERYTHING, not just `ExpressionError`. This runs inside a React
 * `useMemo` during render, so anything that escapes takes the editor down
 * instead of showing a validation message. The parser recurses about four
 * frames per bracket, so a deeply nested pasted expression throws `RangeError`
 * — an `Error`, but not an `ExpressionError`, and rethrowing it crashed the
 * editor.
 */
export function tryEvaluateExpression(expression: string): ExpressionAttempt {
  try {
    return { value: evaluateExpression(expression), error: null };
  } catch (error) {
    if (error instanceof ExpressionError) {
      return { value: null, error: error.message };
    }
    return {
      value: null,
      error: "That calculation is too complex to work out.",
    };
  }
}
