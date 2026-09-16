/**
 * Utility for fetching files from Supabase Storage.
 */

/**
 * Generate a signed URL for a file in Supabase Storage.
 * Lets external services (e.g. ConvertAPI) fetch the file directly,
 * avoiding large in-memory downloads in edge functions.
 */
export async function getSignedUrl(
  supabase: any,
  bucketName: string,
  filePath: string,
  expirySeconds = 3600,
): Promise<{ url: string; fileName: string }> {
  const { data, error } = await supabase.storage
    .from(bucketName)
    .createSignedUrl(filePath, expirySeconds);

  if (error || !data?.signedUrl) {
    throw new Error(
      `Failed to generate signed URL for ${bucketName}/${filePath}: ${error?.message || "Unknown error"}`,
    );
  }

  const fileName = filePath.split("/").pop() || filePath;

  return { url: data.signedUrl, fileName };
}

export async function fetchFileAsBase64(
  supabase: any,
  bucketName: string,
  filePath: string,
): Promise<{ base64: string; fileName: string }> {
  const { data, error } = await supabase.storage
    .from(bucketName)
    .download(filePath);

  if (error || !data) {
    throw new Error(
      `Failed to download file from ${bucketName}/${filePath}: ${error?.message}`,
    );
  }

  const arrayBuffer = await data.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  const fileName = filePath.split("/").pop() || filePath;

  return { base64, fileName };
}
