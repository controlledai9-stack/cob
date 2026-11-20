import { randomUUID } from "node:crypto";
import type { Store } from "../store";
import type { LibraryEntry, Source } from "./types";
import { sourceIdentityKeys } from "./identity";

type Row = { data: string };

/** Local persistence only: source text and summaries are inert, untrusted data. */
export class ResearchLibrary {
  constructor(private readonly store: Store) {
    store.transaction(() => {
      store.db.exec(`
        CREATE TABLE IF NOT EXISTS research_library_entries(
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL,
          UNIQUE(project_id,id));
        CREATE INDEX IF NOT EXISTS research_library_project ON research_library_entries(project_id);
        CREATE TABLE IF NOT EXISTS research_library_identities(
          project_id TEXT NOT NULL, identity TEXT NOT NULL, entry_id TEXT NOT NULL,
          PRIMARY KEY(project_id,identity),
          FOREIGN KEY(project_id,entry_id) REFERENCES research_library_entries(project_id,id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS research_library_identity_entry ON research_library_identities(project_id,entry_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS research_library_fts USING fts5(
          project_id UNINDEXED, entry_id UNINDEXED, title, abstract, summary);
      `);
    });
  }

  upsert(projectId: string, source: Source): LibraryEntry {
    this.checkProject(projectId);
    return this.store.transaction(() => {
      const keys = new Set(sourceIdentityKeys(source));
      const ids = new Set<string>();
      for (const key of keys) {
        const match = this.store.db
          .prepare(
            "SELECT entry_id FROM research_library_identities WHERE project_id=? AND identity=?",
          )
          .get(projectId, key) as { entry_id: string } | undefined;
        if (match) ids.add(match.entry_id);
      }
      const existing = this.search(projectId).filter((entry) =>
        ids.has(entry.id),
      );
      const now = new Date().toISOString();
      let merged = existing[0]?.source ?? source;
      for (const entry of existing.slice(1))
        merged = mergeSource(merged, entry.source);
      merged = mergeSource(merged, source);
      const summaries = [
        ...new Set(
          existing
            .map((entry) => entry.summary)
            .filter(
              (summary): summary is string =>
                summary !== null && summary.length > 0,
            ),
        ),
      ];
      const entry: LibraryEntry = {
        id: existing[0]?.id ?? randomUUID(),
        projectId,
        source: merged,
        summary: summaries.length
          ? summaries.join("\n\n")
          : (existing[0]?.summary ?? null),
        createdAt: existing[0]?.createdAt ?? now,
        updatedAt: now,
      };
      // Preserve every historical alias, even when refreshed metadata changes URLs.
      for (const old of existing) {
        const aliases = this.store.db
          .prepare(
            "SELECT identity FROM research_library_identities WHERE project_id=? AND entry_id=?",
          )
          .all(projectId, old.id) as { identity: string }[];
        for (const alias of aliases) keys.add(alias.identity);
        this.store.db
          .prepare(
            "DELETE FROM research_library_fts WHERE project_id=? AND entry_id=?",
          )
          .run(projectId, old.id);
        this.store.db
          .prepare(
            "DELETE FROM research_library_entries WHERE project_id=? AND id=?",
          )
          .run(projectId, old.id);
      }
      this.store.db
        .prepare(
          "INSERT INTO research_library_entries(id,project_id,data) VALUES(?,?,?)",
        )
        .run(entry.id, projectId, JSON.stringify(entry));
      for (const key of sourceIdentityKeys(merged)) keys.add(key);
      for (const key of keys)
        this.store.db
          .prepare(
            "INSERT INTO research_library_identities(project_id,identity,entry_id) VALUES(?,?,?)",
          )
          .run(projectId, key, entry.id);
      this.index(entry);
      return entry;
    });
  }

  setSummary(
    projectId: string,
    id: string,
    summary: string | null,
  ): LibraryEntry {
    this.checkProject(projectId);
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare(
          "SELECT data FROM research_library_entries WHERE project_id=? AND id=?",
        )
        .get(projectId, id) as Row | undefined;
      if (!row) throw new Error("Research library entry not found");
      const entry = JSON.parse(row.data) as LibraryEntry;
      entry.summary = summary;
      entry.updatedAt = new Date().toISOString();
      this.store.db
        .prepare(
          "UPDATE research_library_entries SET data=? WHERE project_id=? AND id=?",
        )
        .run(JSON.stringify(entry), projectId, id);
      this.store.db
        .prepare(
          "DELETE FROM research_library_fts WHERE project_id=? AND entry_id=?",
        )
        .run(projectId, id);
      this.index(entry);
      return entry;
    });
  }

  search(projectId: string, query = "", limit?: number): LibraryEntry[] {
    this.checkProject(projectId);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new Error("Library limit must be a positive integer");
    let rows: Row[];
    if (!query.trim()) {
      rows = this.store.db
        .prepare(
          "SELECT data FROM research_library_entries WHERE project_id=? ORDER BY json_extract(data,'$.createdAt'),id LIMIT ?",
        )
        .all(projectId, limit ?? -1) as Row[];
    } else {
      // Only quoted literal tokens reach MATCH; punctuation can never become FTS syntax.
      const tokens = query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
      if (!tokens.length) return [];
      const match = tokens.map((token) => `"${token}"`).join(" AND ");
      rows = this.store.db
        .prepare(
          `SELECT e.data FROM research_library_fts
        JOIN research_library_entries e ON e.id=research_library_fts.entry_id AND e.project_id=research_library_fts.project_id
        WHERE research_library_fts MATCH ? AND e.project_id=?
        ORDER BY rank, json_extract(e.data,'$.createdAt'),e.id LIMIT ?`,
        )
        .all(match, projectId, limit ?? -1) as Row[];
    }
    return rows.map((row) => JSON.parse(row.data) as LibraryEntry);
  }

  private index(entry: LibraryEntry): void {
    this.store.db
      .prepare(
        "INSERT INTO research_library_fts(project_id,entry_id,title,abstract,summary) VALUES(?,?,?,?,?)",
      )
      .run(
        entry.projectId,
        entry.id,
        entry.source.title,
        entry.source.abstract,
        entry.summary,
      );
  }

  private checkProject(projectId: string): void {
    if (!projectId.trim()) throw new Error("Project id is required");
  }
}

// Later nonempty scalar metadata wins; authors retain all observed names in order.
function mergeSource(previous: Source, incoming: Source): Source {
  const result = { ...previous };
  for (const key of Object.keys(incoming) as (keyof Source)[]) {
    const value = incoming[key];
    if (
      value !== null &&
      value !== undefined &&
      (typeof value !== "string" || value.trim())
    ) {
      Object.assign(result, { [key]: value });
    }
  }
  result.authors = [
    ...new Set(
      [...previous.authors, ...incoming.authors].filter((author) =>
        author.trim(),
      ),
    ),
  ];
  return result;
}
