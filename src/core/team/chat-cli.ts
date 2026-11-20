import type { CobbleService } from "../service";
import { runChatRepl } from "./chat-repl";
import type { Readable, Writable } from "node:stream";

export async function runChatCommand(
  service: CobbleService,
  opts: { project?: string } = {},
  io: { input: Readable; output: Writable } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<void> {
  const project = opts.project;
  if (project !== undefined) {
    const teams = service.store.teams();
    const team = teams.find(
      (team) => team.name.toLowerCase() === project.toLowerCase(),
    );
    if (!team)
      throw new Error(
        `Unknown project "${opts.project}". Available projects: ${teams.map((team) => team.name).join(", ") || "none"}`,
      );
    await service.action({ type: "selectTeam", teamId: team.id });
  }
  const teamId = service.activeTeam()?.id;
  if (!teamId)
    throw new Error("Select or create a project before starting chat.");
  await runChatRepl(
    {
      teamControl: (text) => service.teamControl(text),
      confirmTeamControl: (id, yes) => service.confirmTeamControl(id, yes),
      addTeamProposalToBacklog: (id) => service.addTeamProposalToBacklog(id),
      startTeamProposalItem: (id, item) =>
        service.startTeamProposalItem(id, item),
    },
    io,
    {
      teamId,
      activeTeamId: () => service.activeTeam()?.id,
      canExit: () => {
        const status = service.autopilotStatus(teamId);
        return status.active && !status.detach
          ? "Autopilot is still active in this process. Say stop before exiting."
          : null;
      },
    },
  );
}

