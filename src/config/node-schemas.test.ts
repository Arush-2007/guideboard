import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "./node-schemas";

describe("node config schema registry", () => {
  // Guards the architecture's invariant: every NodeType must have a schema
  // registered so parseNodeConfig never hits its "no schema" throw at runtime.
  it("has a schema registered for every NodeType", () => {
    for (const type of Object.values(NodeType)) {
      expect(() => parseNodeConfig(type, {})).not.toThrow(
        /No node config schema registered/,
      );
    }
  });

  it("accepts a valid http request config", () => {
    expect(() =>
      parseNodeConfig(NodeType.HTTP_REQUEST, {
        endpoint: "https://example.com",
        method: "GET",
      }),
    ).not.toThrow();
  });

  it("rejects an http request config with an invalid method", () => {
    expect(() =>
      parseNodeConfig(NodeType.HTTP_REQUEST, {
        endpoint: "https://example.com",
        method: "FETCH",
      }),
    ).toThrow(/Invalid node.data/);
  });

  it("rejects a discord config missing its webhook url", () => {
    expect(() => parseNodeConfig(NodeType.DISCORD, { content: "hi" })).toThrow(
      /Invalid node.data/,
    );
  });
});
