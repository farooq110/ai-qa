"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useAnchoredMenu } from "@/components/use-anchored-menu";

export interface SelectOption { value: string; label: string; hint?: string }

/**
 * App dropdown replacing the native <select>: same look as SearchableSelect, keyboard
 * listbox (arrows, Home/End, type-ahead, Enter/Space, Esc). Controlled via value/onChange,
 * or uncontrolled with defaultValue + name, in which case a hidden input carries the value
 * into FormData like a native select would.
 */
export function Select({ value, defaultValue, onChange, options, placeholder, ariaLabel, name, disabled, className }: {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  name?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [internal, setInternal] = useState(defaultValue ?? "");
  const current = value ?? internal;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();
  const selected = options.find((option) => option.value === current);
  const close = useCallback(() => setOpen(false), []);
  useAnchoredMenu(open, triggerRef, menuRef, close);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function show() {
    setActive(Math.max(0, options.findIndex((option) => option.value === current)));
    setOpen(true);
  }

  function commit(option: SelectOption) {
    if (value === undefined) setInternal(option.value);
    if (option.value !== current) onChange?.(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); show(); }
      return;
    }
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, options.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(options.length - 1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); const option = options[active]; if (option) commit(option); }
    else if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); setOpen(false); }
    else if (event.key.length === 1) {
      // Type-ahead: jump to the first option starting with what was typed in the last 700ms.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + event.key.toLowerCase(), at: now };
      const match = options.findIndex((option) => option.label.toLowerCase().startsWith(typed.current.text));
      if (match >= 0) setActive(match);
    }
  }

  return (
    <div className={`combo select${open ? " open" : ""}${className ? ` ${className}` : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="combo-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className="combo-value">
          <strong className={selected ? undefined : "placeholder"}>{selected?.label ?? placeholder ?? "Select…"}</strong>
          {selected?.hint && <small>{selected.hint}</small>}
        </span>
        <ChevronDown size={14} />
      </button>
      {/* Like a native select on its disabled placeholder, an empty value is left out of the form. */}
      {name && current !== "" && <input type="hidden" name={name} value={current} />}
      {open && (
        <div className="combo-menu" role="listbox" id={listId} ref={menuRef} aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              type="button"
              key={option.value}
              data-index={index}
              role="option"
              aria-selected={option.value === current}
              tabIndex={-1}
              className={`combo-option${index === active ? " active" : ""}${option.value === current ? " selected" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => commit(option)}
            >
              <span><strong>{option.label}</strong>{option.hint && <small>{option.hint}</small>}</span>
              {option.value === current && <Check size={13} />}
            </button>
          ))}
          {options.length === 0 && <div className="combo-empty">No options</div>}
        </div>
      )}
    </div>
  );
}
