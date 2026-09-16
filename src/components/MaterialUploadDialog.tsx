/* eslint-disable react-refresh/only-export-components */
import { useState, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Upload, Loader2 } from "lucide-react";
import { PDFDocument } from "pdf-lib";
import { toast } from "sonner";

export type MaterialType =
  | "textbook"
  | "teacher_companion"
  | "reference_exercises"
  | "images"
  | "other";

export const MATERIAL_TYPE_LABELS: Record<MaterialType, string> = {
  textbook: "Textbook",
  teacher_companion: "Teacher's Companion",
  reference_exercises: "Reference Exercises",
  images: "Images",
  other: "Other",
};

/** Display order for the grouped material list. */
export const MATERIAL_TYPE_ORDER = Object.keys(MATERIAL_TYPE_LABELS) as MaterialType[];

/**
 * "Other" is a whole-document source (#1019): a standalone PDF — a syllabus, a
 * paper, a set of notes — that an instructor wants used without pretending it
 * is a course textbook.
 *
 * It is never split into chapters, so every consumer attaches the WHOLE
 * document via `course_materials.openai_file_id` instead of a chapter file.
 * Study guides were the first; question generation and tutoring sessions take
 * it the same way, as one unit with no chapter to select or link back to.
 *
 * Still excluded from flashcards and cheat sheets, which generate from
 * textbooks only — a stricter rule enforced in their own edge functions.
 */
export const WHOLE_DOCUMENT_MATERIAL_TYPE: MaterialType = "other";

/** Material types a study guide can be built from. */
export const STUDY_GUIDE_MATERIAL_TYPES: MaterialType[] = [
  "textbook",
  WHOLE_DOCUMENT_MATERIAL_TYPE,
];

/** Types that are never split into chapters. */
export const CHAPTERLESS_MATERIAL_TYPES: MaterialType[] = [
  "images",
  WHOLE_DOCUMENT_MATERIAL_TYPE,
];

interface MaterialUploadDialogProps {
  courseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

// Create a preview PDF with only the first N pages
async function createPreviewPdf(
  file: File,
  maxPages: number = 10,
): Promise<{ previewBlob: Blob; totalPages: number } | null> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    const totalPages = pdfDoc.getPageCount();

    // If PDF is already small enough, use it as-is
    if (totalPages <= maxPages) {
      return { previewBlob: file, totalPages };
    }

    // Create a new PDF with only the first N pages
    const previewDoc = await PDFDocument.create();
    const pagesToCopy = Math.min(maxPages, totalPages);
    const copiedPages = await previewDoc.copyPages(
      pdfDoc,
      Array.from({ length: pagesToCopy }, (_, i) => i),
    );

    for (const page of copiedPages) {
      previewDoc.addPage(page);
    }

    const previewBytes = await previewDoc.save();
    // Create ArrayBuffer from Uint8Array for Blob compatibility
    const buffer = new ArrayBuffer(previewBytes.length);
    new Uint8Array(buffer).set(previewBytes);
    const previewBlob = new Blob([buffer], { type: "application/pdf" });

    console.log(
      `[createPreviewPdf] Created preview with ${pagesToCopy} pages (${(previewBlob.size / 1024).toFixed(1)}KB) from original ${totalPages} pages`,
    );

    return { previewBlob, totalPages };
  } catch (error) {
    console.error("Error creating preview PDF:", error);
    return null;
  }
}

export function MaterialUploadDialog({ courseId, open, onOpenChange, onSuccess }: MaterialUploadDialogProps) {
  const { user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [materialType, setMaterialType] = useState<MaterialType>("textbook");
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [tempFilePath, setTempFilePath] = useState<string | null>(null);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isSelectingFileRef = useRef(false);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setFile(null);
      setTitle("");
      setAuthor("");
      setMaterialType("textbook");
      setTotalPages(null);
      setTempFilePath(null);
      setPreviewFilePath(null);
      isSelectingFileRef.current = false;
    }
  }, [open]);

  // Handle dialog close - prevent closing while file picker is open
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && isSelectingFileRef.current) {
      console.log("[MaterialUpload] Preventing close during file selection");
      return; // Don't close while file picker is open
    }
    if (!newOpen) {
      handleClose();
    } else {
      onOpenChange(newOpen);
    }
  };

  const openFilePicker = () => {
    isSelectingFileRef.current = true;
    fileInputRef.current?.click();
    // Reset flag after a delay in case user cancels the file picker
    setTimeout(() => {
      isSelectingFileRef.current = false;
    }, 500);
  };

  const handleFileSelect = async (files: FileList | null) => {
    console.log("[MaterialUpload] handleFileSelect called", { files, user: !!user });
    if (!files || files.length === 0 || !user) {
      console.log("[MaterialUpload] Early return - no files or user");
      return;
    }

    const selectedFile = files[0];
    console.log("[MaterialUpload] File selected:", selectedFile.name, selectedFile.size);

    if (selectedFile.type !== "application/pdf") {
      toast.error("Only PDF files are allowed");
      return;
    }

    if (selectedFile.size > 80 * 1024 * 1024) {
      toast.error("File size must be less than 80MB");
      return;
    }

    // Check page count before proceeding
    setProcessing(true);
    try {
      const arrayBuffer = await selectedFile.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer);
      const pageCount = pdfDoc.getPageCount();
      
      const MAX_PAGES = 3000;
      if (pageCount > MAX_PAGES) {
        toast.error(
          `PDF has ${pageCount} pages, which exceeds the ${MAX_PAGES} page limit. Please split the PDF into smaller parts using a tool like smallpdf.com/split-pdf and upload them separately.`,
          { duration: 8000 }
        );
        setProcessing(false);
        return;
      }

      setFile(selectedFile);
      setTotalPages(pageCount);

      const timestamp = Date.now();
      // Sanitize filename to avoid storage key issues with special characters
      const sanitizedFileName = selectedFile.name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
        .replace(/[^a-zA-Z0-9._-]/g, "_"); // Replace non-ASCII with underscore

      const tempPath = `temp/${courseId}/${timestamp}-${sanitizedFileName}`;
      console.log("[MaterialUpload] Uploading to temp path:", tempPath);

      // Create preview PDF with first 10 pages
      const previewResult = await createPreviewPdf(selectedFile, 10);
      if (previewResult) {
        console.log("[MaterialUpload] Preview created, pages:", previewResult.totalPages);

        // Upload preview PDF
        const previewPath = `temp/${courseId}/${timestamp}-preview-${sanitizedFileName}`;
        const { error: previewUploadError } = await supabase.storage
          .from("course-materials")
          .upload(previewPath, previewResult.previewBlob, {
            cacheControl: "3600",
            upsert: false,
          });

        if (!previewUploadError) {
          setPreviewFilePath(previewPath);
          console.log(`[MaterialUpload] Preview PDF uploaded: ${previewPath}`);
        } else {
          console.error("[MaterialUpload] Preview upload error:", previewUploadError);
        }
      }

      // Upload full PDF
      console.log("[MaterialUpload] Uploading full PDF...");
      const { error: uploadError } = await supabase.storage.from("course-materials").upload(tempPath, selectedFile, {
        cacheControl: "3600",
        upsert: false,
      });

      if (uploadError) throw uploadError;

      setTempFilePath(tempPath);
      console.log("[MaterialUpload] Temp file uploaded successfully");
    } catch (error: any) {
      console.error("[MaterialUpload] Error preparing file:", error);
      toast.error("Failed to prepare file");
    } finally {
      setProcessing(false);
      console.log("[MaterialUpload] Processing complete");
    }
  };

  const handleUpload = async () => {
    if (!file || !user || !tempFilePath) return;

    setUploading(true);

    try {
      const timestamp = Date.now();
      // Sanitize filename to avoid storage key issues with special characters
      const sanitizedFileName = file.name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
        .replace(/[^a-zA-Z0-9._-]/g, "_"); // Replace non-ASCII with underscore

      // Move from temp to final location
      const finalPath = `${courseId}/${timestamp}-${sanitizedFileName}`;
      const finalPreviewPath = previewFilePath ? `${courseId}/${timestamp}-preview-${sanitizedFileName}` : null;

      // Download from temp
      const { data: downloadData, error: downloadError } = await supabase.storage
        .from("course-materials")
        .download(tempFilePath);

      if (downloadError) throw downloadError;

      // Upload to final location
      const { error: uploadError } = await supabase.storage.from("course-materials").upload(finalPath, downloadData, {
        cacheControl: "3600",
        upsert: false,
      });

      if (uploadError) throw uploadError;

      // Move preview file if exists
      if (previewFilePath && finalPreviewPath) {
        const { data: previewData, error: previewDownloadError } = await supabase.storage
          .from("course-materials")
          .download(previewFilePath);

        if (!previewDownloadError && previewData) {
          await supabase.storage.from("course-materials").upload(finalPreviewPath, previewData, {
            cacheControl: "3600",
            upsert: false,
          });
          console.log(`[MaterialUpload] Preview file moved to: ${finalPreviewPath}`);
        }
      }

      // Delete temp files
      const filesToRemove = [tempFilePath];
      if (previewFilePath) filesToRemove.push(previewFilePath);
      await supabase.storage.from("course-materials").remove(filesToRemove);

      // Upload to OpenAI Files API FIRST (before database insert) - REQUIRED
      console.log("[MaterialUpload] Starting OpenAI sync...");
      let openaiFileId: string | null = null;

      try {
        console.log("[MaterialUpload] Calling upload-to-openai with:", {
          filePath: finalPath,
          fileName: file.name,
          courseId,
        });

        /**
         * `courseId` is what gets the file INDEXED, not merely uploaded (#1108).
         *
         * `upload-to-openai` adds a file to the institution's vector store only
         * if it can resolve a course from the request — courseId, or a
         * materialId it can read `course_id` off — and from that course an
         * institution with a `vector_store_id`. This call had neither, so the
         * lookup never ran and every material uploaded through this dialog was
         * left out of the store, while the same material synced from the
         * course-materials row button (which passes materialId) went in. The
         * function reports the miss as `addedToVectorStore: false` alongside
         * `success: true`, so nothing surfaced.
         *
         * There is no materialId to pass: this runs BEFORE the insert below, by
         * design — a material that failed to reach OpenAI must not be created
         * at all. courseId is in scope as a prop and resolves the same chain.
         *
         * Consequence worth knowing: the file-level attributes are stamped from
         * what the request can resolve, so a dialog upload carries course_id and
         * course_name but not material_id / material_title. Nothing consumes
         * those attributes yet (no function issues a file_search), and the
         * super-admin Vector Store page's per-material Sync passes materialId
         * when they are needed. Indexed with partial attributes beats absent.
         */
        const { data, error } = await supabase.functions.invoke("upload-to-openai", {
          body: {
            filePath: finalPath,
            fileName: file.name,
            courseId,
          },
        });

        console.log("[MaterialUpload] OpenAI response:", { data, error });

        // Check for invoke-level errors
        if (error) {
          console.error("OpenAI function invoke error:", error);
          throw new Error(error.message || "Failed to call OpenAI sync function");
        }

        // Check for errors in the response data
        if (data?.error) {
          console.error("OpenAI function returned error:", data.error);
          throw new Error(data.error);
        }

        if (!data?.openaiFileId) {
          console.error("No openaiFileId in response:", data);
          throw new Error("OpenAI did not return a file ID");
        }

        openaiFileId = data.openaiFileId;
        console.log("[MaterialUpload] OpenAI upload successful:", openaiFileId);
      } catch (openaiErr: any) {
        console.error("OpenAI sync failed:", openaiErr);
        // Clean up the uploaded file since we can't proceed without OpenAI sync
        await supabase.storage.from("course-materials").remove([finalPath]);
        if (finalPreviewPath) {
          await supabase.storage.from("course-materials").remove([finalPreviewPath]);
        }
        throw new Error(openaiErr.message || "Failed to sync file to OpenAI. Please try again.");
      }

      // Ensure we have the OpenAI file ID before proceeding
      if (!openaiFileId) {
        throw new Error("OpenAI file ID is missing. Cannot save material.");
      }

      // Save metadata to database with OpenAI file ID and page count
      const { error: dbError } = await supabase.from("course_materials").insert({
        course_id: courseId,
        file_name: file.name,
        file_url: finalPath,
        file_size: file.size,
        uploaded_by: user.id,
        title: title || null,
        author: author || null,
        material_type: materialType,
        openai_file_id: openaiFileId,
        page_count: totalPages,
      });

      if (dbError) throw dbError;

      toast.success("Material uploaded successfully");
      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Upload error:", error);
      toast.error(error.message || "Failed to upload file");
    } finally {
      setUploading(false);
    }
  };

  const handleClose = async () => {
    console.log("[MaterialUpload] handleClose called - cleaning up temp files");
    // Clean up temp files if exist
    const filesToRemove: string[] = [];
    if (tempFilePath) filesToRemove.push(tempFilePath);
    if (previewFilePath) filesToRemove.push(previewFilePath);

    if (filesToRemove.length > 0) {
      try {
        await supabase.storage.from("course-materials").remove(filesToRemove);
      } catch (e) {
        console.error("Failed to clean up temp files:", e);
      }
    }
    onOpenChange(false);
  };

  // Log when open state changes
  useEffect(() => {
    console.log("[MaterialUpload] Dialog open state changed:", open);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* `overflow-y-auto`, not `overflow-hidden`: this form grows once a file is
          picked (metadata fields appear), and `overflow-hidden` would override the
          base scroll and clip the tail off on a short viewport. Width is already
          held by `w-[95vw]` plus `break-words` on the long-filename description. */}
      <DialogContent className="max-w-lg w-[95vw] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload Material</DialogTitle>
          <DialogDescription className="break-words">
            Upload a PDF and add metadata. You can then create chapters from page ranges.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* File Selection */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={(e) => {
                isSelectingFileRef.current = false;
                handleFileSelect(e.target.files);
              }}
            />
            {!file ? (
              <div
                onClick={openFilePicker}
                className="border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all hover:border-primary/50 hover:bg-secondary/50"
              >
                <div className="flex flex-col items-center gap-3">
                  <div className="w-14 h-14 rounded-xl bg-secondary flex items-center justify-center">
                    <Upload className="w-7 h-7 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Click to select PDF</p>
                    <p className="text-xs text-muted-foreground mt-1">Max 80MB</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 p-3 bg-secondary/50 rounded-lg">
                <div className="w-10 h-10 rounded-lg bg-destructive/10 flex items-center justify-center flex-shrink-0">
                  <FileText className="w-5 h-5 text-destructive" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" title={file.name}>
                    {file.name.length > 35 
                      ? `${file.name.slice(0, 20)}...${file.name.slice(-12)}` 
                      : file.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {(file.size / (1024 * 1024)).toFixed(2)} MB
                    {totalPages && ` • ${totalPages} pages`}
                  </p>
                </div>
                {processing && <Loader2 className="w-4 h-4 animate-spin text-primary flex-shrink-0" />}
              </div>
            )}
          </div>

          {/* Title */}
          {file && (
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Document title" />
            </div>
          )}

          {/* Author */}
          {file && (
            <div className="space-y-2">
              <Label htmlFor="author">Author(s)</Label>
              <Input
                id="author"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="Author name(s)"
              />
            </div>
          )}

          {/* Material Type */}
          {file && (
            <div className="space-y-2">
              <Label htmlFor="materialType">Material Type</Label>
              <Select value={materialType} onValueChange={(v) => setMaterialType(v as MaterialType)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(MATERIAL_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {materialType === WHOLE_DOCUMENT_MATERIAL_TYPE
                  ? "Not split into chapters — study guides, question generation and tutoring sessions all read the whole document. Flashcards and cheat sheets are generated from textbooks only."
                  : "This affects how AI generates questions from this material"}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={!file || uploading || processing}>
            {uploading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Uploading...
              </>
            ) : (
              "Upload"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
