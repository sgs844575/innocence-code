// 获取模型同步抽屉：拉回 → 新增/移除预览 → 批量应用（cherry 同步流程）。
import { useEffect, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import type { ModelInfo, ProviderProfile } from "../../../../../shared/ipc";
import { CapabilityTags } from "../../tags/CapabilityTags";
import { Drawer } from "../../ui/Drawer";
import { mergeSync, type SyncPlan } from "./mergeSync";

interface Props {
  open: boolean;
  profile: ProviderProfile;
  onClose: () => void;
  listModels: (profile: ProviderProfile) => Promise<string[]>;
  onApply: (plan: SyncPlan) => void;
  modelFromPreset: (providerName: string, id: string) => ModelInfo;
}

/** 获取模型同步抽屉：拉回 → 新增/移除预览 → 批量应用。 */
export function SyncDrawer({
  open,
  profile,
  onClose,
  listModels,
  onApply,
  modelFromPreset,
}: Props): React.JSX.Element {
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setError("");
    listModels(profile).then(
      (ids) => setPlan(mergeSync(profile.models, ids, profile.name, modelFromPreset)),
      (err) => setError((err as Error).message.slice(0, 200)),
    );
  }, [open, profile, listModels, modelFromPreset]);

  return (
    <Drawer open={open} title="获取模型" onClose={onClose} width={420}>
      {error && (
        <div className="rounded-lg border border-(--color-tool-err)/40 bg-(--color-diff-del-bg) p-3 text-[12px] text-(--color-tool-err)">
          {error}
        </div>
      )}
      {!plan && !error && (
        <div className="text-[12px] text-(--color-app-muted)">正在获取模型列表…</div>
      )}
      {plan && (
        <div className="flex flex-col gap-4 text-[12px]">
          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <Plus size={13} className="text-(--color-tool-ok)" />
              新增 <span className="text-(--color-app-muted)">{plan.added.length}</span>
              {plan.added.length > 0 && (
                <button
                  type="button"
                  // 只加新不清失效：removed 一并入 kept（onApply 语义 = kept + added），
                  // 避免"全部添加"顺手静默删除失效模型。
                  onClick={() =>
                    onApply({
                      ...plan,
                      kept: [...plan.kept, ...plan.removed, ...plan.added],
                      added: [],
                    })
                  }
                  className="ml-auto rounded-lg border border-(--color-app-border) px-2 py-0.5 text-[11px] hover:bg-(--color-app-bubble)/50"
                >
                  全部添加
                </button>
              )}
            </div>
            {plan.added.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2 border-b border-(--color-app-hairline) py-1.5"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{m.id}</span>
                <CapabilityTags model={m} />
                {m.contextWindow != null && (
                  <span className="font-mono text-[10px] text-(--color-app-muted)">
                    {Math.round(m.contextWindow / 1000)}K
                  </span>
                )}
              </div>
            ))}
          </section>
          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <Trash2 size={13} className="text-(--color-tool-err)" />
              失效 <span className="text-(--color-app-muted)">{plan.removed.length}</span>
              {plan.removed.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    onApply({
                      added: [],
                      removed: plan.removed,
                      kept: plan.kept.filter((k) => !plan.removed.some((r) => r.id === k.id)),
                    })
                  }
                  className="ml-auto rounded-lg border border-(--color-app-border) px-2 py-0.5 text-[11px] hover:bg-(--color-app-bubble)/50"
                >
                  清理失效
                </button>
              )}
            </div>
            {plan.removed.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2 border-b border-(--color-app-hairline) py-1.5"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-(--color-app-muted) line-through">
                  {m.id}
                </span>
              </div>
            ))}
          </section>
          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <Check size={13} className="text-(--color-app-muted)" />
              保留 <span className="text-(--color-app-muted)">{plan.kept.length}</span>
            </div>
          </section>
          <button
            type="button"
            onClick={() => onApply(plan)}
            className="self-start rounded-lg bg-(--color-app-accent) px-3 py-1.5 text-[12px] font-medium text-(--color-app-accent-fg)"
          >
            应用全部变更（+{plan.added.length} / −{plan.removed.length}）
          </button>
        </div>
      )}
    </Drawer>
  );
}
