import { ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Building2,
  ChevronDown,
  GraduationCap,
  Key,
  LogOut,
  Mail,
  ShieldCheck,
  Users,
} from "lucide-react";
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
import { NotificationBell } from "@/components/NotificationBell";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { SiteFooter } from "@/components/SiteFooter";

/**
 * The chrome around the student surface: the bar every student page has had,
 * lifted out of `StudentDashboard` so the course route can render the same
 * surface without a second copy of it.
 *
 * Nothing here is new. The institution switcher, the language switcher, the
 * notification bell and the account menu keep the behaviour and the catalog
 * keys they had on the dashboard — this is a move, not a redesign, and the
 * tests that assert them still assert them.
 */
export interface ShellInstitution {
  id: string;
  name: string;
}

interface SurfaceShellProps {
  institutions: ShellInstitution[];
  currentInstitution: ShellInstitution | null;
  onSwitchInstitution: (institution: ShellInstitution) => void;
  profileName: string | null;
  gradeLevelLabel: string | null;
  isViewingAsStudent: boolean;
  isAdmin: boolean;
  onSignOut: () => void;
  children: ReactNode;
}

export function SurfaceShell({
  institutions,
  currentInstitution,
  onSwitchInstitution,
  profileName,
  gradeLevelLabel,
  isViewingAsStudent,
  isAdmin,
  onSignOut,
  children,
}: SurfaceShellProps) {
  const { t } = useTranslation(["student", "common"]);
  const navigate = useNavigate();
  const displayName = profileName || t("nav.roleFallback");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [mfaOpen, setMfaOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <nav className="sticky top-0 z-50 border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="container mx-auto flex items-center justify-between gap-2 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary sm:h-10 sm:w-10">
              <GraduationCap className="h-5 w-5 text-primary-foreground sm:h-6 sm:w-6" />
            </div>
            <span className="hidden font-display text-lg font-bold text-foreground xs:inline sm:text-xl">
              Noesis
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-4">
            {isViewingAsStudent && isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="hidden sm:flex"
                onClick={() => navigate("/dashboard")}
              >
                {t("nav.backToAdmin")}
              </Button>
            )}

            {institutions.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex h-8 items-center gap-1 px-2 sm:h-9 sm:gap-2 sm:px-3"
                  >
                    <Building2 className="h-4 w-4 flex-shrink-0" />
                    <span className="hidden max-w-[100px] truncate sm:inline md:max-w-[150px]">
                      {currentInstitution?.name || t("common:institution.fallbackName")}
                    </span>
                    <ChevronDown className="h-3 w-3 sm:h-4 sm:w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>{t("common:institution.yours")}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {institutions.map((inst) => (
                    <DropdownMenuItem
                      key={inst.id}
                      onClick={() => onSwitchInstitution(inst)}
                      className={inst.id === currentInstitution?.id ? "bg-muted" : ""}
                    >
                      <Building2 className="mr-2 h-4 w-4" />
                      {inst.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate("/select-institution")}>
                    <Users className="mr-2 h-4 w-4" />
                    {t("common:institution.browseAll")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <LanguageSwitcher />
            <NotificationBell />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 sm:h-9 sm:gap-2 sm:px-3">
                  <span className="hidden max-w-[120px] truncate text-muted-foreground md:inline">
                    {displayName}
                    {gradeLevelLabel && ` · ${gradeLevelLabel}`}
                  </span>
                  <ChevronDown className="h-3 w-3 sm:h-4 sm:w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                  <div className="flex flex-col">
                    <span>{displayName}</span>
                    {gradeLevelLabel && (
                      <span className="text-xs font-normal text-muted-foreground">
                        {gradeLevelLabel}
                      </span>
                    )}
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {isViewingAsStudent && isAdmin && (
                  <>
                    <DropdownMenuItem onClick={() => navigate("/dashboard")} className="sm:hidden">
                      {t("nav.backToAdmin")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="sm:hidden" />
                  </>
                )}
                <DropdownMenuItem onClick={() => setPasswordOpen(true)}>
                  <Key className="mr-2 h-4 w-4" />
                  {t("common:actions.changePassword")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setMfaOpen(true)}>
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {t("common:actions.twoFactorAuth")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate("/contact")}>
                  <Mail className="mr-2 h-4 w-4" />
                  {t("common:actions.contactUs")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onSignOut} className="text-destructive">
                  <LogOut className="mr-2 h-4 w-4" />
                  {t("common:actions.signOut")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
            <MfaSettingsDialog open={mfaOpen} onOpenChange={setMfaOpen} />
          </div>
        </div>
      </nav>

      <main className="container mx-auto flex-1 px-4 py-5 sm:px-6 sm:py-7">{children}</main>

      {/* Rendered here rather than left to GlobalFooter, so the legal links sit
          at the bottom of the page instead of below a forced 100vh (#937). */}
      <SiteFooter />
    </div>
  );
}
