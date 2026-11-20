import { type ReportLibrary, searchForResearch } from "./library-bridge";
import { canonicalSourceId, selectSources } from "./sources";
import { validSummary, type ResearchReader } from "./reader";
import type {
  ResearchReport,
  ResearchClaim,
  Source,
  SourceSummary,
} from "./report-types";

export async function runResearch(input: {
  question: string;
  projectContext: string;
  library: ReportLibrary;
  reader: ResearchReader;
  search?: (query: string) => Promise<Source[]>;
}): Promise<ResearchReport> {
  const { question, projectContext, library, reader } = input;
  let external: Source[] = [];
  try {
    external = await (input.search ?? searchForResearch)(question);
  } catch {
    /* Local library remains usable offline. */
  }
  // One id per paper (from its DOI or URL), so saved summaries are found again.
  const selected = selectSources(question, [
    ...library.search(question),
    ...external,
  ]).map((source) => ({ ...source, id: canonicalSourceId(source) }));
  library.upsertSources(selected);
  const summaries: SourceSummary[] = [];
  const sources: Source[] = [];
  for (const source of selected) {
    try {
      let summary = library.getSummary(source.id, reader.model);
      if (!validSummary(summary, source.id, reader.model)) {
        summary = await reader.summarize(source);
        if (!validSummary(summary, source.id, reader.model)) continue;
        library.saveSummary(summary);
      }
      summaries.push(summary);
      sources.push(source);
    } catch {
      /* Failed reads never become evidence. */
    }
  }
  const allowed = new Set(sources.map((s) => s.id));
  const filter = (value: unknown): ResearchClaim[] =>
    Array.isArray(value)
      ? value
          .slice(0, 30)
          .filter(
            (c): c is ResearchClaim =>
              !!c &&
              typeof c.text === "string" &&
              !!c.text.trim() &&
              c.text.length <= 4000 &&
              Array.isArray(c.sourceIds) &&
              c.sourceIds.length > 0 &&
              c.sourceIds.every(
                (id: unknown) => typeof id === "string" && allowed.has(id),
              ),
          )
          .map((c) => ({
            text: c.text.trim(),
            sourceIds: [...new Set(c.sourceIds)],
          }))
      : [];
  let findings: ResearchClaim[] = [],
    applications: ResearchClaim[] = [],
    openQuestions: ResearchClaim[] = [];
  let status = selected.length
    ? "No sources could be successfully summarized."
    : "No sources were found.";
  if (summaries.length) {
    try {
      const report = await reader.writeReport({
        question,
        projectContext,
        sources,
        summaries,
      });
      findings = filter(report.findings);
      applications = filter(report.applications);
      openQuestions = filter(report.openQuestions);
      status = "No supported claims were returned.";
    } catch {
      status =
        "Sources were summarized, but report generation failed. Retry the question to reuse saved summaries.";
    }
  }
  const safe = (text: string) =>
    text
      .replace(/[\r\n]+/g, " ")
      .replace(/\[\d+(?:[,;\s]+\d+)*\]/g, "")
      .replace(/[\[\]<>`]/g, "");
  const render = (claims: ResearchClaim[]) =>
    claims.length
      ? claims
          .map(
            (c) =>
              `- ${safe(c.text)} ${c.sourceIds.map((id) => `[${sources.findIndex((s) => s.id === id) + 1}]`).join(" ")}`,
          )
          .join("\n")
      : `- ${status}`;
  const sourceLines = sources
    .map(
      (s, i) =>
        `${i + 1}. ${safe(s.title)} - ${s.url.replace(/[\r\n<>]/g, "")}`,
    )
    .join("\n");
  const text = `Key findings\n${render(findings)}\n\nApplication to this project\n${render(applications)}\n\nOpen questions\n${render(openQuestions)}\n\nSources\n${sourceLines || "No successfully summarized sources."}`;
  return { question, findings, applications, openQuestions, sources, text };
}
