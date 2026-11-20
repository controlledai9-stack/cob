import { createHash } from "node:crypto";
import path from "node:path";

export type WatchdogPlatform = "win32" | "darwin" | "linux";
export interface WatchdogTarget {
  data: string;
  command: string;
  args: string[];
  home: string;
  uid?: number;
  user?: string;
  logFile?: string;
  startBoundary?: string;
}
export interface WatchdogFile {
  path: string;
  content: string;
  encoding: "utf8" | "utf16le-bom";
}
export interface WatchdogPlan {
  platform: WatchdogPlatform;
  name: string;
  files: WatchdogFile[];
  commands: string[][];
  removeFiles: string[];
  crontab?: { install: boolean; block: string };
}
export interface WatchdogDeps {
  exec(
    cmd: string,
    args: string[],
    input?: string,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  writeFile(p: string, c: string | Buffer): void;
  removeFile(p: string): void;
  mkdir(p: string): void;
}
const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const shell = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
const windows = (s: string) =>
  `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
const systemd = (s: string) =>
  `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, () => "$$")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")}"`;
export function watchdogName(p: WatchdogPlatform, data: string): string {
  return `cobble-watchdog-${createHash("sha1").update(path.resolve(data)).digest("hex").slice(0, 8)}`;
}
export function installPlan(
  p: WatchdogPlatform,
  t: WatchdogTarget,
  o: { systemd?: boolean } = {},
): WatchdogPlan {
  return build(p, t, o, true);
}
export function uninstallPlan(
  p: WatchdogPlatform,
  t: WatchdogTarget,
  o: { systemd?: boolean } = {},
): WatchdogPlan {
  return build(p, t, o, false);
}
function build(
  p: WatchdogPlatform,
  t: WatchdogTarget,
  o: { systemd?: boolean },
  install: boolean,
): WatchdogPlan {
  const name = watchdogName(p, t.data);
  const plan: WatchdogPlan = {
    platform: p,
    name,
    files: [],
    commands: [],
    removeFiles: [],
  };
  const file = (
    f: string,
    content: string,
    encoding: WatchdogFile["encoding"] = "utf8",
  ) => {
    if (install) plan.files.push({ path: f, content, encoding });
    else plan.removeFiles.push(f);
  };
  if (p === "win32") {
    const f = `${t.data}.watchdog.xml`;
    const consoleExe = /(?:^|[\\/])node\.exe$/i.test(t.command);
    const command = consoleExe ? "conhost.exe" : t.command;
    const args = consoleExe ? ["--headless", t.command, ...t.args] : t.args;
    const subscription =
      '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name=\'Microsoft-Windows-Power-Troubleshooter\'] and EventID=1]]</Select></Query></QueryList>';
    file(
      f,
      `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><UserId>${xml(t.user ?? "")}</UserId></LogonTrigger><EventTrigger><Subscription>${xml(subscription)}</Subscription><Delay>PT1M</Delay></EventTrigger><TimeTrigger><Repetition><Interval>PT10M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${xml(t.startBoundary ?? "2020-01-01T00:00:00")}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(t.user ?? "")}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT5M</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>${xml(command)}</Command><Arguments>${xml(args.map(windows).join(" "))}</Arguments></Exec></Actions></Task>`,
      "utf16le-bom",
    );
    plan.commands.push(
      install
        ? ["schtasks", "/Create", "/TN", name, "/XML", f, "/F"]
        : ["schtasks", "/Delete", "/TN", name, "/F"],
    );
  } else if (p === "darwin") {
    const f = path.posix.join(
      t.home,
      "Library",
      "LaunchAgents",
      `${name}.plist`,
    );
    const log = t.logFile ?? `${t.data}.watchdog.log`;
    file(
      f,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${xml(name)}</string><key>ProgramArguments</key><array>${[t.command, ...t.args].map((s) => `<string>${xml(s)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>StartInterval</key><integer>600</integer><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`,
    );
    plan.commands.push(["launchctl", "bootout", `gui/${t.uid ?? 0}`, f]);
    if (install)
      plan.commands.push(["launchctl", "bootstrap", `gui/${t.uid ?? 0}`, f]);
  } else if (o.systemd) {
    const base = path.posix.join(t.home, ".config", "systemd", "user", name);
    file(
      `${base}.service`,
      `[Unit]\nDescription=Cobble daemon watchdog\n[Service]\nType=oneshot\nExecStart=${[t.command, ...t.args].map(systemd).join(" ")}\n`,
    );
    file(
      `${base}.timer`,
      `[Unit]\nDescription=Cobble daemon watchdog timer\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=10min\nPersistent=true\n[Install]\nWantedBy=timers.target\n`,
    );
    plan.commands = install
      ? [
          ["systemctl", "--user", "daemon-reload"],
          ["systemctl", "--user", "enable", "--now", `${name}.timer`],
        ]
      : [
          ["systemctl", "--user", "disable", "--now", `${name}.timer`],
          ["systemctl", "--user", "daemon-reload"],
        ];
  } else {
    // Cron treats percent signs specially, even within shell quotes.
    const command = [t.command, ...t.args]
      .map(shell)
      .join(" ")
      .replace(/%/g, "\\%");
    plan.crontab = {
      install,
      block: `# >>> ${name}\n@reboot ${command}\n*/10 * * * * ${command}\n# <<< ${name}`,
    };
  }
  return plan;
}
export async function hasSystemdUser(
  deps: Pick<WatchdogDeps, "exec">,
): Promise<boolean> {
  try {
    return (
      (await deps.exec("systemctl", ["--user", "show-environment"])).code === 0
    );
  } catch {
    return false;
  }
}
export async function applyWatchdogPlan(
  plan: WatchdogPlan,
  deps: WatchdogDeps,
  o: { dryRun?: boolean } = {},
): Promise<{ dryRun: boolean; lines: string[] }> {
  const lines = [
    ...plan.files.map((f) => `Write ${f.path}`),
    ...plan.commands.map((c) => c.join(" ")),
    ...plan.removeFiles.map((f) => `Remove ${f}`),
    ...(plan.crontab ? ["crontab -l", "crontab -"] : []),
  ];
  if (o.dryRun) return { dryRun: true, lines };
  for (const f of plan.files) {
    deps.mkdir(path.dirname(f.path));
    deps.writeFile(
      f.path,
      f.encoding === "utf16le-bom"
        ? Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from(f.content, "utf16le"),
          ])
        : f.content,
    );
  }
  const run = async (c: string[], input?: string) => {
    const r = await deps.exec(c[0], c.slice(1), input);
    if (r.code !== 0 && !(c[0] === "launchctl" && c[1] === "bootout"))
      throw new Error(`${c.join(" ")}: ${r.stderr || r.code}`);
  };
  for (const c of plan.commands) {
    // Reload after unit files have been removed on uninstall.
    if (
      plan.removeFiles.length &&
      c[0] === "systemctl" &&
      c.includes("daemon-reload")
    ) {
      for (const f of plan.removeFiles) deps.removeFile(f);
    }
    await run(c);
  }
  if (!(
    plan.platform === "linux" &&
    plan.commands.some((c) => c.includes("daemon-reload"))
  ))
    for (const f of plan.removeFiles) deps.removeFile(f);
  if (plan.crontab) {
    const existing = await deps.exec("crontab", ["-l"]);
    if (
      existing.code !== 0 &&
      !(
        existing.code === 1 &&
        (!existing.stderr.trim() || /no crontab/i.test(existing.stderr))
      )
    )
      throw new Error(existing.stderr || "Cannot read crontab");
    const escapedName = plan.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = new RegExp(
      `^# >>> ${escapedName}\\r?\\n[\\s\\S]*?^# <<< ${escapedName}(?:\\r?\\n|$)`,
      "gm",
    );
    const kept = existing.stdout.replace(block, "");
    await run(
      ["crontab", "-"],
      plan.crontab.install
        ? `${kept}${kept && !kept.endsWith("\n") ? "\n" : ""}${plan.crontab.block}\n`
        : kept,
    );
  }
  return { dryRun: false, lines };
}
