import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { TablesUpdate } from "@/integrations/supabase/types";
import {
  buildClassDisplayName,
} from "@/lib/greek-school";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import { filterGradeOptionsBySchoolLevels } from "@/lib/grade-levels";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { InlineGradeSelector } from "@/components/InlineGradeSelector";
import { StudentNotesDialog } from "@/components/StudentNotesDialog";
import { ResetUserPasswordDialog } from "@/components/ResetUserPasswordDialog";
import { RemoveUserMfaDialog } from "@/components/RemoveUserMfaDialog";
import { BulkImportDialog, type BulkImportRole } from "@/components/BulkImportDialog";
import {
  BookOpen,
  ArrowLeft,
  Users,
  Mail,
  Loader2,
  Trash2,
  RefreshCw,
  X,
  CheckCircle,
  Clock,
  Plus,
  PauseCircle,
  Scale,
  PlayCircle,
  User,
  Shield,
  GraduationCap,
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  UserPlus,
  ChevronDown,
  Key,
  Upload,
  School,
  StickyNote,
  ClipboardCheck,
  ShieldOff,
} from "lucide-react";
import { toast } from "sonner";
import { useFormatters } from "@/i18n/formatters";

interface ClassEnrollment {
  class_id: string;
  class_name: string;
  role: string;
  category: string | null;
}

interface UserProfile {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: string;
  is_suspended: boolean;
  created_at: string;
  status?: string;
  isPending?: boolean;
  invitationId?: string;
  institution_role?: string; // Role in the current institution
  grade_level_id?: string | null;
  user_institution_id?: string;
  last_sign_in_at?: string | null;
  auth_created_at?: string | null;
  father_name?: string | null;
  date_of_birth?: string | null;
}

interface Institution {
  id: string;
  name: string;
  slug: string;
  school_levels: string[];
}

interface Invitation {
  id: string;
  email: string;
  status: string;
  role: string;
  created_at: string;
  invited_name?: string | null;
  invited_class_id?: string | null;
}

interface Class {
  id: string;
  name: string;
  is_active: boolean | null;
  section_name: string | null;
  grade_level_id: string | null;
  category: string | null;
}

interface Course {
  id: string;
  title: string;
  grade_level_id: string | null;
}

const UserManagement = () => {
  const { compareText, formatDate } = useFormatters();
  const navigate = useNavigate();
  const { user, profile, loading } = useAuth();
  
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [institution, setInstitution] = useState<Institution | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [superAdminUserIds, setSuperAdminUserIds] = useState<Set<string>>(new Set());

  // Get effective institution ID from session storage
  const getEffectiveInstitutionId = () => {
    return sessionStorage.getItem("selectedInstitutionId");
  };

  const effectiveInstitutionId = getEffectiveInstitutionId();
  const institutionGradeLevels = useInstitutionGradeLevels(effectiveInstitutionId);
  // Restrict the grade-level dropdowns to the institution's own school levels.
  // The backfill seeds `grade_levels` rows across every school level, so the
  // institution-scoped list alone still shows e.g. Δημοτικού grades to a
  // Λύκειο-only school. Re-apply the school-level filter that #459 introduced
  // and #797/#798 dropped (see #825).
  const filteredGradeOptions = useMemo(
    () =>
      filterGradeOptionsBySchoolLevels(
        institutionGradeLevels.options,
        institution?.school_levels,
      ),
    [institutionGradeLevels.options, institution?.school_levels],
  );
  // Grade_level ids actually in use by the institution's classes — passed to
  // InlineGradeSelector so each row's dropdown lists only grades that can
  // match a section (see #805). Distinct-by-id in insertion order.
  const institutionGradeLevelIdsInUse = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const cls of classes) {
      const id = cls.grade_level_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids.length > 0 ? ids : null;
  }, [classes]);


  // Invite form
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("student");
  const [inviteGradeLevel, setInviteGradeLevel] = useState<string>("");
  const [inviteCourseIds, setInviteCourseIds] = useState<Set<string>>(new Set());
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [isInviting, setIsInviting] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  
  // Direct user creation form
  const [createUserDialogOpen, setCreateUserDialogOpen] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createRole, setCreateRole] = useState<string>("student");
  // Evaluator course scope for the direct-create flow (mirrors inviteCourseIds).
  const [createCourseIds, setCreateCourseIds] = useState<Set<string>>(new Set());
  const [createGradeLevel, setCreateGradeLevel] = useState<string>("");
  const [createFatherName, setCreateFatherName] = useState("");
  const [createDateOfBirth, setCreateDateOfBirth] = useState("");
  const [isCreatingUser, setIsCreatingUser] = useState(false);
  
  // Active tab tracking
  const [activeTab, setActiveTab] = useState<string>("students");

  // Search and filter
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [classFilter, setClassFilter] = useState<string>("all");
  const [instructorGradesMap, setInstructorGradesMap] = useState<Record<string, string[]>>({});
  const [userEnrollmentsMap, setUserEnrollmentsMap] = useState<Record<string, ClassEnrollment[]>>({});
  const [instructorCoursesMap, setInstructorCoursesMap] = useState<Record<string, { course_id: string; course_title: string; grade_level_id: string | null }[]>>({});
  const [evaluatorCoursesMap, setEvaluatorCoursesMap] = useState<Record<string, { course_id: string; course_title: string; grade_level_id: string | null }[]>>({});
  const [invitationCoursesMap, setInvitationCoursesMap] = useState<Record<string, { course_id: string; course_title: string; grade_level_id: string | null }[]>>({});
  const [confirmingRemoveEvaluatorCourse, setConfirmingRemoveEvaluatorCourse] = useState<string | null>(null);
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  
  // Edit name dialog
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [editName, setEditName] = useState("");
  const [editFatherName, setEditFatherName] = useState("");
  const [editDateOfBirth, setEditDateOfBirth] = useState("");
  const [isSavingName, setIsSavingName] = useState(false);
  
  // Invitation status filter and search
  const [invitationStatusFilter, setInvitationStatusFilter] = useState<string>("all");
  const [invitationSearchQuery, setInvitationSearchQuery] = useState("");

  const [confirmingRemoveEnrollment, setConfirmingRemoveEnrollment] = useState<string | null>(null);

  // Student notes dialog
  const [notesDialogTarget, setNotesDialogTarget] = useState<UserProfile | null>(null);
  const [notesCountsMap, setNotesCountsMap] = useState<Record<string, { total: number; recent: number }>>({});
  const [resetPasswordTarget, setResetPasswordTarget] = useState<UserProfile | null>(null);
  const [mfaResetTarget, setMfaResetTarget] = useState<UserProfile | null>(null);

  // Bulk import
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkImportRole, setBulkImportRole] = useState<BulkImportRole>("student");

  const NOTES_RECENT_DAYS = 14;

  // Check super admin and access
  useEffect(() => {
    const checkAccess = async () => {
      if (!user) return;
      
      const { data: superAdminData } = await supabase.rpc("is_super_admin", {
        _user_id: user.id,
      });
      setIsSuperAdmin(superAdminData || false);
      
      const instId = getEffectiveInstitutionId();
      if (!instId) {
        navigate("/select-institution");
        return;
      }
      
      // Check if user is admin of this institution
      const { data: isAdmin } = await supabase.rpc("is_institution_admin", {
        _user_id: user.id,
        _institution_id: instId,
      });
      
      if (!isAdmin && !superAdminData) {
        navigate("/dashboard");
        toast.error("Access denied. Admins only.");
      }
    };
    
    if (!loading && !user) {
      navigate("/auth");
    } else if (user) {
      checkAccess();
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    const instId = getEffectiveInstitutionId();
    if (instId && user) {
      fetchData(instId);
    }
  }, [effectiveInstitutionId, user]);

  const fetchData = async (institutionId: string) => {
    if (!institutionId) return;

    try {
      // Fetch institution
      const { data: instData } = await supabase
        .from("institutions")
        .select("*")
        .eq("id", institutionId)
        .maybeSingle();

      if (instData) {
        setInstitution(instData);
      }

      // Fetch users in this institution via user_institutions join
      const { data: membershipData } = await supabase
        .from("user_institutions")
        .select("id, user_id, role, is_suspended, created_at, grade_level_id")
        .eq("institution_id", institutionId);
      
      if (membershipData && membershipData.length > 0) {
        // Get profile details for each user
        const userIds = membershipData.map(m => m.user_id);
        const { data: profilesData } = await supabase
          .from("profiles")
          .select("*")
          .in("user_id", userIds);
        
        if (profilesData) {
          // Fetch auth info for each user
          const authInfoPromises = profilesData.map(async (p) => {
            const { data: authData } = await supabase.rpc("get_user_auth_info", {
              _user_id: p.user_id,
            });
            return {
              user_id: p.user_id,
              last_sign_in_at: authData?.[0]?.last_sign_in_at || null,
              auth_created_at: authData?.[0]?.auth_created_at || null,
            };
          });
          
          const authInfoResults = await Promise.all(authInfoPromises);
          const authInfoMap = Object.fromEntries(
            authInfoResults.map(a => [a.user_id, a])
          );

          // Merge profile data with institution role and auth info
          const mergedUsers = profilesData.map(p => {
            const membership = membershipData.find(m => m.user_id === p.user_id);
            const authInfo = authInfoMap[p.user_id];
            return {
              ...p,
              institution_role: membership?.role || 'student',
              role: membership?.role || 'student',
              is_suspended: membership?.is_suspended || false,
              grade_level_id: membership?.grade_level_id || null,
              user_institution_id: membership?.id,
              last_sign_in_at: authInfo?.last_sign_in_at,
              auth_created_at: authInfo?.auth_created_at,
            };
          });

          // Check which users are super admins and filter them out
          const superAdminCheckPromises = mergedUsers.map(async (u) => {
            const { data: isSuperAdminUser } = await supabase.rpc("is_super_admin", {
              _user_id: u.user_id,
            });
            return { user_id: u.user_id, isSuperAdmin: isSuperAdminUser || false };
          });

          const superAdminResults = await Promise.all(superAdminCheckPromises);
          const superAdminIds = new Set(
            superAdminResults.filter(r => r.isSuperAdmin).map(r => r.user_id)
          );
          setSuperAdminUserIds(superAdminIds);

          // Filter out super admin users from the list
          const nonSuperAdminUsers = mergedUsers.filter(u => !superAdminIds.has(u.user_id));
          setUsers(nonSuperAdminUsers);
          setInstructorGradesMap({});

          if (userIds.length > 0) {
            // Fetch instructor grades from junction table
            const instructorMembers = membershipData.filter(m => m.role === "instructor");
            if (instructorMembers.length > 0) {
              const instructorUiIds = instructorMembers.map(m => m.id);
              const { data: gradesData } = await supabase
                .from("user_institution_grades")
                .select("user_institution_id, grade_level_id, grade_levels:grade_level_id(code)")
                .in("user_institution_id", instructorUiIds);

              if (gradesData) {
                // Build a map from user_institution_id -> user_id for reverse lookup
                const uiIdToUserId: Record<string, string> = {};
                instructorMembers.forEach(m => { uiIdToUserId[m.id] = m.user_id; });

                const gradesMap: Record<string, string[]> = {};
                gradesData.forEach((g: any) => {
                  const uid = uiIdToUserId[g.user_institution_id];
                  const code = g.grade_levels?.code;
                  if (uid && code) {
                    if (!gradesMap[uid]) gradesMap[uid] = [];
                    gradesMap[uid].push(code);
                  }
                });
                setInstructorGradesMap(gradesMap);
              }
            }

            // Fetch class enrollments for students only
            const { data: enrollmentsData } = await supabase
              .from("class_enrollments")
              .select(`
                user_id,
                role,
                class_id,
                classes!inner(id, name, grade_level_id, section_name, category, institution_id)
              `)
              .in("user_id", userIds)
              .eq("classes.institution_id", institutionId)
              .eq("role", "student");

            if (enrollmentsData) {
              const enrollmentsMap: Record<string, ClassEnrollment[]> = {};
              enrollmentsData.forEach((enrollment: any) => {
                const userId = enrollment.user_id;
                if (!enrollmentsMap[userId]) {
                  enrollmentsMap[userId] = [];
                }
                const cls = enrollment.classes;
                const displayName = buildClassDisplayName(cls);
                enrollmentsMap[userId].push({
                  class_id: enrollment.class_id,
                  class_name: displayName,
                  role: enrollment.role,
                  category: cls?.category ?? null,
                });
              });
              setUserEnrollmentsMap(enrollmentsMap);
            }

            // Fetch admin-note counts for students in this institution (RLS scopes per role).
            const studentUserIdsForNotes = membershipData
              .filter(m => m.role === "student")
              .map(m => m.user_id);
            if (studentUserIdsForNotes.length > 0) {
              const { data: noteRows } = await supabase
                .from("student_admin_notes" as any)
                .select("student_user_id, created_at")
                .eq("institution_id", institutionId)
                .in("student_user_id", studentUserIdsForNotes);
              if (noteRows) {
                const recentCutoff = Date.now() - NOTES_RECENT_DAYS * 24 * 60 * 60 * 1000;
                const counts: Record<string, { total: number; recent: number }> = {};
                for (const row of noteRows as any[]) {
                  const sid = row.student_user_id as string;
                  if (!counts[sid]) counts[sid] = { total: 0, recent: 0 };
                  counts[sid].total += 1;
                  if (new Date(row.created_at).getTime() >= recentCutoff) {
                    counts[sid].recent += 1;
                  }
                }
                setNotesCountsMap(counts);
              }
            }

            // Fetch course assignments for instructors
            const instructorUserIds = membershipData
              .filter(m => m.role === "instructor")
              .map(m => m.user_id);
            if (instructorUserIds.length > 0) {
              const { data: courseAssignments } = await supabase
                .from("course_instructors")
                .select("user_id, course_id, courses:course_id(title, grade_level_id)")
                .in("user_id", instructorUserIds);

              if (courseAssignments) {
                const coursesMap: Record<string, { course_id: string; course_title: string; grade_level_id: string | null }[]> = {};
                courseAssignments.forEach((ca: any) => {
                  if (!coursesMap[ca.user_id]) coursesMap[ca.user_id] = [];
                  coursesMap[ca.user_id].push({
                    course_id: ca.course_id,
                    course_title: ca.courses?.title || "Unknown",
                    grade_level_id: ca.courses?.grade_level_id || null,
                  });
                });
                setInstructorCoursesMap(coursesMap);
              }
            }

            // Fetch course assignments for evaluators
            const evaluatorUserIds = membershipData
              .filter(m => m.role === "evaluator")
              .map(m => m.user_id);
            if (evaluatorUserIds.length > 0) {
              const { data: evaluatorAssignments } = await supabase
                .from("course_evaluators")
                .select("user_id, course_id, courses:course_id(title, grade_level_id, institution_id)")
                .in("user_id", evaluatorUserIds);

              if (evaluatorAssignments) {
                const evalMap: Record<string, { course_id: string; course_title: string; grade_level_id: string | null }[]> = {};
                evaluatorAssignments.forEach((ea: any) => {
                  // Scope to the current institution (RLS will already filter cross-institution rows
                  // unless the admin is a member elsewhere; this is the belt-and-braces guard).
                  if (ea.courses?.institution_id && ea.courses.institution_id !== institutionId) return;
                  if (!evalMap[ea.user_id]) evalMap[ea.user_id] = [];
                  evalMap[ea.user_id].push({
                    course_id: ea.course_id,
                    course_title: ea.courses?.title || "Unknown",
                    grade_level_id: ea.courses?.grade_level_id || null,
                  });
                });
                setEvaluatorCoursesMap(evalMap);
              }
            }
          }
        }
      } else {
        setUsers([]);
      }

      // Fetch invitations
      const { data: invData } = await supabase
        .from("invitations")
        .select("*")
        .eq("institution_id", institutionId)
        .order("created_at", { ascending: false });

      if (invData) {
        setInvitations(invData.map(inv => ({
          ...inv,
          invited_class_id: inv.invited_class_id || null,
        })));

        // Fetch course scopes for pending evaluator invitations so the admin
        // sees which courses each invite is targeted at.
        const evaluatorInvitationIds = invData
          .filter(inv => inv.role === "evaluator" && inv.status === "pending")
          .map(inv => inv.id);
        if (evaluatorInvitationIds.length > 0) {
          const { data: invCoursesData } = await supabase
            .from("invitation_courses")
            .select("invitation_id, course_id, courses:course_id(title, grade_level_id)")
            .in("invitation_id", evaluatorInvitationIds);
          if (invCoursesData) {
            const map: Record<string, { course_id: string; course_title: string; grade_level_id: string | null }[]> = {};
            invCoursesData.forEach((ic: any) => {
              if (!map[ic.invitation_id]) map[ic.invitation_id] = [];
              map[ic.invitation_id].push({
                course_id: ic.course_id,
                course_title: ic.courses?.title || "Unknown",
                grade_level_id: ic.courses?.grade_level_id || null,
              });
            });
            setInvitationCoursesMap(map);
          }
        }
      }

      // Fetch classes for the institution
      const { data: classesData } = await supabase
        .from("classes")
        .select("id, name, is_active, section_name, grade_level_id, category")
        .eq("institution_id", institutionId)
        .order("name");

      if (classesData) {
        setClasses(classesData);
      }

      // Fetch courses for the institution (used by the evaluator invite picker
      // and the per-evaluator course-assignment management UI).
      const { data: coursesData } = await supabase
        .from("courses")
        .select("id, title, grade_level_id")
        .eq("institution_id", institutionId)
        .order("title");

      if (coursesData) {
        setCourses(coursesData);
      }
    } catch (error) {
      console.error("Error fetching data:", error);
    } finally {
      setLoadingData(false);
    }
  };

  const handleInviteUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const instId = getEffectiveInstitutionId();
    if (!instId) return;

    if (inviteRole === "evaluator" && inviteCourseIds.size === 0) {
      toast.error("Pick at least one course to scope the evaluator to");
      return;
    }

    setIsInviting(true);

    try {
      // Check if user already exists in this institution
      const existingUser = users.find(
        (u) => u.email?.toLowerCase() === inviteEmail.toLowerCase()
      );

      if (existingUser) {
        toast.error("This user is already a member of your institution");
        setIsInviting(false);
        return;
      }

      // Check if there's already an accepted invitation for this email
      const acceptedInvitation = invitations.find(
        (inv) => inv.email.toLowerCase() === inviteEmail.toLowerCase() && inv.status === "accepted"
      );

      if (acceptedInvitation) {
        toast.error("This user has already accepted an invitation to your institution");
        setIsInviting(false);
        return;
      }

      // Check if there's already a pending invitation for this email
      const existingInvitation = invitations.find(
        (inv) => inv.email.toLowerCase() === inviteEmail.toLowerCase() && inv.status === "pending"
      );

      if (existingInvitation) {
        toast.error("A pending invitation already exists for this email. Use resend instead.");
        setIsInviting(false);
        return;
      }

      const invitedGradeLevel =
        inviteRole === "student" && inviteGradeLevel ? inviteGradeLevel : null;
      const invitedGradeLevelId = invitedGradeLevel
        ? institutionGradeLevels.findIdByCode(invitedGradeLevel)
        : null;
      const { data, error } = await supabase
        .from("invitations")
        .insert({
          email: inviteEmail,
          invited_name: inviteName || null,
          institution_id: effectiveInstitutionId,
          invited_by: user?.id,
          role: inviteRole,
          invited_class_id: null,
          invited_grade_level_id: invitedGradeLevelId,
        })
        .select()
        .single();

      if (error) throw error;

      // For evaluator invites, persist the chosen course scope. If this fails,
      // roll back the invitation so the admin can retry instead of being left
      // with a scopeless evaluator invite.
      if (inviteRole === "evaluator" && inviteCourseIds.size > 0) {
        const courseRows = Array.from(inviteCourseIds).map((course_id) => ({
          invitation_id: data.id,
          course_id,
        }));
        const { error: scopeError } = await supabase
          .from("invitation_courses")
          .insert(courseRows);
        if (scopeError) {
          await supabase.from("invitations").delete().eq("id", data.id);
          throw scopeError;
        }
      }

      // Send invitation email (also auto-adds existing users)
      const { data: emailResult, error: emailError } = await supabase.functions.invoke("send-invitation", {
        body: {
          email: inviteEmail,
          invitedName: inviteName || undefined,
          institutionId: effectiveInstitutionId,
          institutionName: institution?.name || "Your Institution",
          inviterName: profile?.full_name || profile?.email || "An administrator",
          invitationId: data.id,
          role: inviteRole,
          invitedClassId: undefined,
        },
      });

      if (emailError) {
        console.error("Failed to send email:", emailError);
        toast.warning("Invitation created but email may not have been sent");
        setInvitations([{ ...data, invited_class_id: data.invited_class_id || null }, ...invitations]);
      } else if (emailResult?.autoAdded) {
        // User already existed and was auto-added
        toast.success(`${inviteEmail} has been added to the institution`);
        // Update invitation status to accepted and refresh data
        setInvitations([{ ...data, status: "accepted", invited_class_id: data.invited_class_id || null }, ...invitations]);
        // Refresh user list to show the new member
        fetchData(instId);
      } else {
        toast.success(`Invitation email sent to ${inviteEmail}`);
        setInvitations([{ ...data, invited_class_id: data.invited_class_id || null }, ...invitations]);
      }

      // Persist invitation_courses to local state so the pending invite renders
      // its course scope immediately (no refetch round-trip).
      if (inviteRole === "evaluator" && inviteCourseIds.size > 0) {
        const chosen = courses
          .filter(c => inviteCourseIds.has(c.id))
          .map(c => ({ course_id: c.id, course_title: c.title, grade_level_id: c.grade_level_id }));
        setInvitationCoursesMap(prev => ({ ...prev, [data.id]: chosen }));
      }

      setInviteDialogOpen(false);
      setInviteEmail("");
      setInviteName("");
      setInviteRole("student");
      setInviteGradeLevel("");
      setInviteCourseIds(new Set());
    } catch (error: any) {
      toast.error(error.message || "Failed to send invitation");
    } finally {
      setIsInviting(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const instId = getEffectiveInstitutionId();
    if (!instId) return;

    if (createPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }

    if (createRole === "evaluator" && createCourseIds.size === 0) {
      toast.error("Pick at least one course to scope the evaluator to");
      return;
    }

    setIsCreatingUser(true);

    try {
      // Check if user already exists in this institution
      const existingUser = users.find(
        (u) => u.email?.toLowerCase() === createEmail.toLowerCase()
      );
      
      if (existingUser) {
        toast.error("This user is already a member of your institution");
        setIsCreatingUser(false);
        return;
      }

      const createGradeLevelValue =
        createRole === "student" && createGradeLevel ? createGradeLevel : null;
      const createGradeLevelIdValue = createGradeLevelValue
        ? institutionGradeLevels.findIdByCode(createGradeLevelValue)
        : null;
      const { data, error } = await supabase.functions.invoke("create-user", {
        body: {
          email: createEmail,
          password: createPassword,
          fullName: createName || null,
          institutionId: instId,
          role: createRole,
          classId: null,
          gradeLevel: createGradeLevelValue,
          gradeLevelId: createGradeLevelIdValue,
          fatherName: createRole === "student" && createFatherName ? createFatherName : null,
          dateOfBirth: createRole === "student" && createDateOfBirth ? createDateOfBirth : null,
          // Scope an evaluator to the chosen courses (the edge function writes
          // course_evaluators after creating the account).
          courseIds: createRole === "evaluator" ? Array.from(createCourseIds) : undefined,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast.success(`User ${createEmail} created successfully`);
      setCreateUserDialogOpen(false);
      setCreateEmail("");
      setCreateName("");
      setCreatePassword("");
      setCreateRole("student");
      setCreateCourseIds(new Set());
      setCreateGradeLevel("");
      setCreateFatherName("");
      setCreateDateOfBirth("");

      // Refresh data
      fetchData(instId);
    } catch (error: any) {
      toast.error(error.message || "Failed to create user");
    } finally {
      setIsCreatingUser(false);
    }
  };

  const handleCancelInvitation = async (invitationId: string) => {
    if (!confirm("Are you sure you want to cancel this invitation?")) return;
    
    setCancellingId(invitationId);
    try {
      const { error } = await supabase
        .from("invitations")
        .delete()
        .eq("id", invitationId);

      if (error) throw error;

      setInvitations(invitations.filter((inv) => inv.id !== invitationId));
      setInvitationCoursesMap(prev => {
        const next = { ...prev };
        delete next[invitationId];
        return next;
      });
      toast.success("Invitation cancelled");
    } catch (error: any) {
      toast.error(error.message || "Failed to cancel invitation");
    } finally {
      setCancellingId(null);
    }
  };

  const handleResendInvitation = async (invitation: Invitation) => {
    setResendingId(invitation.id);
    try {
      const { error: emailError } = await supabase.functions.invoke("send-invitation", {
        body: {
          email: invitation.email,
          institutionId: effectiveInstitutionId,
          institutionName: institution?.name || "Your Institution",
          inviterName: profile?.full_name || profile?.email || "An administrator",
          invitationId: invitation.id,
        },
      });

      if (emailError) throw emailError;

      toast.success(`Invitation resent to ${invitation.email}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to resend invitation");
    } finally {
      setResendingId(null);
    }
  };

  const handleRemoveUser = async (userProfile: UserProfile) => {
    if (userProfile.user_id === user?.id) {
      toast.error("You cannot remove yourself");
      return;
    }

    if (!confirm(`Are you sure you want to remove ${userProfile.full_name || userProfile.email}?`)) return;

    try {
      // Remove user from institution by deleting their user_institutions entry
      const { error } = await supabase
        .from("user_institutions")
        .delete()
        .eq("user_id", userProfile.user_id)
        .eq("institution_id", effectiveInstitutionId);

      if (error) throw error;

      // Also delete any invitations for this email so they can be re-invited
      if (userProfile.email) {
        await supabase
          .from("invitations")
          .delete()
          .eq("email", userProfile.email)
          .eq("institution_id", effectiveInstitutionId);

        // Update local invitations state
        setInvitations(invitations.filter((inv) => inv.email.toLowerCase() !== userProfile.email?.toLowerCase()));
      }

      setUsers(users.filter((u) => u.id !== userProfile.id));
      toast.success("User removed from institution");
    } catch (error: any) {
      toast.error(error.message || "Failed to remove user");
    }
  };

  const handleToggleUserStatus = async (userProfile: UserProfile) => {
    if (userProfile.user_id === user?.id) {
      toast.error("You cannot suspend yourself");
      return;
    }

    const newSuspended = !userProfile.is_suspended;
    const action = newSuspended ? "suspend" : "reactivate";

    try {
      const { error } = await supabase
        .from("user_institutions")
        .update({ is_suspended: newSuspended })
        .eq("user_id", userProfile.user_id)
        .eq("institution_id", effectiveInstitutionId);

      if (error) throw error;

      setUsers(users.map((u) =>
        u.id === userProfile.id ? { ...u, is_suspended: newSuspended } : u
      ));
      toast.success(`User ${action}d successfully`);
    } catch (error: any) {
      toast.error(error.message || `Failed to ${action} user`);
    }
  };

  const handleAddEnrollment = async (userId: string, classId: string, role: string) => {
    if (role === "instructor") {
      toast.error("Instructor course assignments are managed on the Classes page");
      return;
    }
    try {
      const { error } = await supabase
        .from("class_enrollments")
        .insert({ user_id: userId, class_id: classId, role });
      if (error) throw error;
      const cls = classes.find(c => c.id === classId);
      const displayName = buildClassDisplayName(cls);
      setUserEnrollmentsMap(prev => ({
        ...prev,
        [userId]: [...(prev[userId] || []), {
          class_id: classId,
          class_name: displayName,
          role,
          category: cls?.category ?? null,
        }],
      }));
      toast.success(`Added to ${displayName}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to add class enrollment");
    }
  };

  const handleRemoveEnrollment = async (userId: string, classId: string, className: string) => {
    const key = `${userId}-${classId}`;
    if (confirmingRemoveEnrollment !== key) {
      setConfirmingRemoveEnrollment(key);
      return;
    }
    setConfirmingRemoveEnrollment(null);
    try {
      const { error } = await supabase
        .from("class_enrollments")
        .delete()
        .eq("user_id", userId)
        .eq("class_id", classId);
      if (error) throw error;
      setUserEnrollmentsMap(prev => ({
        ...prev,
        [userId]: (prev[userId] || []).filter(e => e.class_id !== classId),
      }));
      toast.success(`Removed from ${className}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to remove class enrollment");
    }
  };

  const handleAddEvaluatorCourse = async (userId: string, courseId: string) => {
    try {
      const { error } = await supabase
        .from("course_evaluators")
        .insert({ user_id: userId, course_id: courseId });
      if (error) throw error;
      const course = courses.find(c => c.id === courseId);
      setEvaluatorCoursesMap(prev => ({
        ...prev,
        [userId]: [
          ...(prev[userId] || []),
          {
            course_id: courseId,
            course_title: course?.title || "Unknown",
            grade_level_id: course?.grade_level_id || null,
          },
        ],
      }));
      toast.success(`Assigned to ${course?.title || "course"}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to assign course");
    }
  };

  const handleRemoveEvaluatorCourse = async (userId: string, courseId: string, courseTitle: string) => {
    const key = `${userId}-${courseId}`;
    if (confirmingRemoveEvaluatorCourse !== key) {
      setConfirmingRemoveEvaluatorCourse(key);
      return;
    }
    setConfirmingRemoveEvaluatorCourse(null);
    try {
      const { error } = await supabase
        .from("course_evaluators")
        .delete()
        .eq("user_id", userId)
        .eq("course_id", courseId);
      if (error) throw error;
      setEvaluatorCoursesMap(prev => ({
        ...prev,
        [userId]: (prev[userId] || []).filter(c => c.course_id !== courseId),
      }));
      toast.success(`Unassigned from ${courseTitle}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to unassign course");
    }
  };

  const handleChangeRole = async (userProfile: UserProfile, newRole: string) => {
    if (userProfile.user_id === user?.id) {
      toast.error("You cannot change your own role");
      return;
    }

    if (newRole === userProfile.role) return;

    if (newRole === "evaluator") {
      toast.error("To make a user an evaluator, invite them with that role so you can pick the courses they will review.");
      return;
    }

    try {
      // 1. Update institution role
      const { error } = await supabase
        .from("user_institutions")
        .update({ role: newRole })
        .eq("user_id", userProfile.user_id)
        .eq("institution_id", effectiveInstitutionId);

      if (error) throw error;

      // 2. If changing FROM student, remove their class_enrollments
      if (userProfile.role === "student") {
        const { data: institutionClasses } = await supabase
          .from("classes")
          .select("id")
          .eq("institution_id", effectiveInstitutionId);

        if (institutionClasses && institutionClasses.length > 0) {
          const classIds = institutionClasses.map(c => c.id);
          await supabase
            .from("class_enrollments")
            .delete()
            .eq("user_id", userProfile.user_id)
            .in("class_id", classIds);
        }
        // Clear local enrollment state
        setUserEnrollmentsMap(prev => {
          const next = { ...prev };
          delete next[userProfile.user_id];
          return next;
        });
      }

      // If changing FROM evaluator, remove their course_evaluators scoped to
      // this institution so they lose read access immediately.
      if (userProfile.role === "evaluator") {
        const { data: institutionCourses } = await supabase
          .from("courses")
          .select("id")
          .eq("institution_id", effectiveInstitutionId);

        if (institutionCourses && institutionCourses.length > 0) {
          const courseIds = institutionCourses.map(c => c.id);
          await supabase
            .from("course_evaluators")
            .delete()
            .eq("user_id", userProfile.user_id)
            .in("course_id", courseIds);
        }
        setEvaluatorCoursesMap(prev => {
          const next = { ...prev };
          delete next[userProfile.user_id];
          return next;
        });
      }

      // 3. If changing FROM instructor, remove their course_instructors & section restrictions
      if (userProfile.role === "instructor") {
        const { data: institutionCourses } = await supabase
          .from("courses")
          .select("id")
          .eq("institution_id", effectiveInstitutionId);

        if (institutionCourses && institutionCourses.length > 0) {
          const courseIds = institutionCourses.map(c => c.id);
          await supabase
            .from("course_instructor_sections")
            .delete()
            .eq("user_id", userProfile.user_id)
            .in("course_id", courseIds);
          await supabase
            .from("course_instructors")
            .delete()
            .eq("user_id", userProfile.user_id)
            .in("course_id", courseIds);
        }
        // Clear local instructor courses state
        setInstructorCoursesMap(prev => {
          const next = { ...prev };
          delete next[userProfile.user_id];
          return next;
        });
      }

      setUsers(users.map((u) =>
        u.id === userProfile.id ? { ...u, role: newRole, institution_role: newRole } : u
      ));
      toast.success(`Role updated to ${newRole}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to update role");
    }
  };

  const handleEditUser = async () => {
    if (!editingUser) return;

    setIsSavingName(true);
    try {
      const updateData: TablesUpdate<"profiles"> = {
        full_name: editName.trim() || null,
      };
      if (editingUser.role === "student") {
        updateData.father_name = editFatherName.trim() || null;
        updateData.date_of_birth = editDateOfBirth || null;
      }

      const { error } = await supabase
        .from("profiles")
        .update(updateData)
        .eq("id", editingUser.id);

      if (error) throw error;

      setUsers(users.map((u) =>
        u.id === editingUser.id
          ? {
              ...u,
              full_name: editName.trim() || null,
              ...(editingUser.role === "student" ? {
                father_name: editFatherName.trim() || null,
                date_of_birth: editDateOfBirth || null,
              } : {}),
            }
          : u
      ));
      toast.success("User updated successfully");
      setEditingUser(null);
      setEditName("");
      setEditFatherName("");
      setEditDateOfBirth("");
    } catch (error: any) {
      toast.error(error.message || "Failed to update user");
    } finally {
      setIsSavingName(false);
    }
  };

  const refreshNotesCountForStudent = async (studentUserId: string) => {
    if (!effectiveInstitutionId) return;
    const { data, error } = await supabase
      .from("student_admin_notes" as any)
      .select("created_at")
      .eq("institution_id", effectiveInstitutionId)
      .eq("student_user_id", studentUserId);
    if (error) {
      console.error("Failed to refresh notes count", error);
      return;
    }
    const recentCutoff = Date.now() - NOTES_RECENT_DAYS * 24 * 60 * 60 * 1000;
    const counts = { total: 0, recent: 0 };
    for (const row of (data as any[]) || []) {
      counts.total += 1;
      if (new Date(row.created_at).getTime() >= recentCutoff) counts.recent += 1;
    }
    setNotesCountsMap(prev => {
      const next = { ...prev };
      if (counts.total === 0) {
        delete next[studentUserId];
      } else {
        next[studentUserId] = counts;
      }
      return next;
    });
  };

  if (loading || loadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const activeUsers = users.filter((u) => !u.is_suspended);
  const suspendedUsers = users.filter((u) => u.is_suspended);
  const pendingInvitations = invitations.filter((i) => i.status === "pending");
  const acceptedInvitations = invitations.filter((i) => i.status === "accepted");

  // Role-filtered counts (include pending invitations of that role)
  const studentCount = users.filter(u => u.role === "student").length + pendingInvitations.filter(i => i.role === "student").length;
  const instructorCount = users.filter(u => u.role === "instructor").length + pendingInvitations.filter(i => i.role === "instructor").length;
  const adminCount = users.filter(u => u.role === "admin").length + pendingInvitations.filter(i => i.role === "admin").length;
  const evaluatorCount = users.filter(u => u.role === "evaluator").length + pendingInvitations.filter(i => i.role === "evaluator").length;

  const getTabRole = (): string | null => {
    if (activeTab === "students") return "student";
    if (activeTab === "instructors") return "instructor";
    if (activeTab === "admins") return "admin";
    if (activeTab === "evaluators") return "evaluator";
    return null;
  };

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
                <BookOpen className="w-6 h-6 text-primary-foreground" />
              </div>
              <div>
                <span className="text-xl font-display font-bold text-foreground">User Management</span>
                {institution && (
                  <p className="text-xs text-muted-foreground">{institution.name}</p>
                )}
              </div>
            </div>
          </div>
          <Button variant="outline" onClick={() => navigate("/rights-requests")}>
            <Scale className="w-4 h-4 mr-2" />
            Rights Requests
          </Button>
        </div>
      </nav>

      <main className="container mx-auto px-6 py-8">
        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Users className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{activeUsers.length}</p>
                  <p className="text-sm text-muted-foreground">Active Users</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-yellow-500/10 flex items-center justify-center">
                  <PauseCircle className="w-6 h-6 text-yellow-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{suspendedUsers.length}</p>
                  <p className="text-sm text-muted-foreground">Suspended</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-gold/10 flex items-center justify-center">
                  <Clock className="w-6 h-6 text-gold-dark" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{pendingInvitations.length}</p>
                  <p className="text-sm text-muted-foreground">Pending Invites</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-green-500/10 flex items-center justify-center">
                  <CheckCircle className="w-6 h-6 text-green-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{acceptedInvitations.length}</p>
                  <p className="text-sm text-muted-foreground">Accepted</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="students" onValueChange={(val) => { setActiveTab(val); setCurrentPage(1); setClassFilter("all"); }} className="space-y-6">
          <div className="flex items-center justify-between">
            <TabsList>
              <TabsTrigger value="students">Students ({studentCount})</TabsTrigger>
              <TabsTrigger value="instructors">Instructors ({instructorCount})</TabsTrigger>
              <TabsTrigger value="evaluators">Evaluators ({evaluatorCount})</TabsTrigger>
              <TabsTrigger value="admins">Admins ({adminCount})</TabsTrigger>
              <TabsTrigger value="invitations">Invitations ({invitations.length})</TabsTrigger>
            </TabsList>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button>
                  <Plus className="w-4 h-4 mr-2" />
                  Add User
                  <ChevronDown className="w-4 h-4 ml-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => {
                  const tabRole = getTabRole();
                  if (tabRole) setInviteRole(tabRole);
                  setInviteDialogOpen(true);
                }}>
                  <Mail className="w-4 h-4 mr-2" />
                  Send Invitation
                </DropdownMenuItem>
                {isSuperAdmin && (
                  <DropdownMenuItem onClick={() => {
                    const tabRole = getTabRole();
                    if (tabRole) setCreateRole(tabRole);
                    setCreateUserDialogOpen(true);
                  }}>
                    <UserPlus className="w-4 h-4 mr-2" />
                    Create User Directly
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => {
                    const tabRole = getTabRole();
                    setBulkImportRole(tabRole === "instructor" ? "instructor" : "student");
                    setBulkImportOpen(true);
                  }}
                >
                  <Upload className="w-4 h-4 mr-2" />
                  Bulk Import
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            
            {/* Invite User Dialog */}
            <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Invite a User</DialogTitle>
                  <DialogDescription>
                    Send an invitation email to join your institution
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleInviteUser} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="invite-name">Full Name</Label>
                    <Input
                      id="invite-name"
                      type="text"
                      placeholder="John Doe"
                      value={inviteName}
                      onChange={(e) => setInviteName(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Optional. The user won't be able to change this upon signup.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="invite-email">Email Address</Label>
                    <Input
                      id="invite-email"
                      type="email"
                      placeholder="user@email.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="invite-role">Role</Label>
                    <Select value={inviteRole} onValueChange={(v) => { setInviteRole(v); setInviteCourseIds(new Set()); }}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a role" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="student">
                          <div className="flex items-center gap-2">
                            <User className="w-4 h-4" />
                            <span>Student</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="instructor">
                          <div className="flex items-center gap-2">
                            <GraduationCap className="w-4 h-4" />
                            <span>Instructor</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="evaluator">
                          <div className="flex items-center gap-2">
                            <ClipboardCheck className="w-4 h-4" />
                            <span>Evaluator</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="admin">
                          <div className="flex items-center gap-2">
                            <Shield className="w-4 h-4" />
                            <span>Admin</span>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {inviteRole === "admin" && "Full access to manage institution, users, and courses"}
                      {inviteRole === "instructor" && "Can create and manage courses and materials"}
                      {inviteRole === "student" && "Can view courses and access materials"}
                      {inviteRole === "evaluator" && "Read-only access to questions for assigned courses; reviews their quality"}
                    </p>
                  </div>
                  {inviteRole === "student" && (
                    <div className="space-y-2">
                      <Label htmlFor="invite-grade-level">Grade Level</Label>
                      <Select value={inviteGradeLevel} onValueChange={setInviteGradeLevel}>
                        <SelectTrigger>
                          <School className="w-4 h-4 mr-2" />
                          <SelectValue placeholder="Select grade level" />
                        </SelectTrigger>
                        <SelectContent>
                          {filteredGradeOptions.map((g) => (
                            <SelectItem key={g.value} value={g.value}>
                              {g.labelEl} ({g.labelEn})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Set the student's grade level for class enrollment filtering.
                      </p>
                    </div>
                  )}
                  {inviteRole === "evaluator" && (
                    <div className="space-y-2">
                      <Label>Assigned Courses ({inviteCourseIds.size} selected)</Label>
                      {courses.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic px-2 py-1.5">
                          No courses in this institution yet. Create a course before inviting an evaluator.
                        </p>
                      ) : (
                        <div className="max-h-48 overflow-y-auto border rounded-md divide-y">
                          {courses.map((course) => {
                            const checked = inviteCourseIds.has(course.id);
                            return (
                              <label
                                key={course.id}
                                className={`flex items-start gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                                  checked ? "bg-primary/10" : "hover:bg-secondary"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    setInviteCourseIds(prev => {
                                      const next = new Set(prev);
                                      if (next.has(course.id)) next.delete(course.id);
                                      else next.add(course.id);
                                      return next;
                                    });
                                  }}
                                  className="mt-0.5"
                                />
                                <div className="flex-1 min-w-0">
                                  <p className="truncate">{course.title}</p>
                                  {course.grade_level_id && (
                                    <p className="text-xs text-muted-foreground">{institutionGradeLevels.getLabelById(course.grade_level_id, "el")}</p>
                                  )}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Pick the courses this evaluator can review. They will see questions only for these courses.
                      </p>
                    </div>
                  )}
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isInviting || (inviteRole === "evaluator" && inviteCourseIds.size === 0)}
                  >
                    {isInviting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        Sending...
                      </>
                    ) : (
                      "Send Invitation"
                    )}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>

            {/* Create User Directly Dialog */}
            <Dialog open={createUserDialogOpen} onOpenChange={setCreateUserDialogOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create User Directly</DialogTitle>
                  <DialogDescription>
                    Create a new user account with a password (no invitation email)
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreateUser} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="create-name">Full Name</Label>
                    <Input
                      id="create-name"
                      type="text"
                      placeholder="John Doe"
                      value={createName}
                      onChange={(e) => setCreateName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="create-email">Email Address</Label>
                    <Input
                      id="create-email"
                      type="email"
                      placeholder="user@email.com"
                      value={createEmail}
                      onChange={(e) => setCreateEmail(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="create-password">Password</Label>
                    <div className="relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="create-password"
                        type="password"
                        placeholder="Minimum 8 characters"
                        value={createPassword}
                        onChange={(e) => setCreatePassword(e.target.value)}
                        className="pl-9"
                        required
                        minLength={8}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      The user can change their password after logging in.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="create-role">Role</Label>
                    <Select value={createRole} onValueChange={(v) => { setCreateRole(v); setCreateCourseIds(new Set()); }}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a role" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="student">
                          <div className="flex items-center gap-2">
                            <User className="w-4 h-4" />
                            <span>Student</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="instructor">
                          <div className="flex items-center gap-2">
                            <GraduationCap className="w-4 h-4" />
                            <span>Instructor</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="evaluator">
                          <div className="flex items-center gap-2">
                            <ClipboardCheck className="w-4 h-4" />
                            <span>Evaluator</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="admin">
                          <div className="flex items-center gap-2">
                            <Shield className="w-4 h-4" />
                            <span>Admin</span>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {createRole === "admin" && "Full access to manage institution, users, and courses"}
                      {createRole === "instructor" && "Can create and manage courses and materials"}
                      {createRole === "student" && "Can view courses and access materials"}
                      {createRole === "evaluator" && "Read-only access to questions for assigned courses; reviews their quality"}
                    </p>
                  </div>
                  {createRole === "evaluator" && (
                    <div className="space-y-2">
                      <Label>Assigned Courses ({createCourseIds.size} selected)</Label>
                      {courses.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic px-2 py-1.5">
                          No courses in this institution yet. Create a course before creating an evaluator.
                        </p>
                      ) : (
                        <div className="max-h-48 overflow-y-auto border rounded-md divide-y">
                          {courses.map((course) => {
                            const checked = createCourseIds.has(course.id);
                            return (
                              <label
                                key={course.id}
                                className={`flex items-start gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                                  checked ? "bg-primary/10" : "hover:bg-secondary"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    setCreateCourseIds(prev => {
                                      const next = new Set(prev);
                                      if (next.has(course.id)) next.delete(course.id);
                                      else next.add(course.id);
                                      return next;
                                    });
                                  }}
                                  className="mt-0.5"
                                />
                                <div className="flex-1 min-w-0">
                                  <p className="truncate">{course.title}</p>
                                  {course.grade_level_id && (
                                    <p className="text-xs text-muted-foreground">{institutionGradeLevels.getLabelById(course.grade_level_id, "el")}</p>
                                  )}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Pick the courses this evaluator can review. They will see questions only for these courses.
                      </p>
                    </div>
                  )}
                  {createRole === "student" && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="create-father-name">Father's Name</Label>
                        <Input
                          id="create-father-name"
                          type="text"
                          placeholder="Father's full name"
                          value={createFatherName}
                          onChange={(e) => setCreateFatherName(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="create-date-of-birth">Date of Birth</Label>
                        <Input
                          id="create-date-of-birth"
                          type="date"
                          value={createDateOfBirth}
                          onChange={(e) => setCreateDateOfBirth(e.target.value)}
                        />
                      </div>
                    </>
                  )}
                  {createRole === "student" && (
                    <div className="space-y-2">
                      <Label htmlFor="create-grade-level">Grade Level</Label>
                      <Select value={createGradeLevel} onValueChange={setCreateGradeLevel}>
                        <SelectTrigger>
                          <School className="w-4 h-4 mr-2" />
                          <SelectValue placeholder="Select grade level" />
                        </SelectTrigger>
                        <SelectContent>
                          {filteredGradeOptions.map((g) => (
                            <SelectItem key={g.value} value={g.value}>
                              {g.labelEl} ({g.labelEn})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Set the student's grade level for class enrollment filtering.
                      </p>
                    </div>
                  )}
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isCreatingUser || (createRole === "evaluator" && createCourseIds.size === 0)}
                  >
                    {isCreatingUser ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        Creating...
                      </>
                    ) : (
                      "Create User"
                    )}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          {/* Role-based User Tabs */}
          {(["students", "instructors", "evaluators", "admins"] as const).map((tabValue) => {
            const roleForTab =
              tabValue === "students" ? "student"
              : tabValue === "instructors" ? "instructor"
              : tabValue === "evaluators" ? "evaluator"
              : "admin";
            return (
            <TabsContent key={tabValue} value={tabValue} className="space-y-4">
              {/* Search and Filter */}
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name or email..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-full sm:w-[150px]">
                    <SelectValue placeholder="All Statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="suspended">Suspended</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                  </SelectContent>
                </Select>
                {tabValue !== "admins" && tabValue !== "evaluators" && (
                  <Select value={classFilter} onValueChange={(v) => { setClassFilter(v); setCurrentPage(1); }}>
                    <SelectTrigger className="w-full sm:w-[180px]">
                      <div className="flex items-center gap-2">
                        <School className="w-4 h-4" />
                        <SelectValue placeholder="Filter by class" />
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Classes</SelectItem>
                      <SelectItem value="no-class">No class</SelectItem>
                      {(() => {
                        // Group by grade_level_id (FK identity) so generic
                        // grades render alongside Greek ones and ordering
                        // comes from the institution's grade_levels ordinal.
                        const seen = new Set<string>();
                        const gradeOrdinal = new Map(
                          institutionGradeLevels.rows.map((r) => [r.id, r.ordinal] as const),
                        );
                        return classes
                          .filter(c => c.is_active !== false && c.grade_level_id)
                          .sort((a, b) => {
                            const oa = gradeOrdinal.get(a.grade_level_id!) ?? Number.MAX_SAFE_INTEGER;
                            const ob = gradeOrdinal.get(b.grade_level_id!) ?? Number.MAX_SAFE_INTEGER;
                            return oa - ob;
                          })
                          .filter(cls => {
                            if (seen.has(cls.grade_level_id!)) return false;
                            seen.add(cls.grade_level_id!);
                            return true;
                          })
                          .map(cls => (
                            <SelectItem key={cls.grade_level_id!} value={`grade_id:${cls.grade_level_id}`}>
                              {institutionGradeLevels.getLabelById(cls.grade_level_id, "el")}
                            </SelectItem>
                          ));
                      })()}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {tabValue === "instructors" && (
                <p className="text-sm text-muted-foreground">
                  To assign or unassign courses to instructors, go to the{" "}
                  <Link to="/classes" className="text-primary underline hover:text-primary/80">
                    Classes page
                  </Link>
                  .
                </p>
              )}

              {(() => {
                // Combine users with pending invitations, filtered by role
                const pendingInvitationsAsUsers: UserProfile[] = invitations
                  .filter(inv => inv.status === "pending" && inv.role === roleForTab)
                  .map(inv => ({
                    id: inv.id,
                    user_id: inv.id,
                    full_name: inv.invited_name || null,
                    email: inv.email,
                    role: inv.role,
                    is_suspended: false,
                    created_at: inv.created_at,
                    isPending: true,
                    invitationId: inv.id,
                  }));

                const roleUsers = users.filter(u => u.role === roleForTab);
                const combinedUsers = [...roleUsers, ...pendingInvitationsAsUsers];

                const filteredUsers = combinedUsers.filter((u) => {
                  const matchesSearch = searchQuery === "" ||
                    (u.full_name?.toLowerCase().includes(searchQuery.toLowerCase())) ||
                    (u.email?.toLowerCase().includes(searchQuery.toLowerCase()));
                  const matchesStatus = statusFilter === "all" ||
                    (statusFilter === "pending" && u.isPending) ||
                    (statusFilter === "suspended" && !u.isPending && u.is_suspended) ||
                    (statusFilter === "active" && !u.isPending && !u.is_suspended);
                  const enrollments = u.isPending ? [] : (userEnrollmentsMap[u.user_id] || []);
                  const matchesClass = tabValue === "admins" || tabValue === "evaluators" || classFilter === "all" ||
                    (classFilter === "no-class" ? enrollments.length === 0 :
                      classFilter.startsWith("grade_id:") ?
                        enrollments.some(e => {
                          const gradeIdVal = classFilter.slice("grade_id:".length);
                          const cls = classes.find(c => c.id === e.class_id);
                          return cls?.grade_level_id === gradeIdVal;
                        }) :
                        enrollments.some(e => e.class_id === classFilter));
                  return matchesSearch && matchesStatus && matchesClass;
                });

                // Pagination calculations
                const totalPages = Math.ceil(filteredUsers.length / pageSize);
                const startIndex = (currentPage - 1) * pageSize;
                const paginatedUsers = filteredUsers.slice(startIndex, startIndex + pageSize);

                // Reset to page 1 if current page is out of bounds
                if (currentPage > totalPages && totalPages > 0) {
                  setCurrentPage(1);
                }

                if (combinedUsers.length === 0) {
                  return (
                    <Card className="border-dashed">
                      <CardContent className="py-12 text-center">
                        <Users className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                        <h3 className="text-lg font-medium text-foreground mb-2">
                          No {tabValue} yet
                        </h3>
                        <p className="text-muted-foreground">
                          Invite {tabValue} to join your institution
                        </p>
                      </CardContent>
                    </Card>
                  );
                }

                if (filteredUsers.length === 0) {
                  return (
                    <Card className="border-dashed">
                      <CardContent className="py-12 text-center">
                        <Search className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                        <h3 className="text-lg font-medium text-foreground mb-2">
                          No {tabValue} found
                        </h3>
                        <p className="text-muted-foreground">
                          Try adjusting your search or filter
                        </p>
                      </CardContent>
                    </Card>
                  );
                }

                return (
                  <div className="space-y-4">
                    <Card>
                      <CardContent className="p-0">
                        <div className="divide-y divide-border">
                          {paginatedUsers.map((userProfile) => (
                          <div
                            key={userProfile.id}
                            className={`flex items-center justify-between p-4 ${
                              userProfile.is_suspended ? "bg-muted/50" :
                              userProfile.isPending ? "bg-amber-500/5" : ""
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                                userProfile.isPending
                                  ? "bg-amber-500/20"
                                  : userProfile.role === "admin"
                                  ? "bg-gold/20"
                                  : userProfile.is_suspended
                                  ? "bg-muted"
                                  : "bg-secondary"
                              }`}>
                                {userProfile.isPending ? (
                                  <Clock className="w-5 h-5 text-amber-600" />
                                ) : (
                                  <User className={`w-5 h-5 ${
                                    userProfile.role === "admin"
                                      ? "text-gold-dark"
                                      : "text-muted-foreground"
                                  }`} />
                                )}
                              </div>
                              <div className="flex-1">
                                <p className="font-medium text-foreground">
                                  {!userProfile.isPending && userProfile.role === "student" ? (
                                    <Link
                                      to={`/student/${userProfile.user_id}/profile`}
                                      className="hover:underline"
                                    >
                                      {userProfile.full_name || "No name"}
                                    </Link>
                                  ) : (
                                    userProfile.full_name || "No name"
                                  )}
                                  {userProfile.user_id === user?.id && !userProfile.isPending && (
                                    <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                                  )}
                                  {userProfile.isPending && (
                                    <span className="ml-2 text-xs text-amber-600">(pending)</span>
                                  )}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  {userProfile.email}
                                </p>
                                {!userProfile.isPending && userProfile.role === "student" && (userProfile.father_name || userProfile.date_of_birth) && (
                                  <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                                    {userProfile.father_name && (
                                      <span>Father: {userProfile.father_name}</span>
                                    )}
                                    {userProfile.father_name && userProfile.date_of_birth && (
                                      <span className="text-border">&bull;</span>
                                    )}
                                    {userProfile.date_of_birth && (
                                      <span>DOB: {formatDate(userProfile.date_of_birth + 'T12:00:00')}</span>
                                    )}
                                  </div>
                                )}
                                {!userProfile.isPending && (userProfile.role === "student" || userProfile.role === "instructor") && userProfile.user_institution_id && effectiveInstitutionId && (
                                  <div className="mt-1">
                                    <InlineGradeSelector
                                      userId={userProfile.user_id}
                                      institutionId={effectiveInstitutionId}
                                      userInstitutionId={userProfile.user_institution_id}
                                      role={userProfile.role as "student" | "instructor"}
                                      currentGradeLevel={institutionGradeLevels.findCodeById(userProfile.grade_level_id)}
                                      currentGradeLevels={instructorGradesMap[userProfile.user_id] || []}
                                      availableGradeLevelIds={institutionGradeLevelIdsInUse}
                                      onGradeChange={(grades, removedEnrollmentClassIds, removedCourseIds) => {
                                        if (userProfile.role === "student") {
                                          const newCode = grades[0] || null;
                                          const newId = newCode ? institutionGradeLevels.findIdByCode(newCode) : null;
                                          setUsers(users.map(u =>
                                            u.user_id === userProfile.user_id
                                              ? { ...u, grade_level_id: newId }
                                              : u
                                          ));
                                          if (removedEnrollmentClassIds && removedEnrollmentClassIds.length > 0) {
                                            setUserEnrollmentsMap(prev => ({
                                              ...prev,
                                              [userProfile.user_id]: (prev[userProfile.user_id] || []).filter(
                                                e => !removedEnrollmentClassIds.includes(e.class_id)
                                              ),
                                            }));
                                          }
                                        } else {
                                          setInstructorGradesMap(prev => ({
                                            ...prev,
                                            [userProfile.user_id]: grades,
                                          }));
                                          if (removedCourseIds && removedCourseIds.length > 0) {
                                            setInstructorCoursesMap(prev => ({
                                              ...prev,
                                              [userProfile.user_id]: (prev[userProfile.user_id] || []).filter(
                                                c => !removedCourseIds.includes(c.course_id)
                                              ),
                                            }));
                                          }
                                        }
                                      }}
                                    />
                                  </div>
                                )}
                                {!userProfile.isPending && (
                                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                                    <span title="Joined">
                                      Joined: {userProfile.auth_created_at
                                        ? formatDate(userProfile.auth_created_at)
                                        : "N/A"}
                                    </span>
                                    <span className="text-border">•</span>
                                    <span title="Last sign in">
                                      Last login: {userProfile.last_sign_in_at
                                        ? formatDate(userProfile.last_sign_in_at)
                                        : "Never"}
                                    </span>
                                  </div>
                                )}
                                {!userProfile.isPending && userProfile.role === "student" && (
                                  <div className="mt-1 flex items-center gap-1 flex-wrap">
                                    <BookOpen className="w-3 h-3 text-muted-foreground" />
                                    {(() => {
                                      const enrollments = userEnrollmentsMap[userProfile.user_id] || [];
                                      const enrolledClassIds = new Set(enrollments.map(e => e.class_id));
                                      // Match "same grade" by grade_level_id (FK identity) — the TEXT
                                      // column no longer exists after #799.
                                      const userGradeId = userProfile.grade_level_id;
                                      const enrolledCategories = new Set(
                                        enrollments
                                          .filter(e => e.category !== null)
                                          .map(e => e.category as string)
                                      );
                                      const availableSections = classes.filter(c =>
                                        c.is_active !== false &&
                                        c.section_name &&
                                        !enrolledClassIds.has(c.id) &&
                                        !!userGradeId &&
                                        c.grade_level_id === userGradeId &&
                                        !(c.category !== null && enrolledCategories.has(c.category))
                                      );
                                      return (
                                        <>
                                          {enrollments.length === 0 && availableSections.length === 0 && (
                                            <span className="text-xs text-muted-foreground italic">
                                              No class enrollments
                                            </span>
                                          )}
                                          {enrollments.map((enrollment) => (
                                            <span
                                              key={enrollment.class_id}
                                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-primary/10 text-primary"
                                            >
                                              {enrollment.class_name}
                                              {confirmingRemoveEnrollment === `${userProfile.user_id}-${enrollment.class_id}` ? (
                                                <>
                                                  <button
                                                    type="button"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      handleRemoveEnrollment(userProfile.user_id, enrollment.class_id, enrollment.class_name);
                                                    }}
                                                    className="ml-0.5 text-destructive hover:text-destructive/80"
                                                    title="Confirm removal"
                                                  >
                                                    <CheckCircle className="w-3 h-3" />
                                                  </button>
                                                  <button
                                                    type="button"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      setConfirmingRemoveEnrollment(null);
                                                    }}
                                                    className="hover:text-muted-foreground"
                                                    title="Cancel"
                                                  >
                                                    <X className="w-3 h-3" />
                                                  </button>
                                                </>
                                              ) : (
                                                <button
                                                  type="button"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleRemoveEnrollment(userProfile.user_id, enrollment.class_id, enrollment.class_name);
                                                  }}
                                                  className="ml-0.5 hover:text-destructive"
                                                  title={`Remove from ${enrollment.class_name}`}
                                                >
                                                  <X className="w-3 h-3" />
                                                </button>
                                              )}
                                            </span>
                                          ))}
                                          {availableSections.length > 0 && (
                                            <Popover>
                                              <PopoverTrigger asChild>
                                                <button
                                                  type="button"
                                                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs border border-dashed border-muted-foreground/40 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                                                  title="Add to section"
                                                >
                                                  <Plus className="w-3 h-3" />
                                                  Section
                                                </button>
                                              </PopoverTrigger>
                                              <PopoverContent className="w-48 p-1" align="start">
                                                <div className="max-h-48 overflow-y-auto">
                                                  {availableSections.map((cls) => (
                                                    <button
                                                      key={cls.id}
                                                      type="button"
                                                      className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-secondary transition-colors"
                                                      onClick={() => handleAddEnrollment(userProfile.user_id, cls.id, "student")}
                                                    >
                                                      {buildClassDisplayName(cls)}
                                                    </button>
                                                  ))}
                                                </div>
                                              </PopoverContent>
                                            </Popover>
                                          )}
                                        </>
                                      );
                                    })()}
                                  </div>
                                )}
                                {!userProfile.isPending && userProfile.role === "instructor" && (
                                  <div className="mt-1 flex items-center gap-1 flex-wrap">
                                    <BookOpen className="w-3 h-3 text-muted-foreground" />
                                    {(() => {
                                      const instructorCourses = instructorCoursesMap[userProfile.user_id] || [];
                                      return (
                                        <>
                                          {instructorCourses.length === 0 && (
                                            <span className="text-xs text-muted-foreground italic">
                                              No course assignments — manage on Classes page
                                            </span>
                                          )}
                                          {instructorCourses.map((course) => (
                                            <span
                                              key={course.course_id}
                                              className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-primary/10 text-primary"
                                            >
                                              {course.course_title}{course.grade_level_id ? ` (${institutionGradeLevels.getLabelById(course.grade_level_id, "el")})` : ""}
                                            </span>
                                          ))}
                                        </>
                                      );
                                    })()}
                                  </div>
                                )}
                                {!userProfile.isPending && userProfile.role === "evaluator" && (
                                  <div className="mt-1 flex items-center gap-1 flex-wrap">
                                    <BookOpen className="w-3 h-3 text-muted-foreground" />
                                    {(() => {
                                      const assigned = evaluatorCoursesMap[userProfile.user_id] || [];
                                      const assignedIds = new Set(assigned.map(c => c.course_id));
                                      const available = courses.filter(c => !assignedIds.has(c.id));
                                      return (
                                        <>
                                          {assigned.length === 0 && available.length === 0 && (
                                            <span className="text-xs text-muted-foreground italic">
                                              No courses available to assign
                                            </span>
                                          )}
                                          {assigned.length === 0 && available.length > 0 && (
                                            <span className="text-xs text-muted-foreground italic">
                                              No course assignments
                                            </span>
                                          )}
                                          {assigned.map((course) => (
                                            <span
                                              key={course.course_id}
                                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-purple-500/10 text-purple-700 dark:text-purple-300"
                                            >
                                              {course.course_title}{course.grade_level_id ? ` (${institutionGradeLevels.getLabelById(course.grade_level_id, "el")})` : ""}
                                              {confirmingRemoveEvaluatorCourse === `${userProfile.user_id}-${course.course_id}` ? (
                                                <>
                                                  <button
                                                    type="button"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      handleRemoveEvaluatorCourse(userProfile.user_id, course.course_id, course.course_title);
                                                    }}
                                                    className="ml-0.5 text-destructive hover:text-destructive/80"
                                                    title="Confirm removal"
                                                  >
                                                    <CheckCircle className="w-3 h-3" />
                                                  </button>
                                                  <button
                                                    type="button"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      setConfirmingRemoveEvaluatorCourse(null);
                                                    }}
                                                    className="hover:text-muted-foreground"
                                                    title="Cancel"
                                                  >
                                                    <X className="w-3 h-3" />
                                                  </button>
                                                </>
                                              ) : (
                                                <button
                                                  type="button"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleRemoveEvaluatorCourse(userProfile.user_id, course.course_id, course.course_title);
                                                  }}
                                                  className="ml-0.5 hover:text-destructive"
                                                  title={`Unassign from ${course.course_title}`}
                                                >
                                                  <X className="w-3 h-3" />
                                                </button>
                                              )}
                                            </span>
                                          ))}
                                          {available.length > 0 && (
                                            <Popover>
                                              <PopoverTrigger asChild>
                                                <button
                                                  type="button"
                                                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs border border-dashed border-muted-foreground/40 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                                                  title="Assign course"
                                                >
                                                  <Plus className="w-3 h-3" />
                                                  Course
                                                </button>
                                              </PopoverTrigger>
                                              <PopoverContent className="w-64 p-1" align="start">
                                                <div className="max-h-48 overflow-y-auto">
                                                  {available.map((course) => (
                                                    <button
                                                      key={course.id}
                                                      type="button"
                                                      className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-secondary transition-colors"
                                                      onClick={() => handleAddEvaluatorCourse(userProfile.user_id, course.id)}
                                                    >
                                                      {course.title}{course.grade_level_id ? ` (${institutionGradeLevels.getLabelById(course.grade_level_id, "el")})` : ""}
                                                    </button>
                                                  ))}
                                                </div>
                                              </PopoverContent>
                                            </Popover>
                                          )}
                                        </>
                                      );
                                    })()}
                                  </div>
                                )}
                                {userProfile.isPending && userProfile.role === "evaluator" && (
                                  <div className="mt-1 flex items-center gap-1 flex-wrap">
                                    <BookOpen className="w-3 h-3 text-muted-foreground" />
                                    {(() => {
                                      const invCourses = invitationCoursesMap[userProfile.invitationId || ""] || [];
                                      if (invCourses.length === 0) {
                                        return (
                                          <span className="text-xs text-muted-foreground italic">
                                            No courses scoped to this invitation
                                          </span>
                                        );
                                      }
                                      return invCourses.map((course) => (
                                        <span
                                          key={course.course_id}
                                          className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-purple-500/10 text-purple-700 dark:text-purple-300"
                                        >
                                          {course.course_title}{course.grade_level_id ? ` (${institutionGradeLevels.getLabelById(course.grade_level_id, "el")})` : ""}
                                        </span>
                                      ));
                                    })()}
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              {userProfile.isPending ? (
                                <>
                                  <span className="px-2 py-1 text-xs rounded-full bg-amber-500/20 text-amber-700">
                                    {userProfile.role}
                                  </span>
                                  <div className="flex items-center gap-1">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => handleResendInvitation(invitations.find(i => i.id === userProfile.invitationId)!)}
                                      disabled={resendingId === userProfile.invitationId}
                                      title="Resend invitation"
                                    >
                                      {resendingId === userProfile.invitationId ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                      ) : (
                                        <RefreshCw className="w-4 h-4 text-muted-foreground" />
                                      )}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => handleCancelInvitation(userProfile.invitationId!)}
                                      disabled={cancellingId === userProfile.invitationId}
                                      className="text-destructive hover:text-destructive"
                                      title="Cancel invitation"
                                    >
                                      {cancellingId === userProfile.invitationId ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                      ) : (
                                        <X className="w-4 h-4" />
                                      )}
                                    </Button>
                                  </div>
                                </>
                              ) : (
                                <>
                                  {userProfile.user_id === user?.id || userProfile.is_suspended ? (
                                    <span className={`px-2 py-1 text-xs rounded-full ${
                                      userProfile.role === "admin"
                                        ? "bg-gold/20 text-gold-dark"
                                        : userProfile.is_suspended
                                        ? "bg-yellow-500/20 text-yellow-700"
                                        : userProfile.role === "instructor"
                                        ? "bg-blue-500/20 text-blue-700"
                                        : userProfile.role === "evaluator"
                                        ? "bg-purple-500/20 text-purple-700"
                                        : "bg-secondary text-muted-foreground"
                                    }`}>
                                      {userProfile.is_suspended ? `${userProfile.role} (suspended)` : userProfile.role}
                                    </span>
                                  ) : (
                                    <Select
                                      value={userProfile.role}
                                      onValueChange={(value) => handleChangeRole(userProfile, value)}
                                    >
                                      <SelectTrigger className="w-[130px] h-8 text-xs">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="student">
                                          <div className="flex items-center gap-2">
                                            <User className="w-3 h-3" />
                                            <span>Student</span>
                                          </div>
                                        </SelectItem>
                                        <SelectItem value="instructor">
                                          <div className="flex items-center gap-2">
                                            <GraduationCap className="w-3 h-3" />
                                            <span>Instructor</span>
                                          </div>
                                        </SelectItem>
                                        {userProfile.role === "evaluator" && (
                                          <SelectItem value="evaluator">
                                            <div className="flex items-center gap-2">
                                              <ClipboardCheck className="w-3 h-3" />
                                              <span>Evaluator</span>
                                            </div>
                                          </SelectItem>
                                        )}
                                        <SelectItem value="admin">
                                          <div className="flex items-center gap-2">
                                            <Shield className="w-3 h-3" />
                                            <span>Admin</span>
                                          </div>
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  )}
                                  {userProfile.role === "student" && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => setNotesDialogTarget(userProfile)}
                                      title="Notes"
                                      className="relative"
                                    >
                                      <StickyNote className="w-4 h-4 text-muted-foreground" />
                                      {(notesCountsMap[userProfile.user_id]?.recent ?? 0) > 0 && (
                                        <span
                                          className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] leading-4 text-center"
                                          title={`${notesCountsMap[userProfile.user_id]?.recent} recent note(s)`}
                                        >
                                          {notesCountsMap[userProfile.user_id]?.recent}
                                        </span>
                                      )}
                                    </Button>
                                  )}
                                  {/* Deliberately also shown on the admin's own
                                      row: the edge function authorizes self-
                                      targets, and this is the recovery path when
                                      an admin loses their own authenticator. */}
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setMfaResetTarget(userProfile)}
                                    title="Remove two-factor authentication"
                                  >
                                    <ShieldOff className="w-4 h-4 text-muted-foreground" />
                                  </Button>
                                  {userProfile.user_id !== user?.id && (
                                    <div className="flex items-center gap-1">
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => {
                                          setEditingUser(userProfile);
                                          setEditName(userProfile.full_name || "");
                                          setEditFatherName(userProfile.father_name || "");
                                          setEditDateOfBirth(userProfile.date_of_birth || "");
                                        }}
                                        title="Edit user"
                                      >
                                        <Pencil className="w-4 h-4 text-muted-foreground" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => setResetPasswordTarget(userProfile)}
                                        title="Reset password"
                                      >
                                        <Key className="w-4 h-4 text-muted-foreground" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => handleToggleUserStatus(userProfile)}
                                        title={userProfile.is_suspended ? "Reactivate" : "Suspend"}
                                      >
                                        {userProfile.is_suspended ? (
                                          <PlayCircle className="w-4 h-4 text-green-600" />
                                        ) : (
                                          <PauseCircle className="w-4 h-4 text-yellow-600" />
                                        )}
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => handleRemoveUser(userProfile)}
                                        className="text-destructive hover:text-destructive"
                                        title="Remove from institution"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </Button>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>

                  {/* Pagination Controls */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span>Show</span>
                      <Select value={pageSize.toString()} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1); }}>
                        <SelectTrigger className="w-[70px] h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="10">10</SelectItem>
                          <SelectItem value="25">25</SelectItem>
                          <SelectItem value="50">50</SelectItem>
                          <SelectItem value="100">100</SelectItem>
                        </SelectContent>
                      </Select>
                      <span>of {filteredUsers.length} {tabValue}</span>
                    </div>
                    {totalPages > 1 && (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                          disabled={currentPage === 1}
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </Button>
                        <span className="text-sm text-muted-foreground px-2">
                          Page {currentPage} of {totalPages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                          disabled={currentPage === totalPages}
                        >
                          <ChevronRight className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
                );
              })()}
            </TabsContent>
            );
          })}

          {/* Invitations Tab */}
          <TabsContent value="invitations">
            {/* Search and Status Filter */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-4">
              <div className="relative flex-1 w-full sm:max-w-xs">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search by email..."
                  value={invitationSearchQuery}
                  onChange={(e) => setInvitationSearchQuery(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-sm text-muted-foreground">Status:</Label>
                <Select value={invitationStatusFilter} onValueChange={setInvitationStatusFilter}>
                  <SelectTrigger className="w-[140px] h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="accepted">Accepted</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <span className="text-sm text-muted-foreground">
                {invitations.filter(inv => 
                  (invitationStatusFilter === "all" || inv.status === invitationStatusFilter) &&
                  (invitationSearchQuery === "" || inv.email.toLowerCase().includes(invitationSearchQuery.toLowerCase()))
                ).length} invitation{invitations.filter(inv => 
                  (invitationStatusFilter === "all" || inv.status === invitationStatusFilter) &&
                  (invitationSearchQuery === "" || inv.email.toLowerCase().includes(invitationSearchQuery.toLowerCase()))
                ).length !== 1 ? "s" : ""}
              </span>
            </div>

            {invitations.filter(inv => 
              (invitationStatusFilter === "all" || inv.status === invitationStatusFilter) &&
              (invitationSearchQuery === "" || inv.email.toLowerCase().includes(invitationSearchQuery.toLowerCase()))
            ).length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <Mail className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium text-foreground mb-2">
                    {invitationSearchQuery ? "No matching invitations" : (invitationStatusFilter === "all" ? "No invitations sent" : `No ${invitationStatusFilter} invitations`)}
                  </h3>
                  <p className="text-muted-foreground">
                    {invitationSearchQuery 
                      ? "Try a different search term"
                      : (invitationStatusFilter === "all" 
                        ? "Invite users to join your institution"
                        : `There are no ${invitationStatusFilter} invitations`)}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {invitations
                      .filter(inv => 
                        (invitationStatusFilter === "all" || inv.status === invitationStatusFilter) &&
                        (invitationSearchQuery === "" || inv.email.toLowerCase().includes(invitationSearchQuery.toLowerCase()))
                      )
                      .map((invitation) => (
                      <div
                        key={invitation.id}
                        className="flex items-center justify-between p-4"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                            <Mail className="w-5 h-5 text-muted-foreground" />
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-foreground">
                                {invitation.email}
                              </p>
                              <span className={`px-2 py-0.5 text-xs rounded-full ${
                                invitation.role === "admin"
                                  ? "bg-gold/20 text-gold-dark"
                                  : invitation.role === "instructor"
                                  ? "bg-blue-500/20 text-blue-700"
                                  : invitation.role === "evaluator"
                                  ? "bg-purple-500/20 text-purple-700"
                                  : "bg-secondary text-muted-foreground"
                              }`}>
                                {invitation.role}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground mb-1">
                              Sent {formatDate(invitation.created_at)}
                            </p>
                            {invitation.invited_class_id && (
                              <div className="flex items-center gap-1 mt-1">
                                <BookOpen className="w-3 h-3 text-muted-foreground" />
                                <span className="text-xs text-muted-foreground">
                                  Enrolls in: {(() => { const cls = classes.find(c => c.id === invitation.invited_class_id); return cls ? buildClassDisplayName(cls) : "Unknown class"; })()}
                                </span>
                              </div>
                            )}
                            {invitation.role === "evaluator" && (invitationCoursesMap[invitation.id] || []).length > 0 && (
                              <div className="flex items-center gap-1 mt-1 flex-wrap">
                                <BookOpen className="w-3 h-3 text-muted-foreground" />
                                <span className="text-xs text-muted-foreground mr-1">Reviews:</span>
                                {invitationCoursesMap[invitation.id].map((course) => (
                                  <span
                                    key={course.course_id}
                                    className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-purple-500/10 text-purple-700 dark:text-purple-300"
                                  >
                                    {course.course_title}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {invitation.status === "accepted" ? (
                            <span className="flex items-center gap-1 text-sm text-green-600">
                              <CheckCircle className="w-4 h-4" />
                              Accepted
                            </span>
                          ) : invitation.status === "pending" ? (
                            <>
                              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                                <Clock className="w-4 h-4" />
                                Pending
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleResendInvitation(invitation)}
                                disabled={resendingId === invitation.id}
                                className="gap-1"
                              >
                                {resendingId === invitation.id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <RefreshCw className="w-4 h-4" />
                                )}
                                Resend
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleCancelInvitation(invitation.id)}
                                disabled={cancellingId === invitation.id}
                                className="text-destructive hover:text-destructive"
                                title="Cancel invitation"
                              >
                                {cancellingId === invitation.id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <X className="w-4 h-4" />
                                )}
                              </Button>
                            </>
                          ) : (
                            <span className="text-sm text-destructive">Declined</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>

        {/* Bulk Import Dialog */}
        {effectiveInstitutionId && (
          <BulkImportDialog
            open={bulkImportOpen}
            onOpenChange={setBulkImportOpen}
            role={bulkImportRole}
            institutionId={effectiveInstitutionId}
            institutionName={institution?.name || "Your Institution"}
            inviterName={profile?.full_name || profile?.email || "An administrator"}
            existingMemberEmails={
              new Set(
                users
                  .map((u) => u.email?.toLowerCase())
                  .filter((e): e is string => !!e),
              )
            }
            existingInvitationEmails={
              new Set(
                invitations
                  .filter((i) => i.status === "pending" || i.status === "accepted")
                  .map((i) => i.email.toLowerCase()),
              )
            }
            classes={classes.map((c) => ({
              id: c.id,
              grade_level_id: c.grade_level_id,
              section_name: c.section_name,
            }))}
            onComplete={() => {
              if (effectiveInstitutionId) fetchData(effectiveInstitutionId);
            }}
          />
        )}

        {/* Student Notes Dialog */}
        {notesDialogTarget && effectiveInstitutionId && (
          <StudentNotesDialog
            open={!!notesDialogTarget}
            onOpenChange={(open) => {
              if (!open) {
                const target = notesDialogTarget;
                setNotesDialogTarget(null);
                if (target) {
                  refreshNotesCountForStudent(target.user_id);
                }
              }
            }}
            studentUserId={notesDialogTarget.user_id}
            studentFullName={notesDialogTarget.full_name}
            institutionId={effectiveInstitutionId}
            mode="read-write"
          />
        )}

        {resetPasswordTarget && (
          <ResetUserPasswordDialog
            userId={resetPasswordTarget.user_id}
            userLabel={resetPasswordTarget.full_name || resetPasswordTarget.email}
            open={!!resetPasswordTarget}
            onOpenChange={(open) => {
              if (!open) setResetPasswordTarget(null);
            }}
          />
        )}

        {mfaResetTarget && (
          <RemoveUserMfaDialog
            userId={mfaResetTarget.user_id}
            userLabel={mfaResetTarget.full_name || mfaResetTarget.email}
            isSelf={mfaResetTarget.user_id === user?.id}
            open={!!mfaResetTarget}
            onOpenChange={(open) => {
              if (!open) setMfaResetTarget(null);
            }}
          />
        )}

        {/* Edit Name Dialog */}
        <Dialog open={!!editingUser} onOpenChange={(open) => !open && setEditingUser(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit User</DialogTitle>
              <DialogDescription>
                Update details for {editingUser?.email}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={(e) => { e.preventDefault(); handleEditUser(); }} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">Full Name</Label>
                <Input
                  id="edit-name"
                  type="text"
                  placeholder="John Doe"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              {editingUser?.role === "student" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="edit-father-name">Father's Name</Label>
                    <Input
                      id="edit-father-name"
                      type="text"
                      placeholder="Father's full name"
                      value={editFatherName}
                      onChange={(e) => setEditFatherName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-date-of-birth">Date of Birth</Label>
                    <Input
                      id="edit-date-of-birth"
                      type="date"
                      value={editDateOfBirth}
                      onChange={(e) => setEditDateOfBirth(e.target.value)}
                    />
                  </div>
                </>
              )}
              <div className="flex gap-2 justify-end">
                <Button type="button" variant="outline" onClick={() => setEditingUser(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSavingName}>
                  {isSavingName ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      Saving...
                    </>
                  ) : (
                    "Save"
                  )}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

      </main>
    </div>
  );
};

export default UserManagement;
