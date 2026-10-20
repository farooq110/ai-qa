"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { useAnchoredMenu } from "@/components/use-anchored-menu";

export interface ComboOption { value: string; label: string; hint?: string }

/**
 * Searchable dropdown: type-to-filter, arrow keys + Enter, click-outside close.
 * Empty value renders as the provided placeholder option.
 */
export function SearchableSelect({ value, onChange, options, placeholder, ariaLabel, disabled }: {
  value: string;
  onChange: (value: string) => void;
  options: ComboOption[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useAnchoredMenu(open, triggerRef, menuRef, close);

  const selected = options.find((option) => option.value === value);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(needle));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(Math.max(0, filtered.findIndex((option) => option.value === value)));
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function commit(option: ComboOption) {
    onChange(option.value);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, filtered.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); const option = filtered[activeIndex]; if (option) commit(option); }
    else if (event.key === "Escape") { setOpen(false); }
  }

  return (
    <div className={`combo ${open ? "open" : ""}`} ref={rootRef}>
      <button type="button" ref={triggerRef} className="combo-trigger" onClick={() => !disabled && setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} disabled={disabled}>
        <span className="combo-value">
          <strong className={selected ? undefined : "placeholder"}>{selected?.label ?? placeholder ?? "Select…"}</strong>
          {selected?.hint && <small>{selected.hint}</small>}
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="combo-menu" role="listbox" ref={menuRef}>
          <label className="combo-search">
            <Search size={13} />
            <input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={onKeyDown} placeholder="Search…" />
          </label>
          {placeholder !== undefined && !query.trim() && (
            <button type="button" className={`combo-option ${value === "" ? "selected" : ""}`} onClick={() => commit({ value: "", label: placeholder ?? "" })} role="option" aria-selected={value === ""}>
              <span>{placeholder}</span>
              {value === "" && <Check size={13} />}
            </button>
          )}
          {filtered.map((option, index) => (
            <button type="button" key={option.value} className={`combo-option ${index === activeIndex ? "active" : ""} ${option.value === value ? "selected" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => commit(option)} role="option" aria-selected={option.value === value}>
              <span><strong>{option.label}</strong>{option.hint && <small>{option.hint}</small>}</span>
              {option.value === value && <Check size={13} />}
            </button>
          ))}
          {filtered.length === 0 && <div className="combo-empty">No matches</div>}
        </div>
      )}
    </div>
  );
}
