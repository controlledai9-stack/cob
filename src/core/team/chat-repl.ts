import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { describeControlCommand } from "./control-commands";
import type { TeamChatMessage } from "./types";

export interface ChatReplApi {
  teamControl(text: string): Promise<{
    type?: "result" | "confirm" | "planner";
    message?: TeamChatMessage;
    reply?: TeamChatMessage;
    proposal?: TeamChatMessage;
    control?: TeamChatMessage;
    needsConfirm?: boolean;
  }>;
  confirmTeamControl(messageId: string, yes: boolean): Promise<TeamChatMessage>;
  addTeamProposalToBacklog(messageId: string): Promise<TeamChatMessage>;
  startTeamProposalItem(messageId: string, item: string): Promise<unknown>;
}

export async function runChatRepl(
  api: ChatReplApi,
  io: { input: Readable; output: Writable },
  opts: {
    teamId?: string;
    activeTeamId?: () => string | undefined;
    canExit?: () => string | null;
  } = {},
): Promise<void> {
  const lines = createInterface({ input: io.input, crlfDelay: Infinity });
  // Queue events immediately: an async iterator can lose already-buffered lines
  // while an API request is in flight and the input reaches EOF.
  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  lines.on("line", (line) => {
    queue.push(line);
    wake?.();
  });
  lines.on("close", () => {
    closed = true;
    wake?.();
  });
  const write = (text: string) => {
    io.output.write(text);
  };
  const print = (message: TeamChatMessage) => {
    write(`${message.control?.result ?? message.text}\n`);
  };
  let pending: TeamChatMessage | undefined;
  let proposal: TeamChatMessage | undefined;
  const started = new Set<string>();
  let added = false;
  const teamId = opts.teamId ?? opts.activeTeamId?.();
  const sameTeam = () => !opts.activeTeamId || opts.activeTeamId() === teamId;
  try {
    for (;;) {
      write(
        pending?.control
          ? `${describeControlCommand(pending.control.command)} [y/N] `
          : "cobble> ",
      );
      while (!queue.length && !closed)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      wake = undefined;
      const line = queue.shift();
      if (line === undefined) {
        const reason = opts.canExit?.();
        if (reason) {
          write(`${reason}\n`);
          // EOF cannot be read again. Keep the session alive until its owner
          // says outstanding work can safely be left.
          while (opts.canExit?.())
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        break;
      }
      const text = line.trim();
      if (!sameTeam()) {
        write("The active team changed. Start a new chat for that team.\n");
        pending = undefined;
        continue;
      }
      try {
        if (pending) {
          const message = pending;
          pending = undefined;
          print(
            await api.confirmTeamControl(message.id, /^(y|yes)$/i.test(text)),
          );
        } else if (/^(exit|quit)$/i.test(text)) {
          const reason = opts.canExit?.();
          if (reason) write(`${reason}\n`);
          else break;
        } else if (/^add$/i.test(text) && proposal) {
          if (added || proposal.proposal?.status === "added")
            write("Already added to backlog.\n");
          else {
            print(await api.addTeamProposalToBacklog(proposal.id));
            added = true;
          }
        } else if (/^start\s+\d+$/i.test(text) && proposal) {
          const item =
            proposal.proposal?.items?.[Number(text.split(/\s+/)[1]) - 1];
          if (!item) write("Choose a proposal item number.\n");
          else if (started.has(item)) write("This item was already started.\n");
          else {
            await api.startTeamProposalItem(proposal.id, item);
            started.add(item);
            write(`Started: ${item}\n`);
          }
        } else if (text) {
          const result = await api.teamControl(text);
          const message = result.message ?? result.control ?? result.reply;
          if (message?.control?.status === "pending") pending = message;
          else if (message) print(message);
          const nextProposal =
            result.proposal ?? (message?.proposal ? message : undefined);
          if (nextProposal) {
            proposal = nextProposal;
            added = false;
            started.clear();
            if (nextProposal !== message) print(nextProposal);
            nextProposal.proposal?.items?.forEach((item, i) =>
              write(`${i + 1}. ${item}\n`),
            );
            write("Use add to add to backlog, or start N to start an item.\n");
          }
        }
      } catch (error) {
        write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    lines.close();
  }
}
