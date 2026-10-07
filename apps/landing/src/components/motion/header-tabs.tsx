"use client";

import type { ReactNode } from "react";
import { useActiveSection } from "./use-active-section";

export type HeaderTab = { readonly href: `#${string}`; readonly label: string; readonly count: number; readonly icon: ReactNode };

/** PR-style tab strip: icon, label, count, and an underline on the section in view. */
export function HeaderTabs({ tabs, ids }: { tabs: readonly HeaderTab[]; ids: readonly string[] }) {
  const activeIndex = useActiveSection(ids);
  const activeId = activeIndex >= 0 ? ids[activeIndex] : undefined;

  return (
    <ul className="flex h-full items-stretch">
      {tabs.map((tab) => {
        const current = tab.href.slice(1) === activeId;
        return (
          <li key={tab.href} className="flex">
            <a
              href={tab.href}
              aria-current={current ? "location" : undefined}
              className={`relative flex items-center gap-2 px-3 text-sm transition-colors after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:origin-left after:rounded-full after:bg-pending after:transition-transform after:duration-300 after:ease-[var(--ease-out-expo)] ${
                current ? "text-fg after:scale-x-100" : "text-dim after:scale-x-0 hover:text-fg"
              }`}
            >
              <span className="hidden text-muted lg:inline">{tab.icon}</span>
              {tab.label}
              <span className="hidden rounded-full bg-raised px-1.5 xl:inline py-px font-mono text-[10.5px] text-muted">{tab.count}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
