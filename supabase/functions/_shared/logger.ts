/**
 * Centralized logging utility for edge functions
 * Outputs structured logs to console for the Supabase dashboard
 */

import { reportException } from "./error-tracking.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  institutionId?: string;
  institutionName?: string;
  courseId?: string;
  courseName?: string;
  userId?: string;
}

// ============================================
// REDACTION
// ============================================

export const REDACTED = "[REDACTED]";

/**
 * Key names whose values must never reach the log sink. `withLogging` logs
 * whole request and response bodies, so without this list a call to
 * `admin-set-user-password` writes the new password to the Supabase edge logs
 * in cleartext, and `create-user` writes a password plus a (frequently
 * under-age) student's date of birth and father's name.
 *
 * Keys are matched after normalisation — lower-cased with every non
 * alphanumeric character stripped — so `newPassword`, `new_password` and
 * `new-password` all collapse to `newpassword` and match a single entry.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  // Credentials and secrets.
  "password",
  "passwd",
  "newpassword",
  "oldpassword",
  "currentpassword",
  "confirmpassword",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "secret",
  "clientsecret",
  "authorization",
  "auth",
  "jwt",
  "privatekey",
  "credential",
  "credentials",
  "cookie",
  "setcookie",
  // NB: `sessionId` is deliberately absent. In this codebase it is a
  // study_sessions / chat-session row id on the tutoring surfaces, not an
  // auth credential, and it is load-bearing for tracing a tutoring flow. The
  // actual session-bearing secrets are covered by `cookie` and the token
  // entries above.
  // PII. This is a school product, so these fields describe minors —
  // `create-user` and `bulk-invite-users` both accept them in the request
  // body. `email` and `fullName` are deliberately NOT redacted: they are the
  // practical correlation keys when debugging a specific user's report, and
  // `audit_logs` already retains `actor_email` by design. This exemption is a
  // RECORDED DECISION, carried in the operator's private compliance records
  // under "known gaps the operator should decide on" (those records are not in
  // this repository — see docs/compliance/README.md), and revisited whenever a
  // data-processing agreement is negotiated. Add them here the day a DPA
  // requires it, and update those records in the same change.
  "dateofbirth",
  "birthdate",
  "dob",
  "fathername",
  "mothername",
  "parentname",
]);

/**
 * Suffix match for the composed names the exact list cannot enumerate —
 * `invitation_token`, `openaiApiKey`, `service_role_secret`, and so on.
 */
const SENSITIVE_KEY_SUFFIXES: readonly string[] = [
  "password",
  "passwd",
  "token",
  "secret",
  "apikey",
  "privatekey",
  "credential",
];

/** Bound the walk so a pathologically nested body cannot stall the isolate. */
const MAX_REDACT_DEPTH = 8;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Recursively replace the value of every sensitive key with `[REDACTED]`.
 *
 * Returns primitives untouched, so a `text/plain` request body that happens to
 * contain a secret is NOT covered — redaction is key-based, and a bare string
 * has no key to match on.
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return "[redaction depth exceeded]";

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactSensitive(entry, depth + 1);
  }
  return out;
}

class Logger {
  private functionName: string = "unknown";
  private traceId: string | null = null;
  private context: LogContext = {};

  /**
   * Initialize the logger for a given edge function
   * Call this at the start of your edge function
   */
  init(functionName: string, traceId?: string): void {
    this.functionName = functionName;
    this.traceId = traceId || crypto.randomUUID();
    console.log(`[Logger] Initialized for ${functionName}, trace: ${this.traceId}`);
  }

  /**
   * Set context for all subsequent log entries (institution, course, etc.)
   */
  setContext(context: LogContext): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Get the current trace ID for request correlation
   */
  getTraceId(): string {
    return this.traceId || crypto.randomUUID();
  }

  /**
   * Create a log entry and output to console
   */
  private log(
    level: LogLevel,
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    const consoleMethod = level === "error" ? console.error :
                          level === "warn" ? console.warn :
                          level === "debug" ? console.debug : console.log;
    const contextMeta = Object.keys(this.context).length > 0 ? this.context : undefined;
    const combined = (contextMeta || metadata) ? { ...contextMeta, ...metadata } : undefined;
    // Redact centrally rather than at each call site: this is the single choke
    // point every logger.* call, logRequest and logResponse funnels through, so
    // a future `logger.info("…", { password })` is covered without the author
    // having to remember.
    const safe = combined ? redactSensitive(combined) : undefined;
    consoleMethod(`[${level.toUpperCase()}] [${this.functionName}] ${message}`, safe || "");
  }

  /**
   * Flush is a no-op — kept for backwards compatibility
   */
  async flush(): Promise<void> {
    // No-op
  }

  /**
   * Log a debug message
   */
  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log("debug", message, metadata);
  }

  /**
   * Log an info message
   */
  info(message: string, metadata?: Record<string, unknown>): void {
    this.log("info", message, metadata);
  }

  /**
   * Log a warning message
   */
  warn(message: string, metadata?: Record<string, unknown>): void {
    this.log("warn", message, metadata);
  }

  /**
   * Log an error message
   */
  error(message: string, metadata?: Record<string, unknown>): void {
    this.log("error", message, metadata);
  }

  /**
   * Log an error with stack trace
   */
  exception(
    messageOrError: string | unknown,
    errorOrMetadata?: unknown | Record<string, unknown>,
    metadata?: Record<string, unknown>
  ): void {
    let message: string;
    let err: Error;
    let meta: Record<string, unknown> | undefined;

    if (typeof messageOrError === "string") {
      message = messageOrError;
      err = errorOrMetadata instanceof Error ? errorOrMetadata : new Error(String(errorOrMetadata));
      meta = metadata;
    } else {
      err = messageOrError instanceof Error ? messageOrError : new Error(String(messageOrError));
      message = typeof errorOrMetadata === "string" ? errorOrMetadata : err.message;
      meta = typeof errorOrMetadata === "object" && !(errorOrMetadata instanceof Error)
        ? errorOrMetadata as Record<string, unknown>
        : metadata;
    }

    this.log("error", message, {
      ...meta,
      exception: {
        error_name: err.name,
        error_message: err.message,
        stack_trace: err.stack,
      },
    });
  }

  /**
   * Create a timer for measuring operation duration
   * Returns duration in ms when called
   */
  startTimer(operation: string): () => number {
    const startTime = performance.now();
    return () => {
      const duration = Math.round(performance.now() - startTime);
      this.info(`${operation} completed`, { duration_ms: duration });
      return duration;
    };
  }

  /**
   * Log request start with common metadata and optional body
   */
  async logRequest(req: Request, additionalMetadata?: Record<string, unknown>): Promise<void> {
    let requestBody: unknown = undefined;

    // Clone the request to read body without consuming it
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      try {
        const clonedReq = req.clone();
        const contentType = req.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
          requestBody = await clonedReq.json();
        } else if (contentType.includes("text/")) {
          requestBody = await clonedReq.text();
        } else if (contentType.includes("form")) {
          const formData = await clonedReq.formData();
          requestBody = Object.fromEntries(formData.entries());
        }
      } catch {
        requestBody = "[unable to parse body]";
      }
    }

    this.info("Request received", {
      method: req.method,
      url: req.url,
      user_agent: req.headers.get("user-agent"),
      origin: req.headers.get("origin"),
      request_body: requestBody,
      ...additionalMetadata, // user_id, course_id, institution_id can be passed here
    });
  }

  /**
   * Log response with status, duration, and optional body
   */
  logResponse(
    status: number,
    durationMs: number,
    responseBody?: unknown,
    additionalMetadata?: Record<string, unknown>
  ): void {
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    this.log(level, "Response sent", {
      status_code: status,
      duration_ms: durationMs,
      response_body: responseBody,
      ...additionalMetadata,
    });
  }
}

// Export a singleton instance
export const logger = new Logger();

/**
 * Extract IP address from request headers
 */
function getClientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
         req.headers.get("x-real-ip") ||
         req.headers.get("cf-connecting-ip") ||
         "unknown";
}

/**
 * Mask a JWT token for logging (show first and last few characters)
 */
function maskToken(token: string | null): string | undefined {
  if (!token) return undefined;
  const cleanToken = token.replace(/^Bearer\s+/i, "");
  if (cleanToken.length < 20) return "[invalid-format]";
  return `${cleanToken.substring(0, 10)}...${cleanToken.substring(cleanToken.length - 5)}`;
}

/**
 * Log authentication failure with detailed context for security monitoring
 */
function logAuthFailure(
  req: Request,
  reason: string,
  statusCode: number,
  responseBody?: unknown
): void {
  const authHeader = req.headers.get("authorization");
  const url = new URL(req.url);

  logger.warn("Authentication failed", {
    auth_failure: true,
    reason: reason,
    status_code: statusCode,
    ip_address: getClientIp(req),
    user_agent: req.headers.get("user-agent") || "unknown",
    origin: req.headers.get("origin") || req.headers.get("referer") || "unknown",
    path: url.pathname,
    method: req.method,
    // Named `…_masked` so it does not trip the `*token` redaction rule in
    // `redactSensitive`. The value is already reduced to 15 of ~800 characters
    // by `maskToken`, which is enough to correlate repeated attempts without
    // being replayable. Never put a raw token here — under any name ending in
    // `token` it would be redacted, and under this one it would leak.
    attempted_token_masked: maskToken(authHeader),
    x_client_info: req.headers.get("x-client-info") || undefined,
    apikey_present: !!req.headers.get("apikey"),
    authorization_present: !!authHeader,
    response_hint: typeof responseBody === 'object' && responseBody !== null
      ? (responseBody as Record<string, unknown>).error || (responseBody as Record<string, unknown>).message
      : undefined,
  });
}

/**
 * Wrapper function to add logging to an edge function handler
 * Automatically logs request/response and monitors for auth failures
 */
export function withLogging(
  functionName: string,
  handler: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") || crypto.randomUUID();
    const startTime = performance.now();

    logger.init(functionName, traceId);
    await logger.logRequest(req);

    try {
      const response = await handler(req);
      const duration = Math.round(performance.now() - startTime);

      // Read response body once and store it for both logging and returning
      const contentType = response.headers.get("content-type") || "";
      let responseBodyText: string | null = null;
      let responseBody: unknown = undefined;

      // Read the body as text ONLY if it's JSON (for logging)
      // For non-JSON responses, preserve the original body stream
      if (contentType.includes("application/json")) {
        try {
          responseBodyText = await response.text();
          if (responseBodyText.length < 10000) {
            responseBody = JSON.parse(responseBodyText);
          } else {
            responseBody = `[response too large: ${responseBodyText.length} chars]`;
          }
        } catch {
          responseBody = "[unable to parse response body]";
        }
      }

      // Handler-built 5xx responses (caught-and-wrapped errors) never reach
      // the catch below, so report them here. Deliberately a fixed
      // classification with no body-derived detail: handlers put upstream
      // provider text in their error fields, which must stay inside the
      // payload bound documented in error-tracking.ts. The trace_id tag
      // correlates the report to the full hint in the Supabase edge logs.
      if (response.status >= 500) {
        reportException(
          new Error(`HTTP ${response.status}`),
          { functionName, traceId, status: response.status },
        );
      }

      // Log authentication failures for security monitoring
      if (response.status === 401 || response.status === 403) {
        const reason = response.status === 401
          ? "unauthorized_missing_or_invalid_token"
          : "forbidden_insufficient_permissions";
        logAuthFailure(req, reason, response.status, responseBody);
      }

      logger.logResponse(response.status, duration, responseBody);

      // Add trace ID to response headers for correlation
      const headers = new Headers(response.headers);
      headers.set("x-trace-id", traceId);

      return new Response(responseBodyText !== null ? responseBodyText : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      const duration = Math.round(performance.now() - startTime);

      // Check if the error is auth-related
      const errorMessage = (error as Error).message?.toLowerCase() || "";
      if (errorMessage.includes("unauthorized") ||
          errorMessage.includes("jwt") ||
          errorMessage.includes("token") ||
          errorMessage.includes("auth")) {
        logAuthFailure(req, `auth_exception: ${errorMessage}`, 401);
      }

      logger.exception(error as Error, "Unhandled exception in edge function");
      logger.logResponse(500, duration, { error: (error as Error).message });
      reportException(error, { functionName, traceId, status: 500 });

      throw error;
    }
  };
}
