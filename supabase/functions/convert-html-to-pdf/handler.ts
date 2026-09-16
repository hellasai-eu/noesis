/**
 * Issue #728: HTML -> PDF for the rich-text test editor.
 *
 * Mirrors the shape of `convert-md-to-pdf` but only accepts HTML and wraps
 * it in a print stylesheet that honours the instructor-controlled layout:
 *   - `<div class="page-break"></div>` produces a hard page break
 *   - inline `font-size` styles on `<span>`/text-style marks pass through
 *   - the KaTeX stylesheet is linked so math rendered into the saved
 *     snapshot keeps its glyph fonts
 *
 * Auth is delegated to the existing `tests` RLS (the row is fetched
 * client-side before invoking this function); `verify_jwt = false` in
 * `config.toml` keeps the gateway open to `supabase.functions.invoke()`
 * just like `convert-md-to-pdf`.
 */
import { logger } from "../_shared/logger.ts";
import { requireCaller } from "../_shared/require-caller.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const KATEX_VERSION = "0.16.27";
const KATEX_CSS_URL = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css`;

function printStylesheet(pageSize: string): string {
  return `
    @page { size: ${pageSize}; margin: 1in; }
    body {
      font-family: 'Helvetica', 'Arial', sans-serif;
      color: #111;
      line-height: 1.5;
      font-size: 12pt;
    }
    h1 { font-size: 22pt; margin: 12px 0 8px; }
    h2 { font-size: 16pt; margin: 16px 0 8px; }
    h3 { font-size: 14pt; margin: 12px 0 6px; }
    p { margin: 6px 0; }
    ul, ol { margin: 6px 0; padding-left: 24px; }
    /* Hard page break — TipTap's PageBreak node renders this exact markup. */
    .page-break {
      page-break-after: always;
      break-after: page;
      height: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }
    /* KaTeX produces both visually-rendered HTML and a hidden MathML copy.
       Hide the MathML copy in print so glyphs don't double up. */
    .katex .katex-mathml { display: none; }
  `;
}

function wrapHtml(body: string, pageSize: string, filename: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(filename)}</title>
    <link rel="stylesheet" href="${KATEX_CSS_URL}" crossorigin="anonymous" />
    <style>${printStylesheet(pageSize)}</style>
  </head>
  <body>${body}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const ALLOWED_PAGE_SIZES = new Set(["a4", "letter", "legal", "a3"]);
    // ── Caller gate (#1137) ───────────────────────────────────────────────
    // Converts caller-supplied HTML and bills the platform's ConvertAPI quota.
    //
    // Authentication only: there is no tenant resource in this request to
    // authorize anyone against. That is the whole difference between an
    // endpoint the internet can spend money through and one only signed-in
    // users can.
    const caller = await requireCaller(req);
    if (!caller.ok) {
      return new Response(JSON.stringify({ error: caller.error, code: caller.code }), {
        status: caller.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { html, filename, pageSize: rawPageSize = "a4" } = await req.json();

    const pageSize = ALLOWED_PAGE_SIZES.has(String(rawPageSize).toLowerCase())
      ? String(rawPageSize).toLowerCase()
      : "a4";

    if (typeof html !== "string" || html.length === 0) {
      logger.error("Missing html content");
      return new Response(
        JSON.stringify({ error: "Missing html content" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const convertApiKey = Deno.env.get("CONVERT_API_KEY");
    if (!convertApiKey) {
      logger.error("CONVERT_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "CONVERT_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const safeName = (typeof filename === "string" && filename.length > 0) ? filename : "test";
    const wrapped = wrapHtml(html, pageSize, safeName);

    logger.info("Converting HTML to PDF", { filename: safeName, pageSize });

    // Base64-encode without `String.fromCharCode(...bytes)` — for large HTML
    // inputs that exceeds the JS call-stack limit and throws (same fix
    // applied to convert-md-to-pdf).
    const encoder = new TextEncoder();
    const sourceBytes = encoder.encode(wrapped);
    let binary = "";
    for (let i = 0; i < sourceBytes.length; i++) {
      binary += String.fromCharCode(sourceBytes[i]);
    }
    const sourceBase64 = btoa(binary);

    const response = await fetch("https://v2.convertapi.com/convert/html/to/pdf", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${convertApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Parameters: [
          {
            Name: "File",
            FileValue: {
              Name: `${safeName}.html`,
              Data: sourceBase64,
            },
          },
          { Name: "PageSize", Value: pageSize },
          { Name: "StoreFile", Value: false },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("ConvertAPI error", { status: response.status, error: errorText });
      return new Response(
        JSON.stringify({ error: `ConvertAPI error: ${response.status}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const result = await response.json();

    if (!result.Files || result.Files.length === 0) {
      logger.error("No files returned from ConvertAPI");
      return new Response(
        JSON.stringify({ error: "No files returned from ConvertAPI" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    logger.info("PDF conversion successful", { outputFilename: result.Files[0].FileName });

    return new Response(
      JSON.stringify({
        pdfBase64: result.Files[0].FileData,
        filename: result.Files[0].FileName,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Failed to convert HTML to PDF";
    logger.exception(error as Error, "Error converting HTML to PDF");
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
};
