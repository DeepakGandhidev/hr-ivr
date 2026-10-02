"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";

export interface ActionMenuItem {
  label: string;
  /** A link item. Rendered as an anchor so it opens in a new tab like one. */
  href?: string;
  external?: boolean;
  onSelect?: () => void;
  disabled?: boolean;
  /** Why it is disabled, read out and shown on hover. */
  hint?: string;
  danger?: boolean;
}

/**
 * The three-dot menu.
 *
 * Secondary actions live here so a row or card carries one primary button and
 * nothing overflows at 1280px. The trigger's label must name the entity ("More
 * actions for Senior Sales Expert"): a screen reader user tabbing through a
 * list of identical "More" buttons cannot tell which row they are on.
 *
 * The menu is positioned with `fixed` from the trigger's rect rather than
 * absolutely inside its row, because tables sit in scrolling containers that
 * would clip it. A fixed element cannot be scrolled into view, so when there
 * is no room below the trigger — the last card or row on screen — it opens
 * upwards instead of out of sight.
 */
export default function ActionMenu({
  label,
  items,
  size = "md",
}: {
  label: string;
  items: ActionMenuItem[];
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  // Runs once the menu is in the DOM (rendered hidden), so its height is known.
  const place = useCallback(() => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const height = menu.current?.offsetHeight ?? 0;
    const below = r.bottom + 6;
    const above = r.top - 6 - height;
    const fitsBelow = below + height <= window.innerHeight - 8;
    setPos({ top: fitsBelow || above < 8 ? below : above, right: Math.max(8, window.innerWidth - r.right) });
  }, []);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    // Follow the trigger rather than closing on any scroll: a scroll still
    // settling from a trackpad flick when the click lands would otherwise shut
    // the menu the instant it opened. It closes once the trigger is off screen.
    const onScroll = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) close(false);
      else place();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place, close]);

  // Focus the first enabled item, as a menu button is expected to — once it is
  // placed and visible (a hidden element cannot take focus), and once per
  // opening, not again each time a scroll moves it. preventScroll, because
  // the browser would otherwise scroll to the item.
  const focused = useRef(false);
  useEffect(() => {
    if (!open) {
      focused.current = false;
      return;
    }
    if (!pos || focused.current) return;
    focused.current = true;
    menu.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
      ?.focus({ preventScroll: true });
  }, [open, pos]);

  function onKeyDown(e: React.KeyboardEvent) {
    const nodes = Array.from(
      menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []
    );
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      nodes[(at + 1) % nodes.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nodes[(at - 1 + nodes.length) % nodes.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      nodes[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      nodes[nodes.length - 1]?.focus();
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`icon-btn${size === "sm" ? " sm" : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          // Cards are clickable as a whole; opening the menu must not also
          // open the card.
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <circle cx="2.2" cy="7" r="1.4" />
          <circle cx="7" cy="7" r="1.4" />
          <circle cx="11.8" cy="7" r="1.4" />
        </svg>
      </button>

      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={label}
          className="action-menu"
          // Hidden until measured and placed, so it never flashes in the wrong spot.
          style={pos ? { top: pos.top, right: pos.right } : { top: 0, right: 0, visibility: "hidden" }}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((item) =>
            item.href && !item.disabled ? (
              item.external ? (
                <a
                  key={item.label}
                  role="menuitem"
                  tabIndex={-1}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="action-menu-item"
                  onClick={() => close(false)}
                >
                  {item.label}
                </a>
              ) : (
                <Link
                  key={item.label}
                  role="menuitem"
                  tabIndex={-1}
                  href={item.href}
                  className="action-menu-item"
                  onClick={() => close(false)}
                >
                  {item.label}
                </Link>
              )
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={item.disabled || undefined}
                title={item.disabled ? item.hint : undefined}
                className={`action-menu-item${item.danger ? " danger" : ""}`}
                onClick={() => {
                  if (item.disabled) return;
                  close();
                  item.onSelect?.();
                }}
              >
                {item.label}
                {item.disabled && item.hint && <span className="visually-hidden"> ({item.hint})</span>}
              </button>
            )
          )}
        </div>
      )}
    </>
  );
}
