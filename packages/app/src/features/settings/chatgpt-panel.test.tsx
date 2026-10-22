import assert from "node:assert/strict";
import test from "node:test";
import { act, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { clientDom, loadClientModule, settlePromises } from "@/lib/feed-beacon.test-helpers";

test("browser sign-in activates the ChatGPT model and disconnect shows unconfirmed revocation", async () => {
  let connected = false;
  let defaultModel = "first";
  let activeId: string | null = null;
  let selectedModel = "ollama/old";
  let mixMode = true;
  let invalidations = 0;
  let popupUrl = "";
  const calls: Array<{ path: string; body: any }> = [];
  const account = () => ({ id: "chatgpt-account", email: "fixture@example.test", label: "Fixture", connected, models: connected ? ["first", "second"] : [], defaultModel });
  const env = clientDom({ fetch: async (input: string, init?: RequestInit) => {
    const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    let data: unknown;
    if (path === "/api/chatgpt/accounts") data = connected || calls.some(call => call.path.includes("/disconnect")) ? [account()] : [];
    else if (path === "/api/chatgpt/login") data = { id: "attempt", authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=fixture" };
    else if (path === "/api/chatgpt/login/attempt") { connected = true; data = { status: "completed", profileId: "chatgpt-account" }; }
    else if (path.endsWith("/list-models")) data = { ok: true, models: ["first", "second"] };
    else if (path === "/api/keys/chatgpt-account") { defaultModel = body.defaultModel; data = {}; }
    else if (path === "/api/users/me") { activeId = body.preferences.activeApiKeyId; data = {}; }
    else if (path.endsWith("/disconnect")) { connected = false; data = { revocationConfirmed: false }; }
    else throw new Error(`Unexpected request: ${path}`);
    return Response.json({ data });
  } });
  env.dom.reconfigure({ url: "http://localhost:3000/app/settings" });
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: env.dom.window.localStorage });
  env.dom.window.open = (() => ({ opener: null, location: { replace: (url: string) => { popupUrl = url; } }, close() {} })) as unknown as typeof window.open;
  const useProfile = Object.assign((selector: (state: any) => unknown) => selector({ profile: { preferences: { activeApiKeyId: activeId } } }), { getState: () => ({ forceFetchProfile: async () => {} }) });
  const useConfig = Object.assign((selector: (state: any) => unknown) => selector({ selectedModel }), {
    getState: () => ({ setConfig: (key: string, value: unknown) => { if (key === "selectedModel") selectedModel = String(value); if (key === "mixMode") mixMode = Boolean(value); } }),
  });
  const useModels = { getState: () => ({ invalidateModels: () => invalidations++, fetchModels: async () => {}, addToRecent: () => {} }) };
  const Container = ({ children }: any) => <div>{children}</div>;
  const { ChatGPTPanel } = loadClientModule<{ ChatGPTPanel: ComponentType }>(new URL("./chatgpt-panel.tsx", import.meta.url), {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/components/ui/button": { Button: ({ children, variant: _variant, size: _size, ...props }: any) => <button {...props}>{children}</button> },
    "@/components/ui/dialog": { Dialog: ({ open, children }: any) => open ? <div role="dialog">{children}</div> : null, DialogContent: Container, DialogDescription: Container, DialogTitle: Container },
    "@/stores/user-profile": { useUserProfileStore: useProfile },
    "@/stores/config": { useConfigStore: useConfig },
    "@/stores/models": { useModelsStore: useModels },
    "@/features/chat/chatgpt-usage": { CHATGPT_USAGE_URL: "https://chatgpt.com/settings/usage", ChatGPTUsage: () => <span>Using ChatGPT plan</span> },
  });
  const rootElement = env.dom.window.document.getElementById("root")!;
  const root = createRoot(rootElement);
  const button = (label: string) => [...rootElement.querySelectorAll("button")].find(element => element.textContent === label)!;
  const click = async (label: string) => { await act(async () => { button(label).click(); await settlePromises(); }); };
  try {
    await act(async () => { root.render(<ChatGPTPanel />); await settlePromises(); });
    await click("chatgpt.continue");
    await act(async () => { await settlePromises(); });
    assert.match(popupUrl, /^https:\/\/auth.openai.com\//);
    assert.equal(activeId, "chatgpt-account");
    assert.equal(selectedModel, "chatgpt/first");
    assert.equal(mixMode, false);
    assert.equal(invalidations, 1);
    assert.ok(rootElement.querySelector('[role="dialog"]'));
    await click("chatgpt.gotIt");
    assert.equal(localStorage.getItem("yumina-chatgpt-welcome-seen"), "1");
    await act(async () => {
      const select = rootElement.querySelector("select")!;
      select.value = "second";
      select.dispatchEvent(new env.dom.window.Event("change", { bubbles: true }));
      await settlePromises();
    });
    assert.equal(selectedModel, "chatgpt/second");
    await click("chatgpt.disconnect");
    assert.equal(connected, false);
    assert.match(rootElement.textContent!, /chatgpt.revocationUnconfirmed/);
    assert.equal(rootElement.querySelector("select"), null);
    assert.equal(invalidations, 3);
    assert.equal(Object.keys(localStorage).some(key => /token|credential/i.test(key)), false);
  } finally {
    await act(async () => root.unmount());
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage");
    env.restore();
  }
});
