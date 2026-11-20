import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiUsageCard } from "../src/renderer/team-usage";
import { usageFixture } from "./fixtures/usage-view";

function render(view = usageFixture, pending = false) {
  return renderToStaticMarkup(
    React.createElement(AiUsageCard, { view, pending, setStopAt() {} }),
  );
}

test("AI usage card shows each agent's usage, source, window and stop status", () => {
  const html = render();
  assert.match(html, /<h3>AI usage<\/h3>/);
  const bars = [...html.matchAll(/<div role="progressbar"[^>]*>/g)].map(
    (match) => match[0],
  );
  assert.equal(bars.length, 3);
  for (const [index, usage] of usageFixture.agents.entries()) {
    assert.ok(bars[index].includes(`aria-label="${usage.agent} usage"`));
    assert.match(bars[index], /aria-valuemin="0" aria-valuemax="100"/);
    if (usage.percent !== null)
      assert.ok(bars[index].includes(`aria-valuenow="${usage.percent}"`));
    else assert.ok(!bars[index].includes("aria-valuenow"));
  }
  assert.match(html, />42%<\/span>/);
  assert.match(html, />97%<\/span>/);
  assert.match(html, />—<\/span>/);
  assert.match(html, />5h<\/span>/);
  for (const badge of ["reported", "estimated", "stopped"])
    assert.ok(html.includes(`>${badge}</span>`));
  assert.match(html, /resets at <time dateTime="2026-11-16T12:00:00Z">/);
  assert.match(bars[1], /is-warning/);
  assert.ok(!bars[0].includes("is-warning"));
  assert.match(
    render({ ...usageFixture, stopAt: 42 }),
    /codex usage"[^>]*is-warning/,
  );
});

test("AI usage threshold has bounds and disables while pending", () => {
  const input = render().match(/<input[^>]*>/)![0];
  assert.match(input, /type="number"/);
  assert.match(input, /aria-label="Stop at percent"/);
  for (const attribute of ['min="50"', 'max="100"', 'step="1"', 'value="95"'])
    assert.ok(input.includes(attribute));
  assert.match(render(usageFixture, true), /<input[^>]*disabled=""/);
});

test("AI usage card shows an empty state without agents or a loaded view", () => {
  for (const html of [
    render({ stopAt: 95, agents: [] }),
    renderToStaticMarkup(
      React.createElement(AiUsageCard, { view: undefined, setStopAt() {} }),
    ),
  ]) {
    assert.match(html, /No usage data yet\./);
    assert.ok(!html.includes('role="progressbar"'));
  }
});

test("AI usage threshold changes and commits clamp to integers", () => {
  const calls: number[] = [];
  function input(pending = false) {
    let props: ReturnType<typeof AiUsageCard>["props"];
    function Capture() {
      const tree = AiUsageCard({
        view: usageFixture,
        pending,
        setStopAt: (value) => calls.push(value),
      });
      props = tree.props.children[1].props.children[1].props;
      return tree;
    }
    renderToStaticMarkup(React.createElement(Capture));
    return props;
  }
  const field = input();
  field.onChange({ currentTarget: { value: "7" } });
  field.onChange({ currentTarget: { value: "73.2" } });
  assert.deepEqual(calls, []);
  field.onBlur({ currentTarget: { value: "73.2" } });
  field.onBlur({ currentTarget: { value: "73" } });
  assert.deepEqual(calls, [73]);
  for (const value of ["49", "101", "94.7", "", "invalid"])
    input().onBlur({ currentTarget: { value } });
  const enter = input();
  enter.onKeyDown({ key: "a", currentTarget: { value: "80" } });
  enter.onKeyDown({ key: "Enter", currentTarget: { value: "80" } });
  enter.onBlur({ currentTarget: { value: "80" } });
  input(true).onBlur({ currentTarget: { value: "80" } });
  input(true).onKeyDown({ key: "Enter", currentTarget: { value: "80" } });
  assert.deepEqual(calls, [73, 50, 100, 80]);
});
