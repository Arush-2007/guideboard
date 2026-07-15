import { describe, expect, it } from "vitest";
import { matchRows, type RowMatchCondition } from "./row-match";

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
) => matchRows(ledger, conditions, ctx, NOW);

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
      NOW,
    );
    expect(m.map((r) => r.row.Name)).toEqual(["old", "boundary"]);
  });

  it("within_days excludes the exact-boundary row and unparseable dates", () => {
    const m = matchRows(
      rows,
      [{ column: "Last", operator: "within_days", value: "30" }],
      {},
      NOW,
    );
    expect(m.map((r) => r.row.Name)).toEqual(["recent"]);
  });

  it("returns no match when the day count is non-numeric", () => {
    const m = matchRows(
      rows,
      [{ column: "Last", operator: "older_than_days", value: "abc" }],
      {},
      NOW,
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
