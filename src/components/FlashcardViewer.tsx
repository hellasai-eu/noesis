import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Layers,
  Eye,
  EyeOff,
  Loader2,
  ChevronDown,
  ChevronRight,
  BookOpen,
  RotateCcw,
  RefreshCw,
  ChevronLeft,
  ChevronRightIcon,
} from "lucide-react";
import { toast } from "sonner";

interface Flashcard {
  front: string;
  back: string;
}

interface ChapterWithFlashcards {
  id: string;
  chapter_number: number;
  title: string;
  flashcards: Flashcard[];
  flashcards_visible: boolean;
  material_id: string;
  material_title: string;
}

interface FlashcardViewerProps {
  courseId: string;
  isAdmin?: boolean;
  onlyVisible?: boolean;
  refreshKey?: number; // Trigger refresh when this changes
  filterChapterId?: string; // Filter to show only a specific chapter
  offeringId?: string; // Filter by offering for students
}

export default function FlashcardViewer({
  courseId,
  isAdmin = false,
  onlyVisible = false,
  refreshKey = 0,
  filterChapterId,
  offeringId,
}: FlashcardViewerProps) {
  const [chapters, setChapters] = useState<ChapterWithFlashcards[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedMaterials, setExpandedMaterials] = useState<Set<string>>(new Set());
  const [selectedChapter, setSelectedChapter] = useState<ChapterWithFlashcards | null>(null);
  const [togglingVisibility, setTogglingVisibility] = useState<string | null>(null);
  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);

  useEffect(() => {
    fetchChapters();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/refreshKey change
  }, [courseId, refreshKey]);

  // Auto-refresh when flashcards are generated/updated
  useEffect(() => {
    const channel = supabase
      .channel(`flashcard-updates-${courseId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'material_chapters',
        },
        (payload) => {
          // Check if flashcards field was updated
          const newFlashcards = payload.new?.flashcards;
          if (Array.isArray(newFlashcards) && newFlashcards.length > 0) {
            fetchChapters(true);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscription setup on courseId change
  }, [courseId]);

  const fetchChapters = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const { data: materialsData, error: materialsError } = await supabase
        .from("course_materials")
        .select("id, title")
        .eq("course_id", courseId);

      if (materialsError) throw materialsError;
      if (!materialsData || materialsData.length === 0) {
        setChapters([]);
        setLoading(false);
        return;
      }

      const materialIds = materialsData.map((m) => m.id);
      const materialTitles = new Map(
        materialsData.map((m) => [m.id, m.title || "Untitled Material"])
      );

      // If student view with offering, get assigned chapter IDs first
      let assignedChapterIds: Set<string> | null = null;
      if (onlyVisible && offeringId) {
        const { data: assignedChapters } = await supabase
          .from("offering_chapter_flashcards")
          .select("chapter_id")
          .eq("offering_id", offeringId)
          .not("published_at", "is", null);
        
        if (assignedChapters && assignedChapters.length > 0) {
          assignedChapterIds = new Set(assignedChapters.map(ac => ac.chapter_id));
        } else {
          // No flashcards assigned to this offering
          setChapters([]);
          setLoading(false);
          setRefreshing(false);
          return;
        }
      }

      let query = supabase
        .from("material_chapters")
        .select("id, chapter_number, title, flashcards, flashcards_visible, material_id")
        .in("material_id", materialIds)
        .order("chapter_number", { ascending: true }).order("id");

      if (filterChapterId) {
        query = query.eq("id", filterChapterId);
      }

      if (onlyVisible) {
        query = query.eq("flashcards_visible", true);
      }

      const { data: chaptersData, error: chaptersError } = await query;

      if (chaptersError) throw chaptersError;

      // Filter chapters that have flashcards
      let enrichedChapters: ChapterWithFlashcards[] = (chaptersData || [])
        .filter((ch: any) => {
          const flashcards = ch.flashcards;
          return Array.isArray(flashcards) && flashcards.length > 0;
        })
        .map((ch: any) => ({
          ...ch,
          flashcards: ch.flashcards as Flashcard[],
          material_title: materialTitles.get(ch.material_id) || "Untitled Material",
        }));

      // Filter by assigned chapters if in student view with offering
      if (assignedChapterIds) {
        enrichedChapters = enrichedChapters.filter(ch => assignedChapterIds!.has(ch.id));
      }

      setChapters(enrichedChapters);

      if (enrichedChapters.length > 0) {
        const materialIds = new Set(enrichedChapters.map((ch) => ch.material_id));
        setExpandedMaterials(materialIds);
      }
    } catch (error: any) {
      console.error("Error fetching flashcards:", error);
      toast.error("Failed to load flashcards");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const toggleVisibility = async (chapter: ChapterWithFlashcards) => {
    setTogglingVisibility(chapter.id);
    try {
      const { error } = await supabase
        .from("material_chapters")
        .update({ flashcards_visible: !chapter.flashcards_visible })
        .eq("id", chapter.id);

      if (error) throw error;

      setChapters((prev) =>
        prev.map((ch) =>
          ch.id === chapter.id
            ? { ...ch, flashcards_visible: !ch.flashcards_visible }
            : ch
        )
      );

      toast.success(
        chapter.flashcards_visible
          ? "Flashcards hidden from students"
          : "Flashcards visible to students"
      );
    } catch (error: any) {
      toast.error("Failed to update visibility");
    } finally {
      setTogglingVisibility(null);
    }
  };

  const openFlashcards = (chapter: ChapterWithFlashcards) => {
    setSelectedChapter(chapter);
    setCurrentCardIndex(0);
    setIsFlipped(false);
  };

  const nextCard = () => {
    if (selectedChapter && currentCardIndex < selectedChapter.flashcards.length - 1) {
      setCurrentCardIndex((prev) => prev + 1);
      setIsFlipped(false);
    }
  };

  const prevCard = () => {
    if (currentCardIndex > 0) {
      setCurrentCardIndex((prev) => prev - 1);
      setIsFlipped(false);
    }
  };

  const groupedByMaterial = chapters.reduce(
    (acc, chapter) => {
      if (!acc[chapter.material_id]) {
        acc[chapter.material_id] = {
          title: chapter.material_title,
          chapters: [],
        };
      }
      acc[chapter.material_id].chapters.push(chapter);
      return acc;
    },
    {} as Record<string, { title: string; chapters: ChapterWithFlashcards[] }>
  );

  const totalFlashcards = chapters.reduce((sum, ch) => sum + ch.flashcards.length, 0);

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
        <CardContent className="py-12 text-center">
          <Layers className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">
            {onlyVisible
              ? "No flashcards available yet"
              : "No flashcards generated yet. Create chapters from your materials to generate flashcards."}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => fetchChapters(true)}
            disabled={refreshing}
          >
            {refreshing ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            Refresh
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 font-sans">
            <Layers className="w-5 h-5 text-blue-500" />
            Flashcards
            <Badge variant="secondary" className="ml-2">
              {totalFlashcards} cards
            </Badge>
          </CardTitle>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => fetchChapters(true)}
            disabled={refreshing}
            className="h-8 w-8"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Object.entries(groupedByMaterial).map(
              ([materialId, { title, chapters: materialChapters }]) => (
                <Collapsible
                  key={materialId}
                  open={expandedMaterials.has(materialId)}
                  onOpenChange={(open) => {
                    setExpandedMaterials((prev) => {
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
                        {materialChapters.reduce((sum, ch) => sum + ch.flashcards.length, 0)} cards
                      </Badge>
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="pl-8 pr-2 space-y-2 mt-2">
                      {materialChapters.map((chapter) => (
                        <div
                          key={chapter.id}
                          className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                        >
                          <div className="flex items-center gap-3">
                            <Layers className="w-4 h-4 text-blue-500" />
                            <div>
                              <p className="font-medium text-sm">
                                Ch. {chapter.chapter_number}: {chapter.title}
                              </p>
                              <div className="flex items-center gap-2 mt-1">
                                <Badge variant="secondary" className="text-xs">
                                  {chapter.flashcards.length} cards
                                </Badge>
                                {isAdmin && (
                                  <>
                                    {chapter.flashcards_visible ? (
                                      <Badge
                                        variant="outline"
                                        className="text-xs bg-green-500/10 text-green-600 border-green-500/30"
                                      >
                                        <Eye className="w-3 h-3 mr-1" />
                                        Visible
                                      </Badge>
                                    ) : (
                                      <Badge
                                        variant="outline"
                                        className="text-xs bg-muted text-muted-foreground"
                                      >
                                        <EyeOff className="w-3 h-3 mr-1" />
                                        Hidden
                                      </Badge>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {isAdmin && (
                              <>
                                <Switch
                                  checked={chapter.flashcards_visible}
                                  onCheckedChange={() => toggleVisibility(chapter)}
                                  disabled={togglingVisibility === chapter.id}
                                />
                              </>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openFlashcards(chapter)}
                            >
                              <Eye className="w-4 h-4 mr-1" />
                              Study
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )
            )}
          </div>
        </CardContent>
      </Card>

      {/* Flashcard Study Dialog */}
      <Dialog open={!!selectedChapter} onOpenChange={() => setSelectedChapter(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-blue-500" />
              Flashcards: {selectedChapter?.title}
            </DialogTitle>
          </DialogHeader>
          {selectedChapter && (
            <div className="space-y-6">
              {/* Progress */}
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  Card {currentCardIndex + 1} of {selectedChapter.flashcards.length}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCurrentCardIndex(0);
                    setIsFlipped(false);
                  }}
                >
                  <RotateCcw className="w-4 h-4 mr-1" />
                  Restart
                </Button>
              </div>

              {/* Flashcard */}
              <div
                className="relative min-h-[250px] cursor-pointer"
                onClick={() => setIsFlipped(!isFlipped)}
              >
                <div
                  className={`absolute inset-0 rounded-xl border-2 p-6 flex flex-col items-center justify-center text-center transition-all duration-300 ${
                    isFlipped
                      ? "bg-green-500/5 border-green-500/30"
                      : "bg-primary/5 border-primary/30"
                  }`}
                >
                  <Badge
                    variant="outline"
                    className={`absolute top-4 left-4 ${
                      isFlipped ? "text-green-600" : "text-primary"
                    }`}
                  >
                    {isFlipped ? "Answer" : "Question"}
                  </Badge>
                  <p className="text-lg font-medium leading-relaxed">
                    {isFlipped
                      ? selectedChapter.flashcards[currentCardIndex].back
                      : selectedChapter.flashcards[currentCardIndex].front}
                  </p>
                  <p className="text-xs text-muted-foreground mt-4">
                    Click to {isFlipped ? "see question" : "reveal answer"}
                  </p>
                </div>
              </div>

              {/* Navigation */}
              <div className="flex items-center justify-between">
                <Button
                  variant="outline"
                  onClick={prevCard}
                  disabled={currentCardIndex === 0}
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Previous
                </Button>
                <div className="flex gap-1">
                  {selectedChapter.flashcards.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setCurrentCardIndex(i);
                        setIsFlipped(false);
                      }}
                      className={`w-2 h-2 rounded-full transition-colors ${
                        i === currentCardIndex ? "bg-primary" : "bg-muted"
                      }`}
                    />
                  ))}
                </div>
                <Button
                  variant="outline"
                  onClick={nextCard}
                  disabled={currentCardIndex === selectedChapter.flashcards.length - 1}
                >
                  Next
                  <ChevronRightIcon className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
