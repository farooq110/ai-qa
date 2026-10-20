"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useInView, useReducedMotion } from "motion/react";

type SequenceOptions = {
  /** Delay in ms before each step: delays[i] is the wait before step i + 1. */
  delays: readonly number[];
  /** Hold on the final step before restarting. Omit to play once. */
  loopAfter?: number;
};

/**
 * Drives a step counter through a timeline while the element is on screen.
 * Pauses off screen, jumps to the final step under reduced motion.
 */
export function useSequence<T extends Element>({ delays, loopAfter }: SequenceOptions): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const inView = useInView(ref, { amount: 0.35 });
  const reduced = useReducedMotion();
  const last = delays.length;
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reduced) {
      setStep(last);
      return;
    }
    if (!inView) return;

    const wait = step < last ? delays[step] : loopAfter;
    if (wait === undefined) return;

    const timer = window.setTimeout(() => setStep((s) => (s < last ? s + 1 : 0)), wait);
    return () => window.clearTimeout(timer);
  }, [step, inView, reduced, delays, last, loopAfter]);

  return [ref, step];
}
