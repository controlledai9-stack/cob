import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import type { AgentAdapter } from "../src/core/team/adapters";
import type { ReviewPolicy } from "../src/core/team/review-policy";

const actions = (actions: object[]) =>
  "```cobble-actions\n" + JSON.stringify({ actions }) + "\n```";

async function scenario(
  policy: ReviewPolicy,
  path: string,
  explicit = false,
  options: { noReviewer?: boolean; taskId?: string; collide?: boolean } = {},
) {
  const taskId = options.taskId ?? "T1";
  const collisionId = `${taskId.slice(0, 25)}-review`;
  const root = mkdtempSync(join(tmpdir(), "cobble-review-policy-"));
  const work = join(root, "work");
  mkdirSync(work);
  writeFileSync(join(work, "README.md"), "initial\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam(
    "T",
    "Implement the requested files in this project",
    work,
  );
  const ts = new TeamStore(store);
  ts.setRole(team.id, "planner", "claude");
  ts.setRole(team.id, "coder", "codex");
  if (!options.noReviewer) ts.setRole(team.id, "reviewer", "gemini");
  ts.setReviewPolicy(team.id, policy);
  let plannerTurns = 0;
  let reviews = 0;
  const planner: AgentAdapter = {
    id: "claude",
    detect: async () => ({ agent: "claude", installed: true }),
    async run() {
      const delegated = [
        {
          type: "delegate",
          id: taskId,
          role: "coder",
          title: "Change",
          instructions: `Update ${path}`,
        },
        ...(options.collide
          ? [
              {
                type: "delegate",
                id: collisionId,
                role: "reviewer",
                dependsOn: [taskId],
                title: "Existing unrelated task",
                instructions: "Keep this task intact",
              },
            ]
          : []),
        ...(explicit
          ? [
              {
                type: "delegate",
                id: "explicit-review",
                role: "reviewer",
                reviews: taskId,
                dependsOn: [taskId],
                title: "Review",
                instructions: "Review T1",
              },
            ]
          : []),
      ];
      return {
        exitCode: 0,
        durationMs: 1,
        finalText: actions(
          ++plannerTurns === 1
            ? delegated
            : [{ type: "finish", summary: "ok" }],
        ),
      };
    },
  };
  const coder: AgentAdapter = {
    id: "codex",
    detect: async () => ({ agent: "codex", installed: true }),
    async run(input) {
      mkdirSync(dirname(join(input.cwd, path)), { recursive: true });
      writeFileSync(join(input.cwd, path), "small change\n");
      mkdirSync(join(input.cwd, ".cobble-task"), { recursive: true });
      writeFileSync(
        join(input.cwd, ".cobble-task/report.json"),
        JSON.stringify({ status: "done", summary: "updated", files: [path] }),
      );
      // Keep the completion state observable before the next planner turn
      // consumes pending notes or starts either of the queued review tasks.
      if (options.noReviewer || options.collide)
        orchestrator.pause(input.task!.runId);
      return { exitCode: 0, durationMs: 1, finalText: "done" };
    },
  };
  const reviewer: AgentAdapter = {
    id: "gemini",
    detect: async () => ({ agent: "gemini", installed: true }),
    async run() {
      reviews++;
      return {
        exitCode: 0,
        durationMs: 1,
        finalText:
          '```cobble-report\n{"status":"done","summary":"approve","verdict":"approve"}\n```',
      };
    },
  };
  const orchestrator = new TeamOrchestrator({
    teamStore: ts,
    adapters: { claude: planner, codex: coder, gemini: reviewer },
    worktreeRoot: join(root, "trees"),
    team: (id) => store.team(id),
  });
  try {
    const run = await orchestrator.startRun(
      team.id,
      "Update the requested file",
      {},
      {},
      { checkCommand: 'node -e ""' },
    );
    await orchestrator.idle(run.id);
    const snapshot = orchestrator.snapshot(run.id)!;
    assert.equal(
      snapshot.tasks.find((t) => t.id === taskId)?.state,
      "done",
      JSON.stringify(snapshot.events),
    );
    assert.equal(
      snapshot.tasks.find((t) => t.id === taskId)?.check?.passed,
      true,
    );
    return { snapshot, reviews, chat: ts.chatMessages(run.id) };
  } finally {
    await orchestrator.close();
    store.db.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows locks */
    }
  }
}

test("risky accepts a small safe change without a reviewer turn", async () => {
  const { snapshot, reviews, chat } = await scenario("risky", "author.ts");
  assert.equal(reviews, 0);
  assert.match(snapshot.tasks[0].reviewSkipped!, /policy risky:.*check passed/);
  assert.equal(snapshot.tasks[0].autoReview, undefined);
  assert.ok(
    chat.some(
      (m) =>
        m.author === "cobble" && m.text.includes("accepted without an LLM review"),
    ),
  );
});

test("risky reviews dependency manifest changes", async () => {
  const { snapshot, reviews } = await scenario("risky", "package.json");
  assert.equal(reviews, 1);
  assert.equal(snapshot.tasks[0].autoReview, "T1-review");
});

test("risky reviews deploy file changes", async () => {
  const { reviews } = await scenario("risky", "Dockerfile");
  assert.equal(reviews, 1);
});

test("always reviews a small safe change", async () => {
  const { snapshot, reviews } = await scenario("always", "author.ts");
  assert.equal(reviews, 1);
  assert.equal(snapshot.tasks[0].autoReview, "T1-review");
});

test("an explicit explicit review prevents a duplicate", async () => {
  const { snapshot, reviews } = await scenario("always", "author.ts", true);
  assert.equal(reviews, 1);
  assert.equal(snapshot.tasks.filter((t) => t.reviews === "T1").length, 1);
  assert.equal(snapshot.tasks[0].reviewSkipped, undefined);
  assert.equal(snapshot.tasks[0].autoReview, undefined);
});

test("review policy settings default, normalize, persist and reject invalid values", () => {
  const store = new Store(":memory:");
  const ts = new TeamStore(store);
  try {
    assert.equal(ts.reviewPolicy("a"), "risky");
    assert.equal(ts.setReviewPolicy("a", " ALWAYS "), "always");
    assert.equal(new TeamStore(store).reviewPolicy("a"), "always");
    assert.equal(ts.reviewPolicy("b"), "risky");
    assert.throws(
      () => ts.setReviewPolicy("a", "sometimes"),
      /Review policy must/,
    );
    store.set("teamReviewPolicy:a", "broken");
    assert.equal(ts.reviewPolicy("a"), "risky");
  } finally {
    store.db.close();
  }
});

test("risky change without a reviewer preserves completion and wakes the planner", async () => {
  const { snapshot, reviews } = await scenario("risky", "package.json", false, {
    noReviewer: true,
  });
  assert.equal(reviews, 0);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].state, "done");
  assert.equal(snapshot.tasks[0].autoReview, undefined);
  assert.equal(snapshot.tasks.filter((t) => t.role === "reviewer").length, 0);
  assert.ok(
    snapshot.run.pendingNotes.some(
      (note) =>
        note.startsWith("T1 should be reviewed (touches sensitive paths: package.json)") &&
        note.includes("the team has no reviewer"),
    ),
    JSON.stringify(snapshot.run.pendingNotes),
  );
  assert.equal(snapshot.run.wakeRequested, true);
});

test("long writing task ids get a bounded unique review id on collision", async () => {
  const taskId = "coding-task-with-a-long-id-1234";
  const collisionId = `${taskId.slice(0, 25)}-review`;
  const { snapshot } = await scenario("always", "author.ts", false, {
    taskId,
    collide: true,
  });
  const coding = snapshot.tasks.find((t) => t.id === taskId)!;
  const review = snapshot.tasks.find((t) => t.reviews === taskId)!;
  assert.equal(coding.state, "done");
  assert.equal(coding.autoReview, review.id);
  assert.equal(review.id, `${taskId.slice(0, 23)}-review-2`);
  assert.ok(review.id.length <= 32);
  assert.equal(review.role, "reviewer");
  assert.equal(snapshot.tasks.length, 3);
  const existing = snapshot.tasks.find((t) => t.id === collisionId)!;
  assert.equal(existing.title, "Existing unrelated task");
  assert.equal(existing.instructions, "Keep this task intact");
  assert.deepEqual(existing.dependsOn, [taskId]);
  assert.equal(existing.reviews, undefined);
  assert.equal(existing.state, "queued");
});

test("never skips review even for a dependency manifest", async () => {
  const { snapshot, reviews } = await scenario("never", "package.json");
  assert.equal(reviews, 0);
  assert.equal(snapshot.tasks[0].reviewSkipped, "policy never");
});

test("risky rules: size, check result and sensitive paths", async () => {
  const { decideReview } = await import("../src/core/team/review-policy");
  const small = { policy: "risky" as const, checkPassed: true, changedLines: 20, paths: ["src/a.ts"] };
  assert.equal(decideReview(small).review, false);
  assert.equal(decideReview({ ...small, changedLines: 150 }).review, true);
  assert.equal(decideReview({ ...small, checkPassed: false }).review, true);
  assert.equal(decideReview({ ...small, checkPassed: undefined }).review, true);
  for (const path of ["package.json", "Dockerfile", ".github/workflows/ci.yml", "db/migrations/1.sql", "src/auth/login.ts", ".env.local", "vercel.json"])
    assert.equal(decideReview({ ...small, paths: [path] }).review, true, path);
});
