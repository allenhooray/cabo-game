import type { ReactNode } from "react";

export function ScoreList(props: { children: ReactNode }) {
  return <div className="score-list">{props.children}</div>;
}

export function PlayerScoreRow(props: { label: ReactNode; score: ReactNode }) {
  return <div><span>{props.label}</span><strong>{props.score}</strong></div>;
}
