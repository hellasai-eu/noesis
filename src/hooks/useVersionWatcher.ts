import { useCallback, useEffect, useRef, useState } from "react";

import { fetchDeployedVersion } from "@/lib/versionCheck";
import {
  NEW_VERSION_EVENT,
  installChunkLoadRecovery,
} from "@/lib/chunkLoadRecovery";

export const POLL_INTERVAL_MS = 15 * 60 * 1000;
export const MIN_CHECK_INTERVAL_MS = 2 * 60 * 1000;

interface UseVersionWatcherResult {
  updateAvailable: boolean;
  refresh: () => void;
}

export function useVersionWatcher(): UseVersionWatcherResult {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  const lastCheckRef = useRef<number>(0);
  const inFlightRef = useRef<boolean>(false);
  const updateAvailableRef = useRef<boolean>(false);

  const runningVersion = import.meta.env.VITE_GIT_COMMIT as string | undefined;

  const flipToAvailable = useCallback(() => {
    if (updateAvailableRef.current) return;
    updateAvailableRef.current = true;
    setUpdateAvailable(true);
  }, []);

  const check = useCallback(
    async (force = false) => {
      if (updateAvailableRef.current) return;
      if (inFlightRef.current) return;
      const now = Date.now();
      if (!force && now - lastCheckRef.current < MIN_CHECK_INTERVAL_MS) return;
      inFlightRef.current = true;
      lastCheckRef.current = now;
      try {
        const deployed = await fetchDeployedVersion();
        if (
          deployed &&
          typeof runningVersion === "string" &&
          runningVersion.length > 0 &&
          deployed !== runningVersion
        ) {
          flipToAvailable();
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [flipToAvailable, runningVersion],
  );

  useEffect(() => {
    installChunkLoadRecovery();

    void check(true);

    const intervalId = window.setInterval(() => {
      void check();
    }, POLL_INTERVAL_MS);

    const handleFocus = () => {
      void check();
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void check();
      }
    };

    const handleNewVersion = () => {
      flipToAvailable();
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener(NEW_VERSION_EVENT, handleNewVersion);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener(NEW_VERSION_EVENT, handleNewVersion);
    };
  }, [check, flipToAvailable]);

  const refresh = useCallback(() => {
    window.location.reload();
  }, []);

  return { updateAvailable, refresh };
}
