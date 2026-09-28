"use client";

import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "framer-motion";
import { parseDisplayValue, formatDisplayValue } from "@/lib/animatedValue";

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

/**
 * Counts a formatted KPI value up to its final text ("₹12,48,300", "3.42x", "18.50%") — the number
 * part only, re-formatted every frame exactly like the final string (see animatedValue.ts), so the
 * last frame is the value the page passed. A later value counts on from the one shown. Anything
 * that isn't a single number (e.g. "—") and users who ask for reduced motion get the text as-is.
 * Screen readers always get the final value, never the moving one.
 */
export function AnimatedNumber({ value, delay = 0, duration = 1.1 }: { value: string | number; delay?: number; duration?: number }) {
  const text = String(value);
  const reduceMotion = useReducedMotion();
  const parts = parseDisplayValue(text);
  const [shown, setShown] = useState(() => (parts && !reduceMotion ? formatDisplayValue(parts, 0) : text));
  const fromRef = useRef(0);

  useEffect(() => {
    const target = parseDisplayValue(text);
    if (!target || reduceMotion) {
      fromRef.current = target?.value ?? 0;
      const id = requestAnimationFrame(() => setShown(text));
      return () => cancelAnimationFrame(id);
    }
    const controls = animate(fromRef.current, target.value, {
      duration,
      delay,
      ease: EASE_OUT_EXPO,
      onUpdate: (v) => setShown(formatDisplayValue(target, v)),
      // Land on the exact final string, whatever the last eased frame rounded to.
      onComplete: () => setShown(text),
    });
    fromRef.current = target.value;
    return () => controls.stop();
  }, [text, reduceMotion, delay, duration]);

  return (
    <span className="tabular-nums">
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{shown}</span>
    </span>
  );
}
