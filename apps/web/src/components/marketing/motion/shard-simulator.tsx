"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useInView, useReducedMotion } from "motion/react";
import { estimateMinutes, formatDuration, scale } from "@/content/scale";

const CELL = 8;
const DOT = 5;
const COLORS = { idle: "#1f282e", running: "#f2b544", done: "#35d08f" } as const;
const stopLabels: Record<number, string> = { 5: "Starter", 25: "Team", 100: "Business", 200: "Enterprise" };

/** 3,000 approved tests drain through N concurrent slots; the canvas shows the waves. */
export function ShardSimulator() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inView = useInView(wrapRef, { amount: 0.3 });
  const reduced = useReducedMotion();
  const sliderId = useId();
  const [stop, setStop] = useState<number>(scale.workerStops.indexOf(scale.defaultWorkers));
  const workers = scale.workerStops[stop] ?? scale.defaultWorkers;
  const minutes = estimateMinutes(workers);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !wrap || !ctx) return;

    const total = scale.totalTests;
    let frame = 0;
    let start = 0;

    const layout = () => {
      const width = wrap.clientWidth;
      const cols = Math.max(20, Math.floor(width / CELL));
      const rows = Math.ceil(total / cols);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = cols * CELL * dpr;
      canvas.height = rows * CELL * dpr;
      canvas.style.width = `${cols * CELL}px`;
      canvas.style.height = `${rows * CELL}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return cols;
    };

    let cols = layout();
    // ponytail: animation length is a visual scale of the estimate, not real time.
    const duration = reduced ? 0 : Math.min(12000, Math.max(1200, minutes * 40));

    const paint = (doneCount: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < total; i++) {
        const state = i < doneCount ? "done" : i < doneCount + workers ? "running" : "idle";
        ctx.fillStyle = COLORS[state];
        ctx.beginPath();
        ctx.roundRect((i % cols) * CELL, Math.floor(i / cols) * CELL, DOT, DOT, 1.5);
        ctx.fill();
      }
    };

    const tick = (t: number) => {
      if (!start) start = t;
      const p = duration === 0 ? 1 : Math.min(1, (t - start) / duration);
      const waves = Math.ceil(total / workers);
      const done = Math.min(total, Math.floor(p * waves) * workers);
      paint(done);
      if (p < 1) frame = requestAnimationFrame(tick);
    };

    if (inView || reduced) frame = requestAnimationFrame(tick);
    else paint(0);

    const ro = new ResizeObserver(() => {
      cols = layout();
      paint(scale.totalTests);
    });
    ro.observe(wrap);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [workers, minutes, inView, reduced]);

  return (
    <div className="mkt-panel overflow-hidden">
      <div className="grid gap-px bg-line md:grid-cols-3">
        <Readout label="Concurrent test slots" value={String(workers)} />
        <Readout label="Estimated wall-clock" value={`≈ ${formatDuration(minutes)}`} accent />
        <Readout label="Same suite, one at a time" value={formatDuration(estimateMinutes(1))} muted />
      </div>

      <div className="flex flex-col gap-3 border-y border-line px-4 py-5 sm:px-6">
        <label htmlFor={sliderId} className="text-[13px] text-dim">
          Concurrent slots
        </label>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={scale.workerStops.length - 1}
          step={1}
          value={stop}
          onChange={(e) => setStop(Number(e.target.value))}
          aria-valuetext={`${workers} concurrent slots, about ${formatDuration(minutes)}`}
          className="w-full cursor-pointer"
        />
        <div className="relative h-9 font-mono text-[11px] text-muted">
          {scale.workerStops.map((w, i) => {
            const last = scale.workerStops.length - 1;
            const align = i === 0 ? "items-start" : i === last ? "-translate-x-full items-end" : "-translate-x-1/2 items-center";
            return (
              <button
                key={w}
                type="button"
                onClick={() => setStop(i)}
                style={{ left: `${(i / last) * 100}%` }}
                className={`absolute top-0 flex flex-col gap-0.5 transition-colors ${align} ${i === stop ? "text-fg" : "hover:text-dim"}`}
              >
                <span>{w}</span>
                {stopLabels[w] && <span className="hidden text-[10px] sm:inline">{stopLabels[w]}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="px-4 py-5 sm:px-6" aria-hidden>
        <div ref={wrapRef}>
          <canvas ref={canvasRef} className="mx-auto block" />
        </div>
      </div>
      <p className="border-t border-line px-4 py-3 text-[12.5px] leading-relaxed text-muted sm:px-6">{scale.caveat}</p>
    </div>
  );
}

function Readout({ label, value, accent, muted }: { label: string; value: string; accent?: boolean; muted?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 bg-panel px-4 py-5 sm:px-6">
      <span className="text-xs text-muted">{label}</span>
      <span
        className={`font-mono text-[clamp(1.6rem,3vw,2.25rem)] font-medium tracking-[-0.03em] ${
          accent ? "text-approve" : muted ? "text-muted line-through decoration-change/60 decoration-1" : "text-fg"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
