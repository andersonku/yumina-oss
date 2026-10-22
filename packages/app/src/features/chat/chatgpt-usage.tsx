import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

export function ChatGPTUsage() {
  const { t } = useTranslation("profile");
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-emerald-300">
    <span>{t("chatgpt.usingPlan")}</span>
    <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">{t("chatgpt.manageUsage")}<ExternalLink className="h-3 w-3" /></a>
  </div>;
}
