import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys } from "../db/schema.js";
import { encryptApiKey, decryptApiKey } from "./crypto.js";
import { env } from "./env.js";
import { cancelChatGPTRequests } from "./llm/chatgpt.js";
import { CHATGPT_ISSUER, CHATGPT_RESOURCE, applyChatGPTTokens, requestChatGPTTokens, verifyChatGPTIdentity, type ChatGPTCredentials } from "./chatgpt-oauth.js";

export function readChatGPTCredentials(row: typeof apiKeys.$inferSelect): ChatGPTCredentials {
  const raw = decryptApiKey(row.encryptedKey, row.keyIv, row.keyTag);
  if (!raw) throw new Error("ChatGPT credentials could not be decrypted. Please reconnect.");
  const credentials = JSON.parse(raw) as ChatGPTCredentials;
  if (credentials.id !== row.id || !credentials.clientId || !credentials.subject) throw new Error("Invalid ChatGPT connection. Please reconnect.");
  return credentials;
}

export function encryptedChatGPTCredentials(credentials: ChatGPTCredentials) {
  const { encrypted, iv, tag } = encryptApiKey(JSON.stringify(credentials));
  return { encryptedKey: encrypted, keyIv: iv, keyTag: tag };
}

let hostPromise: Promise<string> | undefined;
export function getChatGPTHostId(): Promise<string> {
  return hostPromise ??= (async () => {
    const directory = path.resolve(env.YUMINA_DATA_DIR);
    const file = path.join(directory, "chatgpt-host-id");
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(file, `urn:uuid:${randomUUID()}`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const id = (await readFile(file, "utf8")).trim();
    if (!/^urn:uuid:[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid saved ChatGPT host identifier.");
    return id;
  })().catch(error => { hostPromise = undefined; throw error; });
}

/** Row locking also serializes rotating refresh tokens across server processes.
 * Always re-read storage: a provider instance must observe disconnects and refreshes. */
export async function getChatGPTAccessToken(id: string): Promise<string> {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.provider, "chatgpt"))).for("update");
    if (!row) throw new Error("ChatGPT is disconnected. Continue with ChatGPT in AI settings.");
    const credentials = readChatGPTCredentials(row);
    if (!credentials.accessToken) throw new Error("ChatGPT is disconnected. Continue with ChatGPT in AI settings.");
    if (credentials.expiresAt > Date.now() + 60_000) return credentials.accessToken;
    if (!credentials.refreshToken) throw new Error("ChatGPT session expired. Please reconnect in AI settings.");
    const tokens = await requestChatGPTTokens(new URLSearchParams({
      grant_type: "refresh_token", client_id: credentials.clientId,
      refresh_token: credentials.refreshToken, resource: CHATGPT_RESOURCE,
    }));
    if (tokens.id_token) {
      const identity = await verifyChatGPTIdentity(tokens.id_token, credentials.clientId);
      if (identity.subject !== credentials.subject) throw new Error("ChatGPT account changed. Please reconnect.");
    }
    const updated = applyChatGPTTokens(credentials, tokens);
    await tx.update(apiKeys).set(encryptedChatGPTCredentials(updated)).where(eq(apiKeys.id, id));
    return updated.accessToken!;
  });
}

/** Sign-out keeps the issued registration, but clears all local tokens even
 * when OpenAI cannot confirm remote revocation. */
export async function disconnectChatGPTAccount(userId: string, id: string): Promise<boolean> {
  cancelChatGPTRequests(id);
  return db.transaction(async tx => {
    const [row] = await tx.select().from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), eq(apiKeys.provider, "chatgpt"))).for("update");
    if (!row) throw new Error("ChatGPT account not found.");
    const credentials = readChatGPTCredentials(row);
    let revoked = !credentials.refreshToken;
    if (credentials.refreshToken) {
      try {
        const discovery = await fetch(`${CHATGPT_ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
        if (!discovery.ok) throw new Error("Discovery failed");
        const config = await discovery.json() as { revocation_endpoint?: string };
        const endpoint = new URL(config.revocation_endpoint ?? "");
        if (endpoint.origin !== CHATGPT_ISSUER) throw new Error("Invalid revocation endpoint");
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await fetch(endpoint, {
              method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ token: credentials.refreshToken, token_type_hint: "refresh_token", client_id: credentials.clientId }),
              signal: AbortSignal.timeout(10_000), redirect: "error",
            });
            revoked = response.status === 200;
            if (response.status < 500) break;
          } catch { /* Retry once, then report unconfirmed revocation. */ }
          if (!attempt) await new Promise(resolve => setTimeout(resolve, 250));
        }
      } catch { /* Local sign-out still completes. */ }
    }
    const cleared: ChatGPTCredentials = { id, clientId: credentials.clientId, subject: credentials.subject,
      email: credentials.email, scopes: [], expiresAt: 0 };
    await tx.update(apiKeys).set({ ...encryptedChatGPTCredentials(cleared), metadata: { models: [] } }).where(eq(apiKeys.id, id));
    cancelChatGPTRequests(id);
    return revoked;
  });
}
