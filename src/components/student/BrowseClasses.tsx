import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, School, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { buildClassDisplayName } from "@/lib/greek-school";

interface BrowseableClass {
  id: string;
  name: string;
  grade_level_id: string | null;
  section_name: string | null;
  academic_period: string | null;
  enrolled_count: number;
}

interface BrowseClassesProps {
  userId: string;
  institutionId: string;
  enrolledClassIds: string[];
  onEnrollmentChange: () => void;
}

export const BrowseClasses = ({ 
  userId, 
  institutionId, 
  enrolledClassIds,
  onEnrollmentChange 
}: BrowseClassesProps) => {
  const { t } = useTranslation("student");
  const [availableClasses, setAvailableClasses] = useState<BrowseableClass[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrollingClassId, setEnrollingClassId] = useState<string | null>(null);
  const [institutionAllowsSelfEnrollment, setInstitutionAllowsSelfEnrollment] = useState(false);

  useEffect(() => {
    fetchAvailableClasses();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on institutionId/enrolledClassIds change
  }, [institutionId, enrolledClassIds]);

  const fetchAvailableClasses = async () => {
    if (!institutionId) return;
    
    setLoading(true);
    try {
      // First check if institution allows self-enrollment
      const { data: instData } = await supabase
        .from("institutions")
        .select("allow_self_enrollment")
        .eq("id", institutionId)
        .single();
      
      if (!instData?.allow_self_enrollment) {
        setInstitutionAllowsSelfEnrollment(false);
        setAvailableClasses([]);
        setLoading(false);
        return;
      }
      
      setInstitutionAllowsSelfEnrollment(true);
      
      // Fetch active classes that allow self-enrollment
      const { data: classesData, error } = await supabase
        .from("classes")
        .select(`
          id,
          name,
          grade_level_id,
          section_name,
          academic_period
        `)
        .eq("institution_id", institutionId)
        .eq("is_active", true)
        .eq("allow_self_enrollment", true);
      
      if (error) throw error;
      
      // Filter out classes the user is already enrolled in
      const availableClassIds = (classesData || [])
        .filter(c => !enrolledClassIds.includes(c.id))
        .map(c => c.id);
      
      if (availableClassIds.length === 0) {
        setAvailableClasses([]);
        setLoading(false);
        return;
      }
      
      // Get enrollment counts for these classes
      const { data: enrollmentCounts } = await supabase
        .from("class_enrollments")
        .select("class_id")
        .in("class_id", availableClassIds);
      
      const countMap: Record<string, number> = {};
      (enrollmentCounts || []).forEach(e => {
        countMap[e.class_id] = (countMap[e.class_id] || 0) + 1;
      });
      
      const classesWithCounts: BrowseableClass[] = (classesData || [])
        .filter(c => !enrolledClassIds.includes(c.id))
        .map(c => ({
          ...c,
          enrolled_count: countMap[c.id] || 0
        }));
      
      setAvailableClasses(classesWithCounts);
    } catch (error) {
      console.error("Error fetching available classes:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelfEnroll = async (classId: string) => {
    setEnrollingClassId(classId);
    try {
      const { error } = await supabase
        .from("class_enrollments")
        .insert({
          class_id: classId,
          user_id: userId,
          role: "student"
        });
      
      if (error) throw error;
      
      toast.success(t("browseClasses.joinSuccess"));
      onEnrollmentChange();
      
      // Remove from available list
      setAvailableClasses(prev => prev.filter(c => c.id !== classId));
    } catch (error: any) {
      console.error("Enrollment error:", error);
      toast.error(error.message || t("browseClasses.joinFailed"));
    } finally {
      setEnrollingClassId(null);
    }
  };

  // Don't render anything if institution doesn't allow self-enrollment
  if (!institutionAllowsSelfEnrollment && !loading) {
    return null;
  }

  if (loading) {
    return (
      <Card className="mb-6">
        <CardContent className="py-6 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (availableClasses.length === 0) {
    return null; // Don't show the section if there are no classes to browse
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <School className="w-5 h-5" />
          {t("browseClasses.title")}
        </CardTitle>
        <CardDescription>
          {t("browseClasses.description")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {availableClasses.map((cls) => (
            <div
              key={cls.id}
              className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground truncate">{buildClassDisplayName(cls)}</p>
                <div className="flex items-center gap-2 mt-1">
                  {cls.academic_period && (
                    <Badge variant="outline" className="text-xs">
                      {cls.academic_period}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Users className="w-3 h-3" />
                    {t("browseClasses.enrolled", { count: cls.enrolled_count })}
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                onClick={() => handleSelfEnroll(cls.id)}
                disabled={enrollingClassId === cls.id}
                className="ml-3 shrink-0"
              >
                {enrollingClassId === cls.id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <UserPlus className="w-4 h-4 mr-1" />
                    {t("browseClasses.join")}
                  </>
                )}
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
