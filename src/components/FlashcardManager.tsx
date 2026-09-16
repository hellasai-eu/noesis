import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Trash2, Loader2, Sparkles, Layers, Check, Eye, EyeOff, RefreshCw, MoreHorizontal, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useContentAssignments } from "@/hooks/useContentAssignments";
import { ContentAssignDialog } from "./ContentAssignDialog";
import { AssignedClassesBadges } from "./AssignedClassesBadges";
import type { CourseClass } from "@/types/content-assignments";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import FlashcardViewer from "@/components/FlashcardViewer";

interface ChapterWithFlashcards {
  id: string;
  title: string;
  chapter_number: number;
  flashcards: any[] | null;
  flashcards_visible: boolean;
  material_title: string | null;
  material_file_name: string;
}

interface FlashcardManagerProps {
  courseId: string;
  classes?: CourseClass[];
}

export function FlashcardManager({ courseId, classes = [] }: FlashcardManagerProps) {
  const [allChapters, setAllChapters] = useState<ChapterWithFlashcards[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [generatingFlashcards, setGeneratingFlashcards] = useState<string | null>(null);
  const [deletingFlashcards, setDeletingFlashcards] = useState<string | null>(null);
  const [confirmDeleteFlashcards, setConfirmDeleteFlashcards] = useState<ChapterWithFlashcards | null>(null);
  const [previewChapter, setPreviewChapter] = useState<ChapterWithFlashcards | null>(null);

  // Content assignment
  const chapterIds = useMemo(() => allChapters.filter(ch => ch.flashcards && ch.flashcards.length > 0).map(ch => ch.id), [allChapters]);
  const contentAssignments = useContentAssignments('chapter_flashcard', chapterIds, classes);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignTargetId, setAssignTargetId] = useState<string | null>(null);

  const handleOpenAssignDialog = useCallback((chapterId: string) => {
    setAssignTargetId(chapterId);
    setAssignDialogOpen(true);
  }, []);

  const handleSaveAssign = useCallback(async (selection: Set<string> | import("@/types/content-assignments").AssignSelection) => {
    if (assignTargetId) {
      await contentAssignments.saveAssignments([assignTargetId], selection, false);
    }
    setAssignDialogOpen(false);
  }, [contentAssignments, assignTargetId]);

  useEffect(() => {
    fetchAllChaptersWithFlashcards();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId change
  }, [courseId]);

  const fetchAllChaptersWithFlashcards = async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const { data, error } = await supabase
        .from("material_chapters")
        .select(`
          id, title, chapter_number, flashcards, flashcards_visible,
          course_materials!inner(id, title, file_name, course_id)
        `)
        .eq("course_materials.course_id", courseId)
        .eq("course_materials.material_type", "textbook")
        // A course can hold several textbooks, and `chapter_number` repeats
        // across them — two books both have a "Ch. 1". Ordering on it alone
        // leaves ties undefined, so the same rows came back in a different
        // order after this query re-ran post-generation and the table visibly
        // reshuffled under the user. `id` is the tiebreak that makes the sort
        // total. See #1065.
        .order("chapter_number").order("id");

      if (error) throw error;

      const chaptersWithMaterial: ChapterWithFlashcards[] = (data || []).map((c: any) => ({
        id: c.id,
        title: c.title,
        chapter_number: c.chapter_number,
        flashcards: c.flashcards,
        flashcards_visible: c.flashcards_visible ?? false,
        material_title: c.course_materials?.title,
        material_file_name: c.course_materials?.file_name,
      }));

      setAllChapters(chaptersWithMaterial);
    } catch (error: any) {
      console.error("Failed to load chapters for flashcards:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleGenerateFlashcards = async (chapter: ChapterWithFlashcards) => {
    setGeneratingFlashcards(chapter.id);
    try {
      const { data, error } = await supabase.functions.invoke("generate-flashcards", {
        body: { chapterId: chapter.id },
      });

      if (error) throw error;

      if (data?.success) {
        const count = data.count || 0;
        toast.success(`${count} flashcards generated for "${chapter.title}"`);
        fetchAllChaptersWithFlashcards();
      } else if (data?.error) {
        toast.error(data.error);
      } else if (data?.skipped) {
        toast.info(data.reason || "Flashcard generation skipped");
      }
    } catch (err: any) {
      console.error("Flashcard generation error:", err);
      toast.error(err.message || "Failed to generate flashcards");
    } finally {
      setGeneratingFlashcards(null);
    }
  };

  const handleDeleteFlashcards = async (chapter: ChapterWithFlashcards) => {
    setDeletingFlashcards(chapter.id);
    try {
      const { error } = await supabase
        .from("material_chapters")
        .update({ flashcards: null, flashcards_visible: false })
        .eq("id", chapter.id);

      if (error) throw error;

      toast.success("Flashcards deleted");
      fetchAllChaptersWithFlashcards();
    } catch (err: any) {
      console.error("Delete flashcards error:", err);
      toast.error("Failed to delete flashcards");
    } finally {
      setDeletingFlashcards(null);
      setConfirmDeleteFlashcards(null);
    }
  };

  const handleToggleVisibility = async (chapter: ChapterWithFlashcards) => {
    const newVisibility = !chapter.flashcards_visible;
    // Optimistic update
    setAllChapters(prev => prev.map(c => 
      c.id === chapter.id ? { ...c, flashcards_visible: newVisibility } : c
    ));
    
    try {
      const { error } = await supabase
        .from("material_chapters")
        .update({ flashcards_visible: newVisibility })
        .eq("id", chapter.id);

      if (error) throw error;

      toast.success(newVisibility ? "Flashcards visible to students" : "Flashcards hidden from students");
    } catch (err: any) {
      console.error("Toggle visibility error:", err);
      toast.error("Failed to update visibility");
      // Revert on error
      setAllChapters(prev => prev.map(c => 
        c.id === chapter.id ? { ...c, flashcards_visible: !newVisibility } : c
      ));
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (allChapters.length === 0) {
    return (
      <Card data-testid="flashcard-card">
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Layers className="w-12 h-12 text-muted-foreground mb-4" />
          <h4 className="font-sans font-medium mb-2">No Textbook Chapters</h4>
          <p className="text-sm text-muted-foreground">
            Upload a textbook and detect chapters first to generate flashcards.
          </p>
        </CardContent>
      </Card>
    );
  }

  const chaptersWithFlashcards = allChapters.filter(
    (ch) => ch.flashcards && Array.isArray(ch.flashcards) && ch.flashcards.length > 0
  );

  return (
    <>
      <Card data-testid="flashcard-card">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 font-sans">
            <Layers className="w-5 h-5 text-primary" />
            Flashcards
            <Badge variant="secondary" className="ml-2">
              {chaptersWithFlashcards.length} / {allChapters.length}
            </Badge>
          </CardTitle>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => fetchAllChaptersWithFlashcards(true)}
            disabled={refreshing}
            className="h-8 w-8"
            aria-label="Refresh flashcards"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </CardHeader>
        <CardContent>
          <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[38%]">Chapter</TableHead>
              <TableHead className="w-[22%]">Material</TableHead>
              <TableHead className="w-[110px] whitespace-nowrap">Status</TableHead>
              <TableHead className="w-[80px] whitespace-nowrap">Visible</TableHead>
              {classes.length > 0 && <TableHead className="w-[150px] text-center">Classes</TableHead>}
              <TableHead className="w-[72px] text-right whitespace-nowrap">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allChapters.map((chapter) => {
              const hasFlashcards = chapter.flashcards && Array.isArray(chapter.flashcards) && chapter.flashcards.length > 0;
              const flashcardsCount = hasFlashcards ? chapter.flashcards!.length : 0;
              return (
                <TableRow key={chapter.id}>
                  <TableCell className="font-medium">
                    Ch. {chapter.chapter_number}: {chapter.title}
                  </TableCell>
                  <TableCell>
                    {/* The full title is often longer than its column; wrapping
                        it turned the cell into a one-word-per-line stack that
                        stretched every row. Clamp it and keep the whole string
                        on hover. */}
                    <span
                      className="block max-w-[220px] truncate text-muted-foreground text-[11px]"
                      title={chapter.material_title || chapter.material_file_name}
                    >
                      {chapter.material_title || chapter.material_file_name}
                    </span>
                  </TableCell>
                  <TableCell>
                    {hasFlashcards ? (
                      <Badge variant="secondary" className="gap-1 text-xs">
                        <Check className="w-3 h-3 text-green-600" />
                        {flashcardsCount}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {hasFlashcards ? (
                      <div className="flex items-center gap-1.5">
                        {chapter.flashcards_visible ? (
                          <Eye className="w-3 h-3 text-green-600" />
                        ) : (
                          <EyeOff className="w-3 h-3 text-muted-foreground" />
                        )}
                        <Switch
                          checked={chapter.flashcards_visible}
                          onCheckedChange={() => handleToggleVisibility(chapter)}
                          className="scale-75"
                          aria-label={`Toggle flashcard visibility for ${chapter.title}`}
                        />
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  {classes.length > 0 && (
                    // whitespace-nowrap is inherited by the badge inside, which
                    // otherwise wraps "Section 1" onto two lines and inflates
                    // the row.
                    <TableCell className="whitespace-nowrap text-center [&>div]:justify-center">
                      {hasFlashcards ? (
                        <AssignedClassesBadges
                          classes={classes}
                          assignedTargets={contentAssignments.getAssignedTargets(chapter.id)}
                          groupsByOffering={contentAssignments.groupsByOffering}
                          onClickAssign={() => handleOpenAssignDialog(chapter.id)}
                          compact
                        />
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {hasFlashcards ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label={`Flashcard actions for ${chapter.title}`}
                            >
                              {/* The menu closes on select, so a busy row shows
                                  its pending state on the trigger instead. */}
                              {generatingFlashcards === chapter.id || deletingFlashcards === chapter.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <MoreHorizontal className="w-4 h-4" />
                              )}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setPreviewChapter(chapter)}>
                              <Eye className="w-4 h-4 mr-2" />
                              Preview
                            </DropdownMenuItem>
                            {classes.length > 0 && (
                              <DropdownMenuItem onClick={() => handleOpenAssignDialog(chapter.id)}>
                                <Users className="w-4 h-4 mr-2" />
                                Assign to classes
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() => handleGenerateFlashcards(chapter)}
                              disabled={generatingFlashcards === chapter.id}
                            >
                              <Sparkles className="w-4 h-4 mr-2" />
                              Regenerate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => setConfirmDeleteFlashcards(chapter)}
                              disabled={deletingFlashcards === chapter.id}
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs gap-1"
                          onClick={() => handleGenerateFlashcards(chapter)}
                          disabled={generatingFlashcards === chapter.id}
                        >
                          {generatingFlashcards === chapter.id ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Generating...
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-3 h-3" />
                              Generate
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        </CardContent>
      </Card>

      {/* Confirm Delete Flashcards */}
      <AlertDialog open={!!confirmDeleteFlashcards} onOpenChange={(open) => !open && setConfirmDeleteFlashcards(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Flashcards?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all flashcards for "{confirmDeleteFlashcards?.title}". You can regenerate them later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDeleteFlashcards && handleDeleteFlashcards(confirmDeleteFlashcards)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Preview Flashcards Dialog */}
      <Dialog open={!!previewChapter} onOpenChange={(open) => !open && setPreviewChapter(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Preview: Ch. {previewChapter?.chapter_number} - {previewChapter?.title}
            </DialogTitle>
          </DialogHeader>
          {previewChapter && (
            <FlashcardViewer 
              courseId={courseId} 
              isAdmin={true} 
              refreshKey={0}
              filterChapterId={previewChapter.id}
            />
          )}
        </DialogContent>
      </Dialog>

      {classes.length > 0 && assignTargetId && (
        <ContentAssignDialog
          open={assignDialogOpen}
          onOpenChange={setAssignDialogOpen}
          classes={classes}
          currentAssignedTargets={contentAssignments.getAssignedTargets(assignTargetId)}
          groupsByOffering={contentAssignments.groupsByOffering}
          onSave={handleSaveAssign}
          saving={contentAssignments.saving}
        />
      )}
    </>
  );
}