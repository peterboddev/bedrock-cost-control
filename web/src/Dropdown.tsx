import { useEffect, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** Text shown on the button when nothing is selected / value not in options. */
  placeholder?: string;
  disabled?: boolean;
}

/**
 * A fully-styled dropdown that replaces the native <select>. The native
 * option popup is rendered by the OS and, on some Windows/dark-mode setups,
 * paints with colors that blend into the page. This component renders the
 * open list as plain styled HTML (with its own border + shadow), so it is
 * always clearly visible regardless of OS theme.
 */
export function Dropdown({ value, options, onChange, placeholder, disabled }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close when clicking outside or pressing Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const buttonText = selected ? selected.label : placeholder ?? "Select…";

  return (
    <div className="dd" ref={ref}>
      <button
        type="button"
        className="dd-button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {buttonText}
        </span>
        <span className="dd-caret">▼</span>
      </button>
      {open && (
        <div className="dd-menu" role="listbox">
          {options.length === 0 && <div className="dd-empty">{placeholder ?? "No options"}</div>}
          {options.map((o) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={"dd-option" + (o.value === value ? " selected" : "")}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
