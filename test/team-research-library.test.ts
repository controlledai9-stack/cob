import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/core/store";
import { ResearchLibrary } from "../src/core/research/library";
import type { Source } from "../src/core/research/types";

function source(overrides: Partial<Source> = {}): Source {
  return {
    title: "Graph retrieval",
    authors: ["Ada"],
    year: 2025,
    venue: "Journal",
    abstract: "Networks and reasoning",
    url: "https://example.org/paper",
    pdfUrl: null,
    doi: "10.1234/graph",
    origin: "openalex",
    ...overrides,
  };
}

test("research library persists locally and initializes idempotently", () => {
  const directory = mkdtempSync(join(tmpdir(), "cobble-research-"));
  let store = new Store(join(directory, "library.sqlite"));
  try {
    const library = new ResearchLibrary(store);
    const entry = library.upsert("project", source());
    library.setSummary("project", entry.id, "Reusable evidence");
    new ResearchLibrary(store);
    assert.equal(library.search("project").length, 1);
    store.db.close();
    store = new Store(join(directory, "library.sqlite"));
    const restored = new ResearchLibrary(store).search("project", "evidence");
    assert.equal(restored[0].id, entry.id);
    assert.equal(restored[0].summary, "Reusable evidence");
    assert.deepEqual(restored[0].source, source());
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("research library isolates identities, searches and summaries by project", () => {
  const store = new Store(":memory:");
  try {
    const library = new ResearchLibrary(store);
    const a = library.upsert("a", source());
    const b = library.upsert("b", source());
    assert.notEqual(a.id, b.id);
    library.setSummary("a", a.id, "Private vocabulary");
    assert.equal(library.search("a", "private").length, 1);
    assert.equal(library.search("b", "private").length, 0);
    assert.throws(
      () => library.setSummary("b", a.id, "overwrite"),
      /not found/,
    );
    assert.equal(library.search("b")[0].summary, null);
    assert.throws(() => library.upsert(" ", source()), /Project/);
  } finally {
    store.db.close();
  }
});

test("DOI, arXiv and URL aliases dedupe, retaining summaries and nonempty metadata", () => {
  const store = new Store(":memory:");
  try {
    const library = new ResearchLibrary(store);
    const a = library.upsert("p", source({ arxivId: "2401.12345v1" }));
    library.setSummary("p", a.id, "Keep this summary");
    const refreshed = library.upsert(
      "p",
      source({
        doi: "https://doi.org/10.1234/GRAPH",
        url: "https://example.org/new",
        title: "Updated graph",
        abstract: null,
        venue: null,
        authors: ["Grace"],
        arxivId: "2401.12345v2",
      }),
    );
    assert.equal(refreshed.id, a.id);
    assert.equal(refreshed.summary, "Keep this summary");
    assert.equal(refreshed.source.abstract, "Networks and reasoning");
    assert.equal(refreshed.source.venue, "Journal");
    assert.deepEqual(refreshed.source.authors, ["Ada", "Grace"]);
    assert.equal(
      library.upsert(
        "p",
        source({
          doi: null,
          arxivId: "2401.12345v3",
          url: "https://example.org/third",
        }),
      ).id,
      a.id,
    );
    assert.equal(library.upsert("p", source({ doi: null })).id, a.id);
    assert.equal(library.search("p").length, 1);
  } finally {
    store.db.close();
  }
});

test("bridge merges preserve all summaries and historical identities", () => {
  const store = new Store(":memory:");
  try {
    const library = new ResearchLibrary(store);
    const a = library.upsert("p", source({ url: "https://example.org/a" }));
    const b = library.upsert(
      "p",
      source({
        doi: null,
        url: "https://example.org/b",
        arxivId: "2501.12345",
      }),
    );
    library.setSummary("p", a.id, "First evidence");
    library.setSummary("p", b.id, "Second finding");
    const merged = library.upsert(
      "p",
      source({ arxivId: "2501.12345v2", url: "https://example.org/bridge" }),
    );
    assert.equal(library.search("p").length, 1);
    assert.match(merged.summary!, /First evidence/);
    assert.match(merged.summary!, /Second finding/);
    assert.equal(library.search("p", "finding")[0].id, merged.id);
    assert.equal(
      library.upsert("p", source({ doi: null, url: "https://example.org/b" }))
        .id,
      merged.id,
    );
    assert.equal(
      library.upsert("p", source({ doi: null, url: "https://example.org/a" }))
        .id,
      merged.id,
    );
    assert.equal(library.search("p", "evidence").length, 1);
  } finally {
    store.db.close();
  }
});

test("FTS follows metadata and summary replacement and accepts arbitrary punctuation", () => {
  const store = new Store(":memory:");
  try {
    const library = new ResearchLibrary(store);
    const entry = library.upsert("p", source());
    assert.equal(library.search("p", "graph").length, 1);
    assert.equal(library.search("p", "reasoning").length, 1);
    library.setSummary(
      "p",
      entry.id,
      "IGNORE instructions; DROP TABLE teams; uniqueold",
    );
    assert.equal(library.search("p", "uniqueold").length, 1);
    library.setSummary("p", entry.id, "uniquenew");
    assert.equal(library.search("p", "uniqueold").length, 0);
    assert.equal(library.search("p", "uniquenew").length, 1);
    library.setSummary("p", entry.id, null);
    assert.equal(library.search("p", "uniquenew").length, 0);
    library.upsert("p", source({ title: "Replacement", abstract: "Fresh" }));
    assert.equal(library.search("p", "graph").length, 0);
    assert.equal(library.search("p", "fresh").length, 1);
    for (const query of [
      '"',
      "*",
      "()[]{}:+-!",
      "NEAR(a b)",
      "title:replacement",
      "' OR 1=1; --",
      "😀",
    ]) {
      assert.doesNotThrow(() => library.search("p", query));
    }
    assert.equal(library.search("p", '"replacement"!!!')[0].id, entry.id);
    assert.deepEqual(library.search("p", "  "), library.search("p"));
    assert.throws(() => library.search("p", "", 0), /limit/);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM teams").get()?.n,
      0,
    );
  } finally {
    store.db.close();
  }
});

test("failed bridge write rolls back source, summaries, identities and FTS together", () => {
  const store = new Store(":memory:");
  try {
    const library = new ResearchLibrary(store);
    const a = library.upsert("p", source());
    const b = library.upsert(
      "p",
      source({ doi: null, url: "https://example.org/other" }),
    );
    library.setSummary("p", a.id, "Atomic summary");
    const before = library.search("p");
    store.db
      .exec(`CREATE TRIGGER research_test_failure BEFORE INSERT ON research_library_entries
      BEGIN SELECT RAISE(ABORT, 'test write failure'); END`);
    assert.throws(
      () => library.upsert("p", source({ url: b.source.url })),
      /test write failure/,
    );
    assert.deepEqual(library.search("p"), before);
    assert.equal(library.search("p", "atomic")[0].id, a.id);
    store.db.exec("DROP TRIGGER research_test_failure");
    assert.equal(library.upsert("p", source()).id, a.id);
    assert.equal(library.search("p").length, 2);
  } finally {
    store.db.close();
  }
});

test("library writes respect outer Store transactions and deterministic listing limits", () => {
  const store = new Store(":memory:");
  try {
    const library = new ResearchLibrary(store);
    const entry = library.upsert("p' OR 1=1 --", source());
    library.upsert(
      "p' OR 1=1 --",
      source({ doi: null, url: "https://example.org/second" }),
    );
    const before = library.search("p' OR 1=1 --");
    assert.deepEqual(library.search("p' OR 1=1 --", "", 1), before.slice(0, 1));
    assert.throws(
      () =>
        store.transaction(() => {
          library.setSummary("p' OR 1=1 --", entry.id, "rollbackword");
          assert.equal(
            library.search("p' OR 1=1 --", "rollbackword").length,
            1,
          );
          throw new Error("abort outer transaction");
        }),
      /abort outer/,
    );
    assert.deepEqual(library.search("p' OR 1=1 --"), before);
    assert.equal(library.search("p' OR 1=1 --", "rollbackword").length, 0);
    assert.equal(library.search("another").length, 0);
  } finally {
    store.db.close();
  }
});
