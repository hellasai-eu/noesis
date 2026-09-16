import { useEffect, useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { InstructorHomeButton } from "@/components/InstructorHomeButton";
import { ArrowLeft, Layers } from "lucide-react";
import { JobProgressList } from "@/components/JobProgressList";
import { JobsCronHealthBanner } from "@/components/JobsCronHealthBanner";

// Dedicated jobs page (issue #723).
//
// Lists every background job the caller can see, RLS-scoped. Optional
// `?courseId` narrows the list to a single course — the inline indicator
// on `CoursePage` links here pre-filtered, so the user can click straight
// from "1 job running" to the full history.

const JobsPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const courseId = searchParams.get("courseId") ?? undefined;
  const [courseTitle, setCourseTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!courseId) {
      setCourseTitle(null);
      return;
    }
    let cancelled = false;
    supabase
      .from("courses")
      .select("title")
      .eq("id", courseId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setCourseTitle((data as { title?: string } | null)?.title ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  if (authLoading || !user) return null;

  const heading = courseId
    ? courseTitle
      ? `Background jobs · ${courseTitle}`
      : "Background jobs · course"
    : "Background jobs";

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-6 max-w-4xl">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(-1)}
              className="gap-1"
              data-testid="jobs-page-back"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </Button>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Layers className="w-5 h-5 text-muted-foreground" />
              {heading}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <InstructorHomeButton />
            {courseId && (
              <Button asChild variant="outline" size="sm" data-testid="jobs-page-all">
                <Link to="/jobs">View all jobs</Link>
              </Button>
            )}
          </div>
        </div>

        <JobsCronHealthBanner />

        <JobProgressList
          courseId={courseId}
          heading={courseId ? "Jobs for this course" : "All your jobs"}
          limit={50}
        />

        <p className="text-xs text-muted-foreground mt-4">
          You see jobs you created plus jobs for courses or institutions you
          manage. Cancelling a running job stops further work; items that have
          already finished are kept.
        </p>
      </div>
    </div>
  );
};

export default JobsPage;
