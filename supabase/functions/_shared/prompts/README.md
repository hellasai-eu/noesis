# Shared prompt templates

This directory holds the OpenAI prompt templates that the edge functions
substitute variables into. The structure of each template directly affects
**prompt-cache hit rate** and therefore input-token cost.

## The static-first / dynamic-last rule

OpenAI's Responses API automatically caches prompts ≥ 1024 tokens. The cache
key is the **longest stable prefix** of everything we send in a single channel
(same route, same model, same tools). Cached input tokens cost ~50% less than
non-cached tokens.

Cache hit requires the prefix to be **byte-identical** across calls. If a
dynamic substitution (chat history, special instructions, the current request
payload, etc.) appears early in the prompt, every subsequent call gets a fresh
cache key and the cache barely activates.

The rule for every template in this directory:

> **Static content first. Dynamic content last.**

The recommended layout (from issue #558):

```
[1] System prompt                          (always same)
[2] Quality instruction (language rules)   (same per course)
[3] Output schema / format rules           (always same)
[4] Course metadata + objective            (same per course)
[5] Competency list                        (same per chapter)
[6] Chapter content / file_search          (same per chapter for hours)
─────────── prefix-cache boundary ───────────
[7] Past questions for dedup               (changes per call)
[8] Group/student audience hint            (changes per call)
[9] Special instructions (instructor)      (changes per call)
[10] Current request payload                (changes per call)
```

Anything above the boundary lives in the **system prompt** (the
`instructions` field on the Responses API). Anything below the boundary lives
in the **user message** (the trailing portion of the `input` array).

## Correct vs incorrect ordering

### ❌ Incorrect — dynamic substitution in the system prompt

```ts
export const SYSTEM_PROMPT = `You are an expert tutor.
[rules...]

{{special_instructions}}     // CHANGES per call — poisons the cache prefix
{{chapter_content}}`;         // stable, but never hit because the prefix already diverged
```

Even with `chapter_content` last, the `special_instructions` substitution
above it means the cache key changes on every call where the instructor
tweaks the special instructions, and there is no caching across two different
instructors targeting the same chapter.

### ✅ Correct — dynamic substitutions moved to the user message

```ts
export const SYSTEM_PROMPT = `You are an expert tutor.
[rules...]

{{chapter_content}}`;        // stable per chapter — cache hits across calls

export const USER_PROMPT = `{{full_competency_list}}
{{chapter_list}}

⸻ DYNAMIC PER-CALL CONTEXT ⸻
{{group_audience_hint}}
{{special_instructions}}
{{past_questions}}

⸻ REQUEST ⸻
Generate {{num}} questions of {{difficulty}} difficulty in {{lang}}.`;
```

The system prompt stays byte-identical for the same chapter regardless of
instructor or audience, so the cache key is the same. Dynamic content only
diverges *after* the cache boundary.

## Enforcement

A Deno test in `supabase/functions/_shared/__tests__/prompt-cache-order.test.ts`
asserts the placeholder ordering for every prompt in this directory. A PR that
reorders a dynamic block above a static block fails CI.

If you add a new prompt template here, extend that test so the ordering is
locked in from the start.

## Related guardrails

- `prompt-pii-guard.test.ts` — forbids student-identity placeholders
  (`{{student_name}}`, etc.) to keep PII out of OpenAI requests (issue #557).

## Out of scope for this layout

- **Saved prompts** (`pmpt_*`) live in the OpenAI dashboard, not in this
  directory, and follow their own conventions. The cache rule still applies
  but the source-of-truth is the dashboard.
- **Image generation prompts** — not cache-eligible.
- **Moderation calls** — too small to cache.
