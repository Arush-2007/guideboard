import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { serializeSnapshot } from "./snapshot";

const node = (overrides: Partial<Node> & Pick<Node, "id">): Node => ({
  type: "HTTP_REQUEST",
  position: { x: 0, y: 0 },
  data: {},
  ...overrides,
});

const edge = (overrides: Partial<Edge> & Pick<Edge, "id">): Edge => ({
  source: "a",
  target: "b",
  ...overrides,
});

describe("serializeSnapshot", () => {
  it("ignores volatile React Flow fields (selected, dragging, measured, sizes)", () => {
    const clean = serializeSnapshot([node({ id: "n1" })], []);
    const noisy = serializeSnapshot(
      [
        node({
          id: "n1",
          selected: true,
          dragging: true,
          measured: { width: 80, height: 80 },
          width: 80,
          height: 80,
        } as Node),
      ],
      [],
    );
    expect(noisy).toBe(clean);
  });

  it("treats sub-grid position jitter as no change but a real move as a change", () => {
    const base = serializeSnapshot(
      [node({ id: "n1", position: { x: 100, y: 100 } })],
      [],
    );
    const jitter = serializeSnapshot(
      [node({ id: "n1", position: { x: 103, y: 97 } })],
      [],
    );
    const moved = serializeSnapshot(
      [node({ id: "n1", position: { x: 140, y: 100 } })],
      [],
    );
    expect(jitter).toBe(base);
    expect(moved).not.toBe(base);
  });

  it("is insensitive to node/edge array order", () => {
    const a = serializeSnapshot(
      [node({ id: "n1" }), node({ id: "n2" })],
      [edge({ id: "e1" }), edge({ id: "e2" })],
    );
    const b = serializeSnapshot(
      [node({ id: "n2" }), node({ id: "n1" })],
      [edge({ id: "e2" }), edge({ id: "e1" })],
    );
    expect(b).toBe(a);
  });

  it("is insensitive to data key order", () => {
    const a = serializeSnapshot(
      [node({ id: "n1", data: { method: "GET", endpoint: "/x" } })],
      [],
    );
    const b = serializeSnapshot(
      [node({ id: "n1", data: { endpoint: "/x", method: "GET" } })],
      [],
    );
    expect(b).toBe(a);
  });

  it("detects config (data) changes", () => {
    const a = serializeSnapshot(
      [node({ id: "n1", data: { endpoint: "/x" } })],
      [],
    );
    const b = serializeSnapshot(
      [node({ id: "n1", data: { endpoint: "/y" } })],
      [],
    );
    expect(b).not.toBe(a);
  });

  it("detects added / removed nodes and edges", () => {
    const one = serializeSnapshot([node({ id: "n1" })], []);
    const two = serializeSnapshot([node({ id: "n1" }), node({ id: "n2" })], []);
    expect(two).not.toBe(one);

    const noEdge = serializeSnapshot(
      [node({ id: "n1" }), node({ id: "n2" })],
      [],
    );
    const withEdge = serializeSnapshot(
      [node({ id: "n1" }), node({ id: "n2" })],
      [edge({ id: "e1", source: "n1", target: "n2" })],
    );
    expect(withEdge).not.toBe(noEdge);
  });

  it("detects edge endpoint / handle changes", () => {
    const a = serializeSnapshot(
      [],
      [edge({ id: "e1", sourceHandle: "source-1" })],
    );
    const b = serializeSnapshot(
      [],
      [edge({ id: "e1", sourceHandle: "source-2" })],
    );
    expect(b).not.toBe(a);
  });

  it("freezes the baseline against later in-place data mutation", () => {
    // Reproduces the real bug: a config dialog mutating node.data in place must
    // not retroactively change a baseline captured before the edit.
    const data: Record<string, unknown> = { subject: "Heyy" };
    const baseline = serializeSnapshot([node({ id: "n1", data })], []);

    data.subject = "Changed";

    const after = serializeSnapshot([node({ id: "n1", data })], []);
    expect(after).not.toBe(baseline);
  });
});
