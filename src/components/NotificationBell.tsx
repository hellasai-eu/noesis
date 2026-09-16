import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Bell,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Check,
  RefreshCw,
  Layers,
} from "lucide-react";
import { toast } from "sonner";

// Unified in-app notification bell (issues #699, #740).
//
// Merges two feeds into a single bell so the header never shows two bells side
// by side:
//   - `notifications` — per-user, RLS-scoped (job completion, etc.). Always on.
//   - `admin_notifications` — content-moderation flags for instructors/admins.
//     Opt-in via `includeAdminFeed`.
//
// Each feed has its own realtime channel and its own mark-as-read write path
// against the correct source table. Items are normalized into one list shape
// (`UnifiedNotification`) so the popover renders both uniformly.

type NotificationSource = "user" | "admin";

interface UnifiedNotification {
  id: string;
  source: NotificationSource;
  type: string;
  title: string;
  body: string | null;
  job_id: string | null;
  read: boolean;
  created_at: string;
}

interface UserNotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  job_id: string | null;
  read_at: string | null;
  created_at: string;
}

interface AdminNotificationRow {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  created_at: string;
}

const FETCH_LIMIT = 20;

function fromUserRow(row: UserNotificationRow): UnifiedNotification {
  return {
    id: row.id,
    source: "user",
    type: row.type,
    title: row.title,
    body: row.body,
    job_id: row.job_id,
    read: !!row.read_at,
    created_at: row.created_at,
  };
}

function fromAdminRow(row: AdminNotificationRow): UnifiedNotification {
  return {
    id: row.id,
    source: "admin",
    type: row.type,
    title: row.title,
    body: row.message,
    job_id: null,
    read: row.read,
    created_at: row.created_at,
  };
}

function compositeKey(n: UnifiedNotification) {
  return `${n.source}:${n.id}`;
}

function sortByCreatedDesc(list: UnifiedNotification[]) {
  return [...list].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

function iconFor(n: UnifiedNotification) {
  if (n.source === "admin") {
    return <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />;
  }
  if (n.type === "job.completed") {
    return <CheckCircle className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />;
  }
  if (n.type === "job.partially_completed") {
    return <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />;
  }
  if (n.type === "job.failed") {
    return <XCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />;
  }
  return <Bell className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />;
}

function raiseToast(n: UnifiedNotification) {
  const description = n.body ?? undefined;
  if (n.source === "admin") {
    toast.warning(n.title, { description });
    return;
  }
  if (n.type === "job.completed") {
    toast.success(n.title, { description });
  } else if (n.type === "job.partially_completed") {
    toast.warning(n.title, { description });
  } else if (n.type === "job.failed") {
    toast.error(n.title, { description });
  } else {
    toast(n.title, { description });
  }
}

function formatTime(dateStr: string) {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

interface NotificationBellProps {
  includeAdminFeed?: boolean;
}

export function NotificationBell({ includeAdminFeed = false }: NotificationBellProps = {}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<UnifiedNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [realtimeOk, setRealtimeOk] = useState(true);
  // Avoid double-toasting the same row when the realtime payload races the
  // optimistic refresh that follows a server-side insert.
  const seenKeysRef = useRef<Set<string>>(new Set());
  // Per-channel health: only show Refresh when at least one active channel is failing.
  const channelHealthRef = useRef<Map<string, boolean>>(new Map());

  const userId = user?.id ?? null;

  const fetchUserNotifications = async (uid: string): Promise<UnifiedNotification[]> => {
    const { data, error } = await supabase
      .from("notifications")
      .select("id, type, title, body, job_id, read_at, created_at")
      .eq("user_id", uid)
      .order("created_at", { ascending: false })
      .limit(FETCH_LIMIT);
    if (error) {
      console.error("Failed to fetch notifications:", error);
      return [];
    }
    return (data ?? []).map((r) => fromUserRow(r as UserNotificationRow));
  };

  const fetchAdminNotifications = async (): Promise<UnifiedNotification[]> => {
    const { data, error } = await supabase
      .from("admin_notifications")
      .select("id, type, title, message, read, created_at")
      .order("created_at", { ascending: false })
      .limit(FETCH_LIMIT);
    if (error) {
      console.error("Failed to fetch admin notifications:", error);
      return [];
    }
    return (data ?? []).map((r) => fromAdminRow(r as AdminNotificationRow));
  };

  const refreshAll = useCallback(
    async (uid: string) => {
      const tasks: Promise<UnifiedNotification[]>[] = [fetchUserNotifications(uid)];
      if (includeAdminFeed) tasks.push(fetchAdminNotifications());
      const results = await Promise.all(tasks);
      const merged = sortByCreatedDesc(results.flat());
      merged.forEach((n) => seenKeysRef.current.add(compositeKey(n)));
      setNotifications(merged);
    },
    [includeAdminFeed],
  );

  useEffect(() => {
    if (!userId) {
      setNotifications([]);
      seenKeysRef.current = new Set();
      return;
    }

    let isMounted = true;
    const channels: Array<ReturnType<typeof supabase.channel>> = [];
    channelHealthRef.current = new Map();

    refreshAll(userId);

    const userChannel = supabase
      .channel(`user-notifications-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (!isMounted) return;
          const incoming = fromUserRow(payload.new as UserNotificationRow);
          const key = compositeKey(incoming);
          if (seenKeysRef.current.has(key)) return;
          seenKeysRef.current.add(key);
          setNotifications((prev) => sortByCreatedDesc([incoming, ...prev]).slice(0, FETCH_LIMIT * 2));
          raiseToast(incoming);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (!isMounted) return;
          const updated = fromUserRow(payload.new as UserNotificationRow);
          setNotifications((prev) =>
            prev.map((n) => (n.source === "user" && n.id === updated.id ? { ...n, read: updated.read } : n)),
          );
        },
      )
      .subscribe((status) => {
        if (!isMounted) return;
        if (status === "SUBSCRIBED") {
          channelHealthRef.current.set("user", true);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          // Surface the manual-refresh button so the bell stays useful when
          // realtime is unavailable.
          channelHealthRef.current.set("user", false);
        } else {
          return;
        }
        setRealtimeOk([...channelHealthRef.current.values()].every(Boolean));
      });
    channels.push(userChannel);

    if (includeAdminFeed) {
      const adminChannel = supabase
        .channel(`admin-notifications-${userId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "admin_notifications" },
          (payload) => {
            if (!isMounted) return;
            const incoming = fromAdminRow(payload.new as AdminNotificationRow);
            const key = compositeKey(incoming);
            if (seenKeysRef.current.has(key)) return;
            seenKeysRef.current.add(key);
            setNotifications((prev) => sortByCreatedDesc([incoming, ...prev]).slice(0, FETCH_LIMIT * 2));
            raiseToast(incoming);
          },
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "admin_notifications" },
          (payload) => {
            if (!isMounted) return;
            const updated = fromAdminRow(payload.new as AdminNotificationRow);
            setNotifications((prev) =>
              prev.map((n) => (n.source === "admin" && n.id === updated.id ? { ...n, read: updated.read } : n)),
            );
          },
        )
        .subscribe((status) => {
          if (!isMounted) return;
          if (status === "SUBSCRIBED") {
            channelHealthRef.current.set("admin", true);
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            channelHealthRef.current.set("admin", false);
          } else {
            return;
          }
          setRealtimeOk([...channelHealthRef.current.values()].every(Boolean));
        });
      channels.push(adminChannel);
    }

    return () => {
      isMounted = false;
      channels.forEach((c) => supabase.removeChannel(c));
    };
  }, [userId, includeAdminFeed, refreshAll]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const markAsRead = async (n: UnifiedNotification) => {
    if (n.read) return;
    if (n.source === "user") {
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", n.id)
        .eq("user_id", userId!);
      if (error) {
        console.error("Failed to mark notification as read:", error);
        return;
      }
    } else {
      const { error } = await supabase
        .from("admin_notifications")
        .update({ read: true })
        .eq("id", n.id);
      if (error) {
        console.error("Failed to mark admin notification as read:", error);
        return;
      }
    }
    setNotifications((prev) =>
      prev.map((item) =>
        item.source === n.source && item.id === n.id ? { ...item, read: true } : item,
      ),
    );
  };

  const markAllAsRead = async () => {
    if (!userId) return;
    const unread = notifications.filter((n) => !n.read);
    if (unread.length === 0) return;
    const unreadUserIds = unread.filter((n) => n.source === "user").map((n) => n.id);
    const unreadAdminIds = unread.filter((n) => n.source === "admin").map((n) => n.id);

    // `PromiseLike`, not `Promise`: a supabase query builder is a thenable, and
    // `.then()` on it returns another thenable rather than a real Promise. That
    // is all `Promise.allSettled` below needs.
    const writes: { source: "user" | "admin"; promise: PromiseLike<void> }[] = [];
    if (unreadUserIds.length > 0) {
      writes.push({
        source: "user",
        promise: supabase
          .from("notifications")
          .update({ read_at: new Date().toISOString() })
          .in("id", unreadUserIds)
          .eq("user_id", userId)
          .then(({ error }) => {
            if (error) {
              console.error("Failed to mark notifications as read:", error);
              throw error;
            }
          }),
      });
    }
    if (unreadAdminIds.length > 0) {
      writes.push({
        source: "admin",
        promise: supabase
          .from("admin_notifications")
          .update({ read: true })
          .in("id", unreadAdminIds)
          .then(({ error }) => {
            if (error) {
              console.error("Failed to mark admin notifications as read:", error);
              throw error;
            }
          }),
      });
    }
    const results = await Promise.allSettled(writes.map((w) => w.promise));
    const succeededSources = new Set(
      writes.filter((_, i) => results[i].status === "fulfilled").map((w) => w.source),
    );
    if (succeededSources.size > 0) {
      setNotifications((prev) =>
        prev.map((n) => (n.read || !succeededSources.has(n.source) ? n : { ...n, read: true })),
      );
    }
  };

  const handleClick = async (n: UnifiedNotification) => {
    if (!n.read) {
      await markAsRead(n);
    }
    // If the notification is linked to a job with a course, navigate to the
    // course page — the user's mental model for "go look at the result".
    if (n.source === "user" && n.job_id) {
      const { data, error } = await supabase
        .from("jobs")
        .select("course_id, type")
        .eq("id", n.job_id)
        .maybeSingle();
      if (!error && data?.course_id) {
        setOpen(false);
        navigate(`/course/${data.course_id}`);
      }
    }
  };

  // Only render the bell for signed-in users. The Dashboard, Student, etc.
  // pages mount this above their gating logic, but be defensive anyway.
  if (!userId) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative"
          data-testid="user-notification-bell"
          aria-label="Notifications"
        >
          <Bell className="w-4 h-4" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-5 min-w-5 px-1 text-[10px] flex items-center justify-center"
              data-testid="user-notification-badge"
            >
              {unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h4 className="text-sm font-semibold">Notifications</h4>
          <div className="flex items-center gap-1">
            {!realtimeOk && (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto py-1 px-2 text-xs"
                onClick={() => refreshAll(userId)}
                data-testid="user-notification-refresh"
                title="Realtime is unavailable — refresh manually"
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                Refresh
              </Button>
            )}
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto py-1 px-2 text-xs"
                onClick={markAllAsRead}
              >
                <Check className="w-3 h-3 mr-1" />
                Mark all read
              </Button>
            )}
          </div>
        </div>
        <ScrollArea className="max-h-80">
          {notifications.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No notifications</p>
          ) : (
            <div className="divide-y">
              {notifications.map((n) => (
                <button
                  key={compositeKey(n)}
                  className={`w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors ${
                    !n.read ? "bg-primary/5" : ""
                  }`}
                  onClick={() => handleClick(n)}
                  data-testid="user-notification-item"
                >
                  <div className="flex items-start gap-2">
                    {iconFor(n)}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{n.title}</span>
                        {!n.read && (
                          <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
                        )}
                      </div>
                      {n.body && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {n.body}
                        </p>
                      )}
                      <span className="text-xs text-muted-foreground mt-1 block">
                        {formatTime(n.created_at)}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
        <div className="border-t px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-xs"
            onClick={() => {
              setOpen(false);
              navigate("/jobs");
            }}
            data-testid="user-notification-jobs-link"
          >
            <Layers className="w-3 h-3 mr-2" />
            View all jobs
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
