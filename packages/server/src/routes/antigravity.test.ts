import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys, user } from "../db/schema.js";
import { decryptApiKey } from "../lib/crypto.js";
import { env } from "../lib/env.js";
import * as cli from "../lib/antigravity.js";
import type { AppEnv, SessionUser } from "../lib/types.js";

let userId: string | null = "cli-owner";
let ready = true;
let statusChecks = 0;
mock.module(new URL("../middleware/auth.ts", import.meta.url).href, { namedExports: {
  authMiddleware: createMiddleware<AppEnv>(async (c, next) => {
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", { id: userId } as SessionUser); await next();
  }),
} });
mock.module(new URL("../lib/antigravity.ts", import.meta.url).href, { namedExports: {
  ...cli, getAntigravityStatus: async () => { statusChecks++; return { installed: true, loggedIn: ready, ready, models: [{ id: "sonnet", name: "Sonnet" }, { id: "opus", name: "Opus" }], error: ready ? undefined : "Sign in through Antigravity first." }; },
} });
mock.module(new URL("./messages.ts", import.meta.url).href, { namedExports: { invalidateModelCacheForUser: async () => {} } });
const { antigravityRoutes } = await import("./antigravity.js");
const { apiKeyRoutes } = await import("./api-keys.js");
const { resolveProviderForModel } = await import("../lib/resolve-provider.js");
const app = new Hono().route("/api/antigravity", antigravityRoutes).route("/api/keys", apiKeyRoutes);
const origin = "http://localhost:3000";
const json = async (response: Response): Promise<{ data: { profileId?: string; ready: boolean } }> => response.json() as Promise<{ data: { profileId?: string; ready: boolean } }>;
const call = (route: string, body?: object, requestOrigin = origin, method = body ? "POST" : "GET") => app.request(`${origin}${route}`, {
  method, headers: { origin: requestOrigin, "Content-Type": "application/json" }, ...(body && { body: JSON.stringify(body) }),
});

test("local CLI lifecycle preserves native login, protects profiles and never routes to official providers", async t => {
  const edition = env.YUMINA_EDITION, host = env.HOST;
  env.YUMINA_EDITION = "local"; env.HOST = undefined;
  t.after(() => { env.YUMINA_EDITION = edition; env.HOST = host; });
  await db.insert(user).values([
    { id: "cli-owner", email: "cli-owner@test.local", name: "Player", preferences: { theme: "dark" } },
    { id: "cli-other", email: "cli-other@test.local", name: "Other" },
  ]);
  userId = null;
  assert.equal((await call("/api/antigravity/status")).status, 401);
  userId = "cli-owner";
  assert.equal((await call("/api/antigravity/connect", {}, "https://attacker.test")).status, 403);
  assert.equal((await app.request("https://remote.test/api/antigravity/status")).status, 403);
  env.HOST = "0.0.0.0";
  assert.equal((await call("/api/antigravity/status")).status, 403);
  env.HOST = undefined; env.YUMINA_EDITION = "hosted";
  assert.equal((await call("/api/antigravity/status")).status, 403);
  env.YUMINA_EDITION = "local";
  assert.equal(statusChecks, 0);
  assert.equal((await call("/api/antigravity/connect", { model: "--tools Bash" })).status, 400);
  ready = false;
  assert.equal((await call("/api/antigravity/connect", { model: "sonnet" })).status, 400);
  assert.equal(await resolveProviderForModel("cli-owner", "antigravity/sonnet"), null);
  ready = true;
  let response = await call("/api/antigravity/connect", { model: "opus" });
  assert.equal(response.status, 200, await response.clone().text());
  const first = (await json(response)).data;
  const second = await json(await call("/api/antigravity/connect", { model: "sonnet" }));
  assert.equal(first.profileId, second.data.profileId);
  const rows = await db.select().from(apiKeys).where(and(eq(apiKeys.userId, "cli-owner"), eq(apiKeys.provider, "antigravity")));
  assert.equal(rows.length, 1);
  assert.equal(decryptApiKey(rows[0]!.encryptedKey, rows[0]!.keyIv, rows[0]!.keyTag), "local-antigravity");
  const [account] = await db.select().from(user).where(eq(user.id, "cli-owner"));
  assert.equal(account?.preferences?.activeApiKeyId, first.profileId);
  assert.equal(account?.preferences?.theme, "dark");
  const resolved = await resolveProviderForModel("cli-owner", "antigravity/sonnet");
  assert.equal(resolved?.providerName, "antigravity");
  assert.equal(resolved?.isByok, true);
  assert.equal(await resolveProviderForModel("cli-owner", "antigravity/sonnet", { forceOfficial: true }), null);
  assert.equal(await resolveProviderForModel("cli-owner", "antigravity/unknown", { allowOfficialFallback: true }), null);
  assert.equal(await resolveProviderForModel("cli-other", "antigravity/sonnet", { allowOfficialFallback: true }), null);
  env.YUMINA_EDITION = "hosted";
  assert.equal(await resolveProviderForModel("cli-owner", "antigravity/sonnet", { allowOfficialFallback: true }), null);
  env.YUMINA_EDITION = "local";
  assert.equal((await call("/api/keys", { provider: "antigravity", key: "token" })).status, 400);
  assert.equal((await call(`/api/keys/${first.profileId}`, { key: "token" }, origin, "PATCH")).status, 400);
  userId = "cli-other";
  const otherStatus = (await json(await call("/api/antigravity/status"))).data;
  assert.equal(otherStatus.profileId, undefined);
  await call("/api/antigravity/disconnect", {});
  assert.ok(await resolveProviderForModel("cli-owner", "antigravity/sonnet"));
  userId = "cli-owner";
  response = await call("/api/antigravity/disconnect", {});
  assert.equal(response.status, 200);
  assert.equal(await resolveProviderForModel("cli-owner", "antigravity/sonnet"), null);
  const [disconnected] = await db.select().from(user).where(eq(user.id, "cli-owner"));
  assert.equal(disconnected?.preferences?.activeApiKeyId, null);
  const status = (await json(await call("/api/antigravity/status"))).data;
  assert.equal(status.ready, true, "disconnect never signs out of the official CLI");
  assert.equal(status.profileId, undefined);
  assert.equal(JSON.stringify(status).includes("encrypted"), false);
});
