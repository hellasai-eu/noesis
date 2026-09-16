import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useUserInstitution } from "@/hooks/useUserInstitution";
import { useInstitutionConfig } from "@/hooks/useInstitutionConfig";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import {
  ensureGradeLevel,
  filterGradeOptionsBySchoolLevels,
  getGradeLevelGroupsById,
} from "@/lib/grade-levels";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { InstructorHomeButton } from "@/components/InstructorHomeButton";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Loader2, Plus, School } from "lucide-react";
import { toast } from "sonner";

import { useClassManagement } from "@/components/class-management/hooks/useClassManagement";
import type {
  ClassItem,
  ClassOffering,
  ClassEnrollment,
  AvailableUser,
  StudentFilterMode,
} from "@/components/class-management/hooks/useClassManagement";
import { buildClassDisplayName, getSectionDisplayName, SECTION_LETTERS } from "@/lib/greek-school";

import GradeLevelSidebar from "@/components/class-management/GradeLevelSidebar";
import ClassDetailPanel from "@/components/class-management/ClassDetailPanel";
import GradeLevelDetailPanel from "@/components/class-management/GradeLevelDetailPanel";
import CreateGradeLevelDialog from "@/components/class-management/CreateGradeLevelDialog";
import CreateGenericGradeDialog from "@/components/class-management/CreateGenericGradeDialog";
import AttachCourseDialog from "@/components/class-management/AttachCourseDialog";
import CreateCourseDialog from "@/components/class-management/CreateCourseDialog";
import EnrollStudentDialog from "@/components/class-management/EnrollStudentDialog";
import { useFormatters } from "@/i18n/formatters";

const ClassManagement = () => {
  const { compareText } = useFormatters();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { institutionId, isAdmin, isInstructor, loading: institutionLoading } =
    useUserInstitution(user?.id);
  const { institutionType, schoolLevels, defaultLanguage, academicPeriod, loading: configLoading } =
    useInstitutionConfig(institutionId);

  const cm = useClassManagement(institutionId, user?.id, isAdmin, isInstructor);
  const gradeLevels = useInstitutionGradeLevels(institutionId);
  const queryClient = useQueryClient();

  const isGreekSchool = institutionType === "greek_school";

  // Selection state
  const [selectedClass, setSelectedClass] = useState<ClassItem | null>(null);
  const [selectedGradeLevel, setSelectedGradeLevel] = useState<string | null>(null);
  const [classOfferings, setClassOfferings] = useState<ClassOffering[]>([]);
  const [classEnrollments, setClassEnrollments] = useState<ClassEnrollment[]>([]);
  const [loadingClassDetails, setLoadingClassDetails] = useState(false);
  // Dialog state
  const [createGradeLevelOpen, setCreateGradeLevelOpen] = useState(false);
  const [createGenericGradeOpen, setCreateGenericGradeOpen] = useState(false);
  const [attachCourseOpen, setAttachCourseOpen] = useState(false);
  const [createCourseOpen, setCreateCourseOpen] = useState(false);
  const [gradeCoursesVersion, setGradeCoursesVersion] = useState(0);
  const [enrollStudentOpen, setEnrollStudentOpen] = useState(false);
  const [studentFilterMode, setStudentFilterMode] = useState<StudentFilterMode>("unassigned");
  const [enrollTargetSection, setEnrollTargetSection] = useState<ClassItem | null>(null);
  const [gradeEnrollmentVersion, setGradeEnrollmentVersion] = useState(0);

  // Data for dialogs
  const [availableCourses, setAvailableCourses] = useState<
    { id: string; title: string; grade_level_id: string | null }[]
  >([]);
  const [availableStudents, setAvailableStudents] = useState<AvailableUser[]>([]);

  // For grade-level attach course
  const [attachCourseGradeMode, setAttachCourseGradeMode] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  // Grade level groups — both greek_school and generic institutions use grades now
  const gradeLevelGroups = useMemo(
    () => getGradeLevelGroupsById(cm.classes, gradeLevels.rows),
    [cm.classes, gradeLevels.rows],
  );

  const existingGradeLevels = useMemo(
    () => gradeLevelGroups.map((g) => g.gradeLevel),
    [gradeLevelGroups],
  );

  const selectedGradeLevelId = useMemo(
    () => (selectedGradeLevel ? gradeLevels.findIdByCode(selectedGradeLevel) : null),
    [selectedGradeLevel, gradeLevels],
  );

  const categoriesForGrade = useMemo(() => {
    if (!selectedGradeLevelId) return [];
    const cats = new Set<string>();
    for (const c of cm.classes) {
      if (c.grade_level_id === selectedGradeLevelId && c.category) {
        cats.add(c.category);
      }
    }
    return Array.from(cats).sort();
  }, [selectedGradeLevelId, cm.classes]);

  // Sections for currently selected grade level
  const selectedGradeSections = useMemo(() => {
    if (!selectedGradeLevelId) return [];
    return cm.classes
      .filter((c) => c.grade_level_id === selectedGradeLevelId)
      .sort((a, b) => {
        // Sort by category first: NULL first, then alphabetical
        const aCat = a.category ?? "";
        const bCat = b.category ?? "";
        if (aCat !== bCat) return compareText(aCat, bCat);
        // Then by section letter
        const ai = SECTION_LETTERS.indexOf(a.section_name as any);
        const bi = SECTION_LETTERS.indexOf(b.section_name as any);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
  }, [selectedGradeLevelId, cm.classes, compareText]);

  // --- Class selection ---
  const handleSelectClass = async (cls: ClassItem) => {
    setSelectedClass(cls);
    setSelectedGradeLevel(null);
    setLoadingClassDetails(true);
    try {
      const details = await cm.fetchClassDetails(cls);
      setClassOfferings(details.offerings);
      setClassEnrollments(details.enrollments);
    } catch (err) {
      toast.error("Failed to load class details");
    } finally {
      setLoadingClassDetails(false);
    }
  };

  const handleSelectGradeLevel = (gradeLevel: string) => {
    setSelectedGradeLevel(gradeLevel);
    setSelectedClass(null);
  };

  // Greek schools pick a grade from the fixed taxonomy; generic schools name a
  // free-text grade.
  const openCreateGrade = () =>
    isGreekSchool ? setCreateGradeLevelOpen(true) : setCreateGenericGradeOpen(true);

  // --- Grade level creation ---
  const handleCreateGradeLevel = async (
    gradeLevel: string,
    sections: { name: string; section_name: string; category?: string | null }[],
  ) => {
    if (!institutionId) throw new Error("No institution");
    // Ensure a grade_levels row exists (backfill covered pre-existing grades;
    // this covers admins picking a Greek grade that had no classes yet, or
    // typing a brand-new generic grade name).
    const gradeLevelId = await ensureGradeLevel(supabase, institutionId, gradeLevel);
    await queryClient.invalidateQueries({ queryKey: ["grade_levels", institutionId] });
    const sectionsWithFk = sections.map((s) => ({ ...s, grade_level_id: gradeLevelId }));
    await cm.createClassesBatch(sectionsWithFk, academicPeriod);
    await cm.fetchClasses();
  };

  // --- Delete entire grade level ---
  const handleDeleteGradeLevel = async (gradeLevel: string) => {
    const gradeLevelIdForDelete = gradeLevels.findIdByCode(gradeLevel);
    if (!gradeLevelIdForDelete) {
      toast.error("Grade level not found");
      return;
    }
    const sections = cm.classes.filter(
      (c) => c.grade_level_id === gradeLevelIdForDelete,
    );
    const gradeLabel = gradeLevels.getLabel(gradeLevel, "el");
    if (
      !confirm(
        `Are you sure you want to delete ${gradeLabel} and all its ${sections.length} section(s)? This will also remove all enrollments, offerings, and course attachments for these sections.`,
      )
    )
      return;
    try {
      await cm.deleteClassesBatch(sections.map((s) => s.id));
      toast.success(`${gradeLabel} deleted`);
      cm.setClasses((prev) =>
        prev.filter((c) => c.grade_level_id !== gradeLevelIdForDelete),
      );
      if (selectedGradeLevel === gradeLevel) setSelectedGradeLevel(null);
      if (selectedClass && selectedClass.grade_level_id === gradeLevelIdForDelete) {
        setSelectedClass(null);
      }
    } catch {
      toast.error("Failed to delete grade level");
      await cm.fetchClasses();
    }
  };

  // --- Dialog openers ---
  const handleOpenAttachCourse = async (gradeMode = false) => {
    setAttachCourseGradeMode(gradeMode);
    let attachedIds: string[];
    if (gradeMode) {
      // Collect course IDs already attached to ALL sections in this grade
      // to exclude them from the dropdown (avoids UNIQUE constraint violations)
      const sectionIds = selectedGradeSections.map((s) => s.id);
      if (sectionIds.length > 0) {
        const { data } = await supabase
          .from("offerings")
          .select("course_id")
          .in("class_id", sectionIds);
        attachedIds = [...new Set((data || []).map((o) => o.course_id))];
      } else {
        attachedIds = [];
      }
    } else {
      attachedIds = classOfferings.map((o) => o.course_id);
    }
    const courses = await cm.fetchAvailableCourses(attachedIds);
    setAvailableCourses(courses);
    setAttachCourseOpen(true);
  };

  const handleOpenEnrollStudent = async () => {
    setStudentFilterMode("unassigned");
    const students = await cm.fetchAvailableUsers(
      selectedClass!.id,
      "student",
      classEnrollments.map((e) => e.user_id),
      "unassigned",
      selectedClass!.category,
      selectedClass!.grade_level_id,
    );
    setAvailableStudents(students);
    setEnrollStudentOpen(true);
  };

  const handleStudentFilterModeChange = async (mode: StudentFilterMode) => {
    const target = selectedClass || enrollTargetSection;
    if (!target) return;
    setStudentFilterMode(mode);
    let enrolledUserIds: string[];
    if (selectedClass) {
      enrolledUserIds = classEnrollments.map((e) => e.user_id);
    } else {
      const { data: enrollments } = await supabase
        .from("class_enrollments")
        .select("user_id")
        .eq("class_id", target.id);
      enrolledUserIds = (enrollments || []).map((e) => e.user_id);
    }
    const students = await cm.fetchAvailableUsers(
      target.id,
      "student",
      enrolledUserIds,
      mode,
      target.category,
      target.grade_level_id,
    );
    setAvailableStudents(students);
  };

  const handleOpenEnrollStudentForSection = async (section: ClassItem) => {
    setEnrollTargetSection(section);
    setStudentFilterMode("unassigned");
    const { data: enrollments } = await supabase
      .from("class_enrollments")
      .select("user_id")
      .eq("class_id", section.id);
    const enrolledUserIds = (enrollments || []).map((e) => e.user_id);
    const students = await cm.fetchAvailableUsers(
      section.id,
      "student",
      enrolledUserIds,
      "unassigned",
      section.category,
      section.grade_level_id,
    );
    setAvailableStudents(students);
    setEnrollStudentOpen(true);
  };

  // --- Handlers for ClassDetailPanel ---
  const handleDetachCourse = async (offeringId: string) => {
    if (!confirm("Remove this course from the class?")) return;
    try {
      await cm.detachCourse(offeringId);
      toast.success("Course removed from class");
      setClassOfferings((prev) => prev.filter((o) => o.id !== offeringId));
    } catch {
      toast.error("Failed to remove course");
    }
  };

  const handleRemoveInstructor = async (courseId: string, userId: string) => {
    if (!selectedClass || !confirm("Remove this instructor from the course?")) return;
    try {
      await cm.removeCourseInstructor(courseId, userId, selectedClass.id);
      toast.success("Instructor removed from course");
      setClassOfferings((prev) =>
        prev.map((o) =>
          o.course_id === courseId
            ? { ...o, instructors: o.instructors.filter((i) => i.user_id !== userId) }
            : o,
        ),
      );
      if (selectedClass) handleSelectClass(selectedClass);
    } catch {
      toast.error("Failed to remove instructor");
    }
  };

  const handleRemoveEnrollment = async (userId: string) => {
    if (!selectedClass || !confirm("Remove this user from the class?")) return;
    try {
      await cm.removeEnrollment(selectedClass.id, userId);
      toast.success("User removed from class");
      setClassEnrollments((prev) => prev.filter((e) => e.user_id !== userId));
    } catch {
      toast.error("Failed to remove user");
    }
  };

  const handleDeleteClass = async (classId: string) => {
    if (
      !confirm(
        "Are you sure you want to delete this class? This will also remove all enrollments and course attachments.",
      )
    )
      return;
    try {
      await cm.deleteClass(classId);
      toast.success("Class deleted");
      cm.setClasses(cm.classes.filter((c) => c.id !== classId));
      if (selectedClass?.id === classId) setSelectedClass(null);
    } catch {
      toast.error("Failed to delete class");
    }
  };

  const handleToggleClassActive = async (classId: string, currentActive: boolean) => {
    const warning = currentActive
      ? "Deactivating this class will prevent students from accessing courses through this class. Continue?"
      : "Activate this class?";
    if (!confirm(warning)) return;
    try {
      await cm.toggleClassActive(classId, !currentActive);
      toast.success(`Class ${currentActive ? "deactivated" : "activated"} successfully`);
      cm.setClasses(cm.classes.map((c) => (c.id === classId ? { ...c, is_active: !currentActive } : c)));
      if (selectedClass?.id === classId)
        setSelectedClass({ ...selectedClass, is_active: !currentActive });
    } catch {
      toast.error("Failed to update class");
    }
  };

  const handleToggleSelfEnrollment = async (classId: string, currentValue: boolean) => {
    try {
      await cm.toggleSelfEnrollment(classId, !currentValue);
      toast.success(currentValue ? "Self-enrollment disabled" : "Self-enrollment enabled");
      cm.setClasses(
        cm.classes.map((c) =>
          c.id === classId ? { ...c, allow_self_enrollment: !currentValue } : c,
        ),
      );
      if (selectedClass?.id === classId)
        setSelectedClass({ ...selectedClass, allow_self_enrollment: !currentValue });
    } catch {
      toast.error("Failed to update self-enrollment setting");
    }
  };

  // --- Attach course handler ---
  const handleAttachCourse = async (courseId: string, sectionIds?: string[]) => {
    if (attachCourseGradeMode && sectionIds) {
      // Attach to multiple sections
      const failed: string[] = [];
      for (const sectionId of sectionIds) {
        try {
          await cm.attachCourse(sectionId, courseId);
        } catch (err: any) {
          failed.push(sectionId);
        }
      }
      if (failed.length === sectionIds.length) {
        toast.error("Failed to attach course to any sections");
      } else if (failed.length > 0) {
        toast.warning(`Course attached to ${sectionIds.length - failed.length} of ${sectionIds.length} sections`);
      } else {
        toast.success("Course attached to selected sections");
      }
      setGradeCoursesVersion((v) => v + 1);
    } else if (selectedClass) {
      await cm.attachCourse(selectedClass.id, courseId);
      toast.success("Course attached successfully");
      // Refresh class details
      handleSelectClass(selectedClass);
    }
  };

  // --- Create course from grade level ---
  const handleCreateCourseFromGrade = async (data: {
    title: string;
    description: string;
    theme: string;
    language: string;
    grade_level: string;
    category: string;
  }) => {
    try {
      if (!institutionId) throw new Error("No institution");
      const gradeLevelId = await ensureGradeLevel(supabase, institutionId, data.grade_level);
      await queryClient.invalidateQueries({ queryKey: ["grade_levels", institutionId] });
      const courseId = await cm.createCourse({
        title: data.title,
        description: data.description,
        theme: data.theme,
        language: data.language,
        grade_level_id: gradeLevelId,
        category: data.category,
      });

      // Auto-attach to sections in the selected grade, filtered by category.
      // Match by grade_level_id (FK identity — the TEXT column no longer
      // exists after #799).
      const sectionsForGrade = cm.classes.filter((c) => {
        if (c.grade_level_id !== gradeLevelId) return false;
        if (data.category === "Default") return !c.category;
        return c.category === data.category;
      });
      const sectionIds = sectionsForGrade.map((s) => s.id);
      if (sectionIds.length > 0) {
        const { error: offeringError } = await supabase
          .from("offerings")
          .upsert(
            sectionIds.map((classId) => ({
              class_id: classId,
              course_id: courseId,
              is_active: true,
            })),
            { onConflict: "class_id,course_id" },
          );
        if (offeringError) {
          console.error("Error creating offerings:", offeringError);
          toast.warning("Course created but could not be auto-attached to sections");
        } else {
          const catLabel = data.category ? ` (${data.category})` : "";
          toast.success(`Course created and attached to ${sectionIds.length} section${sectionIds.length !== 1 ? "s" : ""}${catLabel}`);
        }
      } else {
        toast.success("Course created successfully");
      }
      setGradeCoursesVersion((v) => v + 1);
    } catch (err: any) {
      if (err.code === "23505") {
        toast.error("A course with this title already exists");
      } else {
        toast.error(err.message || "Failed to create course");
      }
      throw err;
    }
  };

  const handleEnrollStudent = async (userIds: string[], reassignments?: { userId: string; fromClassId: string }[]) => {
    const target = selectedClass || enrollTargetSection;
    if (!target) return;
    try {
      const reassignMap = new Map(reassignments?.map((r) => [r.userId, r.fromClassId]) || []);
      const reassignIds = userIds.filter((id) => reassignMap.has(id));
      const directIds = userIds.filter((id) => !reassignMap.has(id));

      for (const userId of reassignIds) {
        await cm.reassignUser(reassignMap.get(userId)!, target.id, userId, "student");
      }

      if (directIds.length > 0) {
        await cm.enrollUsers(target.id, directIds, "student");
      }

      const total = userIds.length;
      if (total === 1) {
        toast.success(reassignIds.length > 0 ? "Student reassigned successfully" : "Student enrolled successfully");
      } else {
        toast.success(`${total} students enrolled successfully`);
      }

      if (selectedClass) {
        handleSelectClass(selectedClass);
      }
      if (enrollTargetSection) {
        setGradeEnrollmentVersion((v) => v + 1);
      }
    } catch (err) {
      toast.error("Failed to enroll students. Please try again.");
      throw err;
    }
  };

  if (authLoading || institutionLoading || cm.loading || configLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
                <School className="w-6 h-6 text-primary-foreground" />
              </div>
              <div>
                <span className="text-xl font-display font-bold text-foreground">
                  Class Management
                </span>
                <p className="text-xs text-muted-foreground">
                  Manage grades, sections, and courses
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <InstructorHomeButton />
            {(isAdmin || isInstructor) && (
              <Button onClick={openCreateGrade}>
                <Plus className="w-4 h-4 mr-2" />
                {isGreekSchool ? "Add Grade Level" : "Add Grade"}
              </Button>
            )}
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-6 py-8">
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Sidebar */}
          <div className="lg:col-span-1">
            <GradeLevelSidebar
              classes={cm.classes}
              institutionId={institutionId}
              selectedGradeLevel={selectedGradeLevel}
              selectedClassId={selectedClass?.id || null}
              onSelectGradeLevel={handleSelectGradeLevel}
              onSelectClass={handleSelectClass}
              onCreateGradeLevel={openCreateGrade}
              onDeleteGradeLevel={handleDeleteGradeLevel}
              isAdmin={isAdmin}
            />
          </div>

          {/* Detail Panel */}
          <div className="lg:col-span-2">
            {/* Grade selected (both greek_school and generic) */}
            {selectedGradeLevel && !selectedClass && (
              <GradeLevelDetailPanel
                gradeLevel={selectedGradeLevel}
                gradeLevelId={gradeLevels.findIdByCode(selectedGradeLevel)}
                gradeSections={selectedGradeSections}
                institutionId={institutionId!}
                isAdmin={isAdmin}
                onSectionAdded={() => cm.fetchClasses()}
                onSectionRemoved={() => {
                  cm.fetchClasses();
                  // If the removed section was selected, clear
                  setSelectedClass(null);
                }}
                onSectionRenamed={() => cm.fetchClasses()}
                onSelectSection={handleSelectClass}
                onAttachCourseToGrade={() => handleOpenAttachCourse(true)}
                onCreateCourseForGrade={() => setCreateCourseOpen(true)}
                onEnrollStudentInSection={handleOpenEnrollStudentForSection}
                coursesVersion={gradeCoursesVersion}
                enrollmentVersion={gradeEnrollmentVersion}
                userId={user?.id}
                academicPeriod={academicPeriod}
              />
            )}

            {/* Any institution type: class/section selected */}
            {selectedClass && (
              <ClassDetailPanel
                selectedClass={selectedClass}
                classOfferings={classOfferings}
                classEnrollments={classEnrollments}
                loadingClassDetails={loadingClassDetails}
                isAdmin={isAdmin}
                onEnrollStudent={handleOpenEnrollStudent}
                onDetachCourse={handleDetachCourse}
                onRemoveInstructor={handleRemoveInstructor}
                onRemoveEnrollment={handleRemoveEnrollment}
                onDeleteClass={handleDeleteClass}
                onToggleClassActive={handleToggleClassActive}
                onToggleSelfEnrollment={handleToggleSelfEnrollment}
                institutionId={institutionId!}
                onInstructorAssigned={() => selectedClass && handleSelectClass(selectedClass)}
                institutionAcademicPeriod={academicPeriod}
              />
            )}

            {/* Nothing selected */}
            {!selectedClass && !selectedGradeLevel && (
              <Card>
                <CardContent className="py-16 text-center">
                  <School className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium mb-2">
                    {isGreekSchool ? "Select a Grade Level or Section" : "Select a Grade or Section"}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Choose a grade to manage sections and courses, or a section to manage enrollments
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>

      {/* Dialogs */}
      <CreateGradeLevelDialog
        open={createGradeLevelOpen}
        onOpenChange={setCreateGradeLevelOpen}
        schoolLevels={schoolLevels}
        existingGradeLevels={existingGradeLevels}
        onCreateGradeLevel={handleCreateGradeLevel}
      />

      <CreateGenericGradeDialog
        open={createGenericGradeOpen}
        onOpenChange={setCreateGenericGradeOpen}
        existingGradeLevels={existingGradeLevels}
        onCreateGradeLevel={handleCreateGradeLevel}
      />

      <AttachCourseDialog
        open={attachCourseOpen}
        onOpenChange={setAttachCourseOpen}
        availableCourses={availableCourses}
        targetName={
          attachCourseGradeMode && selectedGradeLevel
            ? `grade level`
            : selectedClass ? buildClassDisplayName(selectedClass) : "class"
        }
        institutionId={institutionId}
        gradeSections={attachCourseGradeMode ? selectedGradeSections : undefined}
        gradeLevel={attachCourseGradeMode ? selectedGradeLevel || undefined : undefined}
        onAttach={handleAttachCourse}
      />

      {selectedGradeLevel && (
        <CreateCourseDialog
          open={createCourseOpen}
          onOpenChange={setCreateCourseOpen}
          gradeLevel={selectedGradeLevel}
          gradeLevels={filterGradeOptionsBySchoolLevels(gradeLevels.options, schoolLevels)}
          defaultLanguage={defaultLanguage}
          categories={categoriesForGrade}
          onCreate={handleCreateCourseFromGrade}
        />
      )}

      {(() => {
        const enrollTarget = selectedClass || enrollTargetSection;
        const enrollTargetGradeCode = gradeLevels.findCodeById(
          enrollTarget?.grade_level_id,
        );
        return (
          <EnrollStudentDialog
            open={enrollStudentOpen}
            onOpenChange={(open) => {
              setEnrollStudentOpen(open);
              if (!open) setEnrollTargetSection(null);
            }}
            availableUsers={availableStudents}
            targetName={
              enrollTargetGradeCode && enrollTarget?.section_name
                ? `${gradeLevels.getLabel(enrollTargetGradeCode, "el")} ${getSectionDisplayName(enrollTargetGradeCode, enrollTarget.section_name)}${enrollTarget.category ? ` (${enrollTarget.category})` : ""}`
                : enrollTarget
                  ? buildClassDisplayName({
                      grade_level: enrollTargetGradeCode,
                      section_name: enrollTarget.section_name,
                      category: enrollTarget.category,
                      name: enrollTarget.name,
                    })
                  : "class"
            }
            institutionId={institutionId}
            classGradeLevel={enrollTargetGradeCode}
            classCategory={enrollTarget?.category}
            filterMode={studentFilterMode}
            onFilterModeChange={handleStudentFilterModeChange}
            onEnroll={handleEnrollStudent}
          />
        );
      })()}

    </div>
  );
};

export default ClassManagement;
