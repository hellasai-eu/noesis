import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Loader2, BookOpen, GraduationCap, ChevronDown, ChevronRight, School, MessageSquareText, BarChart2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { buildClassDisplayName } from "@/lib/greek-school";
import { ClassCompetencyAnalytics } from "./ClassCompetencyAnalytics";
import { useFormatters } from "@/i18n/formatters";

interface Chapter {
  id: string;
  material_id: string;
  chapter_number: number;
  title: string;
  instructions: string | null;
}

interface Material {
  id: string;
  title: string | null;
  file_name: string;
}

interface Competency {
  id: string;
  title: string;
  description: string | null;
}

interface ChapterProgress {
  chapter_id: string;
  is_complete: boolean;
}

interface CompetencyChapter {
  competency_id: string;
  chapter_id: string;
}

interface ClassOption {
  id: string;
  name: string;
  grade_level_id: string | null;
  section_name: string | null;
  academic_period: string | null;
  is_active: boolean;
}

interface CourseProgressProps {
  courseId: string;
  canManage: boolean;
}

export function CourseProgress({
  courseId,
  canManage,
}: CourseProgressProps) {
  const { compareText } = useFormatters();
  const [loading, setLoading] = useState(true);
  const [classesLoading, setClassesLoading] = useState(true);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string>("");
  const [materials, setMaterials] = useState<Material[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [competencies, setCompetencies] = useState<Competency[]>([]);
  const [chapterProgress, setChapterProgress] = useState<ChapterProgress[]>([]);
  const [competencyChapters, setCompetencyChapters] = useState<CompetencyChapter[]>([]);
  const [expandedMaterials, setExpandedMaterials] = useState<Set<string>>(new Set());
  const [updatingChapter, setUpdatingChapter] = useState<string | null>(null);
  const [expandedInstructions, setExpandedInstructions] = useState<Set<string>>(new Set());
  const [instructionsDraft, setInstructionsDraft] = useState<Record<string, string>>({});
  const [savingInstructions, setSavingInstructions] = useState<string | null>(null);
  const [showCompetencyAnalytics, setShowCompetencyAnalytics] = useState(false);

  // Fetch classes for this course
  useEffect(() => {
    fetchClasses();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId change
  }, [courseId]);

  // Fetch progress data when class is selected
  useEffect(() => {
    if (selectedClassId) {
      fetchData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/class change
  }, [courseId, selectedClassId]);

  const fetchClasses = async () => {
    setClassesLoading(true);
    try {
      const { data, error } = await supabase
        .from("offerings")
        .select(`
          class_id,
          classes (
            id,
            name,
            grade_level_id,
            section_name,
            academic_period,
            is_active
          )
        `)
        .eq("course_id", courseId);

      if (error) throw error;

      const classOptions: ClassOption[] = (data || [])
        .filter((o: any) => o.classes)
        .map((o: any) => ({
          id: o.classes.id,
          name: o.classes.name,
          grade_level_id: o.classes.grade_level_id,
          section_name: o.classes.section_name,
          academic_period: o.classes.academic_period,
          is_active: o.classes.is_active ?? true,
        }))
        .sort((a, b) => {
          if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
          return compareText(a.name, b.name);
        });

      setClasses(classOptions);

      // Auto-select first active class if available
      const firstActiveClass = classOptions.find(c => c.is_active);
      if (firstActiveClass) {
        setSelectedClassId(firstActiveClass.id);
      }
    } catch (error) {
      console.error("Error fetching classes:", error);
      toast.error("Failed to load classes");
    } finally {
      setClassesLoading(false);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch materials
      const { data: materialsData, error: materialsError } = await supabase
        .from("course_materials")
        .select("id, title, file_name")
        .eq("course_id", courseId)
        .eq("material_type", "textbook");

      if (materialsError) throw materialsError;
      setMaterials(materialsData || []);

      // Fetch chapters for all materials
      if (materialsData && materialsData.length > 0) {
        const materialIds = materialsData.map((m) => m.id);
        const { data: chaptersData, error: chaptersError } = await supabase
          .from("material_chapters")
          .select("id, material_id, chapter_number, title, instructions")
          .in("material_id", materialIds)
          .order("chapter_number").order("id");

        if (chaptersError) throw chaptersError;
        setChapters(chaptersData || []);
        setInstructionsDraft(
          Object.fromEntries((chaptersData || []).map((c: Chapter) => [c.id, c.instructions || ""]))
        );
      }

      // Fetch competencies
      const { data: competenciesData, error: competenciesError } = await supabase
        .from("course_competencies")
        .select("id, title, description")
        .eq("course_id", courseId)
        .order("order_num");

      if (competenciesError) throw competenciesError;
      setCompetencies(competenciesData || []);

      // Fetch competency-chapter associations
      if (competenciesData && competenciesData.length > 0) {
        const competencyIds = competenciesData.map((c) => c.id);
        const { data: assocData, error: assocError } = await supabase
          .from("competency_chapters")
          .select("competency_id, chapter_id")
          .in("competency_id", competencyIds);

        if (assocError) throw assocError;
        setCompetencyChapters(assocData || []);
      }

      // Fetch chapter progress for selected class
      const { data: progressData, error: progressError } = await supabase
        .from("course_chapter_progress")
        .select("chapter_id, is_complete")
        .eq("class_id", selectedClassId);

      if (progressError) throw progressError;
      setChapterProgress(progressData || []);
    } catch (error) {
      console.error("Error fetching progress data:", error);
      toast.error("Failed to load progress data");
    } finally {
      setLoading(false);
    }
  };

  const toggleChapterComplete = async (chapterId: string, currentlyComplete: boolean) => {
    if (!canManage || !selectedClassId) return;

    setUpdatingChapter(chapterId);
    try {
      const newIsComplete = !currentlyComplete;

      // Upsert the progress record
      const { error } = await supabase
        .from("course_chapter_progress")
        .upsert({
          course_id: courseId,
          class_id: selectedClassId,
          chapter_id: chapterId,
          is_complete: newIsComplete,
          completed_at: newIsComplete ? new Date().toISOString() : null,
        }, {
          onConflict: "class_id,chapter_id",
        });

      if (error) throw error;

      // Update local state
      setChapterProgress((prev) => {
        const existing = prev.find((p) => p.chapter_id === chapterId);
        if (existing) {
          return prev.map((p) =>
            p.chapter_id === chapterId ? { ...p, is_complete: newIsComplete } : p
          );
        }
        return [...prev, { chapter_id: chapterId, is_complete: newIsComplete }];
      });

      toast.success(newIsComplete ? "Chapter marked as done" : "Chapter marked as incomplete");
    } catch (error) {
      console.error("Error updating chapter progress:", error);
      toast.error("Failed to update chapter progress");
    } finally {
      setUpdatingChapter(null);
    }
  };

  const isChapterComplete = (chapterId: string) => {
    return chapterProgress.find((p) => p.chapter_id === chapterId)?.is_complete || false;
  };

  const getCompletedChapterIds = () => {
    return new Set(chapterProgress.filter((p) => p.is_complete).map((p) => p.chapter_id));
  };

  const isCompetencyHighlighted = (competencyId: string) => {
    const completedChapterIds = getCompletedChapterIds();
    const associatedChapterIds = competencyChapters
      .filter((cc) => cc.competency_id === competencyId)
      .map((cc) => cc.chapter_id);

    // Competency is highlighted if at least one of its chapters is complete
    return associatedChapterIds.some((chapterId) => completedChapterIds.has(chapterId));
  };

  const isCompetencyFullyComplete = (competencyId: string) => {
    const completedChapterIds = getCompletedChapterIds();
    const associatedChapterIds = competencyChapters
      .filter((cc) => cc.competency_id === competencyId)
      .map((cc) => cc.chapter_id);

    if (associatedChapterIds.length === 0) return false;
    // Competency is fully complete if all its chapters are complete
    return associatedChapterIds.every((chapterId) => completedChapterIds.has(chapterId));
  };

  const toggleInstructionsExpanded = (chapterId: string) => {
    setExpandedInstructions((prev) => {
      const next = new Set(prev);
      if (next.has(chapterId)) {
        next.delete(chapterId);
      } else {
        next.add(chapterId);
      }
      return next;
    });
  };

  const saveChapterInstructions = async (chapterId: string) => {
    if (!canManage) return;
    const raw = instructionsDraft[chapterId] ?? "";
    const value = raw.trim() ? raw.trim() : null;

    setSavingInstructions(chapterId);
    try {
      const { error } = await supabase
        .from("material_chapters")
        .update({ instructions: value })
        .eq("id", chapterId);

      if (error) throw error;

      setChapters((prev) =>
        prev.map((ch) => (ch.id === chapterId ? { ...ch, instructions: value } : ch))
      );
      toast.success("Instructions saved");
    } catch (error) {
      console.error("Error saving chapter instructions:", error);
      toast.error("Failed to save instructions");
    } finally {
      setSavingInstructions(null);
    }
  };

  const toggleMaterialExpanded = (materialId: string) => {
    setExpandedMaterials((prev) => {
      const next = new Set(prev);
      if (next.has(materialId)) {
        next.delete(materialId);
      } else {
        next.add(materialId);
      }
      return next;
    });
  };

  // Calculate overall progress
  const totalChapters = chapters.length;
  const completedChapters = chapterProgress.filter((p) => p.is_complete).length;
  const progressPercentage = totalChapters > 0 ? (completedChapters / totalChapters) * 100 : 0;

  if (classesLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (classes.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <School className="w-12 h-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">No Classes Available</h3>
          <p className="text-sm text-muted-foreground max-w-md">
            Attach this course to a class first to track chapter progress.
          </p>
        </CardContent>
      </Card>
    );
  }

  const selectedClass = classes.find(c => c.id === selectedClassId);

  return (
    <div className="space-y-4">
      {/* Class Selector - Compact */}
      <div className="flex items-center gap-3 p-3 rounded-lg border bg-card">
        <School className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <span className="text-sm font-medium text-muted-foreground">Class:</span>
        <Select value={selectedClassId} onValueChange={setSelectedClassId}>
          <SelectTrigger className="w-[200px] h-8">
            <SelectValue placeholder="Select a class" />
          </SelectTrigger>
          <SelectContent>
            {classes.map((cls) => (
              <SelectItem key={cls.id} value={cls.id}>
                {buildClassDisplayName(cls)}
                {cls.academic_period ? ` (${cls.academic_period})` : ""}
                {!cls.is_active && " - Inactive"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!selectedClassId ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-8 text-center">
            <School className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              Select a class above to view and manage chapter progress
            </p>
          </CardContent>
        </Card>
      ) : loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : (
        <>
          {/* Overall Progress - Compact */}
          <div className="p-3 rounded-lg border bg-card">
            <div className="flex items-center justify-between mb-2 gap-2">
              <span className="text-sm font-medium">{selectedClass?.name} Progress</span>
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 gap-1 text-xs"
                  onClick={() => setShowCompetencyAnalytics((v) => !v)}
                >
                  <BarChart2 className="w-3.5 h-3.5" />
                  Competency Analytics
                  {showCompetencyAnalytics ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                </Button>
                <span className="text-sm font-medium">{Math.round(progressPercentage)}%</span>
              </div>
            </div>
            <Progress value={progressPercentage} className="h-2" />
            <p className="text-xs text-muted-foreground mt-1">
              {completedChapters} of {totalChapters} chapters complete
            </p>
          </div>

          {showCompetencyAnalytics && (
            <ClassCompetencyAnalytics
              courseId={courseId}
              classes={classes}
              selectedClassId={selectedClassId || null}
              showSelector={false}
              description={`Aggregated competency scores for ${selectedClass ? buildClassDisplayName(selectedClass) : "this section"} from saved student evaluations.`}
            />
          )}

      <div className="grid md:grid-cols-2 gap-6">
        {/* Chapters Section */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <BookOpen className="w-5 h-5" />
              Chapters
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {materials.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No materials with chapters yet
              </p>
            ) : (
              materials.map((material) => {
                const materialChapters = chapters.filter((c) => c.material_id === material.id);
                const isExpanded = expandedMaterials.has(material.id);
                const materialCompleteCount = materialChapters.filter((c) =>
                  isChapterComplete(c.id)
                ).length;
                const chaptersWithInstructionsCount = materialChapters.filter(
                  (c) => !!c.instructions,
                ).length;

                return (
                  <Collapsible
                    key={material.id}
                    open={isExpanded}
                    onOpenChange={() => toggleMaterialExpanded(material.id)}
                  >
                    <CollapsibleTrigger className="w-full">
                      <div className="flex items-center justify-between gap-2 p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
                        <div className="flex items-center gap-2 min-w-0">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 shrink-0" />
                          ) : (
                            <ChevronRight className="w-4 h-4 shrink-0" />
                          )}
                          <span className="font-medium text-sm truncate">
                            {material.title || material.file_name}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {chaptersWithInstructionsCount > 0 && (
                            <Badge
                              variant="outline"
                              className="text-xs gap-1 border-primary/40 text-primary"
                              title={`${chaptersWithInstructionsCount} chapter${chaptersWithInstructionsCount === 1 ? "" : "s"} with AI instructions`}
                            >
                              <MessageSquareText className="w-3 h-3" />
                              {chaptersWithInstructionsCount}
                            </Badge>
                          )}
                          <Badge variant="secondary" className="text-xs">
                            {materialCompleteCount}/{materialChapters.length}
                          </Badge>
                        </div>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="ml-6 mt-2 space-y-2">
                        {materialChapters.map((chapter) => {
                          const isComplete = isChapterComplete(chapter.id);
                          const isUpdating = updatingChapter === chapter.id;
                          const instructionsOpen = expandedInstructions.has(chapter.id);
                          const draft = instructionsDraft[chapter.id] ?? "";
                          const savedInstructions = chapter.instructions || "";
                          const isDirty = draft.trim() !== savedInstructions.trim();
                          const isSavingThis = savingInstructions === chapter.id;
                          const hasInstructions = !!chapter.instructions;

                          return (
                            <div
                              key={chapter.id}
                              className={`rounded-md transition-colors ${
                                isComplete ? "bg-primary/10" : "hover:bg-muted/50"
                              }`}
                            >
                              <div className="flex items-center gap-3 p-2">
                                {isUpdating ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Checkbox
                                    checked={isComplete}
                                    onCheckedChange={() =>
                                      toggleChapterComplete(chapter.id, isComplete)
                                    }
                                    disabled={!canManage}
                                  />
                                )}
                                <span
                                  className={`text-sm flex-1 ${
                                    isComplete ? "text-primary font-medium" : ""
                                  }`}
                                >
                                  Ch. {chapter.chapter_number}: {chapter.title}
                                </span>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleInstructionsExpanded(chapter.id)}
                                  className="h-7 px-2 gap-1 text-xs"
                                  title={hasInstructions ? "Edit AI instructions" : "Add AI instructions"}
                                >
                                  <span className="relative inline-flex">
                                    <MessageSquareText
                                      className={`w-3.5 h-3.5 ${hasInstructions ? "text-primary" : "text-muted-foreground"}`}
                                    />
                                    {hasInstructions && (
                                      <span
                                        aria-label="Has AI instructions"
                                        className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary ring-1 ring-background"
                                      />
                                    )}
                                  </span>
                                  {hasInstructions && !instructionsOpen && (
                                    <span className="text-primary font-medium">Notes</span>
                                  )}
                                  {instructionsOpen ? (
                                    <ChevronDown className="w-3 h-3" />
                                  ) : (
                                    <ChevronRight className="w-3 h-3" />
                                  )}
                                </Button>
                              </div>
                              {instructionsOpen && (
                                <div className="px-2 pb-2 pl-9 space-y-2">
                                  <Textarea
                                    placeholder="Special instructions for the AI when students generate questions on this chapter (e.g., focus on vocabulary, avoid theoretical proofs...)"
                                    value={draft}
                                    onChange={(e) =>
                                      setInstructionsDraft((prev) => ({
                                        ...prev,
                                        [chapter.id]: e.target.value,
                                      }))
                                    }
                                    disabled={!canManage || isSavingThis}
                                    className="min-h-[70px] text-sm"
                                  />
                                  {canManage && (
                                    <div className="flex justify-end">
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => saveChapterInstructions(chapter.id)}
                                        disabled={!isDirty || isSavingThis}
                                      >
                                        {isSavingThis ? (
                                          <>
                                            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                            Saving...
                                          </>
                                        ) : (
                                          "Save Instructions"
                                        )}
                                      </Button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* Competencies Section */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <GraduationCap className="w-5 h-5" />
              Competencies
            </CardTitle>
          </CardHeader>
          <CardContent>
            {competencies.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No competencies defined yet
              </p>
            ) : (
              <div className="space-y-2">
                {competencies.map((competency) => {
                  const isHighlighted = isCompetencyHighlighted(competency.id);
                  const isFullyComplete = isCompetencyFullyComplete(competency.id);
                  const associatedChapterCount = competencyChapters.filter(
                    (cc) => cc.competency_id === competency.id
                  ).length;
                  const completedChapterIds = getCompletedChapterIds();
                  const completedAssociatedCount = competencyChapters.filter(
                    (cc) =>
                      cc.competency_id === competency.id &&
                      completedChapterIds.has(cc.chapter_id)
                  ).length;

                  return (
                    <div
                      key={competency.id}
                      className={`p-3 rounded-lg border transition-all ${
                        isFullyComplete
                          ? "bg-primary/20 border-primary"
                          : isHighlighted
                          ? "bg-primary/10 border-primary/50"
                          : "bg-muted/30 border-border opacity-60"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p
                            className={`font-medium text-sm ${
                              isHighlighted ? "text-primary" : "text-muted-foreground"
                            }`}
                          >
                            {competency.title}
                          </p>
                          {competency.description && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                              {competency.description}
                            </p>
                          )}
                        </div>
                        {associatedChapterCount > 0 && (
                          <Badge
                            variant={isFullyComplete ? "default" : "secondary"}
                            className="text-xs shrink-0"
                          >
                            {completedAssociatedCount}/{associatedChapterCount}
                          </Badge>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
        </>
      )}
    </div>
  );
}
