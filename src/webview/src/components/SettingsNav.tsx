// SettingsNav — the first-level settings menu that replaces the project
// sidebar while the settings view is open (reference shots 4/5): a back-to-
// chat row on top, then one entry per settings section. Pure content; the
// shell column (docked / rail / drawer) supplies background and borders.
import { ArrowLeft, Cpu, SlidersHorizontal, Puzzle, Palette, Info } from "lucide-react";

export type SettingsSection = "models" | "general" | "plugins" | "appearance" | "about";

interface Props {
  t: (key: string) => string;
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onBack: () => void;
}

/** Shared with the settings NavRail (medium windows / collapsed state). */
export const SETTINGS_SECTIONS: {
  id: SettingsSection;
  icon: typeof Cpu;
  key: string;
}[] = [
  { id: "models", icon: Cpu, key: "settings.section.models" },
  { id: "general", icon: SlidersHorizontal, key: "settings.section.general" },
  { id: "plugins", icon: Puzzle, key: "settings.section.plugins" },
  { id: "appearance", icon: Palette, key: "settings.section.appearance" },
  { id: "about", icon: Info, key: "settings.section.about" },
];

export function SettingsNav({ t, section, onSelect, onBack }: Props): React.JSX.Element {
  return (
    <nav className="flex h-full w-full flex-col overflow-hidden">
      <div className="px-2 pt-3 pb-2">
        <button
          type="button"
          onClick={onBack}
          className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
        >
          <ArrowLeft size={16} className="shrink-0" />
          <span className="truncate">{t("settings.backToChat")}</span>
        </button>
      </div>

      <div className="flex flex-col gap-0.5 px-2 pb-3">
        {SETTINGS_SECTIONS.map(({ id, icon: Icon, key }) => (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            className={`flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm transition-colors ${
              section === id
                ? "bg-(--color-app-accent-soft) font-medium text-(--color-app-accent)"
                : "text-(--color-app-text) hover:bg-(--color-app-bubble)"
            }`}
          >
            <Icon size={16} className="shrink-0 text-(--color-app-muted)" />
            <span className="truncate">{t(key)}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
