import type { ReactNode } from "react";

export function ActionPrompt(props: { eyebrow?: ReactNode; title: ReactNode; detail?: ReactNode; actions?: ReactNode }) {
  return <>{props.eyebrow && <p className="action-kicker">{props.eyebrow}</p>}<h3>{props.title}</h3>{props.detail && <p>{props.detail}</p>}{props.actions}</>;
}
