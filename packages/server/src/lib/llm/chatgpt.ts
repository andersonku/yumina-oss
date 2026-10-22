import type { GenerateParams, LLMProvider, Model, StreamChunk } from "./types.js";
import { LLM_CONNECTION_TIMEOUT_MS, LLM_REQUEST_TIMEOUT_MS, LLM_STREAM_INACTIVITY_TIMEOUT_MS } from "./constants.js";
import { registerContextWindows } from "./model-catalog.js";

const BASE = "https://api.openai.com/v1";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const activeRequests = new Map<string, Set<AbortController>>();
export function cancelChatGPTRequests(id: string): void {
  for (const request of activeRequests.get(id) ?? []) request.abort(new Error("ChatGPT disconnected. Please reconnect in AI settings."));
  activeRequests.delete(id);
}

/** The plan-usage API accepts Responses input, without sampling/output-limit
 * parameters. Keep message order, including the engine's trailing instructions. */
export function buildChatGPTBody(params: GenerateParams): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  for (const message of params.messages) {
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
      continue;
    }
    const role = message.role === "system" ? "developer" : message.role;
    const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    const content = role === "assistant" && parts.every(part => part.type === "text")
      ? parts.map(part => part.type === "text" ? part.text : "").join("\n\n")
      : parts.map(part => part.type === "text"
      ? { type: "input_text", text: part.text }
      : { type: "input_image", image_url: part.image_url.url });
    if (content.length && (typeof message.content !== "string" || message.content.length)) input.push({ role, content });
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        input.push({ type: "function_call", namespace: "yumina", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  const body: Record<string, unknown> = { model: params.model.replace(/^chatgpt\//, ""), input, store: false, stream: true };
  if (params.tools?.length) {
    body.tools = [{ type: "namespace", name: "yumina", description: "Yumina world and story tools", tools: params.tools.map(tool => ({
      type: "function", ...tool.function, strict: false,
    })) }];
    body.tool_choice = typeof params.toolChoice === "object"
      ? { type: "function", namespace: "yumina", name: params.toolChoice.function.name }
      : params.toolChoice ?? "auto";
  }
  if (params.responseFormat) body.text = { format: params.responseFormat.type === "json_schema"
    ? { type: "json_schema", ...params.responseFormat.json_schema }
    : { type: "json_object" } };
  if (params.reasoningEffort) body.reasoning = { effort: params.reasoningEffort };
  return body;
}

function requestError(status: number): string {
  if (status === 401 || status === 403) return "ChatGPT authorization is unavailable. Reconnect in AI settings and allow ChatGPT plan usage.";
  if (status === 429) return `ChatGPT usage limit reached. Manage usage: ${CHATGPT_USAGE_URL}`;
  return `ChatGPT request failed (${status}). Please try again or choose another model.`;
}

export class ChatGPTProvider implements LLMProvider {
  private readonly getToken: () => Promise<string>;
  private readonly id: string;

  constructor(serializedCredentials: string, getToken?: () => Promise<string>) {
    const { id } = JSON.parse(serializedCredentials) as { id?: string };
    if (!id) throw new Error("Invalid ChatGPT connection. Please reconnect.");
    this.id = id;
    this.getToken = getToken ?? (async () => (await import("../chatgpt-accounts.js")).getChatGPTAccessToken(id));
  }

  async listModels(): Promise<Model[]> {
    const response = await fetch(`${BASE}/models`, {
      headers: { Authorization: `Bearer ${await this.getToken()}` },
      signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    if (!response.ok) throw new Error(requestError(response.status));
    const catalog = await response.json() as { models?: Array<{
      slug?: string; display_name?: string; visibility?: string; context_window?: number;
      input_modalities?: string[];
    }> };
    const models = (catalog.models ?? []).filter(model => model.visibility === "list" && typeof model.slug === "string" && model.slug).map(model => ({
      id: `chatgpt/${model.slug}`, name: model.display_name ?? model.slug!, provider: "ChatGPT",
      contextLength: typeof model.context_window === "number" ? model.context_window : 0,
      supportsImages: model.input_modalities?.includes("image"),
    }));
    registerContextWindows(models);
    return models;
  }

  async verify(): Promise<boolean> { return (await this.listModels()).length > 0; }

  async *generateStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    const abort = new AbortController();
    const requests = activeRequests.get(this.id) ?? new Set<AbortController>();
    requests.add(abort);
    activeRequests.set(this.id, requests);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS), ...(params.signal ? [params.signal] : [])]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const token = await this.getToken();
      timer = setTimeout(() => abort.abort(), LLM_CONNECTION_TIMEOUT_MS);
      const response = await fetch(`${BASE}/responses`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildChatGPTBody(params)), signal, redirect: "error",
      });
      clearTimeout(timer);
      if (!response.ok) {
        yield { type: "error", content: requestError(response.status), retryAfterMs: response.status === 429 ? 0 : undefined };
        return;
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error("ChatGPT returned no response stream.");
      const decoder = new TextDecoder();
      let buffer = "";
      let bufferedText = "";
      const calls = new Map<string, { id: string; name: string; args: string; index: number }>();
      while (true) {
        timer = setTimeout(() => abort.abort(), LLM_STREAM_INACTIVITY_TIMEOUT_MS);
        const { value, done } = await reader.read();
        clearTimeout(timer);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data || data === "[DONE]") continue;
          const event = JSON.parse(data);
          if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
            if (params.stream === false) bufferedText += event.delta ?? "";
            else yield { type: "text", content: event.delta ?? "" };
          } else if (event.type === "response.reasoning_summary_text.delta") {
            yield { type: "reasoning", content: event.delta ?? "" };
          } else if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
            const call = { id: event.item.call_id, name: event.item.name, args: event.item.arguments ?? "", index: event.output_index };
            calls.set(event.item.id, call);
            yield { type: "tool_call_start", content: "", toolCallId: call.id, toolCallName: call.name, toolCallIndex: call.index };
          } else if (event.type === "response.function_call_arguments.delta") {
            const call = calls.get(event.item_id);
            if (call) {
              call.args += event.delta ?? "";
              yield { type: "tool_call_delta", content: event.delta ?? "", toolCallId: call.id, toolCallIndex: call.index };
            }
          } else if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
            const call = calls.get(event.item.id);
            if (call) {
              yield { type: "tool_call_end", content: "", toolCallId: call.id, toolCallIndex: call.index,
                toolCall: { id: call.id, type: "function", function: { name: call.name, arguments: event.item.arguments ?? call.args } } };
              calls.delete(event.item.id);
            }
          } else if (event.type === "response.completed") {
            if (event.response?.status !== "completed" || calls.size) throw new Error("ChatGPT response did not complete. Please try again.");
            if (params.stream === false && bufferedText) yield { type: "text", content: bufferedText };
            const usage = event.response.usage;
            yield { type: "done", content: "", stopReason: "end_turn", usage: usage ? {
              promptTokens: usage.input_tokens ?? 0, completionTokens: usage.output_tokens ?? 0, totalTokens: usage.total_tokens ?? 0,
              cacheReadTokens: usage.input_tokens_details?.cached_tokens, reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
            } : undefined };
            return;
          } else if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
            const code = event.code ?? event.error?.code ?? event.response?.error?.code;
            yield { type: "error", content: /limit|quota|rate/.test(String(code)) ? requestError(429) : "ChatGPT could not complete this response. Please try again or choose another model." };
            return;
          }
        }
      }
      yield { type: "error", content: "ChatGPT connection ended before the response completed. Please try again." };
    } catch (error) {
      if (params.signal?.aborted) return;
      yield { type: "error", content: signal.aborted ? (abort.signal.reason?.message?.startsWith("ChatGPT") ? abort.signal.reason.message : "ChatGPT request timed out. Please try again.")
        : error instanceof Error && /ChatGPT/.test(error.message) ? error.message : "Unable to connect to ChatGPT. Please try again." };
    } finally {
      requests.delete(abort);
      if (!requests.size && activeRequests.get(this.id) === requests) activeRequests.delete(this.id);
      clearTimeout(timer);
      abort.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
}
