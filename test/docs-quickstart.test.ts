import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");
const demo = readFileSync("docs/DEMO.md", "utf8");
const quickstart = readme.slice(
  readme.indexOf("## Start in 5 minutes"),
  readme.indexOf("\n## ", readme.indexOf("## Start in 5 minutes") + 5),
);
const scripts = Object.keys(
  JSON.parse(readFileSync("package.json", "utf8")).scripts,
);
const help = execFileSync(
  process.execPath,
  ["--import", "tsx", "src/cli.ts", "--help"],
  { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
);

test("the quickstart sits near the top of the README", () => {
  assert.ok(quickstart.length > 200);
  assert.ok(readme.indexOf("## Start in 5 minutes") < readme.indexOf("## Install the app"));
});

test("every command in the quickstart and DEMO.md exists", () => {
  for (const [name, text] of [["README quickstart", quickstart], ["DEMO.md", demo]] as const) {
    for (const [, script] of text.matchAll(/npm run ([\w:-]+)/g))
      assert.ok(scripts.includes(script!), `${name}: npm run ${script}`);
    for (const [, words] of text.matchAll(/npm run cli -- (team [a-z-]+(?: [a-z-]+)?)/g)) {
      const [team, sub, next] = words!.split(" ");
      const known = help.includes(`cobble ${team} ${sub} ${next}`) || help.includes(`cobble ${team} ${sub}`);
      assert.ok(known, `${name}: cobble ${words}`);
    }
  }
});

test("DEMO.md walks through the five demo steps in order", () => {
  const steps = ["Brief, once", "Pilot", "Chat", "Answer from the phone", "Finished run"];
  let at = 0;
  for (const step of steps) {
    const found = demo.indexOf(`**${step}`, at);
    assert.ok(found > at, step);
    at = found;
  }
});
