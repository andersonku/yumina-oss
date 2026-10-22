import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "./env.js";
import { isLoopbackHost } from "./claude-code.js";

const execute = promisify(execFile);
export const isAntigravityModel = (model: unknown): model is string =>
  typeof model === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(model);
export const antigravityEnabled = () => env.YUMINA_EDITION === "local" && isLoopbackHost(env.HOST ?? "127.0.0.1");

// Use the CLI's native keyring session. Never pass application secrets, API
// keys, ADC overrides or another provider's credentials to the child process.
export function antigravityEnvironment(source = process.env): NodeJS.ProcessEnv {
  const systemKeys = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|APPDATA|LOCALAPPDATA|USERPROFILE|LANG|LC_.*|XDG_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
  return Object.fromEntries(Object.entries(source).filter(([key]) => systemKeys.test(key)));
}

async function binaryPath() {
  if (process.env.YUMINA_ANTIGRAVITY_PATH) return process.env.YUMINA_ANTIGRAVITY_PATH;
  const native = path.join(homedir(), ".local", "bin", process.platform === "win32" ? "agy.exe" : "agy");
  try { await access(native, constants.X_OK); return native; } catch { return "agy"; }
}

export interface AntigravityModel { id: string; name: string }
export interface AntigravityStatus { installed: boolean; ready: boolean; models: AntigravityModel[]; error?: string }
export function parseAntigravityModels(output: string): AntigravityModel[] {
  const models = new Map<string, AntigravityModel>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([a-z0-9][a-z0-9._-]{0,127})\s+(.+)$/.exec(line.trim());
    if (match) models.set(match[1]!, { id: match[1]!, name: match[2]!.trim() });
  }
  return [...models.values()].slice(0, 500);
}

export async function getAntigravityStatus(): Promise<AntigravityStatus> {
  if (!antigravityEnabled()) return { installed: false, ready: false, models: [], error: "Antigravity requires the local edition bound to localhost." };
  let cwd: string | undefined;
  try {
    // Refuse separately billed provider modes rather than silently changing
    // the user's native Antigravity configuration.
    for (const [file, isCli] of [["antigravity-cli/settings.json", true], ["config/config.json", false]] as const) {
      let settings: Record<string, any>;
      try { settings = JSON.parse(await readFile(path.join(homedir(), ".gemini", file), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if ((isCli && settings.modelProvider && settings.modelProvider !== "antigravity") || settings.userSettings?.enableAdc === true) {
        return { installed: true, ready: false, models: [], error: "Antigravity is configured for API-key or Google Cloud billing. Switch the official CLI to your personal Google sign-in, then check again." };
      }
    }
    cwd = await mkdtemp(path.join(tmpdir(), "yumina-antigravity-status-"));
    const { stdout } = await execute(await binaryPath(), ["models"], {
      cwd, env: antigravityEnvironment(), timeout: 30_000, maxBuffer: 512 * 1024, windowsHide: true,
    });
    const models = parseAntigravityModels(stdout);
    return { installed: true, ready: models.length > 0, models,
      ...(!models.length && { error: "No Antigravity models are available. Run agy in Terminal to sign in, then check again." }) };
  } catch (error) {
    const installed = (error as NodeJS.ErrnoException).code !== "ENOENT";
    return { installed, ready: false, models: [], error: installed
      ? "Could not check Antigravity. Run agy in Terminal and sign in with your Google account, then check again."
      : "Install the official Antigravity CLI, then run agy in Terminal to sign in." };
  } finally { if (cwd) await rm(cwd, { recursive: true, force: true }); }
}

export const ANTIGRAVITY_AGENT = "yumina-narrator";
export async function prepareAntigravityWorkspace(cwd: string) {
  const directory = path.join(cwd, ".agents", "agents");
  await mkdir(directory, { recursive: true });
  // An empty tools list means default tools in the CLI. Explicitly allow only
  // finish: no filesystem, shell, browser, MCP, image or delegation tools.
  await writeFile(path.join(directory, `${ANTIGRAVITY_AGENT}.md`), `---
name: ${ANTIGRAVITY_AGENT}
description: Text conversation for Yumina
mainAgent: true
subagent: false
tools: [finish]
mcpServers: []
skills: []
plugins: []
commandExecutionPolicy: off
---
Continue the supplied interactive-fiction conversation using only text. Follow its world instructions and return only the next assistant message. Do not use tools or manage tasks.
`, { mode: 0o600 });
}

export async function startAntigravity(args: string[], cwd: string) {
  return spawn(await binaryPath(), args, { cwd, env: antigravityEnvironment(), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}
