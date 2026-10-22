import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as cli from "../antigravity.js";
import type { GenerateParams, StreamChunk } from "./types.js";

let ready = true, enabled = true, hang = false, malformed = false;
let events: object[] = [], exitCode = 0, starts = 0, lastCwd = "";
mock.module(new URL("../antigravity.ts", import.meta.url).href, { namedExports: {
  ...cli, antigravityEnabled: () => enabled,
  getAntigravityStatus: async () => ({ ready, models: [{ id: "gemini-test", name: "Gemini Test" }] }),
  startAntigravity: async (args: string[], cwd: string) => {
    starts++; lastCwd = cwd;
    assert.equal(args[args.indexOf("--model") + 1], "gemini-test");
    assert.equal(args[args.indexOf("--agent") + 1], cli.ANTIGRAVITY_AGENT);
    assert.ok(args.includes("--disable-slash-commands"));
    assert.equal(args.includes("--dangerously-skip-permissions"), false);
    assert.match(readFileSync(`${cwd}/.agents/agents/${cli.ANTIGRAVITY_AGENT}.md`, "utf8"), /tools: \[finish\]/);
    const output = malformed ? "invalid\n" : events.map(event => JSON.stringify(event) + "\n").join("");
    return spawn(process.execPath, ["-e", `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => input += value); process.stdin.on('end', () => {
      const message = JSON.parse(input); if (message.event !== 'user' || !message.message.content.includes('Open the door')) process.exit(9);
      const bytes = Buffer.from(${JSON.stringify(output)}); for (let i = 0; i < bytes.length; i += 7) process.stdout.write(bytes.subarray(i, i + 7));
      ${hang ? "setInterval(() => {}, 1000);" : `process.exitCode = ${exitCode};`}
    });`], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  },
} });
const { AntigravityProvider, buildAntigravityInput } = await import("./antigravity.js");
const params: GenerateParams = { model: "antigravity/gemini-test", messages: [{ role: "system", content: "World" }, { role: "user", content: "Open the door" }] };
const delta = (text: string) => ({ event: "step_update", step_update: { step_type: "agent_response", text_delta: text } });
const success = { event: "result", result: { status: "SUCCESS", response: "The door opens.", usage: { input_tokens: 30, output_tokens: 4, cache_read_tokens: 20, thinking_tokens: 2 } } };
const collect = async (input = params) => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of new AntigravityProvider().generateStream(input)) chunks.push(chunk);
  return chunks;
};

test("Antigravity streams official CLI events, validates completion and cancels safely", async t => {
  await t.test("preserves ordered world instructions and UTF-8 deltas", async () => {
    assert.deepEqual(JSON.parse(buildAntigravityInput(params).split("\n\n")[1]!), params.messages);
    events = [delta("繁體中文 "), delta("door opens."), success];
    const chunks = await collect();
    assert.deepEqual(chunks.map(chunk => chunk.type), ["text", "text", "done"]);
    assert.equal(chunks[0]!.content, "繁體中文 ");
    assert.deepEqual(chunks.at(-1)!.usage, { promptTokens: 30, completionTokens: 4, totalTokens: 34, cacheReadTokens: 20, reasoningTokens: 2 });
    assert.equal(existsSync(lastCwd), false);
  });
  await t.test("supports non-streaming and final-result-only output", async () => {
    events = [delta("The door "), delta("opens."), success];
    assert.deepEqual((await collect({ ...params, stream: false })).map(chunk => [chunk.type, chunk.content]), [["text", "The door opens."], ["done", ""]]);
    events = [success];
    assert.equal((await collect())[0]!.content, "The door opens.");
  });
  await t.test("rejects malformed, incomplete, timed-out and failed output without leaking diagnostics", async () => {
    for (const scenario of ["malformed", "truncated", "failed", "exit", "tool", "timeout"] as const) {
      malformed = scenario === "malformed"; exitCode = scenario === "exit" ? 1 : 0;
      events = scenario === "truncated" ? [delta("Partial")]
        : scenario === "tool" ? [{ event: "step_update", step_update: { step_type: "tool", tool_name: "run_command" } }]
        : scenario === "failed" || scenario === "timeout" ? [{ event: "result", result: { status: scenario === "failed" ? "ERROR" : "RUNNING", error: "private diagnostic" } }] : [success];
      const chunks = await collect();
      assert.equal(chunks.at(-1)?.type, "error", scenario);
      assert.equal(chunks.some(chunk => chunk.type === "done"), false);
      assert.equal(JSON.stringify(chunks).includes("private diagnostic"), false);
    }
    malformed = false; exitCode = 0;
  });
  await t.test("rejects unavailable models, images, tool calls and disconnected sessions", async () => {
    const before = starts;
    for (const input of [
      { ...params, model: "antigravity/--flag" }, { ...params, model: "antigravity/unavailable" },
      { ...params, tools: [{ type: "function" as const, function: { name: "read", description: "read", parameters: {} } }] },
      { ...params, messages: [{ role: "user" as const, content: [{ type: "image_url" as const, image_url: { url: "private" } }] }] },
    ]) assert.equal((await collect(input))[0]!.type, "error");
    ready = false; assert.equal((await collect())[0]!.type, "error"); ready = true;
    enabled = false; assert.equal((await collect())[0]!.type, "error"); enabled = true;
    assert.equal(starts, before);
  });
  await t.test("abort kills the child and releases its working directory", async () => {
    events = [delta("Partial")]; hang = true;
    const controller = new AbortController();
    for await (const chunk of new AntigravityProvider().generateStream({ ...params, signal: controller.signal })) {
      assert.equal(chunk.type, "text"); controller.abort();
    }
    assert.equal(existsSync(lastCwd), false); hang = false;
    events = [success]; assert.equal((await collect()).at(-1)!.type, "done");
  });
});
