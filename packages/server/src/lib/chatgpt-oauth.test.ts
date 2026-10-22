import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { CHATGPT_ISSUER, applyChatGPTTokens, createChatGPTTransaction, validateChatGPTCallback, verifyChatGPTIdentity, type ChatGPTCredentials } from "./chatgpt-oauth.js";

const registration: ChatGPTCredentials = { id: "profile", clientId: "oaiapp_fixture", subject: "user", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expiresAt: 0 };

test("registration uses fresh state, nonce and PKCE, with a stable host ID", () => {
  const first = createChatGPTTransaction("urn:uuid:host", "http://127.0.0.1:54321/auth/callback");
  const second = createChatGPTTransaction("urn:uuid:host", first.redirectUri);
  const url = new URL(first.authorizationUrl);
  assert.equal(url.origin, CHATGPT_ISSUER);
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("agent_name_hint"), "Yumina");
  assert.equal(url.searchParams.get("ext_agent_host_id"), "urn:uuid:host");
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(first.verifier).digest("base64url"));
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.verifier, second.verifier);
  assert.equal(url.searchParams.get("redirect_uri"), first.redirectUri);
});

test("callback rejects forged state, denied consent, missing client IDs and changed registrations", () => {
  const transaction = createChatGPTTransaction("host", "http://127.0.0.1:1234/auth/callback");
  const callback = new URL(transaction.redirectUri);
  callback.search = new URLSearchParams({ code: "code", state: transaction.state, client_id: "oaiapp_new" }).toString();
  assert.deepEqual(validateChatGPTCallback(callback, transaction), { code: "code", clientId: "oaiapp_new" });
  callback.searchParams.set("state", "forged");
  assert.throws(() => validateChatGPTCallback(callback, transaction), /state/);
  callback.searchParams.set("state", transaction.state);
  callback.searchParams.set("error", "access_denied");
  assert.throws(() => validateChatGPTCallback(callback, transaction), /declined/);
  callback.searchParams.delete("error");
  callback.searchParams.delete("client_id");
  assert.throws(() => validateChatGPTCallback(callback, transaction), /incomplete/);
  const returning = createChatGPTTransaction("host", transaction.redirectUri, { ...registration, idToken: "retained", email: "test@example.test" });
  const auth = new URL(returning.authorizationUrl);
  assert.equal(auth.searchParams.get("client_id"), registration.clientId);
  assert.equal(auth.searchParams.get("id_token_hint"), "retained");
  assert.equal(auth.searchParams.has("agent_name_hint"), false);
  callback.searchParams.set("state", returning.state);
  assert.equal(validateChatGPTCallback(callback, returning).clientId, registration.clientId);
  callback.searchParams.set("client_id", "oaiapp_someone_else");
  assert.throws(() => validateChatGPTCallback(callback, returning), /did not match/);
  const retry = createChatGPTTransaction("host", transaction.redirectUri, undefined, "oaiapp_issued_before_expired_code");
  assert.equal(new URL(retry.authorizationUrl).searchParams.has("agent_name_hint"), false);
  callback.searchParams.set("state", retry.state);
  callback.searchParams.delete("client_id");
  assert.equal(validateChatGPTCallback(callback, retry).clientId, "oaiapp_issued_before_expired_code");
});

test("identity validation verifies signature, issuer, audience, expiry and nonce", async () => {
  const pair = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "fixture", alg: "RS256" }] });
  const signed = (claims: Record<string, unknown> = {}, audience = registration.clientId, issuer = CHATGPT_ISSUER, expiry = "5m") =>
    new SignJWT({ nonce: "nonce", email: "user@example.test", ...claims }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setSubject("user").setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expiry).sign(pair.privateKey);
  assert.deepEqual(await verifyChatGPTIdentity(await signed(), registration.clientId, "nonce", keys), { subject: "user", email: "user@example.test" });
  await assert.rejects(verifyChatGPTIdentity(await signed(), registration.clientId, "wrong", keys));
  await assert.rejects(verifyChatGPTIdentity(await signed({}, "other"), registration.clientId, "nonce", keys));
  await assert.rejects(verifyChatGPTIdentity(await signed({}, registration.clientId, "https://attacker.test"), registration.clientId, "nonce", keys));
  await assert.rejects(verifyChatGPTIdentity(await signed({}, registration.clientId, CHATGPT_ISSUER, "-1h"), registration.clientId, "nonce", keys));
  const wrongKeys = await generateKeyPair("RS256");
  await assert.rejects(verifyChatGPTIdentity(await signed(), registration.clientId, "nonce", createLocalJWKSet({ keys: [await exportJWK(wrongKeys.publicKey)] })));
});

test("rotating refresh tokens are replaced together and grants fail closed", () => {
  const tokens = { access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 3600 };
  const updated = applyChatGPTTokens({ ...registration, refreshToken: "old-refresh" }, tokens);
  assert.equal(updated.refreshToken, "new-refresh");
  assert.equal(updated.accessToken, "new-access");
  assert.ok(updated.expiresAt > Date.now() + 3_500_000);
  assert.equal(applyChatGPTTokens({ ...registration, refreshToken: "old-refresh" }, { ...tokens, refresh_token: undefined }).refreshToken, "old-refresh");
  assert.throws(() => applyChatGPTTokens(registration, { ...tokens, scope: "openid email" }), /not authorized/);
  assert.throws(() => applyChatGPTTokens(registration, { ...tokens, expires_in: -1 }), /invalid token/);
  assert.throws(() => applyChatGPTTokens(registration, { ...tokens, token_type: "Basic" }), /invalid token/);
});
