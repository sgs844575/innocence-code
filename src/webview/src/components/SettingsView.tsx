// Settings content area — renders the section picked in SettingsNav.
// 只做节分发：models → ProviderSettingsPage（模型服务整页），其余 → 基础节。
import type { HarnessSettings } from "../../../shared/ipc";
import type { SettingsSection } from "./SettingsNav";
import { AboutSection, AppearanceSection, GeneralSection } from "./settings/BasicSections";
import { PluginsSection } from "./settings/PluginsSection";
import { ProviderSettingsPage } from "./settings/provider/ProviderSettingsPage";

interface Props {
  t: (key: string) => string;
  section: SettingsSection;
  settings: HarnessSettings;
  appInfo: { version: string; platform: NodeJS.Platform } | null;
  onSettingsChange: (next: HarnessSettings) => void;
  onPickWorkspace: () => void;
}

const SECTION_TITLE_KEY: Record<SettingsSection, string> = {
  models: "settings.section.models",
  general: "settings.section.general",
  plugins: "settings.section.plugins",
  appearance: "settings.section.appearance",
  about: "settings.section.about",
};

export function SettingsView({
  t,
  section,
  settings,
  appInfo,
  onSettingsChange,
  onPickWorkspace,
}: Props): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center border-b border-(--color-app-hairline) px-4 text-sm font-medium">
        {t(SECTION_TITLE_KEY[section])}
      </header>

      {section === "models" ? (
        <ProviderSettingsPage settings={settings} onSettingsChange={onSettingsChange} />
      ) : (
        <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-xl px-[clamp(14px,4vw,24px)] py-5">
            {section === "general" && (
              <GeneralSection
                t={t}
                settings={settings}
                onSettingsChange={onSettingsChange}
                onPickWorkspace={onPickWorkspace}
              />
            )}
            {section === "plugins" && (
              <PluginsSection t={t} settings={settings} onSettingsChange={onSettingsChange} />
            )}
            {section === "appearance" && (
              <AppearanceSection t={t} settings={settings} onSettingsChange={onSettingsChange} />
            )}
            {section === "about" && <AboutSection t={t} appInfo={appInfo} />}
          </div>
        </div>
      )}
    </div>
  );
}
