/**
 * Shared utility for uploading PDF content directly to OpenAI Files API
 */

import { OpenAIError } from "./openai-client.ts";
import { logger } from "./logger.ts";

/**
 * Upload PDF bytes directly to OpenAI Files API
 * Returns the OpenAI file ID for use with saved prompts
 */
export async function uploadPdfToOpenAI(
  pdfBlob: Blob,
  fileName: string = "document.pdf"
): Promise<string> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new OpenAIError("OPENAI_API_KEY is not configured", 500);
  }

  const formData = new FormData();
  formData.append("purpose", "assistants");
  formData.append("file", pdfBlob, fileName);

  logger.info("[file-upload] Uploading file to OpenAI", { fileName, sizeBytes: pdfBlob.size });

  const response = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("[file-upload] OpenAI Files API error", { status: response.status, error: errorText });
    throw new OpenAIError(`OpenAI Files API error: ${response.status} - ${errorText}`, response.status);
  }

  const data = await response.json();
  logger.info("[file-upload] OpenAI file created", { fileId: data.id });
  
  return data.id;
}

/**
 * Delete a file from OpenAI Files API
 */
export async function deleteOpenAIFile(fileId: string): Promise<void> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new OpenAIError("OPENAI_API_KEY is not configured", 500);
  }

  logger.info("[file-upload] Deleting OpenAI file", { fileId });

  const response = await fetch(`https://api.openai.com/v1/files/${fileId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("[file-upload] OpenAI Files API delete error", { status: response.status, error: errorText });
    // Don't throw - cleanup failures shouldn't break the flow
  } else {
    logger.info("[file-upload] OpenAI file deleted", { fileId });
  }
}
