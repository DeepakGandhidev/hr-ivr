"use client";

import { useId } from "react";
import { parseCtc } from "@pratibha/shared";

/** ₹6,00,000 */
export function rupees(n: number) {
  return `₹${n.toLocaleString("en-IN")}`;
}

/** What a band input holds, as annual rupees, or null when empty or unreadable. */
export function bandValue(text: string): number | null {
  return text.trim() ? parseCtc(text) : null;
}

export function bandText(n: number | null | undefined) {
  return n ? String(n) : "";
}

/**
 * Batch 6, I02. The role's band as two annual figures, typed the way people
 * write them ("6 L", "600000", "8 LPA"), each read back as rupees so a wrong
 * zero is visible before save. The salary policy on calls compares against
 * the maximum.
 */
export default function SalaryBandFields({
  min,
  max,
  onMin,
  onMax,
}: {
  min: string;
  max: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
}) {
  const id = useId();
  const lo = bandValue(min);
  const hi = bandValue(max);
  const help = (text: string, value: number | null) =>
    !text.trim() ? "Annual. Optional." : value ? `${rupees(value)} a year` : "Not a figure we can read. Try 6 L or 600000.";

  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
      <label htmlFor={`${id}-min`}>
        <span className="subtle">Band minimum, per year</span>
        <input id={`${id}-min`} value={min} onChange={(e) => onMin(e.target.value)} placeholder="6 L" aria-describedby={`${id}-min-h`} />
        <small id={`${id}-min-h`} className="subtle">{help(min, lo)}</small>
      </label>
      <label htmlFor={`${id}-max`}>
        <span className="subtle">Band maximum, per year</span>
        <input id={`${id}-max`} value={max} onChange={(e) => onMax(e.target.value)} placeholder="8 L" aria-describedby={`${id}-max-h`} />
        <small id={`${id}-max-h`} className="subtle">
          {lo && hi && lo > hi ? "The maximum is below the minimum." : help(max, hi)}
        </small>
      </label>
    </div>
  );
}
