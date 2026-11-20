import { userMessage } from "../src/core/team/gates";
import type { OrchestratorContext } from "../src/core/team/orchestrator-context";
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { ProjectChat, projectChatPrompt } from "../src/core/team/project-chat";
import {
  createAdapterResearchReader,
  researchRoute,
  recentResearchContext,
} from "../src/core/team/research-chat";
import { createGeminiReader } from "../src/core/research/reader";
import type { Source } from "../src/core/research/report-types";
import type { AdapterRunInput } from "../src/core/team/adapters";

const source: Source = {
  id: "doi:10.1234/test",
  title: "Useful evidence",
  authors: [],
  abstract: "Evidence about caches",
  url: "https://example.org/paper",
  origin: "test",
};

test("research routes deterministically and preserves other mentions", () => {
  const members = [
    { name: "reader2", role: "researcher" as const, agent: "free" as const },
  ];
  assert.equal(
    researchRoute("RESEARCH MODE: caches", members)?.question,
    "caches",
  );
  assert.equal(
    researchRoute("@READER2 caches", members)?.member?.name,
    "reader2",
  );
  assert.equal(researchRoute("@researcher1 caches", [])?.question, "caches");
  assert.equal(researchRoute("@T2 fix the cache", members), undefined);
  assert.equal(researchRoute("research models", members), undefined);
});

test("research persists cited reports, drops unsupported claims, caches reads, and bypasses planner", async () => {
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam(
    "Research",
    "Understand caching",
    process.cwd(),
  );
  const teamStore = new TeamStore(store);
  let reads = 0;
  let plannerCalls = 0;
  const chat = new ProjectChat({
    teamStore,
    team: (id) => store.team(id),
    backlog: async () => "",
    plannerAdapter: () => {
      plannerCalls++;
      return undefined;
    },
    research: {
      search: async () => [source],
      reader: {
        model: "fake-reader",
        summarize: async (s: Source) => {
          reads++;
          return {
            sourceId: s.id,
            findings: ["Cache helps"],
            limitations: [],
            relevance: "Caching",
            readerModel: "fake-reader",
          };
        },
        writeReport: async ({ sources }: { sources: Source[] }) => ({
          findings: [
            { text: "Supported evidence", sourceIds: [sources[0]!.id] },
            { text: "UNCITED", sourceIds: [] },
            { text: "INVALID", sourceIds: ["unknown"] },
          ],
          applications: [],
          openQuestions: [],
        }),
      },
    },
  });
  try {
    const first = await chat.ask(team.id, "research mode: caching");
    assert.equal(first.reply.role, "researcher");
    assert.equal(first.reply.kind, "report");
    assert.equal(first.proposal, undefined);
    assert.match(first.reply.text, /Supported evidence/);
    assert.match(first.reply.text, /\[1\]/);
    assert.match(first.reply.text, /Useful evidence/);
    assert.doesNotMatch(first.reply.text, /UNCITED|INVALID/);
    await chat.ask(team.id, "@researcher1 caching");
    assert.equal(reads, 1);
    assert.equal(plannerCalls, 0);
    const history = chat.messages(team.id);
    assert.equal(history.filter((m) => m.role === "researcher").length, 2);
    assert.match(recentResearchContext(history), /Supported evidence/);
    assert.ok(
      recentResearchContext(
        Array.from({ length: 10 }, () => ({
          ...first.reply,
          text: "x".repeat(20000),
        })),
      ).length < 12200,
    );
    assert.match(
      projectChatPrompt(
        {
          team,
          history,
          answers: [],
          sessionBrief: null,
          runs: [],
          digest: "",
          backlog: [],
        },
        "next",
      ),
      /Supported evidence/,
    );
  } finally {
    store.close();
  }
});

test("configured adapter reader runs read-only and never interprets actions", async () => {
  const calls: AdapterRunInput[] = [];
  const reader = createAdapterResearchReader(
    {
      id: "free",
      detect: async () => ({ agent: "free", installed: true }),
      run: async (input) => {
        calls.push(input);
        return {
          exitCode: 0,
          durationMs: 1,
          finalText: JSON.stringify({
            findings: ["Evidence"],
            limitations: [],
            relevance: "Relevant",
          }),
        };
      },
    },
    process.cwd(),
    "local-model",
  );
  const summary = await reader.summarize(source);
  assert.equal(summary.sourceId, source.id);
  assert.equal(calls[0].tools, false);
  assert.equal(calls[0].readOnly, true);
  assert.equal(calls[0].network, false);
  assert.equal(calls[0].fullAccess, false);
  assert.equal(calls[0].model, "local-model");
  assert.match(calls[0].prompt, /Use no tools or shell/);
});

test("native Gemini uses generateContent and header credentials with fake transport", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const reader = createGeminiReader({
    apiKey: "fake-test-key",
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      findings: ["Evidence"],
                      limitations: [],
                      relevance: "Relevant",
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  await reader.summarize(source);
  assert.match(calls[0].url, /:generateContent/);
  assert.doesNotMatch(calls[0].url, /fake-test-key/);
  assert.equal(
    new Headers(calls[0].init?.headers).get("x-goog-api-key"),
    "fake-test-key",
  );
  const body = JSON.parse(String(calls[0].init?.body));
  assert.ok(Array.isArray(body.contents));
  assert.ok(body.contents[0].parts.length > 0);
  assert.equal(body.tools, undefined);
});

test("run chat research switch does not schedule or invoke planner", async () => {
  const messages: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const run = {
    id: "run",
    teamId: "project",
    workspace: process.cwd(),
    state: "running",
    goal: "Cache research",
  };
  const ctx = {
    require: () => run,
    store: {
      members: () => [],
      chat: (m: unknown) => {
        messages.push(m);
        return m;
      },
    },
    options: {},
    adapters: {},
    emit: () => true,
    changed: () => {},
    track: (_id: string, p: Promise<unknown>) => {
      pending.push(p);
      return p;
    },
    say: (_run: unknown, m: unknown) => {
      messages.push(m);
    },
    schedule: () => {
      assert.fail("research must not wake planner");
    },
  } as unknown as OrchestratorContext;
  userMessage(ctx, "run", "RESEARCH MODE");
  await Promise.all(pending);
  assert.equal(messages.length, 2);
  assert.match(JSON.stringify(messages[1]), /researcher/);
});
