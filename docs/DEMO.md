# Cobble in 3 minutes

A short walkthrough of what Cobble is for: you set the direction once, and a team of AI agents keeps working, asks you only when it must, and finishes the work. It runs with the agents you already have (Claude Code, Codex, Gemini CLI) or with a free local model, so nobody needs a paid account to try it.

The same five steps run automatically, with fake agents and no network, in `test/demo-flow.test.ts`.

## Before you start (1 minute)

Open the app (`npm start`), create a project with a short plan and your code folder, then pick the team:

```powershell
npm run cli -- team detect
npm run cli -- team members add planner1 planner codex
npm run cli -- team members add coder1 coder codex
```

With no paid agent, use a free local model instead: `npm run cli -- team model free ollama qwen3-coder`, and use the agent `free` for both members.

For the phone step, turn on alerts and subscribe to the shown topic in the free ntfy app:

```powershell
npm run cli -- team notify on
npm run cli -- team notify status
```

## The five steps

1. **Brief, once.** Answer five short questions: how long the team may work, hours per day, which agents, a spending limit, and the top priority.

   ```powershell
   npm run cli -- team brief
   ```

2. **Pilot.** Start it and walk away. Each cycle the planner picks the next work from the plan and the backlog, and the agents build and test it on their own branches.

   ```powershell
   npm run cli -- team pilot --parallel 2
   ```

3. **Chat.** In the app's **Team Chat**, type `status` to see who works on what, or talk to one agent: `@T1 use green for the buttons`. Anything else goes to the planner, and the chat shows when it is writing a reply.

4. **Answer from the phone.** When an agent has a question, the phone alert shows the options as buttons. Tap one; the agent continues with your answer. Production deploys and sign-ins never happen from the phone: they wait for you in the app.

5. **Finished run.** The run ends, its work is merged into `cobble/autopilot`, and the backlog item is ticked. Open **Workspace & Plan → Build plan** to see it move to **Done**, or type `status` in the chat.

## What to point out

- The user spoke three times: the brief, one chat message, one phone tap. Everything else ran on its own.
- Pilot waits out usage limits and failed turns instead of stopping, and a stuck item is marked "needs attention" while the rest continues.
- Every check is a real test command; work that fails its tests is not merged.
