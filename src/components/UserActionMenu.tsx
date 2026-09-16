import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  Bug,
  CheckCircle,
  ChevronDown,
  Key,
  LogOut,
  Mail,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { MfaSettingsDialog } from "@/components/MfaSettingsDialog";

interface UserActionMenuProps {
  /** Sign-out varies per page (post-sign-out navigation differs), so the page supplies it. */
  onSignOut: () => void;
  /** When provided, a "Report a bug" item is shown. */
  onReportBug?: () => void;
  /** e.g. "Super Admin", "Admin", "Instructor" — shown under the name in the menu. */
  roleLabel?: string;
}

/**
 * Header account menu: collapses the per-user actions (report a bug, change
 * password, two-factor auth, contact, sign out) behind a single trigger
 * labeled with the signed-in user's name or email.
 */
export function UserActionMenu({ onSignOut, onReportBug, roleLabel }: UserActionMenuProps) {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [mfaOpen, setMfaOpen] = useState(false);

  const email = profile?.email || user?.email;
  const displayName = profile?.full_name?.trim() || email || "Account";
  const emailVerified = !!user?.email_confirmed_at;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 px-2 sm:gap-2 sm:px-3"
            data-testid="user-menu-trigger"
            aria-label="Account menu"
          >
            <UserRound className="h-4 w-4 shrink-0" />
            <span className="hidden max-w-[160px] truncate sm:inline">{displayName}</span>
            <ChevronDown className="h-3 w-3 sm:h-4 sm:w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>
            <div className="flex flex-col gap-0.5">
              <span className="truncate">{displayName}</span>
              {email && (
                <span
                  className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground"
                  title={emailVerified ? "Email verified" : "Email not verified"}
                >
                  <span className="truncate">{email}</span>
                  {emailVerified ? (
                    <CheckCircle
                      className="h-3.5 w-3.5 shrink-0 text-emerald-500"
                      aria-label="Email verified"
                    />
                  ) : (
                    <AlertCircle
                      className="h-3.5 w-3.5 shrink-0 text-amber-500"
                      aria-label="Email not verified"
                    />
                  )}
                </span>
              )}
              {roleLabel && (
                <span className="text-xs font-normal text-muted-foreground">{roleLabel}</span>
              )}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {onReportBug && (
            <DropdownMenuItem onClick={onReportBug}>
              <Bug className="mr-2 h-4 w-4" />
              Report a bug
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setPasswordOpen(true)}>
            <Key className="mr-2 h-4 w-4" />
            Change Password
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setMfaOpen(true)}>
            <ShieldCheck className="mr-2 h-4 w-4" />
            Two-Factor Auth
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate("/contact")}>
            <Mail className="mr-2 h-4 w-4" />
            Contact Us
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onSignOut} className="text-destructive">
            <LogOut className="mr-2 h-4 w-4" />
            Sign Out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Rendered outside the menu so they survive the menu closing. */}
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
      <MfaSettingsDialog open={mfaOpen} onOpenChange={setMfaOpen} />
    </>
  );
}
