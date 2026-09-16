import { assertEquals, assertRejects } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { getSignedUrl } from "../convertapi-utils.ts";

function createMockSupabase(signedUrl: string | null, error: any = null) {
  return {
    storage: {
      from: (_bucket: string) => ({
        createSignedUrl: (_path: string, _expiry: number) => {
          if (error) {
            return Promise.resolve({ data: null, error });
          }
          return Promise.resolve({
            data: { signedUrl },
            error: null,
          });
        },
      }),
    },
  };
}

Deno.test("getSignedUrl: returns url and fileName on success", async () => {
  const supabase = createMockSupabase("https://example.com/signed-url");
  const result = await getSignedUrl(supabase, "my-bucket", "uploads/test-file.pdf");

  assertEquals(result.url, "https://example.com/signed-url");
  assertEquals(result.fileName, "test-file.pdf");
});

Deno.test("getSignedUrl: uses custom expiry", async () => {
  let capturedExpiry = 0;
  const supabase = {
    storage: {
      from: () => ({
        createSignedUrl: (_path: string, expiry: number) => {
          capturedExpiry = expiry;
          return Promise.resolve({
            data: { signedUrl: "https://example.com/url" },
            error: null,
          });
        },
      }),
    },
  };

  await getSignedUrl(supabase, "bucket", "file.pdf", 7200);
  assertEquals(capturedExpiry, 7200);
});

Deno.test("getSignedUrl: throws on error", async () => {
  const supabase = createMockSupabase(null, { message: "Bucket not found" });

  await assertRejects(
    () => getSignedUrl(supabase, "bad-bucket", "file.pdf"),
    Error,
    "Failed to generate signed URL",
  );
});

Deno.test("getSignedUrl: throws when signedUrl is missing", async () => {
  const supabase = {
    storage: {
      from: () => ({
        createSignedUrl: () =>
          Promise.resolve({ data: {}, error: null }),
      }),
    },
  };

  await assertRejects(
    () => getSignedUrl(supabase, "bucket", "file.pdf"),
    Error,
    "Failed to generate signed URL",
  );
});

Deno.test("getSignedUrl: extracts fileName from nested path", async () => {
  const supabase = createMockSupabase("https://example.com/url");
  const result = await getSignedUrl(supabase, "bucket", "a/b/c/deep-file.pdf");

  assertEquals(result.fileName, "deep-file.pdf");
});
