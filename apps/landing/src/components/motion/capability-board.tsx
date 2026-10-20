"use client";

import { useId, useState } from "react";
import { LayoutGroup, motion } from "motion/react";
import { Folder, Layers } from "lucide-react";
import { capabilities, type SuiteTest } from "@/content/capabilities";

type View = keyof typeof capabilities.views;

function groupBy(tests: readonly SuiteTest[], key: "capability" | "folder") {
  const groups = new Map<string, SuiteTest[]>();
  for (const t of tests) groups.set(t[key], [...(groups.get(t[key]) ?? []), t]);
  return [...groups.entries()];
}

const spring = { type: "spring", stiffness: 380, damping: 34, mass: 0.8 } as const;

export function CapabilityBoard() {
  const [view, setView] = useState<View>("capability");
  const groups = groupBy(capabilities.tests, view);
  const tabsId = useId();

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <span className="font-mono text-[12px] text-muted">acme/storefront · 8 of 142 tests</span>
        <div role="tablist" aria-label="Group tests" className="relative flex rounded-lg border border-line bg-sunken p-0.5">
          {(Object.keys(capabilities.views) as View[]).map((v) => {
            const selected = v === view;
            return (
              <button
                key={v}
                role="tab"
                type="button"
                id={`${tabsId}-${v}`}
                aria-selected={selected}
                aria-controls={`${tabsId}-panel`}
                onClick={() => setView(v)}
                className={`relative z-10 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  selected ? "text-fg" : "text-muted hover:text-dim"
                }`}
              >
                {selected && (
                  <motion.span layoutId={`${tabsId}-pill`} transition={spring} className="absolute inset-0 -z-10 rounded-md bg-raised shadow-[0_1px_0_rgb(255_255_255/0.06)_inset]" />
                )}
                {v === "capability" ? <Layers size={14} aria-hidden /> : <Folder size={14} aria-hidden />}
                {capabilities.views[v]}
              </button>
            );
          })}
        </div>
      </div>

      <LayoutGroup>
        <div
          id={`${tabsId}-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-${view}`}
          className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3"
        >
          {groups.map(([group, tests]) => (
            <motion.section layout="position" key={`${view}-${group}`} transition={spring} className="flex flex-col gap-2 bg-panel p-4 sm:p-5">
              <motion.h3 layout="position" className={`mb-1 flex items-center gap-2 text-[14px] font-semibold ${view === "folder" ? "font-mono text-[12.5px] font-normal text-dim" : ""}`}>
                {view === "capability" ? <Layers size={14} className="text-ai" aria-hidden /> : <Folder size={14} className="text-muted" aria-hidden />}
                {group}
                <span className="ml-auto font-mono text-[11px] font-normal text-muted">{tests.length}</span>
              </motion.h3>
              {tests.map((t) => (
                <motion.div
                  layoutId={t.id}
                  key={t.id}
                  transition={spring}
                  className="flex flex-col gap-1.5 rounded-lg border border-line bg-raised px-3 py-2"
                >
                  <span className="flex items-center gap-2">
                    <span className="size-1.5 shrink-0 rounded-full bg-approve" aria-hidden />
                    <span className="min-w-0 text-[13.5px] leading-snug">{t.name}</span>
                  </span>
                  <span className={`flex flex-wrap gap-1 pl-3.5 ${t.tags.length ? "" : "hidden"}`}>
                    {t.tags.map((tag) => (
                      <span key={tag} className="rounded border border-line-strong px-1.5 font-mono text-[10.5px] text-muted">
                        {tag}
                      </span>
                    ))}
                  </span>
                </motion.div>
              ))}
            </motion.section>
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}
