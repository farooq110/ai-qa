"use client";

import { Info } from "lucide-react";

/** Small info icon with a hover/focus tooltip; tooltip content is plain JSX. */
import { useEffect, useRef, useState } from "react";

export function InfoTooltip({ children, label }: { children: React.ReactNode; label?: string }) {
  const bodyRef = useRef<HTMLSpanElement | null>(null);
  const [align, setAlign] = useState<"center" | "left" | "right">("center");

  useEffect(() => {
    // Measure only while the tooltip is shown (focus/hover) and clamp alignment
    // so the panel never clips past the viewport edge.
    const el = bodyRef.current;
    if (!el || el.style.display === "none") return;
    const rect = el.getBoundingClientRect();
    if (rect.left < 8) setAlign("left");
    else if (rect.right > window.innerWidth - 8) setAlign("right");
  });

  return (
    <span className="info-tip" tabIndex={0} role="note" aria-label={label}>
      <Info size={13} />
      <span className={`info-tip-body align-${align}`} ref={bodyRef}>{children}</span>
    </span>
  );
}
