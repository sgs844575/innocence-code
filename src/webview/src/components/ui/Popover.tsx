import * as RadixPopover from "@radix-ui/react-popover";
import type { ReactNode } from "react";

interface Props {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  contentClassName?: string;
}

export function Popover({ trigger, children, align = "start", side = "top", contentClassName = "" }: Props): React.JSX.Element {
  return (
    <RadixPopover.Root>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          align={align}
          side={side}
          sideOffset={6}
          className={`z-50 rounded-xl border border-(--color-app-border) bg-(--color-app-panel) shadow-(--shadow-pop) ${contentClassName}`}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
