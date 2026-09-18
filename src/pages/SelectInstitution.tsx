import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { SafeImage } from "@/components/SafeImage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCountryName } from "@/lib/country-options";
import { toast } from "sonner";
import {
  LogOut,
  Loader2,
  Building,
  ArrowRight,
  Shield,
  Globe,
  GraduationCap,
  User,
  UserPlus,
  ClipboardCheck,
} from "lucide-react";
import { clearSelectedInstitutionId, setSelectedInstitutionId } from "@/lib/selected-institution";
import { BrandMark } from "@/components/BrandMark";

interface Institution {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  is_public?: boolean;
  role?: string | null;
  country?: string | null;
  description?: string | null;
}

const SelectInstitution = () => {
  const navigate = useNavigate();
  const { user, profile, loading, signOut } = useAuth();
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [autoRedirected, setAutoRedirected] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      navigate("/auth");
      return;
    }

    if (user) {
      checkAccessAndFetchInstitutions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on user/loading change
  }, [user, loading, navigate]);

  // Auto-redirect when user belongs to exactly one institution and no public ones to browse
  useEffect(() => {
    if (loading || loadingData || isSuperAdmin || autoRedirected) return;

    const memberInsts = institutions.filter(i => i.role);
    const publicInsts = institutions.filter(i => !i.role && i.is_public);

    if (memberInsts.length === 1 && publicInsts.length === 0) {
      setAutoRedirected(true);
      handleSelectInstitution(memberInsts[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- redirect once when institutions are loaded
  }, [institutions, loading, loadingData, isSuperAdmin, autoRedirected]);

  const checkAccessAndFetchInstitutions = async () => {
    try {
      // Check if super admin
      const { data: superAdminData } = await supabase.rpc("is_super_admin", {
        _user_id: user!.id,
      });
      setIsSuperAdmin(superAdminData || false);

      if (superAdminData) {
        // Super admin can see all institutions
        const { data: allInstitutions } = await supabase
          .from("institutions")
          .select("id, name, slug, logo_url, country, description")
          .order("name");
        setInstitutions(allInstitutions || []);
      } else {
        // Regular user - fetch institutions they belong to via user_institutions table
        const { data: userInstitutionLinks } = await supabase
          .from("user_institutions")
          .select("institution_id, role, institutions(id, name, slug, logo_url, is_public, country, description)")
          .eq("user_id", user!.id);
        
        // Also fetch public institutions
        const { data: publicInstitutions } = await supabase
          .from("institutions")
          .select("id, name, slug, logo_url, is_public, country, description")
          .eq("is_public", true);
        
        const memberInstitutions = userInstitutionLinks
          ? userInstitutionLinks
              .map(link => {
                const inst = link.institutions as unknown as Institution;
                if (inst) {
                  inst.role = link.role;
                }
                return inst;
              })
              .filter(Boolean)
          : [];
        
        // Combine member institutions with public institutions (avoiding duplicates)
        const memberIds = new Set(memberInstitutions.map(i => i.id));
        const additionalPublic = (publicInstitutions || []).filter(i => !memberIds.has(i.id))
          .map(i => ({ ...i, role: null })); // Public institutions user isn't a member of
        
        setInstitutions([...memberInstitutions, ...additionalPublic]);
      }
    } catch (error) {
      console.error("Error fetching institutions:", error);
    } finally {
      setLoadingData(false);
    }
  };

  const handleJoinInstitution = async (institution: Institution, e: React.MouseEvent) => {
    e.stopPropagation();
    setJoiningId(institution.id);
    
    try {
      const { error } = await supabase
        .from("user_institutions")
        .insert({
          user_id: user!.id,
          institution_id: institution.id,
          role: "student",
        });
      
      if (error) {
        console.error("Error joining institution:", error);
        toast.error("Failed to join institution");
        return;
      }
      
      toast.success(`Joined ${institution.name} successfully!`);
      
      // Update local state to reflect the join
      setInstitutions(prev => 
        prev.map(inst => 
          inst.id === institution.id 
            ? { ...inst, role: "student" } 
            : inst
        )
      );
      
      // Navigate to student dashboard
      setSelectedInstitutionId(institution.id);
      navigate("/student");
    } catch (error) {
      console.error("Error joining institution:", error);
      toast.error("Failed to join institution");
    } finally {
      setJoiningId(null);
    }
  };

  const handleSelectInstitution = (institution: Institution) => {
    // If user is not a member and institution is public, don't navigate (they need to click Join)
    if (!isSuperAdmin && !institution.role && institution.is_public) {
      return;
    }

    // Store selected institution in session storage
    setSelectedInstitutionId(institution.id);

    // Navigate based on role (super admins and admins go to dashboard;
    // instructors get the action-oriented home; evaluators (#667) go to
    // their dedicated workspace)
    // Use the already-fetched role from user_institutions to avoid race conditions
    if (isSuperAdmin || institution.role === "admin") {
      navigate("/dashboard");
    } else if (institution.role === "instructor") {
      navigate("/instructor");
    } else if (institution.role === "evaluator") {
      navigate("/evaluator");
    } else {
      navigate("/student");
    }
  };

  const handleSignOut = async () => {
    clearSelectedInstitutionId();
    await signOut();
    navigate("/");
  };

  if (loading || loadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // Separate member institutions from public institutions user hasn't joined
  const memberInstitutions = institutions.filter(i => i.role);
  const publicInstitutions = institutions.filter(i => !i.role && i.is_public);

  // Show loading spinner while auto-redirect is in progress
  if (autoRedirected) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // No institutions available
  if (institutions.length === 0 && !isSuperAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <nav className="border-b border-border bg-card">
          <div className="container mx-auto px-6 py-4 flex items-center justify-between">
            <BrandMark />
            <Button variant="ghost" onClick={handleSignOut}>
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </nav>

        <div className="container mx-auto px-6 py-16">
          <div className="max-w-xl mx-auto text-center">
            <div className="w-20 h-20 rounded-2xl bg-secondary flex items-center justify-center mx-auto mb-8">
              <Building className="w-10 h-10 text-muted-foreground" />
            </div>
            <h1 className="text-3xl font-display font-bold text-foreground mb-4">
              No Institution Access
            </h1>
            <p className="text-muted-foreground mb-8">
              You haven't been assigned to an institution yet. Please contact your administrator or wait for an invitation.
            </p>
            <Button variant="outline" onClick={handleSignOut}>
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="border-b border-border bg-card">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <BrandMark
            badge={
              isSuperAdmin && (
                <span className="ml-2 text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
                  Super Admin
                </span>
              )
            }
          />
          <div className="flex items-center gap-2">
            {isSuperAdmin && (
              <Button variant="outline" onClick={() => navigate("/super-admin")}>
                <Shield className="w-4 h-4 mr-2" />
                Manage All
              </Button>
            )}
            <Button variant="ghost" onClick={handleSignOut}>
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </div>
      </nav>

      <div className="container mx-auto px-6 py-16">
        <div className="max-w-2xl mx-auto">
          {/* Your Institutions Section */}
          {(memberInstitutions.length > 0 || isSuperAdmin) && (
            <>
              <div className="mb-6">
                <h2 className="text-2xl font-display font-bold text-foreground mb-2">
                  Your Institutions
                </h2>
                <p className="text-muted-foreground">
                  {isSuperAdmin 
                    ? "Choose an institution to manage"
                    : "Select an institution to continue"
                  }
                </p>
              </div>

              <div className="space-y-3 mb-12">
                {(isSuperAdmin ? institutions : memberInstitutions).map((institution) => (
                  <Card 
                    key={institution.id}
                    className="cursor-pointer hover:bg-secondary/50 transition-colors group"
                    onClick={() => handleSelectInstitution(institution)}
                  >
                    <CardContent className="flex items-center justify-between p-4">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center overflow-hidden">
                          <SafeImage
                            src={institution.logo_url || undefined}
                            alt={`${institution.name} institution logo`}
                            wrapperClassName="w-12 h-12"
                            className="w-full h-full object-contain"
                            fallback={
                              <Building className="w-6 h-6 text-primary" />
                            }
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium text-foreground">{institution.name}</p>
                            {institution.country && (
                              <span className="text-xs text-muted-foreground">
                                {getCountryName(institution.country)}
                              </span>
                            )}
                            {institution.is_public && (
                              <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-full">
                                <Globe className="w-3 h-3" />
                                Public
                              </span>
                            )}
                          </div>
                          {institution.description && (
                            <p className="text-sm text-muted-foreground line-clamp-1 mt-0.5">
                              {institution.description}
                            </p>
                          )}
                          <div className="flex items-center gap-2 mt-1">
                            <p className="text-sm text-muted-foreground">/i/{institution.slug}</p>
                            {isSuperAdmin ? (
                              <span className="flex items-center gap-1 text-xs text-purple-600 bg-purple-500/10 px-2 py-0.5 rounded-full">
                                <Shield className="w-3 h-3" />
                                Super Admin
                              </span>
                            ) : institution.role === "admin" ? (
                              <span className="flex items-center gap-1 text-xs text-purple-600 bg-purple-500/10 px-2 py-0.5 rounded-full">
                                <Shield className="w-3 h-3" />
                                Admin
                              </span>
                            ) : institution.role === "instructor" ? (
                              <span className="flex items-center gap-1 text-xs text-blue-600 bg-blue-500/10 px-2 py-0.5 rounded-full">
                                <GraduationCap className="w-3 h-3" />
                                Instructor
                              </span>
                            ) : institution.role === "student" ? (
                              <span className="flex items-center gap-1 text-xs text-emerald-600 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                                <User className="w-3 h-3" />
                                Student
                              </span>
                            ) : institution.role === "evaluator" ? (
                              <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-full">
                                <ClipboardCheck className="w-3 h-3" />
                                Evaluator
                              </span>
                            ) : institution.role ? (
                              <span className="flex items-center gap-1 text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                                <User className="w-3 h-3" />
                                {institution.role}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-foreground transition-colors" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}

          {/* Browse Public Institutions Section */}
          {!isSuperAdmin && publicInstitutions.length > 0 && (
            <>
              <div className="mb-6">
                <h2 className="text-2xl font-display font-bold text-foreground mb-2">
                  Browse Public Institutions
                </h2>
                <p className="text-muted-foreground">
                  Discover and join public institutions
                </p>
              </div>

              <div className="space-y-3">
                {publicInstitutions.map((institution) => {
                  const isJoining = joiningId === institution.id;
                  
                  return (
                    <Card 
                      key={institution.id}
                      className="border-dashed"
                    >
                      <CardContent className="flex items-center justify-between p-4">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center overflow-hidden">
                            <SafeImage
                              src={institution.logo_url || undefined}
                              alt={`${institution.name} institution logo`}
                              wrapperClassName="w-12 h-12"
                              className="w-full h-full object-contain"
                              fallback={
                                <Building className="w-6 h-6 text-primary" />
                              }
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-foreground">{institution.name}</p>
                              {institution.country && (
                                <span className="text-xs text-muted-foreground">
                                  {getCountryName(institution.country)}
                                </span>
                              )}
                              <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-full">
                                <Globe className="w-3 h-3" />
                                Public
                              </span>
                            </div>
                            {institution.description && (
                              <p className="text-sm text-muted-foreground line-clamp-1 mt-0.5">
                                {institution.description}
                              </p>
                            )}
                            <p className="text-sm text-muted-foreground mt-1">/i/{institution.slug}</p>
                          </div>
                        </div>
                        
                        <Button
                          size="sm"
                          onClick={(e) => handleJoinInstitution(institution, e)}
                          disabled={isJoining}
                        >
                          {isJoining ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <>
                              <UserPlus className="w-4 h-4 mr-1" />
                              Join
                            </>
                          )}
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </>
          )}

          {/* No institutions at all */}
          {!isSuperAdmin && memberInstitutions.length === 0 && publicInstitutions.length === 0 && (
            <div className="text-center py-12">
              <div className="w-20 h-20 rounded-2xl bg-secondary flex items-center justify-center mx-auto mb-8">
                <Building className="w-10 h-10 text-muted-foreground" />
              </div>
              <h2 className="text-2xl font-display font-bold text-foreground mb-4">
                No Institutions Available
              </h2>
              <p className="text-muted-foreground">
                Please contact your administrator or wait for an invitation.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SelectInstitution;
