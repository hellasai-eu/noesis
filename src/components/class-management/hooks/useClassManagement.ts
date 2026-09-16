import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { buildClassDisplayName } from "@/lib/greek-school";

export interface ClassItem {
  id: string;
  name: string;
  academic_period: string | null;
  is_active: boolean;
  allow_self_enrollment: boolean;
  created_at: string;
  grade_level_id: string | null;
  section_name: string | null;
  category: string | null;
}

export interface ClassOfferingInstructor {
  user_id: string;
  full_name: string | null;
  email: string | null;
}

export interface ClassOffering {
  id: string;
  course_id: string;
  course_title: string;
  is_active: boolean;
  instructors: ClassOfferingInstructor[];
}

export interface ClassEnrollment {
  user_id: string;
  role: string;
  enrolled_at: string;
  full_name: string | null;
  email: string | null;
}

export interface Course {
  id: string;
  title: string;
}

export interface AvailableUser {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: string;
  current_class_id?: string | null;
  current_class_name?: string | null;
}

export type StudentFilterMode = "unassigned" | "same-grade" | "all";

export function useClassManagement(
  institutionId: string | null,
  userId: string | undefined,
  isAdmin: boolean,
  isInstructor: boolean,
) {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchClasses = useCallback(async () => {
    if (!institutionId) return;
    setLoading(true);
    try {
      let classesData: any[] = [];

      if (isAdmin) {
        const { data, error } = await supabase
          .from("classes")
          .select("*")
          .eq("institution_id", institutionId)
          .order("created_at", { ascending: false });
        if (error) throw error;
        classesData = data || [];
      } else if (isInstructor && userId) {
        // Derive instructor's classes from course_instructors -> offerings -> classes
        const { data: courseAssignments, error: ciError } = await supabase
          .from("course_instructors")
          .select("course_id")
          .eq("user_id", userId);
        if (ciError) throw ciError;

        const courseIds = (courseAssignments || []).map((ca) => ca.course_id);
        if (courseIds.length > 0) {
          const { data: offeringsData, error: ofError } = await supabase
            .from("offerings")
            .select("class_id, classes(*)")
            .in("course_id", courseIds);
          if (ofError) throw ofError;

          // Deduplicate classes and filter to current institution
          const seen = new Set<string>();
          classesData = (offeringsData || [])
            .map((o) => o.classes)
            .filter((c): c is NonNullable<typeof c> => {
              if (c === null || (c as any).institution_id !== institutionId) return false;
              if (seen.has((c as any).id)) return false;
              seen.add((c as any).id);
              return true;
            });
        }
      }

      setClasses(classesData);
    } catch (error: any) {
      console.error("Error fetching classes:", error);
      toast.error("Failed to load classes");
    } finally {
      setLoading(false);
    }
  }, [institutionId, isAdmin, isInstructor, userId]);

  useEffect(() => {
    if (institutionId) {
      fetchClasses();
    }
  }, [institutionId, fetchClasses]);

  // --- Class detail loading ---
  const fetchClassDetails = useCallback(
    async (cls: ClassItem) => {
      const { data: offeringsData, error: offeringsError } = await supabase
        .from("offerings")
        .select(
          `id, course_id, is_active, courses:course_id (title)`,
        )
        .eq("class_id", cls.id);

      if (offeringsError) throw offeringsError;

      const courseIds = (offeringsData || []).map((o: any) => o.course_id as string);

      // Fetch instructors for these courses, filtered by section restrictions
      const instructorsByCourse: Record<string, ClassOfferingInstructor[]> = {};
      if (courseIds.length > 0) {
        const { data: ciData, error: ciError } = await supabase
          .from("course_instructors")
          .select("course_id, user_id")
          .in("course_id", courseIds);

        if (ciError) console.warn("Failed to load course instructors", ciError);

        if (ciData && ciData.length > 0) {
          const userIds = [...new Set(ciData.map((ci) => ci.user_id))];
          const [{ data: profiles, error: profilesError }, { data: sectionData, error: sectionsError }] = await Promise.all([
            supabase.from("profiles").select("user_id, full_name, email").in("user_id", userIds),
            supabase.from("course_instructor_sections").select("course_id, user_id, class_id").in("course_id", courseIds),
          ]);

          if (profilesError) console.warn("Failed to load instructor profiles", profilesError);
          if (sectionsError) console.warn("Failed to load instructor sections", sectionsError);

          const profileMap = new Map((profiles || []).map((p) => [p.user_id, p]));

          // Build restriction map: "courseId-userId" -> class_id[]
          const restrictionMap = new Map<string, string[]>();
          for (const row of sectionData || []) {
            const key = `${row.course_id}-${row.user_id}`;
            const arr = restrictionMap.get(key) || [];
            arr.push(row.class_id);
            restrictionMap.set(key, arr);
          }

          const seenPerCourse = new Map<string, Set<string>>();
          for (const ci of ciData) {
            const restrictionKey = `${ci.course_id}-${ci.user_id}`;
            const restrictions = restrictionMap.get(restrictionKey) || [];
            // If restrictions exist and this class is NOT included, skip
            if (restrictions.length > 0 && !restrictions.includes(cls.id)) continue;

            // Deduplicate instructors per course
            if (!seenPerCourse.has(ci.course_id)) seenPerCourse.set(ci.course_id, new Set());
            if (seenPerCourse.get(ci.course_id)!.has(ci.user_id)) continue;
            seenPerCourse.get(ci.course_id)!.add(ci.user_id);

            if (!instructorsByCourse[ci.course_id]) instructorsByCourse[ci.course_id] = [];
            const profile = profileMap.get(ci.user_id);
            instructorsByCourse[ci.course_id].push({
              user_id: ci.user_id,
              full_name: profile?.full_name || null,
              email: profile?.email || null,
            });
          }
        }
      }

      const offerings: ClassOffering[] = (offeringsData || []).map((o: any) => ({
        id: o.id,
        course_id: o.course_id,
        course_title: o.courses?.title || "Unknown Course",
        is_active: o.is_active ?? true,
        instructors: instructorsByCourse[o.course_id] || [],
      }));

      const { data: enrollmentsData, error: enrollmentsError } = await supabase
        .from("class_enrollments")
        .select("user_id, role, enrolled_at")
        .eq("class_id", cls.id);

      if (enrollmentsError) throw enrollmentsError;

      let enrollments: ClassEnrollment[] = [];
      if (enrollmentsData && enrollmentsData.length > 0) {
        const userIds = enrollmentsData.map((e) => e.user_id);
        const { data: profilesData } = await supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", userIds);

        enrollments = enrollmentsData.map((e) => {
          const profile = profilesData?.find((p) => p.user_id === e.user_id);
          return {
            user_id: e.user_id,
            role: e.role,
            enrolled_at: e.enrolled_at,
            full_name: profile?.full_name || null,
            email: profile?.email || null,
          };
        });
      }

      return { offerings, enrollments };
    },
    [],
  );

  // --- Mutations ---
  const createClass = useCallback(
    async (opts: {
      name: string;
      academic_period?: string;
      grade_level_id?: string | null;
      section_name?: string;
      category?: string | null;
    }) => {
      if (!institutionId) throw new Error("No institution");

      const { data, error } = await supabase
        .from("classes")
        .insert({
          name: opts.name,
          academic_period: opts.academic_period || null,
          institution_id: institutionId,
          created_by: userId,
          grade_level_id: opts.grade_level_id ?? null,
          section_name: opts.section_name || null,
          category: opts.category || null,
        })
        .select()
        .single();

      if (error) throw error;

      return data;
    },
    [institutionId, userId],
  );

  const createClassesBatch = useCallback(
    async (
      items: {
        name: string;
        grade_level_id: string | null;
        section_name: string;
        category?: string | null;
      }[],
      academicPeriod?: string | null,
    ) => {
      if (!institutionId) throw new Error("No institution");

      const { data, error } = await supabase
        .from("classes")
        .insert(
          items.map((item) => ({
            name: item.name,
            institution_id: institutionId,
            created_by: userId,
            grade_level_id: item.grade_level_id ?? null,
            section_name: item.section_name,
            category: item.category || null,
            is_active: true,
            academic_period: academicPeriod || null,
          })),
        )
        .select();

      if (error) throw error;
      return data;
    },
    [institutionId, userId],
  );

  const createCourse = useCallback(
    async (courseData: {
      title: string;
      description: string;
      theme: string;
      language: string;
      grade_level_id: string | null;
      category?: string;
    }) => {
      if (!institutionId) throw new Error("No institution");

      const { data, error } = await supabase
        .from("courses")
        .insert({
          title: courseData.title,
          description: courseData.description || null,
          theme: courseData.theme || null,
          language: courseData.language,
          institution_id: institutionId,
          created_by: userId,
          grade_level_id: courseData.grade_level_id ?? null,
          category: courseData.category || "Default",
        })
        .select("id")
        .single();

      if (error) throw error;
      return data.id as string;
    },
    [institutionId, userId],
  );

  const attachCourse = useCallback(
    async (classId: string, courseId: string) => {
      const { error } = await supabase
        .from("offerings")
        .insert({ class_id: classId, course_id: courseId, is_active: true });
      if (error) throw error;
    },
    [],
  );

  const detachCourse = useCallback(async (offeringId: string) => {
    const { error } = await supabase.from("offerings").delete().eq("id", offeringId);
    if (error) throw error;
  }, []);

  const enrollUser = useCallback(
    async (classId: string, targetUserId: string, role: string) => {
      const { error } = await supabase
        .from("class_enrollments")
        .insert({ class_id: classId, user_id: targetUserId, role });
      if (error) throw error;
    },
    [],
  );

  const enrollUsers = useCallback(
    async (classId: string, targetUserIds: string[], role: string) => {
      if (role === "instructor") {
        throw new Error("Instructors must be assigned via course_instructors, not class_enrollments");
      }
      if (targetUserIds.length === 0) return;
      const { error } = await supabase
        .from("class_enrollments")
        .insert(targetUserIds.map((userId) => ({ class_id: classId, user_id: userId, role })));
      if (error) throw error;
    },
    [],
  );

  const removeEnrollment = useCallback(async (classId: string, targetUserId: string) => {
    const { error } = await supabase
      .from("class_enrollments")
      .delete()
      .eq("class_id", classId)
      .eq("user_id", targetUserId);
    if (error) throw error;
  }, []);

  const updateEnrollmentRole = useCallback(
    async (targetUserId: string, classId: string, newRole: string) => {
      const { error } = await supabase
        .from("class_enrollments")
        .update({ role: newRole })
        .eq("user_id", targetUserId)
        .eq("class_id", classId);
      if (error) throw error;
    },
    [],
  );

  const deleteClass = useCallback(async (classId: string) => {
    const { error } = await supabase.from("classes").delete().eq("id", classId);
    if (error) throw error;
  }, []);

  const deleteClassesBatch = useCallback(async (classIds: string[]) => {
    const { error } = await supabase.from("classes").delete().in("id", classIds);
    if (error) throw error;
  }, []);

  const toggleClassActive = useCallback(async (classId: string, newActive: boolean) => {
    const { error } = await supabase
      .from("classes")
      .update({ is_active: newActive })
      .eq("id", classId);
    if (error) throw error;
  }, []);

  const toggleSelfEnrollment = useCallback(async (classId: string, newValue: boolean) => {
    const { error } = await supabase
      .from("classes")
      .update({ allow_self_enrollment: newValue })
      .eq("id", classId);
    if (error) throw error;
  }, []);

  const fetchAvailableUsers = useCallback(
    async (
      classId: string,
      role: "student" | "instructor",
      enrolledUserIds: string[],
      filterMode: StudentFilterMode = "unassigned",
      classCategory?: string | null,
      classGradeLevelId?: string | null,
    ) => {
      if (!institutionId) return [];

      let query = supabase
        .from("user_institutions")
        .select("user_id, role")
        .eq("institution_id", institutionId)
        .eq("role", role);

      // Filter students by grade unless "all" mode — FK identity match on
      // grade_level_id (the TEXT column no longer exists after #799).
      if (role === "student" && filterMode !== "all" && classGradeLevelId) {
        query = query.eq("grade_level_id", classGradeLevelId);
      }

      const { data: usersData } = await query;

      if (!usersData || usersData.length === 0) return [];

      // In "unassigned" mode, exclude users enrolled in ANY class (not just this one)
      // In "same-grade" and "all" modes, only exclude users already in THIS class
      let excludeUserIds: string[];
      const enrollmentsByUser: Record<string, { class_id: string; class_name: string }> = {};

      if (filterMode === "unassigned") {
        // Fetch all student enrollments with class category to find who is assigned in the same category
        const allUserIds = usersData.map((u) => u.user_id);
        if (allUserIds.length > 0) {
          const { data: allEnrollments } = await supabase
            .from("class_enrollments")
            .select("user_id, class_id, classes:class_id(name, category)")
            .in("user_id", allUserIds)
            .eq("role", "student");

          // For named categories: exclude students enrolled in any class of the same category.
          // For NULL-category sections: preserve the original behavior and exclude all enrolled
          // students regardless of category. This avoids a mixed-category edge case where
          // students in named-category sections would incorrectly appear as "unassigned"
          // for uncategorised sections in schools that use both NULL and named categories.
          const enrolledInSameCategory = new Set(
            (allEnrollments || [])
              .filter((e) => {
                const cls = e.classes as any;
                if (!cls) return false;
                if (classCategory === null) return true; // NULL section: exclude any enrolled student
                return (cls.category ?? null) === classCategory;
              })
              .map((e) => e.user_id),
          );
          excludeUserIds = Array.from(enrolledInSameCategory);
        } else {
          excludeUserIds = [];
        }
      } else {
        // "same-grade" or "all": only exclude users already in THIS class
        excludeUserIds = enrolledUserIds;

        // Fetch current class assignments for these users to show indicator
        const candidateUserIds = usersData
          .filter((u) => !enrolledUserIds.includes(u.user_id))
          .map((u) => u.user_id);

        if (candidateUserIds.length > 0) {
          const { data: existingEnrollments } = await supabase
            .from("class_enrollments")
            .select("user_id, class_id, classes:class_id(name, grade_level_id, section_name, category)")
            .in("user_id", candidateUserIds)
            .eq("role", "student");

          for (const e of existingEnrollments || []) {
            const cls = e.classes as any;
            // Only flag as reassignment if the existing enrollment is in the same category
            const sameCategory = cls && (cls.category ?? null) === (classCategory ?? null);
            if (sameCategory && !enrollmentsByUser[e.user_id]) {
              enrollmentsByUser[e.user_id] = {
                class_id: e.class_id,
                class_name: cls ? buildClassDisplayName(cls) : "Unknown",
              };
            }
          }
        }
      }

      const availableUserIds = usersData
        .filter((u) => !excludeUserIds.includes(u.user_id))
        .map((u) => u.user_id);

      if (availableUserIds.length === 0) return [];

      const { data: profilesData } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", availableUserIds);

      return (profilesData || []).map((p) => {
        const enrollment = enrollmentsByUser[p.user_id];
        return {
          user_id: p.user_id,
          full_name: p.full_name,
          email: p.email,
          role,
          current_class_id: enrollment?.class_id || null,
          current_class_name: enrollment?.class_name || null,
        } as AvailableUser;
      });
    },
    [institutionId],
  );

  const reassignUser = useCallback(
    async (fromClassId: string, toClassId: string, targetUserId: string, role: string) => {
      if (role === "instructor") {
        throw new Error("Instructors must be assigned via course_instructors, not class_enrollments");
      }
      const { error: removeError } = await supabase
        .from("class_enrollments")
        .delete()
        .eq("class_id", fromClassId)
        .eq("user_id", targetUserId);
      if (removeError) throw removeError;

      const { error: insertError } = await supabase
        .from("class_enrollments")
        .insert({ class_id: toClassId, user_id: targetUserId, role });
      if (insertError) {
        // Compensating action: re-insert into original class to avoid data loss
        await supabase
          .from("class_enrollments")
          .insert({ class_id: fromClassId, user_id: targetUserId, role });
        throw insertError;
      }
    },
    [],
  );

  const fetchCourseInstructors = useCallback(
    async (courseIds: string[]) => {
      if (courseIds.length === 0) return {} as Record<string, { user_id: string; full_name: string | null; email: string | null }[]>;

      const { data: assignments } = await supabase
        .from("course_instructors")
        .select("course_id, user_id")
        .in("course_id", courseIds);

      if (!assignments || assignments.length === 0) return {} as Record<string, { user_id: string; full_name: string | null; email: string | null }[]>;

      const userIds = [...new Set(assignments.map((a) => a.user_id))];
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", userIds);

      const profileMap = new Map((profiles || []).map((p) => [p.user_id, p]));

      const result: Record<string, { user_id: string; full_name: string | null; email: string | null }[]> = {};
      for (const a of assignments) {
        if (!result[a.course_id]) result[a.course_id] = [];
        const profile = profileMap.get(a.user_id);
        result[a.course_id].push({
          user_id: a.user_id,
          full_name: profile?.full_name || null,
          email: profile?.email || null,
        });
      }
      return result;
    },
    [],
  );

  const removeCourseInstructor = useCallback(
    async (courseId: string, userId: string, classId: string) => {
      // Check if this instructor has section restrictions for this course.
      // Presence of rows means they are restricted to specific classes;
      // absence means they are globally assigned to the course.
      const { data: sectionData, error: sectionError } = await supabase
        .from("course_instructor_sections")
        .select("class_id")
        .eq("course_id", courseId)
        .eq("user_id", userId);

      if (sectionError) throw sectionError;

      if (sectionData && sectionData.length > 0) {
        // Section-restricted: remove only this class's restriction row
        const { error } = await supabase
          .from("course_instructor_sections")
          .delete()
          .eq("course_id", courseId)
          .eq("user_id", userId)
          .eq("class_id", classId);
        if (error) throw error;

        // If this was the only restriction, also remove the global assignment
        // to avoid the instructor becoming unrestricted (visible everywhere).
        const remainingRestrictions = sectionData.filter(
          (r) => r.class_id !== classId,
        );
        if (remainingRestrictions.length === 0) {
          const { error: ciError } = await supabase
            .from("course_instructors")
            .delete()
            .eq("course_id", courseId)
            .eq("user_id", userId);
          if (ciError) throw ciError;
        }
      } else {
        // Globally assigned: remove the global course_instructors row
        const { error } = await supabase
          .from("course_instructors")
          .delete()
          .eq("course_id", courseId)
          .eq("user_id", userId);
        if (error) throw error;
      }
    },
    [],
  );

  const fetchAvailableCourses = useCallback(
    async (attachedCourseIds: string[]) => {
      if (!institutionId) return [];

      const { data: coursesData } = await supabase
        .from("courses")
        .select("id, title, grade_level_id")
        .eq("institution_id", institutionId)
        .order("title");

      return (coursesData || [])
        .filter((c) => !attachedCourseIds.includes(c.id));
    },
    [institutionId],
  );

  return {
    classes,
    setClasses,
    loading,
    fetchClasses,
    fetchClassDetails,
    createClass,
    createClassesBatch,
    createCourse,
    attachCourse,
    detachCourse,
    enrollUser,
    enrollUsers,
    reassignUser,
    removeEnrollment,
    updateEnrollmentRole,
    deleteClass,
    deleteClassesBatch,
    toggleClassActive,
    toggleSelfEnrollment,
    fetchAvailableUsers,
    fetchAvailableCourses,
    fetchCourseInstructors,
    removeCourseInstructor,
  };
}
