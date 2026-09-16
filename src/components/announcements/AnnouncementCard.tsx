import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { formatDistanceToNow } from "date-fns";
import { Clock } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";

export interface AnnouncementCardData {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  author_name?: string | null;
  expires_at?: string | null;
}

interface AnnouncementCardProps {
  announcement: AnnouncementCardData;
  unread?: boolean;
  actions?: React.ReactNode;
  targetLabels?: string[] | null;
  /**
   * Student-facing read control. Passing this renders a checkbox under the
   * body; omitting it renders no control at all, which is what the instructor
   * surfaces do — they have no read state of their own.
   *
   * `read` is the state being moved TO, so unchecking marks the announcement
   * unread again. That is deliberate: a student who ticks the wrong row should
   * be able to put it back, and `announcement_reads` has carried a DELETE
   * policy for exactly this since it was created.
   */
  onToggleRead?: (read: boolean) => void;
  /** Disables the control while a toggle is in flight. */
  readTogglePending?: boolean;
}

export function AnnouncementCard({
  announcement,
  unread,
  actions,
  targetLabels,
  onToggleRead,
  readTogglePending,
}: AnnouncementCardProps) {
  const readCheckboxId = `announcement-read-${announcement.id}`;
  const edited = announcement.updated_at !== announcement.created_at;
  const expiresAtDate = announcement.expires_at ? new Date(announcement.expires_at) : null;
  const isExpired = expiresAtDate ? expiresAtDate.getTime() <= Date.now() : false;
  return (
    <Card className={unread ? "border-primary/50 bg-primary/5" : undefined}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {unread && (
                <span
                  aria-label="Unread"
                  className="inline-block h-2 w-2 rounded-full bg-primary shrink-0"
                />
              )}
              <h3 className="text-base font-semibold text-foreground leading-tight break-words">
                {announcement.title}
              </h3>
              {unread && (
                <Badge variant="default" className="text-xs">New</Badge>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
              {announcement.author_name && (
                <span className="truncate">{announcement.author_name}</span>
              )}
              {announcement.author_name && <span aria-hidden>•</span>}
              <time dateTime={announcement.created_at}>
                {formatDistanceToNow(new Date(announcement.created_at), { addSuffix: true })}
              </time>
              {edited && (
                <>
                  <span aria-hidden>•</span>
                  <span>edited</span>
                </>
              )}
              {expiresAtDate && (
                <>
                  <span aria-hidden>•</span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" aria-hidden />
                    {isExpired ? (
                      <Badge variant="outline" className="text-xs">Expired</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">
                        Expires {formatDistanceToNow(expiresAtDate, { addSuffix: true })}
                      </Badge>
                    )}
                  </span>
                </>
              )}
            </div>
            {targetLabels !== undefined && targetLabels !== null && (
              <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-muted-foreground">Sections:</span>
                {targetLabels.length === 0 ? (
                  <Badge variant="outline" className="text-xs">No sections (hidden)</Badge>
                ) : (
                  targetLabels.map((label) => (
                    <Badge key={label} variant="outline" className="text-xs">
                      {label}
                    </Badge>
                  ))
                )}
              </div>
            )}
          </div>
          {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <MarkdownContent>{announcement.body}</MarkdownContent>
        {onToggleRead && (
          // Under the body, not beside the title: the point of the control is
          // that the student has read the thing, so it sits where they finish.
          <div className="flex items-center gap-2 pt-1 border-t">
            <Checkbox
              id={readCheckboxId}
              checked={!unread}
              disabled={readTogglePending}
              onCheckedChange={(next) => onToggleRead(next === true)}
            />
            <Label
              htmlFor={readCheckboxId}
              className="text-xs font-normal text-muted-foreground cursor-pointer"
            >
              {unread ? "Mark as read" : "Read"}
            </Label>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
