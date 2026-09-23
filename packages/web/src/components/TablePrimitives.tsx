import type { ReactNode } from "react";
import type { StatePlayer } from "@cabo-game/client-core";
import { useTranslation } from "react-i18next";
import { Overlay } from "./Overlays.js";

export function Modal(props: { title: string; children: ReactNode; onClose?(): void }) {
  const { t } = useTranslation();
  return <Overlay className="modal-layer" role="dialog" ariaModal ariaLabelledBy="modal-title"><section className="modal-card"><div className="modal-heading"><p className="eyebrow">{t("modal.table")}</p>{props.onClose && <button type="button" aria-label={t("common.close")} onClick={props.onClose}>×</button>}</div><h2 id="modal-title">{props.title}</h2>{props.children}</section></Overlay>;
}

export function Avatar({ player }: { player: StatePlayer }) {
  const initials = player.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return <span className="avatar" aria-hidden="true">{initials || "?"}</span>;
}

export function CardFace(props: { label: string; rank: number }) {
  const { t } = useTranslation();
  const match = props.label.match(/^(.*?)([SHDC♣♦♥♠])$/);
  const suit = match?.[2] ? suitGlyph(match[2]) : "";
  const rank = match?.[1] ?? props.label;
  return <><span className="card-rank">{rank}</span><span className="card-suit">{suit}</span><span className="card-points">{props.rank >= 0 ? t("common.points", { count: props.rank }) : ""}</span></>;
}

export function formatCardLabel(label: string): string {
  const match = label.match(/^(.*?)([SHDC])$/);
  return match?.[1] && match[2] ? `${match[1]}${suitGlyph(match[2])}` : label;
}

export function CardToken(props: { label: string; variant: "result" | "mini" | "motion" }) {
  const content = formatCardLabel(props.label);
  if (props.variant === "mini") return <i>{content}</i>;
  if (props.variant === "result") return <span>{content}</span>;
  return <>{content}</>;
}

function suitGlyph(suit: string): string {
  return ({ S: "♠", H: "♥", D: "♦", C: "♣" } as Record<string, string>)[suit] ?? suit;
}
