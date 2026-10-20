"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValueEvent, useScroll } from "motion/react";
import { FileCode, Lock, Play } from "lucide-react";
import { lifecycle } from "@/content/lifecycle";
import { StatusPill } from "@/components/ui/status-pill";
import { toneClass } from "@/components/ui/tone";

const stages = lifecycle.stages;
const ease = [0.16, 1, 0.3, 1] as const;

/**
 * Scroll-pinned sequence: the reader scrolls through the stage copy while one
 * test version advances through the lifecycle on a sticky card.
 */
export function LifecycleScroller() {
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const { scrollYProgress } = useScroll({ target: trackRef, offset: ["start 55%", "end 70%"] });

  useMotionValueEvent(scrollYProgress, "change", (p) => {
    const next = Math.min(stages.length - 1, Math.max(0, Math.floor(p * stages.length)));
    setActive((prev) => (prev === next ? prev : next));
  });

  const stage = stages[Math.min(active, stages.length - 1)]!;
  const log = stages.slice(0, active + 1).flatMap((s) => s.log.map((entry, i) => ({ ...entry, key: `${s.id}-${i}` })));

  return (
    <div ref={trackRef} className="relative mt-16 grid gap-10 lg:mt-20 lg:grid-cols-12 lg:gap-12">
      <div className="hidden lg:col-span-6 lg:block">
        <div className="sticky top-28">
          <div className="panel overflow-hidden" aria-hidden>
            <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
              <FileCode size={16} className="text-muted" />
              <span className="font-mono text-[12.5px] text-dim">rejects-expired-card.yaml</span>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={stage.version}
                  initial={{ opacity: 0, y: -8, filter: "blur(4px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                  transition={{ duration: 0.5, ease }}
                  className="ml-auto rounded-md border border-line-strong bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg"
                >
                  {stage.version}
                </motion.span>
              </AnimatePresence>
            </div>

            <div className="flex flex-col gap-6 px-5 py-6">
              <ol className="grid grid-cols-6 gap-1.5">
                {stages.map((s, i) => (
                  <li key={s.id} className="flex flex-col gap-2">
                    <span className="relative h-1 overflow-hidden rounded-full bg-line">
                      <motion.span
                        className={`absolute inset-0 origin-left rounded-full ${i === active ? toneClass[s.tone].dot : "bg-approve/70"}`}
                        initial={false}
                        animate={{ scaleX: i <= active ? 1 : 0 }}
                        transition={{ duration: 0.6, ease }}
                      />
                    </span>
                    <span className={`font-mono text-[10.5px] leading-tight ${i === active ? "text-fg" : "text-muted"}`}>{s.state}</span>
                  </li>
                ))}
              </ol>

              <div className="flex items-center justify-between gap-4">
                <p className="text-xl font-semibold tracking-[-0.02em]">Rejects an expired card at checkout</p>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={stage.id}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.4, ease }}
                  >
                    <StatusPill tone={stage.tone}>{stage.state}</StatusPill>
                  </motion.span>
                </AnimatePresence>
              </div>

              <motion.div
                layout
                transition={{ duration: 0.5, ease }}
                className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-[13.5px] transition-colors duration-500 ${
                  stage.runnable ? "border-approve/30 bg-approve-wash text-approve" : "border-line bg-sunken text-muted"
                }`}
              >
                {stage.runnable ? <Play size={15} className="fill-current" /> : <Lock size={15} />}
                <span className="font-semibold">{stage.runnable ? `Run approved ${stage.version}` : "Run unavailable"}</span>
                <span className="ml-auto font-mono text-[11.5px] opacity-80">
                  {stage.runnable ? "dashboard · API · CI" : "version not approved"}
                </span>
              </motion.div>

              <div className="flex flex-col gap-2 border-t border-line pt-5">
                <span className="text-xs text-muted">Audit trail</span>
                <ul className="flex min-h-[184px] flex-col gap-1.5">
                  <AnimatePresence initial={false}>
                    {log.map((entry) => (
                      <motion.li
                        key={entry.key}
                        layout
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.45, ease }}
                        className="flex items-center gap-2.5 font-mono text-[12px]"
                      >
                        <span className={`size-1.5 shrink-0 rounded-full ${toneClass[entry.tone].dot}`} />
                        <span className={entry.tone === "change" ? "text-change" : "text-dim"}>{entry.text}</span>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              </div>
            </div>
          </div>
          <p className="mt-3 font-mono text-[11px] text-muted">Demonstration data</p>
        </div>
      </div>

      <ol className="flex flex-col lg:col-span-6 lg:col-start-7">
        {stages.map((s, i) => (
          <li
            key={s.id}
            className={`flex flex-col justify-center gap-4 border-l border-line py-8 pl-6 transition-opacity duration-500 lg:min-h-[62vh] lg:py-0 lg:pl-10 ${
              i === active ? "lg:opacity-100" : "lg:opacity-30"
            }`}
          >
            <h3 className="text-balance text-[clamp(1.5rem,2.6vw,2.1rem)] font-semibold leading-[1.1] tracking-[-0.03em]">
              {s.title}{" "}
              <StatusPill tone={s.tone} className="relative -top-1 align-middle">
                {s.state}
              </StatusPill>
            </h3>
            <p className="max-w-[46ch] text-pretty text-[16.5px] leading-[1.65] text-dim">{s.body}</p>
            <ul className="flex flex-col gap-1.5 lg:hidden">
              {s.log.map((entry) => (
                <li key={entry.text} className="flex items-start gap-2.5 font-mono text-[12px]">
                  <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${toneClass[entry.tone].dot}`} />
                  <span className={entry.tone === "change" ? "text-change" : "text-muted"}>{entry.text}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
