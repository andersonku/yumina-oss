import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsLocalEdition } from "@/edition/edition";
import { useUserProfileStore } from "@/stores/user-profile";
import { useConfigStore } from "@/stores/config";
import { useModelsStore } from "@/stores/models";

const apiBase = import.meta.env.VITE_API_URL || "";
interface Status { installed: boolean; ready: boolean; profileId?: string; defaultModel: string; models: { id: string; name: string }[]; error?: string }
async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`${apiBase}/api/antigravity${path}`, {
    method: body ? "POST" : "GET", credentials: "include", signal: AbortSignal.timeout(45_000),
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Antigravity request failed");
  return payload.data;
}

export function AntigravityPanel() {
  const { t } = useTranslation("profile");
  const local = useIsLocalEdition();
  const onThisComputer = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const activeId = useUserProfileStore(state => state.profile?.preferences?.activeApiKeyId);
  const selectedModel = useConfigStore(state => state.selectedModel);
  const [status, setStatus] = useState<Status | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const data = await request<Status>("/status");
    if (mounted.current) { setStatus(data); setModel(data.defaultModel); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (local && onThisComputer) {
      setBusy(true);
      void refresh().catch(e => { if (mounted.current) setError(e.message); }).finally(() => { if (mounted.current) setBusy(false); });
    }
    return () => { mounted.current = false; };
  }, [local, onThisComputer, refresh]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const reload = async () => {
    await useUserProfileStore.getState().forceFetchProfile();
    useModelsStore.getState().invalidateModels();
    await useModelsStore.getState().fetchModels();
    await refresh();
  };
  if (!local) return null;
  const active = !!status?.profileId && status.profileId === activeId && selectedModel.startsWith("antigravity/");
  return <section className="profile-overview-glass profile-overview-glass--soft rounded-2xl p-6 space-y-4">
    <h3 className="text-sm font-semibold text-main">{t("antigravity.title")}</h3>
    <p className="text-xs text-sub">{t("antigravity.description")}</p>
    <p className="text-xs text-sub/70">{t("antigravity.limitations")}</p>
    {!onThisComputer ? <p className="text-xs text-amber-200">{t("antigravity.localOnly")}</p> : <>
      {status && <p role="status" className="text-xs text-sub">{t(status.ready ? active ? "antigravity.active" : "antigravity.ready" : status.installed ? "antigravity.signInRequired" : "antigravity.installRequired")}</p>}
      {!status?.ready && <div className="space-y-2 text-xs text-sub">
        <p>{t("antigravity.loginInstructions")}</p>
        <code className="block rounded-lg bg-black/20 p-3 select-all">agy</code>
        <a href="https://antigravity.google/docs/getting-started?tab=cli" target="_blank" rel="noreferrer" className="underline">{t("antigravity.installGuide")}</a>
      </div>}
      {status?.ready && <label className="block space-y-1 text-xs text-sub">
        <span>{t("antigravity.model")}</span>
        <select aria-label={t("antigravity.model")} value={model} disabled={busy} onChange={event => setModel(event.target.value)}
          className="profile-overview-input-surface w-full rounded-lg border border-white/10 p-2 text-main">
          {status.models.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}
        </select>
      </label>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(refresh)}>
          {busy ? <Loader2 aria-hidden="true" className="mr-2 h-3 w-3 animate-spin" /> : <RefreshCw aria-hidden="true" className="mr-2 h-3 w-3" />}{t("antigravity.refresh")}
        </Button>
        {status?.ready && <Button size="sm" disabled={busy} onClick={() => void run(async () => {
          await request("/connect", { model });
          useConfigStore.getState().setConfig("selectedModel", `antigravity/${model}`);
          useConfigStore.getState().setConfig("mixMode", false);
          useModelsStore.getState().addToRecent(`antigravity/${model}`);
          await reload();
        })}>{t("antigravity.connect")}</Button>}
        {status?.profileId && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          await request("/disconnect", {});
          await reload();
        })}>{t("antigravity.disconnect")}</Button>}
      </div>
    </>}
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    <p className="text-xs text-sub/70">{t("antigravity.usage")}</p>
  </section>;
}
