import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store";
import { ResearchLibrary } from "../src/core/research/library";
import { ProjectResearchLibrary } from "../src/core/research/library-bridge";
import {
  canonicalSourceId,
  selectSources,
  searchSources,
} from "../src/core/research/sources";
import {
  createGeminiReader,
  type ResearchReader,
} from "../src/core/research/reader";
import { runResearch } from "../src/core/research/researcher";
import type { Source } from "../src/core/research/report-types";
const source = (
  url = "https://example.org/paper",
  title = "SQLite research",
): Source => ({
  id: "provider-id",
  title,
  authors: ["Author"],
  abstract: "Research about persistence",
  url,
  origin: "test",
});
const envelope = (value: unknown) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
    }),
    { headers: { "content-type": "application/json" } },
  );
const summary = {
  findings: ["Evidence"],
  limitations: [],
  relevance: "Useful",
};

test("canonical IDs and source selection are deterministic, deduplicated and bounded", () => {
  assert.equal(
    canonicalSourceId({ ...source(), doi: "https://doi.org/10.123/ABC" }),
    "doi:10.123/abc",
  );
  assert.equal(
    canonicalSourceId(source("https://arxiv.org/pdf/2401.12345v2.pdf")),
    "arxiv:2401.12345",
  );
  const a = source("https://example.org/a?utm_source=x#fragment");
  const b = source("https://example.org/a");
  const all = [
    a,
    b,
    ...Array.from({ length: 15 }, (_, i) =>
      source(`https://example.org/${i}`, `Other ${i}`),
    ),
  ];
  assert.deepEqual(
    selectSources("SQLite", all),
    selectSources("SQLite", [...all].reverse()),
  );
  assert.equal(selectSources("SQLite", all).length, 10);
  assert.equal(selectSources("SQLite", all, 5).length, 5);
  assert.equal(selectSources("SQLite", [a, b]).length, 1);
});

test("the shared research library: idempotent, summary searchable, model and project isolated", () => {
  const store = new Store(":memory:");
  try {
    // Research part 2 stores its sources and summaries in the project's one
    // research library (part 1), so ids come from the DOI or URL.
    const a = new ProjectResearchLibrary(new ResearchLibrary(store), "a"),
      again = new ProjectResearchLibrary(new ResearchLibrary(store), "a"),
      b = new ProjectResearchLibrary(new ResearchLibrary(store), "b");
    const id = canonicalSourceId(source());
    a.upsertSources([source()]);
    a.upsertSources([source()]);
    a.saveSummary({
      sourceId: id,
      readerModel: "reader",
      ...summary,
      relevance: "specialkeyword",
    });
    assert.equal(again.search("specialkeyword").length, 1);
    assert.equal(a.search("SQLite").length, 1);
    assert.equal(a.search("SQLite")[0]!.id, id);
    assert.equal(b.search("SQLite").length, 0);
    assert.equal(b.getSummary(id, "reader"), undefined);
    assert.equal(a.getSummary(id, "other"), undefined);
    assert.equal(again.getSummary(id, "reader")?.relevance, "specialkeyword");
  } finally {
    store.db.close();
  }
});

test("source discovery normalizes providers and isolates partial failures offline", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("arxiv"))
      return new Response(
        "<feed><entry><id>http://arxiv.org/abs/2401.12345v1</id><title>SQLite paper</title><summary>Storage</summary><published>2024-01-01</published><author><name>A</name></author></entry></feed>",
      );
    if (url.includes("openalex"))
      return Response.json({
        results: [
          {
            display_name: "SQLite study",
            doi: "https://doi.org/10.1/test",
            authorships: [{ author: { display_name: "B" } }],
            abstract_inverted_index: { SQLite: [0], works: [1] },
            publication_year: 2025,
          },
        ],
      });
    throw new Error("provider offline");
  };
  const results = await searchSources("SQLite", { fetch: fetcher });
  assert.equal(results.length, 2);
  assert.ok(
    results.some((s) => s.id === "arxiv:2401.12345" && s.authors[0] === "A"),
  );
  assert.ok(
    results.some(
      (s) => s.id === "doi:10.1/test" && s.abstract === "SQLite works",
    ),
  );
  assert.ok(!calls.some((c) => c.includes("unpaywall")));
});

test("native Gemini uses header, JSON configuration and validated inline PDF", async () => {
  const bodies: any[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).includes("8.8.8.8"))
      return new Response("%PDF-1.7\nfixture", {
        headers: { "content-type": "application/pdf" },
      });
    assert.match(
      String(input),
      /\/v1beta\/models\/gemini-3\.5-flash-lite:generateContent$/,
    );
    assert.equal(
      new Headers(init?.headers).get("x-goog-api-key"),
      "offline-placeholder",
    );
    bodies.push(JSON.parse(String(init?.body)));
    return envelope(summary);
  };
  const reader = createGeminiReader({
    apiKey: "offline-placeholder",
    fetch: fetcher,
  });
  const result = await reader.summarize({
    ...source(),
    pdfUrl: "https://8.8.8.8/paper.pdf",
  });
  assert.equal(result.readerModel, reader.model);
  assert.equal(
    bodies[0].contents[0].parts[1].inlineData.mimeType,
    "application/pdf",
  );
  assert.equal(bodies[0].generationConfig.responseMimeType, "application/json");
  assert.equal(bodies[0].tools, undefined);
});

test("PDF private redirects, MIME/signature failures and streamed size cap fall back safely", async () => {
  for (const mode of [
    "private",
    "redirect",
    "mime",
    "signature",
    "length",
    "stream",
  ]) {
    let pdfCalls = 0;
    let body: any;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).includes("generateContent")) {
        body = JSON.parse(String(init?.body));
        return envelope(summary);
      }
      pdfCalls++;
      if (mode === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/secret" },
        });
      if (mode === "mime")
        return new Response("%PDF-x", {
          headers: { "content-type": "text/html" },
        });
      if (mode === "signature")
        return new Response("not PDF", {
          headers: { "content-type": "application/pdf" },
        });
      if (mode === "length")
        return new Response("%PDF-x", {
          headers: {
            "content-type": "application/pdf",
            "content-length": String(11 * 1024 * 1024),
          },
        });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(10 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/pdf" } },
      );
    };
    const reader = createGeminiReader({
      apiKey: "offline-placeholder",
      fetch: fetcher,
    });
    const result = await reader.summarize({
      ...source(),
      pdfUrl:
        mode === "private"
          ? "https://127.0.0.1/secret"
          : "https://8.8.8.8/paper.pdf",
    });
    assert.equal(body.contents[0].parts.length, 1, mode);
    assert.match(result.limitations.join(" "), /full text was not read/);
    assert.equal(pdfCalls, mode === "private" ? 0 : 1);
  }
});

test("credentials and malformed Gemini output produce actionable, sanitized errors", async () => {
  assert.throws(() => createGeminiReader({ apiKey: "" }), /GEMINI_API_KEY/);
  const reader = createGeminiReader({
    apiKey: "offline-placeholder",
    fetch: async () => new Response("secret upstream text", { status: 403 }),
  });
  await assert.rejects(reader.summarize(source()), /Check GEMINI_API_KEY/);
  const invalid = createGeminiReader({
    apiKey: "offline-placeholder",
    fetch: async () => envelope({ findings: "wrong" }),
  });
  await assert.rejects(
    invalid.summarize(source()),
    /Invalid Gemini source summary/,
  );
});

test("pipeline reuses SQLite summaries and filters every unsupported claim", async () => {
  const db = new Store(":memory:");
  try {
    let reads = 0;
    const good = source(),
      bad = source("https://example.org/failure");
    const library = new ProjectResearchLibrary(new ResearchLibrary(db), "project");
    const reader: ResearchReader = {
      model: "offline-reader",
      async summarize(s) {
        reads++;
        if (s.url === bad.url) throw new Error("failed read");
        return { ...summary, sourceId: s.id, readerModel: this.model };
      },
      async writeReport({ sources }) {
        return {
          findings: [
            { text: "Supported", sourceIds: [sources[0].id] },
            { text: "Uncited", sourceIds: [] },
            { text: "Unknown", sourceIds: ["missing"] },
            { text: "Mixed", sourceIds: [sources[0].id, "missing"] },
            { text: " ", sourceIds: [sources[0].id] },
          ],
          applications: [],
          openQuestions: [],
        };
      },
    };
    const input = {
      question: "SQLite",
      projectContext: "local desktop",
      library,
      reader,
      search: async () => [good, bad],
    };
    const first = await runResearch(input);
    assert.equal(first.findings.length, 1);
    assert.equal(first.sources.length, 1);
    assert.match(first.text, /Supported \[1\]/);
    assert.doesNotMatch(first.text, /Uncited|Unknown|Mixed/);
    await runResearch({ ...input, search: async () => [good] });
    assert.equal(reads, 3); // One successful cached read; failed source can be retried.
    const cached = new ProjectResearchLibrary(new ResearchLibrary(db), "cached-only");
    await runResearch({
      ...input,
      library: cached,
      search: async () => [good],
    });
    const afterFirstRead = reads;
    await runResearch({
      ...input,
      library: new ProjectResearchLibrary(new ResearchLibrary(db), "cached-only"),
      search: async () => [good],
    });
    assert.equal(reads, afterFirstRead);
    const other = new ProjectResearchLibrary(new ResearchLibrary(db), "other");
    const none = await runResearch({
      ...input,
      library: other,
      search: async () => [],
    });
    assert.equal(none.sources.length, 0);
    assert.match(none.text, /No sources were found/);
    const fail = await runResearch({
      ...input,
      library: other,
      search: async () => [bad],
    });
    assert.equal(fail.findings.length, 0);
    assert.match(fail.text, /No sources could be successfully summarized/);
  } finally {
    db.db.close();
  }
});
