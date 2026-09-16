import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { TablesUpdate } from '@/integrations/supabase/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Sparkles,
  Plus,
  Trash2,
  GripVertical,
  Loader2,
  BookOpen,
  Pencil,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  RefreshCw
} from 'lucide-react';

interface Competency {
  id?: string;
  title: string;
  description: string;
  chapterId?: string | null;
  chapterIds?: string[];
  chapterTitle?: string;
  materialId?: string | null;
  orderNum: number;
  isNew?: boolean;
  isEditing?: boolean;
  isSaving?: boolean;
}

interface Chapter {
  id: string;
  title: string;
  content: string | null;
  instructions: string | null;
  chapter_number: number;
  material_id: string;
  openai_file_id: string | null;
}

interface ChapterWithEstimates extends Chapter {
  estimated_pages: number;
  estimated_size: number;
}

interface Material {
  id: string;
  title: string | null;
  file_name: string;
  openai_file_id: string | null;
  page_count: number | null;
  file_size: number | null;
}

// Batching constants
const MAX_BATCH_PAGES = 200;
const MAX_BATCH_SIZE_BYTES = 32 * 1024 * 1024; // 32MB

// Helper: Group chapters into batches respecting page/size limits
const createBatches = (chapters: ChapterWithEstimates[]): ChapterWithEstimates[][] => {
  const batches: ChapterWithEstimates[][] = [];
  let currentBatch: ChapterWithEstimates[] = [];
  let currentPages = 0;
  let currentSize = 0;

  for (const chapter of chapters) {
    const wouldExceedPages = currentPages + chapter.estimated_pages > MAX_BATCH_PAGES;
    const wouldExceedSize = currentSize + chapter.estimated_size > MAX_BATCH_SIZE_BYTES;

    if (currentBatch.length > 0 && (wouldExceedPages || wouldExceedSize)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentPages = 0;
      currentSize = 0;
    }

    currentBatch.push(chapter);
    currentPages += chapter.estimated_pages;
    currentSize += chapter.estimated_size;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
};

interface CourseCompetenciesProps {
  courseId: string;
  courseTitle: string;
  courseDescription?: string;
  courseLanguage?: string;
  /** Reports the current competency count so the parent tab can flag an empty set. */
  onCountChange?: (count: number) => void;
}

export default function CourseCompetencies({ 
  courseId, 
  courseTitle, 
  courseDescription,
  courseLanguage,
  onCountChange 
}: CourseCompetenciesProps) {
  const [competencies, setCompetencies] = useState<Competency[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [extractionProgress, setExtractionProgress] = useState<{ current: number; total: number } | null>(null);
  const [isOpen, setIsOpen] = useState(true);
  const [clearingAll, setClearingAll] = useState(false);
  // Which course the rows in `competencies` are known to belong to. Stamped by
  // a successful load and by any successful write; null means the panel does
  // not know this course's competencies and must not report a count.
  const [loadedCourseId, setLoadedCourseId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Debounce timer refs for auto-save on text changes
  const debounceTimers = useRef<Record<string, NodeJS.Timeout>>({});

  // Identifies the newest fetchData call; older ones discard their results.
  const fetchSeqRef = useRef(0);

  // The courseId of the current render, readable from a closure created by an
  // older one.
  const currentCourseIdRef = useRef(courseId);
  currentCourseIdRef.current = courseId;

  // False inside a continuation whose course the panel has already left. Every
  // deferred write has to ask: extraction and Clear All can outlive the course
  // that started them, and dropping their rows into state afterwards would put
  // one course's competencies under another's heading.
  const isCurrentCourse = () => currentCourseIdRef.current === courseId;
  const [filterChapterId, setFilterChapterId] = useState<string | null>(null);
  const [filterMaterialId, setFilterMaterialId] = useState<string | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    index: number;
    comp: Competency;
    scoresCount: number;
  } | null>(null);
  const [deleteConfirmBusy, setDeleteConfirmBusy] = useState(false);

  // Filter competencies by selected chapter and/or material
  const filteredCompetencies = competencies.filter(comp => {
    const chapterIds = comp.chapterIds || (comp.chapterId ? [comp.chapterId] : []);
    
    // Filter by chapter
    if (filterChapterId && !chapterIds.includes(filterChapterId)) {
      return false;
    }
    
    // Filter by material
    if (filterMaterialId && comp.materialId !== filterMaterialId) {
      return false;
    }
    
    return true;
  });

  // Only rows that reached the database count. An unsaved draft carries a
  // `temp-` id, and an extracted competency whose insert failed carries no id
  // at all — either would otherwise clear the parent's "no competencies"
  // marker while every downstream consumer still has nothing to score against.
  const persistedCount = competencies.filter(
    c => c.id && !c.id.startsWith('temp-')
  ).length;

  // Keep the parent's count in step with edits made here (extract, add, clear),
  // so the "no competencies" marker on the tab clears without a page reload.
  useEffect(() => {
    // Say nothing until this panel holds data for the course being asked
    // about: a fetch that failed still has the previous course's rows, and
    // reporting them would overwrite the parent's "not known" with a count
    // belonging to a different course.
    if (loading || loadedCourseId !== courseId) return;
    onCountChange?.(persistedCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report on count change only
  }, [persistedCount, loading, loadedCourseId, courseId]);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId change
  }, [courseId]);

  const fetchData = async () => {
    // A courseId change starts a second load while the first is still in
    // flight, and the two can finish in either order. Only the newest one may
    // write state — otherwise a late response leaves another course's rows on
    // screen, and the next successful write would stamp them as this course's.
    const seq = ++fetchSeqRef.current;
    const superseded = () => seq !== fetchSeqRef.current;

    setLoading(true);
    setLoadedCourseId(null);
    setLoadError(false);
    try {
      // Fetch existing competencies
      const { data: compData, error: compError } = await supabase
        .from('course_competencies')
        .select('*')
        .eq('course_id', courseId)
        .order('order_num');

      if (compError) throw compError;

      // Fetch textbooks for extraction (include page_count and file_size)
      const { data: matData, error: matError } = await supabase
        .from('course_materials')
        .select('id, title, file_name, openai_file_id, page_count, file_size')
        .eq('course_id', courseId)
        .eq('material_type', 'textbook');

      if (matError) throw matError;
      if (superseded()) return;
      setMaterials(matData || []);

      let chaptersData: Chapter[] = [];
      if (matData && matData.length > 0) {
        const materialIds = matData.map(m => m.id);
        const { data: chapData, error: chapError } = await supabase
          .from('material_chapters')
          .select('id, title, content, instructions, chapter_number, material_id, openai_file_id')
          .in('material_id', materialIds)
          .order('chapter_number').order('id');

        if (chapError) throw chapError;
        if (superseded()) return;
        chaptersData = (chapData || []) as Chapter[];
        setChapters(chaptersData);
      }

      // Fetch chapter associations from junction table
      const competencyIds = (compData || []).map((c: any) => c.id);
      const chapterAssociations: Record<string, string[]> = {};
      
      if (competencyIds.length > 0) {
        const { data: assocData, error: assocError } = await supabase
          .from('competency_chapters')
          .select('competency_id, chapter_id')
          .in('competency_id', competencyIds);

        if (!assocError && assocData) {
          assocData.forEach((a: any) => {
            if (!chapterAssociations[a.competency_id]) {
              chapterAssociations[a.competency_id] = [];
            }
            chapterAssociations[a.competency_id].push(a.chapter_id);
          });
        }
      }

      if (superseded()) return;
      setCompetencies(
        (compData || []).map((c: any) => {
          const chapterIds = chapterAssociations[c.id] || (c.chapter_id ? [c.chapter_id] : []);
          const chapterTitles = chapterIds
            .map(id => chaptersData.find(ch => ch.id === id)?.title)
            .filter(Boolean);
          
          return {
            id: c.id,
            title: c.title,
            description: c.description || '',
            chapterId: c.chapter_id,
            chapterIds,
            chapterTitle: chapterTitles.join(', '),
            materialId: c.material_id,
            orderNum: c.order_num,
          };
        })
      );
      setLoadedCourseId(courseId);
    } catch (error) {
      console.error('Error fetching data:', error);
      if (superseded()) return;
      toast.error('Failed to load competencies');
      // Drop whatever is in state. fetchData only runs on a courseId change,
      // so a failure means these rows belong to a course we are no longer
      // showing — keeping them would render another course's competencies
      // under this one's heading. The panel says it failed instead (a cleared
      // list must not read as "this course has none").
      setCompetencies([]);
      setChapters([]);
      setMaterials([]);
      setLoadError(true);
    } finally {
      // A superseded load must not clear the spinner the newer one is showing.
      if (!superseded()) setLoading(false);
    }
  };

  // Any successful write proves the rows now in state are this course's: the
  // failed-load path cleared everything else out, and a superseded load never
  // wrote at all. Without this, a competency saved after a failed load would
  // never clear the parent's empty marker.
  //
  // A write started before a courseId change can still land after it, and
  // `courseId` here is the one captured when the handler was created. Stamping
  // then would claim the panel knows a course it has since left — and because
  // fetchData only reruns on a courseId change, that would silence reporting
  // for the current course until the next navigation.
  const markCourseDataKnown = () => {
    if (!isCurrentCourse()) return;
    setLoadedCourseId(courseId);
  };

  // Helper to insert a single competency to DB
  const insertCompetencyToDb = async (competency: Competency): Promise<string | null> => {
    const { data, error } = await supabase
      .from('course_competencies')
      .insert({
        course_id: courseId,
        title: competency.title,
        description: competency.description || null,
        chapter_id: competency.chapterIds?.[0] || competency.chapterId || null,
        material_id: competency.materialId || null,
        order_num: competency.orderNum,
      })
      .select('id')
      .single();

    if (error) {
      console.error('Error inserting competency:', error);
      toast.error('Failed to save competency');
      return null;
    }

    // Insert chapter associations
    if (competency.chapterIds && competency.chapterIds.length > 0) {
      const { error: assocError } = await supabase.from('competency_chapters').insert(
        competency.chapterIds.map(chapterId => ({
          competency_id: data.id,
          chapter_id: chapterId,
        }))
      );
      if (assocError) {
        console.error('Error inserting chapter associations:', assocError);
      }
    }

    markCourseDataKnown();
    return data.id;
  };

  // Helper to update a competency field in DB with debouncing
  const updateCompetencyFieldInDb = useCallback(async (
    competencyId: string,
    field: 'title' | 'description',
    value: string
  ) => {
    // Clear existing timer for this field
    const timerKey = `${competencyId}-${field}`;
    if (debounceTimers.current[timerKey]) {
      clearTimeout(debounceTimers.current[timerKey]);
    }

    // Set new debounced update
    debounceTimers.current[timerKey] = setTimeout(async () => {
      // Skip if it's a temp ID (not yet saved to DB)
      if (competencyId.startsWith('temp-')) return;

      // Branched rather than `{ [field]: value || null }`: a computed key
      // widens the literal to an index signature, which postgrest-js now
      // rejects because it can no longer tell which column is being written.
      //
      // The cast covers only the `title` branch: the column is NOT NULL, so
      // clearing the field has always failed the update with 23502 and
      // surfaced the toast below. Kept as-is rather than quietly starting to
      // save empty titles inside a dependency bump.
      const patch: TablesUpdate<'course_competencies'> =
        field === 'title'
          ? ({ title: value || null } as TablesUpdate<'course_competencies'>)
          : { description: value || null };

      const { error } = await supabase
        .from('course_competencies')
        .update(patch)
        .eq('id', competencyId);

      if (error) {
        console.error(`Error updating ${field}:`, error);
        toast.error(`Failed to save ${field}`);
      }
    }, 500);
  }, []);

  const extractCompetencies = async () => {
    if (!selectedMaterialId) {
      toast.error('Please select a textbook first');
      return;
    }
    
    setIsOpen(true);
    setExtracting(true);
    setExtractionProgress(null);
    
    // Get material info for estimating chapter sizes
    const selectedMaterial = materials.find(m => m.id === selectedMaterialId);
    const materialPageCount = selectedMaterial?.page_count || 0;
    const materialFileSize = selectedMaterial?.file_size || 0;
    
    // Get chapters for the selected material only
    const materialChapters = chapters.filter(ch => ch.material_id === selectedMaterialId);
    const chapterCount = materialChapters.length;
    
    // Estimate page/size per chapter (proportional distribution)
    const chaptersWithEstimates: ChapterWithEstimates[] = materialChapters.map(ch => ({
      ...ch,
      estimated_pages: chapterCount > 0 ? Math.ceil(materialPageCount / chapterCount) : 50,
      estimated_size: chapterCount > 0 ? Math.ceil(materialFileSize / chapterCount) : 1024 * 1024,
    }));
    
    // Create batches respecting 200 pages / 32MB limits
    const batches = createBatches(chaptersWithEstimates);
    
    try {
      const allExtractedCompetencies: Competency[] = [];
      
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        setExtractionProgress({ current: i + 1, total: batches.length });
        
        // Format previously extracted competencies for deduplication
        const previousCompetencies = allExtractedCompetencies
          .map(c => `- ${c.title}: ${c.description}`)
          .join('\n');
        
        const { data, error } = await supabase.functions.invoke('extract-competencies', {
          body: {
            courseId,
            courseTitle,
            courseDescription,
            materialId: selectedMaterialId,
            chapterIds: batch.map(ch => ch.id),
            competencies: previousCompetencies,
            language: courseLanguage || 'en',
          },
        });

        if (error) throw error;

        const extractedCompetencies = data.competencies || [];

        // Map extracted competencies to our format, dedup across and within batches
        for (let idx = 0; idx < extractedCompetencies.length; idx++) {
          const c = extractedCompetencies[idx];
          // Map chapterIndices to chapter IDs (indices are relative to THIS batch)
          const chapterIndices: number[] = c.chapterIndices || [];
          const chapterIds = chapterIndices
            .map((index: number) => batch[index]?.id)
            .filter(Boolean) as string[];
          const chapterTitles = chapterIndices
            .map((index: number) => batch[index]?.title)
            .filter(Boolean);

          // Check if this competency already exists (case-insensitive title match).
          // allExtractedCompetencies is updated in-place within this loop, so this
          // also catches duplicate titles returned within the same batch.
          const existingIdx = allExtractedCompetencies.findIndex(
            (existing) => existing.title.toLowerCase().trim() === c.title.toLowerCase().trim()
          );

          if (existingIdx >= 0) {
            // Merge: add new chapter IDs to the existing competency
            const existing = allExtractedCompetencies[existingIdx];
            const existingChapterIds = new Set(existing.chapterIds || []);
            const newChapterIds = chapterIds.filter(id => !existingChapterIds.has(id));

            if (newChapterIds.length > 0) {
              const mergedChapterIds = [...(existing.chapterIds || []), ...newChapterIds];
              const allChapterTitles = mergedChapterIds
                .map(id => materialChapters.find(ch => ch.id === id)?.title)
                .filter(Boolean);

              // Update in-memory
              allExtractedCompetencies[existingIdx] = {
                ...existing,
                chapterIds: mergedChapterIds,
                chapterTitle: allChapterTitles.join(', '),
              };

              // Update chapter associations in DB
              if (existing.id) {
                const { error: mergeAssocError } = await supabase.from('competency_chapters').insert(
                  newChapterIds.map(chapterId => ({
                    competency_id: existing.id!,
                    chapter_id: chapterId,
                  }))
                );
                if (mergeAssocError) {
                  console.error('Error inserting merged chapter associations:', mergeAssocError);
                  toast.error('Failed to save merged chapter associations');
                }
              }
            }
          } else {
            // New competency — insert to DB
            const comp: Competency = {
              title: c.title,
              description: c.description,
              chapterId: chapterIds[0] || null,
              chapterIds,
              chapterTitle: chapterTitles.join(', '),
              materialId: selectedMaterialId,
              orderNum: competencies.length + allExtractedCompetencies.length,
              isNew: false,
            };

            const dbId = await insertCompetencyToDb(comp);
            if (dbId) {
              comp.id = dbId;
            }

            allExtractedCompetencies.push(comp);
          }
        }

        // Update state after each batch so user sees progress
        if (!isCurrentCourse()) return;
        setCompetencies([...competencies, ...allExtractedCompetencies]);
      }

      if (!isCurrentCourse()) return;
      toast.success(`Extracted ${allExtractedCompetencies.length} competencies from ${materialChapters.length} chapters`);
    } catch (error: any) {
      console.error('Error extracting competencies:', error);
      
      // Check for rate limit or payment errors
      if (error?.status === 429) {
        toast.error('Rate limit exceeded. Please wait and try again.');
      } else if (error?.status === 402) {
        toast.error('AI usage limit reached. Please try again later.');
      } else {
        toast.error('Failed to extract competencies');
      }
    } finally {
      setExtracting(false);
      setExtractionProgress(null);
    }
  };

  const addCompetency = () => {
    // Add to state with a temporary ID until saved
    const tempComp: Competency = {
      id: `temp-${Date.now()}`,
      title: '',
      description: '',
      chapterIds: [],
      orderNum: competencies.length,
      isNew: true,
      isEditing: true,
    };
    setCompetencies(prev => [...prev, tempComp]);
  };

  // Confirm a new competency (save to DB)
  const confirmNewCompetency = async (tempId: string) => {
    const comp = competencies.find(c => c.id === tempId);
    if (!comp) return;

    if (!comp.title.trim()) {
      toast.error('Title is required');
      return;
    }

    // Mark as saving
    setCompetencies(prev => prev.map(c =>
      c.id === tempId ? { ...c, isSaving: true } : c
    ));

    const dbId = await insertCompetencyToDb(comp);

    if (!isCurrentCourse()) return;

    if (dbId) {
      // Replace temp with real DB record
      setCompetencies(prev => prev.map(c =>
        c.id === tempId ? { ...c, id: dbId, isNew: false, isEditing: false, isSaving: false } : c
      ));
      toast.success('Competency saved');
    } else {
      setCompetencies(prev => prev.map(c =>
        c.id === tempId ? { ...c, isSaving: false } : c
      ));
    }
  };

  // Cancel adding a new competency (remove from state without saving)
  const cancelNewCompetency = (tempId: string) => {
    setCompetencies(prev => prev.filter(c => c.id !== tempId));
  };

  const toggleChapterForCompetency = async (index: number, chapterId: string) => {
    const comp = competencies[index];
    const currentIds = comp.chapterIds || [];
    const isRemoving = currentIds.includes(chapterId);
    const newChapterIds = isRemoving
      ? currentIds.filter(id => id !== chapterId)
      : [...currentIds, chapterId];

    // Update state immediately
    const updated = [...competencies];
    updated[index].chapterIds = newChapterIds;
    updated[index].chapterId = newChapterIds[0] || null;
    setCompetencies(updated);

    // Skip DB update for temp IDs
    if (comp.id?.startsWith('temp-')) return;

    // Update DB
    if (isRemoving) {
      const { error } = await supabase
        .from('competency_chapters')
        .delete()
        .eq('competency_id', comp.id)
        .eq('chapter_id', chapterId);
      if (error) {
        console.error('Error removing chapter association:', error);
        toast.error('Failed to update chapter');
      }
    } else {
      const { error } = await supabase
        .from('competency_chapters')
        .insert({ competency_id: comp.id, chapter_id: chapterId });
      if (error) {
        console.error('Error adding chapter association:', error);
        toast.error('Failed to update chapter');
      }
    }

    // Also update the chapter_id column for backwards compatibility
    const { error: updateError } = await supabase
      .from('course_competencies')
      .update({ chapter_id: newChapterIds[0] || null })
      .eq('id', comp.id);
    if (updateError) {
      console.error('Error updating chapter_id:', updateError);
    }
  };

  const updateCompetency = (index: number, field: keyof Competency, value: string) => {
    const comp = competencies[index];
    const updated = [...competencies];
    (updated[index] as any)[field] = value;
    setCompetencies(updated);

    // Auto-save to DB with debouncing for title/description
    if (comp.id && (field === 'title' || field === 'description')) {
      updateCompetencyFieldInDb(comp.id, field, value);
    }
  };

  // Removes the competency from local state at `index`, calls the DB delete,
  // and restores it on failure. Used by both the no-scores fast path and the
  // post-confirmation path that has already cleaned up scores.
  const performDeleteCompetency = async (index: number, comp: Competency, showErrorToast = true): Promise<boolean> => {
    setCompetencies(prev =>
      prev.filter(c => c.id !== comp.id).map((c, i) => ({ ...c, orderNum: i }))
    );

    const { error } = await supabase
      .from('course_competencies')
      .delete()
      .eq('id', comp.id!);

    if (error) {
      console.error('Error deleting competency:', error);
      if (!isCurrentCourse()) return false;
      if (showErrorToast) toast.error('Failed to delete competency');
      setCompetencies(prev => {
        const restored = [...prev];
        const insertAt = Math.min(index, restored.length);
        restored.splice(insertAt, 0, comp);
        return restored.map((c, i) => ({ ...c, orderNum: i }));
      });
      return false;
    }
    markCourseDataKnown();
    return true;
  };

  const deleteCompetency = async (index: number) => {
    const comp = competencies[index];

    // Skip DB delete for temp (unsaved) competencies — just drop from state.
    if (!comp.id || comp.id.startsWith('temp-')) {
      setCompetencies(prev =>
        prev.filter((_, i) => i !== index).map((c, i) => ({ ...c, orderNum: i }))
      );
      return;
    }

    // Pre-check for evaluation scores referencing this competency. The FK
    // constraint is ON DELETE RESTRICT, so without this check the delete fails
    // with a generic error.
    const { count, error: countError } = await supabase
      .from('evaluation_competency_scores')
      .select('*', { count: 'exact', head: true })
      .eq('competency_id', comp.id);

    if (countError) {
      console.error('Error checking competency scores:', countError);
      toast.error('Failed to delete competency');
      return;
    }

    if (count === null) {
      toast.error('Failed to delete competency');
      return;
    }

    if (count > 0) {
      setDeleteConfirm({ index, comp, scoresCount: count });
      return;
    }

    await performDeleteCompetency(index, comp);
  };

  const confirmDeleteWithScores = async () => {
    if (!deleteConfirm) return;
    const { index, comp } = deleteConfirm;

    setDeleteConfirmBusy(true);
    try {
      const { error: scoresError } = await supabase
        .from('evaluation_competency_scores')
        .delete()
        .eq('competency_id', comp.id!);

      if (scoresError) {
        console.error('Error deleting competency scores:', scoresError);
        toast.error('Failed to delete competency scores');
        return;
      }

      // Suppress the generic toast — scores are already gone at this point, so
      // if the competency delete fails the user needs a context-aware message.
      const deleted = await performDeleteCompetency(index, comp, false);
      if (!deleted) {
        // Scores are already removed; competency will delete cleanly on retry.
        toast.error('Scores removed but competency delete failed — please try again.');
      }
    } finally {
      setDeleteConfirmBusy(false);
      setDeleteConfirm(null);
    }
  };

  const toggleEdit = async (index: number) => {
    const comp = competencies[index];

    // If currently editing and it's a new competency, save it first
    if (comp.isEditing && comp.id?.startsWith('temp-')) {
      await confirmNewCompetency(comp.id);
      return;
    }

    // Otherwise just toggle edit mode
    const updated = [...competencies];
    updated[index].isEditing = !updated[index].isEditing;
    setCompetencies(updated);
  };

  const clearAllCompetencies = async () => {
    if (competencies.length === 0) return;

    setClearingAll(true);
    const savedCompetencies = [...competencies];

    // Clear state immediately
    setCompetencies([]);

    try {
      // Delete all competencies for this course from DB
      const { error } = await supabase
        .from('course_competencies')
        .delete()
        .eq('course_id', courseId);

      if (error) throw error;
      markCourseDataKnown();
      toast.success('All competencies cleared');
    } catch (error: any) {
      console.error('Error clearing competencies:', error);
      if (!isCurrentCourse()) return;
      toast.error('Failed to clear competencies');
      // Restore on error
      setCompetencies(savedCompetencies);
    } finally {
      setClearingAll(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="border rounded-lg">
      <CollapsibleTrigger asChild>
        <div className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <BookOpen className="h-5 w-5" />
            <span className="font-semibold">Course Competencies</span>
            {/*
              Testid because this count is the only stable, idempotent signal
              that an extraction added something: the E2E spec reads it before
              and after (#1098). "Clear All appeared" cannot serve — it renders
              for ANY non-zero count, including one a previous run left behind.
            */}
            <Badge variant="secondary" className="ml-2" data-testid="competency-count">
              {competencies.length}
            </Badge>
          </div>
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {/* Textbook selector for extraction */}
            <Select 
              value={selectedMaterialId || ""} 
              onValueChange={(val) => setSelectedMaterialId(val || null)}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Select textbook..." />
              </SelectTrigger>
              <SelectContent>
                {materials.filter(m => m.openai_file_id).map((material) => (
                  <SelectItem key={material.id} value={material.id}>
                    {material.title || material.file_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={extractCompetencies}
              disabled={extracting || !selectedMaterialId}
            >
              {extracting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {extractionProgress 
                    ? `Batch ${extractionProgress.current}/${extractionProgress.total}...`
                    : 'Starting...'}
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Extract
                </>
              )}
            </Button>
            <Button variant="outline" size="sm" onClick={addCompetency}>
              <Plus className="h-4 w-4 mr-2" />
              Add
            </Button>
            {competencies.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={clearAllCompetencies}
                disabled={clearingAll}
                className="text-destructive hover:text-destructive"
              >
                {clearingAll ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" />
                )}
                Clear All
              </Button>
            )}
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 pb-4">
          {chapters.length === 0 && (
            <div className="text-sm text-muted-foreground mb-4 p-3 bg-muted/50 rounded-lg">
              No chapters found. Add chapters to course materials to enable auto-extraction.
            </div>
          )}

          {/* Filters */}
          {competencies.length > 0 && (
            <div className="flex items-center gap-4 mb-4 flex-wrap">
              {/* Textbook filter */}
              {materials.length > 0 && (
                <div className="flex items-center gap-2">
                  <Label className="text-sm text-muted-foreground whitespace-nowrap">Textbook:</Label>
                  <Select 
                    value={filterMaterialId || "all"} 
                    onValueChange={(val) => setFilterMaterialId(val === "all" ? null : val)}
                  >
                    <SelectTrigger className="w-[200px]">
                      <SelectValue placeholder="All textbooks" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All textbooks</SelectItem>
                      {materials.map((material) => (
                        <SelectItem key={material.id} value={material.id}>
                          {material.title || material.file_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              
              {/* Chapter filter */}
              {chapters.length > 0 && (
                <div className="flex items-center gap-2">
                  <Label className="text-sm text-muted-foreground whitespace-nowrap">Chapter:</Label>
                  <Select 
                    value={filterChapterId || "all"} 
                    onValueChange={(val) => setFilterChapterId(val === "all" ? null : val)}
                  >
                    <SelectTrigger className="w-[250px]">
                      <SelectValue placeholder="All chapters" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All chapters</SelectItem>
                      {chapters.map((chapter) => (
                        <SelectItem key={chapter.id} value={chapter.id}>
                          Ch. {chapter.chapter_number}: {chapter.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              
              {(filterChapterId || filterMaterialId) && (
                <Badge variant="secondary" className="text-xs">
                  {filteredCompetencies.length} of {competencies.length}
                </Badge>
              )}
            </div>
          )}

          {loadError && competencies.length === 0 ? (
            <div className="text-center py-8" data-testid="competencies-load-error">
              <AlertTriangle className="h-10 w-10 mx-auto mb-4 text-amber-500" />
              <p className="font-medium">Couldn&apos;t load this course&apos;s competencies.</p>
              <p className="text-sm text-muted-foreground mt-1">
                This is a loading failure, not an empty course &mdash; nothing has been
                changed.
              </p>
              <Button variant="outline" className="mt-4" onClick={fetchData}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Try again
              </Button>
            </div>
          ) : competencies.length === 0 ? (
            /*
              An empty competency set is not a neutral state: quizzes, study
              guides and every per-competency analytic have nothing to map
              answers onto. Say what competencies are for and what to do next,
              rather than just reporting the emptiness.
            */
            <div
              className="max-w-2xl mx-auto text-center py-8"
              data-testid="competencies-empty-state"
            >
              <BookOpen className="h-12 w-12 mx-auto mb-4 opacity-50 text-muted-foreground" />
              <p className="font-medium">This course has no competencies yet.</p>
              <p className="text-sm text-muted-foreground mt-2">
                Competencies are the skills and knowledge students are expected to
                master in this course. Questions, study guides and analytics are
                scored against them &mdash; until you add some, this course&apos;s
                per-competency progress and class reports stay empty.
              </p>
              <div className="text-sm text-muted-foreground mt-4 text-left inline-block">
                <p className="font-medium text-foreground mb-1">Two ways to add them:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>
                    Pick a textbook above and click <strong>Extract</strong> to have AI
                    propose competencies from its chapters &mdash; then edit what it
                    suggests.
                  </li>
                  <li>
                    Click <strong>Add</strong> to write one yourself and link it to the
                    chapters it covers.
                  </li>
                </ul>
              </div>
              <div className="mt-6">
                <Button onClick={addCompetency}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add your first competency
                </Button>
              </div>
            </div>
          ) : filteredCompetencies.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <BookOpen className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No competencies found for this chapter.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredCompetencies.map((comp) => {
                const index = competencies.findIndex(c => c === comp);
                return (
                <div
                  key={comp.id || `new-${index}`}
                  className={`border rounded-lg p-4 ${comp.id?.startsWith('temp-') ? 'border-primary/50 bg-primary/5' : ''}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex items-center gap-1 text-muted-foreground pt-1">
                      <GripVertical className="h-4 w-4" />
                      <span className="text-sm font-medium">{index + 1}</span>
                    </div>

                    <div className="flex-1 space-y-2">
                      {comp.isEditing ? (
                        <>
                          <Input
                            placeholder="Competency title"
                            value={comp.title}
                            onChange={(e) => updateCompetency(index, 'title', e.target.value)}
                            className="font-medium"
                          />
                          <Textarea
                            placeholder="Description of what students will be able to do..."
                            value={comp.description}
                            onChange={(e) => updateCompetency(index, 'description', e.target.value)}
                            rows={2}
                          />
                          {chapters.length > 0 && (
                            <div className="space-y-2 pt-2">
                              <Label className="text-sm text-muted-foreground">Related Chapters</Label>
                              <div className="grid gap-2 max-h-32 overflow-y-auto p-2 border rounded-md bg-muted/30">
                                {chapters.map((chapter) => (
                                  <div key={chapter.id} className="flex items-center space-x-2">
                                    <Checkbox
                                      id={`comp-${index}-chapter-${chapter.id}`}
                                      checked={(comp.chapterIds || (comp.chapterId ? [comp.chapterId] : [])).includes(chapter.id)}
                                      onCheckedChange={() => toggleChapterForCompetency(index, chapter.id)}
                                    />
                                    <label
                                      htmlFor={`comp-${index}-chapter-${chapter.id}`}
                                      className="text-sm cursor-pointer"
                                    >
                                      Ch. {chapter.chapter_number}: {chapter.title}
                                    </label>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{comp.title || 'Untitled'}</span>
                            {comp.materialId && (
                              <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                                {materials.find(m => m.id === comp.materialId)?.title || 
                                 materials.find(m => m.id === comp.materialId)?.file_name || 
                                 'Textbook'}
                              </Badge>
                            )}
                            {(comp.chapterIds && comp.chapterIds.length > 0 ? comp.chapterIds : (comp.chapterId ? [comp.chapterId] : [])).map(chId => {
                              const chapter = chapters.find(c => c.id === chId);
                              return chapter ? (
                                <Badge key={chId} variant="secondary" className="text-xs">
                                  {chapter.title}
                                </Badge>
                              ) : null;
                            })}
                            {comp.id?.startsWith('temp-') && (
                              <Badge variant="outline" className="text-xs text-primary">
                                Unsaved
                              </Badge>
                            )}
                          </div>
                          {comp.description && (
                            <p className="text-sm text-muted-foreground">{comp.description}</p>
                          )}
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      {comp.isEditing ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => toggleEdit(index)}
                            disabled={comp.isSaving}
                            className="h-8 w-8"
                            aria-label="Save competency"
                          >
                            {comp.isSaving ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Check className="h-4 w-4 text-green-600" />
                            )}
                          </Button>
                          {/* Show cancel button only for new unsaved competencies */}
                          {comp.id?.startsWith('temp-') && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => cancelNewCompetency(comp.id!)}
                              disabled={comp.isSaving}
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              aria-label="Discard competency"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          )}
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => toggleEdit(index)}
                          className="h-8 w-8"
                          aria-label="Edit competency"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteCompetency(index)}
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        aria-label="Delete competency"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>

    <AlertDialog
      open={deleteConfirm !== null}
      onOpenChange={(open) => {
        if (!open && !deleteConfirmBusy) setDeleteConfirm(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete competency with recorded scores?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteConfirm && (
              <>
                <strong>{deleteConfirm.comp.title || 'This competency'}</strong> has{' '}
                {deleteConfirm.scoresCount} recorded student evaluation{' '}
                {deleteConfirm.scoresCount === 1 ? 'score' : 'scores'}. Deleting it will
                permanently remove those scores from past evaluations. This cannot be undone.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteConfirmBusy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              confirmDeleteWithScores();
            }}
            disabled={deleteConfirmBusy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleteConfirmBusy ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Deleting...
              </>
            ) : (
              'Delete competency and scores'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
