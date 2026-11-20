// Keep this port independent of the optional helper runtime.
type PresentationRequest = {
  job: "next-up" | "digest" | "condense";
  input: string;
  fallback: string;
};
type PresentationRunner = (request: PresentationRequest) => Promise<string>;

const MAX_WORDING = 12_000;
const validWording = (text: string) =>
  typeof text === "string" &&
  text.trim().length > 0 &&
  text.length <= MAX_WORDING;

/** Only replace display labels; callers retain the original work items. */
export async function wordNextUp(
  runner: PresentationRunner,
  bullets: readonly string[],
): Promise<string[]> {
  const original = [...bullets];
  if (!bullets.length) return original;
  try {
    const text = await runner({
      job: "next-up",
      input: JSON.stringify(bullets),
      fallback: bullets.join("\n"),
    });
    if (!validWording(text)) return original;
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    return lines.length === bullets.length && lines.every(Boolean)
      ? lines
      : original;
  } catch {
    return original;
  }
}

/** Supply summary prose only, keeping authoritative digest fields outside it. */
export async function summarizeDigest(
  runner: PresentationRunner,
  deterministicSummary: string,
): Promise<string> {
  try {
    const text = await runner({
      job: "digest",
      input: deterministicSummary,
      fallback: deterministicSummary,
    });
    return validWording(text) ? text : deterministicSummary;
  } catch {
    return deterministicSummary;
  }
}

/** Condense prompt copies only; raw logs and check results remain authoritative. */
export async function condenseAgentText(
  runner: PresentationRunner,
  text: string,
  fallback: string,
): Promise<string> {
  if (text.length <= 6000) return text;
  try {
    const summary = await runner({ job: "condense", input: text, fallback });
    // The supplied deterministic fallback is returned byte-for-byte.
    if (summary === fallback) return fallback;
    return validWording(summary) && summary.length < text.length
      ? summary
      : fallback;
  } catch {
    return fallback;
  }
}
