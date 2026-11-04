"use client";

import { createContext, Fragment, useCallback, useContext, useMemo, type ReactNode } from "react";
import { candidateStatusLabel, type CandidateStatus } from "@pratibha/shared";
import { fill, type CopyVars } from "@/lib/copy-fill";

/**
 * The client side of the copy channel. A server layout reads the admin
 * panel's wording with copyFor(prefixes) and hands the map to <CopyProvider>;
 * client components read it with useCopy(). Nested providers merge, so a
 * layout further down can add prefixes without hiding its parent's.
 */
const CopyContext = createContext<Record<string, string>>({});

export function CopyProvider({ copy, children }: { copy: Record<string, string>; children: React.ReactNode }) {
  const parent = useContext(CopyContext);
  const merged = useMemo(() => ({ ...parent, ...copy }), [parent, copy]);
  return <CopyContext.Provider value={merged}>{children}</CopyContext.Provider>;
}

export type CopyFn = (key: string, vars?: CopyVars) => string;

/**
 * `t(key, vars)`: the text for `key` with {placeholders} filled. A key the
 * provider did not carry renders as empty; tests check every key used in the
 * code is registered under a prefix its layout provides.
 */
export function useCopy(): CopyFn {
  const map = useContext(CopyContext);
  return useCallback((key: string, vars?: CopyVars) => fill(map[key] ?? "", vars), [map]);
}

/**
 * Text with **bold** runs, for notices whose original wording had <strong>
 * parts. Returns nodes; the stars are the only markup understood.
 */
export function renderRich(text: string): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>));
}

export function useRichCopy(): (key: string, vars?: CopyVars) => ReactNode {
  const t = useCopy();
  return useCallback((key: string, vars?: CopyVars) => renderRich(t(key, vars)), [t]);
}

/** Candidate status names, as the admin panel words them. */
export function useStatusLabel(): (status: CandidateStatus) => string {
  const map = useContext(CopyContext);
  return useCallback((status: CandidateStatus) => candidateStatusLabel(status, map), [map]);
}
