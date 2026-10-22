import assert from "node:assert/strict";
import test from "node:test";
import { antigravityEnvironment, parseAntigravityModels, isAntigravityModel } from "./antigravity.js";

test("Antigravity uses only native OAuth environment and parses the live account catalog", () => {
  assert.deepEqual(antigravityEnvironment({ HOME: "/home/player", PATH: "/bin", GEMINI_API_KEY: "secret", AGY_ADC_AUTH: "true", GOOGLE_APPLICATION_CREDENTIALS: "/private/key", DATABASE_URL: "private", BETTER_AUTH_SECRET: "secret" }), { HOME: "/home/player", PATH: "/bin" });
  assert.deepEqual(parseAntigravityModels("Fetching available models...\n gemini-4-argon-high\tGemini 4 Argon (High)\r\nclaude-opus-5-5-low  Claude Opus 5.5 (Low)\ngemini-4-argon-high\tGemini 4 Argon (High)\n"), [
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" }, { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
  ]);
  for (const id of ["--skip-permissions", "a/b", "model --flag", "a\nflag"]) assert.equal(isAntigravityModel(id), false);
});
