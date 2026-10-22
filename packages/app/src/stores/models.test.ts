import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import "../lib/vite-env.test-helpers";
const { useModelsStore } = await import("./models");
const { useCreditStore } = await import("@/edition/slots.state");
const { useUserProfileStore } = await import("./user-profile");

const originalFetch = globalThis.fetch;
const key = (id = "a", models = ["deepseek-old"]) => ({ id, provider: "custom", metadata: { models } });
const reply = (data: unknown) => Response.json({ data });
function select(id: string) {
  useUserProfileStore.setState({ profile: { preferences: { activeApiKeyId: id } } as never });
}
beforeEach(() => {
  useModelsStore.setState({ models: [], curated: [], loading: false, lastFetched: 0, lastSourceKey: "" });
  useCreditStore.setState({ provider: "private", lastFetched: Date.now() });
  select("a");
});
afterEach(() => { globalThis.fetch = originalFetch; });

for (const activeProvider of ["chatgpt", "openrouter"]) {
  test(`${activeProvider} selection keeps both ChatGPT and OpenRouter catalogs available`, async () => {
    select(activeProvider);
    const paths: string[] = [];
    globalThis.fetch = (async url => {
      const path = String(url);
      paths.push(path);
      if (path.endsWith("/keys")) return reply([
        { id: "openrouter-old", provider: "openrouter", metadata: { models: ["old/model"] }, createdAt: "2026-10-01" },
        { id: "chatgpt", provider: "chatgpt", metadata: { models: ["plan-model"] }, createdAt: "2026-10-22" },
        { id: "openrouter", provider: "openrouter", metadata: null, createdAt: "2026-10-22" },
      ]);
      if (path.includes("/chatgpt/")) return reply({ ok: true, models: ["plan-model"] });
      if (path.includes("/openrouter/")) return reply({ ok: true, models: ["anthropic/api-model"] });
      throw new Error(`Unexpected catalog request: ${path}`);
    }) as typeof fetch;
    await useModelsStore.getState().fetchModels();
    assert.deepEqual(useModelsStore.getState().models.map(m => m.id).sort(), ["anthropic/api-model", "chatgpt/plan-model"]);
    assert.equal(paths.filter(path => path.includes("list-models")).length, 2);
    assert.equal(useUserProfileStore.getState().profile?.preferences?.activeApiKeyId, activeProvider);
  });
}

test("OpenRouter discovery failure does not hide connected ChatGPT models", async () => {
  select("chatgpt");
  globalThis.fetch = (async url => {
    const path = String(url);
    if (path.endsWith("/keys")) return reply([
      { id: "chatgpt", provider: "chatgpt", metadata: { models: ["plan-model"] } },
      { id: "router", provider: "openrouter", metadata: { models: ["google/saved-model"] } },
    ]);
    if (path.includes("/router/")) throw new Error("offline");
    return reply({ ok: true, models: ["plan-model"] });
  }) as typeof fetch;
  await useModelsStore.getState().fetchModels();
  assert.deepEqual(useModelsStore.getState().models.map(m => m.id).sort(), ["chatgpt/plan-model", "google/saved-model"]);
});

test("disconnect invalidation prevents a pending catalog for the same profile from returning", async () => {
  let finishOld: ((response: Response) => void) | undefined;
  let disconnected = false;
  globalThis.fetch = (async url => {
    if (String(url).endsWith("/keys")) return reply([{ id: "a", provider: "chatgpt", metadata: { models: disconnected ? [] : ["old"] } }]);
    if (disconnected) return reply({ ok: false, models: [] });
    return new Promise<Response>(resolve => { finishOld = resolve; });
  }) as typeof fetch;
  const previous = useModelsStore.getState().fetchModels();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(useModelsStore.getState().models[0]?.id, "chatgpt/old");
  disconnected = true;
  useModelsStore.getState().invalidateModels();
  await useModelsStore.getState().fetchModels();
  finishOld!(reply({ ok: true, models: ["stale"] }));
  await previous;
  assert.deepEqual(useModelsStore.getState().models, []);
});

test("saved private catalogs refresh upstream and expose the cache while waiting", async () => {
  let finish: ((value: Response) => void) | undefined;
  let calls = 0;
  globalThis.fetch = (async (url) => {
    calls++;
    if (String(url).endsWith("/keys")) return reply([key()]);
    return new Promise<Response>((resolve) => { finish = resolve; });
  }) as typeof fetch;
  const request = useModelsStore.getState().fetchModels();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useModelsStore.getState().models[0]?.id, "custom/deepseek-old");
  assert.equal(useModelsStore.getState().loading, false);
  await useModelsStore.getState().fetchModels();
  assert.equal(calls, 2, "duplicate opens share the pending refresh");
  assert.ok(finish, "a saved catalog must not prevent upstream refresh");
  finish(reply({ ok: true, provider: "custom", models: ["deepseek-new"] }));
  await request;
  assert.deepEqual(useModelsStore.getState().models.map((m) => m.id), ["custom/deepseek-new"]);
  await useModelsStore.getState().fetchModels();
  assert.equal(calls, 2, "fresh catalogs do not re-fetch");
});

for (const failure of ["network", "http", "empty", "invalid", "provider"]) {
  test(`upstream ${failure} failure keeps saved private models`, async () => {
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("/keys")) return reply([key()]);
      if (failure === "network") throw new Error("offline");
      if (failure === "http") return new Response(null, { status: 503 });
      if (failure === "invalid") return new Response("not JSON");
      return reply({ ok: failure !== "provider", models: [] });
    }) as typeof fetch;
    await useModelsStore.getState().fetchModels();
    assert.deepEqual(useModelsStore.getState().models.map((m) => m.id), ["custom/deepseek-old"]);
    assert.equal(useModelsStore.getState().loading, false);
  });
}

test("expired memory cache queries upstream again even with saved models", async () => {
  let calls = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/keys")) return reply([key()]);
    calls++;
    return reply({ ok: true, models: [`new-${calls}`] });
  }) as typeof fetch;
  await useModelsStore.getState().fetchModels();
  useModelsStore.setState({ lastFetched: Date.now() - 300_001 });
  await useModelsStore.getState().fetchModels();
  assert.equal(calls, 2);
  assert.equal(useModelsStore.getState().models[0]?.id, "custom/new-2");
});

test("a freshly typed default survives an upstream TTL response that lacks it", async () => {
  globalThis.fetch = (async (url) => String(url).endsWith("/keys")
    ? reply([{ ...key(), metadata: { models: ["listed"], defaultModel: "hand-typed" } }])
    : reply({ ok: true, models: ["listed"] })) as typeof fetch;
  await useModelsStore.getState().fetchModels();
  assert.deepEqual(useModelsStore.getState().models.map((m) => m.id), ["custom/listed", "custom/hand-typed"]);
});

test("late responses from an inactive key cannot replace the current catalog", async () => {
  let finishA: ((value: Response) => void) | undefined;
  const paths: string[] = [];
  globalThis.fetch = (async (url) => {
    const path = String(url);
    paths.push(path);
    if (path.endsWith("/keys")) return reply([key("a"), key("b", ["b-old"])]);
    if (path.includes("/a/")) return new Promise<Response>((resolve) => { finishA = resolve; });
    return reply({ ok: true, models: ["b-new"] });
  }) as typeof fetch;
  const a = useModelsStore.getState().fetchModels();
  await new Promise((resolve) => setImmediate(resolve));
  select("b");
  await useModelsStore.getState().fetchModels();
  assert.equal(useModelsStore.getState().models[0]?.id, "custom/b-new");
  finishA!(reply({ ok: true, models: ["a-new"] }));
  await a;
  assert.equal(useModelsStore.getState().models[0]?.id, "custom/b-new");
  assert.equal(useModelsStore.getState().lastSourceKey, "private:b");
  assert.equal(paths.filter((path) => path.includes("list-models")).length, 2);
});

test("missing active key refreshes fallback profiles without losing a failed profile", async () => {
  select("deleted");
  globalThis.fetch = (async (url) => {
    const path = String(url);
    if (path.endsWith("/keys")) return reply([key("a"), key("b", ["b-old"])]);
    if (path.includes("/a/")) return reply({ ok: true, models: ["a-new"] });
    throw new Error("offline");
  }) as typeof fetch;
  await useModelsStore.getState().fetchModels();
  assert.deepEqual(useModelsStore.getState().models.map((m) => m.id), ["custom/a-new", "custom/b-old"]);
});

test("a failed profile read preserves the last rendered catalog", async () => {
  globalThis.fetch = (async (url) => String(url).endsWith("/keys")
    ? reply([key()]) : reply({ ok: true, models: ["new"] })) as typeof fetch;
  await useModelsStore.getState().fetchModels();
  useModelsStore.setState({ lastFetched: 0 });
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
  await useModelsStore.getState().fetchModels();
  assert.equal(useModelsStore.getState().models[0]?.id, "custom/new");
});
