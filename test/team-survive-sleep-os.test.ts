import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { watchdogCommand } from "../src/core/team/daemon-launch.js";
import { KeepAwake, keepAwakeCommand } from "../src/core/team/keep-awake.js";
import {
  applyWatchdogPlan,
  hasSystemdUser,
  installPlan,
  uninstallPlan,
  watchdogName,
  type WatchdogDeps,
} from "../src/core/team/watchdog.js";

const target = {
  data: path.resolve("data with spaces"),
  command: "C:\\Program Files\\node.exe",
  args: ["a b", 'a"b', "<&", "tail\\"],
  home: "/home/test user",
  uid: 123,
  user: "DOMAIN\\A&B",
  startBoundary: "2026-01-01T00:00:00",
};
function fake() {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const writes: { path: string; content: string | Buffer }[] = [];
  const removed: string[] = [];
  const dirs: string[] = [];
  const deps: WatchdogDeps = {
    exec: async (cmd, args, input) => {
      calls.push({ cmd, args, input });
      return { code: 0, stdout: "", stderr: "" };
    },
    writeFile: (path, content) => {
      writes.push({ path, content });
    },
    removeFile: (p) => {
      removed.push(p);
    },
    mkdir: (p) => {
      dirs.push(p);
    },
  };
  return { deps, calls, writes, removed, dirs };
}
test("watchdog name hashes the resolved data path and CLI command uses ensure", () => {
  const name = watchdogName("linux", target.data);
  assert.ok(
    name.endsWith(
      createHash("sha1")
        .update(path.resolve(target.data))
        .digest("hex")
        .slice(0, 8),
    ),
  );
  assert.deepEqual(
    watchdogCommand("relative data", {
      execPath: "node",
      execArgv: ["--import", "tsx"],
      script: "cli.ts",
      env: { UNUSED: "x" },
    }),
    {
      command: "node",
      args: [
        "--import",
        "tsx",
        "cli.ts",
        "team",
        "daemon",
        "ensure",
        "--data",
        path.resolve("relative data"),
      ],
    },
  );
});
test("Windows watchdog escapes XML, quotes arguments and writes a UTF16 BOM", async () => {
  const plan = installPlan("win32", target);
  const content = plan.files[0].content;
  for (const text of [
    "<LogonTrigger>",
    "<UserId>DOMAIN\\A&amp;B</UserId>",
    "Microsoft-Windows-Power-Troubleshooter",
    "EventID=1",
    "<Delay>PT1M</Delay>",
    "<Interval>PT10M</Interval>",
    "<StartBoundary>2026-01-01T00:00:00</StartBoundary>",
    "<LogonType>InteractiveToken</LogonType>",
    "<RunLevel>LeastPrivilege</RunLevel>",
    "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "<StartWhenAvailable>true</StartWhenAvailable>",
    "<ExecutionTimeLimit>PT5M</ExecutionTimeLimit>",
    "<Command>conhost.exe</Command>",
    "&quot;C:\\Program Files\\node.exe&quot;",
    "&lt;&amp;",
    "&lt;QueryList&gt;",
  ])
    assert.ok(content.includes(text), text);
  assert.ok(content.includes("a\\&quot;b"));
  assert.ok(content.includes("tail\\\\&quot;"));
  assert.deepEqual(plan.commands, [
    [
      "schtasks",
      "/Create",
      "/TN",
      plan.name,
      "/XML",
      `${target.data}.watchdog.xml`,
      "/F",
    ],
  ]);
  const f = fake();
  await applyWatchdogPlan(plan, f.deps);
  const bytes = f.writes[0].content as Buffer;
  assert.deepEqual([...bytes.subarray(0, 2)], [255, 254]);
  assert.equal(bytes.subarray(2).toString("utf16le"), content);
  assert.ok(
    !installPlan("win32", {
      ...target,
      command: "C:\\Cobble.exe",
    }).files[0].content.includes("conhost.exe"),
  );
  const remove = uninstallPlan("win32", target);
  assert.deepEqual(remove.commands, [
    ["schtasks", "/Delete", "/TN", plan.name, "/F"],
  ]);
  await applyWatchdogPlan(remove, f.deps);
  assert.deepEqual(f.removed, [`${target.data}.watchdog.xml`]);
});
test("launchd plan has arguments, interval, logs and ignores bootout failure", async () => {
  const plan = installPlan("darwin", target);
  assert.equal(
    plan.files[0].path,
    path.posix.join(
      target.home,
      "Library",
      "LaunchAgents",
      `${plan.name}.plist`,
    ),
  );
  for (const s of [
    "<key>ProgramArguments</key>",
    "<string>a b</string>",
    "<string>a&quot;b</string>",
    "<key>RunAtLoad</key><true/>",
    "<integer>600</integer>",
    `${target.data}.watchdog.log`,
  ])
    assert.ok(plan.files[0].content.includes(s));
  const f = fake();
  f.deps.exec = async (cmd, args) => {
    f.calls.push({ cmd, args });
    return {
      code: args[0] === "bootout" ? 1 : 0,
      stdout: "",
      stderr: "not loaded",
    };
  };
  await applyWatchdogPlan(plan, f.deps);
  assert.deepEqual(
    f.calls.map((c) => c.args.slice(0, 2)),
    [
      ["bootout", "gui/123"],
      ["bootstrap", "gui/123"],
    ],
  );
  assert.equal(
    uninstallPlan("darwin", target).removeFiles[0],
    plan.files[0].path,
  );
});
test("systemd units quote paths and uninstall disables before deleting and reloading", async () => {
  const plan = installPlan(
    "linux",
    { ...target, args: [...target.args, "$HOME %quoted"] },
    { systemd: true },
  );
  assert.equal(plan.files.length, 2);
  assert.ok(plan.files[0].content.includes('"$$HOME %%quoted"'));
  assert.ok(
    plan.files[0].content.includes(
      'Type=oneshot\nExecStart="C:\\\\Program Files\\\\node.exe" "a b"',
    ),
  );
  for (const s of [
    "OnBootSec=1min",
    "OnUnitActiveSec=10min",
    "Persistent=true",
  ])
    assert.ok(plan.files[1].content.includes(s));
  const events: string[] = [];
  const f = fake();
  f.deps.exec = async (_c, a) => {
    events.push(a.join(" "));
    return { code: 0, stdout: "", stderr: "" };
  };
  f.deps.removeFile = (p) => {
    events.push(`remove ${p}`);
  };
  await applyWatchdogPlan(
    uninstallPlan("linux", target, { systemd: true }),
    f.deps,
  );
  assert.ok(events[0].includes("disable --now"));
  assert.ok(events[1].startsWith("remove "));
  assert.equal(events[3], "--user daemon-reload");
  assert.equal(await hasSystemdUser(f.deps), true);
  assert.equal(
    await hasSystemdUser({
      exec: async () => {
        throw new Error("missing");
      },
    }),
    false,
  );
});
test("cron install replaces only its block and uninstall preserves other jobs", async () => {
  const plan = installPlan("linux", { ...target, command: "/a b/it's%node" });
  assert.ok(plan.crontab?.block.includes("@reboot '/a b/it'\"'\"'s\\%node'"));
  assert.ok(plan.crontab?.block.includes("*/10 * * * *"));
  const f = fake();
  const existing = `# other\n@reboot other\n# >>> ${plan.name}\nold job\n# <<< ${plan.name}\n0 * * * * another\n`;
  f.deps.exec = async (cmd, args, input) => {
    f.calls.push({ cmd, args, input });
    return { code: 0, stdout: args[0] === "-l" ? existing : "", stderr: "" };
  };
  await applyWatchdogPlan(plan, f.deps);
  assert.equal(
    f.calls[1].input,
    `# other\n@reboot other\n0 * * * * another\n${plan.crontab!.block}\n`,
  );
  await applyWatchdogPlan(uninstallPlan("linux", target), f.deps);
  assert.equal(f.calls[3].input, "# other\n@reboot other\n0 * * * * another\n");
});
test("dry run never invokes any injected IO", async () => {
  const no = () => {
    throw new Error("IO forbidden");
  };
  const deps: WatchdogDeps = {
    exec: no,
    writeFile: no,
    removeFile: no,
    mkdir: no,
  };
  for (const p of ["win32", "darwin", "linux"] as const)
    for (const builder of [installPlan, uninstallPlan]) {
      const result = await applyWatchdogPlan(builder(p, target), deps, {
        dryRun: true,
      });
      assert.equal(result.dryRun, true);
      assert.ok(result.lines.length);
    }
});
test("keep awake selects platform helper and holds, releases and respawns idempotently", () => {
  const win = keepAwakeCommand("win32", 123, () => false)!;
  assert.equal(win.command, "powershell.exe");
  assert.ok(win.args.includes("Hidden"));
  assert.ok(win.args.at(-1)!.includes("SetThreadExecutionState(0x80000001)"));
  assert.ok(win.args.at(-1)!.includes("Get-Process -Id 123"));
  assert.deepEqual(
    keepAwakeCommand("darwin", 123, () => false),
    { command: "caffeinate", args: ["-i", "-w", "123"] },
  );
  assert.equal(
    keepAwakeCommand("linux", 123, () => false),
    null,
  );
  assert.ok(
    keepAwakeCommand("linux", 123, () => true)!.args.includes("--pid=123"),
  );
  const children: { exit?: () => void; killed: number }[] = [];
  const awake = new KeepAwake({
    platform: "darwin",
    pid: 123,
    hasCommand: () => true,
    spawn: () => {
      const child = { killed: 0, exit: undefined as (() => void) | undefined };
      children.push(child);
      return {
        kill: () => {
          child.killed++;
        },
        on: (_e, f) => {
          child.exit = f;
        },
      };
    },
  });
  awake.hold();
  awake.hold();
  assert.equal(children.length, 1);
  assert.equal(awake.holding, true);
  children[0].exit!();
  assert.equal(awake.holding, false);
  awake.hold();
  assert.equal(children.length, 2);
  children[0].exit!();
  assert.equal(awake.holding, true);
  awake.release();
  awake.release();
  assert.equal(children[1].killed, 1);
  assert.equal(awake.holding, false);
  let logs = 0;
  const unavailable = new KeepAwake({
    platform: "linux",
    pid: 123,
    hasCommand: () => false,
    spawn: () => {
      throw new Error("unexpected spawn");
    },
    log: () => {
      logs++;
    },
  });
  unavailable.hold();
  unavailable.hold();
  assert.equal(logs, 1);
});
