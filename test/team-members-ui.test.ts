import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MembersTable } from "../src/renderer/team-members";
import { author } from "../src/renderer/team-chat";
import * as memberTypes from "../src/core/team/types";
import type {
  DesktopApi,
  TeamMember,
  TeamChatMessage,
} from "../src/shared/types";

const members: TeamMember[] = [
  { name: "planner1", role: "planner", agent: "claude" },
  {
    name: "coder1",
    role: "coder",
    agent: "codex",
    backup: "claude",
    fullAccess: true,
  },
  { name: "coder2", role: "coder", agent: "gemini" },
  { name: "researcher1", role: "researcher", agent: "free" },
  { name: "reviewer1", role: "reviewer", agent: "codex" },
  { name: "generator1", role: "generator", agent: "gemini" },
  { name: "deployer1", role: "deployer", agent: "claude" },
];

function render(pending = false, roster: TeamMember[] | undefined = members) {
  return renderToStaticMarkup(
    React.createElement(MembersTable, {
      members: roster,
      pending,
      add: async () => {},
      update: () => {},
      remove: () => {},
    }),
  );
}

test("Members table preserves multiple members of a role and exposes member controls", () => {
  const html = render();
  for (const label of [
    "Name",
    "Role",
    "Agent",
    "Model",
    "Backup",
    "Full access",
    "Remove",
  ])
    assert.ok(html.includes(`<th scope="col">${label}</th>`));
  for (const member of members) {
    assert.ok(html.includes(`<th scope="row">${member.name}</th>`));
    assert.ok(html.includes(`aria-label="${member.name} agent"`));
    assert.ok(html.includes(`aria-label="${member.name} backup agent"`));
    assert.ok(html.includes(`aria-label="Remove ${member.name}"`));
  }
  assert.match(
    html,
    /aria-label="coder1 backup agent"[^>]*>[\s\S]*?<option value="">None<\/option><option value="claude" selected=""/,
  );
  assert.match(
    html,
    /aria-label="New member role"[\s\S]*?<option value="researcher">researcher<\/option>/,
  );
  assert.match(html, /aria-label="New member name"/);
  assert.match(html, />Add member<\/button>/);
});

test("Member selects use friendly labels and exclude their own agent from backups", () => {
  const html = render();
  for (const label of [
    "Claude",
    "Codex",
    "Gemini",
    "Claude API",
    "Free / local model",
  ])
    assert.ok(html.includes(`>${label}</option>`));
  for (const member of members) {
    const backup = html.match(
      new RegExp(
        `aria-label="${member.name} backup agent"[^>]*>([\\s\\S]*?)</select>`,
      ),
    )![1];
    assert.ok(!backup.includes(`value="${member.agent}"`));
    assert.match(backup, /value=""(?: selected="")?>None<\/option>/);
  }
});

test("Member installation badges use detection results per assigned agent", () => {
  const html = renderToStaticMarkup(
    React.createElement(MembersTable, {
      members,
      detected: [
        { agent: "codex", installed: false },
        { agent: "claude", installed: true },
      ],
      pending: false,
      add: async () => {},
      update: () => {},
      remove: () => {},
    }),
  );
  assert.equal((html.match(/Codex is not installed/g) ?? []).length, 2);
  for (const name of ["coder1", "reviewer1"])
    assert.match(
      html,
      new RegExp(
        `<th scope="row">${name}</th>(?:(?!</tr>)[\\s\\S])*Codex is not installed`,
      ),
    );
  assert.ok(!html.includes("Claude is not installed"));
  assert.ok(!html.includes("Gemini is not installed"));
  assert.ok(!render().includes("is not installed"));
});

test("Full access is editable only for writing members and controls disable while saving", () => {
  const html = render();
  for (const name of ["coder1", "coder2", "generator1", "deployer1"])
    assert.ok(html.includes(`aria-label="Full access for ${name}"`));
  for (const name of ["planner1", "researcher1", "reviewer1"])
    assert.ok(!html.includes(`aria-label="Full access for ${name}"`));
  assert.match(html, /aria-label="Full access for coder1" checked=""/);
  assert.match(html, /aria-label="Full access for coder2"\/>/);
  for (const control of render(true).matchAll(
    /<(?:select|input|button)\b[^>]*>/g,
  ))
    assert.match(control[0], /disabled=""/);
  assert.match(render(false, undefined), /Add member/);
});

test("Chat author shows named members while preserving agent and human labels", () => {
  const message: TeamChatMessage = {
    id: "m",
    runId: "r",
    author: "agent",
    agent: "codex",
    role: "coder",
    member: "coder2",
    taskId: "T1",
    kind: "message",
    text: "Ready",
    createdAt: "2026-11-14T00:00:00Z",
  };
  assert.equal(author(message), "coder2 (Codex) · coder · T1");
  assert.equal(author({ ...message, member: undefined }), "Codex · coder · T1");
  assert.equal(
    author({ ...message, agentLabel: "Local Codex" }),
    "coder2 (Local Codex) · coder · T1",
  );
  assert.equal(
    author({ ...message, author: "user", memberName: "Aarya" }),
    "Aarya",
  );
});

test("Member controls send named updates, removals and validated additions", async () => {
  // Exercise handlers with a small state host; no browser or DOM dependency is needed.
  const state: unknown[] = [];
  let cursor = 0;
  const exports: { MembersTable?: typeof MembersTable } = {};
  const source = ts.transpileModule(
    readFileSync("src/renderer/team-members.tsx", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  runInNewContext(source, {
    exports,
    require: (id: string) => {
      if (id === "react")
        return {
          useState: (initial: unknown) => {
            const index = cursor++;
            if (!(index in state)) state[index] = initial;
            return [
              state[index],
              (next: unknown) => {
                state[index] = next;
              },
            ];
          },
        };
      if (id === "react/jsx-runtime")
        return {
          Fragment: React.Fragment,
          jsx: (type: React.ElementType, props: object) =>
            React.createElement(type, props),
          jsxs: (type: React.ElementType, props: object) =>
            React.createElement(type, props),
        };
      if (id === "../core/team/types") return memberTypes;
      throw new Error(`Unexpected import ${id}`);
    },
  });
  const calls: unknown[][] = [];
  let addError = "";
  function tree() {
    cursor = 0;
    return exports.MembersTable!({
      members,
      pending: false,
      update: (...args) => {
        calls.push(["update", ...args]);
      },
      remove: (...args) => {
        calls.push(["remove", ...args]);
      },
      add: async (...args) => {
        if (addError) throw addError;
        calls.push(["add", ...args]);
      },
    });
  }
  type Props = {
    "aria-label"?: string;
    children?: React.ReactNode;
    value?: string;
    role?: string;
    onChange: (event: {
      currentTarget: { value?: string; checked?: boolean };
    }) => void;
    onBlur: () => void;
    onClick: () => void;
    onSubmit: (event: { preventDefault: () => void }) => Promise<void>;
  };
  function find(label: string, node: unknown = tree()): Props | undefined {
    if (Array.isArray(node))
      return node.map((child) => find(label, child)).find(Boolean);
    if (!React.isValidElement<Props>(node)) return undefined;
    if (node.props["aria-label"] === label || node.type === label)
      return node.props;
    return find(label, node.props.children ?? null);
  }
  find("coder2 agent")!.onChange({ currentTarget: { value: "claude" } });
  find("coder2 backup agent")!.onChange({ currentTarget: { value: "" } });
  find("Full access for coder2")!.onChange({
    currentTarget: { checked: true },
  });
  find("Remove coder2")!.onClick();
  for (const name of ["", "Coder3", "planner", "codex", "t12", "coder1"]) {
    find("New member name")!.onChange({ currentTarget: { value: name } });
    find("form")!.onSubmit({ preventDefault() {} });
  }
  assert.equal(
    calls.length,
    4,
    "invalid or duplicate names must not reach the service",
  );
  find("New member model")!.onChange({ currentTarget: { value: "bad model" } });
  find("New member name")!.onChange({ currentTarget: { value: "coder3" } });
  await find("form")!.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 4);
  assert.equal(find("p")!.role, "alert");
  find("New member model")!.onChange({ currentTarget: { value: "gpt-5.4" } });
  await find("form")!.onSubmit({ preventDefault() {} });
  assert.equal(find("New member model")!.value, "");
  find("New member name")!.onChange({
    currentTarget: { value: "researcher2" },
  });
  find("New member role")!.onChange({ currentTarget: { value: "researcher" } });
  find("New member agent")!.onChange({ currentTarget: { value: "free" } });
  await find("form")!.onSubmit({ preventDefault() {} });
  assert.equal(find("New member name")!.value, "");
  addError = "Member name is already taken";
  find("New member name")!.onChange({ currentTarget: { value: "coder3" } });
  await find("form")!.onSubmit({ preventDefault() {} });
  assert.equal(find("New member name")!.value, "coder3");
  assert.equal(find("p")!.children, addError);
  assert.equal(find("p")!.role, "alert");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["update", "coder2", { agent: "claude" }],
    ["update", "coder2", { backup: null }],
    ["update", "coder2", { fullAccess: true }],
    ["remove", "coder2"],
    [
      "add",
      { name: "coder3", role: "coder", agent: "codex", model: "gpt-5.4" },
    ],
    ["add", { name: "researcher2", role: "researcher", agent: "free" }],
  ]);
});

test("Preload exposes the member IPC contract with arguments unchanged", async () => {
  const calls: unknown[][] = [];
  let api!: DesktopApi;
  const source = readFileSync("src/main/preload.ts", "utf8");
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
      exports: {},
      require: (id: string) => {
        assert.equal(id, "electron");
        return {
          contextBridge: {
            exposeInMainWorld: (_: string, value: DesktopApi) => {
              api = value;
            },
          },
          ipcRenderer: {
            invoke: async (...args: unknown[]) => {
              calls.push(args);
              return members;
            },
          },
        };
      },
    },
  );
  const input = { name: "coder3", role: "coder", agent: "codex" };
  const patch = { backup: null, fullAccess: true };
  assert.equal(await api.teamMembers!(), members);
  assert.equal(await api.addTeamMember!(input), members);
  assert.equal(await api.updateTeamMember!("coder2", patch), members);
  assert.equal(await api.removeTeamMember!("coder2"), members);
  assert.deepEqual(calls, [
    ["cobble:team-members"],
    ["cobble:team-member-add", input],
    ["cobble:team-member-update", "coder2", patch],
    ["cobble:team-member-remove", "coder2"],
  ]);
  const main = readFileSync("src/main/main.ts", "utf8");
  for (const channel of [
    "team-members",
    "team-member-add",
    "team-member-update",
    "team-member-remove",
  ])
    assert.match(main, new RegExp(`handle\\(\\s*"${channel}"`));
});

test("Member IPC rejects non-object payloads before calling the service", () => {
  const main = readFileSync("src/main/main.ts", "utf8");
  const source = main.slice(
    main.indexOf("      const isPlainTeamRequest ="),
    main.indexOf('      handle("team-member-remove"'),
  );
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const calls: unknown[][] = [];
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
      Object,
      handle: (channel: string, handler: (...args: any[]) => unknown) =>
        handlers.set(channel, handler),
      text: (value: unknown) => value,
      service: {
        teamMembers: () => members,
        addTeamMember: (input: unknown) => calls.push([input]),
        updateTeamMember: (name: unknown, patch: unknown) =>
          calls.push([name, patch]),
      },
    },
  );
  for (const payload of [
    null,
    undefined,
    [],
    "name",
    1,
    true,
    new Date(),
    Object.create({}),
  ]) {
    assert.throws(
      () => handlers.get("team-member-add")!(null, payload),
      /Invalid team request/,
    );
    assert.throws(
      () => handlers.get("team-member-update")!(null, "coder1", payload),
      /Invalid team request/,
    );
  }
  assert.equal(calls.length, 0);
  const input = { name: "coder3", role: "coder", agent: "codex" };
  const patch = { backup: null };
  handlers.get("team-member-add")!(null, input);
  handlers.get("team-member-update")!(null, "coder1", patch);
  assert.deepEqual(calls, [[input], ["coder1", patch]]);
});

test("Member model fields show CLI models and defer free/API settings", () => {
  const roster = [
    { name: "coder1", role: "coder", agent: "codex", model: "gpt-5.4" },
    { name: "local1", role: "coder", agent: "free", model: "ignored" },
    { name: "api1", role: "coder", agent: "claude-api" },
  ] satisfies (TeamMember & { model?: string })[];
  const html = render(false, roster);
  assert.match(html, /aria-label="coder1 model"[^>]*value="gpt-5.4"/);
  assert.ok(!html.includes('aria-label="local1 model"'));
  assert.ok(!html.includes('aria-label="api1 model"'));
  assert.equal(
    (html.match(/Uses existing provider model settings/g) ?? []).length,
    2,
  );
  assert.match(html, /aria-label="New member model"/);
});

test("Member model edits validate before updating and blank clears", () => {
  type Field = {
    value: string;
    "aria-invalid": boolean;
    onChange: (event: { currentTarget: { value: string } }) => void;
    onBlur: () => void;
  };
  type Editor = (props: {
    member: TeamMember & { model?: string };
    disabled: boolean;
    update: (name: string, patch: object) => void;
  }) => React.ReactElement<{ children: React.ReactNode }>;
  const exports: { MemberModel?: Editor } = {};
  let draft: unknown;
  const source =
    readFileSync("src/renderer/team-members.tsx", "utf8") +
    "\nexport { MemberModel };";
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText,
    {
      exports,
      require: (id: string) => {
        if (id === "react")
          return {
            useState: () => [
              draft,
              (value: unknown) => {
                draft = value;
              },
            ],
          };
        if (id === "../core/team/types") return memberTypes;
        if (id === "react/jsx-runtime")
          return {
            Fragment: React.Fragment,
            jsx: (type: React.ElementType, props: object) =>
              React.createElement(type, props),
            jsxs: (type: React.ElementType, props: object) =>
              React.createElement(type, props),
          };
        throw new Error(`Unexpected import ${id}`);
      },
    },
  );
  const calls: unknown[][] = [];
  const field = () => {
    const tree = exports.MemberModel!({
      member: {
        name: "coder1",
        role: "coder",
        agent: "codex",
        model: "original",
      },
      disabled: false,
      update: (...args) => {
        calls.push(args);
      },
    });
    const input = React.Children.toArray(tree.props.children).find(
      (child) => React.isValidElement(child) && child.type === "input",
    );
    assert.ok(React.isValidElement<Field>(input));
    return input.props;
  };
  assert.equal(field().value, "original");
  field().onChange({ currentTarget: { value: "bad model" } });
  assert.equal(field()["aria-invalid"], true);
  field().onBlur();
  assert.equal(calls.length, 0);
  const fullModel = "org/model:" + "a".repeat(110);
  field().onChange({ currentTarget: { value: fullModel } });
  assert.equal(field().value, fullModel);
  field().onBlur();
  field().onChange({ currentTarget: { value: "" } });
  field().onBlur();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["coder1", { model: fullModel }],
    ["coder1", { model: null }],
  ]);
});
