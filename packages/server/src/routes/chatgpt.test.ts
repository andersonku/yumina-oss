import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { db } from "../db/index.js";
import { apiKeys, user } from "../db/schema.js";
import { env } from "../lib/env.js";
import { CHATGPT_ISSUER, CHATGPT_SCOPES } from "../lib/chatgpt-oauth.js";
import { getChatGPTAccessToken, readChatGPTCredentials, encryptedChatGPTCredentials } from "../lib/chatgpt-accounts.js";
import type { AppEnv, SessionUser } from "../lib/types.js";

let currentUser: string | null = "chatgpt-fixture";
mock.module(new URL("../middleware/auth.ts", import.meta.url).href, {
  namedExports: { authMiddleware: createMiddleware<AppEnv>(async (c, next) => {
    if (!currentUser) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", { id: currentUser } as SessionUser); await next();
  }) },
});
mock.module(new URL("./messages.ts", import.meta.url).href, { namedExports: { invalidateModelCacheForUser: async () => {} } });
const { chatgptRoutes } = await import("./chatgpt.js");
const { apiKeyRoutes } = await import("./api-keys.js");
const app = new Hono().route("/api/chatgpt", chatgptRoutes).route("/api/keys", apiKeyRoutes);
const origin = "http://localhost:3000";
const call = (route: string, body?: object, method = body ? "POST" : "GET", requestOrigin = origin) => app.request(`${origin}${route}`, {
  method, headers: { origin: requestOrigin, "Content-Type": "application/json" }, ...(body && { body: JSON.stringify(body) }),
});
const json = async (response: Response): Promise<any> => response.json();

test("ChatGPT account lifecycle uses isolated browser auth, encrypted storage, serialized refresh and revocation", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "yumina-chatgpt-"));
  env.YUMINA_DATA_DIR = directory;
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await db.insert(user).values({ id: "chatgpt-fixture", email: "fixture@example.test", name: "Fixture", preferences: { preferredProvider: "private" } });
  const pair = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(pair.publicKey), alg: "RS256", kid: "chatgpt-fixture" };
  const originalFetch = globalThis.fetch;
  let authUrl = new URL(CHATGPT_ISSUER);
  let subject = "subject-one";
  let refreshes = 0;
  let revocations = 0;
  let failRevocation = false;
  let refreshRevoked = false;
  let failExchange = true;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return originalFetch(input, init);
    if (url.pathname === "/.well-known/jwks.json") return Response.json({ keys: [jwk] });
    if (url.pathname === "/.well-known/openid-configuration") return Response.json({ revocation_endpoint: `${CHATGPT_ISSUER}/revoke` });
    if (url.pathname === "/revoke") {
      revocations++;
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("token_type_hint"), "refresh_token");
      return new Response(null, { status: failRevocation ? 503 : 200 });
    }
    assert.equal(url.href, `${CHATGPT_ISSUER}/api/accounts/oauth/token`);
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("resource"), "https://api.openai.com/v1");
    if (body.get("grant_type") === "refresh_token") {
      refreshes++;
      if (refreshRevoked) return Response.json({ error: "invalid_grant" }, { status: 400 });
      assert.equal(body.get("refresh_token"), "fixture-refresh");
      assert.equal(body.get("scope"), null);
      await new Promise(resolve => setTimeout(resolve, 10));
      return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600 });
    }
    assert.equal(body.get("redirect_uri"), authUrl.searchParams.get("redirect_uri"));
    assert.ok(body.get("code_verifier"));
    assert.notEqual(body.get("client_id"), "dynamic_agent_client");
    if (failExchange) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const token = await new SignJWT({ nonce: authUrl.searchParams.get("nonce"), email: "same-email@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setSubject(subject).setIssuer(CHATGPT_ISSUER)
      .setAudience(body.get("client_id")!).setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
    return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: token,
      token_type: "Bearer", expires_in: 3600, scope: CHATGPT_SCOPES });
  });
  const login = async (accountId?: string) => {
    const response = await call("/api/chatgpt/login", { accountId });
    assert.equal(response.status, 200, await response.clone().text());
    const data = (await json(response)).data;
    authUrl = new URL(data.authorizationUrl);
    return data.id as string;
  };
  const complete = async (id: string, clientId = "oaiapp_one") => {
    const callback = new URL(authUrl.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: authUrl.searchParams.get("state")!, code: "fixture-code", client_id: clientId }).toString();
    const response = await fetch(callback);
    assert.equal(response.status, 200, await response.text());
    return (await json(await call(`/api/chatgpt/login/${id}`))).data.profileId as string;
  };

  currentUser = null;
  assert.equal((await call("/api/chatgpt/accounts")).status, 401);
  currentUser = "chatgpt-fixture";
  assert.equal((await call("/api/chatgpt/login", {}, "POST", "https://attacker.test")).status, 403);
  assert.equal((await app.request("https://remote.example/api/chatgpt/accounts")).status, 403);
  let first = await login();
  const hostId = authUrl.searchParams.get("ext_agent_host_id");
  assert.equal(authUrl.searchParams.get("client_id"), "dynamic_agent_client");
  const forged = new URL(authUrl.searchParams.get("redirect_uri")!);
  forged.search = "state=forged&code=stolen&client_id=attacker";
  assert.equal((await fetch(forged)).status, 400);
  assert.equal((await json(await call(`/api/chatgpt/login/${first}`))).data.status, "pending");
  const expiredCode = new URL(authUrl.searchParams.get("redirect_uri")!);
  expiredCode.search = new URLSearchParams({ state: authUrl.searchParams.get("state")!, code: "expired-code", client_id: "oaiapp_one" }).toString();
  assert.equal((await fetch(expiredCode)).status, 400);
  failExchange = false;
  first = await login();
  assert.equal(authUrl.searchParams.get("client_id"), "oaiapp_one", "an expired code reuses the issued registration");
  assert.equal(authUrl.searchParams.has("agent_name_hint"), false);
  const profileId = await complete(first);
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, profileId));
  assert.ok(row);
  assert.equal(row.encryptedKey.includes("fixture-access"), false);
  assert.equal(readChatGPTCredentials(row).clientId, "oaiapp_one");
  const safeAccounts = await (await call("/api/chatgpt/accounts")).text();
  assert.equal(safeAccounts.includes("fixture-access"), false);
  assert.equal(safeAccounts.includes("fixture-refresh"), false);
  assert.equal(safeAccounts.includes("same-email@example.test"), true);
  currentUser = "another-local-user";
  assert.equal((await call("/api/chatgpt/login", { accountId: profileId })).status, 404);
  assert.equal((await call(`/api/chatgpt/login/${first}`)).status, 404);
  currentUser = "chatgpt-fixture";
  assert.equal((await call("/api/keys", { provider: "chatgpt", key: "injected" })).status, 400);
  assert.equal((await call(`/api/keys/${profileId}`, { key: "injected" }, "PATCH")).status, 400);
  assert.equal((await call(`/api/keys/${profileId}`, undefined, "DELETE")).status, 400);

  await db.update(apiKeys).set(encryptedChatGPTCredentials({ ...readChatGPTCredentials(row), expiresAt: 0 })).where(eq(apiKeys.id, profileId));
  assert.deepEqual(await Promise.all([getChatGPTAccessToken(profileId), getChatGPTAccessToken(profileId)]), ["rotated-access", "rotated-access"]);
  assert.equal(refreshes, 1, "concurrent requests share one rotating refresh");
  const [refreshed] = await db.select().from(apiKeys).where(eq(apiKeys.id, profileId));
  assert.equal(readChatGPTCredentials(refreshed!).refreshToken, "rotated-refresh");
  const reauth = await login(profileId);
  assert.equal(authUrl.searchParams.get("client_id"), "oaiapp_one");
  assert.ok(authUrl.searchParams.get("id_token_hint"));
  assert.equal(authUrl.searchParams.get("ext_agent_host_id"), hostId);
  const wrongClient = new URL(authUrl.searchParams.get("redirect_uri")!);
  wrongClient.search = new URLSearchParams({ state: authUrl.searchParams.get("state")!, code: "fixture-code", client_id: "oaiapp_wrong" }).toString();
  assert.equal((await fetch(wrongClient)).status, 400);
  assert.equal((await json(await call(`/api/chatgpt/login/${reauth}`))).data.status, "error");
  assert.equal(await getChatGPTAccessToken(profileId), "rotated-access", "failed reauth preserves the active session");

  const second = await login();
  subject = "subject-two";
  const secondId = await complete(second, "oaiapp_two");
  assert.notEqual(profileId, secondId);
  const saved = (await json(await call("/api/chatgpt/accounts"))).data;
  assert.equal(saved.length, 2, "same-email registrations remain distinct");
  let result = await json(await call(`/api/chatgpt/accounts/${profileId}/disconnect`, {}));
  assert.equal(result.data.revocationConfirmed, true);
  assert.equal(revocations, 1);
  await assert.rejects(getChatGPTAccessToken(profileId), /disconnected/);
  const [signedOut] = await db.select().from(apiKeys).where(eq(apiKeys.id, profileId));
  assert.equal(readChatGPTCredentials(signedOut!).clientId, "oaiapp_one");
  assert.equal(readChatGPTCredentials(signedOut!).idToken, undefined);
  assert.deepEqual(signedOut!.metadata?.models, []);
  const returning = await login(profileId);
  assert.equal(authUrl.searchParams.get("client_id"), "oaiapp_one");
  assert.equal(authUrl.searchParams.has("id_token_hint"), false);
  subject = "subject-one";
  assert.equal(await complete(returning), profileId);
  const [reauthorized] = await db.select().from(apiKeys).where(eq(apiKeys.id, profileId));
  await db.update(apiKeys).set(encryptedChatGPTCredentials({ ...readChatGPTCredentials(reauthorized!), expiresAt: 0 })).where(eq(apiKeys.id, profileId));
  refreshRevoked = true;
  await assert.rejects(getChatGPTAccessToken(profileId), /reconnect/);
  failRevocation = true;
  result = await json(await call(`/api/chatgpt/accounts/${profileId}/disconnect`, {}));
  assert.equal(result.data.revocationConfirmed, false);
  await assert.rejects(getChatGPTAccessToken(profileId), /disconnected/);
  const pending = await login(profileId);
  assert.equal((await call(`/api/chatgpt/login/${pending}/cancel`, {})).status, 200);
  assert.equal((await call(`/api/chatgpt/login/${pending}`)).status, 404);
});
