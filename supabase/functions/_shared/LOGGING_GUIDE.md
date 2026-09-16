# Logging in Edge Functions

There are two independent logging paths, and it matters which one you reach for:

| Path | Module | Destination | Survives the request? |
|---|---|---|---|
| **Structured console logs** | `_shared/logger.ts` | stdout/stderr → Supabase Edge Function logs | No — ephemeral, subject to platform retention |
| **Database logs** | `_shared/usage-tracker.ts`, `_shared/agent-logging.ts`, `_shared/audit.ts` | Postgres tables | Yes — queryable in SQL, surfaced in super-admin UI |

Use the console logger for operational tracing and debugging. Use the database
tables when the data needs to be aggregated, reported on, or read weeks later.

> **Never call `console.*` directly in an edge function.** Everything goes
> through `logger` (or the `context-logger` wrappers, which delegate to it), so
> that adding a real log sink later is a change to `logger.ts` alone rather
> than a sweep across every function. The only `console.*` calls in
> `supabase/functions/` are inside `logger.ts` itself — that *is* the sink.

> **There is no Elasticsearch, Logflare sink, or Kibana in this project.** An
> earlier version of `logger.ts` shipped logs to an Elasticsearch cluster via
> `ELASTICSEARCH_URL` / `ELASTICSEARCH_API_KEY`. That code is gone. Those
> secrets are not read anywhere, and there are no `lovable-logs-YYYY-MM`
> indices to query.

---

## 1. Structured console logging (`logger.ts`)

### Where the output actually goes

- **Production** — Supabase Dashboard → Edge Functions → *your function* → Logs.
- **Local** (`npm run dev:local`) — the terminal running the functions server.

Every level is a plain `console.*` call under the hood, formatted as:

```
[INFO] [derive-group-weaknesses] Request received { method: "POST", ... }
```

### `withLogging` — the standard wrapper

54 of the 55 functions use this, and new functions should too. Wire it up in
`index.ts` and keep the business logic in a separate `handler.ts`:

```typescript
// index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { withLogging } from "../_shared/logger.ts";
import { handler } from "./handler.ts";

serve(withLogging("derive-group-weaknesses", handler));
```

`withLogging` gives you, with no further code:

- a trace ID per request — reused from the inbound `x-trace-id` header if
  present, otherwise generated, and echoed back on the response so callers can
  correlate;
- `logger.init()` already called, so `logger.*` works anywhere downstream
  without re-initialising;
- request logging including a parsed body (JSON, `text/*`, or form data),
  **with secrets and minor-PII redacted** — see below;
- response logging with status and duration, at `error` for 5xx, `warn` for
  4xx, `info` otherwise;
- dedicated auth-failure records on 401/403 and on auth-shaped thrown errors —
  IP, user agent, origin, path, and a masked token, for security monitoring;
- unhandled exceptions logged with a stack trace, then re-thrown.

### Redaction

Because `withLogging` logs whole request and response bodies, `logger.ts`
scrubs them first. `redactSensitive` runs at the single choke point inside
`Logger.log()`, so it covers `logRequest`, `logResponse` **and** every direct
`logger.*` call — you do not need to remember it at the call site.

Any key whose name (lower-cased, non-alphanumerics stripped) is in
`SENSITIVE_KEYS`, or ends with `password` / `token` / `secret` / `apikey` /
`privatekey` / `credential`, has its value replaced by `[REDACTED]`. The walk
recurses into nested objects and arrays and stops at depth 8.

Two deliberate carve-outs, both pinned by
`__tests__/logger-redaction.test.ts`:

- **`sessionId` is not redacted.** It is a study-session / chat-session row id
  on the tutoring surfaces, not an auth credential, and it is load-bearing for
  tracing a tutoring flow.
- **`attempted_token_masked`** (in `logAuthFailure`) is named to sidestep the
  `*token` suffix rule on purpose. `maskToken` has already reduced it to 15 of
  ~800 characters. Never put a raw token under that name.

`email` and `fullName` are **not** redacted — they are the practical
correlation keys when debugging one user's report, and `audit_logs` already
retains `actor_email` by design. `dateOfBirth`, `fatherName` and friends *are*
redacted: this is a school product, so those fields describe minors.

Redaction is key-based, so a `text/plain` body that happens to contain a secret
is not covered — a bare string has no key to match on.

A function whose handler is an inline closure doesn't need a `handler.ts` split
to get wrapped — `withLogging` takes any `(req) => Promise<Response>`, so you
can wrap in place:

```typescript
Deno.serve(withLogging("accept-invitation", async (req) => {
  // ...
}));
```

### The one function that isn't wrapped

`export-data` calls `logger.init("export-data")` at the top of its handler
instead. It returns the entire multi-table dump as a single `application/json`
body, and `withLogging` would buffer that whole thing to a string (see the
caveat below) purely to log a `[response too large]` placeholder. The explicit
`init()` gets the function name and trace ID without the memory cost.

**A handler that calls `init()` itself must not also be wrapped** — `withLogging`
calls `init()` too, and the second call would mint a fresh trace ID, decorrelating
the handler's logs from the request log and the `x-trace-id` response header.

**One behavioural caveat:** to log a JSON response body, `withLogging` reads the
response to text and rebuilds it. Bodies over 10,000 characters are logged as a
placeholder but still returned intact. Non-JSON responses have their body
stream passed through untouched — so **streaming JSON responses will be
buffered**, not streamed, if the wrapper sees `application/json`.

### Log levels

```typescript
logger.debug(message, metadata?)
logger.info(message, metadata?)
logger.warn(message, metadata?)
logger.error(message, metadata?)
logger.exception(errorOrMessage, messageOrError?, metadata?)
```

There is no level filtering — `debug` is emitted in production like everything
else.

#### Choosing between `warn` and `error`

The rule that matters operationally: **`error` means the caller did not get
what they asked for.** A failure the code recovers from — a retried request, a
fallback that worked, a degraded-but-served response — is a `warn`.

This is not stylistic. `error` volume is the thing you would alert or build an
SLO on, so logging a recovered blip at `error` makes the rate reflect provider
turbulence rather than user-visible failure, and an alert that fires on healthy
traffic gets muted.

`openai-client.ts` is the worked example. Every retry loop there used to emit
`logError("OpenAI API error")` on *every* attempt, including ones that then
succeeded, and retry *exhaustion* emitted nothing at all — so a single
recovered 429 looked worse than a call that gave up after four attempts. It now
goes through one helper, `logOpenAIAttemptFailure`:

| Situation | Level | Message |
|---|---|---|
| Attempt failed, another will follow | `warn` | `OpenAI API error — retrying` |
| Retryable, but the budget is gone | `error` | `OpenAI API error — retries exhausted` |
| Not retryable (fatal 4xx, 402) | `error` | `OpenAI API error` |

Every line carries `failure_class` (`rate_limited` / `transient_400` /
`server_error` / `payment_required` / `fatal`), `attempts_made` and
`max_attempts`; the retry lines add `retry_in_ms`. `attempts_made` is what
separates "failed immediately" from "burned 70s of backoff first". Provider
error text is truncated at 500 characters so one response cannot dominate a
line.

Levels are pinned by `__tests__/openai-client-log-levels.test.ts` — it asserts
on the console method actually used, since that is what an alert keys on.

`exception()` accepts either argument order (`(err, "message")` or
`("message", err)`) and attaches `error_name` / `error_message` /
`stack_trace`.

### Ambient context

Set institution/course/user once and every later log line on that request
carries it. 23 handlers do this right after resolving the course:

```typescript
logger.setContext({ courseId, institutionId, userId });
logger.info("Deriving weaknesses");   // includes the context automatically
```

`setContext` merges rather than replaces.

> ⚠️ **`logger` is a module-level singleton, so `functionName`, `traceId`, and
> `context` are per-isolate, not per-request.** A warm isolate serving
> concurrent requests can interleave them — context set by one request may be
> attached to another's log lines. It's fine for debugging; don't build
> anything load-bearing on the trace ID's exclusivity.

### Timing

```typescript
const endTimer = logger.startTimer("openai-api-call");
const response = await fetch("https://api.openai.com/...");
const ms = endTimer();   // logs "openai-api-call completed" with duration_ms, returns it
```

### `flush()` is a no-op

`await logger.flush()` still exists and is safe to call — it does nothing. It
was needed when logs were batched and shipped over the network. Existing call
sites are harmless; don't add new ones.

---

## 2. Context-aware wrappers (`context-logger.ts`)

`log` / `logError` / `logWarn` / `logDebug` behave like `console.*` but parse
the stack trace to prefix `[file:line] [function]` and attach a `log_context`
object. Used by `openai-client.ts`, `moderation.ts`, and
`moderation-middleware.ts`.

```typescript
import { log } from "../_shared/context-logger.ts";
log("Calling OpenAI", { model });   // → [openai-client.ts:142] [callOpenAI] Calling OpenAI
```

These delegate to `logger`, so they land in the same place. Stack parsing is
best-effort and degrades to an unprefixed message. For new code prefer
`logger.*` directly and name the operation in the message — it's cheaper and
doesn't depend on stack-frame shape.

Reach for these instead of `logger.*` in a module that already uses them (so a
file stays internally consistent), or in a shared module that takes an
*injected* logger. `moderation-middleware.ts` is the second case: its `logger`
is an optional caller-supplied parameter, so `logger?.warn?.(…)` fires only when
a caller passes one. Its unconditional records go through `logWarn`.

---

## 3. Database-persisted logs

### `ai_usage_logs` — what a call consumed, and why it was made that way

**One row per HTTP attempt**, not per call. A call that is rate-limited twice
and then succeeds writes three rows. That matters because retries are the most
common reason usage jumps, and an `incomplete` response burns its output tokens
in full before being retried — so folding the attempts together understates the
call by exactly the consumption you are trying to find.

Each row carries three groups of columns:

| Group | Columns | Answers |
|---|---|---|
| **Consumption** | `input_tokens`, `input_tokens_cached`, `output_tokens`, `output_tokens_reasoning`, `total_tokens` | how much it used |
| **Decision** | `feature`, `policy_key`, `policy_version`, `model_tier`, `model_requested`, `model`, `reasoning_effort`, `prompt_id`, `prompt_version`, `file_count`, `background_mode` | why this model |
| **Attempt** | `outcome`, `attempt_number`, `http_status`, `error_message`, `response_time_ms`, `api_latency_ms`, `poll_wait_ms`, `status` | how it went |

`model_requested` is what we asked for; `model` is what the response says
answered. A divergence means OpenAI aliased or substituted the model, which
silently changes both quality and rate.

`response_time_ms` is total wall clock. For a background call, `api_latency_ms`
is the POST alone and `poll_wait_ms` is the wait — the POST returns in about a
second while the work happens during polling, so the split is the difference
between "the model is slow" and "the queue is long".

#### No money is recorded, deliberately

There is no cost column, and no rate table anywhere in this repo. **Do not add
one.**

Token counts are facts the API reports and they stay true forever. A dollar
figure is a fact about a price list on a particular day, and it goes stale the
moment OpenAI reprices — silently, because nothing fails when a rate is wrong.
This is not hypothetical: the frontend rate map that preceded this had already
drifted, reporting `$0` for gpt-5.6-sol, gpt-5.6-terra, gpt-5.5 and gpt-5.2,
which made the study-guide path — the heaviest in the product — look free. It
also recomputed on every page load, so a repricing retroactively rewrote what
previous months had "cost".

Keeping such a table current for every callable model is real maintenance work
that buys an approximation nobody should bill against anyway. Multiply tokens by
current rates outside the app, where the number can be current. The OpenAI
dashboard is the source of truth for billing.

Two consequences to know when reading the data:

- **Cached input tokens are a *subset* of `input_tokens`**, not an addition to
  them. Same for reasoning tokens inside `output_tokens`. Adding them on top
  double-counts.
- **`media.study-image` rows carry little or no token count.** Image generation
  is billed per image, so volume and latency are what those rows offer.

#### Naming the decision

Model choice lives in `_shared/model-policy.ts`, not at the call site. Spread
`modelFor()` and the decision columns fill themselves in:

```typescript
import { modelFor } from "../_shared/model-policy.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";

const result = await callOpenAIStructured({
  ...modelFor("materials.flashcards"),   // model + reasoningEffort + policy
  promptText: FLASHCARDS_SYSTEM_PROMPT,
  structuredOutput: FLASHCARDS_OUTPUT_SCHEMA,
  usageContext: createUsageContext("generate-flashcards", {
    promptKey: "flashcard_generation",
    institutionId,
    courseId,
    userId,
  }),
});
```

Override after the spread to deviate for one call (`{ ...policy,
reasoningEffort: "high" }`). The row then records the effort actually sent
beside the policy it departed from, which is what makes the deviation findable.

**Forget `usageContext` and the call simply won't appear in usage reporting** —
nothing errors. `promptKey` falls back to the saved-prompt id, or NULL for a
local prompt; it deliberately no longer falls back to a label with the model
baked into it, since the model has its own column.

Call `trackAIUsage` directly only when you are outside the client's return path
entirely. Two functions are: `moderate-study-image` (which posts an
`input_image` part the shared client does not model) and `generate-study-image`
(which uses `/v1/images/generations`). Both use `externalPolicy()` or a
`modelFor()` policy and track by hand. Note that `extractUsageData()` returns
`null` for a response with no `id`, so guard before passing it on, and use
`failedAttemptUsage()` for an attempt that never got a response.

Fire-and-forget throughout: insert failures are logged and swallowed, never
thrown — a usage row must never be the reason a generation fails. RLS lets
super admins read everything and institution admins read their own
institution's rows. Surfaced at **`/super-admin/usage`**, where "Usage by Model"
shows what answered and "Why this model" groups the same token volume by the
decision behind it.

### `agent_interaction_logs` — full agent traces

`logInteraction()` in `agent-logging.ts` captures a multi-agent turn end to end:
user message, incoming state, evaluator/planner/presenter outputs, final
response, language, first-message flag, response time. Written by the tutoring
turn (`chat` / `chat-stream`), under the surface's own `function_name` —
`socratic-chat` for the open-question surface, `study-tutor` for the study
session. Those are the `ChatSubject.functionName` values, and they are what
every historical row carries; the endpoints they were named after are gone
(#1441), the log categories are not.

**Gated at runtime.** Check the flag before logging — it reads `system_config`
key `agent_verbose_logging` (renamed from `ta_agent_verbose_logging`), which
ships `{"enabled": false}`:

```typescript
if (await isVerboseLoggingEnabled(supabase)) {
  await logInteraction(supabase, { function_name: "study-tutor", trace_id, ... });
}
```

Viewable and togglable at **`/super-admin/agent-logs`** — no migration or
redeploy needed to turn it on. These rows contain full student prompts and
model reasoning, which is why it defaults off.

### `audit_logs` — durable trail for sensitive admin actions

`recordAudit()` in `audit.ts` writes one row per privileged action —
`user.create`, `user.delete`, `user.password_reset`, `user.bulk_invite`,
`user.invite`, `data.export`, `data.preview` — with actor, target, institution,
and non-identifying metadata.

```typescript
import { recordAudit } from "../_shared/audit.ts";

await recordAudit({
  action: "data.export",
  actorUserId, actorEmail, institutionId,
  metadata: { tables: tablesToExport.length },
});
```

Unlike the other two, **`await` it before returning** — the runtime may kill the
isolate the moment the response is sent. It still swallows every error
internally, so auditing can never fail the action it records.

The `AuditAction` union is kept in sync with a CHECK constraint on
`audit_logs.action` (migration `20260725064858_audit_logs.sql`), so adding an
action means touching both. `metadata` must not carry PII — explicitly so for
`user.delete`, where the point is to record that a deletion happened without
retaining what was deleted.

### Related audit tables

`student_admin_notes_audit` and `login_history` are written by triggers and
application code, not by these utilities.

---

## Debugging a request end to end

1. Find the failing request in the Supabase Edge Function logs and grab its
   `trace_id` (also returned to the client as the `x-trace-id` response
   header).
2. Grep the function's logs for that `trace_id` to get the full sequence.
3. Join to spend and latency:
   ```sql
   select * from ai_usage_logs where trace_id = '<trace-id>';
   ```
4. For agent functions, if verbose logging was on:
   ```sql
   select * from agent_interaction_logs where trace_id = '<trace-id>';
   ```

Console logs are the only record of general execution flow, and they age out —
if something needs to be answerable next month, put it in a table.

---

## Auth-failure logging lives in `logger.ts`

Failed-auth records are emitted by the module-private `logAuthFailure()` and
`maskToken()` helpers in `logger.ts`, called by `withLogging` on 401/403
responses and on auth-shaped exceptions. That is the only implementation —
change it there.

> ⚠️ This covers **edge-function** auth only. The primary login path is the
> browser talking to Supabase Auth directly (`useAuth.signIn`), which never
> reaches an edge function — so a failed password attempt is recorded nowhere.
> `login_history` is written on success only. There is currently no
> brute-force or credential-stuffing signal in the system.

There used to be a second, unreferenced copy in `_shared/auth-logger.ts`
(exporting `logAuthFailure`, `maskToken`, `extractUserIdFromToken`,
`checkAuthHeaders`, `logSuspiciousActivity`). It was deleted; if you find a
reference to it in an old branch or doc, it's stale. `extractUserIdFromToken`
and `logSuspiciousActivity` had no equivalent in `logger.ts` and were never
called anywhere — resurrect them from git history if you actually need them.
