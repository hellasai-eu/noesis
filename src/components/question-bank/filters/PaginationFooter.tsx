/**
 * Pagination footer for the unified Question Bank (#623). Client-side
 * pagination over the already-filtered list — consistent with the legacy
 * per-type tables. Server-side pagination is explicitly out of scope.
 */
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

interface PaginationFooterProps {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export function PaginationFooter({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
}: PaginationFooterProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const atFirst = clampedPage <= 1;
  const atLast = clampedPage >= totalPages;

  return (
    <div
      className="flex flex-col sm:flex-row items-center justify-between gap-3"
      data-testid="bank-pagination-footer"
    >
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Rows per page:</span>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => onPageSizeChange(parseInt(v, 10))}
        >
          <SelectTrigger
            className="w-[80px] h-8"
            data-testid="bank-page-size"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <span
          className="text-sm text-muted-foreground"
          data-testid="bank-page-indicator"
        >
          Page {clampedPage} of {totalPages}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(clampedPage - 1)}
            disabled={atFirst}
            aria-label="Previous page"
            data-testid="bank-page-prev"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(clampedPage + 1)}
            disabled={atLast}
            aria-label="Next page"
            data-testid="bank-page-next"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
