export const NEW_VERSION_EVENT = "noesis:newVersion";

const CHUNK_ERROR_PATTERN =
  /Loading chunk|Failed to fetch dynamically imported module|ChunkLoadError|error loading dynamically imported module|Importing a module script failed/i;

let installed = false;

function looksLikeChunkLoadError(value: unknown): boolean {
  if (!value) return false;
  if (value instanceof Error) {
    if (value.name === "ChunkLoadError") return true;
    return CHUNK_ERROR_PATTERN.test(value.message);
  }
  if (typeof value === "string") return CHUNK_ERROR_PATTERN.test(value);
  if (typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return CHUNK_ERROR_PATTERN.test(message);
  }
  return false;
}

function notify(): void {
  window.dispatchEvent(new CustomEvent(NEW_VERSION_EVENT));
}

export function installChunkLoadRecovery(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    if (looksLikeChunkLoadError(event.error) || looksLikeChunkLoadError(event.message)) {
      notify();
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (looksLikeChunkLoadError(event.reason)) {
      notify();
    }
  });
}

export function __resetChunkLoadRecoveryForTests(): void {
  installed = false;
}
