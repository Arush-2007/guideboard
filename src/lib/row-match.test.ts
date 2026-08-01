import { describe, expect, it } from "vitest";
import { matchRows, type RowMatchCondition } from "./row-match";
import { MERGED_ROW_COLUMN } from "./row-match-operators";

// A fixed "now" so date-window operators are deterministic.
const NOW = Date.parse("2026-07-10T00:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const ledger = [
  { "Service Buyer": "Govt PWD", "Buyer Type": "Government", Pending: "1500" },
  { "Service Buyer": "Private Co", "Buyer Type": "Private", Pending: "0" },
  { "Service Buyer": "Acme, Inc", "Buyer Type": "Private", Pending: "800" },
];

const run = (
  conditions: RowMatchCondition[],
  ctx: Record<string, unknown> = {},
) => matchRows(ledger, conditions, ctx, { now: NOW });

describe("matchRows — base operators (delegated to evaluateCondition)", () => {
  it("equals matches by exact cell value", () => {
    const m = run([
      { column: "Buyer Type", operator: "equals", value: "Private" },
    ]);
    expect(m.map((r) => r.index)).toEqual([1, 2]);
  });

  it("greater_than is numeric", () => {
    const m = run([
      { column: "Pending", operator: "greater_than", value: "0" },
    ]);
    expect(m.map((r) => r.index)).toEqual([0, 2]);
  });

  it("renders the comparison value against context", () => {
    const m = run(
      [{ column: "Pending", operator: "greater_than", value: "@<threshold>@" }],
      { threshold: "1000" },
    );
    expect(m.map((r) => r.index)).toEqual([0]);
  });

  it("passes matching options through to the comparator", () => {
    // Exact/case-sensitive: no match for the lowercased value.
    expect(
      run([{ column: "Buyer Type", operator: "equals", value: "private" }])
        .length,
    ).toBe(0);
    // With ignoreCase the same value now matches both Private rows.
    const m = run([
      {
        column: "Buyer Type",
        operator: "equals",
        value: "private",
        ignoreCase: true,
      },
    ]);
    expect(m.map((r) => r.index)).toEqual([1, 2]);
  });
});

describe("matchRows — AND semantics and enabled flag", () => {
  it("requires every enabled condition (AND)", () => {
    const m = run([
      { column: "Buyer Type", operator: "equals", value: "Private" },
      { column: "Pending", operator: "greater_than", value: "0" },
    ]);
    expect(m.map((r) => r.index)).toEqual([2]);
  });

  it("skips disabled conditions", () => {
    const m = run([
      { column: "Buyer Type", operator: "equals", value: "Private" },
      {
        column: "Pending",
        operator: "greater_than",
        value: "999999",
        enabled: false,
      },
    ]);
    expect(m.map((r) => r.index)).toEqual([1, 2]);
  });

  it("matches every row when there are no active conditions (vacuous AND)", () => {
    expect(run([]).map((r) => r.index)).toEqual([0, 1, 2]);
  });
});

describe("matchRows — in_list", () => {
  it("matches membership from a JSON-array value (comma-safe)", () => {
    const m = run([
      {
        column: "Service Buyer",
        operator: "in_list",
        value: '["Govt PWD","Acme, Inc"]',
      },
    ]);
    expect(m.map((r) => r.index)).toEqual([0, 2]);
  });

  it("also accepts a comma-separated list", () => {
    const m = run([
      {
        column: "Service Buyer",
        operator: "in_list",
        value: "Govt PWD, Private Co",
      },
    ]);
    expect(m.map((r) => r.index)).toEqual([0, 1]);
  });

  it("does not match an empty cell or an absent value in the list", () => {
    const m = run([
      { column: "Service Buyer", operator: "in_list", value: "Nobody" },
    ]);
    expect(m).toEqual([]);
  });
});

describe("matchRows — date windows", () => {
  const rows = [
    { Name: "old", Last: daysAgo(40) },
    { Name: "boundary", Last: daysAgo(30) },
    { Name: "recent", Last: daysAgo(10) },
    { Name: "bad", Last: "not-a-date" },
  ];

  it("older_than_days includes the exact-boundary row", () => {
    const m = matchRows(
      rows,
      [{ column: "Last", operator: "older_than_days", value: "30" }],
      {},
      { now: NOW },
    );
    expect(m.map((r) => r.row.Name)).toEqual(["old", "boundary"]);
  });

  it("within_days excludes the exact-boundary row and unparseable dates", () => {
    const m = matchRows(
      rows,
      [{ column: "Last", operator: "within_days", value: "30" }],
      {},
      { now: NOW },
    );
    expect(m.map((r) => r.row.Name)).toEqual(["recent"]);
  });

  it("returns no match when the day count is non-numeric", () => {
    const m = matchRows(
      rows,
      [{ column: "Last", operator: "older_than_days", value: "abc" }],
      {},
      { now: NOW },
    );
    expect(m).toEqual([]);
  });
});

describe("matchRows — column lookup", () => {
  it("is case-insensitive on the column name", () => {
    const m = run([
      { column: "service buyer", operator: "equals", value: "Govt PWD" },
    ]);
    expect(m.map((r) => r.index)).toEqual([0]);
  });
});

describe("matchRows — the merged-row pseudo-column", () => {
  // Row 1 is a merged section title; its text sits in the FIRST column and its
  // other cells are empty. Rows 0 and 2 are ordinary data.
  const tab = [
    { Name: "Ada", Status: "Done" },
    { Name: "Q1 Sales", Status: "" },
    { Name: "Grace", Status: "Done" },
  ];
  // Row 1 is merged, 3 columns wide — the shape `mergedDataRows` returns.
  const mergedRows = new Map([[1, 3]]);
  const opts = { mergedRows, firstColumn: "Name" };

  const merged = (
    operator: RowMatchCondition["operator"],
    value?: string,
  ): RowMatchCondition[] => [{ column: MERGED_ROW_COLUMN, operator, value }];

  it("matches a merged row by the text of its merged cell", () => {
    const m = matchRows(tab, merged("equals", "Q1 Sales"), {}, opts);
    expect(m.map((r) => r.index)).toEqual([1]);
  });

  it("never matches a DATA row that happens to hold the same text", () => {
    // The whole point of reading the sheet's real merges instead of guessing
    // from "first cell filled, rest empty": this row IS the same text, and is
    // still not a section title.
    const withDecoy = [...tab, { Name: "Q1 Sales", Status: "Done" }];
    const m = matchRows(withDecoy, merged("equals", "Q1 Sales"), {}, opts);
    expect(m.map((r) => r.index)).toEqual([1]);
  });

  it("supports the ordinary operators and restraints", () => {
    expect(
      matchRows(tab, merged("contains", "sales"), {}, opts).map((r) => r.index),
    ).toEqual([]);
    expect(
      matchRows(
        tab,
        [
          {
            column: MERGED_ROW_COLUMN,
            operator: "contains",
            value: "sales",
            ignoreCase: true,
          },
        ],
        {},
        opts,
      ).map((r) => r.index),
    ).toEqual([1]);
  });

  it("lists every merged row when asked only that it is non-empty", () => {
    const m = matchRows(tab, merged("is_not_empty"), {}, opts);
    expect(m.map((r) => r.index)).toEqual([1]);
  });

  // The safety property. A merged condition the matcher cannot answer must
  // select NOTHING — because the alternative, treating "unknown" as "matches",
  // turns it into a filter over every row, and on a write action that silently
  // rewrites or repaints the whole tab.
  it("FAILS CLOSED when no merge information was supplied", () => {
    expect(matchRows(tab, merged("is_not_empty"), {}, {})).toEqual([]);
    expect(matchRows(tab, merged("equals", "Q1 Sales"), {}, {})).toEqual([]);
    // Not even with an operator that is vacuously true of an empty cell.
    expect(matchRows(tab, merged("is_empty"), {}, {})).toEqual([]);
  });

  it("still fails closed for rows outside a supplied merge map", () => {
    // `is_empty` would be TRUE of rows 0 and 2 read as text, so this pins that
    // the merge check runs BEFORE the comparison, not after it.
    const m = matchRows(tab, merged("is_empty"), {}, opts);
    expect(m).toEqual([]);
  });

  it("ANDs with an ordinary column condition", () => {
    const m = matchRows(
      [...tab, { Name: "Q2 Sales", Status: "" }],
      [
        { column: MERGED_ROW_COLUMN, operator: "contains", value: "Sales" },
        { column: "Status", operator: "is_empty" },
      ],
      {},
      opts,
    );
    // Row 3 has matching text and an empty Status, but is not merged.
    expect(m.map((r) => r.index)).toEqual([1]);
  });

  it("reads the merged text from the tab's live first column", () => {
    // The column is supplied at run time, never saved, so renaming the first
    // column cannot break a saved filter.
    const renamed = [
      { Person: "Ada", Status: "Done" },
      { Person: "Q1 Sales", Status: "" },
    ];
    const m = matchRows(
      renamed,
      merged("equals", "Q1 Sales"),
      {},
      { mergedRows, firstColumn: "Person" },
    );
    expect(m.map((r) => r.index)).toEqual([1]);
  });
});
