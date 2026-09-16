import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";

// Small inline indicator that replaces the big "Background jobs" card on the
// course page (issue #723). Shows a one-line "N jobs running · View" pill
// that links to the dedicated jobs page filtered to this course. Renders
// nothing when there are no active jobs.
//
// Realtime: subscribes to INSERTs and UPDATEs on `jobs` filtered to this
// course and refetches on any event — counts are cheap (rows are few) and
// the realtime cost dominates anyway. Falls back to the initial fetch only
// when the subscription never reaches SUBSCRIBED.

interface CourseJobsIndicatorProps {
  courseId: string;
}

const ACTIVE_STATUSES = ["pending", "processing"];

export function CourseJobsIndicator({ courseId }: CourseJobsIndicatorProps) {
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    let isMounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const fetchCount = async () => {
      const { count: c, error } = await supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("course_id", courseId)
        .in("status", ACTIVE_STATUSES);
      if (error) {
        console.error("CourseJobsIndicator: count failed", error);
        return;
      }
      if (isMounted) setCount(c ?? 0);
    };

    fetchCount();

    channel = supabase
      .channel(`course-jobs-indicator-${courseId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "jobs",
          filter: `course_id=eq.${courseId}`,
        },
        () => {
          fetchCount();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "jobs",
          filter: `course_id=eq.${courseId}`,
        },
        () => {
          fetchCount();
        },
      )
      .subscribe();

    return () => {
      isMounted = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [courseId]);

  if (count === 0) return null;

  return (
    <Link
      to={`/jobs?courseId=${courseId}`}
      className="inline-flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
      data-testid="course-jobs-indicator"
    >
      <Loader2 className="w-3 h-3 animate-spin text-blue-600" />
      <span>
        {count} background job{count === 1 ? "" : "s"} running
      </span>
      <span className="text-foreground/70 font-medium">· View</span>
    </Link>
  );
}
