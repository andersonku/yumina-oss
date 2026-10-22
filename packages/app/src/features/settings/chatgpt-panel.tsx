import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useUserProfileStore } from "@/stores/user-profile";
import { useConfigStore } from "@/stores/config";
import { useModelsStore } from "@/stores/models";
import { ChatGPTUsage, CHATGPT_USAGE_URL as usageUrl } from "@/features/chat/chatgpt-usage";

const apiBase = import.meta.env.VITE_API_URL || "";
interface Account { id: string; label: string; email?: string; connected: boolean; models: string[]; defaultModel?: string }
interface Login { id: string; authorizationUrl: string }

async function request<T>(path: string, body?: object, method = body ? "POST" : "GET"): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method, credentials: "include", signal: AbortSignal.timeout(30_000),
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "ChatGPT request failed");
  return payload.data;
}

export function ChatGPTPanel() {
  const { t } = useTranslation("profile");
  const activeId = useUserProfileStore(s => s.profile?.preferences?.activeApiKeyId);
  const selectedModel = useConfigStore(s => s.selectedModel);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<Login | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [welcome, setWelcome] = useState(false);
  const mounted = useRef(true);
  const onThisComputer = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

  const load = useCallback(async () => {
    const data = await request<Account[]>("/api/chatgpt/accounts");
    if (mounted.current) setAccounts(data);
    return data;
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (onThisComputer) void load().catch(e => setError(e.message)).finally(() => setLoading(false));
    else setLoading(false);
    return () => { mounted.current = false; };
  }, [load, onThisComputer]);

  const invalidateModels = async () => {
    useModelsStore.getState().invalidateModels();
    await useModelsStore.getState().fetchModels();
  };
  const activate = async (account: Account, rawModel?: string) => {
    let models = account.models;
    if (!rawModel) {
      const catalog = await request<{ ok: boolean; models: string[]; reason?: string }>(`/api/keys/${account.id}/list-models`, {});
      if (!catalog.ok) throw new Error(catalog.reason ?? t("chatgpt.noModels"));
      models = catalog.models;
    }
    const model = rawModel ?? (models.includes(account.defaultModel ?? "") ? account.defaultModel : models[0]);
    if (!model) throw new Error(t("chatgpt.noModels"));
    await request(`/api/keys/${account.id}`, { defaultModel: model }, "PATCH");
    await request("/api/users/me", { preferences: { activeApiKeyId: account.id } }, "PATCH");
    await useUserProfileStore.getState().forceFetchProfile();
    useConfigStore.getState().setConfig("selectedModel", `chatgpt/${model}`);
    useConfigStore.getState().setConfig("mixMode", false);
    useModelsStore.getState().addToRecent(`chatgpt/${model}`);
    await load();
    await invalidateModels();
  };

  // Poll only our opaque transaction ID. OAuth credentials never enter browser storage.
  useEffect(() => {
    if (!login) return;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await request<{ status: string; profileId?: string; error?: string }>(`/api/chatgpt/login/${login.id}`);
        if (stopped) return;
        if (result.status === "completed") {
          setLogin(null);
          setBusy(true);
          try {
            const saved = await load();
            const account = saved.find(entry => entry.id === result.profileId);
            if (account) await activate(account);
            setNotice(t("chatgpt.connected"));
            try { if (!localStorage.getItem("yumina-chatgpt-welcome-seen")) setWelcome(true); } catch { setWelcome(true); }
          } catch (e) { setError((e as Error).message); }
          finally { setBusy(false); }
          return;
        }
        if (["error", "cancelled"].includes(result.status)) {
          setError(result.error ?? t("chatgpt.cancelled")); setLogin(null); return;
        }
        timeout = setTimeout(() => void poll(), 1500);
      } catch (e) { if (!stopped) { setError((e as Error).message); setLogin(null); } }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timeout); };
    // Login completion uses fresh server account data and store actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login, load, t]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError((e as Error).message); } finally { if (mounted.current) setBusy(false); }
  };
  const connect = (accountId?: string) => {
    // Open synchronously so browsers allow the sign-in window after the fetch.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    void run(async () => {
      try {
        const attempt = await request<Login>("/api/chatgpt/login", { accountId });
        if (new URL(attempt.authorizationUrl).origin !== "https://auth.openai.com") throw new Error("Invalid ChatGPT authorization URL");
        setLogin(attempt);
        if (popup) popup.location.replace(attempt.authorizationUrl);
      } catch (e) { popup?.close(); throw e; }
    });
  };
  const dismissWelcome = () => {
    try { localStorage.setItem("yumina-chatgpt-welcome-seen", "1"); } catch { /* Optional UI preference. */ }
    setWelcome(false);
  };

  return <section className="profile-overview-glass profile-overview-glass--soft rounded-2xl p-6 space-y-4">
    <h3 className="text-sm font-semibold text-main">{t("chatgpt.title")}</h3>
    <p className="text-xs text-sub">{t("chatgpt.description")}</p>
    <p className="text-xs text-sub/70">{t("chatgpt.textOnly")}</p>
    {!onThisComputer ? <p className="text-xs text-amber-200">{t("chatgpt.localOnly")}</p> : <>
      {loading && <Loader2 aria-label={t("chatgpt.loading")} className="h-4 w-4 animate-spin" />}
      {accounts.map(account => <div key={account.id} className="space-y-3 rounded-xl border border-white/10 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-main">
          <span>{account.email ?? account.label}</span><span className="text-xs text-sub/60">{account.id.slice(-6)}</span>
          <span className="text-xs text-sub">{account.connected ? t("chatgpt.connected") : t("chatgpt.disconnected")}</span>
          {activeId === account.id && account.connected && <span className="text-xs text-emerald-300">{t("chatgpt.active")}</span>}
        </div>
        {account.connected && account.models.length > 0 && <label className="block space-y-1 text-xs text-sub">
          <span>{t("chatgpt.model")}</span>
          <select aria-label={t("chatgpt.model")} className="profile-overview-input-surface w-full rounded-lg border border-white/10 p-2 text-main"
            disabled={busy || !!login} value={activeId === account.id && selectedModel.startsWith("chatgpt/") ? selectedModel.slice(8) : account.defaultModel ?? account.models[0]}
            onChange={event => void run(() => activate(account, event.target.value))}>
            {account.models.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>}
        <div className="flex flex-wrap gap-2">
          {account.connected && <Button size="sm" disabled={busy || !!login} onClick={() => void run(() => activate(account))}>{t("chatgpt.useAccount")}</Button>}
          <Button size="sm" variant="outline" disabled={busy || !!login} onClick={() => connect(account.id)}>{t("chatgpt.reconnect")}</Button>
          {account.connected && <Button size="sm" variant="outline" disabled={busy || !!login} onClick={() => void run(async () => {
            const result = await request<{ revocationConfirmed: boolean }>(`/api/chatgpt/accounts/${account.id}/disconnect`, {});
            await load(); await invalidateModels();
            setNotice(result.revocationConfirmed ? t("chatgpt.disconnected") : t("chatgpt.revocationUnconfirmed"));
          })}>{t("chatgpt.disconnect")}</Button>}
        </div>
      </div>)}
      {login ? <div className="space-y-2 text-xs text-sub">
        <p role="status">{t("chatgpt.waiting")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <a href={login.authorizationUrl} target="_blank" rel="noreferrer" className="underline">{t("chatgpt.openSignIn")}</a>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
            await request(`/api/chatgpt/login/${login.id}/cancel`, {}); setLogin(null);
          })}>{t("chatgpt.cancel")}</Button>
        </div>
      </div> : <Button disabled={busy || loading} onClick={() => connect()} className="bg-white text-black hover:bg-white/90">{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("chatgpt.continue")}</Button>}
    </>}
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    {notice && <p role="status" className="text-xs text-sub">{notice}</p>}
    {selectedModel.startsWith("chatgpt/") ? <ChatGPTUsage /> : <a href={usageUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-sub underline">{t("chatgpt.manageUsage")}<ExternalLink className="h-3 w-3" /></a>}
    <Dialog open={welcome} onOpenChange={open => { if (!open) dismissWelcome(); }}>
      <DialogContent><DialogTitle>{t("chatgpt.welcomeTitle")}</DialogTitle><DialogDescription>{t("chatgpt.welcomeDescription")}</DialogDescription>
        <Button onClick={dismissWelcome}>{t("chatgpt.gotIt")}</Button>
      </DialogContent>
    </Dialog>
  </section>;
}
