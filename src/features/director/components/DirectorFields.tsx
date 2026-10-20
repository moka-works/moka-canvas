import { useEffect, useState, type ReactNode } from "react";

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function DirectorField({ label, hint, children }: FieldProps) {
  return (
    <label className="director-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/**
 * A number that is typed freely and written once.
 *
 * Typing a transform into a document on every keypress would turn one edit
 * into a dozen revisions; the field holds the words while they are being
 * written and hands the value over on Enter or when focus leaves. A value
 * that is not a finite number in range puts the old one back.
 */
export function DirectorNumber({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.05,
  hint,
  disabled,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  disabled?: boolean;
  suffix?: string;
}) {
  const [text, setText] = useState(String(round(value)));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(round(value)));
  }, [value, focused]);

  const commit = () => {
    const parsed = Number(text);
    if (
      !Number.isFinite(parsed) ||
      (min !== undefined && parsed < min) ||
      (max !== undefined && parsed > max)
    ) {
      setText(String(round(value)));
      return;
    }
    if (parsed !== value) onChange(parsed);
    setText(String(round(parsed)));
  };

  return (
    <DirectorField hint={hint} label={label}>
      <span className="director-number">
        <input
          disabled={disabled}
          inputMode="decimal"
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setText(String(round(value)));
              event.currentTarget.blur();
            }
          }}
          step={step}
          type="number"
          value={text}
        />
        {suffix && <em>{suffix}</em>}
      </span>
    </DirectorField>
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** A line of text written on blur or Enter, not on every key. */
export function DirectorText({
  label,
  value,
  onCommit,
  multiline,
  rows = 4,
  hint,
  maxLength,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  rows?: number;
  hint?: string;
  maxLength?: number;
}) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value);
  }, [value, focused]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <DirectorField hint={hint} label={label}>
      {multiline ? (
        <textarea
          maxLength={maxLength}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => setFocused(true)}
          rows={rows}
          value={text}
        />
      ) : (
        <input
          maxLength={maxLength}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setText(value);
              event.currentTarget.blur();
            }
          }}
          type="text"
          value={text}
        />
      )}
    </DirectorField>
  );
}

export function DirectorSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <DirectorField hint={hint} label={label}>
      <select
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </DirectorField>
  );
}

export function DirectorColor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <DirectorField label={label}>
      <span className="director-color">
        <input
          onChange={(event) => onChange(event.target.value.toLowerCase())}
          type="color"
          value={value}
        />
        <code>{value}</code>
      </span>
    </DirectorField>
  );
}

export function DirectorToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="director-toggle">
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}

export function DirectorSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="director-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
