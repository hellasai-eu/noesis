import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  UsageByModelPanel,
  computeUsageByModel,
  type UsageByModelData,
  type UsageByModelTotals,
} from "@/components/super-admin/UsageByModelPanel";

function totals(overrides: Partial<UsageByModelTotals> = {}): UsageByModelTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, ...overrides };
}

function makeData(overrides: Partial<UsageByModelData> = {}): UsageByModelData {
  return {
    rows: [
      {
        model: "gpt-5.4",
        totalCalls: 100,
        totalInputTokens: 1_000_000,
        totalOutputTokens: 200_000,
        totalTokens: 1_200_000,
      },
      {
        model: "gpt-5.4-mini",
        totalCalls: 250,
        totalInputTokens: 2_000_000,
        totalOutputTokens: 500_000,
        totalTokens: 2_500_000,
      },
    ],
    crossTab: {
      models: ["gpt-5.4", "gpt-5.4-mini"],
      functions: [
        {
          functionName: "generate-questions",
          cells: {
            "gpt-5.4": { calls: 60, totalTokens: 800_000 },
          },
        },
        {
          functionName: "generate-flashcards",
          cells: {
            "gpt-5.4-mini": { calls: 100, totalTokens: 1_500_000 },
          },
        },
      ],
    },
    hasData: true,
    ...overrides,
  };
}

describe("computeUsageByModel", () => {
  it("returns hasData=false when no models", () => {
    const result = computeUsageByModel({}, {});
    expect(result.hasData).toBe(false);
    expect(result.rows).toEqual([]);
    expect(result.crossTab.models).toEqual([]);
    expect(result.crossTab.functions).toEqual([]);
  });

  it("sums input and output tokens per model", () => {
    const result = computeUsageByModel(
      {
        "gpt-5.4": totals({
          calls: 10,
          inputTokens: 1_000_000,
          outputTokens: 200_000,
        }),
      },
      {},
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.totalTokens).toBe(1_200_000);
    expect(row.totalInputTokens).toBe(1_000_000);
    expect(row.totalOutputTokens).toBe(200_000);
    expect(row.totalCalls).toBe(10);
  });

  it("reports an unfamiliar model like any other — no rate table to miss", () => {
    // The panel used to render "\u2014" for any model absent from a hardcoded rate
    // map, which is how gpt-5.6-sol and gpt-5.5 came to look free. Tokens come
    // from the API, so a model nobody has heard of still reports its usage.
    const result = computeUsageByModel(
      {
        "mystery-llm-9000": totals({ calls: 3, inputTokens: 100, outputTokens: 50 }),
      },
      {},
    );
    expect(result.rows[0].totalTokens).toBe(150);
    expect(result.rows[0].totalCalls).toBe(3);
  });

  it("sorts rows by total tokens desc, breaking ties on output tokens", () => {
    // Output is the expensive half on every model, so between two models at
    // equal volume the one generating more is the one worth looking at.
    const result = computeUsageByModel(
      {
        light: totals({ calls: 1, inputTokens: 100_000, outputTokens: 0 }),
        heavy: totals({ calls: 1, inputTokens: 900_000, outputTokens: 100_000 }),
        "tied-but-generative": totals({ calls: 1, inputTokens: 50_000, outputTokens: 50_000 }),
      },
      {},
    );
    expect(result.rows.map((r) => r.model)).toEqual([
      "heavy",
      "tied-but-generative",
      "light",
    ]);
  });

  it("builds a sparse cross-tab keyed by function and model", () => {
    const result = computeUsageByModel(
      {
        "gpt-5.4": totals({ calls: 1, inputTokens: 100, outputTokens: 50 }),
        "gpt-5.4-mini": totals({ calls: 1, inputTokens: 100, outputTokens: 50 }),
      },
      {
        "fn-A": {
          "gpt-5.4": totals({ calls: 5, inputTokens: 1000, outputTokens: 200 }),
        },
        "fn-B": {
          "gpt-5.4-mini": totals({ calls: 8, inputTokens: 2000, outputTokens: 400 }),
        },
      },
    );
    expect(result.crossTab.models).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
    const fnA = result.crossTab.functions.find((f) => f.functionName === "fn-A");
    const fnB = result.crossTab.functions.find((f) => f.functionName === "fn-B");
    expect(fnA?.cells["gpt-5.4"]).toEqual({ calls: 5, totalTokens: 1200 });
    expect(fnA?.cells["gpt-5.4-mini"]).toBeUndefined();
    expect(fnB?.cells["gpt-5.4-mini"]).toEqual({ calls: 8, totalTokens: 2400 });
    expect(fnB?.cells["gpt-5.4"]).toBeUndefined();
  });

  it("sorts cross-tab functions by total tokens desc", () => {
    const result = computeUsageByModel(
      { "gpt-5.4": totals({ calls: 1, inputTokens: 1, outputTokens: 1 }) },
      {
        small: { "gpt-5.4": totals({ calls: 1, inputTokens: 100, outputTokens: 100 }) },
        large: { "gpt-5.4": totals({ calls: 1, inputTokens: 10_000, outputTokens: 10_000 }) },
        medium: { "gpt-5.4": totals({ calls: 1, inputTokens: 1_000, outputTokens: 1_000 }) },
      },
    );
    expect(result.crossTab.functions.map((f) => f.functionName)).toEqual([
      "large",
      "medium",
      "small",
    ]);
  });
});

describe("UsageByModelPanel", () => {
  it("renders empty state when hasData is false", () => {
    render(<UsageByModelPanel data={makeData({ hasData: false, rows: [] })} />);
    expect(screen.getByTestId("usage-by-model-empty-state")).toHaveTextContent(
      "No AI calls in this window",
    );
  });

  it("renders one row per model in the primary table", () => {
    render(<UsageByModelPanel data={makeData()} />);
    expect(screen.getByTestId("usage-by-model-row-gpt-5.4")).toBeInTheDocument();
    expect(screen.getByTestId("usage-by-model-row-gpt-5.4-mini")).toBeInTheDocument();
    expect(screen.getByTestId("usage-by-model-tokens-gpt-5.4")).toHaveTextContent("1.20M");
    expect(screen.getByTestId("usage-by-model-tokens-gpt-5.4-mini")).toHaveTextContent("2.50M");
  });

  it("renders a model it has never seen before without special-casing", () => {
    // The old panel rendered "—" for anything absent from its hardcoded rate
    // map, which is how gpt-5.6-sol and gpt-5.5 came to look free. Token counts
    // come from the API, so an unfamiliar model reports its usage like any other.
    render(
      <UsageByModelPanel
        data={makeData({
          rows: [
            {
              model: "mystery-llm",
              totalCalls: 1,
              totalInputTokens: 10,
              totalOutputTokens: 5,
              totalTokens: 15,
            },
          ],
          crossTab: { models: [], functions: [] },
        })}
      />,
    );
    expect(screen.getByTestId("usage-by-model-tokens-mystery-llm")).toHaveTextContent("15");
  });

  it("hides the cross-tab toggle entirely when there are no functions", () => {
    render(
      <UsageByModelPanel
        data={makeData({ crossTab: { models: ["gpt-5.4"], functions: [] } })}
      />,
    );
    expect(screen.queryByTestId("usage-by-model-crosstab-toggle")).toBeNull();
  });

  it("hides the cross-tab table by default and reveals it on toggle", () => {
    render(<UsageByModelPanel data={makeData()} />);
    expect(screen.queryByTestId("usage-by-model-crosstab")).toBeNull();

    fireEvent.click(screen.getByTestId("usage-by-model-crosstab-toggle"));

    expect(screen.getByTestId("usage-by-model-crosstab")).toBeInTheDocument();
    expect(
      screen.getByTestId("usage-by-model-crosstab-row-generate-questions"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("usage-by-model-crosstab-row-generate-flashcards"),
    ).toBeInTheDocument();
  });

  it("renders sparse cross-tab cells (empty when a function did not call that model)", () => {
    render(<UsageByModelPanel data={makeData()} />);
    fireEvent.click(screen.getByTestId("usage-by-model-crosstab-toggle"));

    const populatedQ = screen.getByTestId(
      "usage-by-model-crosstab-cell-generate-questions-gpt-5.4",
    );
    expect(populatedQ).toHaveTextContent("800.0K");
    expect(populatedQ).toHaveTextContent("60");

    const emptyQ = screen.getByTestId(
      "usage-by-model-crosstab-cell-generate-questions-gpt-5.4-mini",
    );
    expect(emptyQ).toBeEmptyDOMElement();

    const populatedF = screen.getByTestId(
      "usage-by-model-crosstab-cell-generate-flashcards-gpt-5.4-mini",
    );
    expect(populatedF).toHaveTextContent("1.50M");

    const emptyF = screen.getByTestId(
      "usage-by-model-crosstab-cell-generate-flashcards-gpt-5.4",
    );
    expect(emptyF).toBeEmptyDOMElement();
  });

  it("renders an accessible tooltip trigger on the token column", () => {
    render(<UsageByModelPanel data={makeData()} />);
    expect(
      screen.getByRole("button", { name: /token count explanation/i }),
    ).toBeInTheDocument();
  });
});
