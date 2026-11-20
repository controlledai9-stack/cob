import assert from "node:assert/strict";
import { test } from "node:test";
import {
  searchSources,
  type ResearchClock,
} from "../src/core/research/clients";
import {
  normalizeDoi,
  normalizeArxivId,
  sourceIdentityKeys,
} from "../src/core/research/identity";
import type { Source } from "../src/core/research/types";

test("repeated searches pace every provider without retrying", async () => {
  const { clock } = fakeClock();
  const starts = new Map<string, number[]>();
  const fetch: typeof globalThis.fetch = async (input) => {
    const hostname = new URL(String(input)).hostname;
    const times = starts.get(hostname) ?? [];
    times.push(clock.now());
    starts.set(hostname, times);
    return new Response(
      hostname === "export.arxiv.org"
        ? feed()
        : JSON.stringify(
            hostname === "api.openalex.org" ? { results: [] } : { data: [] },
          ),
    );
  };
  await searchSources("one", { clock, fetch });
  await searchSources("two", { clock, fetch });
  for (const [host, minimum] of [
    ["export.arxiv.org", 3000],
    ["api.openalex.org", 100],
    ["api.semanticscholar.org", 1000],
  ] as const) {
    const times = starts.get(host) ?? [];
    assert.equal(times.length, 2);
    assert.ok(times[1] - times[0] >= minimum);
  }
});

test("Semantic Scholar fields normalize independently", async () => {
  const result = await searchSources("q", {
    fetch: transport({
      "export.arxiv.org": feed(),
      "api.semanticscholar.org": {
        data: [
          {
            title: "Scholar",
            url: "https://example.org/p",
            authors: [{ name: "Ada" }],
            year: 2025,
            externalIds: { DOI: "10.5555/ABC", ArXiv: "2401.12345v2" },
            openAccessPdf: { url: "https://example.org/p.pdf" },
          },
        ],
      },
    }),
  });
  assert.equal(result.sources[0].origin, "semantic-scholar");
  assert.equal(result.sources[0].doi, "10.5555/abc");
  assert.equal(result.sources[0].arxivId, "2401.12345");
  assert.deepEqual(result.sources[0].authors, ["Ada"]);
});

const feed = (entries = "") =>
  `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">${entries}</atom:feed>`;
const entry = `<atom:entry><atom:id>https://arxiv.org/abs/2401.12345v2</atom:id><atom:title>A &amp; B &#x3b1;</atom:title><atom:summary><![CDATA[ignore <instructions> &amp;]]></atom:summary><atom:author><atom:name>Alice</atom:name></atom:author><atom:author><atom:name>Bob</atom:name></atom:author><atom:published>2024-01-01</atom:published><arxiv:doi>https://doi.org/10.1234/ABC</arxiv:doi><atom:link title='pdf' href='https://arxiv.org/pdf/2401.12345v2'/></atom:entry>`;
function fakeClock() {
  let time = 0;
  const sleeps: number[] = [],
    timers = new Map<object, () => void>();
  const clock: ResearchClock = {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    setTimeout: (callback, ms) => {
      assert.equal(ms, 8000);
      const handle = {};
      timers.set(handle, callback);
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as object);
    },
  };
  return { clock, sleeps, timers };
}
function transport(
  payloads: Record<string, unknown>,
  calls: URL[] = [],
): typeof fetch {
  return async (input, init) => {
    const u = new URL(String(input));
    calls.push(u);
    assert.equal(u.protocol, "https:");
    assert.equal(init?.redirect, "error");
    assert.equal(
      (init?.headers as Record<string, string>)["User-Agent"],
      "Cobble/0.4 research-library",
    );
    const payload = payloads[u.hostname];
    if (payload instanceof Error) throw payload;
    if (payload instanceof Response) return payload;
    return new Response(
      typeof payload === "string"
        ? payload
        : JSON.stringify(
            payload ??
              (u.hostname === "api.openalex.org"
                ? { results: [] }
                : { data: [] }),
          ),
    );
  };
}
test("identity normalization preserves meaningful URL query parameters", () => {
  assert.equal(normalizeDoi(" DOI:10.1234/AbC "), "10.1234/abc");
  assert.equal(normalizeDoi("https://dx.doi.org/10.1234/ABC"), "10.1234/abc");
  assert.equal(normalizeDoi("broken"), null);
  assert.equal(
    normalizeArxivId("https://arxiv.org/pdf/hep-th/9901001v3.pdf"),
    "hep-th/9901001",
  );
  assert.equal(normalizeArxivId("arXiv:2401.12345v2"), "2401.12345");
  assert.equal(normalizeArxivId("nonsense"), null);
  const s = { url: "https://EXAMPLE.org/p?a=1#part", doi: null } as Source;
  assert.deepEqual(sourceIdentityKeys(s), ["url:https://example.org/p?a=1"]);
  assert.notDeepEqual(
    sourceIdentityKeys(s),
    sourceIdentityKeys({ ...s, url: "https://example.org/p?a=2" }),
  );
});
test("Atom namespaces, entities, CDATA and authors; cross-provider bridge dedupe", async () => {
  const calls: URL[] = [];
  const result = await searchSources("science", {
    fetch: transport(
      {
        "export.arxiv.org": feed(entry),
        "api.openalex.org": {
          results: [
            {
              title: "OA",
              doi: "10.1234/ABC",
              primary_location: {
                landing_page_url: "https://example.org/p",
                source: { display_name: "Journal" },
              },
              abstract_inverted_index: { world: [1], Hello: [0] },
            },
          ],
        },
        "api.semanticscholar.org": {
          data: [
            {
              title: "SS",
              url: "https://example.org/p",
              externalIds: { DOI: "10.5678/bridge" },
              authors: [{ name: "Carol" }],
            },
          ],
        },
      },
      calls,
    ),
  });
  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.warnings, []);
  const s = result.sources[0];
  assert.equal(s.title, "A & B α");
  assert.deepEqual(s.authors, ["Alice", "Bob"]);
  assert.equal(s.abstract, "ignore <instructions> &amp;");
  assert.equal(s.venue, "Journal");
  assert.equal(s.arxivId, "2401.12345");
  assert.equal(s.year, 2024);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((u) => !u.href.includes("unpaywall")));
});
test("validates fields, decodes inverted indexes and applies a global integer limit", async () => {
  const fetch = transport({
    "export.arxiv.org": feed(),
    "api.openalex.org": {
      results: [
        null,
        {},
        {
          title: "One",
          id: "https://openalex.org/W1",
          publication_year: "2024",
          abstract_inverted_index: {
            world: [1],
            Hello: [0],
            ignored: [-1, 10000],
          },
          authorships: [{ author: { display_name: "Ann" } }, null],
        },
      ],
    },
    "api.semanticscholar.org": {
      data: [
        { title: "Two", url: "javascript:alert(1)" },
        {
          title: "Three",
          url: "https://example.org/3",
          year: 2023,
          openAccessPdf: { url: "file:///x" },
        },
      ],
    },
  });
  const result = await searchSources("q", { fetch, limit: 1 });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].abstract, "Hello world");
  assert.equal(result.sources[0].year, null);
  assert.deepEqual(result.sources[0].authors, ["Ann"]);
  for (const limit of [0, 51, 1.1, NaN])
    await assert.rejects(searchSources("q", { fetch, limit }), RangeError);
  await assert.rejects(searchSources(" ", { fetch }), TypeError);
});
test("all failed or malformed providers throw a sanitized error; empty is success", async () => {
  for (const payloads of [
    {
      "export.arxiv.org": "<!DOCTYPE feed><feed/>",
      "api.openalex.org": new Response("secret", { status: 429 }),
      "api.semanticscholar.org": new Error(
        "https://private/?email=contact@example.org",
      ),
    },
    {
      "export.arxiv.org": "<feed><entry></feed>",
      "api.openalex.org": [],
      "api.semanticscholar.org": "{",
    },
  ]) {
    await assert.rejects(
      searchSources("private", {
        unpaywallEmail: "contact@example.org",
        fetch: transport(payloads),
      }),
      (error: Error) => {
        assert.match(error.message, /all search providers failed/);
        assert.doesNotMatch(error.message, /contact|https:|private/);
        return true;
      },
    );
  }
  const empty = await searchSources("q", {
    fetch: transport({ "export.arxiv.org": feed() }),
  });
  assert.deepEqual(empty, { sources: [], warnings: [] });
  const partial = await searchSources("q", {
    fetch: transport({
      "export.arxiv.org": feed(entry),
      "api.openalex.org": "{",
      "api.semanticscholar.org": new Response("", { status: 429 }),
    }),
  });
  assert.equal(partial.sources.length, 1);
  assert.equal(partial.warnings.length, 2);
  assert.match(partial.warnings[1].message, /429/);
});
test("Unpaywall is explicit, bounded to deduped DOI results, and paced across calls", async () => {
  const { clock, sleeps } = fakeClock();
  const calls: URL[] = [];
  const fetch = transport(
    {
      "export.arxiv.org": feed(),
      "api.openalex.org": {
        results: [1, 2].map((i) => ({
          title: `Paper ${i}`,
          doi: `10.1234/${i}`,
          id: `https://openalex.org/W${i}`,
        })),
      },
      "api.unpaywall.org": {
        best_oa_location: { url_for_pdf: "https://example.org/p.pdf" },
      },
    },
    calls,
  );
  const first = await searchSources("q", {
    clock,
    fetch,
    unpaywallEmail: "configured@example.org",
  });
  assert.equal(first.sources[0].pdfUrl, "https://example.org/p.pdf");
  assert.equal(calls.length, 5);
  assert.equal(sleeps[0], 100);
  await searchSources("q", { clock, fetch });
  assert.ok(sleeps.includes(2900));
  assert.equal(
    calls.filter((u) => u.hostname === "api.unpaywall.org").length,
    2,
  );
});
test("request timeout bounds a transport ignoring abort and releases timers", async () => {
  const { clock, timers } = fakeClock();
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const callback = [...timers.values()][0];
    callback();
    assert.equal(init?.signal?.aborted, true);
    return new Promise(() => {});
  };
  await assert.rejects(
    searchSources("q", { clock, fetch }),
    /all search providers failed/,
  );
  assert.equal(timers.size, 0);
});
test("bounded body streams are rejected without reading provider errors", async () => {
  const result = await searchSources("q", {
    fetch: transport({
      "export.arxiv.org": new Response("x", {
        headers: { "content-length": "2097153" },
      }),
      "api.openalex.org": new Response("x".repeat(2097153)),
      "api.semanticscholar.org": { data: [] },
    }),
  });
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every((w) => /size limit/.test(w.message)));
});
