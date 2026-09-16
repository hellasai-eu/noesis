import { useEffect, useRef } from "react";

const ACTIVITY_EVENTS = ["mousemove", "keydown", "touchstart", "click"] as const;
export const ACTIVITY_STORAGE_KEY = "noesis:lastActivity";
const BROADCAST_THROTTLE_MS = 1000;

interface UseInactivityTimerOptions {
  timeoutMs: number;
  enabled: boolean;
  onTimeout: () => void;
}

export function useInactivityTimer({
  timeoutMs,
  enabled,
  onTimeout,
}: UseInactivityTimerOptions): void {
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    if (!enabled) return;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastBroadcast = 0;

    const scheduleTimeout = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => onTimeoutRef.current(), timeoutMs);
    };

    const scheduleInitialTimeout = () => {
      let elapsed = 0;
      try {
        const stored = Number(localStorage.getItem(ACTIVITY_STORAGE_KEY) || 0);
        const now = Date.now();
        if (stored > 0 && stored <= now) elapsed = now - stored;
      } catch {
        // localStorage may be unavailable — start fresh
      }
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => onTimeoutRef.current(), Math.max(timeoutMs - elapsed, 0));
    };

    const broadcast = () => {
      const now = Date.now();
      if (now - lastBroadcast < BROADCAST_THROTTLE_MS) return;
      lastBroadcast = now;
      try {
        localStorage.setItem(ACTIVITY_STORAGE_KEY, String(now));
      } catch {
        // localStorage may throw in private mode / quota — safe to ignore
      }
    };

    const handleLocalActivity = () => {
      scheduleTimeout();
      broadcast();
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== ACTIVITY_STORAGE_KEY) return;
      scheduleTimeout();
    };

    scheduleInitialTimeout();

    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, handleLocalActivity, { passive: true });
    }
    window.addEventListener("storage", handleStorage);

    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, handleLocalActivity);
      }
      window.removeEventListener("storage", handleStorage);
    };
  }, [enabled, timeoutMs]);
}
