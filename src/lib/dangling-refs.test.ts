import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import {
  availablePaths,
  availablePathsByNode,
  describeStrippedRefs,
  findDanglingRefs,
  findDanglingRefsByNode,
  groupByField,
  humanizeFieldKey,
  reachableValues,
  stripDanglingRefs,
  stripDanglingRefsInNodes,
} from "./dangling-refs";
import { ANCHOR_ROW_KEY } from "./sheet-headers";

// telegram trigger -> AI_TEXT_1 -> SLACK_1, with an AI_TEXT_2 off to the side
// that nothing connects to SLACK_1.
const nodes = [
  { id: "t1", type: NodeType.TELEGRAM_TRIGGER, data: {} },
  { id: "a1", type: NodeType.AI_TEXT, data: { ref: "AI_TEXT_1" } },
  { id: "a2", type: NodeType.AI_TEXT, data: { ref: "AI_TEXT_2" } },
  { id: "s1", type: NodeType.SLACK, data: { ref: "SLACK_1" } },
];
const edges = [
  { source: "t1", target: "a1" },
  { source: "a1", target: "s1" },
];

describe("availablePaths", () => {
  it("offers each upstream node's declared VALUES, not just its name", () => {
    const { paths } = availablePaths("s1", nodes, edges);
    // The picker offers `AI_TEXT_1.output`; the bare name is deliberately NOT
    // on offer, or every invented path beneath it would pass as a drill-down.
    expect(paths.has("AI_TEXT_1.output")).toBe(true);
    expect(paths.has("AI_TEXT_1")).toBe(false);
    expect([...paths].some((p) => p.startsWith("telegram."))).toBe(true);
  });

  it("offers nothing from a node that can't reach this one", () => {
    expect(
      [...availablePaths("s1", nodes, edges).paths].some((p) =>
        p.startsWith("AI_TEXT_2"),
      ),
    ).toBe(false);
  });

  it("offers the columns a find_rows node discovered, and only those", () => {
    // A Sheets node's per-column outputs are `discoveredFields` saved when its
    // dialog last loaded the sheet. They are the whole point of matching by
    // value: a column that has since been renamed is simply not on offer, and a
    // reference to it is dead even though the node IS connected.
    const sheets = [
      { id: "t1", type: NodeType.TELEGRAM_TRIGGER, data: {} },
      {
        id: "g1",
        type: NodeType.GOOGLE_SHEETS_ACTION,
        data: {
          ref: "OG_SHEETS",
          action: "find_rows",
          discoveredFields: [
            { path: "OG_SHEETS.firstRow.Date", label: "Date" },
            { path: "OG_SHEETS.firstRow.TYPE", label: "TYPE" },
          ],
        },
      },
      { id: "s1", type: NodeType.SLACK, data: { ref: "SLACK_1" } },
    ];
    const chain = [
      { source: "t1", target: "g1" },
      { source: "g1", target: "s1" },
    ];
    const { paths } = availablePaths("s1", sheets, chain);
    expect(paths.has("OG_SHEETS.firstRow.Date")).toBe(true);
    expect(paths.has("OG_SHEETS.firstRow.Customer Name")).toBe(false);
  });

  it("offers nothing to a node with no upstream at all (a fresh duplicate)", () => {
    expect(availablePaths("a2", nodes, edges).paths.size).toBe(0);
  });

  it("offers a node its OWN self-roots, with nothing wired to it", () => {
    // `anchorRow` is injected by the Sheets append while rendering its own
    // columns; it never enters the workflow context, so no wiring produces it.
    const orphan = [
      { id: "g1", type: NodeType.GOOGLE_SHEETS_ACTION, data: {} },
    ];
    // A self-root lands in `roots`, not `paths`: its fields are built by the
    // dialog from live sheet headers, so what is inside it is open.
    expect(availablePaths("g1", orphan, []).roots.has(ANCHOR_ROW_KEY)).toBe(
      true,
    );
  });

  it("does NOT offer another node's self-roots", () => {
    // The whole point of keying them to the node: a Slack body naming
    // `anchorRow` is dead, even downstream of the Sheets node that has one.
    const chain = [
      { id: "g1", type: NodeType.GOOGLE_SHEETS_ACTION, data: {} },
      { id: "s1", type: NodeType.SLACK, data: { ref: "SLACK_1" } },
    ];
    const { paths: refs } = availablePaths("s1", chain, [
      { source: "g1", target: "s1" },
    ]);
    expect(refs.has(ANCHOR_ROW_KEY)).toBe(false);
  });

  it("keeps self-roots out of the whole-canvas map's inheritance", () => {
    // Same rule through the batch path, which is a separate walk: a self-root
    // must not ride the propagated set down to a successor.
    const chain = [
      { id: "g1", type: NodeType.GOOGLE_SHEETS_ACTION, data: {} },
      { id: "s1", type: NodeType.SLACK, data: { ref: "SLACK_1" } },
    ];
    const map = availablePathsByNode(chain, [{ source: "g1", target: "s1" }]);
    expect(map.get("g1")?.roots.has(ANCHOR_ROW_KEY)).toBe(true);
    expect(map.get("s1")?.roots.has(ANCHOR_ROW_KEY)).toBe(false);
  });

  it("inherits transitively down a chain", () => {
    // The accumulation is per-edge, not per-ancestry-walk, so a grandparent has
    // to arrive through the parent rather than by re-walking.
    const { paths } = availablePaths("s1", nodes, edges);
    expect([...paths].some((p) => p.startsWith("telegram."))).toBe(true);
    expect(paths.has("AI_TEXT_1.output")).toBe(true);
  });

  it("merges both branches of a diamond", () => {
    const diamond = [
      { id: "t1", type: NodeType.TELEGRAM_TRIGGER, data: {} },
      { id: "a1", type: NodeType.AI_TEXT, data: { ref: "AI_TEXT_1" } },
      { id: "a2", type: NodeType.AI_TEXT, data: { ref: "AI_TEXT_2" } },
      { id: "s1", type: NodeType.SLACK, data: { ref: "SLACK_1" } },
    ];
    const { paths: refs } = availablePaths("s1", diamond, [
      { source: "t1", target: "a1" },
      { source: "t1", target: "a2" },
      { source: "a1", target: "s1" },
      { source: "a2", target: "s1" },
    ]);
    expect(refs.has("AI_TEXT_1.output")).toBe(true);
    expect(refs.has("AI_TEXT_2.output")).toBe(true);
  });

  it("gives a node BELOW a cycle its full ancestry", () => {
    // The memoized walk cut a back-edge short and then cached the partial set,
    // so `d` lost everything published above the cycle — its good references
    // were badged, listed for removal, and deleted, while the node's own dialog
    // (which walks independently) said they were fine.
    const belowCycle = [
      { id: "c", type: NodeType.AI_TEXT, data: { ref: "C1" } },
      { id: "a", type: NodeType.AI_TEXT, data: { ref: "A1" } },
      { id: "b", type: NodeType.AI_TEXT, data: { ref: "B1" } },
      { id: "d", type: NodeType.SLACK, data: { ref: "SLACK_1" } },
    ];
    const cycleEdges = [
      { source: "c", target: "a" },
      { source: "a", target: "b" },
      { source: "b", target: "a" }, // the cycle
      { source: "b", target: "d" },
    ];

    const batch = availablePathsByNode(belowCycle, cycleEdges).get("d");
    // The whole-canvas map must agree with the single-node walk the per-node
    // dialog uses — disagreeing is what made one surface contradict the other.
    expect([...(batch?.paths ?? [])].sort()).toEqual(
      [...availablePaths("d", belowCycle, cycleEdges).paths].sort(),
    );
    expect(batch?.paths.has("C1.output")).toBe(true);
  });

  it("still resolves ancestry through a cycle (the exhaustive fallback)", () => {
    // A cycle can't be topologically ordered, so this takes the slow path. It
    // must not UNDER-report: a node whose upstream it failed to see would have
    // its perfectly good fields called dead.
    const cyclic = [
      { id: "t1", type: NodeType.TELEGRAM_TRIGGER, data: {} },
      { id: "a1", type: NodeType.AI_TEXT, data: { ref: "AI_TEXT_1" } },
      { id: "a2", type: NodeType.AI_TEXT, data: { ref: "AI_TEXT_2" } },
      { id: "s1", type: NodeType.SLACK, data: { ref: "SLACK_1" } },
    ];
    const { paths: refs } = availablePaths("s1", cyclic, [
      { source: "t1", target: "a1" },
      { source: "a1", target: "a2" },
      { source: "a2", target: "a1" }, // the cycle
      { source: "a2", target: "s1" },
    ]);
    expect([...refs].some((p) => p.startsWith("telegram."))).toBe(true);
    expect(refs.has("AI_TEXT_1.output")).toBe(true);
    expect(refs.has("AI_TEXT_2.output")).toBe(true);
  });
});

describe("findDanglingRefs", () => {
  const available = reachableValues(["AI_TEXT_1", "telegram"]);

  it("passes a config whose references are all reachable", () => {
    expect(
      findDanglingRefs(
        { text: "Hi @<telegram.from.firstName>@ — @<AI_TEXT_1.output>@" },
        available,
      ),
    ).toEqual([]);
  });

  it("reports the VALUE and its field, not just the producing step", () => {
    // The user's complaint about the first cut: "AI_TEXT_2" names a step and
    // leaves them to work out which of its values the field was pulling.
    expect(
      findDanglingRefs(
        { message: "Summarize @<AI_TEXT_2.output>@" },
        available,
      ),
    ).toEqual([
      {
        ref: "AI_TEXT_2",
        path: "AI_TEXT_2.output",
        field: "message",
      },
    ]);
  });

  it("distinguishes two values of the same dead step", () => {
    expect(
      findDanglingRefs(
        { message: "@<AI_TEXT_2.output>@ / @<AI_TEXT_2.tokens>@" },
        available,
      ).map((d) => d.path),
    ).toEqual(["AI_TEXT_2.output", "AI_TEXT_2.tokens"]);
  });

  it("finds references nested anywhere in the config blob", () => {
    const config = {
      columnMappings: [
        { column: "Name", value: "@<AI_TEXT_1.output>@" },
        { column: "Score", value: "@<CANDIDATE_SCORING_1.score>@" },
      ],
      conditions: { all: [{ left: "@<SLACK_9.ts>@", right: "x" }] },
    };
    expect(findDanglingRefs(config, available)).toEqual([
      {
        ref: "CANDIDATE_SCORING_1",
        path: "CANDIDATE_SCORING_1.score",
        field: "columnMappings",
      },
      {
        ref: "SLACK_9",
        path: "SLACK_9.ts",
        field: "conditions",
      },
    ]);
  });

  it("names the outermost field, so a list row points at the control", () => {
    // "Column mappings", not "columnMappings.0.value" — the index names a row
    // the user can already see once they are looking at the right field.
    expect(
      findDanglingRefs(
        { columnMappings: [{ value: "@<Z_1.x>@" }] },
        available,
      )[0].field,
    ).toBe("columnMappings");
  });

  it("reports one row per field+value pair, in first-seen order", () => {
    expect(
      findDanglingRefs(
        { a: "@<Z_1.x>@ @<Z_1.x>@", b: "@<Z_1.x>@" },
        available,
      ).map((d) => d.field),
    ).toEqual(["a", "b"]);
  });

  it("accepts a drill-down past the declared fields of a reachable node", () => {
    // Root-only matching: the producing node is upstream, so how deep the path
    // goes is a question only the run can answer.
    expect(
      findDanglingRefs({ text: "@<AI_TEXT_1.output.items.0.id>@" }, available),
    ).toEqual([]);
  });

  it("ignores custom-feature tokens whatever the node", () => {
    // They wear the placeholder shape but name a behaviour of the node being
    // configured, so no wiring can make them reachable or unreachable — a
    // property of the grammar, not of this graph.
    expect(
      findDanglingRefs(
        { serial: "@<custom:serialNumber?start=1&pad=4>@" },
        available,
      ),
    ).toEqual([]);
  });

  it("flags a self-root the CURRENT node does not supply", () => {
    // `anchorRow` is real inside a Sheets append and meaningless anywhere else.
    // A global exception let it pass in a Slack body, where it renders blank.
    expect(
      findDanglingRefs({ message: `@<${ANCHOR_ROW_KEY}.Job No>@` }, available)
        .length,
    ).toBe(1);
  });

  it("ignores plain text and legacy handlebars", () => {
    expect(
      findDanglingRefs(
        { text: "Email me at a@b.com about {{AI_TEXT_2.output}}" },
        available,
      ),
    ).toEqual([]);
  });
});

describe("describeStrippedRefs", () => {
  const entry = (nodeRef: string, fields: string[]) => ({
    nodeId: "n",
    nodeRef,
    nodeType: NodeType.SLACK as string,
    refs: fields.map((field) => ({
      ref: "X_1",
      path: "X_1.out",
      field,
    })),
  });

  it("says nothing when nothing was stripped", () => {
    expect(describeStrippedRefs([])).toBe("");
  });

  it("names the step and field, in the singular", () => {
    const note = describeStrippedRefs([entry("SLACK_1", ["message"])]);
    expect(note).toContain("1 field");
    expect(note).toContain("SLACK_1 (Message)");
    expect(note).toContain("It is");
  });

  it("counts across nodes and reads in the plural", () => {
    const note = describeStrippedRefs([
      entry("SLACK_1", ["message"]),
      entry("SHEETS_1", ["columnMappings"]),
    ]);
    expect(note).toContain("2 fields");
    expect(note).toContain("SLACK_1 (Message)");
    expect(note).toContain("SHEETS_1 (Column mappings)");
    expect(note).toContain("They are");
  });

  it("counts FIELDS, not references, when one field holds two", () => {
    // Two dead values in one box is one field to go and fix, and saying
    // "2 fields" sends the user looking for a second one that doesn't exist.
    const note = describeStrippedRefs([
      entry("SLACK_1", ["message", "message"]),
    ]);
    expect(note).toContain("1 field");
    expect(note).toContain("SLACK_1 (Message)");
    expect(note).not.toContain("Message, Message");
  });
});

describe("fields the node's current settings ignore", () => {
  // The reported bug. A Sheets node duplicated off its find_rows source listed
  // one dead condition AND sixteen dead column mappings — but find_rows never
  // reads columnMappings (executor.ts only maps columns for append_row and
  // update_row), so those sixteen could not have affected the run.
  const columns = Array.from({ length: 16 }, (_, i) => `Column ${i}`);
  const sheetsData = (action: string) => ({
    ref: "GOOGLE_SHEETS_ACTION_1",
    action,
    conditions: [
      { column: "X", value: "@<OG_SHEETS.firstRow.Customer Name>@" },
    ],
    columnMappings: Object.fromEntries(
      columns.map((c) => [c, `@<OG_SHEETS.firstRow.${c}>@`]),
    ),
  });

  it("reports only the live field on a find_rows node", () => {
    const found = findDanglingRefs(
      sheetsData("find_rows"),
      reachableValues([]),
      {
        nodeType: NodeType.GOOGLE_SHEETS_ACTION,
      },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      field: "conditions",
      path: "OG_SHEETS.firstRow.Customer Name",
    });
  });

  it("still reports the mappings when the action DOES read them", () => {
    // Same data, one word different: an append writes those columns, so all 17
    // are real.
    const found = findDanglingRefs(
      sheetsData("append_row"),
      reachableValues([]),
      {
        nodeType: NodeType.GOOGLE_SHEETS_ACTION,
      },
    );
    // A plain bottom append doesn't filter rows, so `conditions` is the inert
    // one here — the rule cuts both ways.
    expect(found.map((f) => f.field)).toEqual(
      Array.from({ length: 16 }, () => "columnMappings"),
    );
  });

  it("keeps both when an under-append maps columns AND filters rows", () => {
    const found = findDanglingRefs(
      { ...sheetsData("append_row"), position: "under_group" },
      reachableValues([]),
      { nodeType: NodeType.GOOGLE_SHEETS_ACTION },
    );
    expect(new Set(found.map((f) => f.field))).toEqual(
      new Set(["conditions", "columnMappings"]),
    );
  });

  it("drops the mapping for a MERGING append, which writes one cell", () => {
    const found = findDanglingRefs(
      {
        ...sheetsData("append_row"),
        styleAppendedRow: true,
        mergeMode: "merge",
        mergedText: "@<OG_SHEETS.firstRow.Title>@",
      },
      reachableValues([]),
      { nodeType: NodeType.GOOGLE_SHEETS_ACTION },
    );
    expect(found.map((f) => f.field)).toEqual(["mergedText"]);
  });

  it("applies to the other mode-switched nodes too", () => {
    const lookup = { source: "notion", column: "@<GHOST_1.a>@" };
    expect(
      findDanglingRefs(lookup, reachableValues([]), {
        nodeType: NodeType.RECORD_LOOKUP,
      }),
    ).toEqual([]);

    const excel = { operation: "append_row", keyValue: "@<GHOST_1.a>@" };
    expect(
      findDanglingRefs(excel, reachableValues([]), {
        nodeType: NodeType.EXCEL_ACTION,
      }),
    ).toEqual([]);
  });

  it("checks every field on a node that declares nothing", () => {
    // The default is unchanged: an unlisted node type has all its fields read.
    expect(
      findDanglingRefs({ message: "@<GHOST_1.a>@" }, reachableValues([]), {
        nodeType: NodeType.SLACK,
      }),
    ).toHaveLength(1);
  });
});

describe("matching by VALUE, not by step name", () => {
  // The reported bug, exactly. A Sheets node reads a find_rows step that offers
  // 15 of its 16 columns — "Customer Name" was renamed in the sheet since. The
  // step IS connected, so name-matching reported nothing wrong until the wire
  // was cut, and then reported all 17. Only the one missing column is dead.
  const columns = ["Date", "TYPE", "SNo", "Discount", "Odometer"];
  const offered = columns.map((c) => ({
    path: `OG_SHEETS.firstRow.${c}`,
    label: c,
  }));

  const graph = [
    { id: "t1", type: NodeType.TELEGRAM_TRIGGER, data: {} },
    {
      id: "og",
      type: NodeType.GOOGLE_SHEETS_ACTION,
      data: {
        ref: "OG_SHEETS",
        action: "find_rows",
        discoveredFields: offered,
      },
    },
    {
      id: "g1",
      type: NodeType.GOOGLE_SHEETS_ACTION,
      data: {
        ref: "GOOGLE_SHEETS_ACTION_1",
        action: "append_row",
        columnMappings: {
          ...Object.fromEntries(
            columns.map((c) => [c, `@<OG_SHEETS.firstRow.${c}>@`]),
          ),
          // The one the upstream step no longer publishes.
          "Customer Name": "@<OG_SHEETS.firstRow.Customer Name>@",
        },
      },
    },
  ];
  const wired = [
    { source: "t1", target: "og" },
    { source: "og", target: "g1" },
  ];

  it("reports ONLY the value that is no longer offered", () => {
    const found = findDanglingRefsByNode(graph, wired);
    expect(found).toHaveLength(1);
    expect(found[0].refs).toHaveLength(1);
    expect(found[0].refs[0].path).toBe("OG_SHEETS.firstRow.Customer Name");
  });

  it("says nothing at all once every value is offered", () => {
    const complete = graph.map((node) =>
      node.id === "og"
        ? {
            ...node,
            data: {
              ...node.data,
              discoveredFields: [
                ...offered,
                {
                  path: "OG_SHEETS.firstRow.Customer Name",
                  label: "Customer Name",
                },
              ],
            },
          }
        : node,
    );
    expect(findDanglingRefsByNode(complete, wired)).toEqual([]);
  });

  it("still reports everything when the step really is disconnected", () => {
    const cut = [
      { source: "t1", target: "og" },
      { source: "t1", target: "g1" },
    ];
    expect(findDanglingRefsByNode(graph, cut)[0].refs).toHaveLength(6);
  });

  it("removes ONLY the dead value, keeping the step's working siblings", () => {
    // Detection is per-value, so removal has to be too. Stripping by STEP wiped
    // `Date` — a mapping that resolved perfectly — while the warning had listed
    // only `Customer Name`, contradicting its own "the rest is kept".
    const found = findDanglingRefsByNode(graph, wired);
    const after = stripDanglingRefsInNodes(graph, found);
    const mappings = (
      after[2].data as { columnMappings: Record<string, string> }
    ).columnMappings;

    expect(mappings["Customer Name"]).toBe("");
    expect(mappings.Date).toBe("@<OG_SHEETS.firstRow.Date>@");
    expect(mappings.TYPE).toBe("@<OG_SHEETS.firstRow.TYPE>@");
  });

  it("allows a drill-down, and an undeclared sibling, when nothing is closed", () => {
    // The static output registry is a CURATED list, not a description — Sheets
    // `find_rows` really publishes `rows` that no descriptor mentions. So an
    // unlisted path off a reachable step has to pass, or working code gets
    // badged. Only a CLOSED container can say something is truly absent.
    const open = reachableValues(["AI_TEXT_1.output"]);
    expect(
      findDanglingRefs({ message: "@<AI_TEXT_1.output.items.0.id>@" }, open),
    ).toEqual([]);
    expect(findDanglingRefs({ message: "@<AI_TEXT_1.rows>@" }, open)).toEqual(
      [],
    );
  });

  it("catches an absent sibling INSIDE a closed container", () => {
    // `OG.firstRow`'s children were read off the sheet, so the list is the whole
    // truth about it and an unlisted column is genuinely gone.
    const closed = reachableValues(
      ["OG.firstRow", "OG.firstRow.Date"],
      ["OG.firstRow"],
    );
    expect(findDanglingRefs({ a: "@<OG.firstRow.Date>@" }, closed)).toEqual([]);
    expect(
      findDanglingRefs({ a: "@<OG.firstRow.Gone>@" }, closed),
    ).toHaveLength(1);
    // A value alongside the closed container is untouched by its authority.
    expect(findDanglingRefs({ a: "@<OG.rows>@" }, closed)).toEqual([]);
  });
});

describe("groupByField", () => {
  // The reported case: a Sheets node duplicated away from the find_rows step it
  // read, so ONE bad wire killed a condition plus a mapping per sheet column.
  // Seventeen findings, but only two fields to go and fix.
  const sheetsRefs = (columns: string[]) => [
    ...findDanglingRefs(
      { conditions: "@<OG_SHEETS.firstRow.Job Card Number>@" },
      reachableValues([]),
    ),
    ...findDanglingRefs(
      {
        columnMappings: Object.fromEntries(
          columns.map((c) => [c, `@<OG_SHEETS.firstRow.${c}>@`]),
        ),
      },
      reachableValues([]),
    ),
  ];

  it("collapses many values in one field to a single entry", () => {
    const columns = Array.from({ length: 16 }, (_, i) => `Column ${i}`);
    const refs = sheetsRefs(columns);
    expect(refs).toHaveLength(17);

    const groups = groupByField(refs);
    expect(groups.map((g) => g.field)).toEqual([
      "conditions",
      "columnMappings",
    ]);
    expect(groups[0].refs).toHaveLength(1);
    expect(groups[1].refs).toHaveLength(16);
  });

  it("keeps first-seen order and every value under its field", () => {
    const groups = groupByField(sheetsRefs(["A", "B"]));
    expect(groups[1].refs.map((r) => `@<${r.path}>@`)).toEqual([
      "@<OG_SHEETS.firstRow.A>@",
      "@<OG_SHEETS.firstRow.B>@",
    ]);
  });

  it("returns nothing for nothing", () => {
    expect(groupByField([])).toEqual([]);
  });
});

describe("humanizeFieldKey", () => {
  it("turns a form key into a field name", () => {
    expect(humanizeFieldKey("message")).toBe("Message");
    expect(humanizeFieldKey("recipientPhones")).toBe("Recipient phones");
    expect(humanizeFieldKey("columnMappings")).toBe("Column mappings");
    expect(humanizeFieldKey("")).toBe("");
  });
});

describe("findDanglingRefsByNode", () => {
  // The reported bug, as a graph: SLACK_1 is a copy of a node that referenced
  // AI_TEXT_1, but it was wired under AI_TEXT_2 instead. Nothing ever opened its
  // dialog, so nothing had looked at its config.
  const miswired = [
    { id: "t1", type: NodeType.TELEGRAM_TRIGGER, data: {} },
    { id: "a1", type: NodeType.AI_TEXT, data: { ref: "AI_TEXT_1" } },
    { id: "a2", type: NodeType.AI_TEXT, data: { ref: "AI_TEXT_2" } },
    {
      id: "s1",
      type: NodeType.SLACK,
      data: { ref: "SLACK_1", message: "Result: @<AI_TEXT_1.output>@" },
    },
  ];
  const miswiredEdges = [
    { source: "t1", target: "a1" },
    { source: "t1", target: "a2" },
    { source: "a2", target: "s1" },
  ];

  it("catches a node wired to the wrong upstream", () => {
    expect(findDanglingRefsByNode(miswired, miswiredEdges)).toEqual([
      {
        nodeId: "s1",
        nodeRef: "SLACK_1",
        nodeType: NodeType.SLACK,
        refs: [
          {
            ref: "AI_TEXT_1",
            path: "AI_TEXT_1.output",
            field: "message",
          },
        ],
      },
    ]);
  });

  it("reports nothing once the node is wired to the step it names", () => {
    const rewired = [
      { source: "t1", target: "a1" },
      { source: "a1", target: "s1" },
    ];
    expect(findDanglingRefsByNode(miswired, rewired)).toEqual([]);
  });

  it("leaves a Sheets append referencing its own anchor row alone", () => {
    // The regression this registry exists to prevent, end to end: the badge, the
    // save dialog and "Remove and save" all read this, so a false positive here
    // erases a working column mapping.
    expect(
      findDanglingRefsByNode(
        [
          {
            id: "g1",
            type: NodeType.GOOGLE_SHEETS_ACTION,
            data: {
              ref: "GOOGLE_SHEETS_ACTION_1",
              action: "append_row",
              position: "under_group",
              columnMappings: { "Job No": `@<${ANCHOR_ROW_KEY}.Job No>@` },
            },
          },
        ],
        [],
      ),
    ).toEqual([]);
  });

  it("ignores a node's own ref, which is data but not a reference", () => {
    // `data.ref` holds the bare string "SLACK_1" — no token, so nothing to find.
    expect(
      findDanglingRefsByNode(
        [{ id: "s1", type: NodeType.SLACK, data: { ref: "SLACK_1" } }],
        [],
      ),
    ).toEqual([]);
  });
});

describe("the Code node is excluded from checking", () => {
  // Its field is a PROGRAM. References are JavaScript property access off the
  // run context, so finding them takes a syntactic scan that can't see
  // destructuring or computed access; the context genuinely holds more than the
  // picker lists (Sheets `find_rows` publishes `rows` no descriptor declares);
  // and nothing found could be auto-repaired, since cutting a reference out of
  // a program leaves code that won't parse. Warnings that fire unpredictably on
  // working code are worse than none, so it is left to the author.
  const code = (source: string) => ({
    id: "c1",
    type: NodeType.CODE,
    data: { ref: "CODE_2", code: source },
  });

  it("says nothing even when the step it names cannot reach it", () => {
    const graph = [
      { id: "t1", type: NodeType.TELEGRAM_TRIGGER, data: {} },
      { id: "a1", type: NodeType.AI_TEXT, data: { ref: "AI_TEXT_1" } },
      code("return input.AI_TEXT_1.output;"),
    ];
    // AI_TEXT_1 is a SIBLING, not upstream — a token node here would be flagged.
    expect(
      findDanglingRefsByNode(graph, [
        { source: "t1", target: "a1" },
        { source: "t1", target: "c1" },
      ]),
    ).toEqual([]);
  });

  it("says nothing about a real output the registry doesn't declare", () => {
    // The MAHINDRA case: `find_rows` publishes `rows` at run time, which
    // `node-outputs.ts` never mentions. Correct code, and it stays unbadged.
    const graph = [
      { id: "t1", type: NodeType.TELEGRAM_TRIGGER, data: {} },
      {
        id: "gd",
        type: NodeType.GOOGLE_SHEETS_ACTION,
        data: { ref: "GOVT_DETAILS", action: "find_rows" },
      },
      code("const rows = input.GOVT_DETAILS.rows || [];\nreturn rows.length;"),
    ];
    expect(
      findDanglingRefsByNode(graph, [
        { source: "t1", target: "gd" },
        { source: "gd", target: "c1" },
      ]),
    ).toEqual([]);
  });

  it("is skipped by the per-node check too, not just the canvas walk", () => {
    expect(
      findDanglingRefs(
        { code: "return input.GHOST_1.output;" },
        reachableValues([]),
        { nodeType: NodeType.CODE },
      ),
    ).toEqual([]);
  });

  it("still checks every OTHER node type", () => {
    // The exclusion is one node type, not a general loosening.
    expect(
      findDanglingRefs({ message: "@<GHOST_1.output>@" }, reachableValues([]), {
        nodeType: NodeType.SLACK,
      }),
    ).toHaveLength(1);
  });
});

describe("stripDanglingRefsInNodes", () => {
  const found = [
    {
      nodeId: "s1",
      nodeRef: "SLACK_1",
      nodeType: NodeType.SLACK as string,
      refs: [
        {
          ref: "AI_TEXT_1",
          path: "AI_TEXT_1.output",
          field: "message",
        },
      ],
    },
  ];

  it("strips only the listed nodes", () => {
    const before = [
      {
        id: "s1",
        type: NodeType.SLACK,
        data: { ref: "SLACK_1", message: "Result: @<AI_TEXT_1.output>@" },
      },
      {
        id: "s2",
        type: NodeType.SLACK,
        data: { ref: "SLACK_2", message: "Result: @<AI_TEXT_1.output>@" },
      },
    ];
    const after = stripDanglingRefsInNodes(before, found);

    expect(after[0].data.message).toBe("Result: ");
    // s2 wasn't in the list — it is downstream of AI_TEXT_1 and perfectly fine.
    expect(after[1]).toBe(before[1]);
  });

  it("keeps the node's other data, including its ref", () => {
    const after = stripDanglingRefsInNodes(
      [
        {
          id: "s1",
          type: NodeType.SLACK,
          data: {
            ref: "SLACK_1",
            channel: "#general",
            message: "@<AI_TEXT_1.output>@",
          },
        },
      ],
      found,
    );
    expect(after[0].data).toEqual({
      ref: "SLACK_1",
      channel: "#general",
      message: "",
    });
  });

  it("returns the same array when nothing was found", () => {
    const nodes = [{ id: "s1", type: NodeType.SLACK, data: {} }];
    expect(stripDanglingRefsInNodes(nodes, [])).toBe(nodes);
  });
});

describe("stripDanglingRefs", () => {
  // PATHS, not steps: removal has to match exactly what detection reported.
  const dead = new Set(["SLACK_9.ts"]);

  it("removes only the dead token, keeping the prose around it", () => {
    expect(
      stripDanglingRefs({ text: "Summarize @<SLACK_9.ts>@ politely" }, dead),
    ).toEqual({ text: "Summarize  politely" });
  });

  it("leaves reachable references untouched", () => {
    expect(
      stripDanglingRefs(
        { text: "@<AI_TEXT_1.output>@ and @<SLACK_9.ts>@" },
        dead,
      ),
    ).toEqual({ text: "@<AI_TEXT_1.output>@ and " });
  });

  it("reaches into arrays and nested objects", () => {
    expect(
      stripDanglingRefs(
        { rows: [{ value: "@<SLACK_9.ts>@" }, { value: "keep" }] },
        dead,
      ),
    ).toEqual({ rows: [{ value: "" }, { value: "keep" }] });
  });

  it("preserves non-string values, including explicit undefined", () => {
    // The submitted values of a form carry `undefined` for cleared optional
    // fields; a JSON round-trip would drop those keys and turn "clear this" into
    // "leave it as it was" when the node spreads them over its saved data.
    const config = {
      credentialId: undefined,
      retries: 3,
      enabled: false,
      when: null,
    };
    expect(stripDanglingRefs(config, dead)).toEqual(config);
    expect("credentialId" in (stripDanglingRefs(config, dead) as object)).toBe(
      true,
    );
  });

  it("returns the input untouched when there is nothing to strip", () => {
    const config = { text: "@<AI_TEXT_1.output>@" };
    expect(stripDanglingRefs(config, new Set())).toBe(config);
  });
});
