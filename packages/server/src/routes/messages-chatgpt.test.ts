import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { apiKeys, creditWallets, messages, playSessions, user, worlds } from "../db/schema.js";
import { encryptedChatGPTCredentials } from "../lib/chatgpt-accounts.js";
import { resolveProviderForModel } from "../lib/resolve-provider.js";
import { normalizeGameState } from "../lib/game-state.js";
import type { AppEnv } from "../lib/types.js";
import { messageRoutes } from "./messages.js";
import { completionRoutes } from "./completions.js";

test("ChatGPT runs ordinary chat, regenerate, continue and structured side completions through real routes", async t => {
  const userId = crypto.randomUUID(), worldId = crypto.randomUUID(), keyId = crypto.randomUUID();
  await db.insert(user).values({ id: userId, email: `${userId}@test.local`, name: "ChatGPT fixture", preferences: { preferredProvider: "private", activeApiKeyId: keyId } });
  await db.insert(apiKeys).values({ id: keyId, userId, provider: "chatgpt", label: "Fixture", ...encryptedChatGPTCredentials({
    id: keyId, clientId: "oaiapp_fixture", subject: "fixture", accessToken: "fixture-access", refreshToken: "fixture-refresh",
    scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expiresAt: Date.now() + 3600_000,
  }), metadata: { models: ["fixture-model"] } });
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "ChatGPT world", description: "", author: "test", entries: [],
    variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  await db.insert(worlds).values({ id: worldId, creatorId: userId, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  const [session] = await db.insert(playSessions).values({ userId, worldId, state: normalizeGameState(world, { turnCount: 0 }) as unknown as Record<string, unknown> }).returning();
  const requests: Record<string, any>[] = [];
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url) === "https://openrouter.ai/api/v1/models") return Response.json({ data: [] });
    assert.equal(String(url), "https://api.openai.com/v1/responses", "no other inference provider is called");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-access");
    const body = JSON.parse(String(init?.body)); requests.push(body);
    assert.equal(body.store, false); assert.equal(body.stream, true);
    assert.equal(body.model, "fixture-model");
    assert.equal(body.input.some((item: any) => item.role === "system"), false);
    const content = body.text?.format ? '{"action":"wait"}' : `The door opens. Reply ${requests.length}.`;
    return new Response([
      { type: "response.output_text.delta", delta: content },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: userId } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of messageRoutes.routes.filter(route => route.method === "POST" && ["/sessions/:sessionId/messages", "/sessions/:sessionId/continue", "/messages/:id/regenerate"].includes(route.path))) app.post(route.path, route.handler);
  for (const route of completionRoutes.routes.filter(route => route.method === "POST" && route.path === "/sessions/:sessionId/completions")) app.post(route.path, route.handler);
  const post = async (route: string, body: object) => {
    const response = await app.request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "chatgpt/fixture-model", ...body }) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(text, /event: done/);
    assert.doesNotMatch(text, /event: error/);
    return text;
  };
  assert.equal((await resolveProviderForModel(userId, "chatgpt/fixture-model"))?.providerName, "chatgpt");
  const [walletBefore] = await db.select().from(creditWallets).where(eq(creditWallets.userId, userId));
  assert.equal(await resolveProviderForModel(userId, "chatgpt/fixture-model", { forceOfficial: true }), null);
  await post(`/sessions/${session!.id}/messages`, { content: "Open the door" });
  const [assistant] = await db.select().from(messages).where(and(eq(messages.sessionId, session!.id), eq(messages.role, "assistant"))).orderBy(desc(messages.createdAt));
  assert.ok(assistant);
  assert.match(assistant.content, /door opens/);
  await post(`/messages/${assistant.id}/regenerate`, {});
  await post(`/sessions/${session!.id}/continue`, {});
  await post(`/sessions/${session!.id}/completions`, { messages: [{ role: "user", content: "Return JSON" }], responseFormat: {
    type: "json_schema", json_schema: { name: "decision", strict: true, schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false } },
  } });
  assert.equal(requests.length, 4);
  assert.equal(requests[3]!.text.format.type, "json_schema");
  const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.userId, userId));
  assert.equal(wallet?.balance, walletBefore?.balance, "user-owned ChatGPT requests do not spend platform credits");
});
