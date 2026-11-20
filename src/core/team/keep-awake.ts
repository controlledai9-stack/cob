export function keepAwakeCommand(
  platform: NodeJS.Platform,
  pid: number,
  has: (n: string) => boolean,
): { command: string; args: string[] } | null {
  if (platform === "win32")
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CobblePower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); public static void Hold() { SetThreadExecutionState(0x80000001); } }'; while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [CobblePower]::Hold(); Start-Sleep -Seconds 30 }`,
      ],
    };
  if (platform === "darwin")
    return { command: "caffeinate", args: ["-i", "-w", String(pid)] };
  if (platform === "linux" && has("systemd-inhibit"))
    return {
      command: "systemd-inhibit",
      args: [
        "--what=sleep:idle",
        "--who=Cobble",
        "--why=Cobble runs are active",
        "--mode=block",
        "tail",
        `--pid=${pid}`,
        "-f",
        "/dev/null",
      ],
    };
  return null;
}

interface KeepAwakeDeps {
  platform: NodeJS.Platform;
  pid: number;
  spawn(
    cmd: string,
    args: string[],
    o: object,
  ): { kill(): void; on(e: "exit" | "error", f: () => void): unknown };
  hasCommand(n: string): boolean;
  log?(l: string): void;
}

export class KeepAwake {
  private child: ReturnType<KeepAwakeDeps["spawn"]> | undefined;
  private logged = false;
  constructor(private readonly d: KeepAwakeDeps) {}
  get holding(): boolean {
    return this.child !== undefined;
  }
  hold(): void {
    if (this.child) return;
    const command = keepAwakeCommand(
      this.d.platform,
      this.d.pid,
      this.d.hasCommand,
    );
    if (!command) {
      if (!this.logged) this.d.log?.("Keep-awake helper unavailable");
      this.logged = true;
      return;
    }
    try {
      const child = this.d.spawn(command.command, command.args, {
        windowsHide: true,
        stdio: "ignore",
      });
      this.child = child;
      child.on("error", () => {
        if (this.child === child) this.child = undefined;
        this.unavailable();
      });
      child.on("exit", () => {
        if (this.child === child) this.child = undefined;
      });
    } catch {
      this.unavailable();
    }
  }
  private unavailable(): void {
    if (!this.logged) this.d.log?.("Keep-awake helper unavailable");
    this.logged = true;
  }
  release(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
}
