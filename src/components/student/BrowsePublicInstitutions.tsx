import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SafeImage } from "@/components/SafeImage";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  Building,
  Globe,
  Loader2,
  UserPlus,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface PublicInstitution {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
}

interface BrowsePublicInstitutionsProps {
  userId: string;
  memberInstitutionIds: string[];
  onJoinSuccess: () => void;
}

export function BrowsePublicInstitutions({
  userId,
  memberInstitutionIds,
  onJoinSuccess,
}: BrowsePublicInstitutionsProps) {
  const { t } = useTranslation("student");
  const [publicInstitutions, setPublicInstitutions] = useState<PublicInstitution[]>([]);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    fetchPublicInstitutions();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on memberInstitutionIds change
  }, [memberInstitutionIds]);

  const fetchPublicInstitutions = async () => {
    try {
      const { data, error } = await supabase
        .from("institutions")
        .select("id, name, slug, logo_url")
        .eq("is_public", true)
        .order("name");

      if (error) throw error;

      // Filter out institutions the user is already a member of
      const availableInstitutions = (data || []).filter(
        (inst) => !memberInstitutionIds.includes(inst.id)
      );

      setPublicInstitutions(availableInstitutions);
    } catch (error) {
      console.error("Error fetching public institutions:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async (institution: PublicInstitution) => {
    setJoiningId(institution.id);

    try {
      const { error } = await supabase.from("user_institutions").insert({
        user_id: userId,
        institution_id: institution.id,
        role: "student",
      });

      if (error) {
        console.error("Error joining institution:", error);
        toast.error(t("browseInstitutions.joinFailed"));
        return;
      }

      toast.success(t("browseInstitutions.joinSuccess", { name: institution.name }));
      
      // Remove from list
      setPublicInstitutions((prev) =>
        prev.filter((inst) => inst.id !== institution.id)
      );
      
      onJoinSuccess();
    } catch (error) {
      console.error("Error joining institution:", error);
      toast.error(t("browseInstitutions.joinFailed"));
    } finally {
      setJoiningId(null);
    }
  };

  // Don't render if no public institutions available
  if (!loading && publicInstitutions.length === 0) {
    return null;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mb-6">
      <Card className="border-dashed border-primary/30 bg-primary/5">
        <CollapsibleTrigger asChild>
          <CardContent className="py-4 cursor-pointer hover:bg-primary/10 transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
                  <Globe className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">
                    {t("browseInstitutions.title")}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {loading
                      ? t("browseInstitutions.loading")
                      : t("browseInstitutions.available", {
                          count: publicInstitutions.length,
                        })}
                  </p>
                </div>
              </div>
              {isOpen ? (
                <ChevronUp className="w-5 h-5 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-5 h-5 text-muted-foreground" />
              )}
            </div>
          </CardContent>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-6 pb-4 space-y-3">
            {loading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : (
              publicInstitutions.map((institution) => (
                <div
                  key={institution.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-background border"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center overflow-hidden">
                      <SafeImage
                        src={institution.logo_url || undefined}
                        alt={`${institution.name} logo`}
                        wrapperClassName="w-10 h-10"
                        className="w-full h-full object-contain"
                        fallback={<Building className="w-5 h-5 text-primary" />}
                      />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">
                        {institution.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        /i/{institution.slug}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleJoin(institution)}
                    disabled={joiningId === institution.id}
                  >
                    {joiningId === institution.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <UserPlus className="w-4 h-4 mr-1" />
                        {t("browseInstitutions.join")}
                      </>
                    )}
                  </Button>
                </div>
              ))
            )}
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
