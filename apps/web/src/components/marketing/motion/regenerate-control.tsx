"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, GitCompareArrows, Info, RotateCcw, TriangleAlert } from "lucide-react";
import { regeneration, type RegenerationMode } from "@/content/regeneration";
import { toneClass, type Tone } from "@/components/marketing/ui/tone";

const ease = [0.16, 1, 0.3, 1] as const;
const modeIds = Object.keys(regeneration.modes) as RegenerationMode[];

/** Working replica of the dashboard's split Regenerate control. */
export function RegenerateControl() {
  const [mode, setMode] = useState<RegenerationMode>("incremental");
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [runId, setRunId] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const run = (next: RegenerationMode) => {
    setOpen(false);
    if (next === "full") return setConfirming(true);
    setMode(next);
    setRunId((n) => n + 1);
  };

  const current = regeneration.modes[mode];

  return (
    <div className="mkt-panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <GitCompareArrows size={16} className="text-muted" aria-hidden />
        <code className="font-mono text-[12.5px] text-dim">
          {regeneration.base}
          <span className="text-muted">...</span>
          <span className="text-fg">{regeneration.target}</span>
        </code>

        <div ref={menuRef} className="relative ml-auto flex">
          <button
            type="button"
            onClick={() => run("incremental")}
            className="inline-flex h-9 items-center gap-2 rounded-l-lg bg-fg px-3.5 text-[13px] font-semibold text-ground transition-colors hover:bg-white"
          >
            <RotateCcw size={14} aria-hidden />
            Regenerate
          </button>
          <button
            type="button"
            aria-label="More regeneration options"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex h-9 items-center rounded-r-lg border-l border-ground/20 bg-fg px-2 text-ground transition-colors hover:bg-white"
          >
            <ChevronDown size={15} className={`transition-transform duration-300 ${open ? "rotate-180" : ""}`} aria-hidden />
          </button>

          <AnimatePresence>
            {open && (
              <motion.div
                id={menuId}
                role="menu"
                initial={{ opacity: 0, y: -6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.22, ease }}
                className="mkt-panel absolute right-0 top-11 z-20 w-[min(20rem,calc(100vw-3rem))] origin-top-right p-1.5"
              >
                {modeIds.map((id) => {
                  const m = regeneration.modes[id];
                  return (
                    <button
                      key={id}
                      type="button"
                      role="menuitem"
                      onClick={() => run(id)}
                      className="flex w-full flex-col gap-1 rounded-md px-3 py-2.5 text-left hover:bg-raised focus-visible:bg-raised"
                    >
                      <span className="flex items-center gap-2 text-[13.5px] font-medium">
                        {m.label}
                        <span className={`rounded px-1.5 font-mono text-[10.5px] ${id === "incremental" ? "bg-approve-wash text-approve" : "bg-pending-wash text-pending"}`}>
                          {m.badge}
                        </span>
                      </span>
                      <span className="flex gap-1.5 text-[12.5px] leading-snug text-muted">
                        <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
                        {m.hint}
                      </span>
                    </button>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {confirming && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease }}
            className="overflow-hidden"
          >
            <div role="alertdialog" aria-label="Confirm full regeneration" className="flex flex-wrap items-center gap-3 border-b border-pending/20 bg-pending-wash px-4 py-3 sm:px-5">
              <TriangleAlert size={15} className="text-pending" aria-hidden />
              <p className="mr-auto text-[13px] text-dim">Full regeneration reanalyzes the whole revision and can use more of your AI quota.</p>
              <button type="button" onClick={() => setConfirming(false)} className="rounded-md px-2.5 py-1 text-[13px] text-dim hover:text-fg">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setMode("full");
                  setRunId((n) => n + 1);
                }}
                className="rounded-md bg-pending px-2.5 py-1 text-[13px] font-semibold text-ground"
              >
                Run full regeneration
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid gap-px bg-line md:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col gap-3 bg-panel p-4 sm:p-5">
          <span className="text-xs text-muted">Changed since last analysis</span>
          <ul className="flex flex-col gap-1.5 font-mono text-[12.5px]">
            {regeneration.changed.map((f) => (
              <li key={f.path} className="flex items-center gap-3">
                <span className="truncate text-dim">{f.path}</span>
                <span className="ml-auto shrink-0 text-approve">+{f.add}</span>
                <span className="shrink-0 text-change">−{f.del}</span>
              </li>
            ))}
          </ul>
          <span className="mt-2 text-xs text-muted">Affected capabilities</span>
          <ul className="flex flex-wrap gap-1.5">
            {regeneration.affected.map((a) => (
              <li key={a} className="rounded-md border border-ai/30 bg-ai-wash px-2 py-0.5 text-[12px] text-ai">
                {a}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-3 bg-panel p-4 sm:p-5" aria-live="polite">
          <span className="flex items-center gap-2 text-xs text-muted">
            {runId > 0 && <Check size={13} className="text-approve" aria-hidden />}
            {runId > 0 ? `${current.label} complete` : `Result preview · ${current.label.toLowerCase()}`}
          </span>
          <AnimatePresence mode="wait" initial={false}>
            <motion.dl
              key={`${mode}-${runId}`}
              initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
              transition={{ duration: 0.4, ease }}
              className="flex flex-col"
            >
              {current.result.map((r) => (
                <div key={r.label} className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 last:border-0">
                  <dt className="text-[13.5px] text-dim">{r.label}</dt>
                  <dd className={`font-mono text-[22px] font-medium tracking-tight ${toneClass[r.tone as Tone].text}`}>{r.value}</dd>
                </div>
              ))}
            </motion.dl>
          </AnimatePresence>
        </div>
      </div>
      <p className="border-t border-line px-4 py-2.5 font-mono text-[10.5px] text-muted sm:px-5">Demonstration data · try the menu</p>
    </div>
  );
}
