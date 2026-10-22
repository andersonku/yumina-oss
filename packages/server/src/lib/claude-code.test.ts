import assert from "node:assert/strict";
import test from "node:test";
import { claudeCodeEnvironment, claudeCodeEnabled, isClaudeCodeModel, isLoopbackHost } from "./claude-code.js";
import { env } from "./env.js";

test("CLI environment excludes application secrets while preserving native authentication configuration", () => {
  assert.deepEqual(claudeCodeEnvironment({ HOME: "/home/player", PATH: "/bin", ANTHROPIC_API_KEY: "native-key", CLAUDE_CONFIG_DIR: "/config", HTTPS_PROXY: "proxy", BETTER_AUTH_SECRET: "secret", DATABASE_URL: "postgres://private", OPENAI_API_KEY: "other-key" }), {
    HOME: "/home/player", PATH: "/bin", ANTHROPIC_API_KEY: "native-key", CLAUDE_CONFIG_DIR: "/config", HTTPS_PROXY: "proxy",
  });
});

test("CLI connection is restricted to a local server bound to loopback", t => {
  const edition = env.YUMINA_EDITION, host = env.HOST;
  t.after(() => { env.YUMINA_EDITION = edition; env.HOST = host; });
  env.YUMINA_EDITION = "local";
  for (const value of [undefined, "localhost", "127.0.0.1", "::1"]) { env.HOST = value; assert.equal(claudeCodeEnabled(), true); }
  for (const value of ["0.0.0.0", "192.168.1.4", "localhost.attacker.test"]) { env.HOST = value; assert.equal(claudeCodeEnabled(), false); assert.equal(isLoopbackHost(value), false); }
  env.HOST = undefined; env.YUMINA_EDITION = "hosted";
  assert.equal(claudeCodeEnabled(), false);
  assert.equal(isClaudeCodeModel("sonnet"), true);
  assert.equal(isClaudeCodeModel("sonnet --tools Bash"), false);
});
