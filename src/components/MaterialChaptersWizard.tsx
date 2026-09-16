import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  FileText,
  Plus,
  Trash2,
  Loader2,
  ChevronUp,
  ChevronDown,
  BookOpen,
  AlertCircle,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { EditableChapterTitle } from "@/components/EditableChapterTitle";
import { useFormatters } from "@/i18n/formatters";


interface Chapter {
  id?: string;
  chapter_number: number;
  title: string;
  pageStart: number;
  pageEnd: number;
  originalPageStart?: number;
  originalPageEnd?: number;
  isNew?: boolean;
  isModified?: boolean;
  isSaving?: boolean;
  content?: string;
  instructions?: string;
  hasCheatSheet?: boolean;
}


interface MaterialChaptersWizardProps {
  materialId: string;
  materialTitle: string;
  materialFileUrl: string;
  materialType: string;
  openaiFileId?: string | null;
  courseId?: string;
  vectorStoreId?: string | null;
  pageCount?: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChaptersUpdated?: () => void;
  canEdit?: boolean;
}

export default function MaterialChaptersWizard({
  materialId,
  materialTitle,
  materialFileUrl,
  materialType,
  openaiFileId,
  courseId,
  vectorStoreId,
  pageCount,
  open,
  onOpenChange,
  onChaptersUpdated,
  canEdit = true,
}: MaterialChaptersWizardProps) {
  const { formatNumber } = useFormatters();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(pageCount || null);
  const [chapterToDelete, setChapterToDelete] = useState<{ index: number; chapter: Chapter } | null>(null);
  const [deleting, setDeleting] = useState(false);
  
  // AI detection state
  const [detectingChapters, setDetectingChapters] = useState(false);
  const [detectionStep, setDetectionStep] = useState<number>(0);
  const [extractionInstructions, setExtractionInstructions] = useState("");

  // Detection step labels (5 steps now)
  const detectionSteps = [
    "Generating signed URL...",
    "Splitting PDF...",
    "Downloading split PDF...",
    "Uploading to AI...",
    "Detecting chapters..."
  ];

  // Sync pageCount prop to state
  useEffect(() => {
    setPdfPageCount(pageCount || null);
  }, [pageCount]);

  const loadChapters = async (forceReload = false) => {
    if (hasLoaded && !forceReload) return;
    setLoading(true);
    console.log("[MaterialChaptersWizard] Loading chapters for materialId:", materialId);
    try {
      const { data, error } = await supabase
        .from("material_chapters")
        .select("*")
        .eq("material_id", materialId)
        .order("chapter_number", { ascending: true }).order("id");

      console.log("[MaterialChaptersWizard] Chapters query result:", { data, error });

      if (error) throw error;

      if (data && data.length > 0) {
        const mappedChapters = data.map((ch: any) => {
          // Parse page range from file_name (e.g., "Pages 1-10")
          let pageStart = 1;
          let pageEnd = 1;
          if (ch.file_name) {
            const match = ch.file_name.match(/Pages\s+(\d+)-(\d+)/i);
            if (match) {
              pageStart = parseInt(match[1], 10);
              pageEnd = parseInt(match[2], 10);
            }
          }
          return {
            id: ch.id,
            chapter_number: ch.chapter_number,
            title: ch.title,
            pageStart,
            pageEnd,
            originalPageStart: pageStart,
            originalPageEnd: pageEnd,
            content: ch.content || undefined,
            instructions: ch.instructions || undefined,
            hasCheatSheet: !!ch.cheat_sheet,
          };
        });
        console.log("[MaterialChaptersWizard] Mapped chapters:", mappedChapters);
        setChapters(mappedChapters);
      } else {
        console.log("[MaterialChaptersWizard] No chapters found for this material");
        setChapters([]);
      }
      setHasLoaded(true);
    } catch (error: any) {
      console.error("[MaterialChaptersWizard] Error loading chapters:", error);
      toast.error("Failed to load chapters");
    } finally {
      setLoading(false);
    }
  };


  // Load chapters when dialog opens
  useEffect(() => {
    if (open && materialId) {
      setHasLoaded(false);
      setChapters([]);
      loadChapters(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load when dialog opens
  }, [open, materialId]);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setHasLoaded(false);
      setChapters([]);
    }
    onOpenChange(newOpen);
  };

  const addChapter = () => {
    // Calculate suggested page start based on previous chapter's end
    const lastChapter = chapters.length > 0 ? chapters[chapters.length - 1] : null;
    const suggestedStart = lastChapter ? lastChapter.pageEnd + 1 : 1;
    
    setChapters([
      ...chapters,
      {
        chapter_number: chapters.length + 1, // Will be reassigned based on position when saving
        title: "",
        pageStart: suggestedStart,
        pageEnd: suggestedStart,
        isNew: true,
      },
    ]);
  };

  const detectChaptersWithAI = async () => {
    if (!pdfPageCount) {
      toast.error("PDF page count not loaded yet");
      return;
    }

    setDetectingChapters(true);
    setDetectionStep(0);
    
    try {
      const requestBody = {
        totalPages: pdfPageCount,
        courseId,
        filePath: materialFileUrl,
        bucketName: "course-materials",
        specialExtractionInstructions: extractionInstructions.trim() || "",
      };

      console.log("[MaterialChaptersWizard] Using ConvertAPI split approach for chapter detection");
      
      // Simulate step progression (5 steps now)
      // Steps: 0=URL, 1=Split, 2=Download, 3=Upload, 4=Detect
      const stepInterval = setInterval(() => {
        setDetectionStep(prev => {
          if (prev < 4) return prev + 1;
          clearInterval(stepInterval);
          return prev;
        });
      }, 3000); // Advance step every 3 seconds

      // Store interval ID to clear on completion
      (window as any).__detectionInterval = stepInterval;

      const { data, error } = await supabase.functions.invoke("detect-chapters", {
        body: requestBody,
      });

      // Clear interval if set
      if ((window as any).__detectionInterval) {
        clearInterval((window as any).__detectionInterval);
        delete (window as any).__detectionInterval;
      }

      if (error) throw error;

      if (data?.error) {
        toast.error(data.error);
        return;
      }

      if (!data?.chapters || data.chapters.length === 0) {
        toast.warning("No chapters detected in the Table of Contents. Try adding chapters manually.");
        return;
      }

      const detectedChapters: Chapter[] = data.chapters.map((ch: any, index: number) => ({
        chapter_number: ch.chapter_number || index + 1,
        title: ch.title,
        pageStart: ch.pageStart,
        pageEnd: ch.pageEnd,
        isNew: true,
      }));

      setChapters(detectedChapters);
      toast.success(`Found ${detectedChapters.length} chapters. Review and edit as needed.`);
    } catch (error: any) {
      console.error("Chapter detection error:", error);
      toast.error(error.message || "Failed to detect chapters");
      // Clear interval on error
      if ((window as any).__detectionInterval) {
        clearInterval((window as any).__detectionInterval);
        delete (window as any).__detectionInterval;
      }
    } finally {
      setDetectingChapters(false);
      setDetectionStep(0);
    }
  };

  const updateChapterNumber = (index: number, newNumber: number) => {
    if (newNumber < 1) return;
    const newChapters = [...chapters];
    newChapters[index] = { ...newChapters[index], chapter_number: newNumber };
    setChapters(newChapters);
  };

  const confirmDeleteChapter = (index: number) => {
    const chapter = chapters[index];
    if (chapter.id) {
      // Saved chapter - show confirmation
      setChapterToDelete({ index, chapter });
    } else {
      // New unsaved chapter - remove immediately
      const newChapters = chapters.filter((_, i) => i !== index);
      setChapters(newChapters);
      toast.success("Chapter removed");
    }
  };

  const removeChapter = async () => {
    if (!chapterToDelete) return;
    
    const { index, chapter } = chapterToDelete;
    setDeleting(true);
    
    try {
      const { error } = await supabase
        .from("material_chapters")
        .delete()
        .eq("id", chapter.id);

      if (error) throw error;
      
      const newChapters = chapters.filter((_, i) => i !== index);
      setChapters(newChapters);
      toast.success("Chapter deleted");
    } catch (error: any) {
      toast.error("Failed to delete chapter");
    } finally {
      setDeleting(false);
      setChapterToDelete(null);
    }
  };

  const updateChapter = (index: number, updates: Partial<Chapter>) => {
    const newChapters = [...chapters];
    const chapter = newChapters[index];
    const updatedChapter = { ...chapter, ...updates };
    
    // Mark as modified if page range changed on a saved chapter
    if (chapter.id && (
      (updates.pageStart !== undefined && updates.pageStart !== chapter.originalPageStart) ||
      (updates.pageEnd !== undefined && updates.pageEnd !== chapter.originalPageEnd)
    )) {
      updatedChapter.isModified = true;
    }
    
    newChapters[index] = updatedChapter;
    setChapters(newChapters);
  };

  const moveChapter = (index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= chapters.length) return;

    const newChapters = [...chapters];
    // Simply swap positions in array - chapter_number will be assigned based on position when saving
    [newChapters[index], newChapters[newIndex]] = [newChapters[newIndex], newChapters[index]];
    setChapters(newChapters);
  };

  const saveChapters = async () => {
    // Validate
    for (const chapter of chapters) {
      if (!chapter.title.trim()) {
        toast.error("All chapters must have a title");
        return;
      }
      if (chapter.pageStart < 1 || chapter.pageEnd < 1) {
        toast.error(`Chapter "${chapter.title}" needs valid page numbers`);
        return;
      }
      if (chapter.pageEnd < chapter.pageStart) {
        toast.error(`Chapter "${chapter.title}": end page must be >= start page`);
        return;
      }
    }

    setSaving(true);
    try {
      // Separate chapters into new/modified vs unchanged
      const chaptersToSplit = chapters.filter((ch, i) => {
        const pageRangeChanged = ch.isModified || 
          (ch.id && (ch.pageStart !== ch.originalPageStart || ch.pageEnd !== ch.originalPageEnd));
        return ch.isNew || !ch.id || pageRangeChanged;
      });

      const openaiFileIds: Record<number, string> = {};

      // If there are chapters that need splitting, call the split-chapters function
      if (chaptersToSplit.length > 0) {
        toast.info(`Splitting ${chaptersToSplit.length} chapter(s) and uploading to AI...`);
        
        const chapterInputs = chaptersToSplit.map((ch, i) => ({
          chapterIndex: chapters.indexOf(ch),
          pageStart: ch.pageStart,
          pageEnd: ch.pageEnd,
          title: ch.title,
        }));

        const { data: splitData, error: splitError } = await supabase.functions.invoke("split-chapters", {
          body: {
            filePath: materialFileUrl,
            bucketName: "course-materials",
            chapters: chapterInputs,
          },
        });

        if (splitError) {
          console.error("Split chapters error:", splitError);
          throw new Error(splitError.message || "Failed to split chapters");
        }

        if (splitData?.error) {
          throw new Error(splitData.error);
        }

        // Map results to chapter indices
        if (splitData?.results) {
          for (const result of splitData.results) {
            openaiFileIds[result.chapterIndex] = result.openai_file_id;
          }
        }
      }

      // Now save each chapter to the database
      for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        // Assign chapter_number based on position (1-indexed)
        const chapterNumber = i + 1;
        
        // Update UI to show this chapter is being processed
        setChapters(prev => prev.map((ch, idx) => 
          idx === i ? { ...ch, isSaving: true, chapter_number: chapterNumber } : ch
        ));

        const chapterData: any = {
          chapter_number: chapterNumber,
          title: chapter.title,
          content_type: "pdf",
          content: null, // No text extraction - we use OpenAI file IDs now
          file_url: materialFileUrl,
          file_name: `Pages ${chapter.pageStart}-${chapter.pageEnd}`,
          instructions: chapter.instructions || null,
        };

        // Add openai_file_id if we have one for this chapter
        if (openaiFileIds[i]) {
          chapterData.openai_file_id = openaiFileIds[i];
        }

        if (chapter.id) {
          const { error } = await supabase
            .from("material_chapters")
            .update(chapterData)
            .eq("id", chapter.id);

          if (error) throw error;
        } else {
          // Delete any existing chapter with same material_id and chapter_number first
          await supabase
            .from("material_chapters")
            .delete()
            .eq("material_id", materialId)
            .eq("chapter_number", chapterNumber);

          const { data: inserted, error } = await supabase
            .from("material_chapters")
            .insert({
              material_id: materialId,
              ...chapterData,
            })
            .select()
            .single();

          if (error) throw error;
          
          chapter.id = inserted.id;
        }

        // Update UI to show this chapter is done
        setChapters(prev => prev.map((ch, idx) => 
          idx === i ? { ...ch, isSaving: false, isNew: false } : ch
        ));
      }

      toast.success("Chapters saved successfully. You can now generate study materials for each chapter.");
      onChaptersUpdated?.();
      handleOpenChange(false);
    } catch (error: any) {
      console.error("Error saving chapters:", error);
      toast.error(error.message || "Failed to save chapters");
    } finally {
      setSaving(false);
    }
  };

  const hasPdf = !!materialFileUrl;

  const hasExistingChapters = chapters.some(ch => ch.id);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl w-[95vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="w-5 h-5" />
            {hasExistingChapters ? "View Chapters" : "Create Chapters"}: {materialTitle}
          </DialogTitle>
          <DialogDescription>
            {hasExistingChapters 
              ? "Chapters have been defined for this material. To modify chapters, delete the material and re-upload it."
              : "Define chapters by specifying page ranges from the uploaded PDF. Text will be automatically extracted from each page range."
            }
          </DialogDescription>
        </DialogHeader>

        {!hasPdf ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <AlertCircle className="w-12 h-12 text-amber-500 mb-4" />
            <h3 className="text-lg font-semibold mb-2">PDF Required</h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              Please upload a PDF to this material first before creating chapters.
            </p>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : hasExistingChapters ? (
          /* READ-ONLY VIEW for existing chapters */
          <div className="space-y-4">
            {/* Info banner */}
            <div className="p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    Chapter titles can be edited, but structure is locked
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                    You can rename chapters by clicking the edit icon. Page ranges and content cannot be changed after creation.
                  </p>
                </div>
              </div>
            </div>

            {/* PDF info */}
            <div className="flex items-center gap-2 p-3 bg-secondary/50 rounded-lg">
              <FileText className="w-5 h-5 text-primary" />
              <span className="text-sm font-medium">Source PDF:</span>
              <span className="text-sm text-muted-foreground truncate flex-1">
                {(() => {
                  const fileName = materialFileUrl.split('/').pop() || '';
                  return fileName.length > 25 ? fileName.slice(0, 25) + '...' : fileName;
                })()}
              </span>
              <Badge variant="outline" className="ml-auto shrink-0">
                {pdfPageCount ? `${pdfPageCount} pages` : "..."}
              </Badge>
            </div>

            {/* Existing chapters list (read-only) */}
            <div className="space-y-3">
              {chapters.map((chapter, index) => (
                <Card key={chapter.id || index} className="border-border">
                  <CardContent className="py-4">
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <span className="text-sm font-semibold text-primary">{index + 1}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        {chapter.id ? (
                          <EditableChapterTitle
                            chapterId={chapter.id}
                            title={chapter.title}
                            canEdit={canEdit}
                            onSaved={(newTitle) => {
                              setChapters(prev => prev.map(ch =>
                                ch.id === chapter.id ? { ...ch, title: newTitle } : ch
                              ));
                              onChaptersUpdated?.();
                            }}
                            className="font-medium text-sm"
                          />
                        ) : (
                          <h4 className="font-medium text-sm">{chapter.title}</h4>
                        )}
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="outline" className="text-xs">
                            Pages {chapter.pageStart}-{chapter.pageEnd}
                          </Badge>
                          {chapter.content && (
                            <span className="text-xs text-muted-foreground">
                              ({formatNumber(chapter.content.length)} chars extracted)
                            </span>
                          )}
                          {chapter.hasCheatSheet && (
                            <Badge variant="secondary" className="text-xs">Cheat Sheet</Badge>
                          )}
                        </div>
                        {chapter.instructions && (
                          <p className="text-xs text-muted-foreground mt-2 italic">
                            Instructions: {chapter.instructions}
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="flex justify-end pt-4 border-t">
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          /* EDITABLE VIEW for creating new chapters */
          <div className="space-y-4">
            {/* PDF info */}
            <div className="flex items-center gap-2 p-3 bg-secondary/50 rounded-lg">
              <FileText className="w-5 h-5 text-primary" />
              <span className="text-sm font-medium">Source PDF:</span>
              <span className="text-sm text-muted-foreground truncate flex-1" title={materialFileUrl.split('/').pop()}>
                {(() => {
                  const fileName = materialFileUrl.split('/').pop() || '';
                  return fileName.length > 25 ? fileName.slice(0, 25) + '...' : fileName;
                })()}
              </span>
              <Badge variant="outline" className="ml-auto shrink-0">
                {pdfPageCount ? `${pdfPageCount} pages` : "..."}
              </Badge>
            </div>

            {/* AI Chapter Detection - Text Based */}
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="pt-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <Sparkles className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 space-y-3">
                    <div>
                      <h4 className="font-medium text-sm">Auto-detect from PDF</h4>
                      <p className="text-xs text-muted-foreground mt-1">
                        Analyzes pages to detect chapter structure
                      </p>
                    </div>
                    <Textarea
                      placeholder="Optional: Add specific instructions for chapter detection (e.g., 'Ignore appendices', 'Focus on main chapters only', 'The TOC is on page 3')"
                      value={extractionInstructions}
                      onChange={(e) => setExtractionInstructions(e.target.value)}
                      className="text-sm min-h-[60px] resize-none bg-background"
                      disabled={detectingChapters}
                    />
                    {/* Progress indicator during detection */}
                    {detectingChapters ? (
                      <div className="space-y-3 w-full">
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin text-primary" />
                          <span className="text-sm font-medium">{detectionSteps[detectionStep]}</span>
                        </div>
                        <div className="flex gap-1">
                          {detectionSteps.map((_, idx) => (
                            <div
                              key={idx}
                              className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                                idx <= detectionStep 
                                  ? 'bg-primary' 
                                  : 'bg-muted'
                              }`}
                            />
                          ))}
                        </div>
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>Step {detectionStep + 1} of {detectionSteps.length}</span>
                          <span className="text-primary">Processing...</span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 flex-wrap">
                        <Button
                          size="sm"
                          onClick={() => detectChaptersWithAI()}
                          disabled={detectingChapters || saving || !pdfPageCount}
                          className="gap-2"
                        >
                          <Sparkles className="w-4 h-4" />
                          Detect Chapters
                        </Button>
                        {chapters.length > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setChapters([]);
                              toast.success("All chapters cleared");
                            }}
                            disabled={saving}
                            className="gap-2 text-destructive hover:text-destructive"
                          >
                            <Trash2 className="w-4 h-4" />
                            Clear All
                          </Button>
                        )}
                      </div>
                    )}
                    {chapters.length > 0 && (
                      <p className="text-xs text-amber-600">
                        Note: Detection will replace existing chapters
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {chapters.length === 0 && (
              <div className="text-center py-6 text-muted-foreground">
                <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm">No chapters yet. Use AI detection or add chapters manually.</p>
              </div>
            )}

            {chapters.map((chapter, index) => (
              <Card key={index} className="border-dashed border-primary/30">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <div className="flex flex-col gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={index === 0 || saving}
                        onClick={() => moveChapter(index, "up")}
                      >
                        <ChevronUp className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={index === chapters.length - 1 || saving}
                        onClick={() => moveChapter(index, "down")}
                      >
                        <ChevronDown className="w-4 h-4" />
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-muted-foreground">#{index + 1}</span>
                    </div>
                    {chapter.isSaving ? (
                      <Badge variant="outline" className="text-xs">
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                        Extracting...
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">New</Badge>
                    )}
                    <div className="flex-1" />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => confirmDeleteChapter(index)}
                      disabled={saving}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Chapter Title</Label>
                    <Input
                      placeholder="e.g., Introduction to Greek History"
                      value={chapter.title}
                      onChange={(e) => updateChapter(index, { title: e.target.value })}
                      disabled={saving}
                    />
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Start Page</Label>
                      <Input
                        type="number"
                        min={1}
                        placeholder="1"
                        value={chapter.pageStart}
                        onChange={(e) => updateChapter(index, {
                          pageStart: parseInt(e.target.value) || 1,
                        })}
                        disabled={saving}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>End Page</Label>
                      <Input
                        type="number"
                        min={1}
                        placeholder="10"
                        value={chapter.pageEnd}
                        onChange={(e) => updateChapter(index, {
                          pageEnd: parseInt(e.target.value) || 1,
                        })}
                        disabled={saving}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Use the PDF page numbers (as shown in your PDF reader), not the printed page numbers in the book.
                  </p>
                  
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">
                      AI Instructions <span className="text-xs">(optional)</span>
                    </Label>
                    <Textarea
                      placeholder="e.g., Pages 12 and 23 contain example questions that can be used or modified. Focus on the theorems in this chapter."
                      value={chapter.instructions || ""}
                      onChange={(e) => updateChapter(index, { instructions: e.target.value })}
                      disabled={saving}
                      className="text-sm min-h-[60px]"
                    />
                  </div>
                  
                </CardContent>
              </Card>
            ))}

            <Button variant="outline" className="w-full" onClick={addChapter} disabled={saving}>
              <Plus className="w-4 h-4 mr-2" />
              Add Chapter
            </Button>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={saveChapters} disabled={saving || chapters.length === 0}>
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Extracting & Saving...
                  </>
                ) : (
                  "Save Chapters"
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>

      <AlertDialog open={!!chapterToDelete} onOpenChange={(open) => !open && setChapterToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Chapter?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{chapterToDelete?.chapter.title || 'this chapter'}"? 
              This will permanently remove the chapter and its extracted content.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={removeChapter} 
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
