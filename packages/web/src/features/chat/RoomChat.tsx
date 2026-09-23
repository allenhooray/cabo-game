import { useEffect, useRef, useState, type FormEvent } from "react";
import type { RoomChatMessage } from "@cabo-game/shared";
import { useTranslation } from "react-i18next";
import { usePreferences } from "../../i18n/I18nProvider.js";

interface RoomChatProps {
  messages: RoomChatMessage[];
  selfId: string;
  enabled: boolean;
  status: string;
  draft: string;
  onDraft(value: string): void;
  autoFocus?: boolean;
  onClose?(): void;
  onSend(text: string): void;
}

export function RoomChat({ messages, selfId, enabled, status, draft, onDraft, autoFocus, onClose, onSend }: RoomChatProps) {
  const { t } = useTranslation();
  const { locale } = usePreferences();
  const [validation, setValidation] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onClose) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (stickToBottom.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) {
      setValidation(t("chat.enter"));
      return;
    }
    if (Array.from(text).length > 200) {
      setValidation(t("chat.tooLong"));
      return;
    }
    if (!enabled) return;
    onSend(text);
    onDraft("");
    setValidation(undefined);
  };

  const count = Array.from(draft.trim()).length;
  const validationId = autoFocus ? "chat-validation-drawer" : "chat-validation-sidebar";
  return (
    <div className="room-chat">
      <div className="chat-heading"><div><span>{t("chat.room")}</span><small>{t("chat.ephemeral")}</small></div></div>
      <div
        ref={listRef}
        className="chat-messages"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {messages.length === 0 && <p className="chat-empty">{t("chat.empty")}</p>}
        {messages.map((message) => (
          <article className="chat-message" key={message.sequence}>
            <div><strong>{message.playerId === selfId ? t("chat.you") : message.playerName}</strong><time dateTime={new Date(message.sentAt).toISOString()}>{formatChatTime(message.sentAt, locale)}</time></div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
      <form className="chat-compose" onSubmit={submit}>
        <label htmlFor={autoFocus ? "chat-message-drawer" : "chat-message-sidebar"}>{t("chat.message")}</label>
        <div>
          <input
            ref={inputRef}
            id={autoFocus ? "chat-message-drawer" : "chat-message-sidebar"}
            value={draft}
            disabled={!enabled}
            autoComplete="off"
            placeholder={enabled ? t("chat.placeholder") : status}
            aria-describedby={validation ? validationId : undefined}
            onChange={(event) => {
              onDraft(event.target.value);
              setValidation(Array.from(event.target.value.trim()).length > 200 ? t("chat.tooLong") : undefined);
            }}
          />
          <button type="submit" disabled={!enabled || !draft.trim() || count > 200}>{t("chat.send")}</button>
        </div>
        <small id={validation ? validationId : undefined} className={validation ? "chat-validation" : "chat-count"}>{validation ?? `${count}/200`}</small>
      </form>
    </div>
  );
}

function formatChatTime(sentAt: number, locale: string): string {
  return new Date(sentAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}
