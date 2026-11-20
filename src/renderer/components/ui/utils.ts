/** Joins class names, skipping empty ones (a tiny stand-in for shadcn's `cn`). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** One or two capital letters for a letter avatar. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
  const letters = (words[0]?.[0] ?? "") + (words[1]?.[0] ?? "");
  return (letters || name[0] || "?").toUpperCase();
}
