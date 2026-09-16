# Edge function authorization audit

Companion to issue #926. Classifies every function under `supabase/functions/`
as **public by design**, **internal-only**, or **privileged** (browser-invocable
and touching tenant data), records the caller gate each one actually has, and
names the gaps.

Re-run the classification after adding a function — an unclassified handler is
an unreviewed one.

## Why this document exists

Two facts combine into the platform's only real access boundary living inside
each handler:

1. **Every function but one has `verify_jwt = false`** in `supabase/config.toml`.
   The gateway performs no authentication at all; a request with no
   `Authorization` header reaches the handler. The exception is
   `academic-year-rollover`, which has no `[functions.*]` entry and so inherits
   the CLI default of `verify_jwt = true` — an omission rather than a decision,
   and no protection worth copying: the anon key ships in the frontend bundle
   and satisfies that check (see below).
2. **Every function that touches the database does so with the service-role
   key**, which bypasses RLS. The table policies that isolate institutions are
   not evaluated for edge-function traffic.

So the RLS work protecting `institutions`, `classes`, and student data does
nothing for an edge function. If the handler does not check the caller, nothing
does. This is exactly how `create-user` came to accept anonymous requests that
minted institution admins (#926).

## Why not just `verify_jwt = true`?

Because it gates nothing, and believing otherwise is worse than leaving it off.

The gateway check verifies that a credential is present and signed by the
project. The anon/publishable key satisfies it — and that key ships in the
frontend bundle, so it is public by construction. Turning the flag on raises the
bar from "send no `Authorization` header" to "copy a string out of the JS
bundle." It would not have stopped #926, and it stops none of the gaps below.

It is not literally worthless: it turns away header-less scanners. But it is not
an access boundary, and adopting it as one invites the assumption that the
handlers are covered when they are not. Considered and rejected in #7.

## The three classes

| Class | Definition | Required gate |
|---|---|---|
| **Public** | Must serve anonymous callers — pre-auth surfaces and unauthenticated forms. | No caller identity. Rate limiting and input sanitisation instead. |
| **Internal** | Driven by cron, the job runner, or another function; never by a browser. | Documented as internal, with a bounded blast radius. |
| **Privileged** | Reachable from the browser and reads or writes tenant data, spends money, or mutates storage. | Resolve the caller from the bearer token, then authorize them against the resource — **not** against an id from the request body. |

## The correct pattern

`admin-set-user-password`, `delete-user`, and (since #926) `create-user` are the
references. In outline:

```ts
const authHeader = req.headers.get("Authorization");
if (!authHeader) return json({ error: "Unauthorized" }, 401);

const token = authHeader.replace("Bearer ", "");
const { data: { user: callerUser }, error } = await supabaseAdmin.auth.getUser(token);
if (error || !callerUser) return json({ error: "Unauthorized" }, 401);

// Authorize against the RESOURCE, using the caller's own id.
if (!(await isInstitutionAdmin(supabaseAdmin, callerUser.id, institutionId))) {
  return json({ error: "…" }, 403);
}
```

Three rules the gaps below all break in one way or another. Each is stated with
the handler that broke it — all three are now fixed, and they are kept here
because the shape recurs, not because the example is still live:

- **The caller's id comes from the token, never from the body.** A body-supplied
  `userId` is whatever the attacker types. `manage-vector-store` checked
  `is_super_admin` against a body-supplied id, which authorizes nothing —
  the caller picks the id being checked (fixed in #1135).
- **Use the RPC helpers, not a raw `user_institutions` read.** `is_institution_admin`
  and the `_shared/institution-authz.ts` wrappers exclude suspended
  memberships; a direct `role = 'admin'` read does not (#1082, and again in
  #1152 where a second copy of the same helper had survived).
- **Authenticating for the audit trail is not a gate.** `create-user` (#926) and
  `send-invitation` (#1136) both resolved the caller *only* to decide whether to
  write an audit row, and performed the action either way.

An alternative, equally valid gate is to build a **caller-scoped client** with
the anon key and the caller's `Authorization` header, then let an RLS helper
(`can_manage_offering`) decide. `analyze-quiz`, `analyze-study-guide`,
`cluster-students-by-performance`, `derive-group-weaknesses`, and
`enqueue-followup-practice` do this correctly.

## Classification

Gate column:

- **✅ authenticated + authorized** — caller resolved from the token and checked
  against the resource. Note what this does *not* assert: that the check
  excludes a **suspended** member. The three study-guide generators were ✅
  throughout this audit while their shared helper read
  `user_institutions.role` directly and accepted a bare `course_instructors`
  row (#1152, a second copy of #1082). If a row here is ✅, verify it goes
  through `institution-authz.ts` before trusting it on that axis.

  It does not assert **granularity** either. `verifyQuestionEnrollment` was ✅
  for two graders while ignoring `offering_questions.group_id`, so a question
  published to one group was answerable by the whole class (#1158). The
  section-scoped equivalent is called out under "Method and its limits" below.
- **⚠️ authenticated only** — caller resolved, but nothing is checked against
  the resource (or the identity is used solely for logging/audit).
- **❌ none** — no caller identity is established.
- **n/a** — public or internal by design.

| Function | Class | Gate | Notes |
|---|---|---|---|
| academic-year-rollover | Privileged | ✅ | The one function with no `config.toml` entry, so it inherits `verify_jwt = true`. Gated internally regardless. |
| accept-invitation | Privileged | ✅ | Fixed in #1135. Caller from the token; the invitation must be addressed to their email. |
| admin-reset-user-mfa | Privileged | ✅ | Mirrors admin-set-user-password: super-admin, or institution-admin of an institution the target belongs to (self-target allowed); only a super-admin may target a super-admin. Audits `user.mfa_reset`, notifies the target. Also requires aal2 of an MFA-enrolled caller (`_shared/require-aal2.ts`). |
| admin-set-user-password | Privileged | ✅ | Reference implementation. Also requires aal2 of an MFA-enrolled caller (`_shared/require-aal2.ts`). |
| analyze-quiz | Privileged | ✅ | `can_manage_offering` via caller-scoped client. |
| analyze-study-guide | Privileged | ✅ | As above. |
| bulk-invite-users | Privileged | ✅ | |
| cancel-job | Privileged | ✅ | |
| chat | Privileged | ✅ | The single tutoring endpoint (replaced `socratic-chat` and `study-tutor`, both deleted in #1441). `runChatTurn` resolves the caller from the bearer token, keys the session on that identity, then runs the subject's entitlement check — `verifyQuestionEnrollment` for an open question, course ownership for a study session. No id from the request body is trusted for authorization. |
| check-question-similarity | Privileged | ✅ | Fixed in #1136. Manager of the course whose bank is read. |
| chat-stream | Privileged | ✅ | The streaming counterpart to `chat`. Shares `prepareTurn`, so the gate is identical: caller resolved from the bearer token, then the subject's entitlement check. Differs only in when output moderation runs — after delivery rather than before, which is why it is opt-in. |
| check-vector-store-file | Privileged | ✅ | Fixed in #1137. Authentication only — no tenant resource to authorize against. |
| cluster-students-by-performance | Privileged | ✅ | `can_manage_offering`. |
| convert-html-to-pdf | Privileged | ✅ | Fixed in #1137. As above. |
| convert-md-to-pdf | Privileged | ✅ | Fixed in #1137. As above. |
| create-user | Privileged | ✅ | Fixed in #926. |
| delete-from-openai | Privileged | ✅ | Fixed in #1135. Course resolved from the material carrying the `openai_file_id`. `action: "delete-orphan"` (#1222) inverts that rule for rollbacks — manager of the body's `courseId`, and only for a file NO material owns. |
| delete-user | Privileged | ✅ | Reference implementation. |
| derive-group-weaknesses | Privileged | ✅ | `can_manage_offering`. |
| detect-chapters | Privileged | ✅ | Fixed in #1135. Course resolved from the file; manager level. |
| enqueue-bulk-generation | Privileged | ✅ | |
| enqueue-followup-practice | Privileged | ✅ | `can_manage_offering`. |
| export-data | Privileged | ✅ | |
| extract-competencies | Privileged | ✅ | Fixed in #1136. Course resolved from the material when one is named. |
| extract-images-from-pdf | Privileged | ✅ | Fixed in #1135. Manager level — it mints `course_materials` rows. Writes go to the resolved course, not the body's. |
| fetch-url-content | Privileged | ✅ | Manager of the `courseId` in the body. Read-only, but it fetches a caller-supplied URL from inside our network (SSRF sink — see `_shared/web-content.ts` `assertPublicHttpUrl`) and spends provider credits, so it is gated on a real course rather than on being signed in. |
| generate-chapter-summary | Privileged | ✅ | Fixed in #1136. Course resolved from the chapter, not the body. Since #1019 it also takes `materialIds` for chapterless "Other" documents; those resolve material → course the same way, and a list mixing courses is refused. |
| generate-cheatsheet | Privileged | ✅ | Fixed in #1136. Course resolved chapter → material → course. |
| generate-classification-questions | Privileged | ✅ | |
| generate-evaluation-timeline | Privileged | ✅ | Fixed in #1137. As above. |
| generate-fill-gaps-questions | Privileged | ✅ | |
| generate-flashcards | Privileged | ✅ | Fixed in #1136. As generate-cheatsheet. |
| generate-open-questions | Privileged | ✅ | |
| generate-ordering-questions | Privileged | ✅ | |
| generate-pdf-thumbnail | Privileged | ✅ | Fixed in #1135. Reader level — enrolled students reach it from the material preview. |
| generate-questions | Privileged | ✅ | The `studyGuideIds` path additionally requires `isAuthorizedCourseManager` on the body `courseId` before any guide content is read; the guides are then fetched scoped to that same course, so the authorized course and the guides' course cannot diverge. |
| generate-student-evaluation | Privileged | ✅ | Fixed in #1135. As above. |
| generate-student-questions | Privileged | ✅ | Fixed in #1136. `authorizeCourseReader` — an enrolled student or a course manager. |
| generate-study-guide-outline | Privileged | ✅ | `isAuthorizedCourseManager`; course read from the guide, not the body. |
| generate-study-guide-questions | Privileged | ✅ | As above. |
| generate-study-guide-theory | Privileged | ✅ | As above. |
| generate-study-image | Privileged | ✅ | Fixed in #1137. Authentication, plus a per-caller hourly ceiling — the priciest call here. |
| grade-deterministic-answer | Privileged | ✅ | |
| manage-vector-store | Privileged | ✅ | Fixed in #1135. Caller from the token; institution-admin per action, super-admin for `resync-metadata`. |
| moderate-study-image | Privileged | ✅ | Fixed in #1137. Authentication only. |
| notify-password-changed | Privileged | ✅ | Subject is the token's caller and there is no id in the body, so it can only ever email and audit the caller's own password change. |
| record-login-attempt | Public | n/a | Pre-auth by necessity. Per-IP and per-isolate rate limits, reason allow-list, length caps. |
| reset-open-question-progress | Privileged | ✅ | Course manager. NOT section-scoped — the reset is course-wide by design (#1162), see below. |
| resume-job | Privileged | ✅ | |
| retry-job | Privileged | ✅ | |
| run-jobs | Internal | n/a | Deliberately unauthenticated and documented in the handler: it cannot enqueue work, so an anonymous call only drains the owner's existing queue. |
| send-contact-form | Public | n/a | Unauthenticated contact form. Per-IP/email rate limit, HTML escaping. |
| send-invitation | Privileged | ✅ | Fixed in #1136. `is_institution_admin` on the token's caller, before the email is sent. |
| split-chapters | Privileged | ✅ | Fixed in #1135. Course resolved from the source file; manager level. |
| suggest-tutoring-sessions | Privileged | ✅ | Gated on creation. Course resolved chapter → material → course; manager level, because it spends OpenAI credit on a course's content. |
| submit-open-answer | Privileged | ✅ | Gated on creation. Caller from the token; enrollment checked via `verifyQuestionEnrollment`. Records the answer ungraded — the AI drafts review notes, never a grade. |
| submit-study-guide-piece | Privileged | ✅ | |
| submit-quiz-answers | Privileged | ✅ | Added in #1094. Caller from the token; the answer's course, offering and session are all checked against them in `record_quiz_answers`. |
| upload-to-openai | Privileged | ✅ | Fixed in #1135. The material's course wins over the body's; a fresh upload's `filePath` must sit under the named course. |
| validate-questions | Privileged | ✅ | |

**Totals:** 57 functions — 2 public by design, 1 internal, 54 privileged. It was
58 until #1137 deleted `upload-example-to-openai`: no caller anywhere in `src/`,
`e2e/` or `scripts/`, and an unauthenticated OpenAI-spending endpoint kept alive
for nothing. Back to 58 with `submit-quiz-answers` (#1094), which took quiz
grading off the client, and 59 with `suggest-tutoring-sessions`, gated from its
first commit rather than in a later audit. Down to 58 when AI grading was
removed: `grade-open-answer` and `grade-interaction` deleted, replaced by the
single recorder `submit-open-answer` (gated from its first commit) — open
answers are held for instructor review, and the AI only drafts qualitative
review notes into the manager-only `open_answer_ai_drafts`. Up to 59 with
`admin-reset-user-mfa` (opt-in TOTP follow-up), gated from its first commit.
Down to 57 in #1441, which deleted the `socratic-chat` and `study-tutor` shims:
both had been thin translations onto `chat` since the surfaces were unified, and
no caller remained anywhere in `src/`. An endpoint nothing calls is still
reachable — attack surface and deploy cost kept alive for nothing.

**All 54 privileged functions are gated.** The ❌ and ⚠️ columns are both empty
— none is reachable without a caller, and none resolves a caller and then fails
to use it. All three gaps are closed: A in #1135, B in #1136, C in #1137.

That is the end of the classification this document was written to drive. It is
not the end of authorization. Two things it never asserted, both of which turned
out to be hiding live bugs, are recorded in the gate legend above and in "Method
and its limits" below:

- **Suspension.** A ✅ row can still admit a suspended member if it reads
  `user_institutions.role` directly (#1082, and again #1152).
- **Granularity.** A ✅ row can still be too coarse — group-targeted questions
  answerable by a whole class (#1158), or a section-limited instructor reaching
  a section they do not teach, which remains unexamined outside the three
  student-record handlers.
- **Assurance level.** A ✅ row establishes WHO the caller is, not how strongly
  they authenticated. RLS enforces aal2 for MFA-enrolled users everywhere
  (migration `20260914150000_enforce_aal2_rls.sql`), but these handlers act
  through the service-role client, which bypasses RLS — so an aal1 token from
  an enrolled caller used to pass any gate that only resolves identity.
  **Closed by the #1440 sweep**: `callerMfaSatisfied` from
  `_shared/require-aal2.ts` now runs at every caller-resolution point — inside
  the two shared resolvers (`_shared/require-caller.ts` and
  `_shared/course-authz.ts` `callerFromRequest`), inside the chat turn
  (`_shared/chat-turn.ts`, covering `chat`, `chat-stream` and the two shims),
  and inline in every handler that resolves the token itself. The refusal is a
  403 with `code: "aal2_required"`, distinct from an authorization failure.
  Two deliberate exceptions:

  * `notify-password-changed` — its subject is always the token's caller and
    its only effects are emailing and auditing that caller's own password
    change. Password *recovery* legitimately happens at aal1 (the recovery
    flow has no MFA challenge yet), and suppressing the security notification
    for exactly that flow would help an attacker, not the user.
  * `run-jobs`, `record-login-attempt`, `send-contact-form` — no caller is
    resolved at all (internal / public by design), so there is nothing to
    check.

  Since the admin MFA mandate (migration `20260914180000`),
  `admin-set-user-password` and `admin-reset-user-mfa` additionally require
  aal2 OUTRIGHT of a super-admin caller (enrollment is not optional for that
  role), and of an institution-admin caller once
  `security_policies.admin_mfa_deadline` (2026-11-01) has passed — via
  `callerIsAal2` / `adminMfaMandateActive` from the same helper. The sweep
  does not change either handler.

## Gap severity

- **Gap A — cross-tenant read/write or destructive. CLOSED.** All ten are
  fixed: `accept-invitation` (#1147); the four storage-path handlers
  `detect-chapters`, `extract-images-from-pdf`, `generate-pdf-thumbnail` and
  `split-chapters`; the two student-record handlers
  `generate-student-evaluation` and
  `grade-interaction` (since deleted with the rest of AI grading); and the three vector-store handlers
  `delete-from-openai`, `manage-vector-store` and `upload-to-openai`.

  The shape of the fix was the same throughout, and is the rule to follow when
  adding a handler: **resolve the governing resource from the thing being acted
  on, not from the request body.** The material that owns the file, the question
  being graded, the row carrying the OpenAI file id. A body-supplied `courseId`
  or `institutionId` is only ever safe when the action is bound to that same id
  by something other than the caller's say-so — `upload-to-openai`'s
  fresh-upload path requires the `filePath` to sit under the named course's
  prefix for exactly that reason.

  Four rules the fixes turned on, three of which only surfaced in review:

  * **Gating the caller is half the fix. Re-read every other body value.**
    Resolving the canonical id and authorizing against it leaves the *action*
    open if any other id still steers it. `upload-to-openai` had three of these
    behind one gate — the source path, the OpenAI file id and the destination
    store — and `delete-from-openai` had the detach target. Each was found
    separately, one review round apart, because the fix was applied to the
    field that had been named rather than to the class of defect. The check is
    mechanical: after adding a gate, grep the handler for every remaining use
    of the request body and ask which of them reaches a write.
  * **A compatibility fallback is not the same as accepting-and-ignoring.**
    `sourceOpenaiFileId ?? openaiFileId` reopened a hole one line below the fix
    that closed it. Keep the parameter accepted so callers do not break; never
    let it be the value that is used.
  * **Authorizing the caller is not always the whole rule.** The student-record
    three also require the *subject* to be a student on the course, so managing
    a course does not license writing an AI verdict onto an arbitrary account —
    and, because RLS never runs for a service-role client, they re-state the
    section restriction from `course_instructor_sections` that the database
    would otherwise enforce.
  * **Use `institution-authz.ts`, never a raw `user_institutions.role` read**,
    so suspended members are excluded (#1082). `authorizeCourseReader` had to be
    corrected during review for missing this on its student path: suspension
    does not delete `class_enrollments` rows, so an enrolment is not on its own
    evidence of access.

  These handlers reached minors' personal data, which is why they carried the
  same GDPR Art. 32 weight as #926 itself.
- **Gap B — tenant content disclosure or spend on someone else's material.**
  **CLOSED.** All nine are fixed: `send-invitation`; the five content readers
  `check-question-similarity`, `extract-competencies`,
  `generate-chapter-summary`, `generate-cheatsheet` and `generate-flashcards`;
  and `generate-student-questions`, `socratic-chat` and `study-tutor`.

  `send-invitation` was the clearest instance of the #926 shape outside #926
  itself: the caller *was* resolved and *was* checked against the institution —
  and the result decided only whether to write an audit row, while the branded
  email went out either way, to any address. Authenticating for the audit trail
  is not a gate.

  The five readers took a `courseId`, `materialId` or `chapterId` from the body
  and generated from it. Note the distinction the fixes turn on, since it is not
  "never trust a body id": `check-question-similarity` authorizes against the
  body's `courseId`, which is safe because the bank being read is that same
  course's. The others resolve the course from the material or the chapter —
  `resolveCourseForChapter` walks chapter → material → course, because
  `material_chapters` carries no `course_id` — since there the body's id and the
  content acted on could differ. A list is authorized entry by entry:
  `generate-chapter-summary` checks every chapter's course, not the first one's.

  The last three were the ⚠️ rows — a caller *was* resolved, and then nothing
  was done with it. Two ways that went wrong, and only one looks like a gate at
  a glance:

  * `socratic-chat` and `study-tutor` treated the token as **optional**. It was
    read for the log line and the paused-session check; absent, the request
    proceeded anyway. An anonymous caller got tutoring on any question, or on
    any student's study session named by id, billed to this platform. Both were
    later folded into `chat` and deleted in #1441; the gate they were given in
    #1136 is `runChatTurn`'s, and outlived them.
  * `generate-student-questions` did require a token — it just never checked the
    caller against `courseId`. Its offering lookup sits in a `try`/`catch` that
    only warns, so it never gated anything. That is the more dangerous variant:
    it reads like authorization from a distance.

  Their levels differ by resource, not by convenience: enrollment for a question
  (`verifyQuestionEnrollment`), ownership for a study session — a course manager
  has no business continuing a student's tutoring turn as them — and
  reader-level for generation, where an enrolled student is the intended caller
  and a manager also legitimately generates.
- **Gap C — abuse and cost, no tenant data. CLOSED.** `check-vector-store-file`,
  `convert-html-to-pdf`, `convert-md-to-pdf`, `generate-evaluation-timeline`,
  `generate-study-image`, `moderate-study-image`. An anonymous caller cannot
  read anyone's data but can spend the platform's OpenAI/ConvertAPI budget.

## Method and its limits

Classification is static: for each function, whether it resolves a caller from
the `Authorization` header, whether it then checks that caller against the
resource, and whether any browser call site exists (`functions.invoke(...)`, a
raw `fetch` to `/functions/v1/...`, or a lookup table of function names). Every
row marked ⚠️ or ❌ was read directly; the ✅ rows were confirmed by reading the
gate itself, not merely by the presence of `auth.getUser`.

## Granularity, and where the line falls

`AUTHORIZATION.md` originally listed this as uncovered. It has since been
derived (#1162), and the answer is simpler than "decide per handler": the schema
already draws the line. `can_manage_offering` folds
`instructor_can_access_section` in
(`20260402000000_add_course_instructor_sections.sql:113-134`), so the rule is

> **offering-scoped ⇒ section-scoped. Course-scoped is not.**

Section scope is enforced three ways, and all of them were already in place:

- **Through RLS, via a caller-scoped client** — `analyze-quiz`,
  `analyze-study-guide`, `cluster-students-by-performance`,
  `derive-group-weaknesses`, `enqueue-followup-practice`, `generate-questions`,
  `generate-open-questions`. This pattern earns more than it looks: because RLS
  evaluates, section scope comes for free.
- **Through a caller-scoped read of `offerings`**, whose policy *is*
  `can_manage_offering` — `resolve-student-target.ts:68`, used by
  `generate-classification-questions`, `generate-fill-gaps-questions` and
  `generate-ordering-questions`.
- **Through an explicit `instructor_can_access_section` call**, where the
  handler runs on the service-role key and RLS cannot help —
  `generate-student-evaluation` (#1136; `grade-interaction` shared the
  pattern until AI grading was removed).

Course-level artefacts are deliberately **not** section-scoped: materials,
chapters, question banks and study-guide authoring are course-wide. Chaptering a
PDF is not a per-section act. Study guides are authored per course and *assigned*
per offering through `offering_study_guides`, and that assignment is a browser
write under RLS, so it is already scoped.

### The one accepted exception

`reset-open-question-progress` is course-wide **by design**, and it is the case
that does not fit the rule. The action is course-level — a question's answering
mode is not a per-section property — but the blast radius is per-student: the
reset deletes every chat, grade and progress row for the question, across every
section (`20260622000000_open_answering_mode.sql:96-130`). So a
section-restricted instructor changing a mode erases work belonging to sections
they do not teach.

A gate was attempted and abandoned (#1162, #1164). It has to answer *"whose work
is about to be deleted"*, and no query over current state answers that for work
created before the state changed:

- **Publication** does not. Unpublish a section and its students' rows survive,
  keyed by the question — invisible to `offering_questions`, still deleted.
- **Enrollment** does not either. A student who has left, or moved section,
  carries work attributed to wherever they are now, or to nowhere.
- Neither is bounded. Both need pagination to be exhaustive, and a section
  represented only by omitted rows silently passes the check.

Each version looks sound and is not, which is worse than no check: it reads like
a guarantee. The honest fix is to scope the **deletion**, not the gate — give the
RPC a caller and filter — and that is a migration rather than an authorization
change.

Until then this is an admin-shaped action performed by instructors, and the
confirmation in `OpenQuestionsTable` says so: it names the blast radius as
crossing every section, including ones the caller does not teach.

**The transferable part:** when a check cannot be derived reliably, say so and
warn, rather than shipping one that looks right. A gate that is wrong in the
cases nobody tests is worse than a documented limitation.
