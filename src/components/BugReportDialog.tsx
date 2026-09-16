import { useRef, useState } from "react";
import { z } from "zod";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Bug, Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";

export const MAX_SCREENSHOTS = 5;
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg"] as const;

const bugReportSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200, "Title is too long"),
  description: z
    .string()
    .trim()
    .min(1, "Description is required")
    .max(5000, "Description is too long"),
});

interface BugReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Best-effort OS sniff from the UA string — sufficient for triage, not
// authoritative (UA freezing can return values like "Windows" with no version).
function detectOs(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (ua.includes("windows")) return "Windows";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "macOS";
  if (ua.includes("android")) return "Android";
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ios")) return "iOS";
  if (ua.includes("linux")) return "Linux";
  return "Unknown";
}

function sanitizeFileName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function BugReportDialog({ open, onOpenChange }: BugReportDialogProps) {
  const { user, profile } = useAuth();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setTitle("");
    setDescription("");
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleOpenChange = (next: boolean) => {
    if (submitting) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const handleFileSelect = (incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    const accepted: File[] = [];
    for (const file of Array.from(incoming)) {
      if (!ALLOWED_MIME_TYPES.includes(file.type as typeof ALLOWED_MIME_TYPES[number])) {
        toast.error(`${file.name}: only PNG or JPG allowed`);
        continue;
      }
      if (file.size > MAX_SCREENSHOT_BYTES) {
        toast.error(`${file.name}: must be 5MB or smaller`);
        continue;
      }
      accepted.push(file);
    }
    setFiles((prev) => {
      const merged = [...prev, ...accepted];
      if (merged.length > MAX_SCREENSHOTS) {
        toast.error(`Maximum ${MAX_SCREENSHOTS} screenshots`);
        return merged.slice(0, MAX_SCREENSHOTS);
      }
      return merged;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      toast.error("You must be signed in to report a bug");
      return;
    }

    const parsed = bugReportSchema.safeParse({ title, description });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }

    setSubmitting(true);
    const uploadedPaths: string[] = [];

    try {
      // Upload screenshots first so we can store their paths in the row.
      for (const file of files) {
        const safeName = sanitizeFileName(file.name);
        const path = `${user.id}/${crypto.randomUUID()}-${safeName}`;
        const { error: uploadError } = await supabase.storage
          .from("bug-reports")
          .upload(path, file, { cacheControl: "3600", upsert: false });
        if (uploadError) throw uploadError;
        uploadedPaths.push(path);
      }

      // Resolve role: prefer institution role for the currently-selected
      // institution; fall back to "super_admin" / "user" if none is set.
      let reporterRole = "user";
      const selectedInstitutionId =
        typeof window !== "undefined"
          ? sessionStorage.getItem("selectedInstitutionId")
          : null;
      if (selectedInstitutionId) {
        const { data: roleData } = await supabase.rpc("get_user_role_in_institution", {
          _user_id: user.id,
          _institution_id: selectedInstitutionId,
        });
        if (typeof roleData === "string" && roleData.length > 0) {
          reporterRole = roleData;
        }
      }
      if (reporterRole === "user") {
        const { data: superAdmin } = await supabase.rpc("is_super_admin", { _user_id: user.id });
        if (superAdmin) reporterRole = "super_admin";
      }

      const viewport = `${window.innerWidth}x${window.innerHeight}`;
      const userAgent = navigator.userAgent;
      const pageUrl = window.location.href;
      const os = detectOs(userAgent);

      const { error: insertError } = await (supabase.from("bug_reports" as any) as any).insert({
        reporter_id: user.id,
        reporter_email: profile?.email ?? user.email ?? null,
        reporter_role: reporterRole,
        institution_id: selectedInstitutionId,
        title: parsed.data.title,
        description: parsed.data.description,
        page_url: pageUrl,
        user_agent: userAgent,
        viewport,
        os,
        screenshot_paths: uploadedPaths,
      });
      if (insertError) throw insertError;

      toast.success("Bug report submitted — thank you!");
      reset();
      onOpenChange(false);
    } catch (error: unknown) {
      console.error("Failed to submit bug report:", error);
      // Supabase errors arrive as plain objects with a `message` field, not
      // Error instances, so we have to check both shapes.
      let message = "Failed to submit bug report";
      if (error instanceof Error) {
        message = error.message;
      } else if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as { message: unknown }).message === "string"
      ) {
        message = (error as { message: string }).message;
      }
      toast.error(message);
      // Best-effort cleanup of any screenshots uploaded before the row insert failed.
      if (uploadedPaths.length > 0) {
        try {
          await supabase.storage.from("bug-reports").remove(uploadedPaths);
        } catch (cleanupError) {
          console.error("Failed to clean up uploaded screenshots:", cleanupError);
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="w-5 h-5" />
            Report a bug
          </DialogTitle>
          <DialogDescription>
            Describe what went wrong. Screenshots help us reproduce the issue.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bug-title">Title</Label>
            <Input
              id="bug-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short summary"
              maxLength={200}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="bug-description">Description</Label>
            <Textarea
              id="bug-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What happened? What did you expect to happen?"
              rows={5}
              maxLength={5000}
              required
            />
            <p className="text-xs text-muted-foreground text-right">
              {description.length}/5000
            </p>
          </div>

          <div className="space-y-2">
            <Label>Screenshots ({files.length}/{MAX_SCREENSHOTS})</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg"
              multiple
              className="hidden"
              data-testid="bug-screenshot-input"
              onChange={(e) => handleFileSelect(e.target.files)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={files.length >= MAX_SCREENSHOTS}
            >
              <Upload className="w-4 h-4 mr-2" />
              Attach screenshot
            </Button>
            <p className="text-xs text-muted-foreground">
              PNG or JPG, up to 5MB each. Maximum {MAX_SCREENSHOTS}.
            </p>

            {files.length > 0 && (
              <ul className="space-y-2 pt-2">
                {files.map((file, index) => (
                  <li
                    key={`${file.name}-${index}`}
                    className="flex items-center justify-between gap-2 rounded-md border bg-secondary/40 px-3 py-2 text-sm"
                  >
                    <span className="truncate flex-1">{file.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {(file.size / 1024).toFixed(0)} KB
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => removeFile(index)}
                      aria-label={`Remove ${file.name}`}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                "Submit report"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
