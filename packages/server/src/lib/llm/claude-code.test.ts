import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { GenerateParams, StreamChunk } from "./types.js";

let ready = true;
let enabled = true;
let events: object[] = [];
let exitCode = 0;
let malformed = false;
let hang = false;
let starts = 0;
let lastCwd = "";
let lastChild: ReturnType<typeof spawn>;
mock.module(new URL("../claude-code.ts", import.meta.url).href, { namedExports: {
  claudeCodeEnabled: () => enabled,
  getClaudeCodeStatus: async () => ({ ready, error: "Sign in through Claude Code first." }),
  CLAUDE_CODE_MODELS: ["sonnet", "opus", "haiku"],
  isClaudeCodeModel: (value: unknown) => ["sonnet", "opus", "haiku"].includes(String(value)),
  startClaudeCode: async (args: string[], cwd: string) => {
    starts++;
    lastCwd = cwd;
    for (const flag of ["--print", "--include-partial-messages", "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--no-chrome"]) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.equal(args[args.indexOf("--setting-sources") + 1], "");
    assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]!), { disableAllHooks: true });
    assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]!), { mcpServers: {} });
    assert.equal(args.includes("--dangerously-skip-permissions"), false);
    const output = malformed ? "not json\n" : events.map(event => JSON.stringify(event) + "\n").join("");
    const script = `process.stdin.resume(); process.stdin.on('end', () => {
      const output = ${JSON.stringify(output)};
      const bytes = Buffer.from(output);
      for (let i = 0; i < bytes.length; i += 7) process.stdout.write(bytes.subarray(i, i + 7));
      ${hang ? "setInterval(() => {}, 1000);" : `process.exitCode = ${exitCode};`}
    });`;
    lastChild = spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    return lastChild;
  },
} });
const { ClaudeCodeProvider, buildClaudeCodeInput } = await import("./claude-code.js");
const params: GenerateParams = { model: "claude-code/sonnet", messages: [{ role: "user", content: "Open the door" }] };
const collect = async (input = params) => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of new ClaudeCodeProvider().generateStream(input)) chunks.push(chunk);
  return chunks;
};
const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const success = { type: "result", subtype: "success", is_error: false, result: "The door opens.", usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } };

test("CLI transport preserves input, streams replies, fails closed and stops children", async t => {
  await t.test("ordered world instructions and conversation are supplied without shell interpolation", () => {
    const messages: GenerateParams["messages"] = [{ role: "system", content: "World" }, { role: "assistant", content: "Previous" }, { role: "system", content: [{ type: "text", text: "State" }] }, { role: "user", content: "$(touch should-not-exist) 繁體中文" }];
    const input = buildClaudeCodeInput({ ...params, messages });
    assert.deepEqual(JSON.parse(input.split("\n\n")[1]!), messages.map(message => ({ role: message.role, content: Array.isArray(message.content) ? "State" : message.content })));
  });
  await t.test("UTF-8 text deltas, reasoning and final usage are streamed once", async () => {
    events = [{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Think" } } }, delta("繁體中文"), delta(" door"), { type: "assistant", message: { content: [{ type: "text", text: "繁體中文 door" }] } }, success];
    const chunks = await collect();
    assert.deepEqual(chunks.map(chunk => chunk.type), ["reasoning", "text", "text", "done"]);
    assert.equal(chunks[1]!.content, "繁體中文");
    assert.deepEqual(chunks.at(-1)!.usage, { promptTokens: 35, completionTokens: 4, totalTokens: 39, cacheReadTokens: 20, cacheWriteTokens: 5 });
    assert.equal(existsSync(lastCwd), false);
  });
  await t.test("non-streaming callers receive one combined reply", async () => {
    events = [delta("The door "), delta("opens."), success];
    assert.deepEqual((await collect({ ...params, stream: false })).map(chunk => [chunk.type, chunk.content]), [["text", "The door opens."], ["done", ""]]);
  });
  await t.test("final result fallback works without partial messages", async () => {
    events = [success];
    assert.deepEqual((await collect()).map(chunk => chunk.type), ["text", "done"]);
    events = [{ type: "assistant", message: { content: [{ type: "text", text: "Complete" }] } }, success];
    assert.equal((await collect()).filter(chunk => chunk.type === "text").map(chunk => chunk.content).join(""), "Complete");
  });
  await t.test("malformed, incomplete and unsuccessful runs never report done", async () => {
    for (const scenario of ["malformed", "truncated", "error", "exit"] as const) {
      malformed = scenario === "malformed"; exitCode = scenario === "exit" ? 1 : 0;
      events = scenario === "truncated" ? [delta("Partial")] : scenario === "error" ? [{ ...success, is_error: true, result: "private diagnostic" }] : [success];
      const chunks = await collect();
      assert.equal(chunks.at(-1)?.type, "error", scenario);
      assert.equal(chunks.some(chunk => chunk.type === "done"), false);
      assert.equal(JSON.stringify(chunks).includes("private diagnostic"), false);
    }
    malformed = false; exitCode = 0;
    events = [{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: 123 } } }, success];
    assert.equal((await collect()).at(-1)?.type, "error");
  });
  await t.test("unsupported modalities, model injection and sign-out do not start inference", async () => {
    const before = starts;
    const inputs: GenerateParams[] = [
      { ...params, model: "claude-code/--dangerously-skip-permissions" },
      { ...params, tools: [{ type: "function", function: { name: "read", description: "read", parameters: {} } }] },
      { ...params, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] }] },
      { ...params, messages: [{ role: "tool", tool_call_id: "one", content: "answer" }] },
    ];
    for (const input of inputs) assert.equal((await collect(input))[0]!.type, "error");
    ready = false;
    assert.equal((await collect())[0]!.type, "error");
    ready = true; enabled = false;
    assert.equal((await collect())[0]!.type, "error");
    enabled = true;
    assert.equal(starts, before);
  });
  await t.test("one active generation, cancellation and early consumer return terminate the child", async () => {
    events = [delta("Partial")]; hang = true;
    const controller = new AbortController();
    const stream = new ClaudeCodeProvider().generateStream({ ...params, signal: controller.signal })[Symbol.asyncIterator]();
    assert.equal((await stream.next()).value?.content, "Partial");
    assert.match((await collect())[0]!.content, /already replying/);
    controller.abort();
    assert.equal((await stream.next()).done, true);
    assert.ok(lastChild.exitCode !== null || lastChild.signalCode !== null);
    assert.equal(existsSync(lastCwd), false);
    const early = new ClaudeCodeProvider().generateStream(params)[Symbol.asyncIterator]();
    await early.next();
    await early.return?.();
    assert.ok(lastChild.exitCode !== null || lastChild.signalCode !== null);
    hang = false; events = [success];
    assert.equal((await collect()).at(-1)!.type, "done");
  });
});
