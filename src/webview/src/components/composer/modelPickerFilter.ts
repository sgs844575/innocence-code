import type { HarnessSettings, ModelInfo, ProviderProfile } from "../../../../shared/ipc";

/** 启用厂家；query 同时匹配厂家名与模型 id/name，命中的厂家保留（模型行也过滤）。 */
export function filterProfiles(settings: HarnessSettings, query: string): ProviderProfile[] {
  const q = query.trim().toLowerCase();
  return settings.profiles
    .filter((p) => p.enabled && p.models.length > 0)
    .map((p) => {
      if (!q) return p;
      if (p.name.toLowerCase().includes(q)) return p;
      const models = p.models.filter(
        (m: ModelInfo) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q),
      );
      return models.length > 0 ? { ...p, models } : null;
    })
    .filter((p): p is ProviderProfile => p !== null);
}
