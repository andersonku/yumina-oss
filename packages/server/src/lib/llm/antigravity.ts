import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { antigravityEnabled, getAntigravityStatus, startAntigravity, isAntigravityModel, prepareAntigravityWorkspace, ANTIGRAVITY_AGENT } from "../antigravity.js";
import type { GenerateParams, LLMProvider, Model, StreamChunk } from "./types.js";

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
let running = false;

export function buildAntigravityInput(params: GenerateParams): string {
  if (params.tools?.length || params.messages.some(message => message.role === "tool" || ("tool_calls" in message && message.tool_calls?.length))) {
    throw new Error("Antigravity in Yumina currently supports text conversations only. Select an API provider for tool calling.");
  }
  for (const message of params.messages) {
    if (Array.isArray(message.content) && message.content.some(part => part.type !== "text")) {
      throw new Error("Antigravity in Yumina currently supports text conversations only. Select another provider for images.");
    }
  }
  if (params.responseFormat?.type === "json_schema") {
    throw new Error("Antigravity in Yumina does not support JSON Schema side completions. Select an API provider for this feature.");
  }
  const input = JSON.stringify(params.messages.map(message => ({
    role: message.role,
    content: typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("\n"),
  })));
  if (Buffer.byteLength(input) > MAX_PROMPT_BYTES) throw new Error("The conversation is too large for the Antigravity CLI. Shorten the context and retry.");
  return `Continue the following Yumina interactive-fiction conversation. The JSON array contains its complete ordered history. System entries contain the application's world instructions and current state. Reply only with the next assistant message, following the world's output format. Do not describe this JSON or add a preamble.\n\n${input}\n`;
}

export class AntigravityProvider implements LLMProvider {
  async listModels(): Promise<Model[]> {
    const status = await getAntigravityStatus();
    if (!status.ready) throw new Error(status.error ?? "Sign in through Antigravity first.");
    // Fetch the current account catalog from the official CLI.
    return status.models.map(model => ({ id: `antigravity/${model.id}`, name: model.name, provider: "Antigravity", contextLength: 0, supportsImages: false }));
  }

  async verify() { return (await getAntigravityStatus()).ready; }

  async *generateStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    if (params.signal?.aborted) return;
    if (!antigravityEnabled()) { yield { type: "error", content: "Antigravity requires the local edition bound to localhost." }; return; }
    const model = params.model.replace(/^antigravity\//, "");
    if (!isAntigravityModel(model)) { yield { type: "error", content: "Choose an Antigravity model in AI settings." }; return; }
    let input: string;
    try { input = buildAntigravityInput(params); }
    catch (error) { yield { type: "error", content: (error as Error).message }; return; }
    if (running) { yield { type: "error", content: "Antigravity is already replying. Wait for that reply or stop it first." }; return; }
    running = true;
    let cwd: string | undefined;
    let child: Awaited<ReturnType<typeof startAntigravity>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let oversized = false;
    let spawnFailed = false;
    let closed: Promise<number | null> | undefined;
    let exited = false;
    let lineBytes = 0;
    const stop = () => {
      if (child && !exited && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child?.kill("SIGKILL"), 2_000);
        killTimer.unref();
      }
    };
    try {
      const status = await getAntigravityStatus();
      if (params.signal?.aborted) return;
      if (!status.ready) { yield { type: "error", content: status.error ?? "Sign in through Antigravity first." }; return; }
      cwd = await mkdtemp(path.join(tmpdir(), "yumina-antigravity-"));
      if (!status.models.some(item => item.id === model)) { yield { type: "error", content: "This Antigravity model is no longer available. Check the connection in AI settings." }; return; }
      await prepareAntigravityWorkspace(cwd);
      child = await startAntigravity([
        "--input-format", "stream-json", "--output-format", "stream-json",
        "--model", model, "--agent", ANTIGRAVITY_AGENT,
        "--disable-slash-commands", "--print-timeout", "5m",
      ], cwd);
      closed = new Promise<number | null>(resolve => {
        child!.once("error", () => { spawnFailed = true; });
        child!.once("close", code => { exited = true; resolve(code); });
      });
      // Never forward CLI diagnostics, which can include local paths or prompt
      // data, into application logs or browser errors.
      child.stderr.resume();
      child.stdin.on("error", () => { /* Early CLI exit is handled below. */ });
      child.stdout.on("data", (bytes: Buffer) => {
        for (const byte of bytes) {
          lineBytes = byte === 10 ? 0 : lineBytes + 1;
          if (lineBytes > MAX_LINE_BYTES) { oversized = true; stop(); child?.stdout.destroy(); break; }
        }
      });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      params.signal?.addEventListener("abort", stop, { once: true });
      if (params.signal?.aborted) stop();
      timer = setTimeout(() => { timedOut = true; stop(); }, REQUEST_TIMEOUT_MS);
      timer.unref();
      child.stdin.end(JSON.stringify({ event: "user", message: { content: input } }) + "\n");
      let result: Record<string, any> | undefined;
      let text = "";
      for await (const line of lines) {
        if (!line.trim()) continue;
        const item = JSON.parse(line);
        if (item.event === "step_update") {
          const step = item.step_update;
          if (step?.subagent_info || (step?.step_type === "tool" && !["finish", "manage_task"].includes(step.tool_name))) {
            throw new Error("Unexpected Antigravity tool execution");
          }
          if (step?.step_type === "agent_response" && step.text_delta !== undefined) {
            if (typeof step.text_delta !== "string") throw new Error("Invalid Antigravity text delta");
            text += step.text_delta;
            if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) throw new Error("Oversized Antigravity reply");
            if (params.stream !== false) yield { type: "text", content: step.text_delta };
          }
        } else if (item.event === "result") {
          if (result) throw new Error("Duplicate Antigravity result");
          result = item.result;
        }
      }
      const code = await closed;
      if (params.signal?.aborted) return;
      if (oversized) throw new Error("oversized");
      if (timedOut) { yield { type: "error", content: "Antigravity timed out. Try again or shorten the context." }; return; }
      if (spawnFailed || code !== 0 || !result || result.status !== "SUCCESS") {
        yield { type: "error", content: "Antigravity did not finish the reply. Check your Antigravity sign-in and usage limits in Terminal, then retry." }; return;
      }
      if (!text && typeof result.response === "string") {
        text = result.response;
        if (params.stream !== false && text) yield { type: "text", content: text };
      }
      if (!text) { yield { type: "error", content: "Antigravity returned an empty reply. Try another Antigravity model." }; return; }
      if (params.stream === false) yield { type: "text", content: text };
      const usage = result.usage;
      const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
      const promptTokens = count(usage?.input_tokens);
      const completionTokens = count(usage?.output_tokens);
      yield { type: "done", content: "", stopReason: "end_turn", usage: {
        promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
        cacheReadTokens: count(usage?.cache_read_tokens), reasoningTokens: count(usage?.thinking_tokens),
      } };
    } catch {
      if (!params.signal?.aborted) yield { type: "error", content: "Antigravity could not complete the reply. Check the CLI installation and sign-in, then retry." };
    } finally {
      params.signal?.removeEventListener("abort", stop);
      clearTimeout(timer);
      stop();
      // Wait for exit before removing the working directory or freeing the slot.
      await closed;
      clearTimeout(killTimer);
      running = false;
      if (cwd) await rm(cwd, { recursive: true, force: true });
    }
  }
}
