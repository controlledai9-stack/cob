import type { Source } from "./report-types";
import { boundedBody, userAgent } from "./http";

export function canonicalSourceId(source: Pick<Source, "url" | "doi">): string {
  const doi = (
    source.doi ??
    (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(source.url)
      ? source.url
      : undefined)
  )
    ?.trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/, "");
  if (doi) return `doi:${doi}`;
  const arxiv = source.url
    .match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+)/i)?.[1]
    ?.replace(/\.pdf$/i, "")
    .replace(/v\d+$/, "");
  if (arxiv) return `arxiv:${arxiv.toLowerCase()}`;
  try {
    const u = new URL(source.url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const key of [...u.searchParams.keys()])
      if (/^(utm_|ref$)/i.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    u.pathname = u.pathname.replace(/\/$/, "") || "/";
    return `url:${u.toString()}`;
  } catch {
    return `url:${source.url.trim()}`;
  }
}
export function selectSources(
  query: string,
  sources: Source[],
  limit = 10,
): Source[] {
  const tokens = [
    ...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
  ];
  const score = (s: Source) =>
    tokens.reduce(
      (n, t) =>
        n +
        (s.title.toLowerCase().includes(t) ? 3 : 0) +
        (s.abstract.toLowerCase().includes(t) ? 1 : 0),
      0,
    );
  const sorted = sources
    .filter((s) => s.title?.trim() && /^https?:\/\//i.test(s.url))
    .map((s) => ({ ...s, id: canonicalSourceId(s) }))
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        a.id.localeCompare(b.id) ||
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  const seen = new Set<string>();
  return sorted
    .filter((s) => {
      const keys = [s.id, canonicalSourceId({ url: s.url })];
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    })
    .slice(
      0,
      Math.max(
        0,
        Math.min(10, Number.isFinite(limit) ? Math.floor(limit) : 10),
      ),
    );
}
const nextRequest = new Map<string, number>();
async function get(url: string, fetcher: typeof fetch): Promise<string> {
  const host = new URL(url).host;
  const now = Date.now();
  const start = Math.max(now, nextRequest.get(host) ?? 0);
  nextRequest.set(host, start + 1000);
  if (start - now > 3000)
    throw new Error("Source provider is busy; retry later");
  if (start > now) await new Promise((r) => setTimeout(r, start - now));
  const response = await fetcher(url, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Source provider HTTP ${response.status}`);
  return (await boundedBody(response, 2 * 1024 * 1024)).toString("utf8");
}
const clean = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
export async function searchSources(
  query: string,
  options: {
    limit?: number;
    fetch?: typeof globalThis.fetch;
    unpaywallEmail?: string;
  } = {},
): Promise<Source[]> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const q = encodeURIComponent(query.slice(0, 1000));
  const jobs: (() => Promise<Source[]>)[] = [
    async () => {
      const xml = await get(
        `https://export.arxiv.org/api/query?search_query=all:${q}&max_results=15`,
        fetcher,
      );
      return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)].map(
        (m) => {
          const tag = (name: string) =>
            clean(
              m[1].match(
                new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`),
              )?.[1] ?? "",
            );
          const url = tag("id").replace(/^http:/, "https:");
          return {
            id: "",
            title: tag("title"),
            abstract: tag("summary"),
            authors: [...m[1].matchAll(/<name>([\s\S]*?)<\/name>/g)].map((x) =>
              clean(x[1]),
            ),
            url,
            pdfUrl: url.replace("/abs/", "/pdf/"),
            year: Number(tag("published").slice(0, 4)) || undefined,
            doi: tag("arxiv:doi") || undefined,
            origin: "arxiv",
          };
        },
      );
    },
    async () => {
      const data = JSON.parse(
        await get(
          `https://api.openalex.org/works?search=${q}&per-page=15`,
          fetcher,
        ),
      );
      return (Array.isArray(data.results) ? data.results : [])
        .slice(0, 15)
        .map((r: any) => {
          const words: string[] = [];
          for (const [word, positions] of Object.entries(
            r.abstract_inverted_index ?? {},
          ))
            for (const p of (positions as number[]).slice(0, 100))
              if (Number.isInteger(p) && p >= 0 && p < 15000) words[p] = word;
          return {
            id: "",
            title: String(r.display_name ?? ""),
            abstract: words.join(" ").slice(0, 30000),
            authors: (r.authorships ?? [])
              .slice(0, 100)
              .map((a: any) => String(a.author?.display_name ?? "")),
            year: r.publication_year,
            url: r.doi ?? r.primary_location?.landing_page_url ?? r.id,
            pdfUrl: r.best_oa_location?.pdf_url ?? undefined,
            doi: r.doi ?? undefined,
            venue: r.primary_location?.source?.display_name,
            origin: "openalex",
          };
        });
    },
    async () => {
      const data = JSON.parse(
        await get(
          `https://api.semanticscholar.org/graph/v1/paper/search?query=${q}&limit=15&fields=title,authors,year,venue,abstract,url,externalIds,openAccessPdf`,
          fetcher,
        ),
      );
      return (Array.isArray(data.data) ? data.data : [])
        .slice(0, 15)
        .map((r: any) => ({
          id: "",
          title: String(r.title ?? ""),
          abstract: String(r.abstract ?? "").slice(0, 30000),
          authors: (r.authors ?? [])
            .slice(0, 100)
            .map((a: any) => String(a.name ?? "")),
          year: r.year ?? undefined,
          venue: r.venue ?? undefined,
          url: r.url,
          doi: r.externalIds?.DOI ?? undefined,
          pdfUrl: r.openAccessPdf?.url ?? undefined,
          origin: "semantic-scholar",
        }));
    },
  ];
  const results = await Promise.allSettled(jobs.map((job) => job()));
  const selected = selectSources(
    query,
    results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
    options.limit,
  );
  if (options.unpaywallEmail)
    for (const s of selected)
      if (s.doi && !s.pdfUrl) {
        try {
          const d = JSON.parse(
            await get(
              `https://api.unpaywall.org/v2/${encodeURIComponent(s.doi.replace(/^https?:\/\/doi.org\//, ""))}?email=${encodeURIComponent(options.unpaywallEmail)}`,
              fetcher,
            ),
          );
          s.pdfUrl = d.best_oa_location?.url_for_pdf ?? undefined;
        } catch {
          /* optional provider failure */
        }
      }
  return selected;
}
