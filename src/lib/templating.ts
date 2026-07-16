import Handlebars from "handlebars";
import { PLACEHOLDER_RE } from "@/lib/template-token";

/**
 * Single source of truth for rendering user-authored template strings against a
 * workflow `context`. Replaces the per-executor `Handlebars.compile(...)` calls
 * and the duplicated `json` helper registrations.
 *
 * Two syntaxes are supported:
 *
 *  - `@<path>@`  — the primary, user-facing placeholder. Inserted by the field
 *    picker (`<TemplateInput>`), it carries a canonical context path such as
 *    `@<telegram.from.firstName>@`. Resolved by direct substitution, so it
 *    never collides with JSON braces (the failure mode plain Handlebars hits
 *    when a `{{x}}` sits right before a `}` in a JSON body).
 *
 *  - `{{...}}`   — legacy Handlebars, kept working for back-compat and power
 *    users. The `json` helper (`{{json some.obj}}`) is registered here, once.
 *
 * Handlebars runs first (only when `{{` is present), then placeholders are
 * substituted, so a value pulled in via `@<...>@` is never re-parsed as a
 * template.
 */

Handlebars.registerHelper("json", (value) => {
  return new Handlebars.SafeString(JSON.stringify(value, null, 2));
});

function getByPath(obj: unknown, path: string): unknown {
  const keys = path
    .split(".")
    .map((k) => k.trim())
    .filter(Boolean);
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Coerces a resolved value into the text that gets substituted into a field. */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Renders `template` against `context`, resolving both `@<path>@` placeholders
 * and `{{...}}` Handlebars expressions. Missing paths resolve to an empty
 * string. A non-string template is returned unchanged-as-string for safety.
 */
export function renderTemplate(
  template: string | null | undefined,
  context: Record<string, unknown>,
): string {
  if (typeof template !== "string" || template.length === 0) {
    return template ?? "";
  }

  let out = template;
  if (out.includes("{{")) {
    out = Handlebars.compile(out)(context);
  }

  out = out.replace(PLACEHOLDER_RE, (_match, path: string) =>
    stringify(getByPath(context, path)),
  );

  return out;
}

export type FieldMappingValue = Record<string, string>;

/**
 * Resolves a "match the columns" mapping (target key -> template string) into
 * concrete values by rendering each template against `context`. Used by action
 * executors (Sheets, Email, ...) so no node hand-rolls templating.
 */
export function resolveMapping(
  mapping: FieldMappingValue,
  context: Record<string, unknown>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, template] of Object.entries(mapping)) {
    resolved[key] = renderTemplate(template, context);
  }
  return resolved;
}
