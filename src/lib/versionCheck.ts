type NavigateFn = (target: string) => void;

interface VersionPayload {
  version: string;
}

export async function fetchDeployedVersion(): Promise<string | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as VersionPayload;
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

export async function checkVersionAndNavigate(
  target: string,
  navigate: NavigateFn,
  currentVersion: string = import.meta.env.VITE_GIT_COMMIT,
): Promise<void> {
  const deployed = await fetchDeployedVersion();
  if (deployed && currentVersion && deployed !== currentVersion) {
    window.location.assign(target);
    return;
  }
  navigate(target);
}
