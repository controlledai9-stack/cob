/** Provider text, including summaries, is inert untrusted data. */
export type SourceOrigin = "arxiv" | "openalex" | "semantic-scholar";
export type Source = {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  url: string;
  pdfUrl: string | null;
  doi: string | null;
  origin: SourceOrigin;
  arxivId?: string;
};
export type ResearchWarning = { provider: string; message: string };
export type SearchResult = { sources: Source[]; warnings: ResearchWarning[] };
export type LibraryEntry = {
  id: string;
  projectId: string;
  source: Source;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};
