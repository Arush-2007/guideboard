import { describe, expect, it } from "vitest";
import { ExecutionStatus } from "@/generated/prisma";
import {
  executionRefetchInterval,
  executionsListRefetchInterval,
  RUNNING_POLL_MS,
} from "./poll-interval";

const NOW = 1_000_000;

describe("executionsListRefetchInterval", () => {
  it("returns false when data is undefined (not loaded yet)", () => {
    expect(executionsListRefetchInterval(undefined)).toBe(false);
  });

  it("returns false for an empty page", () => {
    expect(executionsListRefetchInterval({ items: [] })).toBe(false);
  });

  it("returns false when every row is terminal and no grace window", () => {
    expect(
      executionsListRefetchInterval({
        items: [
          { status: ExecutionStatus.SUCCESS },
          { status: ExecutionStatus.FAILED },
        ],
      }),
    ).toBe(false);
  });

  it("polls when at least one row is still RUNNING", () => {
    expect(
      executionsListRefetchInterval({
        items: [
          { status: ExecutionStatus.SUCCESS },
          { status: ExecutionStatus.RUNNING },
          { status: ExecutionStatus.FAILED },
        ],
      }),
    ).toBe(RUNNING_POLL_MS);
  });

  it("polls inside the grace window even when every row is terminal", () => {
    expect(
      executionsListRefetchInterval(
        { items: [{ status: ExecutionStatus.SUCCESS }] },
        NOW + 5000,
        NOW,
      ),
    ).toBe(RUNNING_POLL_MS);
  });

  it("stops once the grace window has elapsed and nothing is RUNNING", () => {
    expect(
      executionsListRefetchInterval(
        { items: [{ status: ExecutionStatus.SUCCESS }] },
        NOW - 1,
        NOW,
      ),
    ).toBe(false);
  });

  it("keeps polling a RUNNING row even after the grace window elapses", () => {
    expect(
      executionsListRefetchInterval(
        { items: [{ status: ExecutionStatus.RUNNING }] },
        NOW - 1,
        NOW,
      ),
    ).toBe(RUNNING_POLL_MS);
  });
});

describe("executionRefetchInterval", () => {
  it("returns false when data is undefined (not loaded yet)", () => {
    expect(executionRefetchInterval(undefined)).toBe(false);
  });

  it("polls while the execution is RUNNING", () => {
    expect(executionRefetchInterval({ status: ExecutionStatus.RUNNING })).toBe(
      RUNNING_POLL_MS,
    );
  });

  it("stops polling once the execution is terminal", () => {
    expect(executionRefetchInterval({ status: ExecutionStatus.SUCCESS })).toBe(
      false,
    );
    expect(executionRefetchInterval({ status: ExecutionStatus.FAILED })).toBe(
      false,
    );
  });
});
