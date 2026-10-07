"use client";

import { motion, useScroll, useSpring, useTransform } from "motion/react";
import { Plus } from "lucide-react";
import { useActiveSection } from "./use-active-section";

type GutterSection = { readonly id: string; readonly label: string };

const LINE_COUNT = 48;
const lineNumbers = Array.from({ length: LINE_COUNT }, (_, i) => i + 1);

/**
 * The page's diff gutter: a fixed line-number column that turns green as the
 * reader scrolls, with one hunk marker per section.
 */
export function ScrollGutter({ sections, ids }: { sections: readonly GutterSection[]; ids: readonly string[] }) {
  const { scrollYProgress } = useScroll();
  const fill = useSpring(scrollYProgress, { stiffness: 140, damping: 30, mass: 0.4 });
  const clip = useTransform(fill, (p) => `inset(0 0 ${(1 - p) * 100}% 0)`);
  const active = Math.max(0, useActiveSection(ids));

  return (
    <nav
      aria-label="Page sections"
      className="fixed inset-y-0 left-0 z-30 hidden w-16 border-r border-line bg-sunken lg:block"
    >
      <div className="absolute inset-x-0 bottom-6 top-20">
        <Numbers className="text-muted/45" />
        <motion.div aria-hidden className="absolute inset-0" style={{ clipPath: clip }}>
          <Numbers className="diff-add text-approve" />
        </motion.div>

        <span aria-hidden className="absolute bottom-0 left-[42px] top-0 w-px bg-line" />
        <motion.span aria-hidden className="absolute bottom-0 left-[42px] top-0 w-px origin-top bg-approve" style={{ scaleY: fill }} />

        <ol className="absolute bottom-0 left-[33px] top-0 flex flex-col justify-between">
          {sections.map((s, i) => {
            const state = i < active ? "done" : i === active ? "now" : "next";
            return (
              <li key={s.id}>
                <a href={`#${s.id}`} aria-current={state === "now" ? "location" : undefined} className="group relative flex size-[18px] rounded-[5px]">
                  <span
                    className={`grid size-[18px] place-items-center rounded-[5px] border transition-colors duration-300 ${
                      state === "done"
                        ? "border-approve/40 bg-approve-wash text-approve"
                        : state === "now"
                          ? "border-pending/60 bg-pending-wash text-pending"
                          : "border-line-strong bg-ground text-muted"
                    }`}
                  >
                    {state === "next" ? <span className="size-1 rounded-full bg-muted" /> : <Plus size={11} strokeWidth={2.75} />}
                  </span>
                  <span className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-line bg-panel px-2 py-1 font-mono text-[11px] text-dim opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    {s.label}
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}

function Numbers({ className }: { className: string }) {
  return (
    <ol aria-hidden className={`absolute inset-y-0 left-0 flex w-[34px] flex-col justify-between pr-1.5 text-right font-mono text-[10px] leading-none ${className}`}>
      {lineNumbers.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ol>
  );
}
