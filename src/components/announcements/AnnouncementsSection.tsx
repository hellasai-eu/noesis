import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Megaphone, ChevronDown, ChevronUp, Archive } from "lucide-react";
import { AnnouncementCard, type AnnouncementCardData } from "./AnnouncementCard";

interface AnnouncementsSectionProps {
  courseId: string;
  allOfferingIds: string[];
  userId: string;
}

interface Row {
  id: string;
  course_id: string;
  author_id: string | null;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  announcement_offerings: { offering_id: string }[] | null;
}

function isExpired(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t <= now;
}

export function AnnouncementsSection({
  courseId,
  allOfferingIds,
  userId,
}: AnnouncementsSectionProps) {
  // Starts open, then folds itself on first load if there is nothing unread —
  // see the effect below, which needs `activeUnreadCount` and so cannot run
  // until the query has resolved.
  const [collapsed, setCollapsed] = useState(false);
  const appliedInitialFold = useRef(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const queryClient = useQueryClient();

  const offeringKey = useMemo(() => [...allOfferingIds].sort().join(","), [allOfferingIds]);

  const queryKey = useMemo(
    () => ["student-class-announcements", courseId, offeringKey, userId] as const,
    [courseId, offeringKey, userId],
  );

  const { data, isLoading } = useQuery({
    queryKey,
    enabled: Boolean(courseId && userId),
    refetchInterval: 60_000,
    queryFn: async (): Promise<{ items: AnnouncementCardData[]; unreadIds: Set<string> }> => {
      const { data: rows, error } = await supabase
        .from("class_announcements")
        .select(
          "id, course_id, author_id, title, body, created_at, updated_at, expires_at, announcement_offerings(offering_id)",
        )
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });
      if (error) throw error;

      const enrolled = new Set(allOfferingIds);
      const announcements = ((rows ?? []) as Row[]).filter((r) => {
        const targets = r.announcement_offerings ?? [];
        if (targets.length === 0) return false;
        return targets.some((t) => enrolled.has(t.offering_id));
      });
      if (announcements.length === 0) {
        return { items: [], unreadIds: new Set() };
      }

      const ids = announcements.map((r) => r.id);
      const { data: reads } = await supabase
        .from("announcement_reads")
        .select("announcement_id")
        .eq("user_id", userId)
        .in("announcement_id", ids);
      const readSet = new Set((reads ?? []).map((r) => r.announcement_id));
      const unreadIds = new Set(ids.filter((id) => !readSet.has(id)));

      const authorIds = Array.from(
        new Set(announcements.map((r) => r.author_id).filter((x): x is string => Boolean(x))),
      );
      const authorMap = new Map<string, string>();
      if (authorIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", authorIds);
        for (const p of profiles ?? []) {
          authorMap.set(p.user_id, p.full_name ?? "");
        }
      }

      const items: AnnouncementCardData[] = announcements.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        created_at: r.created_at,
        updated_at: r.updated_at,
        expires_at: r.expires_at,
        author_name: r.author_id ? authorMap.get(r.author_id) ?? null : null,
      }));
      return { items, unreadIds };
    },
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const unreadIds = useMemo(() => data?.unreadIds ?? new Set<string>(), [data]);

  const { active, archived } = useMemo(() => {
    const now = Date.now();
    const active: AnnouncementCardData[] = [];
    const archived: AnnouncementCardData[] = [];
    for (const a of items) {
      if (isExpired(a.expires_at, now)) archived.push(a);
      else active.push(a);
    }
    return { active, archived };
  }, [items]);

  const activeUnreadCount = useMemo(
    () => active.reduce((n, a) => (unreadIds.has(a.id) ? n + 1 : n), 0),
    [active, unreadIds],
  );

  // Which announcements have a toggle in flight, so the control can be
  // disabled rather than accepting a second click it would race with.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  /**
   * Record or withdraw this student's read receipt for one announcement.
   *
   * This used to happen on its own: an effect marked EVERYTHING the section
   * displayed as read the moment it rendered. Nothing was ever seen unread,
   * because merely loading the page cleared the state — the student did not
   * have to look at the announcement, or even expand the section. "Unread"
   * meant "you have never loaded this course page", which is not a useful
   * thing to tell anyone.
   *
   * It is now the student's decision, in both directions: unchecking deletes
   * the receipt, which `announcement_reads` has had a DELETE policy for since
   * it was created.
   */
  const toggleRead = useCallback(
    async (announcementId: string, read: boolean) => {
      if (!userId) return;
      setPendingIds((prev) => new Set(prev).add(announcementId));
      try {
        const { error } = read
          ? await supabase
              .from("announcement_reads")
              .upsert(
                [{ announcement_id: announcementId, user_id: userId }],
                { onConflict: "announcement_id,user_id", ignoreDuplicates: true },
              )
          : await supabase
              .from("announcement_reads")
              .delete()
              .eq("announcement_id", announcementId)
              .eq("user_id", userId);

        if (error) {
          // The checkbox reflects server state, so a failed write must not
          // leave it looking done. Say so and leave the row as it was.
          toast.error("Could not update this announcement. Please try again.");
          return;
        }
        await queryClient.invalidateQueries({ queryKey });
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(announcementId);
          return next;
        });
      }
    },
    [userId, queryClient, queryKey],
  );

  /**
   * Fold the section on arrival when the student has read everything.
   *
   * Applied ONCE, on the first load that produces data. Two things make that
   * deliberate rather than incidental:
   *
   *  - The query refetches every 60s. Re-deriving on every result would spring
   *    the section shut under a student who had just opened it.
   *  - Marking the last announcement read is itself a refetch. Folding on that
   *    would make the section vanish from under the click that caused it.
   *
   * So a later arrival does not re-fold, and does not force the section open
   * either — the unread badge in the header is visible while collapsed, which
   * is what tells the student there is something new to open it for.
   */
  useEffect(() => {
    // Not merely "data arrived" — data with something in it.
    //
    // `allOfferingIds` is populated asynchronously by the page, and `course`
    // lands first, so the first query runs with an empty scope. Every
    // announcement is then filtered out as untargeted and the result is a
    // perfectly truthy `{ items: [], unreadIds: ∅ }`. Latching on that folded
    // the section before the real scope had been asked about, and because the
    // latch is one-shot the unread announcements that arrived a moment later
    // could not open it again.
    //
    // Gating on `items.length` also matches what the component does with an
    // empty result three lines down: render nothing. There is no section to
    // fold until there is a section.
    if (appliedInitialFold.current || !data || data.items.length === 0) return;
    appliedInitialFold.current = true;
    setCollapsed(activeUnreadCount === 0);
  }, [data, activeUnreadCount]);

  if (isLoading || items.length === 0) {
    return null;
  }

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle
            className="flex items-center gap-2 text-base"
            data-testid="announcements-heading"
          >
            <Megaphone className="h-5 w-5 text-primary" />
            Announcements
            {/* Only while something is genuinely unread.

                There used to be a second, unconditional badge carrying
                `active.length`. It read as a notification count — a permanent
                "1" beside the heading — but it counted announcements, not
                unread ones, so it never cleared no matter what the student
                did. Two badges side by side made that worse: the one that
                could clear sat next to one that could not. */}
            {activeUnreadCount > 0 && (
              <Badge variant="default" className="ml-1">
                {activeUnreadCount} new
              </Badge>
            )}
          </CardTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand announcements" : "Collapse announcements"}
          >
            {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent className="pt-0 space-y-3">
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active announcements.
            </p>
          ) : (
            active.map((a) => (
              <AnnouncementCard
                key={a.id}
                announcement={a}
                unread={unreadIds.has(a.id)}
                onToggleRead={(read) => toggleRead(a.id, read)}
                readTogglePending={pendingIds.has(a.id)}
              />
            ))
          )}
          {archived.length > 0 && (
            <div className="pt-2 border-t">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-between text-muted-foreground"
                onClick={() => setArchiveOpen((v) => !v)}
                aria-expanded={archiveOpen}
                aria-controls="announcement-archive"
              >
                <span className="flex items-center gap-2">
                  <Archive className="h-4 w-4" />
                  Archived
                  <Badge variant="secondary" className="ml-1">
                    {archived.length}
                  </Badge>
                </span>
                {archiveOpen ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </Button>
              {archiveOpen && (
                <div id="announcement-archive" className="mt-3 space-y-3">
                  {archived.map((a) => (
                    // Expired announcements get the control too. They do not
                    // count toward the heading badge, but they still render
                    // with the unread dot and "New" — without a toggle that
                    // would be a marker the student could never clear.
                    <AnnouncementCard
                      key={a.id}
                      announcement={a}
                      unread={unreadIds.has(a.id)}
                      onToggleRead={(read) => toggleRead(a.id, read)}
                      readTogglePending={pendingIds.has(a.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
