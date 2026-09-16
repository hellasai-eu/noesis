import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";

/** The subset of a course material this dialog needs to group chapters under. */
export interface GenerateImageSource {
  id: string;
  title: string | null;
  file_name: string;
}

interface Chapter {
  id: string;
  material_id: string;
  title: string;
  chapter_number: number;
}

/**
 * A generated image together with the inputs that produced it.
 *
 * Kept as one object rather than reading the live form on save: the chapter and
 * the prompt stay editable while the picture is on screen, and a row must
 * describe the image it actually holds, not what the instructor typed after it
 * came back.
 */
interface GeneratedImage {
  imageUrl: string;
  prompt: string;
  chapterId: string;
  chapterTitle: string;
}

interface GenerateImageDialogProps {
  courseId: string;
  courseTitle: string;
  /** Materials whose chapters can frame the image. */
  materials: GenerateImageSource[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const materialLabel = (material: GenerateImageSource) => material.title || material.file_name;

/** A storage-safe stem: ASCII, no separators, never empty. */
const slugify = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60) || "image";

/**
 * `generate-study-image` returns a `data:image/png;base64,…` URI; storage wants
 * bytes. `atob` is the only decoder available in the browser without pulling a
 * dependency in for it.
 */
/**
 * Supabase hands back plain `{ message }` objects, not `Error`s, so an
 * `instanceof` test alone would swallow every storage and Postgrest reason and
 * show the fallback instead.
 */
const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error as { message?: unknown };
    if (typeof message === "string" && message) return message;
  }
  return fallback;
};

const dataUriToBlob = (dataUri: string): Blob => {
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
};

/**
 * Generates a course image with the OpenAI image model and files the result as
 * an "Images" material.
 *
 * The chapter is what makes the picture a *course* picture: its title and the
 * material it belongs to are handed to the model as context, so "the water
 * cycle" comes back drawn for the chapter the students are actually reading.
 * The instructor's own prompt says what to draw; the chapter says what it is
 * for.
 */
export function GenerateImageDialog({
  courseId,
  courseTitle,
  materials,
  open,
  onOpenChange,
  onSuccess,
}: GenerateImageDialogProps) {
  const { user } = useAuth();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [chapterId, setChapterId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GeneratedImage | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * Bumped whenever a generation is superseded — by another generation, or by
   * the dialog closing. The component stays mounted across open/close, so
   * without this a request in flight when the instructor closes the dialog
   * would land its image in the next session.
   */
  const generationRef = useRef(0);

  const materialIds = useMemo(() => materials.map((m) => m.id), [materials]);

  useEffect(() => {
    if (!open) {
      generationRef.current++;
      setChapterId("");
      setPrompt("");
      setTitle("");
      setResult(null);
      setGenerating(false);
      return;
    }

    if (materialIds.length === 0) {
      setChapters([]);
      return;
    }

    let cancelled = false;
    const loadChapters = async () => {
      setLoadingChapters(true);
      try {
        const { data, error } = await supabase
          .from("material_chapters")
          .select("id, material_id, title, chapter_number")
          .in("material_id", materialIds)
          .order("chapter_number", { ascending: true })
          .order("id");

        if (error) throw error;
        if (!cancelled) setChapters(data || []);
      } catch (error: unknown) {
        console.error("Error loading chapters:", error);
        if (!cancelled) toast.error(errorMessage(error, "Failed to load chapters"));
      } finally {
        if (!cancelled) setLoadingChapters(false);
      }
    };

    loadChapters();
    return () => {
      cancelled = true;
    };
  }, [open, materialIds]);

  const selectedChapter = chapters.find((c) => c.id === chapterId) || null;
  /**
   * The form has moved on from the picture on screen. Not an error — the image
   * cost a model call, so it stays until the instructor regenerates — but the
   * mismatch has to be visible, because saving keeps the generated inputs.
   */
  const isStale =
    !!result && (result.chapterId !== chapterId || result.prompt !== prompt.trim());
  const selectedMaterial = selectedChapter
    ? materials.find((m) => m.id === selectedChapter.material_id) || null
    : null;

  const handleGenerate = async () => {
    if (!selectedChapter || !prompt.trim()) return;

    const token = ++generationRef.current;
    const requestedPrompt = prompt.trim();
    const requestedChapter = selectedChapter;

    setGenerating(true);
    setResult(null);

    try {
      // The user's own token, not the publishable key: `generate-study-image`
      // requires a caller that resolves to a user (#1137) and rate-limits per
      // user, and the anon key satisfies neither.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast.error("Your session expired. Sign in again to generate images.");
        return;
      }

      const context = [
        `Course: ${courseTitle}`,
        selectedMaterial ? `Material: ${materialLabel(selectedMaterial)}` : null,
        `Chapter ${requestedChapter.chapter_number}: ${requestedChapter.title}`,
      ]
        .filter(Boolean)
        .join(". ");

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-study-image`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ prompt: requestedPrompt, context }),
        },
      );

      const data = await response.json().catch(() => null);

      // Superseded while the model was drawing — by a Regenerate, or by the
      // instructor closing the dialog. Dropping the image is the point.
      if (generationRef.current !== token) return;

      if (!response.ok || !data?.imageUrl) {
        // The function returns a readable message for the two cases an
        // instructor can act on — an expired session and the hourly ceiling.
        throw new Error(data?.error || "Failed to generate image");
      }

      setResult({
        imageUrl: data.imageUrl,
        prompt: requestedPrompt,
        chapterId: requestedChapter.id,
        chapterTitle: requestedChapter.title,
      });
      setTitle((current) => current || `${requestedChapter.title} — illustration`);
    } catch (error: unknown) {
      if (generationRef.current !== token) return;
      console.error("Image generation error:", error);
      toast.error(errorMessage(error, "Failed to generate image"));
    } finally {
      if (generationRef.current === token) setGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!result || !user) return;

    setSaving(true);
    // Everything but the title comes from the generation, not from the live
    // form: both inputs stay editable while the picture is on screen.
    const { imageUrl, prompt: generatedPrompt, chapterTitle } = result;

    try {
      const blob = dataUriToBlob(imageUrl);
      const stem = slugify(title || chapterTitle);
      const fileName = `${stem}.png`;
      const filePath = `${courseId}/${Date.now()}-${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from("course-materials")
        .upload(filePath, blob, { cacheControl: "3600", contentType: "image/png", upsert: false });

      if (uploadError) throw uploadError;

      // Filed exactly like an uploaded image, `is_moderated: false` included:
      // an AI-drawn picture goes through the same review before students see it.
      const { error: dbError } = await supabase.from("course_materials").insert({
        course_id: courseId,
        file_name: fileName,
        file_url: filePath,
        file_size: blob.size,
        uploaded_by: user.id,
        title: title || chapterTitle,
        description: generatedPrompt || null,
        material_type: "images",
        is_moderated: false,
      });

      if (dbError) {
        // The row is what makes the file a material; without it the PNG is
        // unreachable from the app and every retry uploads another one.
        await supabase.storage
          .from("course-materials")
          .remove([filePath])
          .catch((cleanupError: unknown) => {
            console.error("Failed to remove orphaned image:", cleanupError);
          });
        throw dbError;
      }

      toast.success("Image added to course materials");
      onSuccess();
      onOpenChange(false);
    } catch (error: unknown) {
      console.error("Error saving generated image:", error);
      toast.error(errorMessage(error, "Failed to save image"));
    } finally {
      setSaving(false);
    }
  };

  const materialsWithChapters = materials.filter((m) =>
    chapters.some((c) => c.material_id === m.id),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg w-[95vw] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generate with AI</DialogTitle>
          <DialogDescription>
            Describe the illustration you want. The chapter you pick tells the model what
            the image is for.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="generate-image-chapter">Chapter</Label>
            {loadingChapters ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading chapters...
              </div>
            ) : chapters.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This course has no chapters yet. Split a material into chapters first — the
                chapter is what tells the model which part of the course the image belongs
                to.
              </p>
            ) : (
              <Select value={chapterId} onValueChange={setChapterId}>
                <SelectTrigger id="generate-image-chapter">
                  <SelectValue placeholder="Select a chapter" />
                </SelectTrigger>
                <SelectContent>
                  {materialsWithChapters.map((material) => (
                    <SelectGroup key={material.id}>
                      <SelectLabel>{materialLabel(material)}</SelectLabel>
                      {chapters
                        .filter((c) => c.material_id === material.id)
                        .map((chapter) => (
                          <SelectItem key={chapter.id} value={chapter.id}>
                            {chapter.chapter_number}. {chapter.title}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="generate-image-prompt">What should the image show?</Label>
            <Textarea
              id="generate-image-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. a labelled cross-section of a volcano, showing the magma chamber and the vent"
              rows={4}
            />
          </div>

          {result && (
            <div className="space-y-3">
              <div className="relative aspect-square rounded-lg overflow-hidden bg-secondary">
                <img
                  src={result.imageUrl}
                  alt={title || result.prompt}
                  className="w-full h-full object-contain"
                />
              </div>
              {isStale && (
                <p className="text-xs text-muted-foreground">
                  This image was generated for “{result.chapterTitle}” from the earlier
                  prompt, and will be saved as such. Regenerate to use your changes.
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor="generate-image-title">Title</Label>
                <Input
                  id="generate-image-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Image title"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant={result && !isStale ? "outline" : "default"}
            onClick={handleGenerate}
            disabled={!selectedChapter || !prompt.trim() || generating || saving}
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : result ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                Regenerate
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Generate
              </>
            )}
          </Button>
          {result && (
            <Button onClick={handleSave} disabled={saving || generating}>
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save to materials"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
