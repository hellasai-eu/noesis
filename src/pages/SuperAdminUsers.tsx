import { useEffect, useState, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  BookOpen,
  Plus,
  LogOut,
  Loader2,
  Users,
  Search,
  ArrowLeft,
  UserPlus,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Trash2,
  UserMinus,
  Pencil,
  Key,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import { ResetUserPasswordDialog } from "@/components/ResetUserPasswordDialog";
import { useFormatters } from "@/i18n/formatters";

interface UserWithInstitutions {
  user_id: string;
  full_name: string | null;
  email: string | null;
  last_sign_in_at: string | null;
  institutions: {
    institution_id: string;
    institution_name: string;
    role: string;
  }[];
}

/**
 * A row `delete-user` found still carrying a typed name matching the erased
 * subject's (`graded_tests.student_name` / `student_evaluations.student_name`).
 * These need a human decision — clear the name, or attest it belongs to a
 * same-named other student — before the Art. 17 request is confirmed complete.
 */
interface NameReviewCandidate {
  source: string;
  rowId: string;
  studentName: string;
  linkedUserId: string | null;
  courseId: string;
  createdAt: string;
}

type SortField = "email" | "full_name" | "last_sign_in_at";
type SortDirection = "asc" | "desc";

interface Institution {
  id: string;
  name: string;
}

/**
 * Roles this page can assign directly. `evaluator` is deliberately absent: it
 * is only usable alongside `course_evaluators` rows, and none of these dialogs
 * picks courses. `UserManagement.tsx` refuses the same change for the same
 * reason, pointing the admin at the invite flow that does. Evaluators are still
 * counted, filtered and labelled everywhere else on this page.
 */
const ASSIGNABLE_ROLES = ["student", "instructor", "admin"] as const;

const ROLE_LABELS: Record<string, string> = {
  student: "Student",
  instructor: "Instructor",
  admin: "Admin",
};

const SuperAdminUsers = () => {
  const { formatDate } = useFormatters();
  const navigate = useNavigate();
  const { user, loading, signOut } = useAuth();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);
  const [users, setUsers] = useState<UserWithInstitutions[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [filterInstitution, setFilterInstitution] = useState<string>("all");
  const [filterRole, setFilterRole] = useState<string>("all");

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 20;

  // Sorting
  const [sortField, setSortField] = useState<SortField>("email");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  // Add User Dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserFullName, setNewUserFullName] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserInstitution, setNewUserInstitution] = useState("");
  const [newUserRole, setNewUserRole] = useState("student");

  // Add to Institution Dialog
  const [addToInstDialogOpen, setAddToInstDialogOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedInstitution, setSelectedInstitution] = useState("");
  const [selectedRole, setSelectedRole] = useState("student");
  const [isAddingToInst, setIsAddingToInst] = useState(false);

  // Delete/Remove dialogs
  const [deleteUserDialogOpen, setDeleteUserDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<UserWithInstitutions | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [nameReviewRows, setNameReviewRows] = useState<NameReviewCandidate[]>([]);
  const [nameReviewDownloaded, setNameReviewDownloaded] = useState(false);
  const [resetPasswordUser, setResetPasswordUser] = useState<UserWithInstitutions | null>(null);
  const [exportingUserId, setExportingUserId] = useState<string | null>(null);
  const [removeFromInstDialogOpen, setRemoveFromInstDialogOpen] = useState(false);
  const [institutionToRemove, setInstitutionToRemove] = useState<{
    userId: string;
    institutionId: string;
    institutionName: string;
  } | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  // Edit Role Dialog
  const [editRoleDialogOpen, setEditRoleDialogOpen] = useState(false);
  const [roleToEdit, setRoleToEdit] = useState<{
    userId: string;
    institutionId: string;
    institutionName: string;
    currentRole: string;
  } | null>(null);
  const [newRole, setNewRole] = useState("student");
  const [isUpdatingRole, setIsUpdatingRole] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      navigate("/auth");
      return;
    }

    if (user) {
      checkSuperAdmin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- check on user/loading change
  }, [user, loading, navigate]);

  const checkSuperAdmin = async () => {
    try {
      const { data, error } = await supabase.rpc("is_super_admin", {
        _user_id: user!.id,
      });

      if (error) {
        console.error("Error checking super admin status:", error);
        setIsSuperAdmin(false);
        return;
      }

      setIsSuperAdmin(data);

      if (data) {
        await Promise.all([fetchUsers(), fetchInstitutions()]);
      }
      setLoadingData(false);
    } catch (error) {
      console.error("Error:", error);
      setIsSuperAdmin(false);
      setLoadingData(false);
    }
  };

  const fetchUsers = async () => {
    try {
      // Get all profiles
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .order("email");

      if (profilesError) throw profilesError;

      // Get all user_institutions with institution names
      const { data: memberships, error: membershipsError } = await supabase
        .from("user_institutions")
        .select(`
          user_id,
          institution_id,
          role,
          institutions:institution_id (name)
        `);

      if (membershipsError) throw membershipsError;

      // Get auth info (last sign in) for each user
      const authInfoPromises = (profiles || []).map(async (profile) => {
        const { data } = await supabase.rpc("get_user_auth_info", {
          _user_id: profile.user_id,
        });
        return {
          user_id: profile.user_id,
          last_sign_in_at: data?.[0]?.last_sign_in_at || null,
        };
      });
      
      const authInfoResults = await Promise.all(authInfoPromises);
      const authInfoMap = new Map(
        authInfoResults.map((r) => [r.user_id, r.last_sign_in_at])
      );

      // Map profiles to include their institutions and last login
      const usersWithInstitutions: UserWithInstitutions[] = (profiles || []).map((profile) => {
        const userMemberships = (memberships || []).filter(
          (m) => m.user_id === profile.user_id
        );

        return {
          user_id: profile.user_id,
          full_name: profile.full_name,
          email: profile.email,
          last_sign_in_at: authInfoMap.get(profile.user_id) || null,
          institutions: userMemberships.map((m) => ({
            institution_id: m.institution_id,
            institution_name: (m.institutions as any)?.name || "Unknown",
            role: m.role,
          })),
        };
      });

      setUsers(usersWithInstitutions);
    } catch (error) {
      console.error("Error fetching users:", error);
      toast.error("Failed to fetch users");
    }
  };

  const fetchInstitutions = async () => {
    try {
      const { data, error } = await supabase
        .from("institutions")
        .select("id, name")
        .order("name");

      if (error) throw error;
      setInstitutions(data || []);
    } catch (error) {
      console.error("Error fetching institutions:", error);
    }
  };

  const filteredAndSortedUsers = useMemo(() => {
    const filtered = users.filter((user) => {
      // Search filter
      const matchesSearch =
        !searchQuery ||
        user.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        user.full_name?.toLowerCase().includes(searchQuery.toLowerCase());

      // Institution filter
      const matchesInstitution =
        filterInstitution === "all" ||
        user.institutions.some((i) => i.institution_id === filterInstitution);

      // Role filter
      const matchesRole =
        filterRole === "all" ||
        user.institutions.some((i) => i.role === filterRole);

      return matchesSearch && matchesInstitution && matchesRole;
    });

    // Sort
    return [...filtered].sort((a, b) => {
      let aVal: string | null = null;
      let bVal: string | null = null;

      switch (sortField) {
        case "email":
          aVal = a.email?.toLowerCase() || "";
          bVal = b.email?.toLowerCase() || "";
          break;
        case "full_name":
          aVal = a.full_name?.toLowerCase() || "";
          bVal = b.full_name?.toLowerCase() || "";
          break;
        case "last_sign_in_at":
          aVal = a.last_sign_in_at || "";
          bVal = b.last_sign_in_at || "";
          break;
      }

      if (aVal < bVal) return sortDirection === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });
  }, [users, searchQuery, filterInstitution, filterRole, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <ArrowUpDown className="w-4 h-4 ml-1" />;
    }
    return sortDirection === "asc" ? (
      <ArrowUp className="w-4 h-4 ml-1" />
    ) : (
      <ArrowDown className="w-4 h-4 ml-1" />
    );
  };

  // Reset to page 1 when filters or sort change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, filterInstitution, filterRole, sortField, sortDirection]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredAndSortedUsers.length / ITEMS_PER_PAGE);
  const paginatedUsers = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredAndSortedUsers.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [filteredAndSortedUsers, currentPage]);

  const formatLastLogin = (dateStr: string | null) => {
    if (!dateStr) return "Never";
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      if (diffHours === 0) {
        const diffMins = Math.floor(diffMs / (1000 * 60));
        return diffMins <= 1 ? "Just now" : `${diffMins} min ago`;
      }
      return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
    }
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) > 1 ? "s" : ""} ago`;
    
    return formatDate(date);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!newUserInstitution) {
      toast.error("Please select an institution");
      return;
    }

    if (newUserPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }

    setIsCreating(true);

    try {
      const { data, error } = await supabase.functions.invoke("create-user", {
        body: {
          email: newUserEmail,
          password: newUserPassword,
          fullName: newUserFullName || undefined,
          institutionId: newUserInstitution,
          role: newUserRole,
        },
      });

      if (error) throw error;

      if (data?.error) {
        throw new Error(data.error);
      }

      toast.success("User created successfully");
      setAddDialogOpen(false);
      resetAddUserForm();
      fetchUsers();
    } catch (error: any) {
      console.error("Error creating user:", error);
      toast.error(error.message || "Failed to create user");
    } finally {
      setIsCreating(false);
    }
  };

  const resetAddUserForm = () => {
    setNewUserEmail("");
    setNewUserFullName("");
    setNewUserPassword("");
    setNewUserInstitution("");
    setNewUserRole("student");
  };

  const openAddToInstitutionDialog = (userId: string) => {
    setSelectedUserId(userId);
    setSelectedInstitution("");
    setSelectedRole("student");
    setAddToInstDialogOpen(true);
  };

  const handleAddToInstitution = async () => {
    if (!selectedUserId || !selectedInstitution) {
      toast.error("Please select an institution");
      return;
    }

    setIsAddingToInst(true);

    try {
      const { error } = await supabase.from("user_institutions").insert({
        user_id: selectedUserId,
        institution_id: selectedInstitution,
        role: selectedRole,
      });

      if (error) {
        if (error.code === "23505") {
          throw new Error("User already belongs to this institution");
        }
        throw error;
      }

      toast.success("User added to institution");
      setAddToInstDialogOpen(false);
      fetchUsers();
    } catch (error: any) {
      console.error("Error adding user to institution:", error);
      toast.error(error.message || "Failed to add user to institution");
    } finally {
      setIsAddingToInst(false);
    }
  };

  const openDeleteUserDialog = (user: UserWithInstitutions) => {
    setUserToDelete(user);
    setDeleteUserDialogOpen(true);
  };

  const handleDeleteUser = async () => {
    if (!userToDelete) return;

    setIsDeleting(true);

    try {
      const { data, error } = await supabase.functions.invoke("delete-user", {
        body: { userId: userToDelete.user_id },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      // The account always goes, but parts of the erasure that a foreign key
      // cannot reach (storage objects, email-keyed rows) can fail on their own.
      // An admin acting on an Art. 17 request has to be told the erasure was
      // partial, otherwise they report it as complete. See issue #932.
      const warnings: Array<{ source: string; message: string }> = data?.warnings ?? [];
      if (warnings.length > 0) {
        toast.warning(
          `User deleted, but some data could not be erased: ${warnings
            .map((w) => w.source)
            .join(", ")}. Re-run or clear it manually before confirming the request.`,
          { duration: 15000 },
        );
      } else {
        toast.success("User deleted successfully");
      }

      // Instructor-typed names that survived the cascade. Shown in a dialog
      // rather than a toast: this is the review step the erasure procedure
      // requires before the request is confirmed complete, and it needs the
      // actual rows, not a count that scrolls away.
      const reviewRows: NameReviewCandidate[] = data?.nameReviewCandidates ?? [];
      if (reviewRows.length > 0) {
        setNameReviewRows(reviewRows);
        setNameReviewDownloaded(false);
      }

      setDeleteUserDialogOpen(false);
      setUserToDelete(null);
      fetchUsers();
    } catch (error: any) {
      console.error("Error deleting user:", error);
      toast.error(error.message || "Failed to delete user");
    } finally {
      setIsDeleting(false);
    }
  };

  /**
   * GDPR Art. 15/20 subject access request. Schools email the request in; a
   * super admin runs the export and hands the requesting school its own
   * section of the document.
   */
  const handleExportUserData = async (user: UserWithInstitutions) => {
    setExportingUserId(user.user_id);

    try {
      const { data, error } = await supabase.functions.invoke("export-data", {
        body: { action: "export-user", userId: user.user_id },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const slug = (user.email || user.user_id).replace(/[^a-zA-Z0-9._-]/g, "_");
      link.download = `gdpr-export-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      const failed = Object.keys(data?.errors ?? {});
      if (failed.length > 0) {
        toast.warning(
          `Export downloaded, but ${failed.length} table(s) could not be read: ${failed.join(", ")}`
        );
      } else {
        toast.success("User data export downloaded");
      }
    } catch (error: any) {
      console.error("Error exporting user data:", error);
      toast.error(error.message || "Failed to export user data");
    } finally {
      setExportingUserId(null);
    }
  };

  const openRemoveFromInstDialog = (
    userId: string,
    institutionId: string,
    institutionName: string
  ) => {
    setInstitutionToRemove({ userId, institutionId, institutionName });
    setRemoveFromInstDialogOpen(true);
  };

  const handleRemoveFromInstitution = async () => {
    if (!institutionToRemove) return;

    setIsRemoving(true);

    try {
      // Removing the membership must also drop any evaluator course
      // assignments — RLS grants evaluator reads through `course_evaluators`
      // alone, so otherwise a user with no membership at all keeps reading the
      // institution's courses. `_role: null` means "remove", and the function
      // does both writes in one transaction (20260726120000).
      // `_role` omitted — the function's NULL default means "remove the
      // membership" rather than "set it to this role".
      const { error } = await supabase.rpc("set_institution_membership_role", {
        _user_id: institutionToRemove.userId,
        _institution_id: institutionToRemove.institutionId,
      });

      if (error) throw error;

      toast.success("User removed from institution");
      setRemoveFromInstDialogOpen(false);
      setInstitutionToRemove(null);
      fetchUsers();
    } catch (error: any) {
      console.error("Error removing user from institution:", error);
      toast.error(error.message || "Failed to remove user from institution");
    } finally {
      setIsRemoving(false);
    }
  };

  const openEditRoleDialog = (
    userId: string,
    institutionId: string,
    institutionName: string,
    currentRole: string
  ) => {
    setRoleToEdit({ userId, institutionId, institutionName, currentRole });
    // An evaluator's current role has no matching item in the select below, and
    // Radix renders a blank trigger for a value it cannot match. Start empty so
    // the placeholder shows and the button stays disabled until a role is
    // chosen, rather than looking like a role is already selected.
    setNewRole(
      (ASSIGNABLE_ROLES as readonly string[]).includes(currentRole) ? currentRole : ""
    );
    setEditRoleDialogOpen(true);
  };

  const handleUpdateRole = async () => {
    if (!roleToEdit) return;

    setIsUpdatingRole(true);

    try {
      // Moving off `evaluator` has to take the course assignments with it, or
      // the new student/instructor keeps evaluator read access to every course
      // they reviewed. Both writes happen in one transaction inside the
      // function (20260726120000): done from here they could not be atomic, and
      // a half-applied change either strands the user without the assignments
      // it just deleted or leaves the access it failed to revoke.
      const { error } = await supabase.rpc("set_institution_membership_role", {
        _user_id: roleToEdit.userId,
        _institution_id: roleToEdit.institutionId,
        _role: newRole,
      });

      if (error) throw error;

      toast.success("Role updated successfully");
      setEditRoleDialogOpen(false);
      setRoleToEdit(null);
      fetchUsers();
    } catch (error: any) {
      console.error("Error updating role:", error);
      toast.error(error.message || "Failed to update role");
    } finally {
      setIsUpdatingRole(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  // Stats. A user holding the role in any institution counts once, so someone
  // who is an admin at one school and an instructor at another appears in both
  // buckets — the cards describe roles in use, not a partition of the total.
  // "No institution" is broken out because those users belong to no bucket at
  // all, which is what made the total look wrong against the role cards.
  const totalUsers = users.length;
  const countWithRole = (role: string) =>
    users.filter((u) => u.institutions.some((i) => i.role === role)).length;

  const stats = [
    { label: "Total Users", value: totalUsers, tone: "bg-primary/10 text-primary" },
    { label: "Admins", value: countWithRole("admin"), tone: "bg-destructive/10 text-destructive" },
    // Colours follow the role badges on SelectInstitution: blue instructor,
    // amber evaluator, emerald student. The instructor card previously used
    // `bg-warning/10 text-warning`, a token this project never defined, so it
    // rendered untinted.
    { label: "Instructors", value: countWithRole("instructor"), tone: "bg-blue-500/10 text-blue-600" },
    { label: "Evaluators", value: countWithRole("evaluator"), tone: "bg-amber-500/10 text-amber-600" },
    { label: "Students", value: countWithRole("student"), tone: "bg-emerald-500/10 text-emerald-600" },
    {
      label: "No institution",
      value: users.filter((u) => u.institutions.length === 0).length,
      tone: "bg-secondary text-muted-foreground",
    },
  ];

  if (loading || loadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isSuperAdmin === false) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md w-full mx-4">
          <CardHeader className="text-center">
            <CardTitle className="text-destructive">Access Denied</CardTitle>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button onClick={() => navigate("/dashboard")}>
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <BookOpen className="w-6 h-6 text-primary-foreground" />
            </div>
            <div>
              <span className="text-xl font-display font-bold text-foreground">
                Noisis
              </span>
              <span className="ml-2 text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
                Super Admin
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Link to="/super-admin">
              <Button variant="outline">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Dashboard
              </Button>
            </Link>
            <Button variant="ghost" onClick={handleSignOut}>
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </div>
      </nav>

      <div className="container mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-display font-bold text-foreground">
              User Management
            </h1>
            <p className="text-muted-foreground mt-1">
              Manage all users across institutions
            </p>
          </div>
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="gold">
                <Plus className="w-4 h-4 mr-2" />
                Add User
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New User</DialogTitle>
                <DialogDescription>
                  Create a new user and assign them to an institution
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreateUser} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="user@example.com"
                    value={newUserEmail}
                    onChange={(e) => setNewUserEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="fullName">Full Name (Optional)</Label>
                  <Input
                    id="fullName"
                    placeholder="John Doe"
                    value={newUserFullName}
                    onChange={(e) => setNewUserFullName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="Min 8 characters"
                    value={newUserPassword}
                    onChange={(e) => setNewUserPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Institution</Label>
                  <Select
                    value={newUserInstitution}
                    onValueChange={setNewUserInstitution}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select institution" />
                    </SelectTrigger>
                    <SelectContent>
                      {institutions.map((inst) => (
                        <SelectItem key={inst.id} value={inst.id}>
                          {inst.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Role</Label>
                  <Select value={newUserRole} onValueChange={setNewUserRole}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="student">Student</SelectItem>
                      <SelectItem value="instructor">Instructor</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" className="w-full" disabled={isCreating}>
                  {isCreating ? (
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

        {/* Stats */}
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-8"
          data-testid="user-stats"
        >
          {stats.map((stat) => (
            <Card key={stat.label} data-testid={`stat-${stat.label}`}>
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${stat.tone}`}>
                    <Users className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{stat.value}</p>
                    <p className="text-sm text-muted-foreground">{stat.label}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search by email or name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select value={filterInstitution} onValueChange={setFilterInstitution}>
                <SelectTrigger className="w-full md:w-[200px]">
                  <SelectValue placeholder="Filter by institution" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Institutions</SelectItem>
                  {institutions.map((inst) => (
                    <SelectItem key={inst.id} value={inst.id}>
                      {inst.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterRole} onValueChange={setFilterRole}>
                <SelectTrigger className="w-full md:w-[150px]">
                  <SelectValue placeholder="Filter by role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Roles</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="instructor">Instructor</SelectItem>
                  <SelectItem value="evaluator">Evaluator</SelectItem>
                  <SelectItem value="student">Student</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Users Table */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              All Users ({filteredAndSortedUsers.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {filteredAndSortedUsers.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No users found</p>
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        <button
                          onClick={() => handleSort("email")}
                          className="flex items-center hover:text-foreground transition-colors"
                        >
                          Email
                          {getSortIcon("email")}
                        </button>
                      </TableHead>
                      <TableHead>
                        <button
                          onClick={() => handleSort("full_name")}
                          className="flex items-center hover:text-foreground transition-colors"
                        >
                          Full Name
                          {getSortIcon("full_name")}
                        </button>
                      </TableHead>
                      <TableHead>Institutions</TableHead>
                      <TableHead>
                        <button
                          onClick={() => handleSort("last_sign_in_at")}
                          className="flex items-center hover:text-foreground transition-colors"
                        >
                          Last Login
                          {getSortIcon("last_sign_in_at")}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedUsers.map((u) => (
                      <TableRow key={u.user_id}>
                        <TableCell className="font-medium">
                          {u.email || "—"}
                        </TableCell>
                        <TableCell>{u.full_name || "—"}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {u.institutions.length === 0 ? (
                              <span className="text-muted-foreground text-sm">
                                No institution
                              </span>
                            ) : (
                              u.institutions.map((inst) => (
                                <Badge
                                  key={inst.institution_id}
                                  variant={
                                    inst.role === "admin"
                                      ? "destructive"
                                      : inst.role === "instructor"
                                      ? "default"
                                      : inst.role === "evaluator"
                                      ? "outline"
                                      : "secondary"
                                  }
                                  className="text-xs"
                                >
                                  {inst.institution_name} ({inst.role})
                                </Badge>
                              ))
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">
                            {formatLastLogin(u.last_sign_in_at)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm">
                                <MoreHorizontal className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => openAddToInstitutionDialog(u.user_id)}
                              >
                                <UserPlus className="w-4 h-4 mr-2" />
                                Add to Institution
                              </DropdownMenuItem>
                              {u.institutions.length > 0 && (
                                <>
                                  <DropdownMenuSeparator />
                                  {u.institutions.map((inst) => (
                                    <DropdownMenuItem
                                      key={`edit-${inst.institution_id}`}
                                      onClick={() =>
                                        openEditRoleDialog(
                                          u.user_id,
                                          inst.institution_id,
                                          inst.institution_name,
                                          inst.role
                                        )
                                      }
                                    >
                                      <Pencil className="w-4 h-4 mr-2" />
                                      Edit role in {inst.institution_name}
                                    </DropdownMenuItem>
                                  ))}
                                  <DropdownMenuSeparator />
                                  {u.institutions.map((inst) => (
                                    <DropdownMenuItem
                                      key={`remove-${inst.institution_id}`}
                                      onClick={() =>
                                        openRemoveFromInstDialog(
                                          u.user_id,
                                          inst.institution_id,
                                          inst.institution_name
                                        )
                                      }
                                    >
                                      <UserMinus className="w-4 h-4 mr-2" />
                                      Remove from {inst.institution_name}
                                    </DropdownMenuItem>
                                  ))}
                                </>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setResetPasswordUser(u)}
                              >
                                <Key className="w-4 h-4 mr-2" />
                                Reset password
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={exportingUserId === u.user_id}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  handleExportUserData(u);
                                }}
                              >
                                {exportingUserId === u.user_id ? (
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                ) : (
                                  <Download className="w-4 h-4 mr-2" />
                                )}
                                Export user data (GDPR)
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => openDeleteUserDialog(u)}
                              >
                                <Trash2 className="w-4 h-4 mr-2" />
                                Delete User
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4 pt-4 border-t">
                    <p className="text-sm text-muted-foreground">
                      Showing {(currentPage - 1) * ITEMS_PER_PAGE + 1} to{" "}
                      {Math.min(currentPage * ITEMS_PER_PAGE, filteredAndSortedUsers.length)} of{" "}
                      {filteredAndSortedUsers.length} users
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                      >
                        <ChevronLeft className="w-4 h-4" />
                        Previous
                      </Button>
                      <span className="text-sm text-muted-foreground px-2">
                        Page {currentPage} of {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                      >
                        Next
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Add to Institution Dialog */}
      <Dialog open={addToInstDialogOpen} onOpenChange={setAddToInstDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add User to Institution</DialogTitle>
            <DialogDescription>
              Assign this user to an additional institution
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Institution</Label>
              <Select
                value={selectedInstitution}
                onValueChange={setSelectedInstitution}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select institution" />
                </SelectTrigger>
                <SelectContent>
                  {institutions.map((inst) => (
                    <SelectItem key={inst.id} value={inst.id}>
                      {inst.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={selectedRole} onValueChange={setSelectedRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="student">Student</SelectItem>
                  <SelectItem value="instructor">Instructor</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full"
              onClick={handleAddToInstitution}
              disabled={isAddingToInst}
            >
              {isAddingToInst ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Adding...
                </>
              ) : (
                "Add to Institution"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Remove from Institution Dialog */}
      <AlertDialog
        open={removeFromInstDialogOpen}
        onOpenChange={setRemoveFromInstDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from Institution</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this user from{" "}
              <strong>{institutionToRemove?.institutionName}</strong>? They will
              lose access to all courses and data in this institution.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveFromInstitution}
              disabled={isRemoving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRemoving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Removing...
                </>
              ) : (
                "Remove"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete User Dialog */}
      <AlertDialog
        open={deleteUserDialogOpen}
        onOpenChange={setDeleteUserDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete{" "}
              <strong>{userToDelete?.email}</strong>? This action cannot be
              undone and will remove all their data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteUser}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Deleting...
                </>
              ) : (
                "Delete User"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Post-erasure name review: rows whose typed student name still matches
          the erased subject. The account is already gone — this dialog exists
          so the admin either clears these rows or attests they belong to a
          same-named other student BEFORE reporting the Art. 17 request
          complete. The procedure is the operator's private compliance record
          (docs/compliance/README.md). */}
      <Dialog
        open={nameReviewRows.length > 0}
        onOpenChange={(open) => {
          // This list is the ONLY copy of the review candidates: the audit
          // keeps a count, and the profile name that keyed the search is
          // already erased, so the search cannot be re-run. The dialog
          // therefore refuses to close until the list has been downloaded.
          if (!open && nameReviewDownloaded) setNameReviewRows([]);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Erasure needs review</DialogTitle>
            <DialogDescription>
              The account was deleted, but {nameReviewRows.length} row(s) still
              carry a typed student name matching the deleted user. A row with a
              linked account belongs to a <em>different</em> student who shares
              the name — leave it alone. An unlinked row is likely the subject's:
              clear its name before confirming the erasure request as complete.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead>Typed name</TableHead>
                  <TableHead>Linked account</TableHead>
                  <TableHead>Row id</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {nameReviewRows.map((row) => (
                  <TableRow key={`${row.source}-${row.rowId}`}>
                    <TableCell className="whitespace-nowrap">{row.source}</TableCell>
                    <TableCell>{row.studentName}</TableCell>
                    <TableCell>
                      {row.linkedUserId ? (
                        <Badge variant="secondary">other student</Badge>
                      ) : (
                        <Badge variant="destructive">unlinked</Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.rowId}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(row.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-end gap-2">
            {!nameReviewDownloaded && (
              <p className="text-xs text-muted-foreground mr-auto">
                Download the list first — it cannot be regenerated after this dialog closes.
              </p>
            )}
            <Button
              variant="outline"
              onClick={() => {
                const blob = new Blob([JSON.stringify(nameReviewRows, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `erasure-name-review-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                setNameReviewDownloaded(true);
              }}
            >
              <Download className="w-4 h-4 mr-2" />
              Download list
            </Button>
            <Button
              disabled={!nameReviewDownloaded}
              onClick={() => setNameReviewRows([])}
            >
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {resetPasswordUser && (
        <ResetUserPasswordDialog
          userId={resetPasswordUser.user_id}
          userLabel={resetPasswordUser.full_name || resetPasswordUser.email}
          open={!!resetPasswordUser}
          onOpenChange={(open) => {
            if (!open) setResetPasswordUser(null);
          }}
        />
      )}

      {/* Edit Role Dialog */}
      <Dialog open={editRoleDialogOpen} onOpenChange={setEditRoleDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Role</DialogTitle>
            <DialogDescription>
              Change user's role in <strong>{roleToEdit?.institutionName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Current Role</Label>
              <p className="text-sm text-muted-foreground capitalize">
                {roleToEdit?.currentRole}
              </p>
            </div>
            <div className="space-y-2">
              <Label>New Role</Label>
              <Select value={newRole} onValueChange={setNewRole}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Evaluator is deliberately absent: the role is only usable
                  alongside course_evaluators rows, and this dialog has no
                  course picker. UserManagement.tsx refuses the same change for
                  the same reason. */}
              <p className="text-xs text-muted-foreground">
                To make someone an evaluator, invite them with that role from the
                institution's own user management, where the courses they will
                review can be picked.
              </p>
            </div>
            <Button
              className="w-full"
              onClick={handleUpdateRole}
              disabled={isUpdatingRole || !newRole || newRole === roleToEdit?.currentRole}
            >
              {isUpdatingRole ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Updating...
                </>
              ) : (
                "Update Role"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SuperAdminUsers;
