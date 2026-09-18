import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { brand, type BrandIcon } from "@/deployment";
import { cn } from "@/lib/utils";

/**
 * The product's mark: the configured logo, and usually the configured name
 * beside it.
 *
 * Every page in this app builds its own nav, so this block used to be copied
 * into fourteen of them — a rounded tile, a `lucide` glyph, and the product
 * name as a string literal. That is why the name was un-rebrandable: it was
 * not a setting, it was fourteen settings. Now there is one component and one
 * source of truth (`src/deployment/`).
 *
 * The props cover what those fourteen call sites actually varied — size, the
 * tile's colour, an alternative glyph, a subtitle, an adjacent badge — and
 * nothing else. A page needing something outside that should compose
 * `<BrandLogo>` and `brand.name` directly rather than grow another prop here.
 */

type BrandMarkSize = "sm" | "md" | "lg" | "responsive";

/**
 * `primary` is the filled tile nearly every nav uses. `gold` is the accent
 * tile for a dark band. `subtle` is the quiet tinted tile for a footer.
 */
type BrandMarkTone = "primary" | "gold" | "subtle";

const TILE_SIZE: Record<BrandMarkSize, string> = {
  sm: "h-8 w-8",
  md: "h-10 w-10",
  lg: "h-10 w-10",
  responsive: "h-8 w-8 sm:h-10 sm:w-10",
};

const GLYPH_SIZE: Record<BrandMarkSize, string> = {
  sm: "h-5 w-5",
  md: "h-6 w-6",
  lg: "h-6 w-6",
  responsive: "h-5 w-5 sm:h-6 sm:w-6",
};

const NAME_SIZE: Record<BrandMarkSize, string> = {
  sm: "text-lg",
  md: "text-xl",
  lg: "text-2xl",
  responsive: "text-lg sm:text-xl",
};

const TILE_TONE: Record<BrandMarkTone, string> = {
  primary: "bg-primary",
  gold: "bg-gold",
  subtle: "bg-primary/10",
};

const GLYPH_TONE: Record<BrandMarkTone, string> = {
  primary: "text-primary-foreground",
  gold: "text-foreground",
  subtle: "text-primary",
};

interface BrandLogoProps {
  size?: BrandMarkSize;
  tone?: BrandMarkTone;
  /**
   * Draw this glyph instead of the configured one. The role surfaces use it to
   * say which part of the app you are in (a mortarboard for a student, a
   * clipboard for an evaluator) while keeping one mark everywhere else.
   *
   * Ignored when the overlay configures an image logo: a deployment that
   * supplied its own artwork did not ask for it to be swapped out per page.
   */
  icon?: BrandIcon;
  className?: string;
}

/**
 * The mark on its own, with no name — for a cramped header, or beside text
 * that is not the product name.
 */
export const BrandLogo = ({
  size = "md",
  tone = "primary",
  icon,
  className,
}: BrandLogoProps) => {
  const { logo } = brand;

  if (logo?.bare) {
    return (
      <img
        src={logo.src}
        alt={logo.alt ?? brand.name}
        className={cn(TILE_SIZE[size], "flex-shrink-0 object-contain", className)}
      />
    );
  }

  return (
    <div
      className={cn(
        TILE_SIZE[size],
        TILE_TONE[tone],
        "flex flex-shrink-0 items-center justify-center rounded-lg",
        className,
      )}
    >
      {logo ? (
        <img
          src={logo.src}
          alt={logo.alt ?? brand.name}
          className="h-full w-full rounded-lg object-contain"
        />
      ) : (
        <Glyph icon={icon} className={cn(GLYPH_SIZE[size], GLYPH_TONE[tone])} />
      )}
    </div>
  );
};

const Glyph = ({ icon, className }: { icon?: BrandIcon; className?: string }) => {
  const Icon = icon ?? brand.icon;
  return Icon ? <Icon className={className} /> : <FallbackMark className={className} />;
};

/**
 * The mark an unconfigured clone draws: an open book, as neutral as the rest
 * of the default brand.
 *
 * Inline rather than a `lucide-react` import so that the fallback owes nothing
 * to an icon set an overlay may well replace outright.
 */
const FallbackMark = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);

interface BrandMarkProps extends BrandLogoProps {
  /**
   * Text shown beside the mark. Defaults to the configured brand name; an
   * institution portal passes the school's own name instead and puts
   * `brand.poweredBy` in `subtitle`.
   */
  name?: ReactNode;
  /** Drop the text and render the mark alone. */
  hideName?: boolean;
  /**
   * Extra classes on the name. The one thing worth passing here is a
   * responsive-visibility rule — a narrow header hides the name below `xs`
   * rather than letting it wrap.
   */
  nameClassName?: string;
  /** A quiet line under the name: the institution, the environment. */
  subtitle?: ReactNode;
  /** Rendered inline after the name — the "Super Admin" chip, typically. */
  badge?: ReactNode;
  /** Wrap the whole mark in a router link to this path. */
  to?: string;
  /** Classes on the outer flex row. */
  className?: string;
}

export const BrandMark = ({
  size = "md",
  tone = "primary",
  icon,
  name,
  hideName = false,
  nameClassName,
  subtitle,
  badge,
  to,
  className,
}: BrandMarkProps) => {
  const nameNode = (
    <span
      className={cn("font-display font-bold text-foreground", NAME_SIZE[size], nameClassName)}
    >
      {name ?? brand.name}
    </span>
  );

  const content = (
    <>
      <BrandLogo size={size} tone={tone} icon={icon} />
      {!hideName &&
        // Wrapped only when there is something to stack: a subtitle belongs
        // under the name rather than beside the tile, and a badge belongs on
        // the name's line. With neither, the bare span is what a caller
        // hiding the name below a breakpoint expects — an empty wrapper would
        // still claim a flex gap.
        (subtitle || badge ? (
          <div>
            {nameNode}
            {badge}
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
        ) : (
          nameNode
        ))}
    </>
  );

  const row = cn("flex items-center gap-3", className);

  return to ? (
    <Link to={to} className={cn(row, "w-fit")}>
      {content}
    </Link>
  ) : (
    <div className={row}>{content}</div>
  );
};

export default BrandMark;
