import type { ReactNode } from "react";
import { toneClass, type Tone } from "./tone";

type StatusPillProps = {
  tone: Tone;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
};

export function StatusPill({ tone, children, icon, className = "" }: StatusPillProps) {
  const t = toneClass[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-medium ${t.text} ${t.wash} ${t.border} ${className}`}
    >
      {icon ?? <span aria-hidden className={`size-1.5 rounded-full ${t.dot}`} />}
      {children}
    </span>
  );
}
