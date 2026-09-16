import { logger } from "../_shared/logger.ts";
import { requireCaller } from "../_shared/require-caller.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ── Caller gate (#1137) ───────────────────────────────────────────────
    // Converts caller-supplied Markdown and bills the platform's ConvertAPI quota.
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

    const { markdown, html, filename, pageSize = 'a4' } = await req.json();


    if (!markdown && !html) {
      logger.error("Missing markdown or html content");
      return new Response(
        JSON.stringify({ error: 'Missing markdown or html content' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const convertApiKey = Deno.env.get('CONVERT_API_KEY');
    if (!convertApiKey) {
      logger.error("CONVERT_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: 'CONVERT_API_KEY not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // HTML inputs render LaTeX/KaTeX (issue #657); plain markdown stays on the md/to/pdf route.
    const useHtml = typeof html === 'string' && html.length > 0;
    const sourceFormat = useHtml ? 'html' : 'md';
    const convertEndpoint = useHtml
      ? 'https://v2.convertapi.com/convert/html/to/pdf'
      : 'https://v2.convertapi.com/convert/md/to/pdf';
    const body = useHtml ? html : markdown;

    logger.info("Converting to PDF", { filename: filename || 'test', pageSize, sourceFormat });

    // Base64-encode the source. Avoid String.fromCharCode(...mdBytes) — for large
    // HTML inputs that exceeds the JS call-stack limit and throws.
    const encoder = new TextEncoder();
    const sourceBytes = encoder.encode(body);
    let binary = '';
    for (let i = 0; i < sourceBytes.length; i++) {
      binary += String.fromCharCode(sourceBytes[i]);
    }
    const sourceBase64 = btoa(binary);

    // Call ConvertAPI
    const response = await fetch(convertEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${convertApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Parameters: [
          {
            Name: 'File',
            FileValue: {
              Name: `${filename || 'test'}.${sourceFormat}`,
              Data: sourceBase64,
            }
          },
          { Name: 'PageSize', Value: pageSize },
          { Name: 'StoreFile', Value: false }
        ]
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("ConvertAPI error", { status: response.status, error: errorText });
      return new Response(
        JSON.stringify({ error: `ConvertAPI error: ${response.status}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = await response.json();

    if (!result.Files || result.Files.length === 0) {
      logger.error("No files returned from ConvertAPI");
      return new Response(
        JSON.stringify({ error: 'No files returned from ConvertAPI' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    logger.info("PDF conversion successful", { outputFilename: result.Files[0].FileName });

    return new Response(
      JSON.stringify({
        pdfBase64: result.Files[0].FileData,
        filename: result.Files[0].FileName
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to convert to PDF';
    logger.exception(error as Error, "Error converting to PDF");
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
};
