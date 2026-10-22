import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const jwks = createRemoteJWKSet(new URL(`${CHATGPT_ISSUER}/.well-known/jwks.json`), { timeoutDuration: 15_000 });

export interface ChatGPTCredentials {
  id: string;
  clientId: string;
  subject: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  scopes: string[];
  expiresAt: number;
}

export function createChatGPTTransaction(hostId: string, redirectUri: string, previous?: ChatGPTCredentials, issuedClientId?: string) {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  const clientId = previous?.clientId ?? issuedClientId ?? "dynamic_agent_client";
  const url = new URL(`${CHATGPT_ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    ext_agent_host_id: hostId,
    ...(clientId === "dynamic_agent_client" && { agent_name_hint: "Yumina" }),
    ...(previous?.idToken && { id_token_hint: previous.idToken }),
    ...(previous?.email && { login_hint: previous.email }),
    response_type: "code", redirect_uri: redirectUri,
    scope: CHATGPT_SCOPES, resource: CHATGPT_RESOURCE,
    state, nonce, code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  return { state, nonce, verifier, redirectUri, authorizationUrl: url.href, previous, clientId };
}

export function validateChatGPTCallback(url: URL, transaction: ReturnType<typeof createChatGPTTransaction>) {
  if (url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== transaction.state) {
    throw new Error("ChatGPT sign-in state did not match. Please try again.");
  }
  if (url.searchParams.has("error")) throw new Error("ChatGPT sign-in was declined. Continue with ChatGPT to try again.");
  const code = url.searchParams.get("code");
  const clientId = url.searchParams.get("client_id") ?? (transaction.clientId === "dynamic_agent_client" ? undefined : transaction.clientId);
  if (!code || !clientId || clientId === "dynamic_agent_client") throw new Error("ChatGPT registration is incomplete. Please try again.");
  if (transaction.clientId !== "dynamic_agent_client" && clientId !== transaction.clientId) throw new Error("ChatGPT registration did not match the selected account.");
  return { code, clientId };
}

export async function verifyChatGPTIdentity(idToken: string, clientId: string, nonce?: string, keys: JWTVerifyGetKey = jwks) {
  const { payload } = await jwtVerify(idToken, keys, {
    issuer: CHATGPT_ISSUER, audience: clientId, requiredClaims: ["sub", "exp", "iat"],
    algorithms: ["RS256", "ES256"], clockTolerance: 5,
  });
  if (typeof payload.sub !== "string" || !payload.sub || (nonce !== undefined && payload.nonce !== nonce)) throw new Error("ChatGPT account identity could not be verified.");
  return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
}

export interface ChatGPTTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export function applyChatGPTTokens(previous: ChatGPTCredentials, tokens: ChatGPTTokenResponse): ChatGPTCredentials {
  const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/) : previous.scopes;
  if (!scopes.includes("chatgpt.tokens.use.direct") || !scopes.includes("resource.invoke")) {
    throw new Error("ChatGPT plan usage was not authorized. Continue with ChatGPT and allow plan usage.");
  }
  if (typeof tokens.access_token !== "string" || !tokens.access_token ||
      tokens.token_type?.toLowerCase() !== "bearer" ||
      typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    throw new Error("ChatGPT returned an invalid token response. Please reconnect.");
  }
  return { ...previous, scopes, accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || previous.refreshToken,
    idToken: tokens.id_token || previous.idToken,
    expiresAt: Date.now() + tokens.expires_in * 1000 };
}

export async function requestChatGPTTokens(body: URLSearchParams): Promise<ChatGPTTokenResponse> {
  const response = await fetch(CHATGPT_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body, signal: AbortSignal.timeout(15_000), redirect: "error",
  });
  // Token endpoint bodies can contain credentials. Never forward or log them.
  if (!response.ok) throw new Error(response.status >= 500
    ? "ChatGPT sign-in is temporarily unavailable. Please try again."
    : "ChatGPT authorization expired or was revoked. Please reconnect.");
  return response.json() as Promise<ChatGPTTokenResponse>;
}
