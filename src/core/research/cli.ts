import type { CobbleService } from "../service";
import { ResearchLibrary } from "./library";
import { searchSources } from "./clients";

export type ResearchCommandDependencies = {
  search?: typeof searchSources;
  print?: (text: string) => void;
  warn?: (text: string) => void;
};

export async function runResearchCommand(
  service: CobbleService,
  args: string[],
  values: Record<string, unknown>,
  dependencies: ResearchCommandDependencies = {},
): Promise<void> {
  const [command, query] = args;
  const usage =
    'Usage: cobble team research search "QUERY" [--limit N] | library [QUERY]';
  if (command !== "search" && command !== "library") throw new Error(usage);
  if (
    args.length > 2 ||
    (command === "search" && (!query?.trim() || query.length > 4000))
  )
    throw new Error(usage);
  if (command === "library" && values.limit !== undefined)
    throw new Error(usage);
  const rawLimit = values.limit;
  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== "string" ||
      !/^\d+$/.test(rawLimit) ||
      Number(rawLimit) < 1 ||
      Number(rawLimit) > 50)
  )
    throw new Error("--limit must be an integer from 1 to 50");
  for (const key of Object.keys(values))
    if (!["data", "project", "json", "limit"].includes(key))
      throw new Error(usage);
  if (typeof values.project === "string") {
    const team = service.store
      .teams()
      .find(
        (team) =>
          team.name.toLowerCase() === values.project!.toString().toLowerCase(),
      );
    if (!team) throw new Error("Unknown project");
    await service.action({ type: "selectTeam", teamId: team.id });
  }
  const projectId = service.activeTeam()?.id;
  if (
    !projectId ||
    !service.store.teams().some((team) => team.id === projectId)
  )
    throw new Error("Select or create a project before using research.");
  const library = new ResearchLibrary(service.store);
  const print = dependencies.print ?? console.log;
  const warn = dependencies.warn ?? console.warn;
  if (command === "library") {
    const entries = library.search(projectId, query);
    print(
      values.json
        ? JSON.stringify(entries, null, 2)
        : entries
            .map(
              (entry) =>
                `${entry.source.title}\n${entry.source.url}${entry.summary ? `\n${entry.summary}` : ""}`,
            )
            .join("\n\n") || "Research library is empty.",
    );
    return;
  }
  const result = await (dependencies.search ?? searchSources)(query!, {
    limit: rawLimit === undefined ? 10 : Number(rawLimit),
    unpaywallEmail: process.env.COBBLE_UNPAYWALL_EMAIL,
  });
  for (const source of result.sources) library.upsert(projectId, source);
  for (const warning of result.warnings)
    warn(`${warning.provider}: ${warning.message}`);
  print(
    values.json
      ? JSON.stringify(result.sources, null, 2)
      : result.sources
          .map((source) => `${source.title}\n${source.url}`)
          .join("\n\n") || "No research sources found.",
  );
}
