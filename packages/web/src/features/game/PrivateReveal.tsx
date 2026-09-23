import type { PrivateRevealMessage } from "@cabo-game/shared";
import { formatCardLabel } from "../../components/TablePrimitives.js";

export function PrivateReveal(props: { message: PrivateRevealMessage; onClose(): void }) {
  return <div className="reveal-layer" role="dialog" aria-modal="true" aria-label="Private card reveal" onClick={props.onClose}><div className="reveal-card"><p>For your eyes only</p><div className="reveal-flip"><div className="reveal-flip-inner"><div className="reveal-face reveal-back" aria-hidden="true"><span>C</span></div><div className="reveal-face reveal-front"><strong>{formatCardLabel(props.message.card.label)}</strong><span>{props.message.card.rank} points</span></div></div></div><small>Closing automatically</small></div></div>;
}
