import { useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { supabase } from "@/integrations/supabase/client";
import { fetchAuthorNames } from "@/lib/author-names";
import { SafeImage } from "@/components/SafeImage";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AssessmentQuestionBank,
  AssessmentBuilderPanel,
  AssessmentList,
  type Competency,
  type AssessmentQuestion,
  type AssessmentItem,
} from "@/components/assessment";
import { processLatexContent } from "@/lib/latex-utils";
import { useUnifiedQuestions } from "@/hooks/useUnifiedQuestions";
import { type UnifiedQuestion } from "@/lib/unified-question";
import { buildTestExportHtml } from "@/lib/test-html-export";
import { buildTestDocumentSeedHtml } from "@/lib/test-document-seed";
import { TestDocumentEditor } from "@/components/TestDocumentEditor";
import {
  mcqOptionsFromPayload,
  fillGapsStemFromPayload,
  orderingPromptFromPayload,
  orderingItemsFromPayload,
  classificationPromptFromPayload,
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
} from "@/lib/question-payload";
import type { QuestionType } from "@/types/question";
import { toast } from "sonner";
import { Loader2, FileText, FileDown, ArrowLeft } from "lucide-react";

interface CourseInfo {
  title: string;
  institution: {
    name: string;
    logo_url: string | null;
  } | null;
}

interface TestBuilderProps {
  courseId: string;
}

interface Test {
  id: string;
  title: string;
  description: string | null;
  custom_header: string | null;
  // Issue #728 — instructor-edited rich-text HTML snapshot. When present,
  // the PDF export pipeline uses the dedicated convert-html-to-pdf
  // function so page breaks + font sizes survive into the PDF.
  html_content: string | null;
  html_updated_at: string | null;
  is_published: boolean;
  created_at: string;
  created_by: string | null;
}

export function TestBuilder({ courseId }: TestBuilderProps) {
  // List view state
  const [tests, setTests] = useState<AssessmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'builder'>('list');
  const [editingTest, setEditingTest] = useState<Test | null>(null);

  // Builder state — bank is the unified question loader (#653 widened it to
  // include all 5 non-interactive types).
  const { questions: bankQuestions, loading: bankLoading } = useUnifiedQuestions(courseId, {
    excludeInteractiveOpen: true,
    excludeUserGenerated: true,
  });
  const [competencies, setCompetencies] = useState<Competency[]>([]);
  const [competencyByQuestionId, setCompetencyByQuestionId] = useState<
    Record<string, string | null>
  >({});
  const [validationByQuestionId, setValidationByQuestionId] = useState<
    Record<
      string,
      {
        status:
          | "CORRECT"
          | "PARTIALLY_CORRECT"
          | "INCORRECT"
          | "INSUFFICIENT_INFORMATION"
          | null;
        confidence: number | null;
      }
    >
  >({});
  const [testQuestions, setTestQuestions] = useState<AssessmentQuestion[]>([]);
  const [testTitle, setTestTitle] = useState("");
  const [testDescription, setTestDescription] = useState("");
  const [customHeader, setCustomHeader] = useState("");
  const [saving, setSaving] = useState(false);
  const [courseInfo, setCourseInfo] = useState<CourseInfo | null>(null);

  // Preview state
  const [showPreview, setShowPreview] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);

  // Issue #728 — rich-text document editor state. `htmlContent` holds the
  // saved snapshot for the test being edited; the editor seeds from
  // questions when no snapshot exists yet.
  const [htmlContent, setHtmlContent] = useState<string>("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorDraft, setEditorDraft] = useState<string>("");
  const [savingDocument, setSavingDocument] = useState(false);

  useEffect(() => {
    fetchTests();
    fetchCourseTagsForBank();
    fetchCourseInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId change
  }, [courseId]);

  const fetchTests = async () => {
    try {
      const { data, error } = await supabase
        .from("tests")
        .select(`
          *,
          test_questions(count)
        `)
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Fetch author names
      const creatorIds = [...new Set((data || []).filter(t => t.created_by).map(t => t.created_by))];
      let authorMap: Record<string, string> = {};
      
      if (creatorIds.length > 0) {
        authorMap = await fetchAuthorNames(creatorIds);
      }

      const testsWithCount = (data || []).map((t: any) => ({
        ...t,
        question_count: t.test_questions?.[0]?.count || 0,
        author_name: t.created_by ? (authorMap[t.created_by] || "Unknown") : null,
      }));

      setTests(testsWithCount);
    } catch (error: any) {
      console.error("Error fetching tests:", error);
      toast.error("Failed to load tests");
    } finally {
      setLoading(false);
    }
  };

  const fetchCourseInfo = async () => {
    try {
      const { data, error } = await supabase
        .from("courses")
        .select("title, institution:institutions(name, logo_url)")
        .eq("id", courseId)
        .single();

      if (error) throw error;
      setCourseInfo(data as CourseInfo);
    } catch (error: any) {
      console.error("Error fetching course info:", error);
    }
  };

  // useUnifiedQuestions (#621) handles the bank fetch end-to-end. We still
  // pull a sidecar of competency / mcq-validation tags keyed by question id so
  // the bank can apply the per-mcq verification gate and competency filter.
  const fetchCourseTagsForBank = async () => {
    try {
      const { data: tagRows, error: tagsError } = await supabase
        .from("questions")
        .select("id, type, competency_id, validation_status, validation_confidence")
        .eq("course_id", courseId);

      if (tagsError) throw tagsError;

      const compMap: Record<string, string | null> = {};
      const valMap: Record<
        string,
        {
          status:
            | "CORRECT"
            | "PARTIALLY_CORRECT"
            | "INCORRECT"
            | "INSUFFICIENT_INFORMATION"
            | null;
          confidence: number | null;
        }
      > = {};
      (tagRows ?? []).forEach((row: any) => {
        compMap[row.id] = row.competency_id ?? null;
        if (row.type === "mcq") {
          valMap[row.id] = {
            status: row.validation_status ?? null,
            confidence: row.validation_confidence ?? null,
          };
        }
      });
      setCompetencyByQuestionId(compMap);
      setValidationByQuestionId(valMap);

      const { data: compData, error: compError } = await supabase
        .from("course_competencies")
        .select("id, title")
        .eq("course_id", courseId)
        .order("order_num", { ascending: true });

      if (compError) throw compError;
      setCompetencies(compData || []);
    } catch (error: any) {
      console.error("Error fetching course tags:", error);
    }
  };

  const fetchTestQuestions = async (testId: string) => {
    try {
      // Unified read: dispatch on the joined `questions.type` (#579/#582).
      // Widened in #653 to accept fill_gaps / ordering / classification.
      const { data, error } = await supabase
        .from("test_questions")
        .select("id, test_id, question_id, order_num, points, question:question_id(type)")
        .eq("test_id", testId)
        .order("order_num", { ascending: true });

      if (error) throw error;

      const VALID_TYPES: Set<QuestionType> = new Set([
        "mcq",
        "open",
        "fill_gaps",
        "ordering",
        "classification",
      ]);
      let droppedCount = 0;
      const questions: AssessmentQuestion[] = (data || []).flatMap((tq: any) => {
        if (!tq.question_id) return [];
        const joinedType = tq.question?.type as QuestionType | undefined;
        if (!joinedType || !VALID_TYPES.has(joinedType)) {
          droppedCount++;
          return [];
        }
        const fullQuestion = bankQuestions.find((q) => q.id === tq.question_id);

        return [{
          id: tq.question_id,
          type: joinedType,
          question: fullQuestion?.preview || '',
          difficulty: fullQuestion?.difficulty || 'medium',
          points: tq.points,
          competency_id: competencyByQuestionId[tq.question_id] ?? null,
        }];
      });

      if (droppedCount > 0) {
        toast.warning(`${droppedCount} question(s) could not be loaded and were skipped.`);
      }
      setTestQuestions(questions);
    } catch (error: any) {
      console.error("Error fetching test questions:", error);
    }
  };

  const handleCreateNew = () => {
    setEditingTest(null);
    setTestTitle("");
    setTestDescription("");
    setCustomHeader("");
    setTestQuestions([]);
    setHtmlContent("");
    setView('builder');
  };

  const handleEdit = async (item: AssessmentItem) => {
    const test = tests.find(t => t.id === item.id);
    if (!test) return;

    setEditingTest(test as Test);
    setTestTitle(test.title);
    setTestDescription(test.description || "");
    setCustomHeader((test as any).custom_header || "");
    setHtmlContent((test as any).html_content || "");
    await fetchTestQuestions(test.id);
    setView('builder');
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase
        .from("tests")
        .delete()
        .eq("id", id);

      if (error) throw error;

      toast.success("Test deleted");
      fetchTests();
    } catch (error: any) {
      console.error("Error deleting test:", error);
      toast.error("Failed to delete test");
    }
  };

  const handleTogglePublish = async (item: AssessmentItem) => {
    try {
      const { error } = await supabase
        .from("tests")
        .update({ is_published: !item.is_published })
        .eq("id", item.id);

      if (error) throw error;

      toast.success(item.is_published ? "Test hidden" : "Test published");
      fetchTests();
    } catch (error: any) {
      console.error("Error toggling publish:", error);
      toast.error("Failed to update test");
    }
  };

  const handleAddQuestion = (question: UnifiedQuestion) => {
    if (testQuestions.some(q => q.id === question.id)) {
      toast.error("Question already added");
      return;
    }

    setTestQuestions(prev => [...prev, {
      id: question.id,
      type: question.type,
      question: question.preview,
      difficulty: question.difficulty,
      points: question.difficulty === 'easy' ? 1 : question.difficulty === 'medium' ? 2 : 3,
      competency_id: competencyByQuestionId[question.id] ?? null,
    }]);
    toast.success("Question added");
  };

  const handleRemoveQuestion = (id: string) => {
    setTestQuestions(prev => prev.filter(q => q.id !== id));
  };

  const handleUpdatePoints = (id: string, points: number) => {
    setTestQuestions(prev => prev.map(q => 
      q.id === id ? { ...q, points: Math.max(0, points) } : q
    ));
  };

  const handleMoveQuestion = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= testQuestions.length) return;
    
    const newQuestions = [...testQuestions];
    [newQuestions[index], newQuestions[newIndex]] = [newQuestions[newIndex], newQuestions[index]];
    setTestQuestions(newQuestions);
  };

  const handleSave = async () => {
    if (!testTitle.trim()) {
      toast.error("Please enter a test title");
      return;
    }
    if (testQuestions.length === 0) {
      toast.error("Please add at least one question");
      return;
    }

    setSaving(true);
    try {
      const { data: user } = await supabase.auth.getUser();

      if (editingTest) {
        // Update existing test — also flush any locally-cached HTML snapshot
        // (issue #728) so a draft made before the test row existed survives.
        const updatePayload: {
          title: string;
          description: string | null;
          custom_header: string | null;
          html_content?: string | null;
          html_updated_at?: string | null;
        } = {
          title: testTitle.trim(),
          description: testDescription.trim() || null,
          custom_header: customHeader.trim() || null,
        };
        if (htmlContent && htmlContent !== (editingTest.html_content || "")) {
          updatePayload.html_content = htmlContent;
          updatePayload.html_updated_at = new Date().toISOString();
        }
        const { error: testError } = await supabase
          .from("tests")
          .update(updatePayload)
          .eq("id", editingTest.id);

        if (testError) throw testError;

        // Delete existing questions
        const { error: deleteError } = await supabase
          .from("test_questions")
          .delete()
          .eq("test_id", editingTest.id);

        if (deleteError) throw deleteError;

        // Add new questions — after #582 `test_questions.question_id`
        // (FK to the unified `questions` table) is the only discriminator.
        const testQuestionsData = testQuestions.map((q, index) => ({
          test_id: editingTest.id,
          question_id: q.id,
          order_num: index,
          points: q.points,
        }));

        const { error: insertError } = await supabase
          .from("test_questions")
          .insert(testQuestionsData);

        if (insertError) throw insertError;

        toast.success("Test updated");
      } else {
        // Create new test — persist any HTML draft (issue #728) made before
        // the row existed so the editor's draft survives the round-trip.
        const insertPayload: {
          course_id: string;
          title: string;
          description: string | null;
          custom_header: string | null;
          created_by: string | undefined;
          is_published: boolean;
          html_content?: string | null;
          html_updated_at?: string | null;
        } = {
          course_id: courseId,
          title: testTitle.trim(),
          description: testDescription.trim() || null,
          custom_header: customHeader.trim() || null,
          created_by: user.user?.id,
          is_published: true,
        };
        if (htmlContent && htmlContent.length > 0) {
          insertPayload.html_content = htmlContent;
          insertPayload.html_updated_at = new Date().toISOString();
        }
        const { data: newTest, error: testError } = await supabase
          .from("tests")
          .insert(insertPayload)
          .select()
          .single();

        if (testError) throw testError;

        // Add questions — after #582 `test_questions.question_id` is the
        // sole FK; the type discriminator lives on `questions.type`.
        const testQuestionsData = testQuestions.map((q, index) => ({
          test_id: newTest.id,
          question_id: q.id,
          order_num: index,
          points: q.points,
        }));

        const { error: insertError } = await supabase
          .from("test_questions")
          .insert(testQuestionsData);

        if (insertError) throw insertError;

        toast.success("Test created");
      }

      fetchTests();
      setView('list');
    } catch (error: any) {
      console.error("Error saving test:", error);
      toast.error(error.message || "Failed to save test");
    } finally {
      setSaving(false);
    }
  };

  const getTotalPoints = () => {
    return testQuestions.reduce((sum, q) => sum + q.points, 0);
  };

  // Shared with the bulk-list and preview export paths so all three entry
  // points stay aligned on the HTML+KaTeX pipeline (#657). The plain
  // markdown path doesn't render LaTeX, so any test with `\(...\)` or
  // `\[...\]` math came out as raw source in the PDF.
  const buildExportHtml = (
    title: string,
    header: string,
    items: AssessmentQuestion[],
  ): string => {
    const questionsById = new Map<string, UnifiedQuestion>();
    for (const q of items) {
      const full = bankQuestions.find((bq) => bq.id === q.id);
      if (full) questionsById.set(q.id, full);
    }
    return buildTestExportHtml({
      institutionName: courseInfo?.institution?.name ?? null,
      courseName: courseInfo?.title ?? null,
      testTitle: title,
      customHeader: header,
      questions: items.map((q) => ({ id: q.id, points: q.points })),
      questionsById,
    });
  };

  const triggerPdfDownload = (pdfBase64: string, filename: string) => {
    const byteCharacters = atob(pdfBase64);
    const byteArray = new Uint8Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteArray[i] = byteCharacters.charCodeAt(i);
    }
    const blob = new Blob([byteArray], { type: 'application/pdf' });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const downloadPdfFromHtml = async (html: string, filename: string) => {
    const { data, error } = await supabase.functions.invoke('convert-md-to-pdf', {
      body: { html, filename, pageSize: 'a4' },
    });

    if (error) throw error;
    if (!data?.pdfBase64) throw new Error('No PDF data received');
    triggerPdfDownload(data.pdfBase64, filename);
  };

  // Issue #728 — when the instructor has saved an edited HTML document
  // on `tests.html_content`, route the PDF export through the dedicated
  // convert-html-to-pdf function so page breaks and inline font-size
  // styles are preserved in the printed output.
  const downloadPdfFromDocumentHtml = async (html: string, filename: string) => {
    const { data, error } = await supabase.functions.invoke('convert-html-to-pdf', {
      body: { html, filename, pageSize: 'a4' },
    });

    if (error) throw error;
    if (!data?.pdfBase64) throw new Error('No PDF data received');
    triggerPdfDownload(data.pdfBase64, filename);
  };

  const handleOpenDocumentEditor = () => {
    if (testQuestions.length === 0) {
      toast.error("Add at least one question before editing the document");
      return;
    }
    const seed =
      htmlContent && htmlContent.length > 0
        ? htmlContent
        : buildSeedHtml(testTitle || "Untitled Test", customHeader, testQuestions);
    setEditorDraft(seed);
    setEditorOpen(true);
  };

  const handleRegenerateDocument = () => {
    const seed = buildSeedHtml(testTitle || "Untitled Test", customHeader, testQuestions);
    setEditorDraft(seed);
  };

  const handleSaveDocument = async () => {
    if (!editingTest) {
      // Persisting the snapshot requires a saved test row (we need its id).
      // Cache the draft locally; the next "Save"/"Update" will flush it via
      // the existing save path so users can iterate offline-style.
      setHtmlContent(editorDraft);
      setEditorOpen(false);
      toast.success("Document draft saved locally — Save the test to persist");
      return;
    }
    setSavingDocument(true);
    try {
      const { error } = await supabase
        .from("tests")
        .update({
          html_content: editorDraft,
          html_updated_at: new Date().toISOString(),
        })
        .eq("id", editingTest.id);
      if (error) throw error;
      setHtmlContent(editorDraft);
      setEditorOpen(false);
      toast.success("Document saved");
    } catch (error: any) {
      console.error("Error saving document:", error);
      toast.error(error.message || "Failed to save document");
    } finally {
      setSavingDocument(false);
    }
  };

  const buildSeedHtml = (
    title: string,
    header: string,
    items: AssessmentQuestion[],
  ): string => {
    const questionsById = new Map<string, UnifiedQuestion>();
    for (const q of items) {
      const full = bankQuestions.find((bq) => bq.id === q.id);
      if (full) questionsById.set(q.id, full);
    }
    return buildTestDocumentSeedHtml({
      institutionName: courseInfo?.institution?.name ?? null,
      courseName: courseInfo?.title ?? null,
      testTitle: title,
      customHeader: header,
      questions: items.map((q) => ({ id: q.id, points: q.points })),
      questionsById,
    });
  };

  const handleExportPdf = async () => {
    if (!testTitle.trim()) {
      toast.error("Please enter a test title");
      return;
    }
    if (testQuestions.length === 0) {
      toast.error("Please add at least one question");
      return;
    }

    setExportingPdf(true);
    try {
      const filename = testTitle.replace(/\s+/g, '_');
      if (htmlContent && htmlContent.trim().length > 0) {
        // Issue #728 — instructor has an edited document; honor it.
        await downloadPdfFromDocumentHtml(htmlContent, filename);
      } else {
        const html = buildExportHtml(testTitle, customHeader, testQuestions);
        await downloadPdfFromHtml(html, filename);
      }

      toast.success("PDF exported successfully");
      setShowPreview(false);
    } catch (error: any) {
      console.error("Error exporting PDF:", error);
      toast.error(error.message || "Failed to export PDF");
    } finally {
      setExportingPdf(false);
    }
  };

  const selectedQuestionIds = new Set(testQuestions.map(q => q.id));

  // For preview/export from list view
  const [previewTest, setPreviewTest] = useState<AssessmentItem | null>(null);
  const [previewQuestions, setPreviewQuestions] = useState<AssessmentQuestion[]>([]);
  const [previewCustomHeader, setPreviewCustomHeader] = useState<string>("");
  // Issue #733: also load the edited HTML snapshot so list-view Preview shows
  // what the PDF export will produce (parity with `handleExportFromList`).
  const [previewHtmlContent, setPreviewHtmlContent] = useState<string>("");
  const [loadingPreview, setLoadingPreview] = useState(false);

  const handlePreviewFromList = async (item: AssessmentItem) => {
    setLoadingPreview(true);
    // Reset stale state from a prior preview before the new fetch resolves.
    setPreviewHtmlContent("");
    setPreviewCustomHeader("");
    setPreviewQuestions([]);
    try {
      // Fetch test details including custom_header and the edited HTML
      // snapshot (issue #728/#733) so Preview matches PDF export.
      const { data: testData, error: testError } = await supabase
        .from("tests")
        .select("custom_header, html_content")
        .eq("id", item.id)
        .single();

      if (testError) throw testError;
      setPreviewCustomHeader(testData?.custom_header || "");
      setPreviewHtmlContent(((testData as any)?.html_content as string | null) || "");

      // Fetch questions for this test (unified read dispatched on questions.type, see #579)
      const { data, error } = await supabase
        .from("test_questions")
        .select("id, test_id, question_id, order_num, points, question:question_id(type)")
        .eq("test_id", item.id)
        .order("order_num", { ascending: true });

      if (error) throw error;

      let droppedCount = 0;
      const questions: AssessmentQuestion[] = (data || []).flatMap((tq: any) => {
        if (!tq.question_id) return [];
        const joinedType = tq.question?.type as QuestionType | undefined;
        if (!joinedType) {
          droppedCount++;
          return [];
        }
        const fullQuestion = bankQuestions.find((q) => q.id === tq.question_id);

        return [{
          id: tq.question_id,
          type: joinedType,
          question: fullQuestion?.preview || '',
          difficulty: fullQuestion?.difficulty || 'medium',
          points: tq.points,
          competency_id: competencyByQuestionId[tq.question_id] ?? null,
        }];
      });

      if (droppedCount > 0) {
        toast.warning(`${droppedCount} question(s) could not be loaded and were skipped.`);
      }
      setPreviewQuestions(questions);
      setPreviewTest(item);
    } catch (error: any) {
      console.error("Error loading test for preview:", error);
      toast.error("Failed to load test");
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleExportFromList = async (item: AssessmentItem) => {
    if (bankLoading) {
      toast.error("Question bank is still loading. Please wait a moment and try again.");
      return;
    }
    setLoadingPreview(true);
    try {
      // Fetch test details including custom_header and the edited HTML
      // snapshot (issue #728). When `html_content` is non-null we route the
      // export through the dedicated HTML → PDF function.
      const { data: testData, error: testError } = await supabase
        .from("tests")
        .select("custom_header, html_content")
        .eq("id", item.id)
        .single();

      if (testError) throw testError;
      const customHeaderValue = testData?.custom_header || "";
      const editedHtml = (testData as any)?.html_content as string | null;

      if (editedHtml && editedHtml.trim().length > 0) {
        setExportingPdf(true);
        const filename = item.title.replace(/\s+/g, '_');
        await downloadPdfFromDocumentHtml(editedHtml, filename);
        toast.success("PDF exported successfully");
        return;
      }

      // Fetch questions for this test (unified read dispatched on questions.type, see #579)
      const { data, error } = await supabase
        .from("test_questions")
        .select("id, test_id, question_id, order_num, points, question:question_id(type)")
        .eq("test_id", item.id)
        .order("order_num", { ascending: true });

      if (error) throw error;

      const VALID_TYPES: Set<QuestionType> = new Set([
        "mcq",
        "open",
        "fill_gaps",
        "ordering",
        "classification",
      ]);
      let droppedCount = 0;
      const questions: AssessmentQuestion[] = (data || []).flatMap((tq: any) => {
        if (!tq.question_id) return [];
        const joinedType = tq.question?.type as QuestionType | undefined;
        if (!joinedType || !VALID_TYPES.has(joinedType)) {
          droppedCount++;
          return [];
        }
        const fullQuestion = bankQuestions.find((q) => q.id === tq.question_id);

        return [{
          id: tq.question_id,
          type: joinedType,
          question: fullQuestion?.preview || '',
          difficulty: fullQuestion?.difficulty || 'medium',
          points: tq.points,
          competency_id: competencyByQuestionId[tq.question_id] ?? null,
        }];
      });

      if (droppedCount > 0) {
        toast.warning(`${droppedCount} question(s) could not be loaded and were skipped.`);
      }
      setExportingPdf(true);
      const html = buildExportHtml(item.title, customHeaderValue, questions);
      const filename = item.title.replace(/\s+/g, '_');
      await downloadPdfFromHtml(html, filename);

      toast.success("PDF exported successfully");
    } catch (error: any) {
      console.error("Error exporting test:", error);
      toast.error(error.message || "Failed to export test");
    } finally {
      setLoadingPreview(false);
      setExportingPdf(false);
    }
  };

  const handleExportPreviewTest = async () => {
    if (!previewTest) return;

    setExportingPdf(true);
    try {
      const filename = previewTest.title.replace(/\s+/g, '_');
      if (previewHtmlContent && previewHtmlContent.trim().length > 0) {
        // Issue #733: keep the list-view Preview export aligned with the
        // direct list-view Export path (`handleExportFromList`) — both
        // route through the dedicated HTML→PDF function when a snapshot exists.
        await downloadPdfFromDocumentHtml(previewHtmlContent, filename);
      } else {
        const html = buildExportHtml(
          previewTest.title,
          previewCustomHeader,
          previewQuestions,
        );
        await downloadPdfFromHtml(html, filename);
      }

      toast.success("PDF exported successfully");
      setPreviewTest(null);
    } catch (error: any) {
      console.error("Error exporting PDF:", error);
      toast.error(error.message || "Failed to export PDF");
    } finally {
      setExportingPdf(false);
    }
  };

  // Per-type body for the white "print preview" pane shared between the
  // list-view and builder-view preview dialogs. Mirrors the shape of the
  // exported PDF — answer blanks for fill_gaps / ordering / classification.
  const renderPrintPreviewBody = (
    fullQuestion: UnifiedQuestion | undefined,
  ) => {
    if (!fullQuestion) return null;
    const { type, raw } = fullQuestion;

    if (type === "mcq") {
      const options = mcqOptionsFromPayload(raw.payload);
      return (
        <>
          <p
            className="text-sm leading-relaxed"
            dangerouslySetInnerHTML={{
              __html: processLatexContent(raw.question || ""),
            }}
          />
          <div className="mt-3 space-y-2 pl-4">
            {options.map((opt, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="font-medium text-gray-700">
                  {String.fromCharCode(65 + i)}.
                </span>
                <span
                  className="text-sm"
                  dangerouslySetInnerHTML={{
                    __html: processLatexContent(opt),
                  }}
                />
              </div>
            ))}
          </div>
        </>
      );
    }

    if (type === "open") {
      return (
        <>
          <p
            className="text-sm leading-relaxed"
            dangerouslySetInnerHTML={{
              __html: processLatexContent(raw.question || ""),
            }}
          />
          <div className="mt-3 border-t border-dashed border-gray-300 pt-2">
            <div className="h-20 border border-gray-300 rounded bg-gray-50" />
            <p className="text-xs text-gray-400 mt-1 italic">Answer space</p>
          </div>
        </>
      );
    }

    if (type === "fill_gaps") {
      const stem = fillGapsStemFromPayload(raw.payload);
      // `____` blanks numbered with their ordinal so an offline grader can
      // line them up with the answer key.
      const rendered = stem.replace(
        /\{\{(\d+)\}\}/g,
        (_m, n) => `**(${n})** ____`,
      );
      return (
        <p
          className="text-sm leading-relaxed"
          dangerouslySetInnerHTML={{
            __html: processLatexContent(rendered),
          }}
        />
      );
    }

    if (type === "ordering") {
      const prompt = orderingPromptFromPayload(raw.payload);
      const items = orderingItemsFromPayload(raw.payload);
      // Apply the same deterministic Fisher-Yates shuffle used by the PDF
      // export so the preview matches what students actually receive.
      const shuffled = [...items];
      let seed = 0x9e3779b9;
      for (let i = shuffled.length - 1; i > 0; i--) {
        seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
        seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
        seed ^= seed >>> 16;
        const j = Math.abs(seed) % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return (
        <>
          <p
            className="text-sm leading-relaxed"
            dangerouslySetInnerHTML={{
              __html: processLatexContent(prompt),
            }}
          />
          <p className="text-xs text-gray-500 italic mt-2">
            Number each item in the correct order (1 = first):
          </p>
          <div className="mt-2 space-y-1 pl-4">
            {shuffled.map((item, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="font-medium text-gray-700">____</span>
                <span
                  className="text-sm"
                  dangerouslySetInnerHTML={{
                    __html: processLatexContent(item),
                  }}
                />
              </div>
            ))}
          </div>
        </>
      );
    }

    // classification
    const prompt = classificationPromptFromPayload(raw.payload);
    const categories = classificationCategoriesFromPayload(raw.payload);
    const items = classificationItemsFromPayload(raw.payload);
    return (
      <>
        <p
          className="text-sm leading-relaxed"
          dangerouslySetInnerHTML={{
            __html: processLatexContent(prompt),
          }}
        />
        <p className="text-xs text-gray-500 italic mt-2">
          Categories: {categories.map((c) => c.label).join(" • ")}
        </p>
        <div className="mt-2 space-y-1 pl-4">
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-2">
              <span className="text-sm">{it.text}</span>
              <span className="text-gray-400">→</span>
              <span className="font-medium text-gray-700">____</span>
            </div>
          ))}
        </div>
      </>
    );
  };

  if (view === 'list') {
    return (
      <>
        <AssessmentList
          mode="test"
          items={tests}
          loading={loading || loadingPreview}
          onCreateNew={handleCreateNew}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onPreview={handlePreviewFromList}
          onExport={handleExportFromList}
        />

        {/* Preview Dialog for List View */}
        <Dialog open={!!previewTest} onOpenChange={(open) => !open && setPreviewTest(null)}>
          <DialogContent className="max-w-3xl max-h-[90vh]">
            <DialogHeader>
              <DialogTitle>Test Preview</DialogTitle>
              <DialogDescription>
                Review how the test will look when exported
              </DialogDescription>
            </DialogHeader>
            
            <ScrollArea className="h-[60vh]">
              {/* Issue #733: render the edited HTML when present so the
                  list-view Preview matches the PDF export. */}
              {previewHtmlContent && previewHtmlContent.trim().length > 0 ? (
                <div
                  className="bg-white text-black p-8 rounded-lg shadow-inner border min-h-[500px] prose prose-sm max-w-none"
                  data-testid="test-list-preview-html-content"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtmlContent) }}
                />
              ) : (
                <div className="bg-white text-black p-8 rounded-lg shadow-inner border min-h-[500px]">
                  <div className="flex items-start justify-between mb-6 pb-4 border-b-2 border-gray-300">
                    <div className="flex items-center gap-4">
                      <SafeImage
                        src={courseInfo?.institution?.logo_url || undefined}
                        alt={`${courseInfo?.institution?.name || "Institution"} institution logo`}
                        wrapperClassName="h-16 w-16"
                        className="h-16 w-16 object-contain"
                        fallback={
                          <div className="h-16 w-16 bg-gray-200 rounded flex items-center justify-center">
                            <FileText className="w-8 h-8 text-gray-400" />
                          </div>
                        }
                      />
                      <div>
                        <p className="font-semibold text-lg">
                          {courseInfo?.institution?.name || "Institution Name"}
                        </p>
                        <p className="text-gray-600">
                          {courseInfo?.title || "Course Name"}
                        </p>
                      </div>
                    </div>
                    <div className="text-right text-sm text-gray-500">
                      <p>{previewQuestions.length} questions</p>
                      <p className="font-medium">{previewQuestions.reduce((sum, q) => sum + q.points, 0)} points</p>
                    </div>
                  </div>

                  <h1 className="text-2xl font-bold text-center mb-4">
                    {previewTest?.title || "Untitled Test"}
                  </h1>

                  {previewCustomHeader && (
                    <div className="mb-6 p-4 bg-gray-50 rounded border border-gray-200 text-sm whitespace-pre-wrap">
                      {previewCustomHeader}
                    </div>
                  )}

                  <div className="space-y-6">
                    {previewQuestions.map((q, index) => {
                      const fullQuestion = bankQuestions.find((bq) => bq.id === q.id);
                      return (
                        <div key={q.id} className="pb-4 border-b border-gray-200 last:border-0">
                          <div className="flex items-start gap-2 mb-2">
                            <span className="font-bold">{index + 1}.</span>
                            <div className="flex-1">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-sm text-gray-500">
                                  [{q.points} point{q.points !== 1 ? 's' : ''}]
                                </span>
                              </div>
                              {renderPrintPreviewBody(fullQuestion)}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </ScrollArea>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setPreviewTest(null)}>
                Close
              </Button>
              <Button onClick={handleExportPreviewTest} disabled={exportingPdf}>
                {exportingPdf ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Exporting...
                  </>
                ) : (
                  <>
                    <FileDown className="w-4 h-4 mr-2" />
                    Export PDF
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        onClick={() => setView('list')}
        className="mb-2"
      >
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to Tests
      </Button>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Question Bank */}
        <div className="lg:col-span-2">
          <AssessmentQuestionBank
            questions={bankQuestions}
            competencies={competencies}
            competencyByQuestionId={competencyByQuestionId}
            validationByQuestionId={validationByQuestionId}
            selectedQuestionIds={selectedQuestionIds}
            onAddQuestion={handleAddQuestion}
            mode="test"
          />
        </div>

        {/* Builder Panel */}
        <div>
          <AssessmentBuilderPanel
            mode="test"
            title={testTitle}
            onTitleChange={setTestTitle}
            description={testDescription}
            onDescriptionChange={setTestDescription}
            customHeader={customHeader}
            onCustomHeaderChange={setCustomHeader}
            questions={testQuestions}
            onRemoveQuestion={handleRemoveQuestion}
            onUpdatePoints={handleUpdatePoints}
            onMoveQuestion={handleMoveQuestion}
            onPreview={() => setShowPreview(true)}
            onSave={handleSave}
            saving={saving}
            isEditing={!!editingTest}
            onEditDocument={handleOpenDocumentEditor}
            hasEditedDocument={!!htmlContent && htmlContent.length > 0}
          />
        </div>
      </div>

      {/* Preview Dialog */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-3xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Test Preview</DialogTitle>
            <DialogDescription>
              Review how your test will look when exported
            </DialogDescription>
          </DialogHeader>
          
          <ScrollArea className="h-[60vh]">
            {/* Issue #733: when the instructor has saved an edited rich-text
                document, render that HTML in Preview so it matches what the
                PDF export will produce (parity with `downloadPdfFromDocumentHtml`
                in `handleExportPdf`). Falls back to the assembled-question
                view when no snapshot exists. */}
            {htmlContent && htmlContent.trim().length > 0 ? (
              <div
                className="bg-white text-black p-8 rounded-lg shadow-inner border min-h-[500px] prose prose-sm max-w-none"
                data-testid="test-preview-html-content"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(htmlContent) }}
              />
            ) : (
              <div className="bg-white text-black p-8 rounded-lg shadow-inner border min-h-[500px]">
                <div className="flex items-start justify-between mb-6 pb-4 border-b-2 border-gray-300">
                  <div className="flex items-center gap-4">
                    <SafeImage
                      src={courseInfo?.institution?.logo_url || undefined}
                      alt={`${courseInfo?.institution?.name || "Institution"} institution logo`}
                      wrapperClassName="h-16 w-16"
                      className="h-16 w-16 object-contain"
                      fallback={
                        <div className="h-16 w-16 bg-gray-200 rounded flex items-center justify-center">
                          <FileText className="w-8 h-8 text-gray-400" />
                        </div>
                      }
                    />
                    <div>
                      <p className="font-semibold text-lg">
                        {courseInfo?.institution?.name || "Institution Name"}
                      </p>
                      <p className="text-gray-600">
                        {courseInfo?.title || "Course Name"}
                      </p>
                    </div>
                  </div>
                  <div className="text-right text-sm text-gray-500">
                    <p>{testQuestions.length} questions</p>
                    <p className="font-medium">{getTotalPoints()} points</p>
                  </div>
                </div>

                <h1 className="text-2xl font-bold text-center mb-4">
                  {testTitle || "Untitled Test"}
                </h1>

                {customHeader && (
                  <div className="mb-6 p-4 bg-gray-50 rounded border border-gray-200 text-sm whitespace-pre-wrap">
                    {customHeader}
                  </div>
                )}

                <div className="space-y-6">
                  {testQuestions.map((q, index) => {
                    const fullQuestion = bankQuestions.find((bq) => bq.id === q.id);
                    return (
                      <div key={q.id} className="pb-4 border-b border-gray-200 last:border-0">
                        <div className="flex items-start gap-2 mb-2">
                          <span className="font-bold">{index + 1}.</span>
                          <div className="flex-1">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm text-gray-500">
                                [{q.points} point{q.points !== 1 ? 's' : ''}]
                              </span>
                            </div>
                            {renderPrintPreviewBody(fullQuestion)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </ScrollArea>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowPreview(false)}>
              Close
            </Button>
            <Button onClick={handleExportPdf} disabled={exportingPdf}>
              {exportingPdf ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Exporting...
                </>
              ) : (
                <>
                  <FileDown className="w-4 h-4 mr-2" />
                  Export PDF
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Issue #728 — Rich-text document editor dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-5xl max-h-[92vh] h-[92vh] flex flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>Edit test document</DialogTitle>
            <DialogDescription>
              Tweak headings, font sizes, and page breaks. Saved HTML is what
              the PDF export uses for this test.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-hidden">
            <TestDocumentEditor
              content={editorDraft}
              onChange={setEditorDraft}
            />
          </div>

          <DialogFooter className="shrink-0 gap-2 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={handleRegenerateDocument}
              title="Discard the current document and re-seed from the questions"
            >
              Regenerate from questions
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditorOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSaveDocument} disabled={savingDocument}>
                {savingDocument ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save document"
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
