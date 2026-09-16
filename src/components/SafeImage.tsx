import * as React from "react";

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type SafeImageProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  /** Rendered when src is missing or the image fails to load */
  fallback?: React.ReactNode;
  /** Optional wrapper classes (useful for fixed-size containers) */
  wrapperClassName?: string;
  /** Show diagnostic tooltip on error (dev mode) */
  showDiagnostics?: boolean;
};

export function SafeImage({
  src,
  alt,
  fallback = null,
  wrapperClassName,
  className,
  onError,
  crossOrigin,
  showDiagnostics = true,
  ...props
}: SafeImageProps) {
  const [failed, setFailed] = React.useState(false);
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const showImage = Boolean(src) && !failed;

  const errorFallback = (
    <div className="flex flex-col items-center justify-center text-destructive text-xs">
      {fallback}
      {showDiagnostics && failedUrl && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="mt-1 cursor-help underline decoration-dotted text-[10px] opacity-70">
                Logo failed to load
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs break-all text-xs">
              <p className="font-semibold mb-1">Failed URL:</p>
              <code className="text-[10px] bg-muted p-1 rounded block">{failedUrl}</code>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );

  return (
    <div className={cn("inline-flex items-center justify-center", wrapperClassName)}>
      {showImage ? (
        <img
          src={src}
          alt={alt}
          className={className}
          crossOrigin={crossOrigin ?? "anonymous"}
          data-cmp-noconsent="true"
          onError={(e) => {
            setFailed(true);
            setFailedUrl(src || null);
            onError?.(e);
          }}
          {...props}
        />
      ) : (
        errorFallback
      )}
    </div>
  );
}
