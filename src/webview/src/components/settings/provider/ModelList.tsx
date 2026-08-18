import type { ProviderProfile } from "../../../../../shared/ipc";

// 最小版：只渲染 models 的简单列表；完整版（同步/编辑/能力标签）在任务 3 实现。
// 接口先行定型，避免任务 3 再改 ProviderDetail 的调用点。
export interface ModelListProps {
  profile: ProviderProfile;
  onChange: (patch: Partial<ProviderProfile>) => void;
  listModels: (profile: ProviderProfile) => Promise<string[]>;
  onToast: (msg: string) => void;
  onPatchModel?: (modelId: string, patch: Record<string, unknown>) => void;
  onSync?: () => void;
}

export function ModelList({ profile }: ModelListProps): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <div className="text-[12.5px] font-medium">模型</div>
      <div className="flex flex-col">
        {profile.models.map((m) => (
          <div key={m.id} className="border-b border-(--color-app-hairline) py-1.5 font-mono text-[12px] text-(--color-app-muted)">
            {m.id}
          </div>
        ))}
        {profile.models.length === 0 && (
          <div className="py-1.5 text-[12px] text-(--color-app-muted)">暂无模型</div>
        )}
      </div>
    </section>
  );
}
