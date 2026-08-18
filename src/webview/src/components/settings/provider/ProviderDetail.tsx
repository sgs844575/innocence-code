import { ExternalLink } from "lucide-react";
import type { ProviderProfile } from "../../../../../shared/ipc";
import { ApiHostField } from "./ApiHostField";
import { ApiKeyField } from "./ApiKeyField";
import { ModelList } from "./ModelList";
import { presetFor } from "./presetLinks";
import { Switch } from "../../ui/Switch";

interface Props {
  profile: ProviderProfile;
  listModels: (profile: ProviderProfile) => Promise<string[]>;
  onChange: (patch: Partial<ProviderProfile>) => void;
  onToast: (msg: string) => void;
}

/** cherry 式厂家详情：名称 + 启用开关 + 密钥 + 地址 + 模型列表（max-w-3xl 居中）。 */
export function ProviderDetail({ profile, listModels, onChange, onToast }: Props): React.JSX.Element {
  const preset = presetFor(profile.name);
  const check = () => {
    void listModels(profile).then(
      (ids) => onToast(`连接正常，${ids.length} 个模型可用`),
      (err) => onToast(`连接失败：${(err as Error).message.slice(0, 120)}`),
    );
  };
  return (
    <div className="scrollbar-thin h-full flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-2">
          <h1 className="text-[15px] font-semibold">{profile.name}</h1>
          {preset?.website && (
            <a href={preset.website} target="_blank" rel="noreferrer" className="text-(--color-app-muted) hover:text-(--color-app-text)"><ExternalLink size={13} /></a>
          )}
          <div className="ml-auto flex items-center gap-2 text-[12px] text-(--color-app-muted)">启用<Switch checked={profile.enabled} onChange={(v) => onChange({ enabled: v })} aria-label="启用厂家" /></div>
        </div>
        <section className="flex flex-col gap-2">
          <div className="text-[12.5px] font-medium">API 密钥</div>
          <ApiKeyField value={profile.apiKey} website={preset?.apiKeyWebsite} onChange={(key) => onChange({ apiKey: key })} onCheck={check} />
        </section>
        <section className="flex flex-col gap-2">
          <div className="text-[12.5px] font-medium">API 地址</div>
          <ApiHostField kind={profile.kind} baseURL={profile.baseURL} presetBaseURL={preset?.baseURL ?? ""} onChange={(url) => onChange({ baseURL: url })} />
        </section>
        <ModelList profile={profile} onChange={onChange} listModels={listModels} onToast={onToast} />
      </div>
    </div>
  );
}
