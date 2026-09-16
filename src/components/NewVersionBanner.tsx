import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useVersionWatcher } from "@/hooks/useVersionWatcher";

export function NewVersionBanner() {
  const { updateAvailable, refresh } = useVersionWatcher();

  if (!updateAvailable) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="fixed bottom-16 right-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-background p-4 shadow-lg max-w-sm"
      data-testid="new-version-banner"
    >
      <div className="flex flex-col">
        <span className="text-sm font-semibold text-foreground">
          A new version is available
        </span>
        <span className="text-xs text-muted-foreground">
          Refresh to load the latest update.
        </span>
      </div>
      <Button size="sm" onClick={refresh} className="shrink-0">
        <RefreshCw aria-hidden="true" />
        Refresh
      </Button>
    </div>
  );
}
