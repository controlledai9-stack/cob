import {
  DEFAULT_REVIEW_POLICY,
  parseReviewPolicy,
  type ReviewPolicy,
} from "./review-policy";
import { ResearchLibrary } from "../research/library";
import { ProjectResearchLibrary } from "../research/library-bridge";
import { bestAvailableMembers } from "./member-setup";
import type { AgentDetection } from "./types";
import type { AutomationRecord } from "./automation";
/**
 * Device-local persistence for Agent Team runs (migration 6). These rows are
 * never sent over team transport or included in host handover snapshots.
 */
import { randomUUID } from "node:crypto";
import type { ChatProposal, ControlCard, TeamChatMessage } from "./types";
import type { Store } from "../store";
import type {
  DaemonLock,
  SessionBrief,
  QueuedInboxItem,
  TeamInboxItem,
  RunSnapshot,
  TeamAgentId,
  TeamDecision,
  TeamEvent,
  TeamRole,
  TeamRun,
  TeamTask,
  TeamMember,
  TeamMemberInput,
  UserAnswer,
} from "./types";
import {
  memberNameError,
  memberModelError,
  FULL_ACCESS_ROLES,
  TEAM_AGENTS,
  TEAM_ROLES,
} from "./types";
import { totalUsage } from "./usage";
import { usageBreakdown } from "./usage-report";

export const TEAM_STORE_LIMITS = Object.freeze({
  inboxPerRun: 100,
  runsPerTeam: 200,
  eventsPerRun: 2_000,
  projectChatPerTeam: 500,
  chatPerRun: 1_000,
  chatText: 8_000,
  retentionDays: 8,
  userAnswers: 60,
});

export interface RecoveryNote {
  at: string;
  kind: "restart" | "sleep";
  runIds: string[];
  gapMs?: number;
}

export class TeamStore {
  /** When a finished task gets an LLM review: always, risky (default) or never. */
  reviewPolicy(teamId: string): ReviewPolicy {
    try {
      return parseReviewPolicy(
        this.store.setting(`teamReviewPolicy:${teamId}`, DEFAULT_REVIEW_POLICY),
      );
    } catch {
      return DEFAULT_REVIEW_POLICY;
    }
  }

  setReviewPolicy(teamId: string, value: string): ReviewPolicy {
    const policy = parseReviewPolicy(value);
    this.store.set(`teamReviewPolicy:${teamId}`, policy);
    return policy;
  }

  daemonUserStopped(): boolean {
    return !!this.store.setting("teamDaemonUserStopped", null);
  }
  setDaemonUserStopped(at: number | null): void {
    this.store.set("teamDaemonUserStopped", at);
  }
  recordRecovery(note: RecoveryNote): void {
    this.store.transaction(() =>
      this.store.set("teamRecovery", [...this.recoveries(0), note].slice(-10)),
    );
  }
  recoveries(sinceMs: number): RecoveryNote[] {
    return this.store
      .setting<RecoveryNote[]>("teamRecovery", [])
      .filter((n) => Date.parse(n.at) >= sinceMs);
  }
  automation(teamId: string): AutomationRecord | null {
    return this.store.setting<AutomationRecord | null>(
      `teamAutomation:${teamId}`,
      null,
    );
  }
  automations(): AutomationRecord[] {
    return (
      this.store.db
        .prepare("SELECT value FROM settings WHERE key LIKE 'teamAutomation:%'")
        .all() as { value: string }[]
    )
      .map((r) => JSON.parse(r.value) as AutomationRecord | null)
      .filter((r): r is AutomationRecord => !!r);
  }
  saveAutomation(r: AutomationRecord): void {
    this.store.set(`teamAutomation:${r.teamId}`, r);
  }
  clearAutomation(teamId: string, ownerId?: string): void {
    this.store.transaction(() => {
      if (ownerId === undefined || this.automation(teamId)?.ownerId === ownerId)
        this.store.set(`teamAutomation:${teamId}`, null);
    });
  }
  claimAutomation(
    teamId: string,
    expectedOwnerId: string,
    newOwnerId: string,
    now: number,
  ): boolean {
    return this.store.transaction(() => {
      const r = this.automation(teamId);
      if (!r || r.ownerId !== expectedOwnerId) return false;
      this.saveAutomation({
        ...r,
        ownerId: newOwnerId,
        ownerPid: process.pid,
        heartbeatAt: now,
        restoreSince: r.restoreSince ?? now,
      });
      return true;
    });
  }

  researchLibrary(projectId: string): ProjectResearchLibrary {
    return new ProjectResearchLibrary(new ResearchLibrary(this.store), projectId);
  }

  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS team_members(team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, name TEXT NOT NULL, role TEXT NOT NULL, agent TEXT NOT NULL, backup TEXT, full_access INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, PRIMARY KEY(team_id,name));
      CREATE TABLE IF NOT EXISTS team_roles(team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, role TEXT NOT NULL, agent TEXT NOT NULL, PRIMARY KEY(team_id,role));
      CREATE TABLE IF NOT EXISTS team_runs(id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, state TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_run_team ON team_runs(team_id,updated_at);
      CREATE TABLE IF NOT EXISTS team_tasks(id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE, state TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,id));
      CREATE TABLE IF NOT EXISTS team_decisions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_decision_run ON team_decisions(run_id,created_at);
      CREATE TABLE IF NOT EXISTS team_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_event_run ON team_events(run_id,seq);
      CREATE TABLE IF NOT EXISTS team_project_chat(seq INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_project_chat_team ON team_project_chat(team_id,seq);
      CREATE TABLE IF NOT EXISTS team_chat(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_chat_run ON team_chat(run_id,seq);
      CREATE TABLE IF NOT EXISTS team_inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_inbox_run ON team_inbox(run_id,seq);
      INSERT OR IGNORE INTO migrations VALUES(6);`);
  }

  sessionBrief(teamId: string): SessionBrief | null {
    try {
      const value = this.store.setting<SessionBrief | null>(
        `teamSessionBrief:${teamId}`,
        null,
      );
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof value.priority !== "string" ||
        !Array.isArray(value.agents) ||
        value.agents.some((agent) => !TEAM_AGENTS.includes(agent)) ||
        typeof value.createdAt !== "string" ||
        typeof value.updatedAt !== "string"
      )
        return null;
      return value;
    } catch {
      return null;
    }
  }
  setSessionBrief(teamId: string, brief: SessionBrief): void {
    this.store.set(`teamSessionBrief:${teamId}`, brief);
  }
  clearSessionBrief(teamId: string): void {
    this.store.set(`teamSessionBrief:${teamId}`, null);
  }

  daemonLock(): DaemonLock | null {
    return this.store.setting<DaemonLock | null>("teamDaemonLock", null);
  }

  acquireDaemonLock(
    owner: { id: string; pid: number },
    now: number,
    staleMs: number,
  ): DaemonLock | null {
    return this.store.transaction(() => {
      const held = this.daemonLock();
      if (held && held.id !== owner.id && now - held.heartbeat < staleMs)
        throw new Error(
          `A Cobble daemon is already running for this data folder (pid ${held.pid}).`,
        );
      this.store.set("teamDaemonLock", {
        ...owner,
        startedAt: now,
        heartbeat: now,
      });
      return held;
    });
  }

  heartbeatDaemonLock(id: string, now: number): DaemonLock | null {
    return this.store.transaction(() => {
      const held = this.daemonLock();
      if (!held || held.id !== id) return null;
      held.heartbeat = now;
      this.store.set("teamDaemonLock", held);
      return held;
    });
  }

  releaseDaemonLock(id: string): void {
    this.store.transaction(() => {
      if (this.daemonLock()?.id === id) this.store.set("teamDaemonLock", null);
    });
  }

  requestDaemonStop(): DaemonLock | null {
    return this.store.transaction(() => {
      const held = this.daemonLock();
      if (!held) return null;
      held.stopRequested = true;
      this.store.set("teamDaemonLock", held);
      return held;
    });
  }

  queueInbox(runId: string, item: TeamInboxItem): QueuedInboxItem {
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare("SELECT COUNT(*) AS n FROM team_inbox WHERE run_id=?")
        .get(runId) as { n: number };
      if (row.n >= TEAM_STORE_LIMITS.inboxPerRun)
        throw new Error("Too many queued messages for this run");
      const createdAt = new Date().toISOString();
      const result = this.store.db
        .prepare("INSERT INTO team_inbox(run_id,created_at,data) VALUES(?,?,?)")
        .run(runId, createdAt, JSON.stringify(item));
      return { seq: Number(result.lastInsertRowid), runId, createdAt, item };
    });
  }
  takeInbox(runId: string): QueuedInboxItem[] {
    return this.store.transaction(() => {
      const rows = this.store.db
        .prepare(
          "SELECT seq, created_at, data FROM team_inbox WHERE run_id=? ORDER BY seq",
        )
        .all(runId) as { seq: number; created_at: string; data: string }[];
      this.store.db.prepare("DELETE FROM team_inbox WHERE run_id=?").run(runId);
      return rows.map((r) => ({
        seq: r.seq,
        runId,
        createdAt: r.created_at,
        item: JSON.parse(r.data) as TeamInboxItem,
      }));
    });
  }
  inboxRunIds(): string[] {
    return (
      this.store.db.prepare("SELECT DISTINCT run_id FROM team_inbox").all() as {
        run_id: string;
      }[]
    ).map((r) => r.run_id);
  }

  private ensureMigrated(teamId: string): void {
    const key = `teamMembersMigrated:${teamId}`;
    if (this.store.setting(key, false)) return;
    this.store.transaction(() => {
      if (this.store.setting(key, false)) return;
      const backups = this.store.setting<Record<string, TeamAgentId>>(
        `teamBackupAgents:${teamId}`,
        {},
      );
      const access = this.store.setting<unknown>(
        `teamFullAccess:${teamId}`,
        [],
      );
      for (const role of TEAM_ROLES) {
        const row = this.store.db
          .prepare("SELECT agent FROM team_roles WHERE team_id=? AND role=?")
          .get(teamId, role) as { agent: string } | undefined;
        if (row)
          this.store.db
            .prepare(
              "INSERT OR IGNORE INTO team_members VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM team_members WHERE team_id=?))",
            )
            .run(
              teamId,
              role + "1",
              role,
              row.agent,
              backups?.[role] ?? null,
              Number(
                FULL_ACCESS_ROLES.includes(role) &&
                  Array.isArray(access) &&
                  access.includes(role),
              ),
              teamId,
            );
      }
      // An old migration marker with no setup marker may represent a team
      // deliberately emptied in a previous version. Only new migrations opt in.
      this.store.set(
        `teamMembersConfigured:${teamId}`,
        !!this.store.db
          .prepare("SELECT 1 FROM team_members WHERE team_id=? LIMIT 1")
          .get(teamId),
      );
      this.store.set(key, true);
    });
  }

  initializeMembers(
    teamId: string,
    detected: readonly AgentDetection[],
  ): boolean {
    return this.store.transaction(() => {
      const existing = this.members(teamId);
      const key = `teamMembersConfigured:${teamId}`;
      if (existing.length || this.store.setting(key, true)) return false;
      const initial = bestAvailableMembers(detected);
      if (!initial.length) return false;
      for (const member of initial) this.addMember(teamId, member);
      return true;
    });
  }

  private modelKey(teamId: string, name: string): string {
    return `teamMemberModel:${teamId}:${name}`;
  }

  private validateMember(input: Partial<TeamMemberInput>): void {
    const modelError = memberModelError(input.model);
    if (modelError) throw new Error(modelError);
    if (input.role === "debugger") {
      if (input.agent !== undefined && input.agent !== "free")
        throw new Error("Debugger must use the free agent");
      if (input.backup != null)
        throw new Error("Debugger cannot use a backup agent");
      if (input.fullAccess)
        throw new Error("Debugger cannot enable full access");
    }
    if (input.name !== undefined) {
      const error = memberNameError(input.name);
      if (error) throw new Error(error);
    }
    if (
      input.role !== undefined &&
      !TEAM_ROLES.includes(input.role as TeamRole)
    )
      throw new Error("Unknown role");
    if (
      input.agent !== undefined &&
      !TEAM_AGENTS.includes(input.agent as TeamAgentId)
    )
      throw new Error("Unsupported agent");
    if (
      input.backup != null &&
      !TEAM_AGENTS.includes(input.backup as TeamAgentId)
    )
      throw new Error("Unsupported agent");
    if (input.fullAccess !== undefined && typeof input.fullAccess !== "boolean")
      throw new Error("Invalid full access");
    if (
      input.fullAccess &&
      input.role !== undefined &&
      !FULL_ACCESS_ROLES.includes(input.role as TeamRole)
    )
      throw new Error("Full access is not allowed for this role");
  }

  members(teamId: string): TeamMember[] {
    this.ensureMigrated(teamId);
    const rows = this.store.db
      .prepare(
        "SELECT name,role,agent,backup,full_access FROM team_members WHERE team_id=? ORDER BY seq",
      )
      .all(teamId) as {
      name: string;
      role: TeamRole;
      agent: TeamAgentId;
      backup: TeamAgentId | null;
      full_access: number;
    }[];
    return rows.map((r) => ({
      ...(this.store.setting<string | null>(this.modelKey(teamId, r.name), null)
        ? {
            model: this.store.setting<string>(
              this.modelKey(teamId, r.name),
              "",
            ),
          }
        : {}),
      name: r.name,
      role: r.role,
      agent: r.agent,
      ...(r.backup ? { backup: r.backup } : {}),
      fullAccess: !!r.full_access,
    }));
  }
  member(teamId: string, name: string): TeamMember | null {
    this.validateMember({ name });
    return this.members(teamId).find((m) => m.name === name) ?? null;
  }
  planner(teamId: string): TeamMember | null {
    return this.members(teamId).find((m) => m.role === "planner") ?? null;
  }
  addMember(teamId: string, input: TeamMemberInput): TeamMember[] {
    return this.store.transaction(() => {
      this.validateMember(input);
      this.ensureMigrated(teamId);
      if (this.member(teamId, input.name))
        throw new Error("Member name is already taken");
      const fullAccess =
        FULL_ACCESS_ROLES.includes(input.role as TeamRole) &&
        (input.fullAccess ??
          this.fullAccessRoles(teamId).includes(input.role as TeamRole));
      this.store.db
        .prepare(
          "INSERT INTO team_members VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM team_members WHERE team_id=?))",
        )
        .run(
          teamId,
          input.name,
          input.role,
          input.agent,
          input.backup ?? null,
          Number(fullAccess),
          teamId,
        );
      this.store.set(this.modelKey(teamId, input.name), input.model || null);
      this.store.set(`teamMembersConfigured:${teamId}`, true);
      return this.members(teamId);
    });
  }
  updateMember(
    teamId: string,
    name: string,
    patch: Partial<TeamMemberInput>,
  ): TeamMember[] {
    return this.store.transaction(() => {
      this.validateMember({ name });
      this.validateMember(patch);
      this.ensureMigrated(teamId);
      const old = this.member(teamId, name);
      if (!old) throw new Error("Unknown member");
      const next = {
        ...old,
        ...patch,
        model: patch.model === undefined ? old.model : patch.model,
      };
      this.validateMember(next);
      if (next.name !== name && this.member(teamId, next.name))
        throw new Error("Member name is already taken");
      this.store.db
        .prepare(
          "UPDATE team_members SET name=?,role=?,agent=?,backup=?,full_access=? WHERE team_id=? AND name=?",
        )
        .run(
          next.name,
          next.role,
          next.agent,
          next.backup ?? null,
          Number(
            FULL_ACCESS_ROLES.includes(next.role as TeamRole) &&
              !!next.fullAccess,
          ),
          teamId,
          name,
        );
      this.store.set(this.modelKey(teamId, name), null);
      this.store.set(this.modelKey(teamId, next.name), next.model || null);
      this.store.set(`teamMembersConfigured:${teamId}`, true);
      return this.members(teamId);
    });
  }
  removeMember(teamId: string, name: string): TeamMember[] {
    return this.store.transaction(() => {
      this.validateMember({ name });
      this.ensureMigrated(teamId);
      this.store.db
        .prepare("DELETE FROM team_members WHERE team_id=? AND name=?")
        .run(teamId, name);
      this.store.set(this.modelKey(teamId, name), null);
      this.store.set(`teamMembersConfigured:${teamId}`, true);
      return this.members(teamId);
    });
  }
  roles(teamId: string): Partial<Record<TeamRole, TeamAgentId>> {
    const out: Partial<Record<TeamRole, TeamAgentId>> = {};
    for (const m of this.members(teamId))
      if (!(m.role in out)) out[m.role] = m.agent;
    return out;
  }
  backupAgents(teamId: string): Partial<Record<TeamRole, TeamAgentId>> {
    const out: Partial<Record<TeamRole, TeamAgentId>> = {};
    const seen = new Set<TeamRole>();
    for (const m of this.members(teamId)) {
      if (!seen.has(m.role) && m.backup) out[m.role] = m.backup;
      seen.add(m.role);
    }
    return out;
  }
  setBackupAgent(teamId: string, role: TeamRole, agent: TeamAgentId | null) {
    if (!TEAM_ROLES.includes(role)) throw new Error("Unknown role");
    if (agent !== null && !TEAM_AGENTS.includes(agent))
      throw new Error("Unsupported agent");
    this.ensureMigrated(teamId);
    const first = this.members(teamId).find((m) => m.role === role);
    if (first) this.updateMember(teamId, first.name, { backup: agent });
    return this.backupAgents(teamId);
  }
  fullAccessRoles(teamId: string): TeamRole[] {
    this.ensureMigrated(teamId);
    const saved = this.store.setting<unknown>(`teamFullAccess:${teamId}`, []);
    return Array.isArray(saved)
      ? saved.filter((r): r is TeamRole => FULL_ACCESS_ROLES.includes(r))
      : [];
  }
  setFullAccessRoles(teamId: string, roles: readonly string[]) {
    const clean = [...new Set(roles)].filter((r): r is TeamRole =>
      FULL_ACCESS_ROLES.includes(r as TeamRole),
    );
    this.ensureMigrated(teamId);
    this.store.transaction(() => {
      this.store.set(`teamFullAccess:${teamId}`, clean);
      for (const role of FULL_ACCESS_ROLES)
        this.store.db
          .prepare(
            "UPDATE team_members SET full_access=? WHERE team_id=? AND role=?",
          )
          .run(Number(clean.includes(role)), teamId, role);
    });
    return clean;
  }

  /**
   * Project decisions the user gave in intake interviews (where to deploy,
   * must-use tech, ...). Every planner and worker prompt includes them, so
   * later runs and autopilot do not ask again.
   */
  decisionsFromUser(teamId: string): UserAnswer[] {
    const saved = this.store.setting<unknown>(`teamUserAnswers:${teamId}`, []);
    return Array.isArray(saved) ? (saved as UserAnswer[]) : [];
  }
  addUserAnswers(teamId: string, answers: UserAnswer[]) {
    const byQuestion = new Map(
      this.decisionsFromUser(teamId).map((a) => [a.question.toLowerCase(), a]),
    );
    for (const a of answers)
      if (a.answer.trim()) {
        // Newest last: a re-answered question moves to the end, so trimming
        // to the limit drops the oldest decisions first.
        byQuestion.delete(a.question.toLowerCase());
        byQuestion.set(a.question.toLowerCase(), {
          question: a.question.slice(0, 500),
          answer: a.answer.slice(0, 1_000),
          at: a.at,
        });
      }
    const all = [...byQuestion.values()].slice(-TEAM_STORE_LIMITS.userAnswers);
    this.store.set(`teamUserAnswers:${teamId}`, all);
    return all;
  }
  forgetUserAnswers(teamId: string) {
    this.store.set(`teamUserAnswers:${teamId}`, []);
  }

  setRole(teamId: string, role: TeamRole, agent: TeamAgentId | null) {
    if (!TEAM_ROLES.includes(role)) throw new Error("Unknown role");
    if (agent !== null && !TEAM_AGENTS.includes(agent))
      throw new Error("Unsupported agent");
    this.ensureMigrated(teamId);
    if (agent === null) {
      for (const m of this.members(teamId).filter((m) => m.role === role))
        this.removeMember(teamId, m.name);
      this.store.set(`teamMembersConfigured:${teamId}`, true);
    } else {
      const first = this.members(teamId).find((m) => m.role === role);
      if (first) this.updateMember(teamId, first.name, { agent });
      else this.addMember(teamId, { name: role + "1", role, agent });
    }
  }

  saveRun(run: TeamRun) {
    run.updatedAt = new Date().toISOString();
    this.store.db
      .prepare(
        "INSERT INTO team_runs(id,team_id,state,updated_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at, data=excluded.data",
      )
      .run(run.id, run.teamId, run.state, run.updatedAt, JSON.stringify(run));
  }
  run(id: string): TeamRun | null {
    const row = this.store.db
      .prepare("SELECT data FROM team_runs WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as TeamRun) : null;
  }
  runs(teamId: string, limit = 50): TeamRun[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM team_runs WHERE team_id=? ORDER BY updated_at DESC LIMIT ?",
        )
        .all(teamId, limit) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as TeamRun);
  }
  /**
   * Atomically checks that the team has no open run and reserves the start
   * (BEGIN IMMEDIATE, so another Cobble process cannot pass at the same time).
   * A reservation older than two minutes is treated as abandoned.
   */
  reserveRunStart(teamId: string, owner: string, now: number, maxActive = 1) {
    this.store.transaction(() => {
      if (
        this.runsInState(["running", "needs_human", "paused"]).filter(
          (r) => r.teamId === teamId,
        ).length >= maxActive
      )
        throw new Error(
          "Finish or stop the current team run before starting another",
        );
      const key = `teamRunStarting:${teamId}`;
      const held = this.store.setting<{ owner: string; at: number } | null>(
        key,
        null,
      );
      if (held && held.owner !== owner && now - held.at < 120_000)
        throw new Error(
          "Another Agent Team run is already starting for this team",
        );
      this.store.set(key, { owner, at: now });
    });
  }
  releaseRunStart(teamId: string, owner: string) {
    const key = `teamRunStarting:${teamId}`;
    const held = this.store.setting<{ owner: string } | null>(key, null);
    if (held?.owner === owner) this.store.set(key, null);
  }

  runsInState(states: string[]): TeamRun[] {
    return (
      this.store.db
        .prepare(
          `SELECT data FROM team_runs WHERE state IN (${states.map(() => "?").join(",")})`,
        )
        .all(...states) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as TeamRun);
  }

  saveTask(task: TeamTask) {
    const seq =
      (
        this.store.db
          .prepare("SELECT seq FROM team_tasks WHERE run_id=? AND id=?")
          .get(task.runId, task.id) as { seq: number } | undefined
      )?.seq ??
      (
        this.store.db
          .prepare(
            "SELECT COALESCE(MAX(seq),0) AS m FROM team_tasks WHERE run_id=?",
          )
          .get(task.runId) as { m: number }
      ).m + 1;
    this.store.db
      .prepare(
        "INSERT INTO team_tasks(id,run_id,state,seq,data) VALUES(?,?,?,?,?) ON CONFLICT(run_id,id) DO UPDATE SET state=excluded.state, data=excluded.data",
      )
      .run(task.id, task.runId, task.state, seq, JSON.stringify(task));
  }
  tasks(runId: string): TeamTask[] {
    return (
      this.store.db
        .prepare("SELECT data FROM team_tasks WHERE run_id=? ORDER BY seq")
        .all(runId) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as TeamTask);
  }

  addDecision(
    runId: string,
    d: { question: string; choice: string; why: string },
  ) {
    const decision: TeamDecision = {
      id: randomUUID(),
      runId,
      ...d,
      createdAt: new Date().toISOString(),
    };
    this.store.db
      .prepare(
        "INSERT INTO team_decisions(id,run_id,created_at,data) VALUES(?,?,?,?)",
      )
      .run(decision.id, runId, decision.createdAt, JSON.stringify(decision));
    return decision;
  }
  decisions(runId: string): TeamDecision[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM team_decisions WHERE run_id=? ORDER BY created_at, rowid",
        )
        .all(runId) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as TeamDecision);
  }

  event(runId: string, kind: string, message: string, taskId?: string) {
    const event: TeamEvent = {
      id: randomUUID(),
      runId,
      kind,
      message: message.slice(0, 2_000),
      ...(taskId ? { taskId } : {}),
      createdAt: new Date().toISOString(),
    };
    this.store.db
      .prepare("INSERT INTO team_events(run_id,data) VALUES(?,?)")
      .run(runId, JSON.stringify(event));
    this.store.db
      .prepare(
        "DELETE FROM team_events WHERE run_id=? AND seq <= (SELECT seq FROM team_events WHERE run_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      )
      .run(runId, runId, TEAM_STORE_LIMITS.eventsPerRun);
    return event;
  }
  projectChat(
    teamId: string,
    message: Omit<TeamChatMessage, "id" | "runId" | "createdAt"> & {
      createdAt?: string;
    },
  ): TeamChatMessage {
    const saved: TeamChatMessage = {
      ...message,
      id: randomUUID(),
      runId: "",
      text: message.text.slice(0, TEAM_STORE_LIMITS.chatText),
      createdAt: message.createdAt ?? new Date().toISOString(),
    };
    this.store.db
      .prepare("INSERT INTO team_project_chat(team_id,data) VALUES(?,?)")
      .run(teamId, JSON.stringify(saved));
    this.store.db
      .prepare(
        "DELETE FROM team_project_chat WHERE team_id=? AND seq <= (SELECT seq FROM team_project_chat WHERE team_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      )
      .run(teamId, teamId, TEAM_STORE_LIMITS.projectChatPerTeam);
    return saved;
  }
  projectChatMessages(teamId: string, limit = 500): TeamChatMessage[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM team_project_chat WHERE team_id=? ORDER BY seq DESC LIMIT ?",
        )
        .all(teamId, limit) as { data: string }[]
    )
      .map((r) => JSON.parse(r.data) as TeamChatMessage)
      .reverse();
  }

  updateProjectChatControl(
    teamId: string,
    messageId: string,
    control: ControlCard,
  ): TeamChatMessage | null {
    const message = this.projectChatMessages(teamId).find(
      (m) => m.id === messageId,
    );
    if (!message || message.kind !== "control") return null;
    message.control = control;
    this.store.db
      .prepare(
        "UPDATE team_project_chat SET data=? WHERE team_id=? AND json_extract(data,'$.id')=?",
      )
      .run(JSON.stringify(message), teamId, messageId);
    return message;
  }

  updateProjectChatProposal(
    teamId: string,
    messageId: string,
    proposal: ChatProposal,
  ): TeamChatMessage | null {
    const message = this.projectChatMessages(teamId).find(
      (m) => m.id === messageId,
    );
    if (!message || message.kind !== "proposal") return null;
    message.proposal = proposal;
    this.store.db
      .prepare(
        "UPDATE team_project_chat SET data=? WHERE team_id=? AND json_extract(data,'$.id')=?",
      )
      .run(JSON.stringify(message), teamId, messageId);
    return message;
  }
  chat(
    message: Omit<TeamChatMessage, "id" | "createdAt"> & { createdAt?: string },
  ): TeamChatMessage {
    const saved: TeamChatMessage = {
      ...message,
      id: randomUUID(),
      text: message.text.slice(0, TEAM_STORE_LIMITS.chatText),
      createdAt: message.createdAt ?? new Date().toISOString(),
    };
    this.store.db
      .prepare("INSERT INTO team_chat(run_id,data) VALUES(?,?)")
      .run(saved.runId, JSON.stringify(saved));
    this.store.db
      .prepare(
        "DELETE FROM team_chat WHERE run_id=? AND seq <= (SELECT seq FROM team_chat WHERE run_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      )
      .run(saved.runId, saved.runId, TEAM_STORE_LIMITS.chatPerRun);
    return saved;
  }
  chatMessages(runId: string, limit = 500): TeamChatMessage[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM team_chat WHERE run_id=? ORDER BY seq DESC LIMIT ?",
        )
        .all(runId, limit) as { data: string }[]
    )
      .map((r) => JSON.parse(r.data) as TeamChatMessage)
      .reverse();
  }

  events(runId: string, limit = 200): TeamEvent[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM team_events WHERE run_id=? ORDER BY seq DESC LIMIT ?",
        )
        .all(runId, limit) as { data: string }[]
    )
      .map((r) => JSON.parse(r.data) as TeamEvent)
      .reverse();
  }

  snapshot(runId: string): RunSnapshot | null {
    const run = this.run(runId);
    if (!run) return null;
    const tasks = this.tasks(runId);
    const usage = totalUsage(run.plannerUsage, tasks);
    const planner = run.teamId ? this.planner(run.teamId) : undefined;
    return {
      run,
      tasks,
      decisions: this.decisions(runId),
      events: this.events(runId),
      ...(usage ? { usage } : {}),
      usageBreakdown: usageBreakdown({
        run,
        tasks,
        plannerAgent: planner?.agent,
        plannerMember: planner?.name,
      }),
    };
  }

  /** Keeps at most `runsPerTeam` runs and drops finished runs past retention. */
  prune(teamId: string, now = Date.now()) {
    const cutoff = new Date(
      now - TEAM_STORE_LIMITS.retentionDays * 86_400_000,
    ).toISOString();
    this.store.db
      .prepare(
        "DELETE FROM team_runs WHERE team_id=? AND state IN ('done','failed','stopped') AND updated_at < ?",
      )
      .run(teamId, cutoff);
    this.store.db
      .prepare(
        "DELETE FROM team_runs WHERE team_id=? AND id NOT IN (SELECT id FROM team_runs WHERE team_id=? ORDER BY updated_at DESC LIMIT ?)",
      )
      .run(teamId, teamId, TEAM_STORE_LIMITS.runsPerTeam);
  }
}
