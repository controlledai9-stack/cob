import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("team limits validates options and persists budgets and threshold", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobble-cli-limits-"));
  const data = join(dir, "limits.db");
  function cli(...args: string[]) {
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--data",
        data,
        "team",
        "limits",
        ...args,
      ],
      {
        cwd: resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );
    assert.ifError(r.error);
    return r;
  }
  try {
    for (const args of [
      ["codex", "--budget", "999", "--window", "5"],
      ["codex", "--budget", "1000", "--window", "169"],
      ["--stop-at", "49"],
      ["--stop-at", "95.5"],
      ["--stop-at", "-1"],
      ["codex", "--budget", "1000"],
      ["--clear"],
      ["codex", "--clear", "--budget", "1000", "--window", "5"],
      ["unknown"],
    ]) {
      const r = cli(...args);
      assert.equal(r.status, 1, r.stdout);
      if (args[0] === "unknown")
        assert.match(
          r.stderr,
          /Unsupported agent\. Valid agents: claude, codex, gemini, claude-api, free, teammate/,
        );
      assert.equal(existsSync(data), false);
    }
    let r = cli(
      "codex",
      "--budget",
      "1000",
      "--window",
      "5",
      "--stop-at",
      "90",
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Stop at: 90%/);
    assert.match(r.stdout, /estimated/);
    assert.match(r.stdout, /0%/);
    r = cli("codex");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Stop at: 90%/);
    r = cli("codex", "--clear");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes("'0%'"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
