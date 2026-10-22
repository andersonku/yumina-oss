import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys, user } from "../db/schema.js";
import { CHATGPT_ISSUER, type ChatGPTCredentials } from "./chatgpt-oauth.js";
import { disconnectChatGPTAccount, encryptedChatGPTCredentials, getChatGPTAccessToken, isChatGPTDisconnecting, readChatGPTCredentials } from "./chatgpt-accounts.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function promptly<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Database operation blocked by remote revocation")), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function account() {
  const userId = crypto.randomUUID(), id = crypto.randomUUID();
  const credentials: ChatGPTCredentials = { id, clientId: "fixture-client", subject: "fixture-subject", email: "fixture@example.test",
    accessToken: "fixture-access", refreshToken: "fixture-refresh", idToken: "fixture-id", scopes: [], expiresAt: Date.now() + 3600_000 };
  await db.insert(user).values({ id: userId, email: `${userId}@test.local`, name: "Fixture" });
  await db.insert(apiKeys).values({ id, userId, provider: "chatgpt", ...encryptedChatGPTCredentials(credentials), metadata: { models: ["fixture-model"] } });
  return { userId, id, credentials };
}

test("disconnect commits local sign-out and leaves the database available during remote waits", async t => {
  for (const stage of ["discovery", "revocation"] as const) await t.test(stage, async t => {
    const { userId, id, credentials } = await account();
    const entered = deferred(), release = deferred();
    let requestToken: string | null = null;
    t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const discovery = String(input).endsWith("openid-configuration");
      if (discovery === (stage === "discovery")) { entered.resolve(); await release.promise; }
      if (discovery) return Response.json({ revocation_endpoint: `${CHATGPT_ISSUER}/revoke` });
      requestToken = new URLSearchParams(String(init?.body)).get("token");
      return new Response(null, { status: 200 });
    });
    const disconnect = disconnectChatGPTAccount(userId, id);
    try {
      await entered.promise;
      assert.equal(isChatGPTDisconnecting(id), true);
      const [row] = await promptly(db.select().from(apiKeys).where(eq(apiKeys.id, id)));
      const saved = readChatGPTCredentials(row!);
      assert.equal(saved.accessToken, undefined);
      assert.equal(saved.refreshToken, undefined);
      assert.equal(saved.idToken, undefined);
      assert.equal(saved.clientId, credentials.clientId);
      assert.equal(saved.subject, credentials.subject);
      assert.deepEqual(row!.metadata?.models, []);
      await promptly(db.update(user).set({ name: "Still responsive" }).where(eq(user.id, userId)));
      await promptly(assert.rejects(getChatGPTAccessToken(id), /disconnected/));
    } finally { release.resolve(); await disconnect; }
    assert.equal(requestToken, "fixture-refresh");
    assert.equal(isChatGPTDisconnecting(id), false);
  });
});

test("concurrent disconnects share revocation and cannot overwrite a newer session", async t => {
  const { userId, id, credentials } = await account();
  const entered = deferred(), release = deferred();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).endsWith("openid-configuration")) return Response.json({ revocation_endpoint: `${CHATGPT_ISSUER}/revoke` });
    requests++;
    assert.equal(new URLSearchParams(String(init?.body)).get("token"), "fixture-refresh");
    entered.resolve(); await release.promise;
    return new Response(null, { status: 200 });
  });
  const first = disconnectChatGPTAccount(userId, id);
  let second: Promise<boolean> | undefined;
  try {
    await entered.promise;
    second = disconnectChatGPTAccount(userId, id);
    await assert.rejects(disconnectChatGPTAccount("other-user", id), /not found/);
    // A different server process could have established a fresh session. The
    // old revocation must never write credentials after its network wait.
    await promptly(db.update(apiKeys).set(encryptedChatGPTCredentials({ ...credentials, accessToken: "new-access", refreshToken: "new-refresh" })).where(eq(apiKeys.id, id)));
  } finally { release.resolve(); }
  assert.deepEqual(await Promise.all([first, second!]), [true, true]);
  assert.equal(requests, 1);
  assert.equal(await getChatGPTAccessToken(id), "new-access");
  assert.equal(isChatGPTDisconnecting(id), false);
});

test("remote failures keep local credentials cleared and release the reconnect guard", async t => {
  const { userId, id } = await account();
  let revocations = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).endsWith("openid-configuration")) return Response.json({ revocation_endpoint: `${CHATGPT_ISSUER}/revoke` });
    revocations++;
    return new Response(null, { status: 503 });
  });
  assert.equal(await disconnectChatGPTAccount(userId, id), false);
  assert.equal(revocations, 2);
  assert.equal(isChatGPTDisconnecting(id), false);
  await assert.rejects(getChatGPTAccessToken(id), /disconnected/);
  assert.equal(await disconnectChatGPTAccount(userId, id), true, "a locally signed-out profile needs no remote request");
  assert.equal(revocations, 2);
  await assert.rejects(disconnectChatGPTAccount(userId, "missing-profile"), /not found/);
  assert.equal(isChatGPTDisconnecting("missing-profile"), false);
});
