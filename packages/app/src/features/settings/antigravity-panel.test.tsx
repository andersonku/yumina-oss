import assert from "node:assert/strict";
import test from "node:test";
import { act, type ButtonHTMLAttributes, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { clientDom, loadClientModule, settlePromises } from "@/lib/feed-beacon.test-helpers";

test("Antigravity panel checks native sign-in, activates the model and disconnects", async () => {
  let ready = false, connected = false, selectedModel = "google/old", mixMode = true;
  let activeId: string | null = null;
  let invalidations = 0;
  const calls: string[] = [];
  const env = clientDom({ fetch: async (input: string, init?: RequestInit) => {
    const path = String(input);
    calls.push(path);
    let data: unknown;
    if (path.endsWith("/status")) data = { installed: true, ready, profileId: connected ? "cli-profile" : undefined, defaultModel: "sonnet", models: [{ id: "sonnet", name: "Sonnet" }, { id: "opus", name: "Opus" }] };
    else if (path.endsWith("/connect")) { assert.equal(JSON.parse(String(init?.body)).model, "opus"); connected = true; activeId = "cli-profile"; data = {}; }
    else if (path.endsWith("/disconnect")) { connected = false; activeId = null; data = {}; }
    else throw new Error(`Unexpected path ${path}`);
    return Response.json({ data });
  } });
  env.dom.reconfigure({ url: "http://localhost:3000/app/settings" });
  const useProfile = Object.assign((selector: (state: { profile: { preferences: { activeApiKeyId: string | null } } }) => unknown) => selector({ profile: { preferences: { activeApiKeyId: activeId } } }), { getState: () => ({ forceFetchProfile: async () => {} }) });
  const useConfig = Object.assign((selector: (state: { selectedModel: string }) => unknown) => selector({ selectedModel }), { getState: () => ({ setConfig: (key: string, value: unknown) => { if (key === "selectedModel") selectedModel = String(value); if (key === "mixMode") mixMode = Boolean(value); } }) });
  const { AntigravityPanel } = loadClientModule<{ AntigravityPanel: ComponentType }>(new URL("./antigravity-panel.tsx", import.meta.url), {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/components/ui/button": { Button: ({ children, onClick, disabled }: ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button> },
    "@/edition/edition": { useIsLocalEdition: () => true },
    "@/stores/user-profile": { useUserProfileStore: useProfile },
    "@/stores/config": { useConfigStore: useConfig },
    "@/stores/models": { useModelsStore: { getState: () => ({ invalidateModels: () => invalidations++, fetchModels: async () => {}, addToRecent: () => {} }) } },
  });
  const container = env.dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const click = async (label: string) => act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === label)!.click(); await settlePromises(); });
  try {
    await act(async () => { root.render(<AntigravityPanel />); await settlePromises(); });
    assert.match(container.textContent!, /agy/);
    assert.equal(container.querySelector("select"), null);
    ready = true;
    await click("antigravity.refresh");
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "opus";
      select.dispatchEvent(new env.dom.window.Event("change", { bubbles: true }));
      await settlePromises();
    });
    await click("antigravity.connect");
    assert.equal(selectedModel, "antigravity/opus");
    assert.equal(mixMode, false);
    assert.equal(activeId, "cli-profile");
    assert.equal(invalidations, 1);
    await click("antigravity.disconnect");
    assert.equal(connected, false);
    assert.equal(ready, true);
    assert.equal(activeId, null);
    assert.equal(invalidations, 2);
    assert.equal(calls.some(call => /token|oauth|login/.test(call)), false);
  } finally { await act(async () => root.unmount()); env.restore(); }
});
