// 获取模型同步抽屉：拉回 → 新增/失效/保留三段预览 → 单条或批量应用（cherry 同步流程）。
// plan 从 profile.models 派生而非一次性快照：每次应用后父级 settings 更新回流，
// 三段计数与行归属即时刷新。
import { useEffect, useMemo, useState } from "react";
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
  onApply: (plan: SyncPlan, opts?: { closeAfter?: boolean }) => void;
  modelFromPreset: (providerName: string, id: string) => ModelInfo;
}

const chipBtn =
  "ml-auto flex items-center gap-1 rounded-full border border-(--color-app-border) px-2 py-0.5 text-[11px] text-(--color-app-muted) hover:bg-(--color-app-bubble)/50 hover:text-(--color-app-text)";
const rowBtn =
  "grid size-5 shrink-0 place-items-center rounded-md text-(--color-app-muted) hover:bg-(--color-app-bubble)/50";

export function SyncDrawer({
  open,
  profile,
  onClose,
  listModels,
  onApply,
  modelFromPreset,
}: Props): React.JSX.Element {
  const [fetched, setFetched] = useState<string[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setFetched(null);
    setError("");
    listModels(profile).then(setFetched, (err) =>
      setError(err instanceof Error ? err.message.slice(0, 200) : String(err)),
    );
  }, [open, profile, listModels]);

  const plan = useMemo(
    () => (fetched ? mergeSync(profile.models, fetched, profile.name, modelFromPreset) : null),
    [fetched, profile, modelFromPreset],
  );

  if (!open) return <></>;

  // 单条操作：applySyncPlan 语义是 kept + added，所以单条添加把本地全部
  //（kept ∪ removed）放 kept、目标单独放 added；单条移除从本地全部里剔除。
  const addOne = (m: ModelInfo) => {
    if (!plan) return;
    onApply({ ...plan, kept: [...plan.kept, ...plan.removed], added: [m] });
  };
  const removeOne = (m: ModelInfo) => {
    if (!plan) return;
    onApply({
      ...plan,
      kept: [...plan.kept, ...plan.removed].filter((x) => x.id !== m.id),
      added: [],
    });
  };

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
                  // 只加新不清失效：removed 一并入 kept，避免批量添加顺手静默删除。
                  onClick={() =>
                    onApply({
                      ...plan,
                      kept: [...plan.kept, ...plan.removed, ...plan.added],
                      added: [],
                    })
                  }
                  className={chipBtn}
                >
                  <Plus size={11} />全部添加
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
                <button type="button" aria-label={`添加 ${m.id}`} title="添加" onClick={() => addOne(m)} className={`${rowBtn} text-(--color-tool-ok)`}>
                  <Plus size={13} />
                </button>
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
                      ...plan,
                      kept: plan.kept.filter((k) => !plan.removed.some((r) => r.id === k.id)),
                      added: [],
                    })
                  }
                  className={chipBtn}
                >
                  <Trash2 size={11} />清理失效
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
                <button type="button" aria-label={`移除 ${m.id}`} title="移除" onClick={() => removeOne(m)} className={`${rowBtn} text-(--color-tool-err)`}>
                  <Trash2 size={13} />
                </button>
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
            onClick={() => onApply(plan, { closeAfter: true })}
            className="self-start rounded-lg bg-(--color-app-accent) px-3 py-1.5 text-[12px] font-medium text-(--color-app-accent-fg)"
          >
            应用全部变更（+{plan.added.length} / −{plan.removed.length}）
          </button>
        </div>
      )}
    </Drawer>
  );
}
