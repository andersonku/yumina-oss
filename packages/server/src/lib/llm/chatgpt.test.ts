import assert from "node:assert/strict";
import test from "node:test";
import { buildChatGPTBody, cancelChatGPTRequests, ChatGPTProvider } from "./chatgpt.js";
import type { GenerateParams, StreamChunk } from "./types.js";

const params: GenerateParams = { model: "chatgpt/fixture-model", messages: [{ role: "user", content: "Hello" }] };
const provider = () => new ChatGPTProvider('{"id":"fixture"}', async () => "fixture-token");
const collect = async (input: GenerateParams = params) => { const chunks: StreamChunk[] = []; for await (const chunk of provider().generateStream(input)) chunks.push(chunk); return chunks; };
function stream(events: object[], split = false) {
  const bytes = new TextEncoder().encode(events.map(event => `event: ${"type" in event ? event.type : "message"}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
const completed = { type: "response.completed", response: { status: "completed", usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } } } };

test("Responses serialization preserves message order, images and tool history while omitting unsupported parameters", () => {
  const body = buildChatGPTBody({ ...params, temperature: 0.5, topP: 0.9, maxTokens: 200, messages: [
    { role: "system", content: [{ type: "text", text: "World", cache_control: { type: "ephemeral" } }] },
    { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] },
    { role: "system", content: "State" },
    { role: "assistant", content: "", tool_calls: [{ id: "call1", type: "function", function: { name: "roll", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call1", content: "6" },
  ], tools: [{ type: "function", function: { name: "roll", description: "Roll dice", parameters: { type: "object" } } }],
  toolChoice: { type: "function", function: { name: "roll" } },
  responseFormat: { type: "json_schema", json_schema: { name: "result", strict: true, schema: { type: "object" } } } });
  assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.model, "fixture-model");
  for (const unsupported of ["temperature", "top_p", "max_tokens", "max_output_tokens", "previous_response_id", "conversation"]) assert.equal(unsupported in body, false);
  assert.deepEqual(body.input, [
    { role: "developer", content: [{ type: "input_text", text: "World" }] },
    { role: "user", content: [{ type: "input_text", text: "Look" }, { type: "input_image", image_url: "data:image/png;base64,abc" }] },
    { role: "developer", content: [{ type: "input_text", text: "State" }] },
    { type: "function_call", namespace: "yumina", call_id: "call1", name: "roll", arguments: "{}" },
    { type: "function_call_output", call_id: "call1", output: "6" },
  ]);
  assert.deepEqual(body.tool_choice, { type: "function", namespace: "yumina", name: "roll" });
  assert.deepEqual(body.text, { format: { type: "json_schema", name: "result", strict: true, schema: { type: "object" } } });
});

test("streams fragmented UTF-8 text, reasoning, tools and usage through completed inference", async t => {
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-token");
    return stream([
      { type: "response.reasoning_summary_text.delta", delta: "Thinking" },
      { type: "response.output_text.delta", delta: "繁體中文" },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "item1", call_id: "call1", name: "roll", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "item1", delta: '{"sides":6}' },
      { type: "response.output_item.done", item: { type: "function_call", id: "item1", arguments: '{"sides":6}' } },
      completed,
    ], true);
  });
  const chunks = await collect();
  assert.deepEqual(chunks.map(chunk => chunk.type), ["reasoning", "text", "tool_call_start", "tool_call_delta", "tool_call_end", "done"]);
  assert.equal(chunks[1]!.content, "繁體中文");
  assert.equal(chunks[4]!.toolCall?.function.name, "roll");
  assert.equal(chunks[4]!.toolCall?.id, "call1");
  assert.equal(chunks[5]!.usage?.cacheReadTokens, 4);
  assert.equal(chunks[5]!.usage?.totalTokens, 15);
});

test("non-streaming callers receive combined text after successful streaming completion", async t => {
  t.mock.method(globalThis, "fetch", async () => stream([{ type: "response.output_text.delta", delta: "one" }, { type: "response.output_text.delta", delta: "two" }, completed]));
  const chunks = await collect({ ...params, stream: false });
  assert.deepEqual(chunks.map(chunk => [chunk.type, chunk.content]), [["text", "onetwo"], ["done", ""]]);
});

test("truncated, failed, incomplete and malformed streams never report success", async t => {
  for (const events of [
    [{ type: "response.output_text.delta", delta: "partial" }],
    [{ type: "response.failed", response: { error: { message: "secret-upstream-body" } } }],
    [{ type: "response.incomplete" }],
    [{ type: "response.completed", response: { status: "failed" } }],
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => stream(events));
    const chunks = await collect();
    assert.equal(chunks.at(-1)?.type, "error");
    assert.equal(chunks.some(chunk => chunk.type === "done"), false);
    assert.equal(JSON.stringify(chunks).includes("secret-upstream-body"), false);
    mock.mock.restore();
  }
});

test("usage limits and revoked credentials return actionable messages without exposing response bodies", async t => {
  for (const [status, expected] of [[429, /settings\/usage/], [401, /Reconnect/], [500, /try again/]] as const) {
    const mock = t.mock.method(globalThis, "fetch", async () => new Response("secret-token", { status }));
    const chunks = await collect();
    assert.match(chunks[0]!.content, expected);
    assert.equal(JSON.stringify(chunks).includes("secret-token"), false);
    mock.mock.restore();
  }
});

test("account-specific models keep server order and omit hidden catalog entries", async t => {
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
    assert.equal(String(url), "https://api.openai.com/v1/models");
    return Response.json({ models: [
      { slug: "first", display_name: "First", visibility: "list", context_window: 1000 },
      { slug: "hidden", visibility: "hide" }, { slug: "second", visibility: "list" },
    ] });
  });
  assert.deepEqual((await provider().listModels()).map(model => [model.id, model.name]), [["chatgpt/first", "First"], ["chatgpt/second", "second"]]);
});

test("disconnect stops active inference and user cancellation exits without success or error", async t => {
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
      init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
    },
  })));
  const disconnected = provider().generateStream(params)[Symbol.asyncIterator]();
  assert.equal((await disconnected.next()).value?.type, "text");
  const pending = disconnected.next();
  cancelChatGPTRequests("fixture");
  const failure = await pending;
  assert.equal(failure.value?.type, "error");
  assert.match(failure.value?.content ?? "", /disconnected/);
  assert.equal((await disconnected.next()).done, true);
  const abort = new AbortController();
  const cancelled = provider().generateStream({ ...params, signal: abort.signal })[Symbol.asyncIterator]();
  await cancelled.next();
  const next = cancelled.next();
  abort.abort();
  assert.equal((await next).done, true);
});
