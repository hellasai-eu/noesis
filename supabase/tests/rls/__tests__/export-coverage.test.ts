// Drift guards for the two export surfaces in supabase/functions/export-data
// (issue #947, finding 2).
//
// Both were hand-maintained lists of table names, and both had already drifted:
//
//   * the super-admin whole-database dump listed 42 of 94 tables, two of which
//     no longer existed — now derived from the catalogue by
//     public.list_exportable_tables(), and checked here against the catalogue;
//   * the per-user GDPR export (Art. 15/20) missed seven tables carrying a
//     foreign key to auth.users, including the three `study_guide_*` tables
//     added by #977/#978 a day after the export shipped.
//
// A list of table names in application code cannot notice a migration. These
// tests can: they compare the specs against the live catalogue, so the next
// personal-data table fails CI instead of silently vanishing from a subject
// access request.
//
// Coverage is judged from two signals, because neither is sufficient alone:
//
//   1. a foreign key to auth.users — misses a reference held in jsonb
//      (`flagged_content.data`), keyed by email (`super_admins`), or left
//      without an FK on purpose (`audit_logs`, so the record of a deletion
//      outlives it);
//   2. an entry in `public.user_reference_map()`, the erasure registry — which
//      had itself drifted four columns behind the schema (backfilled in
//      20260824150000), which is why it is a second signal and not the only one.
//
// The two disagreeing is itself a bug, so it gets its own assertion below: a
// table cannot be private enough to erase and not personal enough to disclose.
//
// Runs in the RLS suite because that is the only harness with a real database.
// Everything here is read-only — no fixtures, no cleanup.

import { describe, it, expect } from 'vitest';
import { queryScalar } from '../helpers/sql';
import {
  ROOT_SPECS,
  CHILD_SPECS,
  NOT_SUBJECT_DATA,
} from '../../../functions/export-data/user-export';

/** Rows of a query returning a single text column, sorted, as an array. */
function queryColumn(sql: string): string[] {
  return JSON.parse(
    queryScalar(
      `SELECT coalesce(json_agg(t ORDER BY t), '[]'::json)::text FROM (${sql}) AS q(t)`
    )
  );
}

/**
 * Ordinary tables plus partitioned parents, minus the individual partitions —
 * one row per logical table. Kept identical to `list_exportable_tables()` on
 * purpose: the assertion below is what catches that function being dropped,
 * regranted, or widened to include views.
 */
const TABLE_PREDICATE = `c.relkind IN ('r', 'p') AND NOT c.relispartition`;

const publicTables = queryColumn(`
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND ${TABLE_PREDICATE}
`);

/** Every public table with at least one foreign key to auth.users. */
const tablesReferencingAuthUsers = queryColumn(`
  SELECT DISTINCT c.conrelid::regclass::text
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE c.contype = 'f'
    AND n.nspname = 'public'
    AND c.confrelid = 'auth.users'::regclass
`);

/**
 * Every public table named by `public.user_reference_map()` — the erasure
 * registry from 20260726000000, "every column referencing a user and its
 * erasure rule".
 *
 * A foreign key alone is not a sufficient signal for personal data, which is
 * why this is unioned in below. Two ways a table escapes the FK scan:
 *
 *   * the reference is not a uuid column at all — `flagged_content.data` holds
 *     the user id inside jsonb, and `super_admins` is keyed by email;
 *   * the FK is deliberately absent so the row can outlive the user.
 *
 * The map already had to reason about all of them for erasure, so it knows
 * about tables the catalogue cannot reveal. Schema-qualified entries
 * (`storage.objects`) are dropped — this guard is about `public` base tables.
 */
const tablesInUserReferenceMap = queryColumn(`
  SELECT DISTINCT tbl FROM public.user_reference_map() WHERE tbl NOT LIKE '%.%'
`);

const columnsByTable = new Map<string, Set<string>>(
  Object.entries(
    JSON.parse(
      queryScalar(`
        SELECT coalesce(json_object_agg(tbl, cols), '{}'::json)::text FROM (
          SELECT c.relname::text AS tbl, json_agg(a.attname::text) AS cols
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          WHERE n.nspname = 'public' AND ${TABLE_PREDICATE}
          GROUP BY 1
        ) s
      `)
    ) as Record<string, string[]>
  ).map(([table, cols]) => [table, new Set(cols)])
);

const specTables = new Set<string>([
  ...ROOT_SPECS.map((s) => s.table),
  ...CHILD_SPECS.map((s) => s.table),
]);

describe('super-admin whole-database export', () => {
  // The regression this replaces: a hand-written array that had fallen 52
  // tables behind the schema while still being labelled a full export.
  it('list_exportable_tables() returns exactly the public base tables', () => {
    expect(queryColumn('SELECT public.list_exportable_tables()')).toEqual(publicTables);
  });
});

describe('per-user GDPR export coverage', () => {
  it('exports every table holding a reference to a user', () => {
    // Union of both signals: a foreign key to auth.users, or an entry in the
    // erasure registry. Either one means someone has already concluded the
    // table points at a person.
    const referencesAUser = [
      ...new Set([...tablesReferencingAuthUsers, ...tablesInUserReferenceMap]),
    ].sort();

    const uncovered = referencesAUser.filter(
      (t) => !specTables.has(t) && !NOT_SUBJECT_DATA.has(t)
    );

    expect(
      uncovered,
      `These tables reference a user — via a foreign key to auth.users, via ` +
        `public.user_reference_map(), or both — but appear in neither ROOT_SPECS ` +
        `nor CHILD_SPECS in supabase/functions/export-data/user-export.ts, so rows ` +
        `about a data subject are missing from their export. Add a spec, or add ` +
        `the table to NOT_SUBJECT_DATA in this file with a reason.`
    ).toEqual([]);
  });

  // The registry and the export specs are maintained by hand in two different
  // files, and 20260726000000 tells authors to update both. This is the
  // assertion behind that instruction: it fails when a table is erased but
  // never exported, which is the direction that loses a subject access request.
  it('keeps the erasure registry and the export specs in agreement', () => {
    const erasedButNotExported = tablesInUserReferenceMap.filter(
      (t) => !specTables.has(t) && !NOT_SUBJECT_DATA.has(t)
    );

    expect(
      erasedButNotExported,
      `public.user_reference_map() treats these as personal data for erasure, ` +
        `but they are absent from the export specs. A table cannot be private ` +
        `enough to erase and not personal enough to disclose.`
    ).toEqual([]);
  });

  it('names only tables that exist', () => {
    // Catches the failure mode that left `student_competency_mastery` and
    // `competency_mastery_history` in the other list long after they were gone.
    const referenced = new Set<string>([
      ...specTables,
      ...CHILD_SPECS.map((s) => s.parentTable),
      ...ROOT_SPECS.flatMap((s) => (s.hops ?? []).map((h) => h.table)),
    ]);

    const missing = [...referenced].filter((t) => !publicTables.includes(t)).sort();
    expect(missing).toEqual([]);
  });

  it('names only columns that exist', () => {
    const problems: string[] = [];
    // A match may address a key inside a jsonb column (`data->>user_id`), which
    // PostgREST accepts verbatim. Only the base column can be checked against
    // the catalogue; the key inside it is not part of the schema.
    const baseColumn = (column: string) => column.split(/->>?/)[0];
    const check = (table: string, column: string, what: string) => {
      const cols = columnsByTable.get(table);
      if (!cols) return; // covered by the "tables that exist" test
      if (!cols.has(baseColumn(column))) problems.push(`${what}: ${table}.${column}`);
    };

    for (const spec of ROOT_SPECS) {
      for (const rule of spec.match) check(spec.table, rule.column, 'match');
      for (const column of (spec.columns ?? '').split(',').filter(Boolean)) {
        check(spec.table, column, 'columns');
      }
      // Each hop reads its column off the previous table in the chain.
      let from = spec.table;
      for (const hop of spec.hops ?? []) {
        check(from, hop.column, 'hop');
        from = hop.table;
      }
    }

    for (const spec of CHILD_SPECS) {
      check(spec.table, spec.fkColumn, 'child fk');
      for (const column of (spec.columns ?? '').split(',').filter(Boolean)) {
        check(spec.table, column, 'child columns');
      }
    }

    expect(problems).toEqual([]);
  });

  it('ends every hop chain at a table carrying institution_id', () => {
    const problems: string[] = [];

    for (const spec of ROOT_SPECS) {
      if (spec.hops === null) continue; // account-level, no institution
      const last = spec.hops.at(-1);
      const table = last ? last.table : spec.table;
      if (!columnsByTable.get(table)?.has('institution_id')) {
        problems.push(`${spec.table} resolves to ${table}, which has no institution_id`);
      }
    }

    expect(problems).toEqual([]);
  });
});
