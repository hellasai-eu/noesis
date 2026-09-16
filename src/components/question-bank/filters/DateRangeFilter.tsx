/**
 * Created-date filter (#623). Presets compute a `from`/`to` ISO date pair
 * and emit it to the parent — the URL only ever stores the absolute dates.
 * "Custom range" opens a two-month range picker.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CalendarIcon, ChevronDown, X } from "lucide-react";
import type { DateRange } from "react-day-picker";

export type DatePreset = "today" | "last_7d" | "last_30d" | "last_90d" | "all";

interface DateRangeFilterProps {
  /** ISO date `YYYY-MM-DD`, inclusive. */
  from: string | null;
  /** ISO date `YYYY-MM-DD`, inclusive. */
  to: string | null;
  onChange: (next: { from: string | null; to: string | null }) => void;
  testId?: string;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function fromDateString(s: string | null): Date | undefined {
  if (!s) return undefined;
  const parts = s.split("-").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return undefined;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

/**
 * Compute the preset window relative to `now`. Used both to apply a preset
 * and to detect whether the current `from/to` matches a known preset on
 * mount (so the trigger label round-trips through a URL refresh).
 */
function presetRange(preset: DatePreset, now: Date): { from: string | null; to: string | null } {
  if (preset === "all") return { from: null, to: null };
  const today = startOfDay(now);
  const to = isoDate(today);
  if (preset === "today") return { from: to, to };
  const days = preset === "last_7d" ? 7 : preset === "last_30d" ? 30 : 90;
  const fromDate = new Date(today);
  fromDate.setDate(today.getDate() - (days - 1));
  return { from: isoDate(fromDate), to };
}

const PRESET_LABEL: Record<DatePreset, string> = {
  all: "All time",
  today: "Today",
  last_7d: "Last 7 days",
  last_30d: "Last 30 days",
  last_90d: "Last 90 days",
};

const PRESETS: DatePreset[] = ["all", "today", "last_7d", "last_30d", "last_90d"];

function matchPreset(
  from: string | null,
  to: string | null,
  now: Date,
): DatePreset | null {
  for (const p of PRESETS) {
    const range = presetRange(p, now);
    if (range.from === from && range.to === to) return p;
  }
  return null;
}

export function DateRangeFilter({
  from,
  to,
  onChange,
  testId,
}: DateRangeFilterProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const now = new Date();
  const matched = matchPreset(from, to, now);

  const label =
    matched !== null
      ? PRESET_LABEL[matched]
      : from && to
        ? `${from} → ${to}`
        : "All time";

  const handlePreset = (preset: DatePreset) => {
    onChange(presetRange(preset, now));
  };

  const handleRangeSelect = (range: DateRange | undefined) => {
    const next = {
      from: range?.from ? isoDate(range.from) : null,
      to: range?.to ? isoDate(range.to) : null,
    };
    onChange(next);
  };

  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange({ from: null, to: null });
  };

  const hasFilter = from != null || to != null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="justify-between min-w-[160px] gap-2"
          data-testid={testId}
        >
          <span className="flex items-center gap-2 truncate">
            <CalendarIcon className="w-3 h-3 opacity-60" />
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Date
            </span>
            <span className="text-sm truncate">{label}</span>
          </span>
          <span className="flex items-center gap-1">
            {hasFilter && (
              <X
                className="w-3 h-3 text-muted-foreground hover:text-foreground"
                onClick={clear}
                aria-label="Clear date filter"
                role="button"
              />
            )}
            <ChevronDown className="w-3 h-3 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="flex flex-col gap-1 min-w-[180px]">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => handlePreset(preset)}
              className={`text-left text-sm px-2 py-1.5 rounded hover:bg-secondary transition-colors ${
                matched === preset ? "bg-secondary font-medium" : ""
              }`}
              data-testid={testId ? `${testId}-preset-${preset}` : undefined}
            >
              {PRESET_LABEL[preset]}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setCustomOpen((v) => !v)}
            className={`text-left text-sm px-2 py-1.5 rounded hover:bg-secondary transition-colors ${
              hasFilter && matched === null ? "bg-secondary font-medium" : ""
            }`}
            data-testid={testId ? `${testId}-preset-custom` : undefined}
          >
            Custom range…
          </button>
          {customOpen && (
            <div className="mt-1 border-t pt-2">
              <Calendar
                mode="range"
                numberOfMonths={1}
                selected={{
                  from: fromDateString(from),
                  to: fromDateString(to),
                }}
                onSelect={handleRangeSelect}
              />
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Exposed for testing — given a `from/to` pair, does it fall in the window? */
export function isWithinRange(
  iso: string,
  from: string | null,
  to: string | null,
): boolean {
  if (!from && !to) return true;
  const dt = new Date(iso);
  const d = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}
