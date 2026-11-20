/** The researcher's own shapes: sources as the reader sees them, summaries and reports. */
export interface Source {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  abstract: string;
  url: string;
  pdfUrl?: string;
  doi?: string;
  origin: string;
}
export interface SourceSummary {
  sourceId: string;
  findings: string[];
  limitations: string[];
  relevance: string;
  readerModel: string;
}
export interface ResearchClaim {
  text: string;
  sourceIds: string[];
}
export interface ResearchReport {
  question: string;
  findings: ResearchClaim[];
  applications: ResearchClaim[];
  openQuestions: ResearchClaim[];
  sources: Source[];
  text: string;
}
