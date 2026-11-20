import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import {
  daemonLogFile,
  watchdogCommand,
  launchDaemon,
  waitUntil,
} from "./daemon-launch";
import {
  applyWatchdogPlan,
  hasSystemdUser,
  installPlan,
  uninstallPlan,
  type WatchdogDeps,
  type WatchdogPlatform,
} from "./watchdog";
import { daemonStatus } from "./daemon";
import type { TeamStore } from "./team-store";

const realDeps: WatchdogDeps = {
  exec: (command, args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: "pipe" });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }),
  writeFile: writeFileSync,
  removeFile: (file) => rmSync(file, { force: true }),
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
};

export async function watchdogAction(
  kind: "install" | "uninstall",
  data: string,
  options: {
    platform?: NodeJS.Platform;
    dryRun?: boolean;
    systemd?: boolean;
    home?: string;
    uid?: number;
    user?: string;
    deps?: WatchdogDeps;
  } = {},
) {
  const platform = options.platform ?? process.platform;
  if (!["win32", "darwin", "linux"].includes(platform))
    throw new Error(`Unsupported watchdog platform: ${platform}`);
  const deps = options.deps ?? realDeps;
  // A dry run must never probe the OS by executing a command.
  const systemd =
    platform === "linux"
      ? (options.systemd ??
        (options.dryRun
          ? existsSync("/run/systemd/user") ||
            (!!process.env.XDG_RUNTIME_DIR &&
              existsSync(`${process.env.XDG_RUNTIME_DIR}/systemd`))
          : await hasSystemdUser(deps)))
      : false;
  const user = userInfo();
  const absolute = resolve(data);
  const plan = (kind === "install" ? installPlan : uninstallPlan)(
    platform as WatchdogPlatform,
    {
      data: absolute,
      ...watchdogCommand(absolute),
      home: options.home ?? homedir(),
      uid: options.uid ?? user.uid,
      user: options.user ?? user.username,
      logFile: daemonLogFile(absolute),
    },
    { systemd },
  );
  const result = await applyWatchdogPlan(plan, deps, {
    dryRun: options.dryRun,
  });
  return {
    ...result,
    plan,
    lines: [
      ...result.lines,
      ...plan.files.map((file) => file.content),
      ...(plan.crontab ? [plan.crontab.block] : []),
    ],
  };
}

export const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const DAEMON_USER_STOPPED_MESSAGE =
  "Cobble daemon was stopped by the user; not starting it. Run cobble team daemon or uninstall the watchdog.";

export async function ensureDaemonRunning(
  store: TeamStore,
  data: string,
  deps: {
    respectUserStop?: boolean;
    alive?: (pid: number) => boolean;
    launch?: (data: string) => number | undefined;
    wait?: typeof waitUntil;
  } = {},
) {
  if (deps.respectUserStop && store.daemonUserStopped())
    return { started: false, pid: undefined, userStopped: true };
  store.setDaemonUserStopped(null);
  const status = () => daemonStatus(store);
  const running = () => {
    const s = status();
    return s.running && !!s.lock && (deps.alive ?? pidAlive)(s.lock.pid);
  };
  if (running()) return { started: false, pid: status().lock!.pid };
  const wait = deps.wait ?? waitUntil;
  if (status().stopping && !(await wait(() => !status().stopping, 20_000)))
    throw new Error("Cobble daemon is still stopping.");
  (deps.launch ?? launchDaemon)(data);
  if (!(await wait(running, 15_000)))
    throw new Error(
      `Cobble daemon did not become ready. See ${daemonLogFile(data)} or run cobble team daemon --data ${JSON.stringify(data)}.`,
    );
  return { started: true, pid: status().lock!.pid };
}
