import { useState } from "react";
import { BrainCircuit, Copy, Eye, RotateCcw, Wrench } from "lucide-react";
import type { ModelInfo } from "../../../../../shared/ipc";
import { Drawer } from "../../ui/Drawer";
import { Switch } from "../../ui/Switch";

interface Props {
  open: boolean;
  model: ModelInfo | null; // id === "" 表示新建
  onClose: () => void;
  onSave: (patch: Partial<ModelInfo> & { dirty?: boolean }) => void;
}

/** cherry 式编辑模型抽屉：每字段失焦/切换即保存（patch 合并 + dirty 标记）。 */
export function EditModelDrawer({ open, model, onClose, onSave }: Props): React.JSX.Element {
  const [draft, setDraft] = useState<ModelInfo | null>(model);
  const [synced, setSynced] = useState<ModelInfo | null>(model);
  // 切换编辑目标时重置草稿。渲染期 setState 是 React 官方的 derived-state 模式（条件
  // 收敛即合法）；按引用比较而非 draft.id，避免新建模式下改 id 后草稿被误重置。
  if (open && model && model !== synced) {
    setSynced(model);
    setDraft(model);
  }
  if (!open || !model || !draft) return <></>;
  const save = (patch: Partial<ModelInfo>) => onSave({ ...patch, dirty: true });
  const num = (v: string): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
  };
  return (
    <Drawer open={open} title={model.id ? "编辑模型" : "添加模型"} onClose={onClose}>
      <div className="flex flex-col gap-5 text-[12.5px]">
        <label className="flex flex-col gap-1">
          <span className="text-(--color-app-muted)">模型 ID</span>
          {model.id ? (
            <span className="flex items-center gap-2 font-mono text-[12px]">
              {model.id}
              <button type="button" aria-label="复制 ID" onClick={() => void navigator.clipboard.writeText(model.id)} className="text-(--color-app-muted) hover:text-(--color-app-text)"><Copy size={12} /></button>
            </span>
          ) : (
            <input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} onBlur={() => save({ id: draft.id })} className="h-8 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) px-2 font-mono text-[12px] outline-none" />
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-(--color-app-muted)">模型名称</span>
          <input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} onBlur={() => save({ name: draft.name })} className="h-8 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) px-2 text-[12px] outline-none" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-(--color-app-muted)">分组名称</span>
          <input value={draft.group ?? ""} onChange={(e) => setDraft({ ...draft, group: e.target.value })} onBlur={() => save({ group: draft.group })} className="h-8 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) px-2 text-[12px] outline-none" />
        </label>
        <section className="flex flex-col gap-2">
          <div className="font-medium">能力</div>
          <div className="flex gap-1.5">
            {([
              ["vision", "视觉", Eye], ["tools", "工具调用", Wrench], ["reasoning", "推理", BrainCircuit],
            ] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                aria-label={label}
                onClick={() => { setDraft({ ...draft, [key]: !draft[key] }); save({ [key]: !draft[key] }); }}
                className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] ${draft[key] ? "border-(--color-app-accent) bg-(--color-app-accent-soft) text-(--color-app-accent)" : "border-(--color-app-border) text-(--color-app-muted)"}`}
              >
                <Icon size={12} />{label}
              </button>
            ))}
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <div className="font-medium">上下文（tokens）</div>
          <div className="grid grid-cols-3 gap-2">
            {([
              ["contextWindow", "上下文窗口", draft.contextWindow], ["maxInput", "最大输入", draft.maxInput], ["maxOutput", "最大输出", draft.maxOutput],
            ] as const).map(([key, label, value]) => (
              <label key={key} className="flex flex-col gap-1">
                <span className="text-[10.5px] text-(--color-app-muted)">{label}</span>
                <input
                  aria-label={label}
                  inputMode="numeric"
                  value={value ?? ""}
                  onChange={(e) => setDraft({ ...draft, [key]: num(e.target.value) })}
                  onBlur={() => save({ [key]: draft[key] })}
                  className="h-8 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) px-2 font-mono text-[12px] outline-none"
                />
              </label>
            ))}
          </div>
        </section>
        <label className="flex items-center justify-between">
          <span>流式输出</span>
          <Switch checked={draft.streaming !== false} onChange={(v) => { setDraft({ ...draft, streaming: v }); save({ streaming: v }); }} aria-label="流式输出" />
        </label>
        <div className="flex items-center gap-2 text-[10.5px] text-(--color-app-muted)/70">
          <RotateCcw size={11} /> 参数默认取预设，改动只存本地，enrich 不会覆盖已修改字段
        </div>
      </div>
    </Drawer>
  );
}
