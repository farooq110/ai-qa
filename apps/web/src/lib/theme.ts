"use client";

import { useEffect, useState } from "react";
import { themeStorageKey as storageKey } from "./theme-boot";

export type ThemePreference = "dark" | "light" | "system";

const changeEvent = "proofline:theme";

function resolve(preference: ThemePreference) {
  if (preference !== "system") return preference;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function read(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored === "light" || stored === "system" ? stored : "dark";
  } catch {
    return "dark";
  }
}

export function setThemePreference(preference: ThemePreference) {
  try { window.localStorage.setItem(storageKey, preference); } catch { /* storage unavailable: still apply for this page */ }
  document.documentElement.dataset.theme = resolve(preference);
  window.dispatchEvent(new CustomEvent(changeEvent, { detail: preference }));
}

/** Current preference plus the theme it resolves to; follows OS changes while on "system". */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>("dark");
  const [resolved, setResolved] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const sync = () => {
      const next = read();
      setPreference(next);
      setResolved(resolve(next));
      document.documentElement.dataset.theme = resolve(next);
    };
    sync();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    window.addEventListener(changeEvent, sync);
    media.addEventListener("change", sync);
    return () => {
      window.removeEventListener(changeEvent, sync);
      media.removeEventListener("change", sync);
    };
  }, []);

  return { preference, resolved, setPreference: setThemePreference };
}
