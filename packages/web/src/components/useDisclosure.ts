import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";

interface DisclosureOptions {
  hover?: boolean;
  outsidePress?: boolean;
  clickMode?: "open" | "toggle" | "pin";
  closePinnedOnLeave?: boolean;
  restoreFocusOnEscape?: boolean;
}

export function useDisclosure(options: DisclosureOptions = {}) {
  const [preview, setPreview] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pointerFocus = useRef(false);
  const ignoreNextFocus = useRef(false);
  const open = preview || pinned;

  const close = (restoreFocus = false) => {
    setPreview(false);
    setPinned(false);
    if (restoreFocus && triggerRef.current && document.activeElement !== triggerRef.current) {
      ignoreNextFocus.current = true;
      triggerRef.current.focus();
    }
  };

  useEffect(() => {
    if (!options.outsidePress) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [options.outsidePress]);

  return {
    open,
    pinned,
    rootRef,
    triggerRef,
    close,
    rootProps: {
      onMouseEnter: options.hover ? () => setPreview(true) : undefined,
      onMouseLeave: options.hover ? () => {
        setPreview(false);
        if (options.closePinnedOnLeave) setPinned(false);
      } : undefined,
      onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (event.target === triggerRef.current) pointerFocus.current = true;
      },
      onFocus: options.hover ? () => {
        if (ignoreNextFocus.current) {
          ignoreNextFocus.current = false;
          return;
        }
        if (!pointerFocus.current) setPreview(true);
      } : undefined,
      onBlur: (event: FocusEvent<HTMLDivElement>) => {
        pointerFocus.current = false;
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") close(options.restoreFocusOnEscape);
      },
    },
    triggerProps: {
      onClick: () => {
        pointerFocus.current = false;
        if (options.clickMode === "toggle") {
          if (open) close();
          else setPinned(true);
        }
        else setPinned(true);
      },
    },
  };
}
