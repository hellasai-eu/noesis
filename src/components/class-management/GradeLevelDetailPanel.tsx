import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  School,
  BookOpen,
  Users,
  Plus,
  Trash2,
  Link as LinkIcon,
  Loader2,
  Settings2,
  Power,
  UserPlus,
  X,
  FolderPlus,
  Pencil,
  Check,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  buildClassDisplayName,
  getSectionDisplayName,
  isGreekGradeLevel,
  nextGenericSectionName,
} from "@/lib/greek-school";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import type { ClassItem, ClassOffering } from "./hooks/useClassManagement";
import CourseInstructorPicker from "./CourseInstructorPicker";
import type { GradeSectionInfo } from "./CourseInstructorPicker";
import { useFormatters } from "@/i18n/formatters";

interface CourseInstructorInfo {
  user_id: string;
  full_name: string | null;
  email: string | null;
  restrictedSections: string[]; // class IDs; empty = all sections
}

interface GradeCourseInfo {
  course_id: string;
  course_title: string;
  course_category: string;
  sections: { classId: string; sectionName: string; category: string | null; offeringId: string | null }[];
  instructors: CourseInstructorInfo[];
}

interface Props {
  gradeLevel: string;
  gradeLevelId?: string | null;
  gradeSections: ClassItem[];
  institutionId: string;
  isAdmin: boolean;
  onSectionAdded: () => void;
  onSectionRemoved: () => void;
  onSectionRenamed: () => void;
  onSelectSection: (cls: ClassItem) => void;
  onAttachCourseToGrade: () => void;
  onCreateCourseForGrade: () => void;
  onEnrollStudentInSection?: (section: ClassItem) => void;
  coursesVersion?: number;
  enrollmentVersion?: number;
  userId?: string;
  academicPeriod?: string | null;
}

export default function GradeLevelDetailPanel({
  gradeLevel,
  gradeLevelId,
  gradeSections,
  institutionId,
  isAdmin,
  onSectionAdded,
  onSectionRemoved,
  onSectionRenamed,
  onSelectSection,
  onAttachCourseToGrade,
  onCreateCourseForGrade,
  onEnrollStudentInSection,
  coursesVersion,
  enrollmentVersion,
  userId,
  academicPeriod,
}: Props) {
  const { compareText } = useFormatters();
  const [gradeCourses, setGradeCourses] = useState<GradeCourseInfo[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [addingSection, setAddingSection] = useState(false);
  const [removingSection, setRemovingSection] = useState<string | null>(null);
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [editSectionName, setEditSectionName] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [togglingOffering, setTogglingOffering] = useState<string | null>(null);
  const [instructorPickerCourse, setInstructorPickerCourse] = useState<{
    id: string;
    title: string;
    instructorIds: string[];
    category: string;
  } | null>(null);
  const [removingInstructor, setRemovingInstructor] = useState<string | null>(null);
  const [savingInstructorSections, setSavingInstructorSections] = useState<string | null>(null);
  const gradeLevels = useInstitutionGradeLevels(institutionId);

  const gradeLabel = gradeLevels.getLabel(gradeLevel, "el");
  const isGreekGrade = isGreekGradeLevel(gradeLevel);
  const sectionWord = isGreekGrade ? "Τμήμα" : "Section";

  // Prefill for the Add Section input. Generic grades auto-number ("1", "2", …);
  // Greek grades start empty so the admin picks the letter (existing behavior).
  const defaultSectionName = (category: string | null) => {
    if (isGreekGrade) return "";
    const inCategory = gradeSections
      .filter((s) => (s.category ?? "") === (category ?? ""))
      .map((s) => s.section_name);
    return nextGenericSectionName(inCategory);
  };

  // Fetch all offerings for all sections in this grade
  useEffect(() => {
    fetchGradeCourses();
  }, [gradeSections.map((s) => s.id).join(","), coursesVersion]);

  const fetchGradeCourses = async () => {
    if (gradeSections.length === 0) {
      setGradeCourses([]);
      return;
    }
    setLoadingCourses(true);
    try {
      const sectionIds = gradeSections.map((s) => s.id);
      const { data: offerings } = await supabase
        .from("offerings")
        .select("id, class_id, course_id, courses:course_id(title, category)")
        .in("class_id", sectionIds);

      // Group by course
      const courseMap = new Map<string, GradeCourseInfo>();
      for (const o of offerings || []) {
        let info = courseMap.get(o.course_id);
        if (!info) {
          const courseCategory: string = (o.courses as any)?.category ?? "Default";
          const matchingSections = gradeSections.filter((s) => {
            if (courseCategory === "Default") return !s.category;
            return s.category === courseCategory;
          });
          info = {
            course_id: o.course_id,
            course_title: (o.courses as any)?.title || "Unknown",
            course_category: courseCategory,
            sections: matchingSections.map((s) => ({
              classId: s.id,
              sectionName: s.section_name || "?",
              category: s.category,
              offeringId: null,
            })),
            instructors: [],
          };
          courseMap.set(o.course_id, info);
        }
        const sec = info.sections.find((s) => s.classId === o.class_id);
        if (sec) sec.offeringId = o.id;
      }

      // Fetch course instructors
      const courseIds = Array.from(courseMap.keys());
      if (courseIds.length > 0) {
        const { data: ciData } = await supabase
          .from("course_instructors")
          .select("course_id, user_id")
          .in("course_id", courseIds);

        if (ciData && ciData.length > 0) {
          const userIds = [...new Set(ciData.map((ci) => ci.user_id))];
          const { data: profiles } = await supabase
            .from("profiles")
            .select("user_id, full_name, email")
            .in("user_id", userIds);

          const profileMap = new Map((profiles || []).map((p) => [p.user_id, p]));

          // Fetch instructor section restrictions
          const { data: sectionData } = await supabase
            .from("course_instructor_sections")
            .select("course_id, class_id, user_id")
            .in("course_id", courseIds);

          // Build a map: courseId-userId -> class_id[]
          const restrictionMap = new Map<string, string[]>();
          for (const row of sectionData || []) {
            const key = `${row.course_id}-${row.user_id}`;
            const arr = restrictionMap.get(key) || [];
            arr.push(row.class_id);
            restrictionMap.set(key, arr);
          }

          for (const ci of ciData) {
            const info = courseMap.get(ci.course_id);
            if (info) {
              const profile = profileMap.get(ci.user_id);
              const restrictionKey = `${ci.course_id}-${ci.user_id}`;
              info.instructors.push({
                user_id: ci.user_id,
                full_name: profile?.full_name || null,
                email: profile?.email || null,
                restrictedSections: restrictionMap.get(restrictionKey) || [],
              });
            }
          }
        }
      }

      setGradeCourses(Array.from(courseMap.values()));
    } catch (err) {
      console.error("Error fetching grade courses:", err);
    } finally {
      setLoadingCourses(false);
    }
  };

  // Distinct categories in this grade (NULL = default, plus any named ones)
  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const s of gradeSections) {
      cats.add(s.category ?? "");
    }
    // Sort: empty (default) first, then alphabetical
    return Array.from(cats).sort((a, b) => compareText(a, b));
  }, [gradeSections, compareText]);

  const hasMultipleCategories = categories.length > 1 || (categories.length === 1 && categories[0] !== "");

  const courseCategories = useMemo(() => {
    const cats = new Set<string>();
    for (const c of gradeCourses) {
      cats.add(c.course_category);
    }
    return Array.from(cats).sort((a, b) => {
      if (a === "Default") return -1;
      if (b === "Default") return 1;
      return compareText(a, b);
    });
  }, [gradeCourses, compareText]);

  const hasMultipleCourseCategories = courseCategories.length > 1 || (courseCategories.length === 1 && courseCategories[0] !== "Default");

  const [addSectionCategory, setAddSectionCategory] = useState<string | null>(null);
  const [newSectionName, setNewSectionName] = useState("");

  const addSectionDialogOpen = addSectionCategory !== null;

  const isDuplicateSectionName = (name: string, category: string | null) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    return gradeSections.some(
      (s) => (s.category ?? "") === (category ?? "") && s.section_name === trimmed,
    );
  };

  const handleAddSection = async (sectionName: string, category?: string | null) => {
    const trimmed = sectionName.trim();
    if (!trimmed) {
      toast.error("Section name cannot be empty");
      return;
    }
    if (isDuplicateSectionName(trimmed, category ?? null)) {
      toast.error(`Section "${trimmed}" already exists in this category`);
      return;
    }
    setAddingSection(true);
    try {
      const name = buildClassDisplayName({ grade_level: gradeLevel, section_name: trimmed, category: category || null });
      const { error } = await supabase.from("classes").insert({
        name,
        institution_id: institutionId,
        grade_level_id: gradeLevelId ?? null,
        section_name: trimmed,
        category: category || null,
        is_active: true,
        created_by: userId,
        academic_period: academicPeriod || null,
      });
      if (error) throw error;
      const catSuffix = category ? ` (${category})` : "";
      toast.success(`Section ${trimmed}${catSuffix} created`);
      setAddSectionCategory(null);
      setNewSectionName("");
      onSectionAdded();
    } catch (err: any) {
      toast.error(err.message || "Failed to add section");
    } finally {
      setAddingSection(false);
    }
  };

  const handleRemoveSection = async (section: ClassItem) => {
    const displayName = section.section_name
      ? getSectionDisplayName(gradeLevel, section.section_name)
      : section.name;
    if (!confirm(`Remove section ${displayName}? All enrollments and offerings in this section will be deleted.`)) return;

    setRemovingSection(section.id);
    try {
      const { error } = await supabase.from("classes").delete().eq("id", section.id);
      if (error) throw error;
      toast.success(`Section ${displayName} removed`);
      onSectionRemoved();
    } catch (err: any) {
      toast.error(err.message || "Failed to remove section");
    } finally {
      setRemovingSection(null);
    }
  };

  const handleStartRename = (section: ClassItem) => {
    setEditingSectionId(section.id);
    setEditSectionName(section.section_name || "");
  };

  const handleCancelRename = () => {
    setEditingSectionId(null);
    setEditSectionName("");
  };

  const handleSaveRename = async (section: ClassItem) => {
    const trimmed = editSectionName.trim();
    if (!trimmed) {
      toast.error("Section name cannot be empty");
      return;
    }
    if (trimmed === section.section_name) {
      handleCancelRename();
      return;
    }
    const duplicate = gradeSections.some(
      (s) => s.id !== section.id && (s.category ?? "") === (section.category ?? "") && s.section_name === trimmed,
    );
    if (duplicate) {
      toast.error(`Section "${trimmed}" already exists in this category`);
      return;
    }
    setSavingRename(true);
    try {
      const name = buildClassDisplayName({ grade_level: gradeLevel, section_name: trimmed, category: section.category });
      const { error } = await supabase
        .from("classes")
        .update({ section_name: trimmed, name })
        .eq("id", section.id);
      if (error) throw error;
      toast.success(`Section renamed to ${trimmed}`);
      handleCancelRename();
      onSectionRenamed();
    } catch (err: any) {
      toast.error(err.message || "Failed to rename section");
    } finally {
      setSavingRename(false);
    }
  };

  const handleToggleOffering = async (courseId: string, classId: string, offeringId: string | null) => {
    const key = `${courseId}-${classId}`;
    setTogglingOffering(key);
    try {
      if (offeringId) {
        // Remove offering
        const { error } = await supabase.from("offerings").delete().eq("id", offeringId);
        if (error) throw error;
      } else {
        // Create offering
        const { error } = await supabase
          .from("offerings")
          .insert({ class_id: classId, course_id: courseId, is_active: true });
        if (error) throw error;
      }
      await fetchGradeCourses();
    } catch (err: any) {
      toast.error(err.message || "Failed to update offering");
    } finally {
      setTogglingOffering(null);
    }
  };

  const handleRemoveInstructor = async (courseId: string, userId: string) => {
    const key = `${courseId}-${userId}`;
    setRemovingInstructor(key);
    try {
      const { error } = await supabase
        .from("course_instructors")
        .delete()
        .eq("course_id", courseId)
        .eq("user_id", userId);
      if (error) throw error;
      toast.success("Instructor removed from course");
      await fetchGradeCourses();
    } catch (err: any) {
      toast.error(err.message || "Failed to remove instructor");
    } finally {
      setRemovingInstructor(null);
    }
  };

  const handleToggleInstructorSection = async (
    courseId: string,
    instructorUserId: string,
    classId: string,
    currentRestrictions: string[],
  ) => {
    const key = `${courseId}-${instructorUserId}`;
    setSavingInstructorSections(key);
    try {
      const isCurrentlyRestricted = currentRestrictions.includes(classId);

      if (currentRestrictions.length === 0) {
        // Currently unrestricted (all sections). User is clicking a section to restrict.
        // Add rows for ALL sections EXCEPT the one being unchecked.
        const course = gradeCourses.find((c) => c.course_id === courseId);
        if (!course) return;
        const otherSections = course.sections
          .filter((s) => s.classId !== classId)
          .map((s) => ({
            course_id: courseId,
            class_id: s.classId,
            user_id: instructorUserId,
          }));
        if (otherSections.length === 0) {
          toast.info(
            "Cannot restrict access when the course has only one section.",
          );
          return;
        }
        const { error } = await supabase
          .from("course_instructor_sections")
          .insert(otherSections);
        if (error) throw error;
      } else if (isCurrentlyRestricted) {
        // Remove this section from restrictions
        const newRestrictions = currentRestrictions.filter((id) => id !== classId);
        if (newRestrictions.length === 0) {
          // No sections left = restore full access (delete all rows)
          const { error } = await supabase
            .from("course_instructor_sections")
            .delete()
            .eq("course_id", courseId)
            .eq("user_id", instructorUserId);
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from("course_instructor_sections")
            .delete()
            .eq("course_id", courseId)
            .eq("class_id", classId)
            .eq("user_id", instructorUserId);
          if (error) throw error;
        }
      } else {
        // Add this section to restrictions
        const { error } = await supabase
          .from("course_instructor_sections")
          .insert({ course_id: courseId, class_id: classId, user_id: instructorUserId });
        if (error) throw error;
      }
      await fetchGradeCourses();
    } catch (err: any) {
      toast.error(err.message || "Failed to update section restrictions");
    } finally {
      setSavingInstructorSections(null);
    }
  };

  // Count enrollments per section (fetched on demand)
  const [newCategoryName, setNewCategoryName] = useState("");
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [sectionCounts, setSectionCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const fetchCounts = async () => {
      if (gradeSections.length === 0) return;
      const ids = gradeSections.map((s) => s.id);
      const { data } = await supabase
        .from("class_enrollments")
        .select("class_id")
        .in("class_id", ids)
        .eq("role", "student");

      const counts: Record<string, number> = {};
      for (const e of data || []) {
        counts[e.class_id] = (counts[e.class_id] || 0) + 1;
      }
      setSectionCounts(counts);
    };
    fetchCounts();
  }, [gradeSections.map((s) => s.id).join(","), enrollmentVersion]);

  const allActive = gradeSections.every((s) => s.is_active);

  const handleToggleAllActive = async () => {
    const newActive = !allActive;
    const warning = newActive
      ? "Activate all sections in this grade?"
      : "Deactivate all sections in this grade? Students won't be able to access courses.";
    if (!confirm(warning)) return;

    try {
      const { error } = await supabase
        .from("classes")
        .update({ is_active: newActive })
        .in(
          "id",
          gradeSections.map((s) => s.id),
        );
      if (error) throw error;
      toast.success(`All sections ${newActive ? "activated" : "deactivated"}`);
      onSectionAdded(); // Trigger refresh
    } catch (err: any) {
      toast.error("Failed to update sections");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <School className="w-5 h-5" />
              {gradeLabel}
            </CardTitle>
            <CardDescription>
              {gradeSections.length} section{gradeSections.length !== 1 ? "s" : ""}
            </CardDescription>
          </div>
          {isAdmin && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-2">
                    <Power
                      className={`w-4 h-4 ${allActive ? "text-green-500" : "text-muted-foreground"}`}
                    />
                    <Switch checked={allActive} onCheckedChange={handleToggleAllActive} />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {allActive ? "Deactivate all sections" : "Activate all sections"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="sections" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="sections" className="flex items-center gap-2">
              <Users className="w-4 h-4" />
              Sections ({gradeSections.length})
            </TabsTrigger>
            <TabsTrigger value="courses" className="flex items-center gap-2">
              <BookOpen className="w-4 h-4" />
              Courses ({gradeCourses.length})
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="settings" className="flex items-center gap-2">
                <Settings2 className="w-4 h-4" />
                Settings
              </TabsTrigger>
            )}
          </TabsList>

          {/* Sections Tab */}
          <TabsContent value="sections">
            <div className="space-y-4">
              <div className="flex justify-end gap-2">
                {isAdmin && (
                  <>
                    {!hasMultipleCategories && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setAddSectionCategory("");
                          setNewSectionName(defaultSectionName(""));
                        }}
                        disabled={addingSection}
                      >
                        <Plus className="w-4 h-4 mr-2" />
                        Add Section
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setShowAddCategory(true)}>
                      <FolderPlus className="w-4 h-4 mr-2" />
                      Add Category
                    </Button>
                  </>
                )}
              </div>

              {/* Add category inline form */}
              {showAddCategory && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary/50">
                  <Input
                    placeholder="Category name (e.g., English, PT)"
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    className="flex-1"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newCategoryName.trim()) {
                        setAddSectionCategory(newCategoryName.trim());
                        setNewSectionName(defaultSectionName(newCategoryName.trim()));
                        setNewCategoryName("");
                        setShowAddCategory(false);
                      }
                      if (e.key === "Escape") {
                        setShowAddCategory(false);
                        setNewCategoryName("");
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      if (newCategoryName.trim()) {
                        setAddSectionCategory(newCategoryName.trim());
                        setNewSectionName(defaultSectionName(newCategoryName.trim()));
                        setNewCategoryName("");
                        setShowAddCategory(false);
                      }
                    }}
                    disabled={!newCategoryName.trim()}
                  >
                    Next
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setShowAddCategory(false);
                      setNewCategoryName("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              )}

              {gradeSections.length === 0 ? (
                <div className="text-center py-8 border-2 border-dashed rounded-lg">
                  <Users className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground">No sections yet</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {categories.map((cat) => {
                    const catSections = gradeSections.filter((s) => (s.category ?? "") === cat);
                    if (catSections.length === 0) return null;
                    return (
                      <div key={cat}>
                        {hasMultipleCategories && (
                          <div className="flex items-center justify-between mt-2 mb-1">
                            <p className="text-xs font-medium text-muted-foreground px-1">
                              {cat || "Default"}
                            </p>
                            {isAdmin && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 text-xs"
                                onClick={() => {
                                  setAddSectionCategory(cat);
                                  setNewSectionName(defaultSectionName(cat));
                                }}
                                disabled={addingSection}
                              >
                                <Plus className="w-3 h-3 mr-1" />
                                Add Section
                              </Button>
                            )}
                          </div>
                        )}
                        {catSections.map((section) => {
                          const displayName = section.section_name
                            ? getSectionDisplayName(gradeLevel, section.section_name)
                            : section.name;
                          const studentCount = sectionCounts[section.id] || 0;
                          const isEditing = editingSectionId === section.id;
                          return (
                            <div
                              key={section.id}
                              className="flex items-center justify-between p-3 rounded-lg bg-secondary/50 cursor-pointer hover:bg-secondary transition-colors"
                              onClick={() => !isEditing && onSelectSection(section)}
                            >
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                                  <Users className="w-4 h-4 text-primary" />
                                </div>
                                <div>
                                  {isEditing ? (
                                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                      <Input
                                        value={editSectionName}
                                        onChange={(e) => setEditSectionName(e.target.value)}
                                        className="h-7 w-24 text-sm"
                                        autoFocus
                                        disabled={savingRename}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") handleSaveRename(section);
                                          if (e.key === "Escape") handleCancelRename();
                                        }}
                                      />
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7"
                                        onClick={() => handleSaveRename(section)}
                                        disabled={savingRename}
                                      >
                                        {savingRename ? (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : (
                                          <Check className="w-3 h-3" />
                                        )}
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7"
                                        onClick={handleCancelRename}
                                        disabled={savingRename}
                                      >
                                        <X className="w-3 h-3" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <p className="font-medium text-sm">
                                      {sectionWord} {displayName}
                                      {section.category && (
                                        <span className="text-muted-foreground ml-1">({section.category})</span>
                                      )}
                                    </p>
                                  )}
                                  <p className="text-xs text-muted-foreground">
                                    {studentCount} student{studentCount !== 1 ? "s" : ""}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge
                                  variant={section.is_active ? "default" : "secondary"}
                                  className="text-xs"
                                >
                                  {section.is_active ? "Active" : "Inactive"}
                                </Badge>
                                {isAdmin && section.is_active && !isEditing && (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-8 w-8"
                                          aria-label="Add Student"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            onEnrollStudentInSection?.(section);
                                          }}
                                        >
                                          <UserPlus className="w-3 h-3" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>Add Student</TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                )}
                                {isAdmin && !isEditing && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleStartRename(section);
                                    }}
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </Button>
                                )}
                                {isAdmin && gradeSections.length > 1 && !isEditing && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleRemoveSection(section);
                                    }}
                                    disabled={removingSection === section.id}
                                  >
                                    {removingSection === section.id ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Trash2 className="w-3 h-3" />
                                    )}
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </TabsContent>

          {/* Courses Tab */}
          <TabsContent value="courses">
            <div className="space-y-4">
              <div className="flex justify-end gap-2">
                {isAdmin && (
                  <>
                    <Button size="sm" onClick={onCreateCourseForGrade}>
                      <Plus className="w-4 h-4 mr-2" />
                      Create Course
                    </Button>
                    <Button size="sm" variant="outline" onClick={onAttachCourseToGrade}>
                      <LinkIcon className="w-4 h-4 mr-2" />
                      Attach Course
                    </Button>
                  </>
                )}
              </div>

              {loadingCourses ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : gradeCourses.length === 0 ? (
                <div className="text-center py-8 border-2 border-dashed rounded-lg">
                  <BookOpen className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground mb-4">
                    No courses attached to any section
                  </p>
                  {isAdmin && (
                    <Button variant="outline" size="sm" onClick={onAttachCourseToGrade}>
                      <LinkIcon className="w-4 h-4 mr-2" />
                      Attach First Course
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {courseCategories.map((cat) => {
                    const catCourses = gradeCourses.filter((c) => c.course_category === cat);
                    if (catCourses.length === 0) return null;
                    return (
                      <div key={cat}>
                        {hasMultipleCourseCategories && (
                          <div className="flex items-center justify-between mt-2 mb-1">
                            <p className="text-xs font-medium text-muted-foreground px-1">
                              {cat || "Default"}
                            </p>
                          </div>
                        )}
                        {catCourses.map((course) => (
                    <div key={course.course_id} className="p-3 rounded-lg bg-secondary/50">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                          <BookOpen className="w-4 h-4 text-primary" />
                        </div>
                        <p className="font-medium text-sm flex-1">{course.course_title}</p>
                        {isAdmin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() =>
                              setInstructorPickerCourse({
                                id: course.course_id,
                                title: course.course_title,
                                instructorIds: course.instructors.map((i) => i.user_id),
                                category: course.course_category,
                              })
                            }
                          >
                            <UserPlus className="w-3.5 h-3.5 mr-1" />
                            Add Instructor
                          </Button>
                        )}
                      </div>
                      {/* Section checkboxes */}
                      <div className="flex flex-wrap items-center gap-3 ml-11 mb-3">
                        <span className="text-xs text-muted-foreground">Offered in sections:</span>
                        {course.sections.map((sec) => {
                          const displayName = getSectionDisplayName(gradeLevel, sec.sectionName);
                          const catSuffix = sec.category ? ` (${sec.category})` : "";
                          const key = `${course.course_id}-${sec.classId}`;
                          const isToggling = togglingOffering === key;
                          return (
                            <label
                              key={sec.classId}
                              className="flex items-center gap-1.5 cursor-pointer text-sm"
                            >
                              <Checkbox
                                checked={!!sec.offeringId}
                                disabled={isToggling || !isAdmin}
                                onCheckedChange={() =>
                                  handleToggleOffering(
                                    course.course_id,
                                    sec.classId,
                                    sec.offeringId,
                                  )
                                }
                              />
                              {isToggling ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <span>{displayName}{catSuffix}</span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                      {/* Instructors */}
                      {course.instructors.length > 0 && (
                        <div className="ml-11 space-y-1.5">
                          <span className="text-xs font-medium text-muted-foreground">Instructors:</span>
                          <div className="space-y-1.5">
                            {(() => {
                              const activeSections = course.sections.filter((sec) => !!sec.offeringId);
                              return course.instructors.map((instructor) => {
                              const instructorKey = `${course.course_id}-${instructor.user_id}`;
                              const isSaving = savingInstructorSections === instructorKey;
                              return (
                                <div
                                  key={instructor.user_id}
                                  className="flex items-center gap-2 flex-wrap"
                                >
                                  <Badge
                                    variant="outline"
                                    className="text-xs py-0.5 px-2 flex items-center gap-1"
                                  >
                                    {instructor.full_name || instructor.email || "Unknown"}
                                    {isAdmin && (
                                      <button
                                        className="ml-0.5 hover:text-destructive disabled:opacity-50"
                                        disabled={removingInstructor === instructorKey}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleRemoveInstructor(course.course_id, instructor.user_id);
                                        }}
                                      >
                                        {removingInstructor === instructorKey ? (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : (
                                          <X className="w-3 h-3" />
                                        )}
                                      </button>
                                    )}
                                  </Badge>
                                  {isAdmin && activeSections.map((sec) => {
                                    const displayName = getSectionDisplayName(
                                      gradeLevel,
                                      sec.sectionName,
                                    ) + (sec.category ? ` (${sec.category})` : "");
                                    const isAllowed =
                                      instructor.restrictedSections.length === 0 ||
                                      instructor.restrictedSections.includes(sec.classId);
                                    return (
                                      <label
                                        key={sec.classId}
                                        className="flex items-center gap-1.5 cursor-pointer text-sm"
                                      >
                                        <Checkbox
                                          checked={isAllowed}
                                          disabled={isSaving}
                                          onCheckedChange={() =>
                                            handleToggleInstructorSection(
                                              course.course_id,
                                              instructor.user_id,
                                              sec.classId,
                                              instructor.restrictedSections,
                                            )
                                          }
                                        />
                                        {isSaving ? (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : (
                                          <span>{displayName}</span>
                                        )}
                                      </label>
                                    );
                                  })}
                                </div>
                              );
                            });
                            })()}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </TabsContent>

          {/* Settings Tab */}
          {isAdmin && (
            <TabsContent value="settings">
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-lg bg-secondary/50">
                  <div className="flex items-center gap-4">
                    <div
                      className={`w-10 h-10 rounded-lg flex items-center justify-center ${allActive ? "bg-green-500/20" : "bg-muted"}`}
                    >
                      <Power
                        className={`w-5 h-5 ${allActive ? "text-green-600" : "text-muted-foreground"}`}
                      />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">Grade Level Active</p>
                      <p className="text-sm text-muted-foreground">
                        {allActive
                          ? "All sections are active"
                          : "Some or all sections are inactive"}
                      </p>
                    </div>
                  </div>
                  <Switch checked={allActive} onCheckedChange={handleToggleAllActive} />
                </div>
              </div>
            </TabsContent>
          )}
        </Tabs>
      </CardContent>

      <Dialog
        open={addSectionDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setAddSectionCategory(null);
            setNewSectionName("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Section</DialogTitle>
            <DialogDescription>
              {addSectionCategory
                ? `Create a new section in the "${addSectionCategory}" category.`
                : `Create a new section${hasMultipleCategories ? " in the default category" : ""}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-section-name">Section name</Label>
            <Input
              id="new-section-name"
              placeholder={isGreekGrade ? "e.g. Α, Β, Morning" : "e.g. 1, 2, Morning"}
              value={newSectionName}
              onChange={(e) => setNewSectionName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && newSectionName.trim() && !isDuplicateSectionName(newSectionName, addSectionCategory || null) && !addingSection) {
                  handleAddSection(newSectionName, addSectionCategory || null);
                }
              }}
            />
            {isDuplicateSectionName(newSectionName, addSectionCategory || null) && (
              <p className="text-sm text-destructive">
                A section with this name already exists in this category.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAddSectionCategory(null);
                setNewSectionName("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => handleAddSection(newSectionName, addSectionCategory || null)}
              disabled={!newSectionName.trim() || isDuplicateSectionName(newSectionName, addSectionCategory || null) || addingSection}
            >
              {addingSection ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {instructorPickerCourse && (
        <CourseInstructorPicker
          open={!!instructorPickerCourse}
          onOpenChange={(open) => {
            if (!open) setInstructorPickerCourse(null);
          }}
          courseId={instructorPickerCourse.id}
          courseTitle={instructorPickerCourse.title}
          institutionId={institutionId}
          currentInstructorIds={instructorPickerCourse.instructorIds}
          gradeSections={gradeSections
            .filter((s) => {
              const cat = instructorPickerCourse.category;
              if (cat === "Default") return !s.category;
              return s.category === cat;
            })
            .map((s) => ({
              classId: s.id,
              sectionName: s.section_name || "?",
              category: s.category,
              gradeLevel: gradeLevel,
            }))}
          onChanged={fetchGradeCourses}
        />
      )}
    </Card>
  );
}

