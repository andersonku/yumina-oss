import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys, user } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { env } from "../lib/env.js";
import { encryptApiKey } from "../lib/crypto.js";
import { antigravityEnabled, getAntigravityStatus, isAntigravityModel } from "../lib/antigravity.js";
import { invalidateModelCacheForUser } from "./messages.js";
import { isLoopbackHost } from "../lib/claude-code.js";
import type { AppEnv } from "../lib/types.js";

export const antigravityRoutes = new Hono<AppEnv>();
antigravityRoutes.use("/*", authMiddleware);
antigravityRoutes.use("/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!antigravityEnabled() || !isLoopbackHost(new URL(c.req.url).hostname)) {
    return c.json({ error: "Antigravity is available when Yumina runs on this computer, bound to localhost." }, 403);
  }
  if (c.req.method !== "GET") {
    const origin = c.req.header("origin");
    const allowed = [new URL(c.req.url).origin, new URL(env.APP_URL).origin, new URL(env.BETTER_AUTH_URL).origin, "http://localhost:5173"];
    if (!origin || !allowed.includes(origin) || !isLoopbackHost(new URL(origin).hostname)) return c.json({ error: "Invalid request origin" }, 403);
  }
  await next();
});

antigravityRoutes.get("/status", async c => {
  const [profile] = await db.select({ id: apiKeys.id, metadata: apiKeys.metadata }).from(apiKeys)
    .where(and(eq(apiKeys.userId, c.get("user").id), eq(apiKeys.provider, "antigravity")));
  const status = await getAntigravityStatus();
  const saved = profile?.metadata?.defaultModel;
  return c.json({ data: { ...status, profileId: profile?.id,
    defaultModel: status.models.some(model => model.id === saved) ? saved : status.models[0]?.id ?? "" } });
});

antigravityRoutes.post("/connect", async c => {
  const body = await c.req.json<{ model?: string }>().catch(() => null);
  const model = body?.model;
  if (!isAntigravityModel(model)) return c.json({ error: "Choose an available Antigravity model." }, 400);
  const status = await getAntigravityStatus();
  if (!status.ready) return c.json({ error: status.error }, 400);
  if (!status.models.some(item => item.id === model)) return c.json({ error: "This model is not available to your Antigravity account." }, 400);
  const userId = c.get("user").id;
  const profileId = await db.transaction(async tx => {
    const [account] = await tx.select().from(user).where(eq(user.id, userId)).for("update");
    if (!account) throw new Error("Local account not found");
    const [existing] = await tx.select({ id: apiKeys.id }).from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), eq(apiKeys.provider, "antigravity")));
    const metadata = { models: status.models.map(item => item.id), defaultModel: model };
    let id = existing?.id;
    if (id) await tx.update(apiKeys).set({ metadata }).where(eq(apiKeys.id, id));
    else {
      // This is a connection marker. Antigravity owns all authentication;
      // Yumina neither reads nor stores its credentials.
      const marker = encryptApiKey("local-antigravity");
      const [saved] = await tx.insert(apiKeys).values({ userId, provider: "antigravity", label: "Antigravity (this computer)",
        encryptedKey: marker.encrypted, keyIv: marker.iv, keyTag: marker.tag, metadata }).returning();
      id = saved!.id;
    }
    await tx.update(user).set({ preferences: { ...account.preferences, preferredProvider: "private", activeApiKeyId: id } }).where(eq(user.id, userId));
    return id;
  });
  await invalidateModelCacheForUser(userId);
  return c.json({ data: { profileId, model } });
});

antigravityRoutes.post("/disconnect", async c => {
  const userId = c.get("user").id;
  await db.transaction(async tx => {
    const [account] = await tx.select().from(user).where(eq(user.id, userId)).for("update");
    const removed = await tx.delete(apiKeys).where(and(eq(apiKeys.userId, userId), eq(apiKeys.provider, "antigravity"))).returning();
    if (account && removed.some(row => row.id === account.preferences?.activeApiKeyId)) {
      await tx.update(user).set({ preferences: { ...account.preferences, activeApiKeyId: null } }).where(eq(user.id, userId));
    }
  });
  await invalidateModelCacheForUser(userId);
  return c.json({ data: { disconnected: true } });
});
