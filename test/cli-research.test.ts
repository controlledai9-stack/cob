import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { Store } from "../src/core/store";
import { ResearchLibrary } from "../src/core/research/library";
import type { Source } from "../src/core/research/types";

test("actual CLI routing validates, selects projects, persists search and queries offline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-research-"));
  const data = join(dir, "research.sqlite");
  const plan = join(dir, "plan.md");
  writeFileSync(plan, "Research sources");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Unexpected network access");
  };
  try {
    const base = ["--data", data, "team", "research"];
    let calls = 0;
    const output: string[] = [],
      warnings: string[] = [];
    const source: Source = {
      title: "Graph retrieval",
      abstract: "Network evidence",
      authors: ["Ada"],
      year: 2025,
      venue: null,
      url: "https://example.org/p",
      pdfUrl: null,
      doi: "10.1234/p",
      origin: "openalex",
    };
    const deps = {
      search: async (
        query: string,
        options?: { limit?: number; unpaywallEmail?: string },
      ) => {
        calls++;
        assert.equal(query, "graphs");
        assert.equal(options?.limit, 2);
        return {
          sources: [source],
          warnings: [{ provider: "arxiv", message: "Rate limited" }],
        };
      },
      print: (text: string) => output.push(text),
      warn: (text: string) => warnings.push(text),
    };
    await assert.rejects(
      main([...base, "search", "graphs", "--limit", "2"], deps),
      /project/,
    );
    for (const name of ["Alpha", "Beta"])
      await main([
        "--data",
        data,
        "init",
        "--name",
        name,
        "--display-name",
        "Tester",
        "--plan-file",
        plan,
        "--workspace",
        dir,
      ]);
    for (const args of [
      [],
      ["oops"],
      ["search"],
      ["search", " "],
      ["search", "a", "b"],
      ["library", "a", "b"],
      ["library", "--limit", "2"],
      ...["0", "51", "1.2", "NaN", "", "-1"].map((limit) => [
        "search",
        "graphs",
        `--limit=${limit}`,
      ]),
      ["search", "graphs", "--smoke"],
      ["search", "graphs", "--unknown"],
    ])
      await assert.rejects(main([...base, ...args], deps));
    await assert.rejects(
      main([...base, "search", "graphs", "--project", "missing"], deps),
      /Unknown project/,
    );
    assert.equal(calls, 0);
    await main(
      [
        ...base,
        "search",
        "graphs",
        "--limit",
        "2",
        "--project",
        "alpha",
        "--json",
      ],
      deps,
    );
    assert.deepEqual(JSON.parse(output.pop()!), [source]);
    assert.deepEqual(warnings, ["arxiv: Rate limited"]);
    const store = new Store(data);
    try {
      const alpha = store.teams().find((team) => team.name === "Alpha")!;
      const library = new ResearchLibrary(store);
      const entry = library.search(alpha.id)[0];
      library.setSummary(alpha.id, entry.id, "Reusable synthesis");
    } finally {
      store.db.close();
    }
    for (const query of ["Graph", "evidence", "synthesis", ""]) {
      await main(
        [
          ...base,
          "library",
          ...(query ? [query] : []),
          "--project",
          "Alpha",
          "--json",
        ],
        deps,
      );
      assert.equal(JSON.parse(output.pop()!).length, 1);
    }
    await main([...base, "library", "--project", "Beta", "--json"], deps);
    assert.deepEqual(JSON.parse(output.pop()!), []);
    await main([...base, "library", "--json"], deps);
    assert.deepEqual(JSON.parse(output.pop()!), []);
    await assert.rejects(
      main(
        ["--data", join(dir, "other.sqlite"), "team", "research", "library"],
        deps,
      ),
      /project/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
