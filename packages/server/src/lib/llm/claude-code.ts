import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { claudeCodeEnabled, getClaudeCodeStatus, startClaudeCode, CLAUDE_CODE_MODELS, isClaudeCodeModel } from "../claude-code.js";
import type { GenerateParams, LLMProvider, Model, StreamChunk } from "./types.js";

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
let running = false;

export function buildClaudeCodeInput(params: GenerateParams): string {
  if (params.tools?.length || params.messages.some(message => message.role === "tool" || ("tool_calls" in message && message.tool_calls?.length))) {
    throw new Error("Claude Code in Yumina currently supports text conversations only. Select an API provider for tool calling.");
  }
  for (const message of params.messages) {
    if (Array.isArray(message.content) && message.content.some(part => part.type !== "text")) {
      throw new Error("Claude Code in Yumina currently supports text conversations only. Select another provider for images.");
    }
  }
  if (params.responseFormat?.type === "json_schema") {
    throw new Error("Claude Code in Yumina does not support JSON Schema side completions. Select an API provider for this feature.");
  }
  const input = JSON.stringify(params.messages.map(message => ({
    role: message.role,
    content: typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("\n"),
  })));
  if (Buffer.byteLength(input) > MAX_PROMPT_BYTES) throw new Error("The conversation is too large for the Claude Code CLI. Shorten the context and retry.");
  return `Continue the following Yumina interactive-fiction conversation. The JSON array contains its complete ordered history. System entries contain the application's world instructions and current state. Reply only with the next assistant message, following the world's output format. Do not describe this JSON or add a preamble.\n\n${input}\n`;
}

export class ClaudeCodeProvider implements LLMProvider {
  async listModels(): Promise<Model[]> {
    const status = await getClaudeCodeStatus();
    if (!status.ready) throw new Error(status.error ?? "Sign in through Claude Code first.");
    // These are CLI aliases, not a claim that every account has access. The
    // official CLI resolves each alias and enforces subscription permissions.
    return CLAUDE_CODE_MODELS.map(id => ({ id: `claude-code/${id}`, name: `Claude Code · ${id[0]!.toUpperCase()}${id.slice(1)}`, provider: "Claude Code", contextLength: 200_000, supportsImages: false }));
  }

  async verify() { return (await getClaudeCodeStatus()).ready; }

  async *generateStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    if (params.signal?.aborted) return;
    if (!claudeCodeEnabled()) { yield { type: "error", content: "Claude Code requires the local edition bound to localhost." }; return; }
    const model = params.model.replace(/^claude-code\//, "");
    if (!isClaudeCodeModel(model)) { yield { type: "error", content: "Choose a Claude Code model in AI settings." }; return; }
    let input: string;
    try { input = buildClaudeCodeInput(params); }
    catch (error) { yield { type: "error", content: (error as Error).message }; return; }
    if (running) { yield { type: "error", content: "Claude Code is already replying. Wait for that reply or stop it first." }; return; }
    running = true;
    let cwd: string | undefined;
    let child: Awaited<ReturnType<typeof startClaudeCode>> | undefined;
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
      const status = await getClaudeCodeStatus();
      if (params.signal?.aborted) return;
      if (!status.ready) { yield { type: "error", content: status.error ?? "Sign in through Claude Code first." }; return; }
      cwd = await mkdtemp(path.join(tmpdir(), "yumina-claude-code-"));
      child = await startClaudeCode([
        "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--model", model, "--tools", "", "--permission-mode", "dontAsk",
        "--no-session-persistence", "--disable-slash-commands", "--no-chrome",
        "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true }),
        "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
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
      child.stdin.end(input);
      let result: Record<string, any> | undefined;
      let text = "";
      let hasTextDelta = false;
      for await (const line of lines) {
        if (!line.trim()) continue;
        const item = JSON.parse(line);
        if (item.parent_tool_use_id) continue;
        if (item.type === "stream_event") {
          const event = item.event;
          if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
            if (typeof event.delta.text !== "string") throw new Error("Invalid Claude Code text delta");
            hasTextDelta = true;
            text += event.delta.text;
            if (params.stream !== false) yield { type: "text", content: event.delta.text };
          } else if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta" && params.stream !== false) {
            if (typeof event.delta.thinking !== "string") throw new Error("Invalid Claude Code reasoning delta");
            yield { type: "reasoning", content: event.delta.thinking };
          }
        } else if (item.type === "assistant" && !hasTextDelta) {
          const content = item.message?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") ?? "";
          text += content;
          if (content && params.stream !== false) yield { type: "text", content };
        } else if (item.type === "result") result = item;
      }
      const code = await closed;
      if (params.signal?.aborted) return;
      if (oversized) throw new Error("oversized");
      if (timedOut) { yield { type: "error", content: "Claude Code timed out. Try again or shorten the context." }; return; }
      if (spawnFailed || code !== 0 || !result || result.is_error || result.subtype !== "success") {
        yield { type: "error", content: "Claude Code did not finish the reply. Check claude auth status and your plan's usage limits in Terminal, then retry." }; return;
      }
      if (!text && typeof result.result === "string") {
        text = result.result;
        if (params.stream !== false && text) yield { type: "text", content: text };
      }
      if (!text) { yield { type: "error", content: "Claude Code returned an empty reply. Try another Claude Code model." }; return; }
      if (params.stream === false) yield { type: "text", content: text };
      const usage = result.usage;
      const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
      const promptTokens = count(usage?.input_tokens) + count(usage?.cache_read_input_tokens) + count(usage?.cache_creation_input_tokens);
      const completionTokens = count(usage?.output_tokens);
      yield { type: "done", content: "", stopReason: "end_turn", usage: {
        promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
        cacheReadTokens: count(usage?.cache_read_input_tokens), cacheWriteTokens: count(usage?.cache_creation_input_tokens),
      } };
    } catch {
      if (!params.signal?.aborted) yield { type: "error", content: "Claude Code could not complete the reply. Check the CLI installation and sign-in, then retry." };
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
