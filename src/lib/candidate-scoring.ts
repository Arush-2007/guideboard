/**
 * Pure candidate-scoring core for the `CANDIDATE_SCORING` node's built-in
 * `rules` provider. Kept React/Inngest/Prisma-free so it can be unit-tested
 * directly (like `compare.ts`, `sheet-row.ts`, `processSchedulePoll`) — the
 * executor stays a thin orchestrator that templates each rule's field/value
 * against the run context, then calls `scoreCandidate`.
 *
 * Model: a weighted scorecard. Each rule compares a (resolved) field value with
 * the same operator set the Condition/Switch nodes use (via `evaluateCondition`),
 * adding its `points` when it matches. A `required` rule is a knockout — if it
 * does NOT match, the candidate is rejected regardless of score, mirroring an
 * ATS's knockout questions. The total is mapped to a decision by two thresholds.
 */

import {
  type CompareOperator,
  evaluateCondition,
} from "@/features/executions/lib/compare";

export type ScoringDecision = "SHORTLIST" | "REVIEW" | "REJECT";

/** A scorecard rule as authored in the dialog (field/value still un-resolved). */
export type ScoringRule = {
  id?: string;
  /** Human label used to explain the decision (e.g. "React experience"). */
  label?: string;
  /** Upstream field reference (e.g. `@<applicant.skills>@`). */
  field: string;
  operator: CompareOperator;
  /** Comparison value (literal or reference). */
  value?: string;
  /** Points added when the rule matches. */
  points: number;
  /** Knockout: when true, a non-match forces REJECT regardless of score. */
  required?: boolean;
};

/** A rule whose `field` has been resolved against the run context. */
export type ResolvedScoringRule = Omit<ScoringRule, "field"> & {
  /** The templated field value this run carried. */
  fieldValue: unknown;
  /** The templated comparison value. */
  value?: string;
};

export type ScoringThresholds = {
  /** Score at/above which the candidate is SHORTLIST. */
  shortlist: number;
  /** Score at/above which the candidate is REVIEW (below shortlist). */
  review: number;
};

export type ScoringResult = {
  score: number;
  decision: ScoringDecision;
  /** Human-readable explanation lines, surfaced as the node's `reasons`. */
  reasons: string[];
  /** True when a required (knockout) rule failed. */
  knockout: boolean;
};

function ruleName(rule: ResolvedScoringRule, index: number): string {
  return rule.label?.trim() || rule.id || `Rule ${index + 1}`;
}

/**
 * Evaluates the scorecard. Pure: same inputs → same result. `score` is the raw
 * sum of matched points (thresholds are absolute point values, not a 0–100
 * percentage), so a config can use any scale it likes as long as the thresholds
 * match it.
 */
export function scoreCandidate(
  rules: ResolvedScoringRule[],
  thresholds: ScoringThresholds,
): ScoringResult {
  let score = 0;
  let knockout = false;
  const reasons: string[] = [];

  rules.forEach((rule, index) => {
    const matched = evaluateCondition(
      rule.operator,
      rule.fieldValue,
      rule.value ?? "",
    );
    const name = ruleName(rule, index);

    if (matched) {
      score += rule.points;
      reasons.push(`${name} (+${rule.points})`);
    } else if (rule.required) {
      knockout = true;
      reasons.push(`Missing required: ${name}`);
    }
  });

  let decision: ScoringDecision;
  if (knockout) {
    decision = "REJECT";
  } else if (score >= thresholds.shortlist) {
    decision = "SHORTLIST";
  } else if (score >= thresholds.review) {
    decision = "REVIEW";
  } else {
    decision = "REJECT";
  }

  reasons.unshift(
    knockout
      ? `Rejected on a required knockout rule (score ${score}).`
      : `Score ${score} → ${decision}.`,
  );

  return { score, decision, reasons, knockout };
}
