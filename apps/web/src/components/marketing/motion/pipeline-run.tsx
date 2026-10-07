"use client";

import { CircleCheck, LoaderCircle } from "lucide-react";
import { ci } from "@/content/ci";
import { useSequence } from "./use-sequence";

// Step i completes when the counter passes 2i + 1; even counts mean "running".
const DELAYS = ci.pipeline.flatMap(() => [520, 380]);

/** A CI run that plays through each gate once it scrolls into view. */
export function PipelineRun() {
  const [ref, step] = useSequence<HTMLOListElement>({ delays: DELAYS });

  return (
    <ol ref={ref} className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-6">
      {ci.pipeline.map((p, i) => {
        const done = step >= 2 * i + 2;
        const running = !done && step >= 2 * i + 1;
        return (
          <li key={p.label} className="relative flex flex-col gap-3 bg-panel px-4 py-5">
            <span
              aria-hidden
              className={`absolute inset-x-0 top-0 h-0.5 origin-left bg-approve transition-transform duration-500 ease-[var(--ease-out-expo)] ${
                done ? "scale-x-100" : "scale-x-0"
              }`}
            />
            <span className="flex items-center gap-2">
              {done ? (
                <CircleCheck size={15} className="text-approve" aria-hidden />
              ) : running ? (
                <LoaderCircle size={15} className="animate-spin text-pending" aria-hidden />
              ) : (
                <span aria-hidden className="size-[15px] rounded-full border border-line-strong" />
              )}
              <span className="font-mono text-[11px] text-muted">{done ? "done" : running ? "running" : "queued"}</span>
            </span>
            <span className="text-[14.5px] font-semibold leading-snug">{p.label}</span>
            <span className="font-mono text-[12px] text-dim">{p.detail}</span>
          </li>
        );
      })}
    </ol>
  );
}
