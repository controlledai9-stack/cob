# UI guide: refining Cobble's interface

This repository is a snapshot of Cobble's desktop app for UI work. The app is Electron + React (TypeScript). Change how things look and feel; leave the behaviour in `src/core` to the main repository.

## Run it

```bash
npm install
npm run dev
```

`npm run dev` opens the app with live reload. To try it without touching your own data, add a scratch database:

```bash
npm run build
npx electron . --data ./scratch.sqlite
```

## Where the UI lives

| Area | Files |
| --- | --- |
| App shell, top bar, Plan Guard, Workspace & Plan | `src/renderer/main.tsx`, `src/renderer/styles.css` |
| Left sidebar | `src/renderer/app-sidebar.tsx`, `src/renderer/components/ui/sidebar.tsx` |
| Agent Team page (tabs, members, usage, setup) | `src/renderer/team-panel.tsx`, `src/renderer/team-panel.css`, `team-members.tsx`, `team-usage.tsx`, `first-run-card.tsx` |
| Chat (Your chat / Team chat, people list, messages) | `src/renderer/team-chat.tsx`, `src/renderer/components/ui/agent-chat.tsx`, `chat-scale.ts` |
| Mic in Your chat (record, offline transcription, errors) | `src/renderer/voice-input.tsx`; `.ui-mic` in `ui.css` |
| Agent avatars (role colour, shape, face; Cobble is the grey pebble) | `src/renderer/components/ui/agent-glyph.tsx` |
| Build plan panel | `src/renderer/build-plan-panel.tsx` |
| Pop-ups | `src/renderer/modal-shell.tsx` |
| Hosting dialog | `src/renderer/hosting-panel.tsx`, `hosting-panel.css` |
| Shared components and their styles | `src/renderer/components/ui/` (`ui.css` loads last and wins) |

Colours and spacing are CSS variables at the top of `styles.css` and `ui.css`; light and dark themes both read them.

## Before you push

```bash
npm run typecheck
npm test
npm run test:desktop
```

Some UI tests look for exact text or class names (for example `test/team-chat-ui.test.ts`, `test/team-ui-components.test.ts`). If you rename something on purpose, update the test with it. `npm run test:desktop` drives the real app; it must end with `COBBLE_SMOKE_OK`.

## Keep these working

- The chat box is never blocked: you can type while agents work.
- The mic and Send buttons stay in place while recording; spoken text lands in the box and is never sent on its own.
- Your chat shows one assistant, "Cobble", plus you and the people on the team. Team chat shows the agents talking to each other and has no input box.
- The sidebar collapses and the page uses the full width.
- Both themes (Light and Dark) stay readable.

## Voice in a source checkout

The mic uses Cobble's offline voice engine, which is not stored in git. Run `npm run prepare:runtime` once (it downloads whisper.cpp and its small speech model, checksum-verified, into `resources/`). Without it the mic says the voice engine isn't installed.
