import type { ReactNode } from "react";

/**
 * One message, one emphasis. `tone` changes a border and a background, never the
 * only signal: every notice opens with a heading that says what kind of message
 * it is, so it survives a greyscale screenshot and a screen reader.
 */
export function Notice({
  tone = "info",
  title,
  children,
  detail,
  role,
}: {
  tone?: "info" | "warn" | "error" | "accent";
  title: string;
  children?: ReactNode;
  detail?: string;
  role?: "status" | "alert";
}) {
  const className =
    tone === "warn"
      ? "notice notice--warn"
      : tone === "error"
        ? "notice notice--error"
        : tone === "accent"
          ? "notice notice--accent"
          : "notice";
  return (
    <div className={className} role={role}>
      <p className="notice__title">{title}</p>
      {children}
      {detail ? <p className="detail">{detail}</p> : null}
    </div>
  );
}
