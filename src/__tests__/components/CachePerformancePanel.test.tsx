import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CachePerformancePanel,
  computeCachePerformance,
  getCachePctColor,
  type CachePerformanceData,
} from "@/components/super-admin/CachePerformancePanel";

function makeData(overrides: Partial<CachePerformanceData> = {}): CachePerformanceData {
  return {
    overallCachePct: 50,
    overallInputTokens: 1_000_000,
    overallInputTokensCached: 500_000,
    perFunction: [
      {
        functionName: "generate-questions",
        totalCalls: 100,
        totalInputTokens: 800_000,
        totalInputTokensCached: 400_000,
        cachePct: 50,
      },
      {
        functionName: "summarize-material",
        totalCalls: 40,
        totalInputTokens: 200_000,
        totalInputTokensCached: 100_000,
        cachePct: 50,
      },
    ],
    hasData: true,
    ...overrides,
  };
}

describe("getCachePctColor", () => {
  it("returns red below 20%", () => {
    expect(getCachePctColor(0)).toBe("red");
    expect(getCachePctColor(19.99)).toBe("red");
  });

  it("returns yellow at exactly 20%", () => {
    expect(getCachePctColor(20)).toBe("yellow");
  });

  it("returns yellow between 20% and 60%", () => {
    expect(getCachePctColor(40)).toBe("yellow");
    expect(getCachePctColor(59.99)).toBe("yellow");
  });

  it("returns green at exactly 60%", () => {
    expect(getCachePctColor(60)).toBe("green");
  });

  it("returns green above 60%", () => {
    expect(getCachePctColor(85)).toBe("green");
    expect(getCachePctColor(100)).toBe("green");
  });
});

describe("computeCachePerformance", () => {
  it("returns hasData=false when no input tokens", () => {
    const result = computeCachePerformance({});
    expect(result.hasData).toBe(false);
    expect(result.overallCachePct).toBe(0);
    expect(result.overallInputTokensCached).toBe(0);
    expect(result.perFunction).toEqual([]);
  });

  it("computes per-function and overall cache stats", () => {
    const result = computeCachePerformance({
      "fn-a": { calls: 10, inputTokens: 1000, inputTokensCached: 500 },
      "fn-b": { calls: 5, inputTokens: 200, inputTokensCached: 0 },
    });
    expect(result.hasData).toBe(true);
    expect(result.overallInputTokens).toBe(1200);
    expect(result.overallInputTokensCached).toBe(500);
    expect(result.overallCachePct).toBeCloseTo((500 * 100) / 1200);

    const fnA = result.perFunction.find((r) => r.functionName === "fn-a");
    expect(fnA?.cachePct).toBe(50);
    expect(fnA?.totalInputTokensCached).toBe(500);

    const fnB = result.perFunction.find((r) => r.functionName === "fn-b");
    expect(fnB?.cachePct).toBe(0);
    expect(fnB?.totalInputTokensCached).toBe(0);
  });

  it("avoids divide-by-zero when a function has 0 input tokens", () => {
    const result = computeCachePerformance({
      "fn-empty": { calls: 1, inputTokens: 0, inputTokensCached: 0 },
    });
    expect(result.perFunction[0].cachePct).toBe(0);
  });

  it("sorts per-function rows by input tokens desc", () => {
    const result = computeCachePerformance({
      small: { calls: 1, inputTokens: 100, inputTokensCached: 50 },
      large: { calls: 1, inputTokens: 10_000, inputTokensCached: 5_000 },
      medium: { calls: 1, inputTokens: 1_000, inputTokensCached: 500 },
    });
    expect(result.perFunction.map((r) => r.functionName)).toEqual([
      "large",
      "medium",
      "small",
    ]);
  });
});

describe("CachePerformancePanel", () => {
  it("renders empty state when hasData is false", () => {
    render(<CachePerformancePanel data={makeData({ hasData: false })} />);
    expect(screen.getByTestId("cache-empty-state")).toHaveTextContent(
      "No AI calls in this window",
    );
  });

  it("renders headline cache pct and cached token volume", () => {
    render(<CachePerformancePanel data={makeData()} />);
    expect(screen.getByTestId("overall-cache-pct")).toHaveTextContent("50.0%");
    expect(screen.getByTestId("overall-cached-tokens")).toHaveTextContent("500.0K");
  });

  it("applies red color class when below 20%", () => {
    render(<CachePerformancePanel data={makeData({ overallCachePct: 5 })} />);
    expect(screen.getByTestId("overall-cache-pct").className).toContain("text-red-600");
  });

  it("applies yellow color class between 20 and 60", () => {
    render(<CachePerformancePanel data={makeData({ overallCachePct: 45 })} />);
    expect(screen.getByTestId("overall-cache-pct").className).toContain("text-yellow-600");
  });

  it("applies green color class above 60", () => {
    render(<CachePerformancePanel data={makeData({ overallCachePct: 80 })} />);
    expect(screen.getByTestId("overall-cache-pct").className).toContain("text-green-600");
  });

  it("renders one row per function with cache pct color coding", () => {
    render(
      <CachePerformancePanel
        data={makeData({
          perFunction: [
            {
              functionName: "low-cache-fn",
              totalCalls: 10,
              totalInputTokens: 1000,
              totalInputTokensCached: 50,
              cachePct: 5,
            },
            {
              functionName: "high-cache-fn",
              totalCalls: 20,
              totalInputTokens: 2000,
              totalInputTokensCached: 1600,
              cachePct: 80,
            },
          ],
        })}
      />,
    );

    const lowRow = screen.getByTestId("cache-pct-low-cache-fn");
    expect(lowRow).toHaveTextContent("5.0%");
    expect(lowRow.className).toContain("text-red-600");

    const highRow = screen.getByTestId("cache-pct-high-cache-fn");
    expect(highRow).toHaveTextContent("80.0%");
    expect(highRow.className).toContain("text-green-600");
  });

  it("renders an accessible tooltip trigger explaining the metric", () => {
    render(<CachePerformancePanel data={makeData()} />);
    expect(
      screen.getByRole("button", { name: /cache hit rate explanation/i }),
    ).toBeInTheDocument();
  });
});
