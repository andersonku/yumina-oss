import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { edition } from "../edition/index.js";
import { env } from "../lib/env.js";
import type { AppEnv } from "../lib/types.js";
import { disconnectChatGPTAccount, encryptedChatGPTCredentials, getChatGPTHostId, readChatGPTCredentials } from "../lib/chatgpt-accounts.js";
import { CHATGPT_RESOURCE, applyChatGPTTokens, createChatGPTTransaction, requestChatGPTTokens, validateChatGPTCallback, verifyChatGPTIdentity, type ChatGPTCredentials } from "../lib/chatgpt-oauth.js";
import { invalidateModelCacheForUser } from "./messages.js";

export const chatgptRoutes = new Hono<AppEnv>();
chatgptRoutes.use("/*", authMiddleware);

function isLoopback(host: string) { return ["localhost", "127.0.0.1", "[::1]"].includes(host); }
interface LoginAttempt {
  id: string;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  status: "pending" | "exchanging" | "completed" | "error" | "cancelled";
  profileId?: string;
  error?: string;
  issuedClientId?: string;
}
const attempts = new Map<string, LoginAttempt>();
const starting = new Set<string>();

chatgptRoutes.use("/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (edition.name !== "local" || !isLoopback(new URL(c.req.url).hostname)) {
    return c.json({ error: "ChatGPT sign-in is available when Yumina runs on this computer. Open Yumina using localhost." }, 403);
  }
  if (c.req.method !== "GET") {
    const origin = c.req.header("origin");
    const allowed = [new URL(c.req.url).origin, new URL(env.APP_URL).origin, new URL(env.BETTER_AUTH_URL).origin];
    if (!origin || !allowed.includes(origin) || !isLoopback(new URL(origin).hostname)) return c.json({ error: "Invalid request origin" }, 403);
  }
  await next();
});

chatgptRoutes.use("/login", async (c, next) => {
  const userId = c.get("user").id;
  if (starting.has(userId)) return c.json({ error: "ChatGPT sign-in is starting. Please wait." }, 409);
  starting.add(userId);
  try { await next(); } finally { starting.delete(userId); }
});

chatgptRoutes.get("/accounts", async c => {
  const rows = await db.select().from(apiKeys).where(and(eq(apiKeys.userId, c.get("user").id), eq(apiKeys.provider, "chatgpt")));
  return c.json({ data: rows.map(row => {
    let account: ChatGPTCredentials | undefined;
    try { account = readChatGPTCredentials(row); } catch { /* Allow reconnecting a damaged connection. */ }
    return { id: row.id, label: row.label, email: account?.email, connected: !!account?.accessToken,
      models: row.metadata?.models ?? [], defaultModel: row.metadata?.defaultModel };
  }) });
});

chatgptRoutes.post("/login", async c => {
  const userId = c.get("user").id;
  const body = await c.req.json<{ accountId?: string }>();
  let previous: ChatGPTCredentials | undefined;
  if (body.accountId) {
    const [row] = await db.select().from(apiKeys).where(and(eq(apiKeys.id, body.accountId), eq(apiKeys.userId, userId), eq(apiKeys.provider, "chatgpt")));
    if (!row) return c.json({ error: "ChatGPT account not found" }, 404);
    try { previous = readChatGPTCredentials(row); } catch { return c.json({ error: "ChatGPT registration could not be read. Add a new account." }, 400); }
  }
  const existing = attempts.get(userId);
  if (existing?.status === "exchanging") return c.json({ error: "ChatGPT sign-in is completing. Please wait." }, 409);
  if (existing) { clearTimeout(existing.timer); existing.server.close(); attempts.delete(userId); }
  const hostId = await getChatGPTHostId();
  let transaction: ReturnType<typeof createChatGPTTransaction>;
  const attempt = { id: randomUUID(), status: "pending" } as LoginAttempt;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (!transaction) { res.writeHead(503).end("Sign-in is starting"); return; }
    let url: URL;
    try { url = new URL(req.url ?? "/", transaction.redirectUri); }
    catch { res.writeHead(400).end("Invalid callback URL"); return; }
    if (req.method !== "GET" || url.pathname !== "/auth/callback" || req.headers.host !== new URL(transaction.redirectUri).host) {
      res.writeHead(404).end("Not found"); return;
    }
    // Unsolicited requests cannot consume a valid pending attempt.
    if (url.searchParams.get("state") !== transaction.state || attempt.status !== "pending") {
      res.writeHead(400).end("Invalid or expired sign-in attempt."); return;
    }
    attempt.status = "exchanging";
    try {
      const { code, clientId } = validateChatGPTCallback(url, transaction);
      // A code can expire after a client was registered. Retain the issued ID
      // for a fresh authorization instead of registering another client.
      attempt.issuedClientId = clientId;
      const tokens = await requestChatGPTTokens(new URLSearchParams({
        grant_type: "authorization_code", client_id: clientId, code,
        code_verifier: transaction.verifier, redirect_uri: transaction.redirectUri, resource: CHATGPT_RESOURCE,
      }));
      if (!tokens.id_token) throw new Error("ChatGPT did not return an identity token. Please reconnect.");
      const identity = await verifyChatGPTIdentity(tokens.id_token, clientId, transaction.nonce);
      if (previous && previous.subject !== identity.subject) throw new Error("ChatGPT account did not match the selected registration.");
      if (!tokens.refresh_token) throw new Error("ChatGPT did not authorize a renewable session. Please reconnect.");
      // Reuse the exact verified registration, including after a local sign-out.
      const rows = await db.select().from(apiKeys).where(and(eq(apiKeys.userId, userId), eq(apiKeys.provider, "chatgpt")));
      const matching = rows.find(row => {
        try { const saved = readChatGPTCredentials(row); return saved.clientId === clientId && saved.subject === identity.subject; } catch { return false; }
      });
      const id = previous?.id ?? matching?.id ?? randomUUID();
      const credentials = applyChatGPTTokens({ id, clientId, ...identity, scopes: [], expiresAt: 0 }, tokens);
      if (attempts.get(userId) !== attempt) throw new Error("ChatGPT sign-in expired. Please try again.");
      const values = encryptedChatGPTCredentials(credentials);
      if (previous || matching) {
        const updated = await db.update(apiKeys).set(values).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId))).returning();
        if (!updated.length) throw new Error("ChatGPT profile was removed during sign-in. Please try again.");
      } else {
        await db.insert(apiKeys).values({ id, userId, provider: "chatgpt", label: identity.email ?? "ChatGPT account", ...values, metadata: { models: [] } });
      }
      attempt.profileId = id;
      attempt.status = "completed";
      await invalidateModelCacheForUser(userId);
      res.end("ChatGPT connected to Yumina. You can close this window and return to AI settings.");
    } catch (error) {
      attempt.status = "error";
      // All external payloads, JWT errors, and token values stay out of responses/logs.
      attempt.error = error instanceof Error && error.message.startsWith("ChatGPT") ? error.message : "ChatGPT sign-in could not be verified. Please try again.";
      res.writeHead(400).end(attempt.error);
    } finally {
      server.close();
    }
  });
  attempt.server = server;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  } catch { return c.json({ error: "Could not open the local ChatGPT callback listener. Please try again." }, 503); }
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); return c.json({ error: "Could not start ChatGPT sign-in" }, 503); }
  transaction = createChatGPTTransaction(hostId, `http://127.0.0.1:${address.port}/auth/callback`, previous,
    !body.accountId && existing?.status === "error" ? existing.issuedClientId : undefined);
  attempt.timer = setTimeout(() => {
    server.close();
    if (attempts.get(userId) === attempt) attempts.delete(userId);
  }, 10 * 60_000);
  attempt.timer.unref();
  attempts.set(userId, attempt);
  return c.json({ data: { id: attempt.id, authorizationUrl: transaction.authorizationUrl } });
});

chatgptRoutes.get("/login/:id", c => {
  const attempt = attempts.get(c.get("user").id);
  if (!attempt || attempt.id !== c.req.param("id")) return c.json({ error: "ChatGPT sign-in expired. Please try again." }, 404);
  return c.json({ data: { status: attempt.status, profileId: attempt.profileId, error: attempt.error } });
});

chatgptRoutes.post("/login/:id/cancel", c => {
  const attempt = attempts.get(c.get("user").id);
  if (!attempt || attempt.id !== c.req.param("id")) return c.json({ error: "ChatGPT sign-in not found" }, 404);
  if (attempt.status === "exchanging") return c.json({ error: "ChatGPT sign-in is completing. Please wait." }, 409);
  attempt.status = "cancelled";
  attempt.server.close();
  clearTimeout(attempt.timer);
  attempts.delete(c.get("user").id);
  return c.json({ data: { cancelled: true } });
});

chatgptRoutes.post("/accounts/:id/disconnect", async c => {
  const userId = c.get("user").id;
  const [row] = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.userId, userId), eq(apiKeys.provider, "chatgpt")));
  if (!row) return c.json({ error: "ChatGPT account not found" }, 404);
  const attempt = attempts.get(userId);
  if (attempt?.status === "exchanging") return c.json({ error: "ChatGPT sign-in is completing. Please wait." }, 409);
  if (attempt) { attempt.server.close(); clearTimeout(attempt.timer); attempts.delete(userId); }
  const revoked = await disconnectChatGPTAccount(userId, row.id);
  await invalidateModelCacheForUser(userId);
  return c.json({ data: { disconnected: true, revocationConfirmed: revoked } });
});
