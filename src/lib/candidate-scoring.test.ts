import { describe, expect, it } from "vitest";
import {
  type ResolvedScoringRule,
  type ScoringThresholds,
  scoreCandidate,
} from "./candidate-scoring";

const thresholds: ScoringThresholds = { shortlist: 60, review: 35 };

describe("scoreCandidate", () => {
  it("sums matched points and shortlists at/above the threshold", () => {
    const rules: ResolvedScoringRule[] = [
      {
        label: "React",
        operator: "contains",
        value: "React",
        points: 25,
        fieldValue: "React, TypeScript",
      },
      {
        label: "TypeScript",
        operator: "contains",
        value: "TypeScript",
        points: 15,
        fieldValue: "React, TypeScript",
      },
      {
        label: "Experience",
        operator: "greater_than",
        value: "0",
        points: 20,
        fieldValue: 2,
      },
    ];
    const result = scoreCandidate(rules, thresholds);
    expect(result.score).toBe(60);
    expect(result.decision).toBe("SHORTLIST");
    expect(result.knockout).toBe(false);
  });

  it("routes a middling score to REVIEW", () => {
    const rules: ResolvedScoringRule[] = [
      {
        label: "Experience",
        operator: "greater_than",
        value: "0",
        points: 20,
        fieldValue: 1,
      },
      {
        label: "Cover letter",
        operator: "is_not_empty",
        points: 20,
        fieldValue: "I am keen",
      },
      {
        label: "Java",
        operator: "contains",
        value: "Java",
        points: 25,
        fieldValue: "Python",
      },
    ];
    const result = scoreCandidate(rules, thresholds);
    expect(result.score).toBe(40);
    expect(result.decision).toBe("REVIEW");
  });

  it("rejects below the review threshold", () => {
    const rules: ResolvedScoringRule[] = [
      {
        label: "React",
        operator: "contains",
        value: "React",
        points: 25,
        fieldValue: "COBOL",
      },
    ];
    const result = scoreCandidate(rules, thresholds);
    expect(result.score).toBe(0);
    expect(result.decision).toBe("REJECT");
  });

  it("knocks out on a failed required rule regardless of score", () => {
    const rules: ResolvedScoringRule[] = [
      {
        label: "Top skill",
        operator: "contains",
        value: "React",
        points: 100,
        fieldValue: "React",
      },
      {
        label: "Work authorization",
        operator: "equals",
        value: "yes",
        points: 0,
        required: true,
        fieldValue: "no",
      },
    ];
    const result = scoreCandidate(rules, thresholds);
    expect(result.knockout).toBe(true);
    expect(result.decision).toBe("REJECT");
    expect(result.reasons.some((r) => r.includes("Work authorization"))).toBe(
      true,
    );
  });

  it("explains the decision in the first reason line", () => {
    const rules: ResolvedScoringRule[] = [
      {
        label: "React",
        operator: "contains",
        value: "React",
        points: 70,
        fieldValue: "React",
      },
    ];
    const result = scoreCandidate(rules, thresholds);
    expect(result.reasons[0]).toContain("SHORTLIST");
  });
});
