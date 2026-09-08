"use client";

import { useEffect, useState } from "react";
import { applyTheme, isTheme, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

/**
 * Light / System / Dark. The storage key and the light/dark/system rules live
 * in lib/theme, shared with the pre-paint script in the root layout.
 *
 * System is a real third state, not the absence of a choice: someone whose
 * laptop switches at sunset wants the app to follow, and collapsing this to a
 * two-way switch would silently pin them to whichever mode they last saw. The
 * stored value is therefore "light" | "dark" | "system", and only the first two
 * write the data-theme attribute the CSS keys off.
 */


const OPTIONS: { value: Theme; label: string; hint: string }[] = [
  { value: "light", label: "Light", hint: "Always use the light theme" },
  { value: "system", label: "Auto", hint: "Follow the operating system setting" },
  { value: "dark", label: "Dark", hint: "Always use the dark theme" },
];

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Private mode and "block site data" both throw rather than returning null.
  }
  return "system";
}

export default function ThemeToggle({ floating = false }: { floating?: boolean }) {
  // Always starts at the server-rendered default and corrects in an effect.
  // Reading localStorage during render would make the first client render
  // disagree with the HTML and React would discard the tree as a hydration
  // mismatch — the pre-paint script in layout.tsx is what stops the flash.
  const [theme, setTheme] = useState<Theme>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(readStoredTheme());
    setMounted(true);
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The theme still applies for this page; it just will not be remembered.
    }
  }

  return (
    <div
      className={`theme-toggle${floating ? " theme-toggle-floating" : ""}`}
      role="group"
      aria-label="Colour theme"
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.hint}
          // Before mount the stored value is unknown, so nothing is marked
          // pressed rather than asserting a default that may be wrong.
          aria-pressed={mounted ? theme === option.value : false}
          onClick={() => choose(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
