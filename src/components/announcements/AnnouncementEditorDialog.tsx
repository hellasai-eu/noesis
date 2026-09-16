import { useEffect, useState } from "react";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { CalendarIcon, Loader2, X } from "lucide-react";
import { format } from "date-fns";
import { MarkdownContent } from "./MarkdownContent";

const announcementSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200, "Title is too long"),
  body: z.string().trim().min(1, "Body is required").max(20000, "Body is too long"),
});

export interface AnnouncementSectionOption {
  offeringId: string;
  label: string;
}

export interface AnnouncementEditorValues {
  title: string;
  body: string;
  offeringIds: string[];
  expiresAt: string | null;
}

interface AnnouncementEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValues?: {
    title: string;
    body: string;
    offeringIds?: string[];
    expiresAt?: string | null;
  } | null;
  sections?: AnnouncementSectionOption[];
  onSubmit: (values: AnnouncementEditorValues) => Promise<void> | void;
  submitting?: boolean;
}

// An announcement expires at the end of the selected day in the user's local
// timezone — the instructor picks a date, not a time, and "expires Friday"
// should include all of Friday.
function endOfDayIso(date: Date): string {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

function isoToDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function AnnouncementEditorDialog({
  open,
  onOpenChange,
  initialValues,
  sections = [],
  onSubmit,
  submitting = false,
}: AnnouncementEditorDialogProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [offeringIds, setOfferingIds] = useState<Set<string>>(new Set());
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ title?: string; body?: string }>({});

  useEffect(() => {
    if (open) {
      setTitle(initialValues?.title ?? "");
      setBody(initialValues?.body ?? "");
      setOfferingIds(new Set(initialValues?.offeringIds ?? []));
      setExpiresAt(initialValues?.expiresAt ?? null);
      setErrors({});
    }
  }, [open, initialValues]);

  const toggleOffering = (id: string, checked: boolean) => {
    setOfferingIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = announcementSchema.safeParse({ title, body });
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({ title: flat.title?.[0], body: flat.body?.[0] });
      return;
    }
    setErrors({});
    // The trimmed locals rather than `parsed.data`. The schema still validates —
    // that is what the guard above is for — but this project compiles with
    // `strictNullChecks: false`, under which zod infers every field of its
    // output as optional, so `parsed.data` will not satisfy
    // `AnnouncementEditorValues`. Trimming is the schema's only transform, so
    // these are the same values it would have returned.
    await onSubmit({
      title: title.trim(),
      body: body.trim(),
      offeringIds: Array.from(offeringIds),
      expiresAt,
    });
  };

  const isEdit = Boolean(initialValues);
  const expiresAtDate = isoToDate(expiresAt);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit announcement" : "New announcement"}</DialogTitle>
          <DialogDescription>
            Post an announcement for students. Markdown is supported.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="announcement-title">Title</Label>
            <Input
              id="announcement-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Midterm review session on Friday"
              maxLength={200}
              disabled={submitting}
            />
            {errors.title && (
              <p className="text-xs text-destructive">{errors.title}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="announcement-body">Body</Label>
            <Tabs defaultValue="edit" className="w-full">
              <TabsList className="mb-2">
                <TabsTrigger value="edit">Edit</TabsTrigger>
                <TabsTrigger value="preview">Preview</TabsTrigger>
              </TabsList>
              <TabsContent value="edit">
                <Textarea
                  id="announcement-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Write your announcement... (markdown supported)"
                  rows={10}
                  disabled={submitting}
                />
              </TabsContent>
              <TabsContent value="preview">
                <div className="min-h-[240px] rounded-md border border-input bg-background p-3">
                  {body.trim() ? (
                    <MarkdownContent>{body}</MarkdownContent>
                  ) : (
                    <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>
                  )}
                </div>
              </TabsContent>
            </Tabs>
            {errors.body && (
              <p className="text-xs text-destructive">{errors.body}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Expiration date (optional)</Label>
            <p className="text-xs text-muted-foreground">
              After this date the announcement moves to the Archived section.
              Leave empty for announcements that never expire.
            </p>
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={submitting}
                    aria-label="Pick expiration date"
                    className="justify-start font-normal"
                  >
                    <CalendarIcon className="w-4 h-4 mr-2" />
                    {expiresAtDate ? format(expiresAtDate, "PPP") : "No expiration"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={expiresAtDate}
                    onSelect={(d) => setExpiresAt(d ? endOfDayIso(d) : null)}
                    disabled={{ before: new Date() }}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              {expiresAt && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={submitting}
                  onClick={() => setExpiresAt(null)}
                  aria-label="Clear expiration date"
                >
                  <X className="w-4 h-4" />
                </Button>
              )}
            </div>
          </div>

          {sections.length > 0 && (
            <div className="space-y-2">
              <Label>Assign to sections</Label>
              <p className="text-xs text-muted-foreground">
                Leave all unchecked to hide from students (saves as a draft).
              </p>
              <div className="grid sm:grid-cols-2 gap-2 pt-1">
                {sections.map((s) => {
                  const checked = offeringIds.has(s.offeringId);
                  return (
                    <label
                      key={s.offeringId}
                      className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm cursor-pointer"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => toggleOffering(s.offeringId, Boolean(v))}
                        disabled={submitting}
                        aria-label={`Target section ${s.label}`}
                      />
                      <span className="truncate">{s.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {isEdit ? "Save changes" : "Post announcement"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
