import { useCallback, useRef, useState } from "react";
import type { RoomChatMessage } from "@cabo-game/shared";

export function useRoomChat() {
  const [messages, setMessages] = useState<RoomChatMessage[]>([]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState("");
  const openRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const receive = useCallback((message: RoomChatMessage) => {
    setMessages((current) => [...current, message].slice(-50));
    if (window.innerWidth <= 760 && !openRef.current) setUnread((current) => current + 1);
  }, []);

  const openDrawer = useCallback(() => {
    openRef.current = true;
    setOpen(true);
    setUnread(0);
  }, []);

  const closeDrawer = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const resetContent = useCallback(() => {
    setMessages([]);
    setUnread(0);
    setDraft("");
  }, []);

  const resetAll = useCallback(() => {
    resetContent();
    openRef.current = false;
    setOpen(false);
  }, [resetContent]);

  return {
    messages,
    open,
    unread,
    draft,
    triggerRef,
    setDraft,
    receive,
    openDrawer,
    closeDrawer,
    resetContent,
    resetAll,
  };
}
