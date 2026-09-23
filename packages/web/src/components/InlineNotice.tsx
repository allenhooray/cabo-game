import type { ReactNode } from "react";

export function InlineNotice(props: { children: ReactNode; className?: string; role: "status" | "alert"; onClose?(): void; closeLabel?: string }) {
  const content = props.onClose ? <><span>{props.children}</span><button type="button" aria-label={props.closeLabel} onClick={props.onClose}>×</button></> : props.children;
  const Element = props.className === "readonly-banner" || props.className === "notice" ? "div" : props.className === "form-notice" || props.className === "reconnecting" ? "p" : "span";
  return <Element className={props.className} role={props.role}>{content}</Element>;
}
