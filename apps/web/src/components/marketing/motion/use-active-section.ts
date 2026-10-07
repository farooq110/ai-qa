"use client";

import { useEffect, useState } from "react";

/** Index of the section currently crossing the middle of the viewport (-1 before any). */
export function useActiveSection(ids: readonly string[]): number {
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = ids.indexOf(entry.target.id);
          if (index >= 0) setActive(index);
        }
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);

  return active;
}
