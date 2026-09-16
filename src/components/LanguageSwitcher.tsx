/**
 * LanguageSwitcher — the one place a user records an explicit UI-language
 * choice. Dropping it into a nav bar is all a surface needs to do.
 *
 * Picking a language here outranks `institutions.default_language` from that
 * point on (see `LocaleProvider`), which is the point: an institution default
 * is a sensible starting guess, not a lock.
 */
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocale } from "@/i18n/locale-context";
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  isSupportedLocale,
} from "@/i18n/config";

export function LanguageSwitcher() {
  const { t } = useTranslation("common");
  const { locale, setLocale } = useLocale();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 px-2 h-8 sm:h-9"
          aria-label={t("language.change")}
          data-testid="language-switcher"
        >
          <Languages className="w-4 h-4" />
          <span className="hidden sm:inline text-xs uppercase tabular-nums">
            {locale}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{t("language.label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* A radio group, not plain menu items: picking a language is a
            single-selection choice, so Radix gives each row `menuitemradio`
            with a real `aria-checked`. `aria-checked` on a bare `menuitem` is
            not valid ARIA and screen readers ignore it. */}
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(next) => {
            // Radix types this as a bare string; the guard keeps a stale or
            // unexpected value from reaching i18next.
            if (isSupportedLocale(next)) setLocale(next);
          }}
        >
          {SUPPORTED_LOCALES.map((code) => (
            <DropdownMenuRadioItem
              key={code}
              value={code}
              data-testid={`language-option-${code}`}
            >
              {LOCALE_LABELS[code]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
