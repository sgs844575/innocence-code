import type { ProviderProfile } from "../../../../../shared/ipc";

export type ProviderFilterMode = "all" | "enabled";

/** 搜索命中厂家名或任一模型 id/name；与启用筛选取交集。 */
export function filterProviderList(
  profiles: ProviderProfile[],
  query: string,
  mode: ProviderFilterMode,
): ProviderProfile[] {
  const q = query.trim().toLowerCase();
  return profiles.filter((p) => {
    if (mode === "enabled" && !p.enabled) return false;
    if (!q) return true;
    if (p.name.toLowerCase().includes(q)) return true;
    return p.models.some(
      (m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q),
    );
  });
}
