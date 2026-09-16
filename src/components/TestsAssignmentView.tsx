import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAuthorNames } from "@/lib/author-names";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PenLine, Loader2, User, Printer, FileDown } from "lucide-react";
import { toast } from "sonner";
import { useFormatters } from "@/i18n/formatters";

interface Test {
  id: string;
  title: string;
  description: string | null;
  is_published: boolean;
  created_at: string;
  created_by: string | null;
  author_name?: string | null;
  question_count?: number;
}

interface TestsAssignmentViewProps {
  courseId: string;
}

export function TestsAssignmentView({ courseId }: TestsAssignmentViewProps) {
  const { formatDate } = useFormatters();
  const [tests, setTests] = useState<Test[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTests();
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

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <PenLine className="w-5 h-5" />
            Tests
            {tests.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                ({tests.length} total)
              </span>
            )}
          </CardTitle>
        </div>
        <CardDescription className="flex items-center gap-2">
          <Printer className="w-4 h-4" />
          Tests are designed for offline distribution. Export as PDF and print for in-class use.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {tests.length === 0 ? (
          <div className="py-12 text-center">
            <PenLine className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground mb-2">No tests created yet</p>
            <p className="text-sm text-muted-foreground">
              Create tests in the Content tab to export and print for offline use
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {tests.map((test) => (
              <div
                key={test.id}
                className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h4 className="font-medium">{test.title}</h4>
                    <Badge variant={test.is_published ? "default" : "secondary"}>
                      {test.is_published ? "Available" : "Hidden"}
                    </Badge>
                    <Badge variant="outline" className="text-muted-foreground">
                      <Printer className="w-3 h-3 mr-1" />
                      Offline Only
                    </Badge>
                  </div>
                  {test.description && (
                    <p className="text-sm text-muted-foreground line-clamp-1">
                      {test.description}
                    </p>
                  )}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1 flex-wrap">
                    {test.author_name && (
                      <span className="flex items-center gap-1">
                        <User className="w-3 h-3" />
                        {test.author_name}
                      </span>
                    )}
                    <span>• {test.question_count || 0} questions</span>
                    <span>• Created {formatDate(test.created_at)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <div className="text-xs text-muted-foreground bg-muted px-3 py-1.5 rounded-md flex items-center gap-1">
                    <FileDown className="w-3 h-3" />
                    Export from Content tab
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
