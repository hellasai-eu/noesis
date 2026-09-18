/**
 * Test harness for edge function handler-level testing.
 *
 * Provides a URL-routing fetch mock that intercepts both Supabase client
 * calls and external API calls (OpenAI, Resend, ConvertAPI), plus env var
 * mocking and a request builder.
 *
 * Usage:
 *   const harness = createTestHarness({ routes: [...] });
 *   try {
 *     const res = await harness.invoke(handler, { email: "a@b.com" });
 *     assertEquals(res.status, 200);
 *   } finally {
 *     harness.cleanup();
 *   }
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface FetchLogEntry {
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface MockRoute {
  /** Return true if this route should handle the request */
  match: (url: string, init?: RequestInit) => boolean;
  /** Produce the mock response */
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

export interface HarnessOptions {
  /** Environment variable overrides (merged with defaults) */
  envVars?: Record<string, string>;
  /** Ordered list of routes — first match wins */
  routes?: MockRoute[];
  /** Fallback for unmatched requests (defaults to 404) */
  defaultResponse?: () => Response;
}

export interface TestHarness {
  /** Call a handler with a JSON body */
  invoke: (
    handler: (req: Request) => Promise<Response>,
    body: unknown,
    options?: { headers?: Record<string, string>; method?: string },
  ) => Promise<Response>;
  /** Every fetch call made during the test */
  fetchLog: FetchLogEntry[];
  /** Restore original globals — MUST be called in finally block */
  cleanup: () => void;
}

// ── Default env vars ───────────────────────────────────────────────────

export const DEFAULT_ENV: Record<string, string> = {
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  SUPABASE_ANON_KEY: "test-anon-key",
  OPENAI_API_KEY: "test-openai-key",
  RESEND_API_KEY: "test-resend-key",
  CONVERTAPI_SECRET: "test-convertapi-secret",
  // The product identity (`_shared/brand.ts`). A deployment supplies these as
  // Supabase secrets; a handler that sends mail refuses to without them, so
  // the harness stands in for a configured deployment. Tests that care about
  // the unconfigured case override them with `env: { … }`.
  BRAND_NAME: "Test Brand",
  BRAND_FROM_EMAIL: "no-reply@test.example",
  BRAND_CONTACT_EMAIL: "hello@test.example",
  BRAND_APP_URL: "https://app.test.example",
};

// ── Harness factory ────────────────────────────────────────────────────

export function createTestHarness(options: HarnessOptions = {}): TestHarness {
  const savedFetch = globalThis.fetch;
  const savedEnvGet = Deno.env.get;

  const envMap = { ...DEFAULT_ENV, ...options.envVars };
  const routes = options.routes ?? [];
  const fetchLog: FetchLogEntry[] = [];

  // Mock Deno.env.get
  Deno.env.get = (key: string): string | undefined => envMap[key];

  // Mock globalThis.fetch with URL-routing
  globalThis.fetch = async (
    input: string | Request | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let bodyStr: string | undefined;
    if (init?.body) {
      bodyStr = typeof init.body === "string"
        ? init.body
        : init.body instanceof URLSearchParams
        ? init.body.toString()
        : "(non-string body)";
    }

    // Lower-cased header names, so a test can assert which client made a call
    // (anon-key + caller token vs service role) without guessing casing.
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    if (rawHeaders) {
      new Headers(rawHeaders as HeadersInit).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    }

    fetchLog.push({ url, method, body: bodyStr, headers });

    for (const route of routes) {
      if (route.match(url, init)) {
        return route.respond(url, init);
      }
    }

    // Default: 404 or custom fallback
    if (options.defaultResponse) return options.defaultResponse();
    return new Response(JSON.stringify({ error: "No mock route matched", url }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };

  return {
    fetchLog,

    async invoke(handler, body, invokeOpts) {
      const req = new Request("http://localhost:54321/functions/v1/test", {
        method: invokeOpts?.method ?? "POST",
        headers: {
          "Content-Type": "application/json",
          ...invokeOpts?.headers,
        },
        body: JSON.stringify(body),
      });
      return handler(req);
    },

    cleanup() {
      globalThis.fetch = savedFetch;
      Deno.env.get = savedEnvGet;
    },
  };
}

// ── Route builders ─────────────────────────────────────────────────────

/** Match Supabase REST API calls to a specific path pattern */
export function supabaseRoute(
  pathPattern: string,
  response: unknown,
  opts?: { status?: number; method?: string },
): MockRoute {
  return {
    match: (url, init) => {
      if (!url.includes(pathPattern)) return false;
      if (opts?.method) {
        const method = init?.method ?? "GET";
        return method.toUpperCase() === opts.method.toUpperCase();
      }
      return true;
    },
    respond: () =>
      new Response(JSON.stringify(response), {
        status: opts?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** Match Supabase auth admin API calls */
export function supabaseAuthRoute(
  pathSuffix: string,
  response: unknown,
  opts?: { status?: number; method?: string },
): MockRoute {
  return supabaseRoute(`/auth/v1/admin/${pathSuffix}`, response, opts);
}

/** Match OpenAI API calls */
export function openaiRoute(
  pathPattern: string,
  response: unknown,
  opts?: { status?: number; method?: string },
): MockRoute {
  return {
    match: (url, init) => {
      if (!url.includes("api.openai.com")) return false;
      if (!url.includes(pathPattern)) return false;
      if (opts?.method) {
        const method = init?.method ?? "GET";
        return method.toUpperCase() === opts.method.toUpperCase();
      }
      return true;
    },
    respond: () =>
      new Response(JSON.stringify(response), {
        status: opts?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** Match Resend email API calls */
export function resendRoute(
  response?: unknown,
  opts?: { status?: number },
): MockRoute {
  return {
    match: (url) => url.includes("api.resend.com"),
    respond: () =>
      new Response(JSON.stringify(response ?? { id: "mock-email-id" }), {
        status: opts?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** Match ConvertAPI calls */
export function convertApiRoute(
  response?: unknown,
  opts?: { status?: number },
): MockRoute {
  return {
    match: (url) => url.includes("convertapi.com"),
    respond: () =>
      new Response(JSON.stringify(response ?? { Files: [] }), {
        status: opts?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

// ── Caller gates (#1135) ───────────────────────────────────────────────

/** Header for a request that carries a bearer token. */
export const BEARER_AUTH = { Authorization: "Bearer test-token" };

export const TEST_CALLER_ID = "00000000-0000-4000-8000-00000000ca11";
export const TEST_INSTITUTION_ID = "00000000-0000-4000-8000-0000000015de";

/**
 * Everything a handler needs to see an authenticated caller who manages the
 * course and a subject who is a student on it.
 *
 * Spread this FIRST in a test's `routes` so it wins the `/rest/v1/courses`
 * match: the course row carries `institution_id` for the authorization lookup
 * and `language` for `getEffectiveLanguage`, so one row satisfies both and a
 * test's own courses route stays a harmless fallback.
 *
 * Pair with `BEARER_AUTH` — the routes alone do nothing without a token on the
 * request.
 */
export function authorizedCallerRoutes(
  opts: { subjectEnrolled?: boolean; language?: string; institutionId?: string } = {},
): MockRoute[] {
  const {
    subjectEnrolled = true,
    language = "en",
    // Override when the handler under test also reads the course row and cares
    // which institution it names.
    institutionId = TEST_INSTITUTION_ID,
  } = opts;
  const jsonRoute = (match: MockRoute["match"], body: unknown): MockRoute => ({
    match,
    respond: () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  return [
    jsonRoute(
      (url) => url.includes("/auth/v1/user"),
      { id: TEST_CALLER_ID, email: "caller@test.local" },
    ),
    jsonRoute(
      (url, init) => url.includes("/rest/v1/courses") && (init?.method ?? "GET") === "GET",
      { institution_id: institutionId, language },
    ),
    jsonRoute((url) => url.includes("/rest/v1/rpc/is_institution_admin"), true),
    jsonRoute(
      (url) => url.includes("/rest/v1/offerings") && url.includes("course_id="),
      [{ class_id: "class-1" }],
    ),
    // Narrowed to the gate's own lookup, which is the only `class_enrollments`
    // read filtered by a class_id IN-list (`enrolledClassIdsForCourse`).
    // Handlers read the same table for their own purposes with different
    // filters, so an unqualified match here would answer those too and hand
    // them the wrong shape.
    jsonRoute(
      (url) => url.includes("/rest/v1/class_enrollments") && url.includes("class_id=in."),
      subjectEnrolled ? [{ class_id: "class-1" }] : [],
    ),
  ];
}

// ── Response helpers ───────────────────────────────────────────────────

/** Parse a handler Response into { status, body } for easy assertions */
// deno-lint-ignore no-explicit-any
export async function parseResponse(
  response: Response,
): Promise<{ status: number; body: any }> {
  const body = await response.json();
  return { status: response.status, body };
}
