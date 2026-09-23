import type { PrivateRevealMessage } from "@cabo-game/shared";
import { formatCardLabel } from "../../components/TablePrimitives.js";
import { useTranslation } from "react-i18next";
import { Overlay } from "../../components/Overlays.js";

export function PrivateReveal(props: { message: PrivateRevealMessage; onClose(): void }) {
  const { t } = useTranslation();
  return <Overlay className="reveal-layer" role="dialog" ariaModal ariaLabel={t("game.privateReveal")} onClick={props.onClose}><div className="reveal-card"><p>{t("game.forEyesOnly")}</p><div className="reveal-flip"><div className="reveal-flip-inner"><div className="reveal-face reveal-back" aria-hidden="true"><span>C</span></div><div className="reveal-face reveal-front"><strong>{formatCardLabel(props.message.card.label)}</strong><span>{t("common.points", { count: props.message.card.rank })}</span></div></div></div><small>{t("game.closingAutomatically")}</small></div></Overlay>;
}
