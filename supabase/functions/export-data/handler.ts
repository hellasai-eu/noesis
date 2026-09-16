import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { recordAudit } from "../_shared/audit.ts";
import { logger } from "../_shared/logger.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";
import { buildUserExport, type ExportDb, type Row } from "./user-export.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PAGE_SIZE = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every base table in the `public` schema, read from the catalogue at call time
 * via `public.list_exportable_tables()`.
 *
 * This used to be a hand-maintained array. It drifted to 42 entries against 94
 * real tables — including two that no longer existed — while being presented in
 * the UI as a whole-database dump (issue #947). Deriving it means a new table is
 * covered the moment its migration lands.
 *
 * Deliberately throws rather than falling back to a partial list: an export
 * labelled "everything" that quietly omits half the schema is worse than one
 * that fails and says why.
 */
// deno-lint-ignore no-explicit-any
async function loadExportableTables(supabaseAdmin: any): Promise<string[]> {
  const { data, error } = await supabaseAdmin.rpc("list_exportable_tables");

  if (error) {
    throw new Error(`Could not read the table list from the database: ${error.message}`);
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("The database returned no exportable tables");
  }

  return data.map((row: unknown) =>
    // `RETURNS SETOF text` arrives as plain strings; tolerate the row-object
    // shape too, so a later change to `RETURNS TABLE(...)` cannot break this.
    typeof row === "string" ? row : String((row as Record<string, unknown>).list_exportable_tables)
  );
}

/**
 * Adapts the service-role Supabase client to the narrow interface the per-user
 * export needs, adding pagination.
 *
 * Paging is ordered by `id` so that rows are neither skipped nor duplicated
 * across pages; join tables with a composite primary key have no `id`, so the
 * first page falls back to an unordered read for those.
 */
// deno-lint-ignore no-explicit-any
function createExportDb(supabaseAdmin: any): ExportDb {
  return {
    async fetch({ table, column, op, value, values, columns }) {
      if (op === "in" && (!values || values.length === 0)) return { data: [] };

      const rows: Row[] = [];
      let offset = 0;
      let ordered = true;

      for (;;) {
        const run = async (withOrder: boolean) => {
          let query = supabaseAdmin.from(table).select(columns ?? "*");
          query = op === "eq" ? query.eq(column, value) : query.in(column, values);
          if (withOrder) query = query.order("id", { ascending: true });
          return await query.range(offset, offset + PAGE_SIZE - 1);
        };

        let { data, error } = await run(ordered);
        if (error && ordered && offset === 0) {
          // Most likely a table without an `id` column; retry unordered.
          ordered = false;
          ({ data, error } = await run(false));
        }
        if (error) return { data: [], error: error.message };
        if (!data || data.length === 0) break;

        rows.push(...(data as Row[]));
        if (data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }

      return { data: rows };
    },

    async getAuthUser(userId: string) {
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (error || !data?.user) return null;
      return {
        id: data.user.id,
        email: data.user.email ?? null,
        created_at: data.user.created_at ?? null,
        last_sign_in_at: data.user.last_sign_in_at ?? null,
      };
    },
  };
}

export const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Initialised here rather than via withLogging: this function returns the
  // whole multi-table dump as one JSON body, and withLogging would buffer it
  // to a string just to log a "[response too large]" placeholder.
  logger.init("export-data");

  try {
    // Get authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase client with user token
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    // Get current user
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      logger.error("Auth error", { error: userError?.message });
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // The exports below run on the service-role client, so RLS's aal2
    // enforcement never applies — refuse an enrolled caller still at aal1.
    const callerToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!callerMfaSatisfied(user, callerToken)) {
      return new Response(
        JSON.stringify({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if user is super admin using service role client
    const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

    // Read once per request: `list-tables` and `export` both need it, and the
    // set cannot change mid-request.
    let exportableTables: string[] | null = null;
    const getExportableTables = async (): Promise<string[]> =>
      (exportableTables ??= await loadExportableTables(supabaseAdmin));

    const { data: isSuperAdmin, error: adminError } = await supabaseAdmin.rpc("is_super_admin", {
      _user_id: user.id,
    });

    if (adminError || !isSuperAdmin) {
      logger.error("Super admin check failed", { error: adminError?.message });
      return new Response(
        JSON.stringify({ error: "Super admin access required" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse request body
    const body = await req.json();
    const { action, tables, table, limit, userId } = body;

    if (action === "export-user") {
      // GDPR Art. 15/20 subject access request, run by a super admin on behalf
      // of the school that received the request (Art. 28(3)(e) processor assistance).
      if (typeof userId !== "string" || !UUID_RE.test(userId)) {
        return new Response(
          JSON.stringify({ error: "A valid userId is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const exportedAt = new Date().toISOString();
      const result = await buildUserExport(createExportDb(supabaseAdmin), {
        userId,
        exportedBy: user.email ?? user.id,
        exportedAt,
      });

      const totalRows = Object.values(result.export_metadata.row_counts)
        .reduce((sum, count) => sum + count, 0);

      // Durable audit trail, recorded only after the export succeeds.
      //
      // One row PER institution touched, scoped to that institution and
      // carrying only that institution's counts — the same shape delete-user
      // settled on. Institution admins can read audit rows for their own
      // institution, so a single row listing every institution the subject
      // belongs to would leak one school's membership to another.
      //
      // Per the erasure-safety rule in `_shared/audit.ts` the subject is
      // referenced by id only: storing their email here would survive, and so
      // undo, a later GDPR erasure.
      const perInstitution = result.by_institution.map((entry) => ({
        institutionId: typeof entry.institution.id === "string" ? entry.institution.id : null,
        rowCounts: Object.fromEntries(
          Object.entries(entry.data).map(([table, rows]) => [table, rows.length])
        ),
      }));

      // Account-level rows (profile, login history) belong to no institution,
      // and a subject with no institutional records at all must still leave a
      // trace, so an unscoped row always accompanies the scoped ones.
      const accountRowCounts = Object.fromEntries(
        Object.entries(result.account).map(([table, rows]) => [table, rows.length])
      );

      await recordAudit({
        action: "data.export",
        actorUserId: user.id,
        actorEmail: user.email ?? null,
        targetUserId: userId,
        targetEntityType: "user_export",
        targetEntityId: userId,
        institutionId: null,
        metadata: {
          mode: "per-user",
          scope: "account",
          institution_count: perInstitution.length,
          row_counts: accountRowCounts,
          total_rows: totalRows,
          errored_tables: Object.keys(result.errors ?? {}),
        },
      });

      for (const { institutionId, rowCounts } of perInstitution) {
        await recordAudit({
          action: "data.export",
          actorUserId: user.id,
          actorEmail: user.email ?? null,
          targetUserId: userId,
          targetEntityType: "user_export",
          targetEntityId: userId,
          institutionId,
          metadata: {
            mode: "per-user",
            scope: "institution",
            row_counts: rowCounts,
            total_rows: Object.values(rowCounts).reduce((sum, count) => sum + count, 0),
          },
        });
      }

      logger.info("Per-user GDPR export completed", {
        target_user_id: userId,
        institution_count: perInstitution.length,
        total_rows: totalRows,
      });

      return new Response(
        JSON.stringify(result),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "list-tables") {
      // Return list of available tables with row counts
      const tableCounts: Record<string, number> = {};
      const allTables = await getExportableTables();

      const countRows = async (t: string) => {
        try {
          const { count, error } = await supabaseAdmin
            .from(t)
            .select("*", { count: "exact", head: true });

          if (!error) {
            tableCounts[t] = count || 0;
          } else {
            logger.warn("Table not accessible", { table: t, error: error.message });
            tableCounts[t] = -1; // Indicate error
          }
        } catch (e) {
          logger.warn("Table count failed", { table: t, error: (e as Error).message });
          tableCounts[t] = -1;
        }
      };

      // Counting every table one at a time was already the slowest part of this
      // page; deriving the list rather than hand-maintaining it more than
      // doubled the number of tables, so the counts run in small batches.
      const COUNT_CONCURRENCY = 8;
      for (let i = 0; i < allTables.length; i += COUNT_CONCURRENCY) {
        await Promise.all(allTables.slice(i, i + COUNT_CONCURRENCY).map(countRows));
      }

      return new Response(
        JSON.stringify({ tables: tableCounts }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "preview") {
      // Preview last N rows from a single table
      if (!table || !(await getExportableTables()).includes(table)) {
        return new Response(
          JSON.stringify({ error: "Invalid table name" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const rowLimit = Math.min(limit || 3, 100); // Cap at 100 rows

      // Durable audit trail: a super-admin previewed raw rows of a table that
      // may contain personal data. Recorded ONLY AFTER the query succeeds — a
      // failed preview must not leave a record that claims data was accessed.
      // Non-identifying metadata only (table name + row cap), never the rows.
      const auditPreview = () =>
        recordAudit({
          action: "data.preview",
          actorUserId: user.id,
          actorEmail: user.email ?? null,
          targetEntityType: "table",
          targetEntityId: table,
          metadata: { table, row_limit: rowLimit },
        });

      try {
        const { data, error } = await supabaseAdmin
          .from(table)
          .select("*")
          .order("created_at", { ascending: false })
          .limit(rowLimit);

        if (error) {
          // Try without ordering if created_at doesn't exist
          const { data: fallbackData, error: fallbackError } = await supabaseAdmin
            .from(table)
            .select("*")
            .limit(rowLimit);

          if (fallbackError) {
            return new Response(
              JSON.stringify({ error: fallbackError.message }),
              { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

          await auditPreview();
          return new Response(
            JSON.stringify({ data: fallbackData || [], table }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        await auditPreview();
        return new Response(
          JSON.stringify({ data: data || [], table }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    if (action === "export") {
      // Export specified tables
      const exportableTableList = await getExportableTables();
      const tablesToExport: string[] = tables || exportableTableList;
      const exportData: Record<string, unknown[]> = {};
      const errors: Record<string, string> = {};

      logger.info("Exporting tables", { tableCount: tablesToExport.length });

      for (const table of tablesToExport) {
        if (!exportableTableList.includes(table)) {
          errors[table] = "Table not in exportable list";
          continue;
        }

        try {
          // Fetch all data from table (paginated for large tables)
          let allData: unknown[] = [];
          let offset = 0;
          const limit = 1000;
          let hasMore = true;

          while (hasMore) {
            const { data, error } = await supabaseAdmin
              .from(table)
              .select("*")
              .range(offset, offset + limit - 1);

            if (error) {
              errors[table] = error.message;
              hasMore = false;
            } else if (data && data.length > 0) {
              allData = allData.concat(data);
              offset += limit;
              hasMore = data.length === limit;
            } else {
              hasMore = false;
            }
          }

          exportData[table] = allData;
          logger.info("Exported table", { table, rows: allData.length });
        } catch (e) {
          errors[table] = e instanceof Error ? e.message : "Unknown error";
        }
      }

      // Durable audit trail: a super-admin bulk-exported table data (may
      // contain personal data across institutions). Records which tables were
      // exported and their row counts — never the exported rows themselves.
      await recordAudit({
        action: "data.export",
        actorUserId: user.id,
        actorEmail: user.email ?? null,
        targetEntityType: "export",
        metadata: {
          tables: tablesToExport,
          table_count: tablesToExport.length,
          row_counts: Object.fromEntries(
            Object.entries(exportData).map(([t, rows]) => [t, (rows as unknown[]).length]),
          ),
          errored_tables: Object.keys(errors),
        },
      });

      return new Response(
        JSON.stringify({
          data: exportData,
          errors: Object.keys(errors).length > 0 ? errors : undefined,
          exportedAt: new Date().toISOString(),
          exportedBy: user.email,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action. Use 'list-tables', 'preview', 'export' or 'export-user'" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    logger.exception(error, "Export error");
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};
