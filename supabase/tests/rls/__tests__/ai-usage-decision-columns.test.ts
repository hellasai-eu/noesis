// DB-level tests for the AI usage decision columns (migration
// 20260819120000_ai_usage_decision_context.sql).
//
// The columns exist so that `ai_usage_logs` can say *why* a call was made the
// way it was, not merely what answered. Two properties are worth asserting
// against a real database rather than in a unit test:
//
//   * a failed attempt is a storable row at all — it has no response id and no
//     OpenAI status, which is why `status` had to lose its NOT NULL;
//   * the outcome vocabulary in Postgres and the TypeScript union cannot drift,
//     because tracking is fire-and-forget and a rejected insert is a silently
//     lost row rather than an error anyone sees.
//
// Deliberately no cost assertions: this table records tokens, never money. See
// the migration header for why.
//
// Reaches an RLS-protected log table that supabase-js cannot seed, so it drives
// raw SQL as the local `postgres` superuser via helpers/sql.ts, matching
// data-retention.test.ts.

import { describe, it, expect, afterAll } from 'vitest';
import { execSql, queryScalar } from '../helpers/sql';
import { MODEL_POLICY, MODEL_TIERS } from '../../../functions/_shared/model-policy.ts';

/** Marker so teardown removes only rows this suite created. */
const FIXTURE_FN = '__usage_fixture__';

function cleanup(): void {
  execSql(`DELETE FROM public.ai_usage_logs WHERE function_name = '${FIXTURE_FN}';`);
}

describe('ai_usage_logs attempt columns', () => {
  afterAll(cleanup);

  it('accepts a failed attempt: no response id, no status, an outcome', () => {
    // The row shape that could not exist before this migration. Only successful
    // responses were ever inserted, so a call that 429'd twice and then
    // succeeded logged one row — and the retries, the most common reason usage
    // jumps, were invisible.
    const id = crypto.randomUUID();
    execSql(
      `INSERT INTO public.ai_usage_logs
         (id, function_name, model, status, response_id, outcome, attempt_number,
          http_status, error_message, feature, policy_key, policy_version, model_tier)
       VALUES ('${id}', '${FIXTURE_FN}', 'gpt-5.4', NULL, NULL, 'rate_limited', 2,
               429, '429 Too Many Requests', 'grading', 'grading.open-answer-draft', 1, 'balanced');`
    );
    expect(queryScalar(`SELECT outcome FROM public.ai_usage_logs WHERE id = '${id}';`)).toBe(
      'rate_limited'
    );
    expect(
      queryScalar(`SELECT attempt_number::text FROM public.ai_usage_logs WHERE id = '${id}';`)
    ).toBe('2');
    expect(
      queryScalar(`SELECT policy_key FROM public.ai_usage_logs WHERE id = '${id}';`)
    ).toBe('grading.open-answer-draft');
  });

  it('records an incomplete attempt with the tokens it burned', () => {
    // An incomplete response hit the output ceiling: it was billed in full and
    // is about to be retried. Folding it into the successful retry's row would
    // understate the call by exactly the tokens that were wasted.
    const id = crypto.randomUUID();
    execSql(
      `INSERT INTO public.ai_usage_logs
         (id, function_name, model, status, outcome, attempt_number,
          input_tokens, output_tokens, total_tokens)
       VALUES ('${id}', '${FIXTURE_FN}', 'gpt-5.4', 'incomplete', 'incomplete', 0,
               1000, 8000, 9000);`
    );
    expect(
      queryScalar(`SELECT output_tokens::text FROM public.ai_usage_logs WHERE id = '${id}';`)
    ).toBe('8000');
    expect(queryScalar(`SELECT outcome FROM public.ai_usage_logs WHERE id = '${id}';`)).toBe(
      'incomplete'
    );
  });

  it('rejects an outcome the edge functions cannot produce', () => {
    // Tracking is fire-and-forget, so a rejected insert is a silently lost row.
    // The CHECK exists to make a typo fail in tests rather than in production.
    expect(() =>
      execSql(
        `INSERT INTO public.ai_usage_logs (function_name, model, outcome)
         VALUES ('${FIXTURE_FN}', 'gpt-5.4', 'exploded');`
      )
    ).toThrow();
  });

  it('accepts every outcome the TypeScript union can produce', () => {
    // The other half of the same guard: the CHECK must not be narrower than the
    // union, or a legitimate outcome is dropped in production and nowhere else.
    const outcomes = [
      'success',
      'incomplete',
      'rate_limited',
      'server_error',
      'client_error',
      'transport_error',
      'poll_timeout',
    ];
    for (const outcome of outcomes) {
      expect(() =>
        execSql(
          `INSERT INTO public.ai_usage_logs (function_name, model, outcome)
           VALUES ('${FIXTURE_FN}', 'gpt-5.4', '${outcome}');`
        ),
        `outcome '${outcome}' is in UsageOutcome but rejected by ai_usage_logs_outcome_check`
      ).not.toThrow();
    }
  });

  it('splits latency into the API round trip and the background poll wait', () => {
    // A background call returns from the POST in about a second and does the
    // work while polling. One number cannot tell a slow model from a long
    // queue, which is why every study-guide call used to report ~1s.
    const id = crypto.randomUUID();
    execSql(
      `INSERT INTO public.ai_usage_logs
         (id, function_name, model, outcome, response_time_ms, api_latency_ms,
          poll_wait_ms, background_mode)
       VALUES ('${id}', '${FIXTURE_FN}', 'gpt-5.6-terra', 'success', 92000, 900, 91100, true);`
    );
    expect(
      queryScalar(`SELECT api_latency_ms::text FROM public.ai_usage_logs WHERE id = '${id}';`)
    ).toBe('900');
    expect(
      queryScalar(`SELECT poll_wait_ms::text FROM public.ai_usage_logs WHERE id = '${id}';`)
    ).toBe('91100');
  });
});

describe('model policy registry', () => {
  it('assigns every policy model a tier', () => {
    // model_tier is what makes "we moved this task down a tier and usage fell
    // by half" answerable. A model missing from MODEL_TIERS logs as "unknown",
    // which silently drops it out of any tier comparison.
    const untiered = [...new Set(Object.values(MODEL_POLICY).map((p) => p.model))].filter(
      (m) => !MODEL_TIERS[m]
    );

    expect(
      untiered,
      `These models are selectable from MODEL_POLICY but absent from MODEL_TIERS, ` +
        `so their usage rows will record model_tier = "unknown".`
    ).toEqual([]);
  });

  it('names a GPT-5.6 tier explicitly wherever it uses one', () => {
    // Bare "gpt-5.6" is an alias for Sol, the most expensive tier, so a policy
    // entry that drops the suffix silently buys the flagship instead of failing.
    const unsuffixed = Object.entries(MODEL_POLICY)
      .filter(([, p]) => /^gpt-5\.6$/.test(p.model))
      .map(([key]) => key);

    expect(
      unsuffixed,
      `These policies name bare "gpt-5.6", which aliases to Sol. Name the tier.`
    ).toEqual([]);
  });
});
