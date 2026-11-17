/**
 * One stroked glyph, from a path in `web/nav.json`.
 *
 * The path data lives in the nav model rather than here because the Python fund-page
 * generator draws the same icons from the same bytes — a second copy of six paths is
 * six chances to drift. `aria-hidden` because every icon in the shell sits beside its
 * own text label, and a screen reader that announced both would say everything twice.
 */
export function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}
