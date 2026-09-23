import { useEffect, type MouseEvent, type ReactNode } from "react";

interface OverlayProps {
  children: ReactNode;
  className: string;
  role?: "presentation" | "dialog";
  ariaModal?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  onBackdropClose?(): void;
  onClick?(): void;
}

export function Overlay({ children, className, role = "presentation", ariaModal, ariaLabel, ariaLabelledBy, onBackdropClose, onClick }: OverlayProps) {
  return <div className={className} role={role} {...(ariaModal === undefined ? {} : { "aria-modal": ariaModal })} {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })} {...(ariaLabelledBy === undefined ? {} : { "aria-labelledby": ariaLabelledBy })} onMouseDown={onBackdropClose ? (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onBackdropClose();
  } : undefined} onClick={onClick}>{children}</div>;
}

interface DialogProps {
  children: ReactNode;
  className: string;
  as?: "div" | "section";
  ariaLabel?: string;
  ariaLabelledBy?: string;
  onClose?(): void;
  closeOnEscape?: boolean;
}

export function Dialog({ children, className, as = "section", ariaLabel, ariaLabelledBy, onClose, closeOnEscape = false }: DialogProps) {
  useEffect(() => {
    if (!closeOnEscape || !onClose) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeOnEscape, onClose]);

  const Element = as;
  return <Element className={className} role="dialog" aria-modal="true" {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })} {...(ariaLabelledBy === undefined ? {} : { "aria-labelledby": ariaLabelledBy })}>{children}</Element>;
}
