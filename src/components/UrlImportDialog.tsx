import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Eye, Globe, Loader2, PenLine, Undo2, Youtube } from "lucide-react";
import { toast } from "sonner";
import {
  buildImportedMarkdown,
  formatVideoDuration,
  importedFileStem,
  importFallbackStem,
  IMPORT_KIND_COPY,
  importKindMismatch,
  isImportableUrl,
  normalizeImportUrl,
  seedImportedContent,
  type ImportKind,
} from "@/lib/url-import";
import { formatNumber } from "@/i18n/formatters";
import { MarkdownContent } from "@/components/announcements/MarkdownContent";
import { MATERIAL_TYPE_LABELS, WHOLE_DOCUMENT_MATERIAL_TYPE } from "@/components/MaterialUploadDialog";

interface UrlImportDialogProps {
  courseId: string;
  /**
   * Which of the two imports the instructor picked from the menu.
   *
   * The dialog is one component rather than two because everything after the
   * fetch — the title field, the Markdown editor, the preview, the save — is
   * identical; only the copy, the accepted link and the summary line differ.
   */
  kind: ImportKind;
  /**
   * The course's language, sent with the request: a provider that can serve a
   * page or a caption track in several languages gives back the one the class
   * is taught in.
   */
  courseLanguage?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

interface FetchedContent {
  kind: ImportKind;
  url: string;
  videoId: string | null;
  title: string | null;
  author: string | null;
  durationSeconds: number | null;
  language: string | null;
  /** Transcript prose for a video, Markdown for a page. */
  markdown: string;
  characterCount: number;
}

/** Pull the real error message out of a FunctionsHttpError's stashed Response. */
async function extractFunctionError(error: unknown, fallback: string): Promise<string> {
  let message = (error as { message?: string })?.message || fallback;
  const ctx = (error as { context?: { json?: () => Promise<unknown> } })?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const body = (await ctx.json()) as { error?: string; message?: string };
      if (body?.error) message = body.error;
      else if (body?.message) message = body.message;
    } catch {
      /* body wasn't JSON — keep the default message */
    }
  }
  return message;
}

/**
 * Remove an OpenAI file uploaded for a material row that was never created.
 *
 * Retried once, because the common failure is a transient network fault and a
 * second attempt costs nothing. It cannot be made airtight from here — a closed
 * tab ends the rollback mid-flight — so the caller reports what was left behind
 * rather than pretending it succeeded. Making this durable means moving the
 * whole save server-side, which is a larger change than this feature.
 *
 * Returns true when the file is gone (or was never OpenAI's to begin with).
 */
async function deleteOrphanedOpenAIFile(
  openaiFileId: string,
  courseId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.functions
      .invoke("delete-from-openai", {
        body: { action: "delete-orphan", openaiFileId, courseId },
      })
      .catch((invokeError: unknown) => ({ data: null, error: invokeError }));

    if (!error && !(data as { error?: string } | null)?.error) return true;

    console.error("[UrlImport] Orphan cleanup failed", { openaiFileId, attempt, error });
  }
  return false;
}

/**
 * Import a link as a course material.
 *
 * A YouTube video becomes its transcript; a web page becomes the page as
 * Markdown. Either way the result is stored as a `.md` material of type
 * "other", taking the same route a PDF upload does — storage object, OpenAI
 * file, `course_materials` row — so nothing downstream has to know the material
 * began as a link. Text only: no frames, images or other media.
 */
export function UrlImportDialog({
  courseId,
  kind,
  courseLanguage,
  open,
  onOpenChange,
  onSuccess,
}: UrlImportDialogProps) {
  const { user } = useAuth();
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState<FetchedContent | null>(null);
  const [title, setTitle] = useState("");
  /**
   * The Markdown as it will be saved.
   *
   * Seeded from what came back and editable from there: extraction is
   * imperfect — auto-captions mishear terms, a scrape can drag in a stray
   * "Related articles" list — and an instructor who can fix that in place gets
   * a usable study source instead of discarding the import.
   */
  const [content, setContent] = useState("");
  /**
   * What the editor was seeded with — the baseline for "edited" and for Revert.
   *
   * Not `fetched.markdown`: a transcript is escaped on the way into the editor,
   * so comparing against the raw response would call every YouTube import
   * edited before anyone touched it.
   */
  const [seededContent, setSeededContent] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingStep, setSavingStep] = useState<string | null>(null);

  const copy = IMPORT_KIND_COPY[kind];

  useEffect(() => {
    if (!open) {
      setUrl("");
      setUrlError(null);
      setFetching(false);
      setFetched(null);
      setTitle("");
      setContent("");
      setSeededContent("");
      setShowPreview(false);
      setSaving(false);
      setSavingStep(null);
    }
  }, [open]);

  const handleFetch = async () => {
    if (!isImportableUrl(url)) {
      setUrlError("Enter a link starting with http:// or https://.");
      return;
    }
    // A link pasted under the wrong action, caught before the round trip: the
    // server refuses the same pairs, but there is nothing to learn from a
    // request whose answer is already known here.
    const mismatch = importKindMismatch(kind, url);
    if (mismatch) {
      setUrlError(mismatch);
      return;
    }
    setUrlError(null);
    setFetching(true);
    setFetched(null);

    try {
      const { data, error } = await supabase.functions.invoke("fetch-url-content", {
        body: { url: normalizeImportUrl(url), courseId, language: courseLanguage, kind },
      });

      if (error) {
        throw new Error(await extractFunctionError(error, "Failed to read that link"));
      }
      if (data?.error) throw new Error(data.error);
      if (!data?.markdown) throw new Error("Nothing readable came back from that link");

      const result = data as FetchedContent;
      setFetched(result);
      // The provider does not always know a title. Falling back to the host
      // would name every video "www.youtube.com", so a video falls back to its
      // id instead — enough to tell two imports apart, and editable below.
      setTitle(
        result.title?.trim() ||
          (result.kind === "youtube"
            ? result.videoId ?? result.url
            : new URL(result.url).hostname),
      );
      const seed = seedImportedContent(result.kind, result.markdown);
      setSeededContent(seed);
      setContent(seed);
      setShowPreview(false);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to read that link";
      setUrlError(message);
      toast.error(message);
    } finally {
      setFetching(false);
    }
  };

  const handleSave = async () => {
    if (!fetched || !user || content.trim().length === 0) return;

    const materialTitle = title.trim() || fetched.title?.trim() || fetched.url;
    setSaving(true);

    let finalPath: string | null = null;
    let openaiFileId: string | null = null;

    try {
      // Stored as Markdown, not as a rendered PDF: OpenAI takes `.md` as an
      // `input_file` and in a vector store, so the study-guide path works on it
      // unchanged, and the text stays text.
      setSavingStep("Preparing the document…");
      const markdown = buildImportedMarkdown({
        title: materialTitle,
        sourceUrl: fetched.url,
        kind: fetched.kind,
        author: fetched.author,
        language: fetched.language,
        content,
      });

      const fileStem = importedFileStem(
        materialTitle,
        importFallbackStem(fetched.url, fetched.videoId),
      );
      const fileName = `${fileStem}.md`;
      const markdownBlob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });

      // Stored under the course prefix — the same shape `MaterialUploadDialog`
      // writes, which is what `upload-to-openai` authorizes against.
      setSavingStep("Uploading…");
      const timestamp = Date.now();
      finalPath = `${courseId}/${timestamp}-${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from("course-materials")
        .upload(finalPath, markdownBlob, {
          cacheControl: "3600",
          upsert: false,
          contentType: "text/markdown;charset=utf-8",
        });

      if (uploadError) throw uploadError;

      // OpenAI before the row, so a material that never reached OpenAI is never
      // created (same rule as the PDF upload path).
      setSavingStep("Indexing for AI…");
      const { data: openaiData, error: openaiError } = await supabase.functions.invoke("upload-to-openai", {
        body: { filePath: finalPath, fileName, courseId },
      });

      if (openaiError) {
        throw new Error(await extractFunctionError(openaiError, "Failed to sync the file to OpenAI"));
      }
      if (openaiData?.error) throw new Error(openaiData.error);
      if (!openaiData?.openaiFileId) throw new Error("OpenAI did not return a file ID");
      openaiFileId = openaiData.openaiFileId as string;

      const { error: dbError } = await supabase.from("course_materials").insert({
        course_id: courseId,
        file_name: fileName,
        file_url: finalPath,
        file_size: markdownBlob.size,
        uploaded_by: user.id,
        title: materialTitle,
        author: fetched.author || null,
        description: fetched.url,
        material_type: WHOLE_DOCUMENT_MATERIAL_TYPE,
        openai_file_id: openaiFileId,
      });

      if (dbError) throw dbError;
      // Past this point nothing is left to undo, so the rollback below must not
      // delete the file the row now owns.
      openaiFileId = null;

      toast.success(`Saved to ${MATERIAL_TYPE_LABELS[WHOLE_DOCUMENT_MATERIAL_TYPE]}`);
      onSuccess();
      onOpenChange(false);
    } catch (error: unknown) {
      // Leave nothing behind that the app can no longer see. The storage object
      // is easy; the OpenAI file matters more, because the ordinary deletion
      // flow is driven from the material row — so a file uploaded for a row
      // that was never created would stay in the institution's vector store,
      // unattributable and unreachable from the UI. `delete-orphan` exists for
      // exactly this case and refuses any file a material does own.
      if (finalPath) {
        await supabase.storage.from("course-materials").remove([finalPath]).catch(() => undefined);
      }
      let orphanLeftBehind = false;
      if (openaiFileId) {
        orphanLeftBehind = !(await deleteOrphanedOpenAIFile(openaiFileId, courseId));
      }
      const message = error instanceof Error ? error.message : "Failed to save the import";
      console.error("[UrlImport] Save failed:", error);
      // A failed cleanup is worth saying out loud rather than hiding in the
      // console: the file is indexed, nothing in the app owns it, and the
      // person who can act on that is not looking at devtools.
      if (orphanLeftBehind) {
        toast.error(
          `${message}. A leftover file could not be removed from the AI index — tell an administrator (id ${openaiFileId}).`,
          { duration: 12_000 },
        );
      } else {
        toast.error(message);
      }
    } finally {
      setSaving(false);
      setSavingStep(null);
    }
  };

  const busy = fetching || saving;
  const duration = formatVideoDuration(fetched?.durationSeconds);
  // Counted off the edited text, not what arrived — the number has to describe
  // what is about to be saved.
  const trimmedContent = content.trim();
  const wordCount = trimmedContent.length === 0 ? 0 : trimmedContent.split(/\s+/).length;
  const isEdited = fetched !== null && content !== seededContent;

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-2xl w-[95vw] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {kind === "youtube" ? <Youtube className="w-5 h-5" /> : <Globe className="w-5 h-5" />}
            {copy.title}
          </DialogTitle>
          <DialogDescription>
            {copy.description} It is saved under{" "}
            {MATERIAL_TYPE_LABELS[WHOLE_DOCUMENT_MATERIAL_TYPE]}.
          </DialogDescription>
        </DialogHeader>

        {/* `min-w-0` is load-bearing. `DialogContent` is a grid, and a grid item
            defaults to `min-width: auto`, so its track cannot shrink below the
            item's min-content width. The fetched-title line below uses
            `truncate` (`white-space: nowrap`), whose min-content width is the
            WHOLE title — so a long one widened this track past the panel's
            `max-w-2xl`, and the description, the title field and the Save
            button were all clipped at the panel edge. Letting the track shrink
            is what allows `truncate` to actually truncate. */}
        <div className="min-w-0 space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="import-url">{kind === "youtube" ? "Video link" : "Page link"}</Label>
            <div className="flex gap-2">
              <Input
                id="import-url"
                value={url}
                autoComplete="off"
                placeholder={copy.placeholder}
                disabled={busy}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setUrlError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) {
                    e.preventDefault();
                    handleFetch();
                  }
                }}
              />
              <Button onClick={handleFetch} disabled={busy || url.trim().length === 0}>
                {fetching ? <Loader2 className="w-4 h-4 animate-spin" /> : "Fetch"}
              </Button>
            </div>
            {urlError && <p className="text-xs text-destructive">{urlError}</p>}
          </div>

          {fetched && (
            <div className="space-y-4">
              <div className="rounded-lg bg-secondary/50 p-3 space-y-1">
                <p className="text-sm font-medium truncate">{fetched.title || fetched.url}</p>
                <p className="text-xs text-muted-foreground">
                  {[
                    fetched.kind === "youtube" ? "YouTube transcript" : "Web page",
                    fetched.author,
                    duration,
                    `${formatNumber(wordCount)} words`,
                    fetched.language,
                  ]
                    .filter(Boolean)
                    .join(" • ")}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="import-title">Title</Label>
                <Input
                  id="import-title"
                  value={title}
                  disabled={saving}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Material title"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="import-content">Content (Markdown)</Label>
                  <div className="flex items-center gap-1">
                    {isEdited && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={saving}
                        onClick={() => setContent(seededContent)}
                      >
                        <Undo2 className="w-3 h-3 mr-1" />
                        Revert
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setShowPreview((previous) => !previous)}
                    >
                      {showPreview ? (
                        <>
                          <PenLine className="w-3 h-3 mr-1" />
                          Edit
                        </>
                      ) : (
                        <>
                          <Eye className="w-3 h-3 mr-1" />
                          Preview
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {showPreview ? (
                  // Rendered with the same component the saved material is
                  // previewed with, so what an instructor approves here is what
                  // they will see afterwards.
                  <div className="h-64 overflow-y-auto rounded-lg border p-3">
                    <MarkdownContent>{content}</MarkdownContent>
                  </div>
                ) : (
                  <Textarea
                    id="import-content"
                    value={content}
                    disabled={saving}
                    spellCheck={false}
                    onChange={(e) => setContent(e.target.value)}
                    className="h-64 font-mono text-xs leading-relaxed"
                  />
                )}

                <p className="text-xs text-muted-foreground">
                  {content.trim().length === 0
                    ? "Add some text before saving."
                    : `${formatNumber(wordCount)} words${isEdited ? " • edited" : ""}`}
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!fetched || busy || trimmedContent.length === 0}>
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {savingStep ?? "Saving…"}
              </>
            ) : (
              "Save as material"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
