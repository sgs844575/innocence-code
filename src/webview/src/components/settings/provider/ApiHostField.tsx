import { RotateCcw } from "lucide-react";

/** API 地址输入 + 最终请求地址预览 + 恢复预设。 */
export function ApiHostField({
  kind, baseURL, presetBaseURL, onChange,
}: {
  kind: "openai" | "anthropic";
  baseURL: string;
  presetBaseURL: string;
  onChange: (url: string) => void;
}): React.JSX.Element {
  const base = baseURL || presetBaseURL;
  const path = kind === "anthropic" ? "/v1/messages" : "/models";
  return (
    <div>
      <div className="flex h-8 items-center gap-1 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) px-2">
        <input
          value={baseURL}
          onChange={(e) => onChange(e.target.value)}
          placeholder={presetBaseURL || "https://api.openai.com/v1"}
          className="w-full bg-transparent font-mono text-[12px] outline-none placeholder:text-(--color-app-muted)"
        />
        <button type="button" aria-label="恢复预设地址" title="恢复预设地址" onClick={() => onChange(presetBaseURL)} className="shrink-0 text-(--color-app-muted) hover:text-(--color-app-text)">
          <RotateCcw size={13} />
        </button>
      </div>
      <div className="mt-1 truncate font-mono text-[10.5px] text-(--color-app-muted)/70">{base.replace(/\/+$/, "")}{path}</div>
    </div>
  );
}
