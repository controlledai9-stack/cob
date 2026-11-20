import {
  parseAgentLoginType,
  type AgentLoginType,
} from "../../shared/cost-label";
import {
  parseCodexRateLimits,
  parseGenericRateLimit,
  type ReportedRateLimit,
} from "./usage-limits";
/**
 * Headless CLI adapters for the user's own installed coding agents.
 *
 * Cobble never reads, stores or forwards provider credentials: the child
 * inherits the user's environment and the CLI uses its own sign-in. The task
 * prompt travels on stdin, so command-line arguments are fixed constants and
 * safe to pass through a Windows .cmd shim.
 *
 * The flags below follow each provider's documented headless mode. They have
 * NOT been verified against a live installation yet; see
 * docs/AGENT-TEAM-DELIVERY.md for the live checklist.
 */
import { spawn, execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, extname, join } from "node:path";
import type { AgentDetection, TeamAgentId, TeamRole, TeamUsage } from "./types";
import { memberModelError, TEAM_AGENTS } from "./types";
import { emptyUsage, unknownTurn } from "./usage";

export interface AdapterRunInput {
  model?: string;
  /** Disable all model tools; unsupported adapters must fail closed. */
  tools?: false;
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  readOnly: boolean;
  /** Network access for deploy tasks (only meaningful for sandboxed CLIs). */
  network: boolean;
  /**
   * User opt-in per role: run like the agent's normal interactive use on the
   * user's PC, without its own sandbox or permission prompts, so it can use
   * the user's installed tools (e.g. deploy CLIs). Codex's Windows sandbox
   * refuses to start programs outside the project ("Access is denied").
   */
  fullAccess?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Worker tasks only: which task this is (used by the teammate adapter). */
  task?: { teamId: string; runId: string; taskId: string; role: TeamRole };
}
export interface AdapterResult {
  sessionId?: string;
  exitCode: number;
  finalText: string;
  authRequired?: { service: string; hint: string };
  rateLimited?: boolean;
  rateLimit?: ReportedRateLimit;
  timedOut?: boolean;
  durationMs: number;
  /** Tokens and cost reported by API-model workers or CLI agents. */
  usage?: TeamUsage;
}
export interface AgentAdapter {
  id: TeamAgentId;
  detect(): Promise<AgentDetection>;
  currentLoginType?(): AgentLoginType;
  run(input: AdapterRunInput): Promise<AdapterResult>;
}

export const ADAPTER_LIMITS = Object.freeze({
  stdoutBytes: 1_000_000,
  finalText: 12_000,
  /** A reply's cobble-actions / cobble-report block is kept up to this size. */
  blockText: 60_000,
});

/**
 * Shortens an agent's reply for storage and parsing. Keeps the end, but never
 * cuts into the last ```cobble-actions or ```cobble-report block: long
 * planner replies (a brief plus many tasks) used to lose the block's opening
 * fence and were rejected as "no cobble-actions block found".
 */
export function clipReply(text: string): string {
  if (text.length <= ADAPTER_LIMITS.finalText) return text;
  const fence = Math.max(
    text.lastIndexOf("```cobble-actions"),
    text.lastIndexOf("```cobble-report"),
  );
  const tail = text.length - ADAPTER_LIMITS.finalText;
  if (fence < 0 || fence >= tail) return text.slice(tail);
  // Keep the whole block (bounded), plus a little of the words before it.
  return text.slice(
    Math.max(0, fence - 2_000, text.length - ADAPTER_LIMITS.blockText),
  );
}

const SAFE_ARG = /^[\w .:=/,@+-]{1,200}$/;
const SAFE_SESSION = /^[\w-]{1,128}$/;

const AUTH_PATTERNS = [
  /not (?:logged|signed) in/i,
  /(?:login|log in|sign in|signin) (?:is )?required/i,
  /please (?:log|sign) ?in/i,
  /\bunauthori[sz]ed\b/i,
  /\b401\b/,
  /authenticat(?:e|ion) (?:required|failed)/i,
  /invalid (?:api key|credentials|token)/i,
  // Gemini CLI 0.67.0 with a free Google sign-in: the account tier was retired.
  /IneligibleTierError|no longer supported for Gemini Code Assist/i,
  /error authenticating/i,
];
const RATE_PATTERNS = [/\b429\b/, /rate.?limit/i, /usage limit/i, /quota/i];

/** Classifies CLI output into sign-in / quota problems. */
export function classifyFailure(output: string): {
  auth: boolean;
  rate: boolean;
} {
  return {
    auth: AUTH_PATTERNS.some((p) => p.test(output)),
    rate: RATE_PATTERNS.some((p) => p.test(output)),
  };
}

async function resolveCommand(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((e) => e.toLowerCase())
      : [""];
  for (const dir of dirs)
    for (const ext of exts) {
      const file = join(dir, name + ext);
      try {
        await access(
          file,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return file;
      } catch {
        /* keep looking */
      }
    }
  return null;
}

export function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32")
    execFile(
      "taskkill",
      ["/pid", String(pid), "/T", "/F"],
      {
        windowsHide: true,
      },
      () => {},
    );
  else
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
}

export interface CliSpec {
  parseRateLimit?(stdout: string, now: number): ReportedRateLimit | undefined;
  id: TeamAgentId;
  command: string;
  versionArgs: string[];
  args(input: AdapterRunInput): string[];
  /** Extracts the final assistant text and session id from stdout. */
  parse(stdout: string): { finalText: string; sessionId?: string };
  /** Extracts reported token numbers; undefined when unavailable. Never throws. */
  parseUsage?(stdout: string): TeamUsage | undefined;
}

export function cliUsage(
  spec: CliSpec,
  stdout: string,
  loginType?: AgentLoginType,
): TeamUsage {
  const usage = spec.parseUsage?.(stdout) ?? unknownTurn();
  if (loginType === undefined) return usage;
  return {
    ...usage,
    loginType,
    costParts:
      usage.cliCostUsd === undefined
        ? []
        : [{ loginType, valueUsd: usage.cliCostUsd }],
  };
}

export interface AuthStatusResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
export type AuthStatusRunner = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<AuthStatusResult>;

/** Bounded even when an injected runner fails to settle. Raw output is never retained. */
export async function detectAgentLoginType(
  agent: string,
  file: string,
  runner: AuthStatusRunner,
  timeoutMs = 3_000,
): Promise<AgentLoginType> {
  const args =
    agent === "claude"
      ? ["auth", "status", "--json"]
      : agent === "codex"
        ? ["login", "status"]
        : undefined;
  if (!args) return "unknown";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runner(file, args, timeoutMs).then((out) =>
        out.code === 0 && !out.timedOut
          ? parseAgentLoginType(agent, `${out.stdout}\n${out.stderr}`.trim())
          : ("unknown" as const),
      ),
      new Promise<"unknown">((resolve) => {
        timer = setTimeout(() => resolve("unknown"), timeoutMs);
      }),
    ]);
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

export class CliAdapter implements AgentAdapter {
  readonly id: TeamAgentId;
  private resolved?: string | null;
  private loginType: AgentLoginType = "unknown";
  private loginCheck?: Promise<AgentLoginType>;
  private loginCheckedAt = 0;
  constructor(
    private readonly spec: CliSpec,
    private readonly authRunner?: AuthStatusRunner,
  ) {
    this.id = spec.id;
  }
  currentLoginType(): AgentLoginType {
    return this.loginType;
  }
  private async checkLogin(file: string): Promise<AgentLoginType> {
    if (!this.loginCheck || Date.now() - this.loginCheckedAt > 300_000) {
      this.loginCheckedAt = Date.now();
      this.loginCheck = detectAgentLoginType(
        this.id,
        file,
        this.authRunner ??
          (async (command, args, timeoutMs) => {
            const child = this.launch(command, args, process.cwd());
            child.stdin?.end();
            return collect(child, timeoutMs, 16_384);
          }),
      ).then((value) => (this.loginType = value));
    }
    return this.loginCheck;
  }
  private async executable() {
    if (this.resolved === undefined)
      this.resolved = await resolveCommand(this.spec.command);
    return this.resolved;
  }
  private launch(file: string, args: string[], cwd: string) {
    for (const arg of args)
      if (!SAFE_ARG.test(arg)) throw new Error(`Unsafe agent argument: ${arg}`);
    const ext = extname(file).toLowerCase();
    if (process.platform === "win32" && (ext === ".cmd" || ext === ".bat"))
      // npm installs Windows CLIs as .cmd shims, which need cmd.exe. Every
      // argument is a validated constant, so quoting cannot be escaped.
      return spawn(`"${file}" ${args.map((a) => `"${a}"`).join(" ")}`, {
        cwd,
        shell: true,
        windowsHide: true,
        env: process.env,
      });
    return spawn(file, args, {
      cwd,
      windowsHide: true,
      env: process.env,
      detached: process.platform !== "win32",
    });
  }
  async detect(): Promise<AgentDetection> {
    const file = await this.executable();
    if (!file) return { agent: this.id, installed: false };
    try {
      const loginType = await this.checkLogin(file);
      const child = this.launch(file, this.spec.versionArgs, process.cwd());
      child.stdin?.end();
      const out = await collect(child, 15_000);
      return {
        agent: this.id,
        installed: true,
        command: file,
        loginType,
        version: out.stdout.trim().split(/\r?\n/)[0]?.slice(0, 120),
      };
    } catch (error) {
      return {
        agent: this.id,
        installed: true,
        command: file,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  async run(input: AdapterRunInput): Promise<AdapterResult> {
    if (input.tools === false)
      throw new Error(
        "Tool-free research requires a model API adapter; CLI tool isolation is unavailable",
      );
    const started = Date.now();
    const file = await this.executable();
    if (!file) throw new Error(`${this.id} CLI is not installed`);
    if (input.resumeSessionId && !SAFE_SESSION.test(input.resumeSessionId))
      throw new Error("Invalid agent session id");
    const loginType = await this.checkLogin(file);
    const child = this.launch(file, this.spec.args(input), input.cwd);
    child.stdin?.end(input.prompt);
    const onAbort = () => killTree(child.pid);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const out = await collect(child, input.timeoutMs);
      const parsed = this.spec.parse(out.stdout);
      const failure =
        out.code === 0
          ? { auth: false, rate: false }
          : classifyFailure(`${out.stderr}\n${out.stdout}`.slice(-20_000));
      return {
        exitCode: out.code,
        finalText: clipReply(parsed.finalText || out.stderr),
        ...(parsed.sessionId && SAFE_SESSION.test(parsed.sessionId)
          ? { sessionId: parsed.sessionId }
          : {}),
        ...(failure.auth
          ? {
              authRequired: {
                service: this.id,
                hint: `Sign in to the ${this.id} CLI or the service it was using, then press Done.`,
              },
            }
          : {}),
        ...(failure.rate ? { rateLimited: true } : {}),
        ...(out.timedOut ? { timedOut: true } : {}),
        durationMs: Date.now() - started,
        usage: cliUsage(this.spec, out.stdout, loginType),
        rateLimit: this.spec.parseRateLimit?.(out.stdout, Date.now()),
      };
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function collect(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  maxBytes: number = ADAPTER_LIMITS.stdoutBytes,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (acc: string, chunk: Buffer) =>
      acc.length >= maxBytes
        ? acc
        : (acc + chunk.toString("utf8")).slice(0, maxBytes);
    child.stdout?.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr?.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* ignore partial lines */
    }
  }
  return out;
}
function lastJson(stdout: string): Record<string, unknown> | null {
  const t = stdout.trim();
  try {
    return JSON.parse(t);
  } catch {
    const lines = jsonLines(stdout);
    return lines.at(-1) ?? null;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tokenNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function reportedTokens(
  value: unknown,
  fields: string[],
): number[] | undefined {
  const record = object(value);
  if (!record) return undefined;
  const numbers = fields.map((field) => tokenNumber(record[field]));
  return numbers.some((n) => n !== undefined)
    ? numbers.map((n) => n ?? 0)
    : undefined;
}

/** Claude Code: `claude -p --output-format json`, prompt on stdin. */
export const claudeSpec: CliSpec = {
  parseRateLimit: parseGenericRateLimit,
  parseUsage(stdout) {
    const value = object(lastJson(stdout));
    const tokens = reportedTokens(value?.usage, [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ]);
    if (!tokens) return undefined;
    const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] =
      tokens;
    const cliCostUsd = tokenNumber(value?.total_cost_usd);
    return {
      ...emptyUsage(),
      calls: 1,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(cliCostUsd !== undefined ? { cliCostUsd } : {}),
    };
  },
  id: "claude",
  command: "claude",
  versionArgs: ["--version"],
  args: (input) => [
    ...modelArgs(input, "--model"),
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    input.readOnly
      ? "plan"
      : input.fullAccess
        ? "bypassPermissions"
        : "acceptEdits",
    ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
  ],
  parse(stdout) {
    const value = lastJson(stdout);
    if (!value) return { finalText: stdout };
    return {
      finalText: typeof value.result === "string" ? value.result : stdout,
      sessionId:
        typeof value.session_id === "string" ? value.session_id : undefined,
    };
  },
};

/** Codex CLI: `codex exec --json -`, prompt on stdin, JSONL events out. */
export const codexSpec: CliSpec = {
  parseRateLimit: parseCodexRateLimits,
  parseUsage(stdout) {
    const events = jsonLines(stdout)
      .map(object)
      .filter((e) => e !== undefined);
    const completed = events.filter((event) => event.type === "turn.completed");
    // Output beyond ADAPTER_LIMITS.stdoutBytes loses turn.completed, so such
    // turns stay unknown by design.
    const records = completed.length
      ? completed.map((event) => event.usage)
      : events.flatMap((event) => {
          const msg = object(event.msg);
          const count = msg?.type === "token_count" ? msg : event;
          return count.type === "token_count"
            ? [object(count.info)?.last_token_usage]
            : [];
        });
    const usage = { ...emptyUsage(), calls: 1 };
    let found = false;
    for (const record of records) {
      const tokens = reportedTokens(record, [
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
      ]);
      if (!tokens) continue;
      found = true;
      const [input, cached, output] = tokens;
      usage.inputTokens += Math.max(0, input - cached);
      usage.cacheReadTokens += cached;
      usage.outputTokens += output;
    }
    return found ? usage : undefined;
  },
  id: "codex",
  command: "codex",
  versionArgs: ["--version"],
  args: (input) => [
    "exec",
    ...(input.resumeSessionId ? ["resume", input.resumeSessionId] : []),
    // Placed with the other flags so both `exec` and `exec resume` accept it.
    ...modelArgs(input, "-m"),
    "--json",
    "--skip-git-repo-check",
    // `codex exec resume` has no --sandbox flag (verified on codex-cli
    // 0.167.0), so the sandbox is set through config for both forms.
    "-c",
    `sandbox_mode=${input.readOnly ? "read-only" : input.fullAccess ? "danger-full-access" : "workspace-write"}`,
    ...(input.network && !input.readOnly && !input.fullAccess
      ? ["-c", "sandbox_workspace_write.network_access=true"]
      : []),
    "-",
  ],
  parse(stdout) {
    let finalText = "";
    let sessionId: string | undefined;
    for (const event of jsonLines(stdout)) {
      if (typeof event.thread_id === "string") sessionId = event.thread_id;
      if (typeof event.session_id === "string") sessionId = event.session_id;
      const item = event.item as Record<string, unknown> | undefined;
      if (
        item &&
        (item.type === "agent_message" ||
          item.item_type === "assistant_message") &&
        typeof item.text === "string"
      )
        finalText = item.text;
    }
    return { finalText: finalText || stdout, sessionId };
  },
};

/** Gemini CLI: `gemini -p ... --output-format json`; stdin is appended. */
export const geminiSpec: CliSpec = {
  parseRateLimit: parseGenericRateLimit,
  parseUsage(stdout) {
    const models = object(object(object(lastJson(stdout))?.stats)?.models);
    if (!models) return undefined;
    const usage = { ...emptyUsage(), calls: 1 };
    let found = false;
    for (const model of Object.values(models)) {
      const tokens = reportedTokens(object(model)?.tokens, [
        "prompt",
        "cached",
        "candidates",
        "thoughts",
      ]);
      if (!tokens) continue;
      found = true;
      const [prompt, cached, candidates, thoughts] = tokens;
      usage.inputTokens += Math.max(0, prompt - cached);
      usage.cacheReadTokens += cached;
      usage.outputTokens += candidates + thoughts;
    }
    return found ? usage : undefined;
  },
  id: "gemini",
  command: "gemini",
  versionArgs: ["--version"],
  args: (input) => [
    ...modelArgs(input, "-m"),
    "-p",
    "Follow the task given on standard input.",
    "--output-format",
    "json",
    // Task worktrees live in Cobble's app data and are never in Gemini's
    // trusted list; without this Gemini silently drops the approval mode.
    "--skip-trust",
    // "plan" is Gemini's read-only mode (verified on gemini-cli 0.67.0).
    "--approval-mode",
    input.readOnly ? "plan" : input.fullAccess ? "yolo" : "auto_edit",
  ],
  parse(stdout) {
    const value = lastJson(stdout);
    if (!value) return { finalText: stdout };
    return {
      finalText: typeof value.response === "string" ? value.response : stdout,
      sessionId:
        typeof value.session_id === "string" ? value.session_id : undefined,
    };
  },
};

/** Fills agent ids without an adapter with one that reports "not available". */
export function withUnavailable(
  adapters: Partial<Record<TeamAgentId, AgentAdapter>>,
): Record<TeamAgentId, AgentAdapter> {
  const out = { ...adapters } as Record<TeamAgentId, AgentAdapter>;
  for (const id of TEAM_AGENTS)
    out[id] ??= {
      id,
      detect: async () => ({ agent: id, installed: false }),
      run: async () => {
        throw new Error(`${id} is not available`);
      },
    };
  return out;
}

/** The installed coding-agent CLIs (API-model workers live in api-agent.ts). */
export function defaultAdapters(): Pick<
  Record<TeamAgentId, AgentAdapter>,
  "claude" | "codex" | "gemini"
> {
  return {
    claude: new CliAdapter(claudeSpec),
    codex: new CliAdapter(codexSpec),
    gemini: new CliAdapter(geminiSpec),
  };
}

function modelArgs(input: AdapterRunInput, flag: string): string[] {
  const error = memberModelError(input.model);
  if (error) throw new Error(error);
  return input.model ? [flag, input.model] : [];
}
