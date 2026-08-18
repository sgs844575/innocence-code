// NavRail — the 48px icon strip shown on medium windows (and as the
// manually-collapsed state on wide ones). Icon-only shortcuts for whichever
// nav (chat sidebar / settings menu) is active; full navigation stays in the
// overlay drawer. Pure content; the shell column supplies background and
// borders.
import type { LucideIcon } from "lucide-react";

export interface RailItem {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
}

interface Props {
  top?: RailItem;
  items: RailItem[];
  bottom?: RailItem;
}

function RailButton({ icon: Icon, label, onClick, active }: RailItem): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`grid size-9 shrink-0 place-items-center rounded-xl transition-colors ${
        active
          ? "bg-(--color-app-accent-soft) text-(--color-app-accent)"
          : "text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
      }`}
    >
      <Icon size={17} />
    </button>
  );
}

export function NavRail({ top, items, bottom }: Props): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center gap-1 px-1.5 py-2">
      {top && <RailButton {...top} />}
      <div className="mx-auto my-1 h-px w-6 bg-(--color-app-hairline)" />
      <div className="flex flex-col items-center gap-1">
        {items.map((item) => (
          <RailButton key={item.label} {...item} />
        ))}
      </div>
      <div className="flex-1" />
      {bottom && <RailButton {...bottom} />}
    </div>
  );
}
