import { useState } from "react";
import { Activity, Eye, EyeOff, KeyRound } from "lucide-react";

/** 密钥输入：隐藏态只读 + 假值掩码（避免掩码回灌 onChange），show 态才可编辑。 */
export function ApiKeyField({
  value, website, onChange, onCheck,
}: {
  value: string;
  website?: string;
  onChange: (key: string) => void;
  onCheck: () => void;
}): React.JSX.Element {
  const [show, setShow] = useState(false);
  return (
    <div className="flex h-8 items-center gap-1 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) px-2">
      <KeyRound size={12} className="shrink-0 text-(--color-app-muted)" />
      <input
        type={show ? "text" : "password"}
        value={show ? value : (value ? "••••••••••••" : "")}
        readOnly={!show}
        onChange={(e) => onChange(e.target.value)}
        placeholder="API 密钥"
        className="w-full bg-transparent font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-(--color-app-muted)"
      />
      <button type="button" aria-label={show ? "隐藏密钥" : "显示密钥"} onClick={() => setShow((v) => !v)} className="shrink-0 text-(--color-app-muted) hover:text-(--color-app-text)">
        {show ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
      <button type="button" aria-label="检查连接" onClick={onCheck} className="shrink-0 text-(--color-app-muted) hover:text-(--color-app-text)">
        <Activity size={13} />
      </button>
      {website && (
        <a href={website} target="_blank" rel="noreferrer" className="shrink-0 text-[11px] text-(--color-app-accent)">获取密钥</a>
      )}
    </div>
  );
}
