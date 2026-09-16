import { useState, useEffect, useMemo, useCallback } from "react";
import { useContentAssignments } from "@/hooks/useContentAssignments";
import { ContentAssignDialog } from "./ContentAssignDialog";
import { AssignedClassesBadges } from "./AssignedClassesBadges";
import type { CourseClass } from "@/types/content-assignments";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AiDisclaimer } from "@/components/AiDisclaimer";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CheatSheetEditor } from "@/components/CheatSheetEditor";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
  Eye,
  EyeOff,
  Loader2,
  ChevronDown,
  ChevronRight,
  Sparkles,
  BookOpen,
  RefreshCw,
  Pencil,
  Save,
  Trash2,
  Check,
  MoreHorizontal,
  Users,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { renderAuthoredHtml } from "@/lib/latex-utils";
import "katex/dist/katex.min.css";
import { useFormatters } from "@/i18n/formatters";

interface ChapterWithCheatSheet {
  id: string;
  chapter_number: number;
  title: string;
  cheat_sheet: string | null;
  cheat_sheet_visible: boolean;
  material_id: string;
  material_title: string;
  material_file_name: string | null;
  material_type: string;
}

interface CheatSheetViewerProps {
  courseId: string;
  isAdmin?: boolean;
  onlyVisible?: boolean; // For student view - only show visible cheat sheets
  refreshKey?: number; // Trigger refresh when this changes
  offeringId?: string; // Filter by offering for students
  classes?: CourseClass[];
}

export default function CheatSheetViewer({
  courseId,
  isAdmin = false,
  onlyVisible = false,
  refreshKey = 0,
  offeringId,
  classes = [],
}: CheatSheetViewerProps) {
  const { compareText } = useFormatters();
  const [chapters, setChapters] = useState<ChapterWithCheatSheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedMaterials, setExpandedMaterials] = useState<Set<string>>(new Set());
  const [selectedCheatSheet, setSelectedCheatSheet] = useState<ChapterWithCheatSheet | null>(null);
  const [togglingVisibility, setTogglingVisibility] = useState<string | null>(null);
  const [editingCheatSheet, setEditingCheatSheet] = useState<ChapterWithCheatSheet | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [generatingChapterId, setGeneratingChapterId] = useState<string | null>(null);
  const [deletingChapterId, setDeletingChapterId] = useState<string | null>(null);
  const [confirmDeleteChapter, setConfirmDeleteChapter] = useState<ChapterWithCheatSheet | null>(null);

  // Content assignment
  const chapterIdsWithCheatSheet = useMemo(() => chapters.filter(ch => !!ch.cheat_sheet).map(ch => ch.id), [chapters]);
  const contentAssignments = useContentAssignments('chapter_cheatsheet', chapterIdsWithCheatSheet, classes);
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
    fetchChapters();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/refreshKey change
  }, [courseId, refreshKey]);

  const fetchChapters = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      // Get textbook materials only (cheat sheets are only for textbooks)
      const { data: materialsData, error: materialsError } = await supabase
        .from("course_materials")
        .select("id, title, file_name, material_type")
        .eq("course_id", courseId)
        .eq("material_type", "textbook");

      if (materialsError) throw materialsError;
      if (!materialsData || materialsData.length === 0) {
        setChapters([]);
        setLoading(false);
        return;
      }

      const materialIds = materialsData.map(m => m.id);
      const materialInfo = new Map(
        materialsData.map(m => [
          m.id,
          {
            title: m.title || "Untitled Material",
            file_name: m.file_name ?? null,
            type: m.material_type,
          },
        ])
      );

      // If student view with offering, get assigned chapter IDs first
      let assignedChapterIds: Set<string> | null = null;
      if (onlyVisible && offeringId) {
        const { data: assignedChapters } = await supabase
          .from("offering_chapter_cheatsheets")
          .select("chapter_id")
          .eq("offering_id", offeringId)
          .not("published_at", "is", null);

        if (assignedChapters && assignedChapters.length > 0) {
          assignedChapterIds = new Set(assignedChapters.map(ac => ac.chapter_id));
        } else {
          // No cheat sheets assigned to this offering
          setChapters([]);
          setLoading(false);
          setRefreshing(false);
          return;
        }
      }

      let query = supabase
        .from("material_chapters")
        .select("id, chapter_number, title, cheat_sheet, cheat_sheet_visible, material_id")
        .in("material_id", materialIds)
        .order("chapter_number", { ascending: true }).order("id");

      // For student view, only show chapters with visible cheat sheets
      if (onlyVisible) {
        query = query.not("cheat_sheet", "is", null).eq("cheat_sheet_visible", true);
      }

      const { data: chaptersData, error: chaptersError } = await query;

      if (chaptersError) throw chaptersError;

      let enrichedChapters: ChapterWithCheatSheet[] = (chaptersData || []).map(ch => {
        const info = materialInfo.get(ch.material_id);
        return {
          ...ch,
          material_title: info?.title || "Untitled Material",
          material_file_name: info?.file_name ?? null,
          material_type: info?.type || "textbook",
        };
      });

      // Filter by assigned chapters if in student view with offering
      if (assignedChapterIds) {
        enrichedChapters = enrichedChapters.filter(ch => assignedChapterIds!.has(ch.id));
      }

      // Order by material title then chapter number for stable table ordering
      enrichedChapters.sort((a, b) => {
        const titleCmp = compareText((a.material_title || ""), b.material_title || "");
        if (titleCmp !== 0) return titleCmp;
        return a.chapter_number - b.chapter_number;
      });

      setChapters(enrichedChapters);

      // Auto-expand all materials (still used for the student view)
      if (enrichedChapters.length > 0) {
        const uniqueMaterialIds = new Set(enrichedChapters.map(ch => ch.material_id));
        setExpandedMaterials(uniqueMaterialIds);
      }
    } catch (error: any) {
      console.error("Error fetching cheat sheets:", error);
      toast.error("Failed to load cheat sheets");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const toggleVisibility = async (chapter: ChapterWithCheatSheet) => {
    setTogglingVisibility(chapter.id);
    try {
      const { error } = await supabase
        .from("material_chapters")
        .update({ cheat_sheet_visible: !chapter.cheat_sheet_visible })
        .eq("id", chapter.id);

      if (error) throw error;

      setChapters(prev => prev.map(ch =>
        ch.id === chapter.id
          ? { ...ch, cheat_sheet_visible: !ch.cheat_sheet_visible }
          : ch
      ));

      toast.success(chapter.cheat_sheet_visible
        ? "Cheat sheet hidden from students"
        : "Cheat sheet visible to students"
      );
    } catch (error: any) {
      toast.error("Failed to update visibility");
    } finally {
      setTogglingVisibility(null);
    }
  };

  const handleEditClick = (chapter: ChapterWithCheatSheet) => {
    const content = (chapter.cheat_sheet || '')
      .replace(/^```html\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    setEditContent(content);
    setEditingCheatSheet(chapter);
  };

  const handleSaveCheatSheet = async () => {
    if (!editingCheatSheet) return;

    setSaving(true);
    try {
      const { error } = await supabase
        .from("material_chapters")
        .update({ cheat_sheet: editContent })
        .eq("id", editingCheatSheet.id);

      if (error) throw error;

      setChapters(prev => prev.map(ch =>
        ch.id === editingCheatSheet.id
          ? { ...ch, cheat_sheet: editContent }
          : ch
      ));

      toast.success("Cheat sheet updated successfully");
      setEditingCheatSheet(null);
    } catch (error: any) {
      console.error("Error saving cheat sheet:", error);
      toast.error("Failed to save cheat sheet");
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateCheatSheet = async (chapter: ChapterWithCheatSheet) => {
    setGeneratingChapterId(chapter.id);
    try {
      const { data, error } = await supabase.functions.invoke("generate-cheatsheet", {
        body: { chapterId: chapter.id },
      });

      if (error) throw error;

      if (data?.success) {
        toast.success("Cheat sheet generated successfully");
        // Update local state
        setChapters(prev => prev.map(ch =>
          ch.id === chapter.id
            ? {
                ...ch,
                cheat_sheet: data.cheatSheet || null,
                cheat_sheet_visible: ch.cheat_sheet ? ch.cheat_sheet_visible : false,
              }
            : ch
        ));
      } else if (data?.error) {
        toast.error(data.error);
      } else if (data?.skipped) {
        toast.info(data.reason || "Cheat sheet generation skipped");
      }
    } catch (err: any) {
      console.error("Cheat sheet generation error:", err);
      toast.error(err.message || "Failed to generate cheat sheet");
    } finally {
      setGeneratingChapterId(null);
    }
  };

  const handleDeleteCheatSheet = async () => {
    if (!confirmDeleteChapter) return;

    setDeletingChapterId(confirmDeleteChapter.id);
    try {
      const { error } = await supabase
        .from("material_chapters")
        .update({ cheat_sheet: null, cheat_sheet_visible: false })
        .eq("id", confirmDeleteChapter.id);

      if (error) throw error;

      toast.success("Cheat sheet deleted");
      // Update local state
      setChapters(prev => prev.map(ch =>
        ch.id === confirmDeleteChapter.id
          ? { ...ch, cheat_sheet: null, cheat_sheet_visible: false }
          : ch
      ));
    } catch (err: any) {
      console.error("Delete cheat sheet error:", err);
      toast.error("Failed to delete cheat sheet");
    } finally {
      setDeletingChapterId(null);
      setConfirmDeleteChapter(null);
    }
  };

  const groupedByMaterial = useMemo(() => {
    return chapters.reduce((acc, chapter) => {
      if (!acc[chapter.material_id]) {
        acc[chapter.material_id] = {
          title: chapter.material_title,
          chapters: [],
        };
      }
      acc[chapter.material_id].chapters.push(chapter);
      return acc;
    }, {} as Record<string, { title: string; chapters: ChapterWithCheatSheet[] }>);
  }, [chapters]);

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

  if (chapters.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <BookOpen className="w-12 h-12 text-muted-foreground mb-4" />
          <h4 className="font-sans font-medium mb-2">
            {onlyVisible ? "No Cheat Sheets Yet" : "No Textbook Chapters"}
          </h4>
          <p className="text-sm text-muted-foreground">
            {onlyVisible
              ? "No cheat sheets have been shared with you yet."
              : "Upload a textbook and detect chapters first to generate cheat sheets."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const chaptersWithCheatSheets = chapters.filter(ch => ch.cheat_sheet);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 font-sans">
            <BookOpen className="w-5 h-5 text-primary" />
            Cheat Sheets
            <Badge variant="secondary" className="ml-2">
              {chaptersWithCheatSheets.length} / {chapters.length}
            </Badge>
          </CardTitle>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => fetchChapters(true)}
            disabled={refreshing}
            className="h-8 w-8"
            aria-label="Refresh cheat sheets"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </CardHeader>
        <CardContent>
          {/* Cheat sheets are written by `generate-cheatsheet` and then edited
              in place through CheatSheetEditor (#936). `material_chapters` has
              no column saying which of the two last touched `cheat_sheet`, so
              the weaker claim is the only true one here. Shown on the student
              view; instructors already read the badge next to the generate
              action. */}
          {!isAdmin && <AiDisclaimer source="model-or-teacher" className="mb-4" />}
          {isAdmin ? (
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
                {chapters.map((chapter) => {
                  const hasCheatSheet = !!chapter.cheat_sheet;
                  const isGenerating = generatingChapterId === chapter.id;
                  return (
                    <TableRow key={chapter.id}>
                      <TableCell className="font-medium">
                        Ch. {chapter.chapter_number}: {chapter.title}
                      </TableCell>
                      <TableCell>
                        {/* The full title is often longer than its column;
                            wrapping it turned the cell into a one-word-per-line
                            stack that stretched every row. Clamp it and keep the
                            whole string on hover. */}
                        <span
                          className="block max-w-[220px] truncate text-muted-foreground text-[11px]"
                          title={chapter.material_title || chapter.material_file_name}
                        >
                          {chapter.material_title || chapter.material_file_name}
                        </span>
                      </TableCell>
                      <TableCell>
                        {hasCheatSheet ? (
                          <Badge variant="secondary" className="gap-1 text-xs">
                            <Check className="w-3 h-3 text-green-600" />
                            Generated
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {hasCheatSheet ? (
                          <div className="flex items-center gap-1.5">
                            {chapter.cheat_sheet_visible ? (
                              <Eye className="w-3 h-3 text-green-600" />
                            ) : (
                              <EyeOff className="w-3 h-3 text-muted-foreground" />
                            )}
                            <Switch
                              checked={chapter.cheat_sheet_visible}
                              onCheckedChange={() => toggleVisibility(chapter)}
                              disabled={togglingVisibility === chapter.id}
                              className="scale-75"
                              aria-label={`Toggle cheat sheet visibility for ${chapter.title}`}
                            />
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      {classes.length > 0 && (
                        // whitespace-nowrap is inherited by the badge inside,
                        // which otherwise wraps "Section 1" onto two lines and
                        // inflates the row.
                        <TableCell className="whitespace-nowrap text-center [&>div]:justify-center">
                          {hasCheatSheet ? (
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
                          {hasCheatSheet ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  aria-label={`Cheat sheet actions for ${chapter.title}`}
                                >
                                  {/* The menu closes on select, so a busy row
                                      shows its pending state on the trigger. */}
                                  {isGenerating || deletingChapterId === chapter.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <MoreHorizontal className="w-4 h-4" />
                                  )}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => setSelectedCheatSheet(chapter)}>
                                  <Eye className="w-4 h-4 mr-2" />
                                  Preview
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleEditClick(chapter)}>
                                  <Pencil className="w-4 h-4 mr-2" />
                                  Edit
                                </DropdownMenuItem>
                                {classes.length > 0 && (
                                  <DropdownMenuItem onClick={() => handleOpenAssignDialog(chapter.id)}>
                                    <Users className="w-4 h-4 mr-2" />
                                    Assign to classes
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  onClick={() => handleGenerateCheatSheet(chapter)}
                                  disabled={isGenerating}
                                >
                                  <Sparkles className="w-4 h-4 mr-2" />
                                  Regenerate
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => setConfirmDeleteChapter(chapter)}
                                  disabled={deletingChapterId === chapter.id}
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
                              onClick={() => handleGenerateCheatSheet(chapter)}
                              disabled={isGenerating}
                            >
                              {isGenerating ? (
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
          ) : (
            <div className="space-y-4">
              {Object.entries(groupedByMaterial).map(([materialId, { title, chapters: materialChapters }]) => (
                <Collapsible
                  key={materialId}
                  open={expandedMaterials.has(materialId)}
                  onOpenChange={(open) => {
                    setExpandedMaterials(prev => {
                      const next = new Set(prev);
                      if (open) next.add(materialId);
                      else next.delete(materialId);
                      return next;
                    });
                  }}
                >
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" className="w-full justify-start p-3 h-auto">
                      {expandedMaterials.has(materialId) ? (
                        <ChevronDown className="w-4 h-4 mr-2" />
                      ) : (
                        <ChevronRight className="w-4 h-4 mr-2" />
                      )}
                      <BookOpen className="w-4 h-4 mr-2 text-primary" />
                      <span className="font-medium">{title}</span>
                      <Badge variant="outline" className="ml-auto">
                        {materialChapters.filter(ch => ch.cheat_sheet).length} / {materialChapters.length} chapters
                      </Badge>
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="pl-8 pr-2 space-y-2 mt-2">
                      {materialChapters.map((chapter) => {
                        const hasCheatSheet = !!chapter.cheat_sheet;
                        return (
                          <div
                            key={chapter.id}
                            className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              <FileText className={`w-4 h-4 ${hasCheatSheet ? 'text-amber-500' : 'text-muted-foreground'}`} />
                              <p className="font-medium text-sm">
                                Ch. {chapter.chapter_number}: {chapter.title}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {hasCheatSheet && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setSelectedCheatSheet(chapter)}
                                >
                                  <Eye className="w-4 h-4 mr-1" />
                                  View
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cheat Sheet Preview Dialog */}
      <Dialog open={!!selectedCheatSheet} onOpenChange={() => setSelectedCheatSheet(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-primary" />
              Cheat Sheet: {selectedCheatSheet?.title}
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="h-[60vh] pr-4">
            {/* Was injected raw: no LaTeX pass, so `$...$` showed as text, and
                no sanitization of model-authored HTML either. */}
            <div
              className="prose prose-sm dark:prose-invert max-w-none
                prose-headings:text-foreground prose-p:text-foreground
                prose-li:text-foreground prose-strong:text-foreground
                prose-table:text-foreground prose-th:text-foreground prose-td:text-foreground
                prose-th:border prose-td:border prose-th:p-2 prose-td:p-2
                prose-table:border-collapse prose-table:w-full"
              dangerouslySetInnerHTML={{
                __html: renderAuthoredHtml(
                  (selectedCheatSheet?.cheat_sheet || '')
                    .replace(/^```html\s*/i, '')
                    .replace(/```\s*$/, '')
                    .trim()
                )
              }}
            />
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Edit Cheat Sheet Dialog */}
      <Dialog open={!!editingCheatSheet} onOpenChange={() => setEditingCheatSheet(null)}>
        <DialogContent className="max-w-4xl h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-amber-500" />
              Edit Cheat Sheet: {editingCheatSheet?.title}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            <CheatSheetEditor
              content={editContent}
              onChange={setEditContent}
            />
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setEditingCheatSheet(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveCheatSheet} disabled={saving}>
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Delete Cheat Sheet Dialog */}
      <AlertDialog open={!!confirmDeleteChapter} onOpenChange={() => setConfirmDeleteChapter(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Cheat Sheet?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the cheat sheet for "{confirmDeleteChapter?.title}". You can regenerate it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingChapterId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteCheatSheet}
              disabled={!!deletingChapterId}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingChapterId ? (
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
