import { logger } from "../_shared/logger.ts";
import { requireCaller } from "../_shared/require-caller.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ── Caller gate (#1137) ───────────────────────────────────────────────
    // Probes OpenAI file metadata; negligible spend, but an unauthenticated
    // probe of the platform's vector stores regardless.
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

    const { openaiFileId, vectorStoreId } = await req.json();


    if (!openaiFileId || !vectorStoreId) {
      return new Response(
        JSON.stringify({ error: 'Missing openaiFileId or vectorStoreId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) {
      logger.error("OpenAI API key not configured");
      return new Response(
        JSON.stringify({ error: 'OpenAI API key not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    logger.info("Checking vector store file status", { vectorStoreId, fileId: openaiFileId });

    const response = await fetch(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${openaiFileId}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${openaiApiKey}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );

    if (response.status === 404) {
      logger.info("File not found in vector store", { fileId: openaiFileId, vectorStoreId });
      return new Response(
        JSON.stringify({
          inVectorStore: false,
          status: null,
          lastError: null,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("OpenAI API error", { status: response.status, error: errorText });
      return new Response(
        JSON.stringify({ error: `OpenAI API error: ${response.status}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    logger.info("Vector store file status retrieved", { status: data.status, createdAt: data.created_at });

    return new Response(
      JSON.stringify({
        inVectorStore: true,
        status: data.status,
        lastError: data.last_error,
        createdAt: data.created_at,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.exception(error as Error, "Error checking vector store file");
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
};
