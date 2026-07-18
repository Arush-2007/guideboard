import { describe, expect, it } from "vitest";
import z from "zod";
import { parseNodeConfig } from "@/config/node-schemas";
import { NodeType } from "@/generated/prisma";
import { compareOptionsSchemaFields } from "./compare-options-schema";

const OPTS = { ignoreCase: true, ignoreChars: "- ", numeric: true };

describe("compareOptionsSchemaFields", () => {
  // The original bug: a plain z.object() STRIPS undeclared keys, so a schema
  // that forgot to spread these fields dropped the options on submit. Spreading
  // the shared fragment must keep them.
  it("preserves the three option fields through a plain z.object parse", () => {
    const schema = z.object({
      column: z.string(),
      ...compareOptionsSchemaFields,
    });
    expect(schema.parse({ column: "x", ...OPTS })).toMatchObject(OPTS);
  });

  it("leaves them undefined when absent (default-off, backward compatible)", () => {
    const schema = z.object({
      column: z.string(),
      ...compareOptionsSchemaFields,
    });
    const parsed = schema.parse({ column: "x" });
    expect(parsed.ignoreCase).toBeUndefined();
    expect(parsed.ignoreChars).toBeUndefined();
    expect(parsed.numeric).toBeUndefined();
  });
});

describe("parseNodeConfig preserves matching options for every comparing node", () => {
  it("CONDITION", () => {
    const cfg = parseNodeConfig(NodeType.CONDITION, {
      field: "@<a>@",
      operator: "equals",
      value: "1",
      ...OPTS,
    });
    expect(cfg).toMatchObject(OPTS);
  });

  it("SWITCH (per case)", () => {
    const cfg = parseNodeConfig(NodeType.SWITCH, {
      cases: [
        { id: "c1", field: "@<a>@", operator: "equals", value: "1", ...OPTS },
      ],
    }) as { cases: Array<Record<string, unknown>> };
    expect(cfg.cases[0]).toMatchObject(OPTS);
  });

  it("GOOGLE_SHEETS_ACTION (per condition)", () => {
    const cfg = parseNodeConfig(NodeType.GOOGLE_SHEETS_ACTION, {
      action: "find_rows",
      spreadsheetId: "sheet-1",
      sheetName: "Sheet1",
      conditions: [
        {
          column: "Vehicle Number",
          operator: "equals",
          value: "@<v>@",
          ...OPTS,
        },
      ],
    }) as { conditions: Array<Record<string, unknown>> };
    expect(cfg.conditions[0]).toMatchObject(OPTS);
  });

  it("CANDIDATE_SCORING (per rule)", () => {
    const cfg = parseNodeConfig(NodeType.CANDIDATE_SCORING, {
      provider: "rules",
      rules: [
        { field: "@<a>@", operator: "equals", value: "x", points: 10, ...OPTS },
      ],
    }) as { rules: Array<Record<string, unknown>> };
    expect(cfg.rules[0]).toMatchObject(OPTS);
  });
});
