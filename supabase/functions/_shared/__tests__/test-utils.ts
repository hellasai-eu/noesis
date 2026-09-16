/**
 * Test utilities for moderation and LLM tests
 */

export interface MockFetchOptions {
  status?: number;
  body?: any;
  delay?: number;
  failTimes?: number; // Number of times to fail before succeeding
}

let fetchCallCount = 0;

/**
 * Reset fetch call counter (call before each test)
 */
export function resetFetchCallCount(): void {
  fetchCallCount = 0;
}

/**
 * Get current fetch call count
 */
export function getFetchCallCount(): number {
  return fetchCallCount;
}

/**
 * Increment fetch call count (for manual tracking in tests)
 */
export function incrementFetchCallCount(): void {
  fetchCallCount++;
}

/**
 * Create a mock fetch function for testing
 */
export function createMockFetch(options: MockFetchOptions | MockFetchOptions[] = {}) {
  const optsArray = Array.isArray(options) ? options : [options];
  let currentIndex = 0;

  return async (url: string | Request | URL, init?: RequestInit): Promise<Response> => {
    fetchCallCount++;
    const currentOpts = optsArray[currentIndex] || optsArray[optsArray.length - 1];
    
    if (currentOpts.delay) {
      await new Promise(resolve => setTimeout(resolve, currentOpts.delay));
    }

    // If failTimes is set, fail that many times before succeeding
    if (currentOpts.failTimes && fetchCallCount <= currentOpts.failTimes) {
      currentIndex = Math.min(currentIndex + 1, optsArray.length - 1);
      return new Response(
        JSON.stringify({ error: "Rate limited" }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }

    currentIndex = Math.min(currentIndex + 1, optsArray.length - 1);
    
    return new Response(
      JSON.stringify(currentOpts.body || {}),
      {
        status: currentOpts.status || 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  };
}

/**
 * Mock moderation API response
 */
export function createModerationResponse(flagged: boolean, categories: Record<string, boolean> = {}) {
  const allCategories = {
    hate: false,
    "hate/threatening": false,
    harassment: false,
    "harassment/threatening": false,
    "self-harm": false,
    "self-harm/intent": false,
    "self-harm/instructions": false,
    sexual: false,
    "sexual/minors": false,
    violence: false,
    "violence/graphic": false,
    ...categories,
  };

  const categoryScores = Object.keys(allCategories).reduce((acc, key) => {
    const categoryKey = key as keyof typeof allCategories;
    acc[key] = allCategories[categoryKey] ? 0.9 : 0.1;
    return acc;
  }, {} as Record<string, number>);

  return {
    id: "modr-test123",
    model: "omni-moderation-latest",
    results: [{
      flagged,
      categories: allCategories,
      category_scores: categoryScores,
    }],
  };
}

