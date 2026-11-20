import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { CobbleService } from "../src/core/service";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import type { AgentAdapter, AdapterRunInput } from "../src/core/team/adapters";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 15000,
  }).trim();
const block = (kind: string, body: object) =>
  "```" + kind + "\n" + JSON.stringify(body) + "\n```";
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          30000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function report(cwd: string, body: object) {
  mkdirSync(join(cwd, ".cobble-task"), { recursive: true });
  writeFileSync(join(cwd, ".cobble-task/report.json"), JSON.stringify(body));
}

test(
  "persisted brief -> CLI pilot -> worker chat -> phone gate -> completed backlog",
  { timeout: 120000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cobble-demo-"));
    const work = join(root, "work");
    const database = join(root, "demo.sqlite");
    const item =
      "Build demo artifact - done when: demo.txt contains jade-orbit";
    const answer = "jade-orbit";
    const questionReady = barrier(),
      chatSent = barrier(),
      phoneReady = barrier(),
      phoneApplied = barrier();
    let service: CobbleService | undefined;
    let command: Promise<void> | undefined;
    const existingInterrupts = new Set(process.listeners("SIGINT"));
    let teamId = "",
      runId = "",
      delegated = false,
      askedPhone = false,
      workerReceived = false;
    let workerCalls = 0,
      pilotCalls = 0;
    const posts: { body: string; headers: Record<string, string> }[] = [];
    const replies: string[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        const post = {
          body: String(init.body),
          headers: init.headers as Record<string, string>,
        };
        posts.push(post);
        if (post.headers.Actions?.includes("body=cobble1 skip"))
          phoneReady.release();
        return new Response("{}");
      }
      return new Response(replies.splice(0).join("\n"));
    }) as typeof fetch;
    const adapter = (
      id: "claude" | "codex",
      script: (input: AdapterRunInput) => Promise<string>,
    ): AgentAdapter => ({
      id,
      detect: async () => ({ agent: id, installed: true }),
      run: async (input) => ({
        exitCode: 0,
        durationMs: 1,
        finalText: await script(input),
      }),
    });
    const planner = adapter("claude", async (input) => {
      if (input.prompt.includes("Minutes left:")) {
        assert.equal(input.network, false);
        assert.match(input.prompt, /demo-priority-marker/);
        pilotCalls++;
        return block(
          "cobble-pilot",
          pilotCalls === 1
            ? {
                items: [
                  {
                    item,
                    role: "coder",
                    minutes: 1,
                    label: "Build demo artifact",
                  },
                ],
              }
            : { done: true },
        );
      }
      const actions = (actions: object[]) =>
        block("cobble-actions", { actions });
      if (!delegated) {
        delegated = true;
        assert.match(input.prompt, /Build demo artifact/);
        return actions([
          {
            type: "delegate",
            id: "T1",
            role: "coder",
            title: "Build demo artifact",
            instructions: "Write demo.txt after asking which marker to use.",
          },
        ]);
      }
      const run = service!.teamStore.runs(teamId)[0];
      runId = run.id;
      const task = service!.teamStore.tasks(runId).find((t) => t.id === "T1");
      if (task?.state === "needs_decision") {
        questionReady.release();
        await bounded(chatSent.promise, "chat sent");
      }
      if (
        service!.teamStore.tasks(runId).find((t) => t.id === "T1")?.state !==
        "done"
      )
        return actions([
          { type: "wait", reason: "Worker is completing artifact" },
        ]);
      if (!askedPhone) {
        askedPhone = true;
        return actions([
          {
            type: "ask_human",
            kind: "clarify",
            message: "Choose the harmless demo finishing detail",
          },
        ]);
      }
      await bounded(phoneApplied.promise, "phone applied");
      return actions([{ type: "finish", summary: "Demo artifact completed" }]);
    });
    const worker = adapter("codex", async (input) => {
      workerCalls++;
      if (workerCalls === 1)
        report(input.cwd, {
          status: "needs_decision",
          summary: "Need marker",
          question: "Which demo marker?",
          options: [answer, "other"],
        });
      else {
        assert.match(
          input.prompt,
          /The user answered your question .*jade-orbit/,
        );
        workerReceived = true;
        writeFileSync(join(input.cwd, "demo.txt"), answer + "\n");
        report(input.cwd, {
          status: "done",
          summary: "Created demo artifact",
          files: ["demo.txt"],
        });
      }
      return "";
    });
    try {
      mkdirSync(work);
      git(work, "init", "-q", "-b", "main");
      git(work, "config", "user.name", "Demo");
      git(work, "config", "user.email", "demo@example.invalid");
      writeFileSync(
        join(work, "BACKLOG.md"),
        `- [ ] Unselected fixture item\n- [ ] ${item}\n`,
      );
      git(work, "add", ".");
      git(work, "commit", "-qm", "fixture");
      const original = git(work, "rev-parse", "HEAD");
      const seed = new Store(database);
      try {
        seed.saveProfile("Demo", "");
        teamId = seed.createTeam(
          "Demo",
          "Build a local artifact only. Never promote main.",
          work,
        ).id;
        const teams = new TeamStore(seed);
        teams.setRole(teamId, "planner", "claude");
        teams.setRole(teamId, "coder", "codex");
        const now = new Date().toISOString();
        teams.setSessionBrief(teamId, {
          days: 1,
          agents: ["claude", "codex"],
          priority: "demo-priority-marker",
          createdAt: now,
          updatedAt: now,
        });
      } finally {
        seed.close();
      }
      command = main(
        ["team", "pilot", "--backlog", "BACKLOG.md", "--data", database],
        undefined,
        {
          createService: (data) => {
            assert.equal(data, database);
            service = new CobbleService(data, undefined, {
              teamAdapters: { claude: planner, codex: worker },
              fetch: fakeFetch,
              teamWorktreeRoot: join(root, "trees"),
            });
            service.phone.update({ enabled: true });
            return service;
          },
        },
      );
      // Observe failures immediately while the scenario waits at its barriers.
      const wait = (promise: Promise<void>, label: string) =>
        bounded(
          Promise.race([
            promise,
            command!.then(() => {
              throw new Error(`CLI ended before ${label}`);
            }),
          ]),
          label,
        );
      await wait(questionReady.promise, "worker question");
      assert.equal(service!.teamStore.tasks(runId)[0].state, "needs_decision");
      await service!.sendTeamChat(runId, `@T1 ${answer}`);
      chatSent.release();
      await wait(phoneReady.promise, "phone notification");
      assert.equal(workerReceived, true);
      assert.equal(service!.teamStore.run(runId)!.gate?.kind, "clarify");
      const code = posts
        .find((p) => p.headers.Actions?.includes("body=cobble1 skip"))!
        .headers.Actions.match(/body=cobble1 skip ([\w-]+)/)![1];
      const reply = JSON.stringify({
        id: "demo-reply-1",
        time: Math.floor(Date.now() / 1000),
        event: "message",
        topic: "demo-reply",
        message: `cobble1 skip ${code}`,
      });
      replies.push(reply);
      assert.equal(await service!.checkPhoneReplies(), 1);
      assert.equal(service!.teamStore.run(runId)!.gate, undefined);
      assert.ok(posts.some((p) => p.body.includes("The planner will decide")));
      replies.push(reply);
      assert.equal(await service!.checkPhoneReplies(), 0);
      phoneApplied.release();
      await bounded(command, "pilot completion");
      const reopened = new Store(database);
      try {
        const teams = new TeamStore(reopened);
        assert.equal(
          teams.sessionBrief(teamId)!.priority,
          "demo-priority-marker",
        );
        assert.equal(teams.run(runId)!.state, "done");
        assert.equal(teams.tasks(runId)[0].state, "done");
        assert.equal(teams.run(runId)!.gate, undefined);
        assert.ok(
          teams
            .chatMessages(runId)
            .some((m) => m.to === "T1" && m.text.includes(answer)),
        );
      } finally {
        reopened.close();
      }
      const backlog = git(work, "show", "cobble/autopilot:BACKLOG.md");
      assert.ok(backlog.includes(`- [x] ${item}`), backlog);
      assert.match(backlog, /- \[ \] Unselected fixture item/);
      assert.equal(git(work, "rev-parse", "main"), original);
      assert.equal(
        readFileSync(join(work, "BACKLOG.md"), "utf8"),
        `- [ ] Unselected fixture item\n- [ ] ${item}\n`,
      );
      assert.equal(workerCalls, 2);
      assert.equal(pilotCalls, 2);
    } finally {
      chatSent.release();
      phoneApplied.release();
      // Invoke only this CLI's shutdown handler so a failed assertion also
      // releases the production pilot wait before its database closes.
      for (const listener of process.listeners("SIGINT"))
        if (!existingInterrupts.has(listener)) listener("SIGINT");
      try {
        if (command)
          await bounded(
            command.catch(() => {}),
            "CLI cleanup",
          );
      } finally {
        await service?.close();
        rmSync(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    }
  },
);
