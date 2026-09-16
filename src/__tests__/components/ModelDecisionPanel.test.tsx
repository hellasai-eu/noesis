import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ModelDecisionPanel,
  computeModelDecisions,
  type DecisionLogRow,
  type ModelDecisionData,
} from "@/components/super-admin/ModelDecisionPanel";

function log(overrides: Partial<DecisionLogRow> = {}): DecisionLogRow {
  return {
    feature: "study-guide",
    policy_key: "study-guide.outline",
    policy_version: 1,
    model_tier: "flagship",
    model: "gpt-5.6-sol",
    outcome: "success",
    total_tokens: 1000,
    output_tokens: 200,
    response_time_ms: 4000,
    ...overrides,
  };
}

describe("computeModelDecisions", () => {
  it("returns hasData=false for an empty window", () => {
    const result = computeModelDecisions([]);
    expect(result.hasData).toBe(false);
    expect(result.byFeature).toEqual([]);
    expect(result.byPolicy).toEqual([]);
  });

  it("groups tutoring's two functions under one feature", () => {
    // The point of the feature column: "why is tutoring usage up" should not
    // require knowing that tutoring means study-tutor AND socratic-chat.
    const result = computeModelDecisions([
      log({ feature: "tutoring", policy_key: "tutoring.study-tutor", total_tokens: 2000 }),
      log({ feature: "tutoring", policy_key: "tutoring.socratic-chat", total_tokens: 1000 }),
      log({ feature: "study-guide", total_tokens: 500 }),
    ]);

    const tutoring = result.byFeature.find((f) => f.feature === "tutoring");
    expect(tutoring?.calls).toBe(2);
    expect(tutoring?.totalTokens).toBe(3000);
    // Heaviest first, so the thing that moved is at the top.
    expect(result.byFeature[0].feature).toBe("tutoring");
    // But the two policies stay separable underneath.
    expect(result.byPolicy.map((p) => p.policyKey)).toContain("tutoring.study-tutor");
    expect(result.byPolicy.map((p) => p.policyKey)).toContain("tutoring.socratic-chat");
  });

  it("reports tokens per call, which is what a tier comparison turns on", () => {
    // Call counts alone hide the thing a tier or effort change actually moves.
    const result = computeModelDecisions([
      log({ policy_key: "study-guide.outline", total_tokens: 3000 }),
      log({ policy_key: "study-guide.outline", total_tokens: 1000 }),
    ]);
    const outline = result.byPolicy.find((p) => p.policyKey === "study-guide.outline");
    expect(outline?.calls).toBe(2);
    expect(outline?.totalTokens).toBe(4000);
    expect(outline?.avgTokensPerCall).toBe(2000);
    expect(outline?.avgLatencyMs).toBe(4000);
  });

  it("surfaces a policy that changed mid-window instead of averaging over it", () => {
    const result = computeModelDecisions([
      log({ policy_version: 1, model: "gpt-5.6-sol", model_tier: "flagship" }),
      log({ policy_version: 2, model: "gpt-5.6-terra", model_tier: "balanced" }),
    ]);
    const outline = result.byPolicy[0];
    expect(outline.policyVersions).toEqual([1, 2]);
    expect(outline.models).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(outline.tiers).toEqual(["balanced", "flagship"]);
  });

  it("attributes tokens burned by attempts that did not succeed", () => {
    // The gap this whole change exists to close: an incomplete attempt burns
    // its output tokens, is billed, and is then retried. Before, only the
    // successful retry was logged at all. A rate-limited attempt burns nothing
    // but still counts as an attempt.
    const result = computeModelDecisions([
      log({ outcome: "rate_limited", total_tokens: 0, output_tokens: 0 }),
      log({ outcome: "incomplete", total_tokens: 9000, output_tokens: 8000 }),
      log({ outcome: "success", total_tokens: 1200, output_tokens: 200 }),
    ]);

    expect(result.failedAttempts).toBe(2);
    expect(result.successfulCalls).toBe(1);
    expect(result.wastedTokens).toBe(9000);
    expect(result.totalTokens).toBe(10200);
    expect(result.wasted.map((w) => w.outcome)).toEqual(["incomplete", "rate_limited"]);
    expect(result.wasted[0].totalTokens).toBe(9000);
    expect(result.wasted[1].totalTokens).toBe(0);
  });

  it("treats a row with no outcome as the success it must have been", () => {
    // Rows predating the outcome column exist only because they succeeded —
    // failures were never written. Counting them as failures would invent waste.
    const result = computeModelDecisions([log({ outcome: null })]);
    expect(result.failedAttempts).toBe(0);
    expect(result.successfulCalls).toBe(1);
  });

  it("counts rows with no policy rather than dropping them silently", () => {
    const result = computeModelDecisions([
      log({ feature: null, policy_key: null, total_tokens: 9999 }),
      log({ total_tokens: 1000 }),
    ]);
    expect(result.unattributedCalls).toBe(1);
    expect(result.byPolicy).toHaveLength(1);
    // Still counted in the window's total — excluded from attribution, not
    // from the usage figure.
    expect(result.totalTokens).toBe(10999);
  });

  it("treats a NULL token count as zero, never as NaN", () => {
    const result = computeModelDecisions([log({ total_tokens: null, output_tokens: null })]);
    expect(result.totalTokens).toBe(0);
    expect(Number.isNaN(result.totalTokens)).toBe(false);
    expect(result.byFeature[0].outputTokens).toBe(0);
  });
});

function makeData(overrides: Partial<ModelDecisionData> = {}): ModelDecisionData {
  return {
    byFeature: [
      { feature: "tutoring", calls: 120, totalTokens: 2_000_000, outputTokens: 400_000 },
      { feature: "study-guide", calls: 20, totalTokens: 900_000, outputTokens: 300_000 },
    ],
    byPolicy: [
      {
        policyKey: "study-guide.outline",
        feature: "study-guide",
        models: ["gpt-5.6-sol"],
        tiers: ["flagship"],
        policyVersions: [1],
        calls: 10,
        totalTokens: 450_000,
        avgTokensPerCall: 45_000,
        avgLatencyMs: 42_000,
      },
    ],
    wasted: [{ outcome: "incomplete", attempts: 3, totalTokens: 24_000 }],
    successfulCalls: 137,
    failedAttempts: 3,
    wastedTokens: 24_000,
    totalTokens: 2_900_000,
    unattributedCalls: 0,
    hasData: true,
    ...overrides,
  };
}

describe("ModelDecisionPanel", () => {
  it("renders empty state when hasData is false", () => {
    render(<ModelDecisionPanel data={makeData({ hasData: false })} />);
    expect(screen.getByTestId("model-decision-empty-state")).toHaveTextContent(
      "No AI calls in this window",
    );
  });

  it("renders a row per feature and per policy", () => {
    render(<ModelDecisionPanel data={makeData()} />);
    expect(screen.getByTestId("model-decision-feature-tutoring")).toHaveTextContent("2.00M");
    expect(screen.getByTestId("model-decision-policy-study-guide.outline")).toHaveTextContent(
      "gpt-5.6-sol",
    );
    expect(screen.getByTestId("model-decision-policy-study-guide.outline")).toHaveTextContent(
      "flagship",
    );
    // Tokens per call is the figure a tier comparison reads.
    expect(screen.getByTestId("model-decision-policy-study-guide.outline")).toHaveTextContent(
      "45.0K",
    );
  });

  it("states what share of tokens went on failed attempts", () => {
    render(<ModelDecisionPanel data={makeData()} />);
    const summary = screen.getByTestId("model-decision-waste-summary");
    expect(summary).toHaveTextContent("3 of 140 attempts");
    expect(summary).toHaveTextContent("0.8%");
    expect(screen.getByTestId("model-decision-waste-incomplete")).toHaveTextContent("24.0K");
  });

  it("says so plainly when nothing failed", () => {
    render(
      <ModelDecisionPanel data={makeData({ wasted: [], failedAttempts: 0, wastedTokens: 0 })} />,
    );
    expect(screen.getByTestId("model-decision-no-waste")).toHaveTextContent(
      "succeeded on its first try",
    );
  });

  it("discloses unattributed rows rather than presenting a partial view as whole", () => {
    render(<ModelDecisionPanel data={makeData({ unattributedCalls: 7 })} />);
    expect(screen.getByTestId("model-decision-unattributed")).toHaveTextContent(
      "7 calls in this window carry no policy",
    );
  });
});
