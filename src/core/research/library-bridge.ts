import { ResearchLibrary } from "./library";
import { searchSources as searchProviders } from "./clients";
import { canonicalSourceId, selectSources } from "./sources";
import type { Source as LibrarySource, SourceOrigin } from "./types";
import type { Source, SourceSummary } from "./report-types";

/**
 * What the researcher needs from a library. The project's one research
 * library (part 1: SQLite, de-duplicated by DOI/arXiv id/URL, full-text
 * search) provides it through `ProjectResearchLibrary` below, so research
 * questions and `cobble team research` share the same sources and summaries.
 */
export interface ReportLibrary {
  search(query: string, limit?: number): Source[];
  upsertSources(sources: Source[]): void;
  getSummary(sourceId: string, readerModel: string): SourceSummary | undefined;
  saveSummary(summary: SourceSummary): void;
}

const ORIGINS: readonly SourceOrigin[] = ["arxiv", "openalex", "semantic-scholar"];

/** A library source as the reader sees it (stable id from its DOI or URL). */
export function toReportSource(source: LibrarySource): Source {
  return {
    id: canonicalSourceId({ url: source.url, doi: source.doi ?? undefined }),
    title: source.title,
    authors: source.authors,
    ...(source.year != null ? { year: source.year } : {}),
    ...(source.venue ? { venue: source.venue } : {}),
    abstract: source.abstract ?? "",
    url: source.url,
    ...(source.pdfUrl ? { pdfUrl: source.pdfUrl } : {}),
    ...(source.doi ? { doi: source.doi } : {}),
    origin: source.origin,
  };
}

export function toLibrarySource(source: Source): LibrarySource {
  return {
    title: source.title,
    authors: source.authors,
    year: source.year ?? null,
    venue: source.venue ?? null,
    abstract: source.abstract || null,
    url: source.url,
    pdfUrl: source.pdfUrl ?? null,
    doi: source.doi ?? null,
    origin: (ORIGINS as readonly string[]).includes(source.origin)
      ? (source.origin as SourceOrigin)
      : "openalex",
  };
}

/** Summaries live in the library entry's summary field, tagged with the reader model. */
const SUMMARY_TAG = "cobble-reader-summary";

export class ProjectResearchLibrary implements ReportLibrary {
  constructor(
    private readonly library: ResearchLibrary,
    private readonly projectId: string,
  ) {}

  search(query: string, limit = 10): Source[] {
    const tokens = query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
    // Full-text search needs every word; ask word by word so related saved
    // sources still come back, then rank them for the question.
    const found = new Map<string, Source>();
    for (const token of tokens.slice(0, 12))
      for (const entry of this.library.search(this.projectId, token, 25)) {
        const source = toReportSource(entry.source);
        found.set(source.id, source);
      }
    return selectSources(query, [...found.values()], limit);
  }

  upsertSources(sources: Source[]): void {
    for (const source of sources)
      this.library.upsert(this.projectId, toLibrarySource(source));
  }

  getSummary(sourceId: string, readerModel: string): SourceSummary | undefined {
    const entry = this.entry(sourceId);
    if (!entry?.summary) return undefined;
    try {
      const value = JSON.parse(entry.summary) as {
        tag?: string;
        summary?: SourceSummary;
      };
      return value.tag === SUMMARY_TAG &&
        value.summary?.readerModel === readerModel
        ? { ...value.summary, sourceId }
        : undefined;
    } catch {
      return undefined; // a plain-text summary written by someone else
    }
  }

  saveSummary(summary: SourceSummary): void {
    const entry = this.entry(summary.sourceId);
    if (!entry) return;
    this.library.setSummary(
      this.projectId,
      entry.id,
      JSON.stringify({ tag: SUMMARY_TAG, summary }),
    );
  }

  private entry(sourceId: string) {
    return this.library
      .search(this.projectId)
      .find((e) => toReportSource(e.source).id === sourceId);
  }
}

/** Search the free providers (arXiv, OpenAlex, Semantic Scholar) for the researcher. */
export async function searchForResearch(query: string): Promise<Source[]> {
  return (await searchProviders(query, { limit: 10 })).sources.map(toReportSource);
}
