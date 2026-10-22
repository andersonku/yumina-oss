import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "./env.js";

const execute = promisify(execFile);
export const CLAUDE_CODE_MODELS = ["sonnet", "opus", "haiku"] as const;
export type ClaudeCodeModel = typeof CLAUDE_CODE_MODELS[number];
export const isClaudeCodeModel = (model: unknown): model is ClaudeCodeModel =>
  typeof model === "string" && CLAUDE_CODE_MODELS.some(value => value === model);
export const isLoopbackHost = (host: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
export function claudeCodeEnabled() {
  return env.YUMINA_EDITION === "local" && isLoopbackHost(env.HOST ?? "127.0.0.1");
}

// Pass OS and Claude configuration through without exposing Yumina's database,
// encryption secret or unrelated provider credentials to the child process.
export function claudeCodeEnvironment(source = process.env): NodeJS.ProcessEnv {
  const systemKeys = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|APPDATA|LOCALAPPDATA|USERPROFILE|LANG|LC_.*|XDG_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    systemKeys.test(key) || /^(ANTHROPIC_|CLAUDE_)/.test(key)));
}

async function binaryPath(): Promise<string> {
  if (process.env.YUMINA_CLAUDE_CODE_PATH) return process.env.YUMINA_CLAUDE_CODE_PATH;
  const native = path.join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  try { await access(native, constants.X_OK); return native; } catch { return "claude"; }
}

export interface ClaudeCodeStatus {
  installed: boolean;
  loggedIn: boolean;
  ready: boolean;
  authMethod?: string;
  error?: string;
}

export async function getClaudeCodeStatus(): Promise<ClaudeCodeStatus> {
  if (!claudeCodeEnabled()) return { installed: false, loggedIn: false, ready: false, error: "Claude Code requires the local edition bound to localhost." };
  const cwd = await mkdtemp(path.join(tmpdir(), "yumina-claude-status-"));
  try {
    const options = { cwd, env: claudeCodeEnvironment(), timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true };
    let stdout: string;
    try { ({ stdout } = await execute(await binaryPath(), ["auth", "status"], options)); }
    catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string };
      if (failure.code === "ENOENT") return { installed: false, loggedIn: false, ready: false, error: "Install the official Claude Code CLI, then run claude auth login in Terminal." };
      if (failure.stdout?.trim().startsWith("{")) stdout = failure.stdout;
      else return { installed: true, loggedIn: false, ready: false, error: "Could not check Claude Code. Run claude auth status in Terminal." };
    }
    const status = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
    const loggedIn = status.loggedIn === true;
    const authMethod = typeof status.authMethod === "string" ? status.authMethod : undefined;
    const ready = loggedIn && authMethod === "claude.ai";
    return { installed: true, loggedIn, ready, authMethod,
      ...(!ready && { error: "Run claude auth login in Terminal and sign in with your Claude subscription. API-key and cloud-provider sessions use separate billing." }) };
  } catch {
    return { installed: true, loggedIn: false, ready: false, error: "Could not read Claude Code status. Update the official CLI and run claude auth login." };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

export async function startClaudeCode(args: string[], cwd: string) {
  return spawn(await binaryPath(), args, {
    cwd, env: claudeCodeEnvironment(), shell: false, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
