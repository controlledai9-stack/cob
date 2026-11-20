import type { Source, SearchResult, SourceOrigin } from "./types";
import { normalizeArxivId, normalizeDoi, sourceIdentityKeys } from "./identity";

export type ResearchClock = {
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
const realClock: ResearchClock = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export type SearchOptions = {
  limit?: number;
  unpaywallEmail?: string;
  fetch?: typeof globalThis.fetch;
  clock?: ResearchClock;
};
// Shared pacing across calls, with isolated schedules for injected transports/clocks.
const schedules = new WeakMap<object, Map<string, Promise<number>>>();
const intervals: Record<string, number> = {
  arxiv: 3000,
  openalex: 100,
  "semantic-scholar": 1000,
  unpaywall: 100,
};
const MAX_BODY = 2 * 1024 * 1024;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim()
    ? value.replace(/\s+/g, " ").trim()
    : null;
const obj = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
const array = (value: unknown): any[] =>
  Array.isArray(value) ? value.slice(0, 200) : [];
function url(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}
function source(raw: Record<string, any>, origin: SourceOrigin): Source | null {
  const title = text(raw.title),
    link = url(raw.url);
  if (!title || !link) return null;
  const arxivId = normalizeArxivId(raw.arxivId) ?? normalizeArxivId(link);
  if (origin === "arxiv" && !arxivId) return null;
  return {
    title,
    url: link,
    authors: array(raw.authors)
      .map(text)
      .filter((v): v is string => v !== null),
    year:
      Number.isInteger(raw.year) && raw.year >= 1000 && raw.year <= 9999
        ? raw.year
        : null,
    venue: text(raw.venue),
    abstract: text(raw.abstract),
    pdfUrl: url(raw.pdfUrl),
    doi: normalizeDoi(raw.doi),
    origin,
    ...(arxivId ? { arxivId } : {}),
  };
}

// Narrow XML tokenizer: no DTDs, expansion, external resources or HTML execution.
type Element = {
  name: string;
  attrs: Record<string, string>;
  children: Element[];
  value: string;
};
function entities(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, key: string) => {
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      };
      if (!key.startsWith("#")) return named[key] ?? _;
      const n =
        key[1].toLowerCase() === "x"
          ? parseInt(key.slice(2), 16)
          : Number(key.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
        ? String.fromCodePoint(n)
        : "\uFFFD";
    },
  );
}
function atom(xml: string): Source[] {
  const root: Element = { name: "", attrs: {}, children: [], value: "" },
    stack = [root];
  const tokens =
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g;
  let consumed = 0;
  for (const match of xml.matchAll(tokens)) {
    if (match.index !== consumed) throw new Error("XML");
    const token = match[0];
    consumed += token.length;
    const parent = stack[stack.length - 1];
    if (token.startsWith("<![CDATA[")) {
      parent.value += token.slice(9, -3);
      continue;
    }
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<!")) throw new Error("XML declarations forbidden");
    if (token.startsWith("</")) {
      if (stack.length === 1 || token !== `</${parent.name}>`)
        throw new Error("XML");
      stack.pop();
      continue;
    }
    if (token.startsWith("<")) {
      const m =
        /^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*)(\/?)>$/.exec(
          token,
        );
      if (!m || stack.length > 32) throw new Error("XML");
      const node: Element = { name: m[1], attrs: {}, children: [], value: "" };
      for (const a of m[2].matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g))
        node.attrs[a[1]] = entities(a[3]);
      parent.children.push(node);
      if (!m[3]) stack.push(node);
    } else parent.value += entities(token);
  }
  if (
    consumed !== xml.length ||
    stack.length !== 1 ||
    root.children.length !== 1
  )
    throw new Error("XML");
  const local = (n: Element) => n.name.split(":").pop();
  const feed = root.children[0];
  if (local(feed) !== "feed") throw new Error("XML");
  const child = (n: Element, name: string) =>
    n.children.find((c) => local(c) === name)?.value;
  return feed.children
    .filter((n) => local(n) === "entry")
    .slice(0, 200)
    .map((n) => {
      const links = n.children.filter((c) => local(c) === "link");
      const id = child(n, "id");
      return source(
        {
          title: child(n, "title"),
          url: links.find((l) => l.attrs.rel === "alternate")?.attrs.href ?? id,
          arxivId: id,
          authors: n.children
            .filter((c) => local(c) === "author")
            .map((a) => child(a, "name")),
          year: Number(child(n, "published")?.slice(0, 4)),
          abstract: child(n, "summary"),
          venue: child(n, "journal_ref"),
          doi: child(n, "doi"),
          pdfUrl: links.find(
            (l) =>
              l.attrs.type === "application/pdf" || l.attrs.title === "pdf",
          )?.attrs.href,
        },
        "arxiv",
      );
    })
    .filter((s): s is Source => s !== null);
}
function abstractIndex(value: unknown): string | null {
  const words = new Map<number, string>();
  for (const [word, positions] of Object.entries(obj(value))) {
    for (const position of array(positions)) {
      if (
        Number.isInteger(position) &&
        position >= 0 &&
        position < 10000 &&
        !words.has(position)
      )
        words.set(position, word);
    }
  }
  return text(
    [...words]
      .sort(([a], [b]) => a - b)
      .map(([, word]) => word)
      .join(" "),
  );
}
function dedupe(sources: Source[]): Source[] {
  const groups: { source: Source; keys: Set<string> }[] = [];
  for (const item of sources) {
    const keys = new Set(sourceIdentityKeys(item));
    const matches = groups.filter((g) => [...keys].some((k) => g.keys.has(k)));
    const base = matches[0] ?? { source: { ...item }, keys: new Set<string>() };
    for (const other of [...matches.slice(1).map((g) => g.source), item]) {
      for (const field of [
        "doi",
        "arxivId",
        "abstract",
        "venue",
        "year",
        "pdfUrl",
      ] as const) {
        if (!base.source[field] && other[field])
          Object.assign(base.source, { [field]: other[field] });
      }
      if (!base.source.authors.length) base.source.authors = other.authors;
    }
    for (const group of matches)
      for (const key of group.keys) base.keys.add(key);
    for (const key of keys) base.keys.add(key);
    for (const group of matches.slice(1))
      groups.splice(groups.indexOf(group), 1);
    if (!matches.length) groups.push(base);
  }
  return groups.map((g) => g.source);
}

export async function searchSources(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new RangeError("Research limit must be an integer from 1 to 50");
  if (typeof query !== "string" || !query.trim() || query.length > 4000)
    throw new TypeError("Research query must contain 1 to 4000 characters");
  const transport = options.fetch ?? globalThis.fetch,
    clock = options.clock ?? realClock;
  const scheduleKey = options.clock ?? transport;
  let schedule = schedules.get(scheduleKey);
  if (!schedule) {
    schedule = new Map();
    schedules.set(scheduleKey, schedule);
  }
  const result: SearchResult = { sources: [], warnings: [] };
  async function request(
    provider: string,
    endpoint: URL,
  ): Promise<string | null> {
    const previous = schedule!.get(provider) ?? Promise.resolve(-Infinity);
    const slot = previous.then(async (last) => {
      const delay = Math.max(0, last + intervals[provider] - clock.now());
      if (delay) await clock.sleep(delay);
      return clock.now();
    });
    schedule!.set(
      provider,
      slot.catch(() => clock.now()),
    );
    await slot;
    const controller = new AbortController();
    let timer: unknown;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let failure = "Request failed";
    const timeout = new Promise<never>((_, reject) => {
      timer = clock.setTimeout(() => {
        failure = "Request timed out";
        controller.abort();
        reject(new Error("timeout"));
      }, 8000);
    });
    try {
      return await Promise.race([
        timeout,
        (async () => {
          const response = await transport(endpoint, {
            signal: controller.signal,
            redirect: "error",
            headers: {
              "User-Agent": "Cobble/0.4 research-library",
              Accept:
                provider === "arxiv"
                  ? "application/atom+xml"
                  : "application/json",
            },
          });
          if (!response.ok) {
            failure =
              response.status === 429
                ? "Rate limited (HTTP 429)"
                : `Request failed (HTTP ${response.status})`;
            void response.body?.cancel().catch(() => {});
            throw new Error("HTTP");
          }
          if (Number(response.headers.get("content-length")) > MAX_BODY) {
            failure = "Response exceeds size limit";
            void response.body?.cancel().catch(() => {});
            throw new Error("size");
          }
          reader = response.body?.getReader();
          if (!reader) return "";
          let bytes = 0,
            body = "";
          const decoder = new TextDecoder();
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_BODY) {
              failure = "Response exceeds size limit";
              throw new Error("size");
            }
            body += decoder.decode(chunk.value, { stream: true });
          }
          return body + decoder.decode();
        })(),
      ]);
    } catch {
      result.warnings.push({ provider, message: failure });
      return null;
    } finally {
      clock.clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  }
  const endpoints: [SourceOrigin, URL][] = [
    ["arxiv", new URL("https://export.arxiv.org/api/query")],
    ["openalex", new URL("https://api.openalex.org/works")],
    [
      "semantic-scholar",
      new URL("https://api.semanticscholar.org/graph/v1/paper/search"),
    ],
  ];
  endpoints[0][1].search = new URLSearchParams({
    search_query: `all:${query.trim()}`,
    start: "0",
    max_results: String(limit),
  }).toString();
  endpoints[1][1].search = new URLSearchParams({
    search: query.trim(),
    per_page: String(limit),
  }).toString();
  endpoints[2][1].search = new URLSearchParams({
    query: query.trim(),
    limit: String(limit),
    fields: "title,authors,year,venue,abstract,url,openAccessPdf,externalIds",
  }).toString();
  let successfulProviders = 0;
  for (const [provider, endpoint] of endpoints) {
    const body = await request(provider, endpoint);
    if (body === null) continue;
    try {
      if (provider === "arxiv") {
        result.sources.push(...atom(body));
        successfulProviders++;
        continue;
      }
      const payload = obj(JSON.parse(body));
      const records = provider === "openalex" ? payload.results : payload.data;
      if (!Array.isArray(records)) throw new Error("payload");
      for (const value of array(records)) {
        const record = obj(value);
        const normalized =
          provider === "openalex"
            ? source(
                {
                  title: record.title ?? record.display_name,
                  authors: array(record.authorships).map(
                    (a) => obj(obj(a).author).display_name,
                  ),
                  year: record.publication_year,
                  venue: obj(obj(record.primary_location).source).display_name,
                  abstract: abstractIndex(record.abstract_inverted_index),
                  doi: record.doi,
                  url:
                    url(obj(record.primary_location).landing_page_url) ??
                    url(record.doi) ??
                    url(record.id),
                  pdfUrl:
                    obj(record.best_oa_location).pdf_url ??
                    obj(record.primary_location).pdf_url,
                },
                provider,
              )
            : source(
                {
                  ...record,
                  authors: array(record.authors).map((a) => obj(a).name),
                  pdfUrl: obj(record.openAccessPdf).url,
                  doi: obj(record.externalIds).DOI,
                  arxivId: obj(record.externalIds).ArXiv,
                },
                provider,
              );
        if (normalized) result.sources.push(normalized);
      }
      successfulProviders++;
    } catch {
      result.warnings.push({ provider, message: "Invalid provider response" });
    }
  }
  if (!successfulProviders)
    throw new Error(
      "Research search failed: all search providers failed or returned invalid responses",
    );
  result.sources = dedupe(result.sources).slice(0, limit);
  const email = options.unpaywallEmail?.trim();
  if (email) {
    for (const item of result.sources) {
      if (!item.doi || item.pdfUrl) continue;
      const endpoint = new URL(
        `https://api.unpaywall.org/v2/${encodeURIComponent(item.doi)}`,
      );
      endpoint.searchParams.set("email", email);
      const body = await request("unpaywall", endpoint);
      if (body === null) continue;
      try {
        const payload = obj(JSON.parse(body));
        item.pdfUrl = url(obj(payload.best_oa_location).url_for_pdf);
      } catch {
        result.warnings.push({
          provider: "unpaywall",
          message: "Invalid provider response",
        });
      }
    }
  }
  return result;
}
