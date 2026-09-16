/**
 * Supabase rejects with a plain `PostgrestError` / `StorageError` object, not
 * an `Error`, so the usual `err instanceof Error ? err.message : fallback`
 * swallows exactly the messages worth showing — "new row violates row-level
 * security policy", "duplicate key", "Payload too large". Read `message` off
 * anything that carries one.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}
