import { useState, useEffect, useMemo, useCallback } from "react";
import { useContentAssignments } from "@/hooks/useContentAssignments";
import { ContentAssignDialog } from "./ContentAssignDialog";
import { AssignedClassesBadges } from "./AssignedClassesBadges";
import type { CourseClass } from "@/types/content-assignments";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RichTextEditor } from "@/components/RichTextEditor";
import { toast } from "sonner";
import { MODERATION_APPROVED } from "@/lib/material-moderation";
import { Plus, Trash2, Loader2, Eye, EyeOff, GraduationCap, Sparkles, BookOpen, MessageSquare, CheckCircle2, HelpCircle, Pencil, ImagePlus, X, Youtube, Image, Check, ChevronDown, ChevronRight, AlertCircle, FileText, AlertTriangle, Users, User } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useFormatters } from "@/i18n/formatters";
import { fetchAuthorNames } from "@/lib/author-names";
import {
  fetchWholeDocumentMaterials,
  type WholeDocumentMaterial,
} from "@/lib/whole-document-materials";

// Limits for chapter selection
const MAX_PAGES = 400;
const MAX_SIZE_BYTES = 32 * 1024 * 1024; // 32MB

// Ceiling on what "Suggest New Sessions with AI" will create from one chapter. The edge
// function enforces the same cap on its own output; this constant only drives
// the copy the instructor reads, so the two are stated in the same terms.
const MAX_AI_SUGGESTIONS = 3;

interface Material {
  id: string;
  title: string | null;
  file_name: string;
  file_size: number | null;
  page_count: number | null;
}

interface ApprovedImage {
  id: string;
  title: string | null;
  file_name: string;
  file_url: string;
}

interface ChapterWithMaterial {
  id: string;
  title: string;
  chapter_number: number;
  content_type: string;
  content: string | null;
  file_name: string | null;
  material_id: string;
  material_title: string;
  chapter_page_count: number;
  chapter_size_bytes: number;
}

interface ReferenceImage {
  url: string;
  storagePath?: string; // Permanent storage path (file_url from course_materials)
  imageId?: string; // ID of the approved image from course_materials
  name: string;
  isApproved?: boolean;
}

interface StudySession {
  id: string;
  title: string;
  topic: string | null;
  material_id: string | null;
  chapter_id: string | null;
  chapter_ids: string[] | null;
  page_start: number | null;
  page_end: number | null;
  extracted_content: string | null;
  llm_status: string | null;
  llm_message: string | null;
  instructions: string | null;
  student_notes: string | null;
  reference_images: ReferenceImage[] | null;
  status: string;
  created_at: string;
  created_by: string | null;
}

interface LLMSummaryResponse {
  status: "success" | "fail";
  message: string;
  summary: string;
}

interface SuggestedSession {
  title: string;
  topic: string;
  instructions: string;
}

interface StudySessionManagerProps {
  courseId: string;
  classes?: CourseClass[];
}

export function StudySessionManager({ courseId, classes = [] }: StudySessionManagerProps) {
  const { formatDate, formatNumber } = useFormatters();
  const [sessions, setSessions] = useState<StudySession[]>([]);
  // `study_sessions.created_by` has no FK to `profiles`, so PostgREST cannot
  // embed the author — the names are resolved in a second query.
  const [authorNames, setAuthorNames] = useState<Record<string, string>>({});
  const [materials, setMaterials] = useState<Material[]>([]);
  const [allChapters, setAllChapters] = useState<ChapterWithMaterial[]>([]);
  // "Other" materials (#1019) are never split, so a session grounded in one
  // takes the whole document instead of a set of chapters.
  const [wholeDocs, setWholeDocs] = useState<WholeDocumentMaterial[]>([]);
  const [approvedImages, setApprovedImages] = useState<ApprovedImage[]>([]);
  const [approvedImageUrls, setApprovedImageUrls] = useState<Record<string, string>>({});
  const [hasOtherMaterials, setHasOtherMaterials] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedSummaries, setExpandedSummaries] = useState<Set<string>>(new Set());
  const [expandedMaterials, setExpandedMaterials] = useState<Set<string>>(new Set());

  const toggleSummaryExpanded = (sessionId: string) => {
    setExpandedSummaries(prev => {
      const newSet = new Set(prev);
      if (newSet.has(sessionId)) {
        newSet.delete(sessionId);
      } else {
        newSet.add(sessionId);
      }
      return newSet;
    });
  };

  const toggleMaterialExpanded = (materialId: string) => {
    setExpandedMaterials(prev => {
      const newSet = new Set(prev);
      if (newSet.has(materialId)) {
        newSet.delete(materialId);
      } else {
        newSet.add(materialId);
      }
      return newSet;
    });
  };

  // Content assignment
  const sessionIds = useMemo(() => sessions.map(s => s.id), [sessions]);
  const contentAssignments = useContentAssignments('study_session', sessionIds, classes);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignTargetId, setAssignTargetId] = useState<string | null>(null);

  // "Not assigned" is a claim about the database, so only make it when the
  // assignment fetch has actually answered. An empty target list also means
  // "still loading", "the query failed", or "this course has no classes, so
  // nothing could be assigned in the first place" — warning in any of those
  // would push instructors to re-assign content that is already assigned.
  const assignmentStateKnown =
    classes.length > 0 && !contentAssignments.loading && !contentAssignments.error;

  const handleOpenAssignDialog = useCallback((sessionId: string) => {
    setAssignTargetId(sessionId);
    setAssignDialogOpen(true);
  }, []);

  // Drafts and ready sessions are listed separately so a draft is never
  // mistaken for something students can already open. Both lists read
  // newest-first regardless of how the rows arrived in state — an in-place
  // status toggle must not shuffle a card out of date order.
  const sessionGroups = useMemo(() => {
    const byNewest = [...sessions].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return [
      {
        key: "ready",
        label: "Ready",
        hint: "Visible to the students they are assigned to",
        emptyText: "No sessions are available to students yet.",
        sessions: byNewest.filter(s => s.status === "ready"),
      },
      {
        key: "draft",
        label: "Drafts",
        hint: "Hidden from students until made available",
        emptyText: "No drafts.",
        sessions: byNewest.filter(s => s.status !== "ready"),
      },
    ];
  }, [sessions]);

  const handleSaveAssign = useCallback(async (selection: Set<string> | import("@/types/content-assignments").AssignSelection) => {
    if (assignTargetId) {
      await contentAssignments.saveAssignments([assignTargetId], selection, false);
    }
    setAssignDialogOpen(false);
  }, [contentAssignments, assignTargetId]);

  // Edit state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<StudySession | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editTopic, setEditTopic] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [editReferenceImages, setEditReferenceImages] = useState<ReferenceImage[]>([]);
  const [editRefImageUrls, setEditRefImageUrls] = useState<Record<number, string>>({}); // Refreshed URLs for edit dialog
  const [editStudentNotes, setEditStudentNotes] = useState("");
  const [saving, setSaving] = useState(false);
  
  // Refreshed URLs cache for reference images in lists (session display)
  const [refImageUrlCache, setRefImageUrlCache] = useState<Record<string, string>>({});

  // Form state
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([]);
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([]);
  
  const [instructions, setInstructions] = useState("");
  const [studentNotes, setStudentNotes] = useState("");
  
  // Reference images state
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
  // uploadingImage state removed - only selecting from approved images now
  const [startAsDraft, setStartAsDraft] = useState(false);

  // LLM response state for inline display
  const [llmSummaryResponse, setLlmSummaryResponse] = useState<LLMSummaryResponse | null>(null);
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  // AI suggestions state
  const [suggestDialogOpen, setSuggestDialogOpen] = useState(false);
  const [suggestChapterId, setSuggestChapterId] = useState<string>("");
  const [suggesting, setSuggesting] = useState(false);
  // What the instructor is waiting on. Suggesting runs two AI calls back to
  // back and can take a while, so the button says which one is in flight
  // rather than spinning silently for a minute.
  const [suggestStage, setSuggestStage] = useState<"idle" | "proposing" | "summarizing">("idle");

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId change
  }, [courseId]);

  // Helper functions for selection limits
  const getSelectionTotals = (chapterIds: string[], materialIds: string[] = selectedMaterialIds) => {
    let totalPages = 0;
    let totalSize = 0;
    allChapters.forEach((ch) => {
      if (!chapterIds.includes(ch.id)) return;
      totalPages += ch.chapter_page_count || 0;
      totalSize += ch.chapter_size_bytes || 0;
    });
    // A whole document counts as itself: the entire file is sent for
    // summarisation, so it is held to the same budget as the chapters.
    wholeDocs.forEach((doc) => {
      if (!materialIds.includes(doc.id)) return;
      totalPages += doc.page_count || 0;
      totalSize += doc.file_size || 0;
    });
    return { totalPages, totalSize };
  };

  const wouldExceedLimits = (chapterId: string) => {
    const chapter = allChapters.find((ch) => ch.id === chapterId);
    if (!chapter) return false;
    const { totalPages, totalSize } = getSelectionTotals(selectedChapterIds);
    const newPages = totalPages + (chapter.chapter_page_count || 0);
    const newSize = totalSize + (chapter.chapter_size_bytes || 0);
    return newPages > MAX_PAGES || newSize > MAX_SIZE_BYTES;
  };

  /**
   * Measured alone, not added to the chapter selection: picking a document
   * replaces whatever was selected, so it is only ever the sole source.
   */
  const materialWouldExceedLimits = (materialId: string) => {
    const doc = wholeDocs.find((m) => m.id === materialId);
    if (!doc) return false;
    return (doc.page_count || 0) > MAX_PAGES || (doc.file_size || 0) > MAX_SIZE_BYTES;
  };

  /**
   * A session is grounded in EITHER chapters OR one whole document — never a
   * mixture, and never several documents.
   *
   * Not a UI preference: `study_sessions` records provenance as one
   * `material_id` plus a `chapter_ids` array. There is no column that can name
   * a second document, so any selection this refuses is one the row would go on
   * to misreport — a two-document session displaying only the first, or a mixed
   * one showing its chapters and hiding the document entirely. The study-guide
   * dialog draws the same line for the same reason.
   *
   * The grounding itself is unaffected: whatever is selected is summarised in
   * full, and that summary is what the tutor reads.
   */
  const toggleWholeDocSelection = (materialId: string) => {
    if (selectedMaterialIds.includes(materialId)) {
      setSelectedMaterialIds([]);
      return;
    }
    if (materialWouldExceedLimits(materialId)) {
      toast.error("Cannot select: would exceed 400 pages or 32MB limit");
      return;
    }
    setSelectedMaterialIds([materialId]);
    setSelectedChapterIds([]);
  };

  const toggleChapterSelection = (chapterId: string) => {
    if (selectedChapterIds.includes(chapterId)) {
      setSelectedChapterIds(prev => prev.filter(id => id !== chapterId));
    } else {
      if (wouldExceedLimits(chapterId)) {
        toast.error("Cannot select: would exceed 400 pages or 32MB limit");
        return;
      }
      setSelectedChapterIds(prev => [...prev, chapterId]);
      setSelectedMaterialIds([]);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const [sessionsRes, materialsRes, approvedImagesRes, otherMaterialsRes, wholeDocsRes] = await Promise.all([
        supabase
          .from("study_sessions")
          .select("*")
          .eq("course_id", courseId)
          .order("created_at", { ascending: false }),
        supabase
          .from("course_materials")
          .select("id, title, file_name, file_size, page_count")
          .eq("course_id", courseId)
          .eq("material_type", "textbook"),
        supabase
          .from("course_materials")
          .select("id, title, file_name, file_url")
          .eq("course_id", courseId)
          .eq("material_type", "images")
          // `is_moderated` only means moderation has RUN — it is true for a
          // rejected image too, which is how rejected images used to reach
          // students. The outcome lives in `moderation_status`.
          .eq("moderation_status", MODERATION_APPROVED),
        supabase
          .from("course_materials")
          .select("id", { count: "exact", head: true })
          .eq("course_id", courseId)
          .neq("material_type", "textbook")
          .neq("material_type", "images")
          // "Other" materials are counted separately, as `wholeDocs`. Only the
          // create dialog can use them — "Suggest New Sessions with AI" still works from a
          // single chapter — so folding them in here would tell the suggest
          // dialog it has material it cannot reach (#1019).
          .neq("material_type", "other"),
        fetchWholeDocumentMaterials(courseId),
      ]);

      if (sessionsRes.error) throw sessionsRes.error;
      if (materialsRes.error) throw materialsRes.error;
      if (approvedImagesRes.error) throw approvedImagesRes.error;
      if (otherMaterialsRes.error) throw otherMaterialsRes.error;
      setHasOtherMaterials((otherMaterialsRes.count ?? 0) > 0);

      // Fetch signed URLs for approved images
      const imageUrls: Record<string, string> = {};
      for (const img of approvedImagesRes.data || []) {
        const { data: signedUrlData } = await supabase.storage
          .from("course-materials")
          .createSignedUrl(img.file_url, 2592000);
        if (signedUrlData?.signedUrl) {
          imageUrls[img.id] = signedUrlData.signedUrl;
        }
      }
      setApprovedImages(approvedImagesRes.data || []);
      setApprovedImageUrls(imageUrls);
      setWholeDocs(wholeDocsRes);

      // Map sessions to StudySession format
      const mappedSessions: StudySession[] = (sessionsRes.data || []).map(s => ({
        ...s,
        reference_images: (s.reference_images as unknown as ReferenceImage[] | null) || null,
        chapter_ids: s.chapter_ids || null,
      }));

      setSessions(mappedSessions);
      setAuthorNames(await fetchAuthorNames(mappedSessions.map(s => s.created_by)));
      setMaterials(materialsRes.data || []);

      // Fetch all chapters for all materials
      if (materialsRes.data && materialsRes.data.length > 0) {
        await fetchAllChapters(materialsRes.data);
      }
    } catch (error: any) {
      toast.error(error.message || "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  const fetchAllChapters = async (mats: Material[]) => {
    try {
      const materialIds = mats.map(m => m.id);
      const materialMap = new Map(mats.map(m => [m.id, m]));

      const { data: chaptersData, error } = await supabase
        .from("material_chapters")
        .select("id, title, chapter_number, content_type, content, file_name, material_id")
        .in("material_id", materialIds)
        .order("chapter_number").order("id");

      if (error) throw error;

      // Calculate page counts and sizes for each chapter
      const chaptersWithMaterial: ChapterWithMaterial[] = (chaptersData || []).map(ch => {
        const material = materialMap.get(ch.material_id);
        
        // Estimate page count from file_name (e.g., "Pages 12-24") or content length
        let chapterPageCount = 0;
        let chapterSizeBytes = 0;
        
        if (ch.file_name) {
          const pageMatch = ch.file_name.match(/Pages?\s*(\d+)\s*-\s*(\d+)/i);
          if (pageMatch) {
            chapterPageCount = parseInt(pageMatch[2]) - parseInt(pageMatch[1]) + 1;
          }
        }
        
        // If no page count from file_name, estimate from content
        if (chapterPageCount === 0 && ch.content) {
          // Rough estimate: ~3000 chars per page
          chapterPageCount = Math.max(1, Math.ceil(ch.content.length / 3000));
          chapterSizeBytes = ch.content.length;
        } else if (ch.file_name && material?.file_size && material?.page_count) {
          // Estimate size based on proportion of material
          const avgPageSize = material.file_size / material.page_count;
          chapterSizeBytes = Math.round(avgPageSize * chapterPageCount);
        }

        // Fallback: if still no page count, assume 10 pages
        if (chapterPageCount === 0) {
          chapterPageCount = 10;
          if (material?.file_size && material?.page_count) {
            chapterSizeBytes = Math.round((material.file_size / material.page_count) * 10);
          }
        }

        return {
          id: ch.id,
          title: ch.title,
          chapter_number: ch.chapter_number,
          content_type: ch.content_type,
          content: ch.content,
          file_name: ch.file_name,
          material_id: ch.material_id,
          material_title: material?.title || material?.file_name || "Unknown Material",
          chapter_page_count: chapterPageCount,
          chapter_size_bytes: chapterSizeBytes,
        };
      });

      setAllChapters(chaptersWithMaterial);
    } catch (error: any) {
      console.error("Error fetching chapters:", error);
    }
  };

  const handleCreate = async () => {
    if (!title.trim()) {
      toast.error("Please enter a title");
      return;
    }
    if (!topic.trim()) {
      toast.error("Please enter an objective");
      return;
    }
    if (selectedChapterIds.length === 0 && selectedMaterialIds.length === 0) {
      toast.error("Please select at least one chapter or document");
      return;
    }

    setCreating(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();

      // Get course language for moderation
      let courseLang = "English";
      const { data: courseData } = await supabase
        .from("courses")
        .select("language")
        .eq("id", courseId)
        .single();
      if (courseData?.language) {
        courseLang = courseData.language;
      }

      // All reference images come from pre-approved course materials - no moderation needed
      
      // Generate chapter summary synchronously before creating the session
      let llmResponse: LLMSummaryResponse | null = null;
      
      const { data: summaryData, error: summaryError } = await supabase.functions.invoke("generate-chapter-summary", {
        body: {
          chapterIds: selectedChapterIds,
          materialIds: selectedMaterialIds,
          courseId: courseId,
          studentNotes: studentNotes.trim() || "",
        },
      });

      if (summaryError) {
        console.error("Failed to generate chapter summary:", summaryError);
        llmResponse = {
          status: "fail",
          message: "Failed to generate chapter summary: " + (summaryError.message || "Unknown error"),
          summary: ""
        };
      } else if (summaryData?.llmResponse) {
        llmResponse = summaryData.llmResponse as LLMSummaryResponse;
      }
      
      // Update React state for dialog display
      setLlmSummaryResponse(llmResponse);

      // Get material_id from first selected chapter, or from the whole
      // document when the session is grounded in one of those instead — a
      // chapterless source leaves both chapter columns null (#1019).
      const firstChapter = allChapters.find(ch => ch.id === selectedChapterIds[0]);

      const insertData: any = {
        course_id: courseId,
        title: title.trim(),
        topic: topic.trim() || null,
        material_id: firstChapter?.material_id || selectedMaterialIds[0] || null,
        chapter_id: selectedChapterIds[0] ?? null, // Keep for backward compatibility
        chapter_ids: selectedChapterIds.length > 0 ? selectedChapterIds : null,
        page_start: null,
        page_end: null,
        extracted_content: llmResponse?.status === "success" ? llmResponse.summary : null,
        llm_status: llmResponse?.status || null,
        llm_message: llmResponse?.message || null,
        instructions: instructions.trim() || null,
        student_notes: studentNotes.trim() || null,
        reference_images: referenceImages.length > 0 ? referenceImages : null,
        status: startAsDraft ? 'draft' : 'ready',
        created_by: user?.id,
      };
      
      const { data: newSession, error } = await supabase
        .from("study_sessions")
        .insert(insertData)
        .select()
        .single();

      if (error) throw error;

      toast.success("Tutoring session created");
      setDialogOpen(false);
      resetForm();
      fetchData();
    } catch (error: any) {
      toast.error(error.message || "Failed to create session");
    } finally {
      setCreating(false);
    }
  };

  /**
   * Ask the AI to propose sessions for one chapter and create them as drafts.
   *
   * Drafts, not "ready": nothing here has been read by a human yet, and draft
   * is the review gate this component already has. The instructor edits or
   * deletes what the model got wrong and flips the rest to Ready.
   *
   * The grounding summary is generated ONCE for the chapter and shared by every
   * session created from it. All three teach the same chapter, so a summary per
   * session would be the same expensive call repeated — the sessions differ in
   * their objective and tutor instructions, which is what the model varies.
   */
  const handleSuggestSessions = async () => {
    if (!suggestChapterId) {
      toast.error("Please select a chapter");
      return;
    }

    const chapter = allChapters.find(ch => ch.id === suggestChapterId);
    if (!chapter) {
      toast.error("Chapter not found");
      return;
    }

    setSuggesting(true);
    setSuggestStage("proposing");
    try {
      const { data: { user } } = await supabase.auth.getUser();

      const { data: suggestData, error: suggestError } = await supabase.functions.invoke(
        "suggest-tutoring-sessions",
        { body: { chapterId: suggestChapterId } },
      );

      if (suggestError) throw suggestError;

      const suggestions: SuggestedSession[] = suggestData?.sessions || [];
      if (suggestions.length === 0) {
        toast.error(suggestData?.message || "The AI could not suggest sessions for this chapter");
        return;
      }

      // Grounding summary for the chapter — one call, reused by every draft.
      setSuggestStage("summarizing");
      let llmResponse: LLMSummaryResponse | null = null;
      const { data: summaryData, error: summaryError } = await supabase.functions.invoke(
        "generate-chapter-summary",
        { body: { chapterIds: [suggestChapterId], courseId } },
      );

      if (summaryError) {
        console.error("Failed to generate chapter summary:", summaryError);
        llmResponse = {
          status: "fail",
          message: "Failed to generate chapter summary: " + (summaryError.message || "Unknown error"),
          summary: "",
        };
      } else if (summaryData?.llmResponse) {
        llmResponse = summaryData.llmResponse as LLMSummaryResponse;
      }

      const rows = suggestions.map(s => ({
        course_id: courseId,
        title: s.title,
        topic: s.topic || null,
        material_id: chapter.material_id,
        chapter_id: suggestChapterId,
        chapter_ids: [suggestChapterId],
        page_start: null,
        page_end: null,
        extracted_content: llmResponse?.status === "success" ? llmResponse.summary : null,
        llm_status: llmResponse?.status || null,
        llm_message: llmResponse?.message || null,
        instructions: s.instructions || null,
        student_notes: null,
        reference_images: null,
        status: "draft",
        created_by: user?.id,
      }));

      const { error: insertError } = await supabase.from("study_sessions").insert(rows);
      if (insertError) throw insertError;

      toast.success(
        `${rows.length} draft ${rows.length === 1 ? "session" : "sessions"} created — review and set them to Ready`,
      );
      setSuggestDialogOpen(false);
      setSuggestChapterId("");
      fetchData();
    } catch (error: any) {
      toast.error(error.message || "Failed to suggest sessions");
    } finally {
      setSuggesting(false);
      setSuggestStage("idle");
    }
  };

  const toggleStatus = async (session: StudySession) => {
    const nextStatus = session.status === 'draft' ? 'ready' : 'draft';

    try {
      const { error } = await supabase
        .from("study_sessions")
        .update({ status: nextStatus })
        .eq("id", session.id);

      if (error) throw error;

      setSessions(sessions.map(s =>
        s.id === session.id ? { ...s, status: nextStatus } : s
      ));
      toast.success(`Session set to ${nextStatus === 'ready' ? 'Ready' : 'Draft'}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to update session");
    }
  };

  const deleteSession = async (id: string) => {
    if (!confirm("Are you sure you want to delete this tutoring session?")) return;

    try {
      const { error } = await supabase
        .from("study_sessions")
        .delete()
        .eq("id", id);

      if (error) throw error;

      setSessions(sessions.filter(s => s.id !== id));
      toast.success("Session deleted");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete session");
    }
  };

  const openEditSession = async (session: StudySession) => {
    setEditingSession(session);
    setEditTitle(session.title);
    setEditTopic(session.topic || "");
    setEditInstructions(session.instructions || "");
    setEditStudentNotes(session.student_notes || "");
    setEditReferenceImages(session.reference_images || []);
    setEditDialogOpen(true);
    
    // Refresh URLs for existing reference images that have storagePath
    const refImages = session.reference_images || [];
    const refreshedUrls: Record<number, string> = {};
    for (let i = 0; i < refImages.length; i++) {
      const img = refImages[i];
      if (img.storagePath) {
        const { data } = await supabase.storage
          .from("course-materials")
          .createSignedUrl(img.storagePath, 2592000);
        if (data?.signedUrl) {
          refreshedUrls[i] = data.signedUrl;
        }
      }
    }
    setEditRefImageUrls(refreshedUrls);
  };

  const saveSession = async () => {
    if (!editingSession) return;
    if (!editTitle.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!editTopic.trim()) {
      toast.error("Please enter an objective");
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase
        .from("study_sessions")
        .update({ 
          title: editTitle.trim(),
          topic: editTopic.trim() || null,
          instructions: editInstructions.trim() || null,
          student_notes: editStudentNotes.trim() || null,
          reference_images: editReferenceImages.length > 0 ? JSON.parse(JSON.stringify(editReferenceImages)) : null,
        })
        .eq("id", editingSession.id);

      if (error) throw error;

      setSessions(sessions.map(s => 
        s.id === editingSession.id ? { 
          ...s, 
          title: editTitle.trim(),
          topic: editTopic.trim() || null,
          instructions: editInstructions.trim() || null,
          student_notes: editStudentNotes.trim() || null,
          reference_images: editReferenceImages.length > 0 ? editReferenceImages : null,
        } : s
      ));
      toast.success("Session updated");
      setEditDialogOpen(false);
      setEditingSession(null);
    } catch (error: any) {
      toast.error(error.message || "Failed to update session");
    } finally {
      setSaving(false);
    }
  };

  // handleEditImageUpload removed - only selecting from approved images now

  const removeEditImage = (index: number) => {
    setEditReferenceImages(prev => prev.filter((_, i) => i !== index));
    // Reindex the URL cache after removal
    setEditRefImageUrls(prev => {
      const newCache: Record<number, string> = {};
      Object.keys(prev).forEach(key => {
        const idx = parseInt(key);
        if (idx < index) {
          newCache[idx] = prev[idx];
        } else if (idx > index) {
          newCache[idx - 1] = prev[idx];
        }
        // Skip the removed index
      });
      return newCache;
    });
  };

  const resetForm = () => {
    setTitle("");
    setTopic("");
    setSelectedChapterIds([]);
    setSelectedMaterialIds([]);
    setInstructions("");
    setStudentNotes("");
    setReferenceImages([]);
    setStartAsDraft(false);
    setLlmSummaryResponse(null);
    setSummaryExpanded(false);
    setExpandedMaterials(new Set());
  };

  // handleImageUpload removed - only selecting from approved images now

  const removeImage = (index: number) => {
    setReferenceImages(prev => prev.filter((_, i) => i !== index));
  };

  const addApprovedImageToReferences = (image: ApprovedImage) => {
    const imageUrl = approvedImageUrls[image.id];
    if (!imageUrl) {
      toast.error("Image URL not available");
      return;
    }
    // Check if already added by imageId or storagePath
    if (referenceImages.some(img => img.imageId === image.id || img.storagePath === image.file_url)) {
      toast.error("This image is already added");
      return;
    }
    setReferenceImages(prev => [...prev, {
      url: imageUrl,
      storagePath: image.file_url, // Store permanent storage path
      imageId: image.id, // Store reference to the approved image
      name: image.title || image.file_name,
      isApproved: true
    }]);
    toast.success("Image added");
  };

  const addApprovedImageToEditReferences = (image: ApprovedImage) => {
    const imageUrl = approvedImageUrls[image.id];
    if (!imageUrl) {
      toast.error("Image URL not available");
      return;
    }
    // Check if already added by imageId or storagePath
    if (editReferenceImages.some(img => img.imageId === image.id || img.storagePath === image.file_url)) {
      toast.error("This image is already added");
      return;
    }
    const newIndex = editReferenceImages.length;
    setEditReferenceImages(prev => [...prev, {
      url: imageUrl,
      storagePath: image.file_url, // Store permanent storage path
      imageId: image.id, // Store reference to the approved image
      name: image.title || image.file_name,
      isApproved: true
    }]);
    // Update the URL cache for the new image
    setEditRefImageUrls(prev => ({ ...prev, [newIndex]: imageUrl }));
    toast.success("Image added");
  };

  // Helper to get display URL for a reference image (handles both old signed URLs and new storagePath)
  const getImageDisplayUrl = async (img: ReferenceImage): Promise<string> => {
    // If we have a storagePath, generate a fresh signed URL
    if (img.storagePath) {
      const { data } = await supabase.storage
        .from("course-materials")
        .createSignedUrl(img.storagePath, 2592000);
      return data?.signedUrl || img.url;
    }
    // Fallback to stored URL (for legacy data)
    return img.url;
  };

  // Group chapters by material
  const chaptersByMaterial = materials.map(mat => ({
    material: mat,
    chapters: allChapters.filter(ch => ch.material_id === mat.id)
  })).filter(group => group.chapters.length > 0);

  // Get selected chapters info for display
  const getSelectedChaptersDisplay = () => {
    const selected = allChapters.filter(ch => selectedChapterIds.includes(ch.id));
    if (selected.length === 0) return null;
    
    return selected.map(ch => `Ch ${ch.chapter_number}`).join(", ");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { totalPages, totalSize } = getSelectionTotals(selectedChapterIds);
  // "Suggest New Sessions with AI" still works from a single chapter, so it needs a split
  // textbook. Creating a session by hand only needs something to ground the
  // tutor in — which a chapterless "Other" document now is (#1019).
  const hasTextbookWithChapters = allChapters.length > 0;
  const hasAnySource = hasTextbookWithChapters || wholeDocs.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Tutoring Sessions</h3>
          <p className="text-sm text-muted-foreground">
            Create interactive tutoring sessions for students
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Dialog
            open={suggestDialogOpen}
            onOpenChange={(open) => { if (!suggesting) setSuggestDialogOpen(open); }}
          >
            <DialogTrigger asChild>
              <Button
                variant="outline"
                onClick={() => { setSuggestChapterId(""); setSuggestDialogOpen(true); }}
                disabled={!hasTextbookWithChapters}
                title={!hasTextbookWithChapters ? "Upload a textbook under Course Materials to suggest sessions" : undefined}
              >
                <Sparkles className="w-4 h-4 mr-2" />
                Suggest New Sessions with AI
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Suggest Tutoring Sessions</DialogTitle>
                <DialogDescription>
                  Pick a chapter and the AI will draft up to {MAX_AI_SUGGESTIONS} tutoring
                  sessions covering it. They are created as drafts, so nothing reaches
                  students until you review them and set them to Ready.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                {materials.length === 0 && hasOtherMaterials && (
                  <Alert className="border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    <AlertTriangle className="h-4 w-4 !text-amber-600 dark:!text-amber-400" />
                    <AlertDescription>
                      No textbook material found for this course. AI generation will use supplementary materials only (teacher companion, exercises), which may affect output quality.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label>Chapter *</Label>
                  {chaptersByMaterial.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      No textbooks with chapters available. Please upload materials first.
                    </p>
                  ) : (
                    <ScrollArea className="h-64 rounded-md border">
                      <RadioGroup
                        value={suggestChapterId}
                        onValueChange={setSuggestChapterId}
                        className="p-2 gap-0"
                      >
                        {chaptersByMaterial.map(({ material, chapters }) => (
                          <div key={material.id} className="py-1">
                            <p className="px-2 py-1 text-xs font-medium text-muted-foreground truncate">
                              {material.title || material.file_name}
                            </p>
                            {chapters.map((chapter) => (
                              <div
                                key={chapter.id}
                                className="flex items-center gap-3 p-2 rounded hover:bg-muted/50"
                              >
                                <RadioGroupItem
                                  value={chapter.id}
                                  id={`suggest-chapter-${chapter.id}`}
                                />
                                <label
                                  htmlFor={`suggest-chapter-${chapter.id}`}
                                  className="flex-1 cursor-pointer text-sm"
                                >
                                  <span className="font-medium">Ch {chapter.chapter_number}:</span>{" "}
                                  <span className="text-muted-foreground">{chapter.title}</span>
                                </label>
                              </div>
                            ))}
                          </div>
                        ))}
                      </RadioGroup>
                    </ScrollArea>
                  )}
                </div>

                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setSuggestDialogOpen(false)}
                    disabled={suggesting}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleSuggestSessions}
                    disabled={suggesting || !suggestChapterId}
                  >
                    {suggesting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                    {suggestStage === "proposing"
                      ? "Analyzing chapter..."
                      : suggestStage === "summarizing"
                        ? "Preparing sessions..."
                        : "Suggest Sessions"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button
                onClick={() => { resetForm(); setDialogOpen(true); }}
                disabled={!hasAnySource}
                title={!hasAnySource ? "Upload a textbook or an \"Other\" document under Course Materials to create a session" : undefined}
              >
                <Plus className="w-4 h-4 mr-2" />
                Create Session
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create Tutoring Session</DialogTitle>
                <DialogDescription>
                  Define content for an interactive tutoring session
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                {materials.length === 0 && (hasOtherMaterials || wholeDocs.length > 0) && (
                  <Alert className="border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    <AlertTriangle className="h-4 w-4 !text-amber-600 dark:!text-amber-400" />
                    <AlertDescription>
                      No textbook material found for this course. AI generation will use supplementary materials only (teacher companion, exercises, other documents), which may affect output quality.
                    </AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="title">Session Title *</Label>
                  <Input
                    id="title"
                    placeholder="e.g., Introduction to Derivatives"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="topic">Topic / Learning Objective *</Label>
                  <Input
                    id="topic"
                    placeholder="e.g., Understanding basic derivative rules"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                  />
                </div>

                {/* Multi-chapter selection */}
                <div className="border rounded-lg p-4 space-y-4 bg-muted/30">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">Select Source Material *</p>
                      <p className="text-xs text-muted-foreground">
                        {selectedChapterIds.length + selectedMaterialIds.length > 0 ? (
                          <>Selected: {totalPages} pages / {formatBytes(totalSize)} (Max: {MAX_PAGES} pages / {formatBytes(MAX_SIZE_BYTES)})</>
                        ) : (
                          <>Max: {MAX_PAGES} pages / {formatBytes(MAX_SIZE_BYTES)}</>
                        )}
                      </p>
                      {wholeDocs.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Chapters, or one whole document — not both.
                        </p>
                      )}
                    </div>
                    {selectedChapterIds.length + selectedMaterialIds.length > 0 && (
                      <Badge variant="secondary">
                        {selectedChapterIds.length + selectedMaterialIds.length} selected
                      </Badge>
                    )}
                  </div>

                  {chaptersByMaterial.length === 0 && wholeDocs.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No textbooks with chapters available. Please upload materials first.
                    </p>
                  ) : (
                    <ScrollArea className="h-64 rounded-md border">
                      <div className="space-y-2">
                        {chaptersByMaterial.map(({ material, chapters }) => (
                          <Collapsible
                            key={material.id}
                            open={expandedMaterials.has(material.id)}
                            onOpenChange={() => toggleMaterialExpanded(material.id)}
                          >
                            <CollapsibleTrigger asChild>
                              <Button
                                variant="ghost"
                                className="w-full justify-between px-3 py-2 h-auto"
                              >
                                <div className="flex items-center gap-2 text-left">
                                  <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                                  <div>
                                    <p className="text-sm font-medium truncate max-w-[300px]">
                                      {material.title || material.file_name}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      {chapters.length} chapters
                                      {material.page_count && ` • ${material.page_count} pages`}
                                    </p>
                                  </div>
                                </div>
                                {expandedMaterials.has(material.id) ? (
                                  <ChevronDown className="w-4 h-4 shrink-0" />
                                ) : (
                                  <ChevronRight className="w-4 h-4 shrink-0" />
                                )}
                              </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <div className="pl-6 pr-2 py-2 space-y-1">
                                {chapters.map((chapter) => {
                                  const isSelected = selectedChapterIds.includes(chapter.id);
                                  const wouldExceed = !isSelected && wouldExceedLimits(chapter.id);
                                
                                  return (
                                    <div
                                      key={chapter.id}
                                      className={`flex items-center gap-3 p-2 rounded hover:bg-muted/50 ${wouldExceed ? 'opacity-50' : ''}`}
                                    >
                                      <Checkbox
                                        id={`chapter-${chapter.id}`}
                                        checked={isSelected}
                                        onCheckedChange={() => toggleChapterSelection(chapter.id)}
                                        disabled={wouldExceed}
                                      />
                                      <label
                                        htmlFor={`chapter-${chapter.id}`}
                                        className="flex-1 cursor-pointer text-sm"
                                      >
                                        <span className="font-medium">Ch {chapter.chapter_number}:</span>{" "}
                                        <span className="text-muted-foreground">{chapter.title}</span>
                                        <span className="text-xs text-muted-foreground ml-2">
                                          ({chapter.chapter_page_count} pages)
                                        </span>
                                      </label>
                                      {wouldExceed && (
                                        <span className="text-xs text-destructive">exceeds limit</span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        ))}

                        {/* "Other" materials have no chapters, so each one is a
                            single choice: the whole document (#1019). */}
                        {wholeDocs.length > 0 && (
                          <div className="px-3 py-2 space-y-1">
                            <p className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                              <FileText className="w-3.5 h-3.5" />
                              Other documents
                            </p>
                            {wholeDocs.map((doc) => {
                              const isSelected = selectedMaterialIds.includes(doc.id);
                              const wouldExceed = !isSelected && materialWouldExceedLimits(doc.id);
                              return (
                                <div
                                  key={doc.id}
                                  className={`flex items-center gap-3 p-2 rounded hover:bg-muted/50 ${wouldExceed ? 'opacity-50' : ''}`}
                                >
                                  <Checkbox
                                    id={`session-doc-${doc.id}`}
                                    checked={isSelected}
                                    onCheckedChange={() => toggleWholeDocSelection(doc.id)}
                                    disabled={wouldExceed}
                                  />
                                  <label
                                    htmlFor={`session-doc-${doc.id}`}
                                    className="flex-1 cursor-pointer text-sm"
                                  >
                                    <span className="font-medium">{doc.title}</span>
                                    {doc.page_count ? (
                                      <span className="text-xs text-muted-foreground ml-2">
                                        ({doc.page_count} pages)
                                      </span>
                                    ) : null}
                                  </label>
                                  {wouldExceed && (
                                    <span className="text-xs text-destructive">exceeds limit</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </ScrollArea>
                  )}
                </div>

                {/* Special Instructions */}
                <div className="space-y-2">
                  <Label htmlFor="instructions">Special Instructions for AI Tutor (Optional)</Label>
                  <Textarea
                    id="instructions"
                    placeholder="e.g., Focus on practical applications, Use simple analogies for complex concepts, Emphasize problem-solving techniques..."
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    rows={3}
                    className="resize-none"
                  />
                  <p className="text-xs text-muted-foreground">
                    These instructions will guide how the AI approaches teaching this session
                  </p>
                </div>

                {/* Student Notes */}
                <div className="space-y-2">
                  <Label>Notes for Students (Optional)</Label>
                  <RichTextEditor
                    content={studentNotes}
                    onChange={setStudentNotes}
                    placeholder="Add notes, instructions, or links for students..."
                  />
                  <p className="text-xs text-muted-foreground">
                    Rich text content that students will see before starting the session
                  </p>
                </div>

                {/* Reference Images */}
                <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
                  <div className="flex items-center gap-2">
                    <ImagePlus className="w-5 h-5 text-primary" />
                    <h4 className="font-medium">Reference Images (Optional)</h4>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Select from approved course images. Students can open these as attachments during the session.
                  </p>
                
                  {referenceImages.length > 0 && (
                    <div className="grid gap-3">
                      {referenceImages.map((img, idx) => (
                        <div key={idx} className="flex gap-3 items-center p-2 bg-background rounded border">
                          <img 
                            src={img.url} 
                            alt={img.name} 
                            className="w-16 h-16 object-cover rounded"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{img.name}</p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeImage(idx)}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Select from approved course images */}
                  {approvedImages.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Select from approved course images:</p>
                      <div className="grid grid-cols-4 gap-2 max-h-32 overflow-y-auto p-1">
                        {approvedImages.map((img) => {
                          const isSelected = referenceImages.some(ref => ref.imageId === img.id || ref.storagePath === img.file_url);
                          return (
                            <button
                              key={img.id}
                              type="button"
                              onClick={() => !isSelected && addApprovedImageToReferences(img)}
                              className={`relative group rounded border overflow-hidden aspect-square ${isSelected ? 'ring-2 ring-primary opacity-50' : 'hover:ring-2 hover:ring-primary/50'}`}
                              disabled={isSelected}
                            >
                              <img 
                                src={approvedImageUrls[img.id]} 
                                alt={img.title || img.file_name}
                                className="w-full h-full object-cover"
                              />
                              {isSelected && (
                                <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                                  <Check className="w-4 h-4 text-primary" />
                                </div>
                              )}
                              <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                <Image className="w-4 h-4 text-white" />
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">
                      No approved images available. Upload and approve images in the Materials section first.
                    </p>
                  )}
                </div>

                {/* Start as Draft Toggle */}
                <div className="flex items-start space-x-3 p-3 border rounded-lg bg-muted/30">
                  <Checkbox
                    id="startAsDraft"
                    checked={startAsDraft}
                    onCheckedChange={(checked) => setStartAsDraft(checked === true)}
                  />
                  <div className="space-y-1">
                    <label
                      htmlFor="startAsDraft"
                      className="text-sm font-medium leading-none cursor-pointer"
                    >
                      Start as draft
                    </label>
                    <p className="text-xs text-muted-foreground">
                      When enabled, the session will be created as a draft for further editing. Otherwise it will be created as &quot;Ready&quot; for review.
                    </p>
                  </div>
                </div>

                {/* Inline LLM Response Display */}
                {llmSummaryResponse && (
                  <div className={`rounded-lg border p-4 ${llmSummaryResponse.status === "success" ? "border-green-500/30 bg-green-500/5" : "border-destructive/30 bg-destructive/5"}`}>
                    <div className="flex items-start gap-2 mb-2">
                      {llmSummaryResponse.status === "success" ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                      )}
                      <p className={`text-sm font-medium ${llmSummaryResponse.status === "success" ? "text-green-700 dark:text-green-400" : "text-destructive"}`}>
                        {llmSummaryResponse.message}
                      </p>
                    </div>
                  
                    {llmSummaryResponse.summary && (
                      <Collapsible open={summaryExpanded} onOpenChange={setSummaryExpanded}>
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm" className="w-full justify-between mt-2">
                            <span className="text-xs">View Generated Summary</span>
                            {summaryExpanded ? (
                              <ChevronDown className="w-4 h-4" />
                            ) : (
                              <ChevronRight className="w-4 h-4" />
                            )}
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="mt-2">
                          <div className="max-h-48 overflow-y-auto rounded border bg-muted/30 p-3">
                            <pre className="text-xs whitespace-pre-wrap font-mono">{llmSummaryResponse.summary}</pre>
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    )}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreate} disabled={creating}>
                    {creating && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                    {creating ? "Generating..." : "Create Session"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {!hasAnySource && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 !text-amber-600 dark:!text-amber-400" />
          <AlertDescription>
            Source material is required to create tutoring sessions. Upload one
            under <strong>Course Materials</strong> first — a textbook, which you
            then split into chapters, or an "Other" document, which a session
            takes whole.
          </AlertDescription>
        </Alert>
      )}

      {contentAssignments.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Could not load which classes these sessions are assigned to. The
            assignment badges below are incomplete.
          </AlertDescription>
        </Alert>
      )}

      {sessions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <GraduationCap className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Tutoring Sessions</h3>
            <p className="text-muted-foreground mb-4">
              Create your first tutoring session to help students learn interactively
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {sessionGroups.map((group) => (
            <section key={group.key} data-testid={`session-group-${group.key}`} className="space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </h3>
                <Badge variant="secondary" className="rounded-full px-2">
                  {group.sessions.length}
                </Badge>
                <span className="text-xs text-muted-foreground">{group.hint}</span>
              </div>
              {group.sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">{group.emptyText}</p>
              ) : (
                <div className="grid gap-4">
                  {group.sessions.map((session) => {
                    // Get chapter titles for display
                    const sessionChapterIds = session.chapter_ids || (session.chapter_id ? [session.chapter_id] : []);
                    const sessionChapters = allChapters.filter(ch => sessionChapterIds.includes(ch.id));
                    const sessionDoc = sessionChapters.length === 0 && session.material_id
                      ? wholeDocs.find(doc => doc.id === session.material_id)
                      : undefined;
                    const chapterDisplay = sessionChapters.length > 0
                      ? sessionChapters.map(ch => `Ch ${ch.chapter_number}`).join(", ")
                      : sessionDoc?.title ?? null;

                    const assignedTargets = contentAssignments.getAssignedTargets(session.id);
                    const isAssigned = assignedTargets.length > 0;
                    // An author whose profile RLS hides from this instructor resolves to
                    // no name at all; say "Unknown" rather than silently dropping the row.
                    const authorName = session.created_by
                      ? (authorNames[session.created_by] || "Unknown")
                      : null;

                    return (
                      <Card
                        key={session.id}
                        className={isAssigned ? "border-emerald-300 dark:border-emerald-900" : undefined}
                      >
                        <CardHeader className="pb-2">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <CardTitle className="text-base flex items-center gap-2">
                                <GraduationCap className="w-4 h-4 text-primary shrink-0" />
                                <span className="truncate">{session.title}</span>
                                {session.status === 'ready' ? (
                                  <Badge variant="default" className="shrink-0">Ready</Badge>
                                ) : (
                                  <Badge variant="secondary" className="shrink-0">Draft</Badge>
                                )}
                                {isAssigned ? (
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 gap-1 border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                                  >
                                    <Users className="w-3 h-3" />
                                    Assigned{assignedTargets.length > 1 ? ` · ${assignedTargets.length}` : ""}
                                  </Badge>
                                ) : session.status === 'ready' && assignmentStateKnown ? (
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 gap-1 border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
                                  >
                                    <AlertCircle className="w-3 h-3" />
                                    Not assigned
                                  </Badge>
                                ) : null}
                              </CardTitle>
                              <CardDescription className="mt-1">
                                {session.topic && <span className="block">{session.topic}</span>}
                                {chapterDisplay && (
                                  <span className="text-xs text-muted-foreground">
                                    {sessionChapters.length > 1 ? `${sessionChapters.length} chapters: ` : ""}
                                    {chapterDisplay}
                                  </span>
                                )}
                              </CardDescription>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {classes.length > 0 && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleOpenAssignDialog(session.id)}
                                  title={session.status === 'draft' ? "Cannot assign draft sessions" : "Assign to classes"}
                                  disabled={session.status === 'draft'}
                                >
                                  <Users className="w-4 h-4" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openEditSession(session)}
                                title="Edit session"
                              >
                                <Pencil className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => toggleStatus(session)}
                                title={session.status === 'draft' ? "Make Available" : "Set to Draft"}
                              >
                                {session.status === 'draft' ? (
                                  <Eye className="w-4 h-4 mr-1.5" />
                                ) : (
                                  <EyeOff className="w-4 h-4 mr-1.5" />
                                )}
                                {session.status === 'draft' ? "Make Available" : "Set to Draft"}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => deleteSession(session.id)}
                                title="Delete session"
                              >
                                <Trash2 className="w-4 h-4 text-destructive" />
                              </Button>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          <div className="flex items-center gap-4 text-sm text-muted-foreground">
                            {session.page_start && session.page_end && (
                              <span>Pages {session.page_start}-{session.page_end}</span>
                            )}
                            <span>
                              {formatNumber((session.extracted_content?.length || 0))} characters
                            </span>
                            <span>
                              Created {formatDate(session.created_at)}
                            </span>
                            {authorName && (
                              <span className="flex items-center gap-1">
                                <User className="w-3.5 h-3.5" />
                                {authorName}
                              </span>
                            )}
                            {classes.length > 0 && (
                              <AssignedClassesBadges
                                classes={classes}
                                assignedTargets={assignedTargets}
                                groupsByOffering={contentAssignments.groupsByOffering}
                                onClickAssign={session.status === 'draft' ? undefined : () => handleOpenAssignDialog(session.id)}
                                compact
                              />
                            )}
                          </div>
                  
                          {session.llm_status === "fail" && (
                            <Collapsible
                              open={expandedSummaries.has(session.id)}
                              onOpenChange={() => toggleSummaryExpanded(session.id)}
                            >
                              <CollapsibleTrigger asChild>
                                <Button variant="ghost" size="sm" className="gap-2 px-0 hover:bg-transparent">
                                  {expandedSummaries.has(session.id) ? (
                                    <ChevronDown className="w-4 h-4" />
                                  ) : (
                                    <ChevronRight className="w-4 h-4" />
                                  )}
                                  <span className="text-sm">View Issue</span>
                                  <Badge variant="destructive" className="text-xs">Failed</Badge>
                                </Button>
                              </CollapsibleTrigger>
                              <CollapsibleContent className="mt-2">
                                <div className="rounded-md border p-3 max-h-64 overflow-y-auto bg-destructive/10 border-destructive/30">
                                  {session.llm_message && (
                                    <p className="text-sm text-muted-foreground mb-2">{session.llm_message}</p>
                                  )}
                                </div>
                              </CollapsibleContent>
                            </Collapsible>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      {/* Edit Session Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={(open) => {
        if (!open) {
          setEditDialogOpen(false);
          setEditingSession(null);
        }
      }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Tutoring Session</DialogTitle>
            <DialogDescription>
              Update session details and AI tutor settings
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Title */}
            <div className="space-y-2">
              <Label htmlFor="edit-title">Session Title *</Label>
              <Input
                id="edit-title"
                placeholder="e.g., Introduction to Derivatives"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </div>

            {/* Topic */}
            <div className="space-y-2">
              <Label htmlFor="edit-topic">Topic / Learning Objective *</Label>
              <Input
                id="edit-topic"
                placeholder="e.g., Understanding basic derivative rules"
                value={editTopic}
                onChange={(e) => setEditTopic(e.target.value)}
              />
            </div>

            {/* Instructions */}
            <div className="space-y-2">
              <Label htmlFor="edit-instructions">Special Instructions for AI Tutor</Label>
              <Textarea
                id="edit-instructions"
                placeholder="e.g., Focus on practical applications, Use simple analogies..."
                value={editInstructions}
                onChange={(e) => setEditInstructions(e.target.value)}
                rows={4}
                className="resize-none"
              />
              <p className="text-xs text-muted-foreground">
                These instructions guide how the AI approaches teaching this session
              </p>
            </div>

            {/* Student Notes */}
            <div className="space-y-2">
              <Label>Notes for Students</Label>
              <RichTextEditor
                content={editStudentNotes}
                onChange={setEditStudentNotes}
                placeholder="Add notes, instructions, or links for students..."
              />
              <p className="text-xs text-muted-foreground">
                Rich text content that students will see before starting the session
              </p>
            </div>

            {/* Reference Images */}
            <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
              <div className="flex items-center gap-2">
                <ImagePlus className="w-5 h-5 text-primary" />
                <h4 className="font-medium">Reference Images</h4>
              </div>
              <p className="text-sm text-muted-foreground">
                Select from approved course images. Students can open these as attachments during the session.
              </p>
              
              {editReferenceImages.length > 0 && (
                <div className="grid gap-3">
                  {editReferenceImages.map((img, idx) => (
                    <div key={idx} className="flex gap-3 items-center p-2 bg-background rounded border">
                      <img 
                        src={editRefImageUrls[idx] || img.url} 
                        alt={img.name} 
                        className="w-16 h-16 object-cover rounded"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{img.name}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeEditImage(idx)}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Select from approved course images */}
              {approvedImages.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Select from approved course images:</p>
                  <div className="grid grid-cols-4 gap-2 max-h-32 overflow-y-auto p-1">
                    {approvedImages.map((img) => {
                      const isSelected = editReferenceImages.some(ref => ref.imageId === img.id || ref.storagePath === img.file_url);
                      return (
                        <button
                          key={img.id}
                          type="button"
                          onClick={() => !isSelected && addApprovedImageToEditReferences(img)}
                          className={`relative group rounded border overflow-hidden aspect-square ${isSelected ? 'ring-2 ring-primary opacity-50' : 'hover:ring-2 hover:ring-primary/50'}`}
                          disabled={isSelected}
                        >
                          <img 
                            src={approvedImageUrls[img.id]} 
                            alt={img.title || img.file_name}
                            className="w-full h-full object-cover"
                          />
                          {isSelected && (
                            <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                              <Check className="w-4 h-4 text-primary" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <Image className="w-4 h-4 text-white" />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  No approved images available. Upload and approve images in the Materials section first.
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => {
                setEditDialogOpen(false);
                setEditingSession(null);
              }}>
                Cancel
              </Button>
              <Button onClick={saveSession} disabled={saving}>
                {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                Save Changes
              </Button>
            </div>
          </div>
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
    </div>
  );
}
