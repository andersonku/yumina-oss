import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { db } from "../db/index.js";
import { apiKeys, user } from "../db/schema.js";
import { encryptApiKey } from "./crypto.js";
import { env } from "./env.js";
import { resolveProviderForModel } from "./resolve-provider.js";

test("local accounts use saved keys for unpriced models without a private-provider preference", async t => {
  const edition = env.YUMINA_EDITION;
  t.after(() => { env.YUMINA_EDITION = edition; });
  env.YUMINA_EDITION = "local";

  for (const preferredProvider of [undefined, "official"] as const) {
    const userId = crypto.randomUUID(), keyId = crypto.randomUUID();
    await db.insert(user).values({
      id: userId, email: `${userId}@test.local`, name: "Local player",
      preferences: { activeApiKeyId: keyId, ...(preferredProvider ? { preferredProvider } : {}) },
    });
    const encrypted = encryptApiKey("synthetic-openrouter-key");
    await db.insert(apiKeys).values({
      id: keyId, userId, provider: "openrouter", encryptedKey: encrypted.encrypted,
      keyIv: encrypted.iv, keyTag: encrypted.tag,
    });
    const resolved = await resolveProviderForModel(userId, "google/not-in-platform-catalog");
    assert.equal(resolved?.providerName, "openrouter");
    assert.equal(resolved?.isByok, true);
    assert.equal(resolved?.apiKeyTier, "byok");
    assert.equal(await resolveProviderForModel(userId, "google/not-in-platform-catalog", { forceOfficial: true }), null);
  }
});
