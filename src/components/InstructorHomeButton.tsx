import { Home } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useIsSuperAdmin } from "@/hooks/useIsSuperAdmin";
import { useUserInstitution } from "@/hooks/useUserInstitution";

/**
 * Header "Instructor's Home" button linking to /instructor. Gates on the caller's role in
 * the selected institution itself, so pages can drop it into any header
 * without threading role state through. Shown to instructors, admins, and
 * super admins — admins may look around the instructor surface (same rule as
 * the InstructorHome bounce logic); super admins have no membership row at
 * all, hence the separate RPC check.
 */
export function InstructorHomeButton() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { isInstructor, isAdmin, loading } = useUserInstitution(user?.id);
  // Wait for membership before consulting the RPC: while loading, both role
  // flags are false, and firing then would ask "super admin?" for every
  // instructor and admin header too.
  const { data: isSuperAdmin } = useIsSuperAdmin(user?.id, {
    enabled: !loading && !isInstructor && !isAdmin,
  });

  if (!isInstructor && !isAdmin && !isSuperAdmin) return null;

  return (
    <Button
      variant="default"
      size="sm"
      aria-label="Instructor's Home"
      onClick={() => navigate("/instructor")}
    >
      <Home className="w-4 h-4" />
      <span className="hidden sm:inline">Instructor's Home</span>
    </Button>
  );
}
