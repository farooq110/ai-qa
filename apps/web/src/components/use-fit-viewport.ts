"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * Caps a sticky panel's height to the viewport space below its current top edge, so its
 * footer (the decision buttons) is visible the moment it opens, not after scrolling.
 */
export function useFitViewport(ref: RefObject<HTMLElement | null>, margin = 12) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const scroller = element.closest(".workspace");
    const fit = () => { element.style.maxHeight = `${Math.max(320, window.innerHeight - element.getBoundingClientRect().top - margin)}px`; };
    fit();
    scroller?.addEventListener("scroll", fit, { passive: true });
    window.addEventListener("resize", fit);
    return () => {
      scroller?.removeEventListener("scroll", fit);
      window.removeEventListener("resize", fit);
    };
  });
}
