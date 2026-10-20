"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * Pins an open dropdown menu to its trigger with position: fixed, so panels with
 * overflow (inspector, modals, the workspace) never clip it. It flips above the
 * trigger when there is no room below and slides left instead of overflowing the
 * right edge. Scrolling anything but the menu, or resizing, closes it.
 */
export function useAnchoredMenu(open: boolean, anchorRef: RefObject<HTMLElement | null>, menuRef: RefObject<HTMLElement | null>, onClose: () => void) {
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current, menu = menuRef.current;
    if (!anchor || !menu) return;
    const gap = 4, edge = 8;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      menu.style.position = "fixed";
      // Anchor first: a fixed box at left 0 measures as wide as the viewport, so measure after placing.
      menu.style.left = `${rect.left}px`;
      menu.style.minWidth = `${rect.width}px`;
      menu.style.maxWidth = `${Math.min(360, window.innerWidth - edge * 2)}px`;
      const below = window.innerHeight - rect.bottom - gap - edge;
      const above = rect.top - gap - edge;
      const openUp = menu.offsetHeight > below && above > below;
      menu.style.maxHeight = `${Math.max(140, Math.min(320, openUp ? above : below))}px`;
      menu.style.top = openUp ? `${rect.top - gap - menu.offsetHeight}px` : `${rect.bottom + gap}px`;
      const width = menu.offsetWidth;
      if (rect.left + width > window.innerWidth - edge) menu.style.left = `${Math.max(edge, window.innerWidth - edge - width)}px`;
    };
    place();
    // Re-place once layout settles (fonts, scrollbars), which can change the menu's width.
    const frame = requestAnimationFrame(place);

    const onScroll = (event: Event) => { if (!menu.contains(event.target as Node)) onClose(); };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, anchorRef, menuRef, onClose]);
}
