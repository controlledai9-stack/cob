import test from "node:test";
import assert from "node:assert/strict";
import {
  wordNextUp,
  summarizeDigest,
  condenseAgentText,
} from "../src/core/team/helper-presentations";

test("next-up replaces one line per bullet without changing original labels", async () => {
  const bullets = Object.freeze(["Coder: tests", "Generator: wording"]);
  const result = await wordNextUp(async (request) => {
    assert.deepEqual(request, {
      job: "next-up",
      input: JSON.stringify(bullets),
      fallback: bullets.join("\n"),
    });
    return " Write tests \r\n Improve wording ";
  }, bullets);
  assert.deepEqual(result, ["Write tests", "Improve wording"]);
  assert.deepEqual(bullets, ["Coder: tests", "Generator: wording"]);
});

test("malformed next-up wording preserves exact original bullets", async () => {
  const bullets = [" First label ", "Second label"];
  for (const text of [
    "",
    "one",
    "one\n\ntwo",
    "one\n",
    "one\ntwo\nthree",
    "x".repeat(12_001),
  ]) {
    assert.deepEqual(await wordNextUp(async () => text, bullets), bullets);
  }
  assert.deepEqual(
    await wordNextUp(async () => {
      throw new Error("unused");
    }, []),
    [],
  );
});

test("digest substitutes only supplied prose and passes exact fallback", async () => {
  const summary = "Work continued.";
  assert.equal(
    await summarizeDigest(async (request) => {
      assert.deepEqual(request, {
        job: "digest",
        input: summary,
        fallback: summary,
      });
      return "The team made progress.";
    }, summary),
    "The team made progress.",
  );
  for (const text of [summary, "", " \n ", "x".repeat(12_001)]) {
    assert.equal(await summarizeDigest(async () => text, summary), summary);
  }
});

test("condensation invokes runner only above 6000 characters", async () => {
  let calls = 0;
  const runner = async () => {
    calls++;
    return "Summary";
  };
  for (const size of [0, 5999, 6000]) {
    const text = "x".repeat(size);
    assert.equal(await condenseAgentText(runner, text, "fallback"), text);
  }
  assert.equal(calls, 0);
  const text = "x".repeat(6001);
  assert.equal(
    await condenseAgentText(
      async (request) => {
        assert.deepEqual(request, {
          job: "condense",
          input: text,
          fallback: "fallback",
        });
        return "Summary";
      },
      text,
      "fallback",
    ),
    "Summary",
  );
});

test("condensation rejects empty, excessive and non-shorter output with exact fallback", async () => {
  const text = "x".repeat(6001);
  const fallback = "  deterministic truncation\n";
  for (const output of [
    "",
    "  ",
    text,
    text + "x",
    "x".repeat(12_001),
    fallback,
  ]) {
    assert.equal(
      await condenseAgentText(async () => output, text, fallback),
      fallback,
    );
  }
});

test("all wrappers catch thrown runner failures", async () => {
  const runner = async (): Promise<string> => {
    throw new Error("runner failed");
  };
  assert.deepEqual(await wordNextUp(runner, [" one ", "two"]), [
    " one ",
    "two",
  ]);
  assert.equal(await summarizeDigest(runner, " summary \n"), " summary \n");
  assert.equal(
    await condenseAgentText(runner, "x".repeat(6001), " fallback \n"),
    " fallback \n",
  );
});
