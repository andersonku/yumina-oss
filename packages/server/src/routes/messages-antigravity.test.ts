import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { spawn } from "node:child_process";
import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { apiKeys, creditWallets, messages, playSessions, user, worlds } from "../db/schema.js";
import { encryptApiKey } from "../lib/crypto.js";
import { env } from "../lib/env.js";
import { normalizeGameState } from "../lib/game-state.js";
import * as cli from "../lib/antigravity.js";
import type { AppEnv } from "../lib/types.js";

let requests = 0;
mock.module(new URL("../lib/antigravity.ts", import.meta.url).href, { namedExports: {
  ...cli, getAntigravityStatus: async () => ({ ready: true, models: [{ id: "sonnet", name: "Sonnet" }] }),
  startAntigravity: async (args: string[], cwd: string) => {
    requests++;
    assert.equal(args[args.indexOf("--model") + 1], "sonnet");
    const text = `The door opens. Reply ${requests}.`;
    const output = [{ event: "step_update", step_update: { step_type: "agent_response", text_delta: text } },
      { event: "result", result: { status: "SUCCESS", response: text, usage: { input_tokens: 20, output_tokens: 10 } } }].map(item => JSON.stringify(item) + "\n").join("");
    return spawn(process.execPath, ["-e", `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(output)}));`], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  },
} });
const { messageRoutes } = await import("./messages.js");
const { completionRoutes } = await import("./completions.js");
const { resolveProviderForModel } = await import("../lib/resolve-provider.js");

test("Antigravity runs chat, regenerate, continue and text side calls without spending platform credits", async t => {
  const edition = env.YUMINA_EDITION, host = env.HOST;
  env.YUMINA_EDITION = "local"; env.HOST = undefined;
  t.after(() => { env.YUMINA_EDITION = edition; env.HOST = host; });
  const userId = crypto.randomUUID(), worldId = crypto.randomUUID(), keyId = crypto.randomUUID();
  await db.insert(user).values({ id: userId, email: `${userId}@test.local`, name: "CLI player", preferences: { activeApiKeyId: keyId } });
  const marker = encryptApiKey("local-antigravity");
  await db.insert(apiKeys).values({ id: keyId, userId, provider: "antigravity", encryptedKey: marker.encrypted, keyIv: marker.iv, keyTag: marker.tag, metadata: { models: ["sonnet"] } });
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "CLI world", description: "", author: "test", entries: [],
    variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  await db.insert(worlds).values({ id: worldId, creatorId: userId, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  const [session] = await db.insert(playSessions).values({ userId, worldId, state: normalizeGameState(world, { turnCount: 0 }) as unknown as Record<string, unknown> }).returning();
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/models", "the CLI provider must not send inference to an API provider");
    return Response.json({ data: [] });
  });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: userId } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of messageRoutes.routes.filter(route => route.method === "POST" && ["/sessions/:sessionId/messages", "/sessions/:sessionId/continue", "/messages/:id/regenerate"].includes(route.path))) app.post(route.path, route.handler);
  for (const route of completionRoutes.routes.filter(route => route.method === "POST" && route.path === "/sessions/:sessionId/completions")) app.post(route.path, route.handler);
  const post = (route: string, body: object) => app.request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "antigravity/sonnet", ...body }) });
  const reply = async (route: string, body: object) => {
    const response = await post(route, body), text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(text, /event: done/);
    assert.doesNotMatch(text, /event: error/);
  };
  assert.equal((await resolveProviderForModel(userId, "antigravity/sonnet"))?.isByok, true);
  const [before] = await db.select().from(creditWallets).where(eq(creditWallets.userId, userId));
  await reply(`/sessions/${session!.id}/messages`, { content: "Open the door" });
  const [assistant] = await db.select().from(messages).where(and(eq(messages.sessionId, session!.id), eq(messages.role, "assistant"))).orderBy(desc(messages.createdAt));
  assert.match(assistant!.content, /door opens/);
  await reply(`/messages/${assistant!.id}/regenerate`, {});
  await reply(`/sessions/${session!.id}/continue`, {});
  await reply(`/sessions/${session!.id}/completions`, { messages: [{ role: "user", content: "One sentence" }] });
  const unsupported = await post(`/sessions/${session!.id}/completions`, { messages: [{ role: "user", content: "Return JSON" }], responseFormat: { type: "json_schema", json_schema: { name: "result", strict: true, schema: { type: "object", properties: {}, additionalProperties: false } } } });
  assert.equal(unsupported.status, 400);
  assert.equal(requests, 4);
  const [after] = await db.select().from(creditWallets).where(eq(creditWallets.userId, userId));
  assert.equal(after?.balance, before?.balance);
});
