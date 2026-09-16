import { ThumbsUp, ThumbsDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Shared, type-agnostic presentational cells for the question bank tables.
 * Used by all five question-type tables so that vote counts and author
 * always render identically and future question types inherit the same
 * display for free (#617).
 */

interface VoteBadgesProps {
  upvotes: number;
  downvotes: number;
  className?: string;
}

/**
 * Always renders both badges, including the 0/0 case — the issue
 * explicitly calls out that votes must be visible even when there are
 * none, otherwise instructors can't tell "no votes yet" apart from
 * "vote display missing for this type".
 */
export const VoteBadges = ({ upvotes, downvotes, className }: VoteBadgesProps) => (
  <div className={cn("flex items-center gap-1.5", className)} data-testid="vote-badges">
    <Badge
      variant="outline"
      className="text-xs bg-green-500/10 text-green-600 border-green-500/20"
    >
      <ThumbsUp className="h-3 w-3 mr-1" /> {upvotes}
    </Badge>
    <Badge
      variant="outline"
      className="text-xs bg-red-500/10 text-red-600 border-red-500/20"
    >
      <ThumbsDown className="h-3 w-3 mr-1" /> {downvotes}
    </Badge>
  </div>
);

interface AuthorCellProps {
  createdBy?: string | null;
  authorName?: string | null;
  className?: string;
}

/**
 * Author label resolution mirrors the existing MCQ/Open expanded-row
 * convention: a null `createdBy` means the row was AI-generated; a set
 * `createdBy` with a missing `authorName` is a profile we couldn't
 * resolve (deleted user, RLS-blocked, etc.) and falls back to "Unknown".
 */
export const AuthorCell = ({ createdBy, authorName, className }: AuthorCellProps) => {
  const label = !createdBy ? "AI Generated" : authorName || "Unknown";
  return (
    <span
      className={cn("text-xs text-muted-foreground", className)}
      data-testid="author-cell"
    >
      {label}
    </span>
  );
};
