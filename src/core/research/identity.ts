import type { Source } from "./types";

export function normalizeDoi(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  let doi = value
    .trim()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "");
  try {
    doi = decodeURIComponent(doi);
  } catch {
    return null;
  }
  return /^10\.\d{4,9}\/[^\s<>]+$/i.test(doi) ? doi.toLowerCase() : null;
}

export function normalizeArxivId(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const id = value
    .trim()
    .replace(
      /^(?:https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)/i,
      "",
    )
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "")
    .toLowerCase();
  return /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[a-z]{2})?\/\d{7})$/.test(id)
    ? id
    : null;
}

export function sourceIdentityKeys(source: Source): string[] {
  const keys: string[] = [];
  const doi = normalizeDoi(source.doi) ?? normalizeDoi(source.url);
  const arxiv =
    normalizeArxivId(source.arxivId) ?? normalizeArxivId(source.url);
  if (doi) keys.push(`doi:${doi}`);
  if (arxiv) keys.push(`arxiv:${arxiv}`);
  try {
    const url = new URL(source.url);
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    ) {
      url.hash = "";
      keys.push(`url:${url.href}`);
    }
  } catch {
    /* Invalid URLs have no URL identity. */
  }
  return keys;
}
