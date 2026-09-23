import { createElement, type AriaRole, type ReactNode } from "react";
import { useDisclosure } from "./useDisclosure.js";

interface PopoverProps {
  id: string;
  trigger: ReactNode;
  children: ReactNode;
  ariaLabel?: string;
  panelAs?: "aside" | "div" | "section";
  role?: AriaRole;
  className?: string;
  triggerClassName?: string;
  panelClassName?: string;
}

export function Popover({
  id,
  trigger,
  children,
  ariaLabel,
  panelAs = "div",
  role,
  className = "",
  triggerClassName = "",
  panelClassName = "",
}: PopoverProps) {
  const disclosure = useDisclosure({
    hover: true,
    outsidePress: true,
    clickMode: "toggle",
    closePinnedOnLeave: true,
    restoreFocusOnEscape: true,
  });

  return (
    <div
      className={`popover ${className}`.trim()}
      ref={disclosure.rootRef}
      {...disclosure.rootProps}
    >
      <button
        ref={disclosure.triggerRef}
        className={`popover-trigger ${triggerClassName}`.trim()}
        type="button"
        aria-haspopup={role === "dialog" ? "dialog" : undefined}
        aria-expanded={disclosure.open}
        aria-controls={id}
        {...disclosure.triggerProps}
      >
        {trigger}
      </button>
      {createElement(panelAs, {
        id,
        className: `popover-panel ${panelClassName}`.trim(),
        role,
        "aria-label": ariaLabel,
        hidden: !disclosure.open,
      }, children)}
    </div>
  );
}
