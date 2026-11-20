import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseArgs } from "node:util";
import ts from "typescript";
import { memberModelError } from "../src/core/team/types";

const source = readFileSync("src/cli.ts", "utf8");
const optionsSource = source
  .slice(
    source.indexOf("    options: {") + "    options: ".length,
    source.indexOf("\n  });", source.indexOf("    options: {")),
  )
  .trim()
  .replace(/,$/, "");
const options = runInNewContext(`(${optionsSource})`) as Record<
  string,
  { type: "string" | "boolean"; short?: string }
>;

function members(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options,
    allowPositionals: true,
  });
  const calls: unknown[][] = [];
  const stored = [
    { name: "coder1", role: "coder", agent: "codex", model: "gpt-5.4" },
  ];
  let output: unknown;
  const branch = source.slice(
    source.indexOf('  if (sub === "members") {'),
    source.indexOf('  if (sub === "roles")'),
  );
  runInNewContext(
    ts.transpileModule(`function run() { ${branch} } run();`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
      sub: "members",
      rest: positionals,
      values,
      memberModelError,
      print: (value: unknown) => {
        output = value;
      },
      service: {
        teamMembers: () => stored,
        addTeamMember: (input: unknown) => {
          calls.push(["add", input]);
          return stored;
        },
        updateTeamMember: (name: string, patch: unknown) => {
          calls.push(["update", name, patch]);
          return stored;
        },
        removeTeamMember: (name: string) => {
          calls.push(["remove", name]);
          return [];
        },
      },
    },
  );
  return {
    calls: JSON.parse(JSON.stringify(calls)) as unknown[][],
    output,
    stored,
  };
}

test("members CLI adds model without losing existing options and lists persisted metadata", () => {
  assert.deepEqual(
    members([
      "add",
      "coder2",
      "coder",
      "codex",
      "--model",
      "org/model:latest",
      "--backup",
      "claude",
      "--full-access",
    ]).calls,
    [
      [
        "add",
        {
          name: "coder2",
          role: "coder",
          agent: "codex",
          model: "org/model:latest",
          backup: "claude",
          fullAccess: true,
        },
      ],
    ],
  );
  const list = members([]);
  assert.equal(list.output, list.stored);
  assert.deepEqual(members(["remove", "coder2"]).calls, [["remove", "coder2"]]);
  assert.match(source, /members update NAME --model NAME/);
});

test("members CLI updates and clears models and rejects invalid/missing values", () => {
  for (const model of ["claude-sonnet-4-6", "", "a".repeat(120)]) {
    assert.deepEqual(members(["update", "coder1", `--model=${model}`]).calls, [
      ["update", "coder1", { model: model || null }],
    ]);
  }
  for (const model of [
    "bad model",
    "-flag",
    "a;echo",
    "a\n",
    "a".repeat(121),
  ]) {
    for (const action of [
      ["update", "coder1"],
      ["add", "coder2", "coder", "codex"],
    ])
      assert.throws(
        () => members([...action, `--model=${model}`]),
        /Model must/,
      );
  }
  assert.throws(() => members(["update", "coder1"]), /Usage:/);
  for (const args of [
    ["update", "coder1"],
    ["add", "coder2", "coder", "codex"],
  ]) {
    assert.throws(
      () => members([...args, "--model"]),
      /argument missing|requires an argument/i,
    );
    assert.throws(
      () => members([...args, "--model", "--full-access"]),
      /ambiguous|argument/i,
    );
  }
});
