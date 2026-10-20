"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { FileCode, ListChecks } from "lucide-react";
import { evidence } from "@/content/evidence";

const anchors = evidence.steps.flatMap((s) => (s.anchor ? [s.anchor] : []));
const anchorIndex = (a?: string) => (a ? anchors.indexOf(a) + 1 : 0);

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Source on the left, generated steps on the right, with drawn links from each
 * step to the line of code it was derived from. Links render on wide screens;
 * numbered markers carry the same mapping everywhere.
 */
export function EvidenceLinks() {
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { once: true, amount: 0.4 });
  const reduced = useReducedMotion();
  const [paths, setPaths] = useState<string[]>([]);

  const measure = useCallback(() => {
    const el = root.current;
    if (!el || window.innerWidth < 1024) return setPaths([]);
    const box = el.getBoundingClientRect();
    const next = anchors.map((a) => {
      const from = el.querySelector<HTMLElement>(`[data-src="${a}"]`)?.getBoundingClientRect();
      const to = el.querySelector<HTMLElement>(`[data-step="${a}"]`)?.getBoundingClientRect();
      if (!from || !to) return "";
      const x1 = from.right - box.left;
      const y1 = from.top + from.height / 2 - box.top;
      const x2 = to.left - box.left;
      const y2 = to.top + to.height / 2 - box.top;
      const mid = (x1 + x2) / 2;
      return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
    });
    setPaths(next);
  }, []);

  useIsoLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (root.current) ro.observe(root.current);
    return () => ro.disconnect();
  }, [measure]);

  const draw = inView || reduced;

  return (
    <div ref={root} className="relative grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-28">
      <figure className="panel min-w-0 overflow-hidden">
        <figcaption className="flex items-center gap-2.5 border-b border-line px-4 py-3 font-mono text-[12px] text-dim">
          <FileCode size={14} className="text-muted" aria-hidden />
          {evidence.sourceFile}
        </figcaption>
        <pre className="overflow-x-auto py-3 font-mono text-[12.5px] leading-[1.9]">
          {evidence.source.map((line) => {
            const idx = anchorIndex(line.anchor);
            return (
              <span key={line.n} className={`flex items-center pr-4 ${idx ? "bg-ai-wash/70" : ""}`}>
                <span className="w-12 shrink-0 select-none pr-3 text-right text-muted/70">{line.n}</span>
                <span className={`whitespace-pre ${idx ? "text-fg" : "text-dim"}`}>{line.code}</span>
                {idx > 0 && (
                  <span data-src={line.anchor} className="ml-auto grid size-5 shrink-0 place-items-center rounded-md border border-ai/40 bg-ai-wash pl-px text-[10.5px] text-ai">
                    {idx}
                  </span>
                )}
              </span>
            );
          })}
        </pre>
      </figure>

      <figure className="panel min-w-0 self-center overflow-hidden">
        <figcaption className="flex items-center gap-2.5 border-b border-line px-4 py-3 font-mono text-[12px] text-dim">
          <ListChecks size={14} className="text-muted" aria-hidden />
          {evidence.testFile}
        </figcaption>
        <ol className="flex flex-col py-3 font-mono text-[12.5px] leading-[1.9]">
          {evidence.steps.map((step, i) => {
            const idx = anchorIndex(step.anchor);
            return (
              <li key={step.code} className="diff-add flex items-center gap-3 px-4">
                {idx > 0 ? (
                  <span data-step={step.anchor} className="grid size-5 shrink-0 place-items-center rounded-md border border-ai/40 bg-ai-wash pl-px text-[10.5px] text-ai">
                    {idx}
                  </span>
                ) : (
                  <span className="grid size-5 shrink-0 place-items-center text-[10.5px] text-muted">{i + 1}</span>
                )}
                <span className="truncate text-[#c9e7d8]">{step.code}</span>
              </li>
            );
          })}
        </ol>
      </figure>

      {paths.length > 0 && (
        <svg aria-hidden className="pointer-events-none absolute inset-0 hidden size-full overflow-visible lg:block">
          {paths.map((d, i) =>
            d ? (
              <g key={i}>
                <path d={d} fill="none" stroke="#c3ccc9" strokeOpacity="0.14" strokeWidth="5" />
                <motion.path
                  d={d}
                  fill="none"
                  stroke="#c3ccc9"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                  initial={{ pathLength: reduced ? 1 : 0, opacity: reduced ? 0.8 : 0 }}
                  animate={draw ? { pathLength: 1, opacity: 0.8 } : undefined}
                  transition={{ duration: 1.1, delay: 0.15 + i * 0.16, ease: [0.16, 1, 0.3, 1] }}
                />
              </g>
            ) : null
          )}
        </svg>
      )}
    </div>
  );
}
