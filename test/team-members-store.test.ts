import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import {
  TEAM_ROLES,
  WRITING_ROLES,
  FULL_ACCESS_ROLES,
} from "../src/core/team/types";

function fixture(file = ":memory:") {
  const store = new Store(file);
  store.saveProfile("Tester", "tester@example.com");
  const team = store.createTeam("Members", "Build it", process.cwd());
  return { store, id: team.id, members: new TeamStore(store) };
}

test("legacy assignments migrate once with backups and full access", () => {
  const { store, id, members } = fixture();
  try {
    store.db
      .prepare("INSERT INTO team_roles VALUES(?,?,?)")
      .run(id, "coder", "codex");
    store.db
      .prepare("INSERT INTO team_roles VALUES(?,?,?)")
      .run(id, "planner", "claude");
    store.set(`teamBackupAgents:${id}`, { coder: "gemini" });
    store.set(`teamFullAccess:${id}`, ["coder"]);
    const migrated = members.members(id);
    assert.deepEqual(
      migrated.map((m) => m.name),
      ["planner1", "coder1"],
    );
    assert.equal(members.member(id, "coder1")?.backup, "gemini");
    assert.equal(members.member(id, "coder1")?.fullAccess, true);
    assert.equal(members.planner(id)?.agent, "claude");
    assert.deepEqual(members.members(id), migrated);
    for (const m of migrated) members.removeMember(id, m.name);
    assert.deepEqual(members.members(id), []);
    assert.deepEqual(new TeamStore(store).roles(id), {});
  } finally {
    store.db.close();
  }
});

test("member validation, derived roles and legacy mutations", () => {
  const { store, id, members } = fixture();
  try {
    assert.ok(TEAM_ROLES.includes("researcher"));
    assert.ok(!WRITING_ROLES.has("researcher"));
    assert.ok(!FULL_ACCESS_ROLES.includes("researcher"));
    for (const name of ["coder", "codex", "t2", "Bad", "a_b", "planner"]) {
      assert.throws(() =>
        members.addMember(id, { name, role: "coder", agent: "codex" }),
      );
    }
    members.setFullAccessRoles(id, ["coder", "researcher", "coder"]);
    members.addMember(id, { name: "zebra", role: "coder", agent: "codex" });
    members.addMember(id, {
      name: "alpha",
      role: "coder",
      agent: "gemini",
      fullAccess: false,
    });
    assert.equal(members.member(id, "zebra")?.fullAccess, true);
    assert.throws(() =>
      members.addMember(id, { name: "zebra", role: "coder", agent: "claude" }),
    );
    assert.deepEqual(members.roles(id), { coder: "codex" });
    members.setRole(id, "coder", "claude");
    assert.equal(members.member(id, "alpha")?.agent, "gemini");
    assert.deepEqual(members.setBackupAgent(id, "coder", "codex"), {
      coder: "codex",
    });
    assert.deepEqual(members.setBackupAgent(id, "coder", null), {});
    assert.deepEqual(members.setBackupAgent(id, "reviewer", "codex"), {});
    assert.deepEqual(members.setFullAccessRoles(id, ["coder", "reviewer"]), [
      "coder",
    ]);
    assert.ok(members.members(id).every((m) => m.fullAccess));
    members.setFullAccessRoles(id, []);
    assert.ok(members.members(id).every((m) => !m.fullAccess));
    members.updateMember(id, "alpha", { backup: "claude" });
    members.removeMember(id, "zebra");
    assert.deepEqual(members.roles(id), { coder: "gemini" });
    assert.deepEqual(members.backupAgents(id), { coder: "claude" });
    members.setRole(id, "coder", null);
    assert.deepEqual(members.members(id), []);
    members.setRole(id, "coder", "codex");
    assert.equal(members.members(id)[0].name, "coder1");
    assert.throws(() =>
      members.addMember(id, {
        name: "reader",
        role: "researcher",
        agent: "codex",
        fullAccess: true,
      }),
    );
  } finally {
    store.db.close();
  }
});

test("CLI members add, list and remove use the service", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobble-members-"));
  const file = join(dir, "data.db");
  const { store } = fixture(file);
  store.db.close();
  const cli = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--data",
        file,
        "team",
        "members",
        ...args,
      ],
      {
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const added = cli(
      "add",
      "coder2",
      "coder",
      "codex",
      "--backup",
      "claude",
      "--full-access",
    );
    assert.deepEqual(added, [
      {
        name: "coder2",
        role: "coder",
        agent: "codex",
        backup: "claude",
        fullAccess: true,
      },
    ]);
    assert.deepEqual(cli(), added);
    assert.deepEqual(cli("list"), added);
    assert.deepEqual(cli("remove", "coder2"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy backup validation happens before database access", () => {
  const store = new Store(":memory:");
  const members = new TeamStore(store);
  store.db.close();
  assert.throws(
    () => members.setBackupAgent("missing", "boss" as never, "codex"),
    /Unknown role/,
  );
  assert.throws(
    () => members.setBackupAgent("missing", "coder", "unknown" as never),
    /Unsupported agent/,
  );
});
