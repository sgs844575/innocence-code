export function Switch({
  checked, onChange, disabled, "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-(--color-app-accent)" : "bg-(--color-app-border)"}`}
    >
      <span className={`absolute top-0.5 size-3 rounded-full transition-all ${checked ? "right-0.5 bg-(--color-app-accent-fg)" : "left-0.5 bg-(--color-app-muted)"}`} />
    </button>
  );
}
