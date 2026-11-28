import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_TIMELINE_TEXT_CONTENT,
  type TextClipData,
  type TextClipStyle,
} from "../../../shared/domain";
import { CLIP_FONTS } from "../fonts";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  STROKE_WIDTH_MAX,
  clampTextContent,
} from "../interactions/textActions";
import { wholeNumberIn } from "./clipFieldMath";

/**
 * The form a text clip wears, wherever one is written.
 *
 * The same fields set the words that are about to be laid down on the Text
 * page and the words a chosen clip already carries, so the two can never grow
 * apart: the composer and the inspector both hand this form a value and take
 * the value it makes back. Nothing is committed here — the caller decides what
 * a keystroke, a release and a click each mean — except the points the form
 * can only know itself: the words commit on blur, `Escape` inside them asks
 * the caller to put back what was there, and a number commits on blur or on a
 * step button.
 *
 * A field a set of clips disagrees about wears `Mixed`: the caller says which
 * ones those are, and a mixed select or number shows the word rather than one
 * of the values, since there is no one value to show.
 */

/** Text held locally while a field is being typed in, synced when it is not. */
function useTypedText(value: string) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return { text, setText, focused };
}

/** The word a field wears when the chosen clips do not agree about it. */
function Mixed() {
  const { t } = useTranslation();
  return <em className="clip-text-mixed">{t("clip:common.mixed")}</em>;
}

function Label({ children, mixed }: { children: string; mixed?: boolean }) {
  return (
    <span className="clip-text-label">
      {children}
      {mixed === true && <Mixed />}
    </span>
  );
}

/** Which words each alignment wears, and how the switch is named to a reader. */
const ALIGN_KEYS = {
  left: { word: "clip:textFields.left", aria: "clip:textFields.alignLeftAria" },
  center: {
    word: "clip:textFields.center",
    aria: "clip:textFields.alignCenterAria",
  },
  right: {
    word: "clip:textFields.right",
    aria: "clip:textFields.alignRightAria",
  },
} as const;

/** Which words each placement wears, and how the switch is named to a reader. */
const POSITION_KEYS = {
  top: {
    word: "clip:textFields.top",
    aria: "clip:textFields.positionTopAria",
  },
  center: {
    word: "clip:textFields.center",
    aria: "clip:textFields.positionCenterAria",
  },
  bottom: {
    word: "clip:textFields.bottom",
    aria: "clip:textFields.positionBottomAria",
  },
} as const;

/** A whole-number field with a step down and a step up beside it. */
function NumberStepper({
  labelKey,
  max,
  min,
  mixed,
  onCommit,
  value,
}: {
  /** What the field is called, as a translation key. */
  labelKey: string;
  min: number;
  max: number;
  /** The number the field stands for; null on a set that disagrees. */
  value: number | null;
  mixed: boolean;
  onCommit: (value: number) => void;
}) {
  const { t } = useTranslation();
  const label = t(labelKey);
  const shown = mixed || value === null ? "" : String(value);
  const { text, setText, focused } = useTypedText(shown);
  const commit = () => {
    if (text.trim().length === 0) {
      setText(shown);
      return;
    }
    const parsed = wholeNumberIn(text, min, max);
    if (parsed === null) {
      // A reading outside the bounds is shown as it was rather than jumping
      // the number somewhere the reader did not ask for.
      setText(shown);
      return;
    }
    if (value !== null && parsed === value) return;
    onCommit(parsed);
  };
  const nudge = (delta: number) => {
    const from = value ?? Math.round((min + max) / 2);
    const next = Math.min(max, Math.max(min, from + delta));
    if (value !== null && next === value) return;
    onCommit(next);
  };
  const name = label.toLowerCase();
  return (
    <div className="clip-text-field clip-text-size">
      <Label mixed={mixed}>{label}</Label>
      <span className="clip-text-stepper">
        <button
          aria-label={t("clip:textFields.smaller", { name })}
          onClick={() => nudge(-1)}
          type="button"
        >
          −
        </button>
        <input
          aria-label={label}
          inputMode="numeric"
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => {
            focused.current = true;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          placeholder={mixed ? t("clip:common.mixed") : undefined}
          value={text}
        />
        <button
          aria-label={t("clip:textFields.larger", { name })}
          onClick={() => nudge(1)}
          type="button"
        >
          +
        </button>
      </span>
    </div>
  );
}

export interface TextFieldsProps {
  /** The text the form is editing: a clip's own, or a draft standing in for it. */
  value: TextClipData;
  /**
   * The value the form makes. `commit` is false while a keystroke or a drag is
   * still going on and true at the point the caller should write it down.
   */
  onChange: (next: TextClipData, commit: boolean) => void;
  /** Style fields the chosen set disagrees about; those read as `Mixed`. */
  mixed?: ReadonlySet<keyof TextClipStyle>;
  /** Whether the words themselves may be edited here (one clip chosen). */
  words?: boolean;
  /** `Escape` in the words box: the caller puts back what the document holds. */
  onEscape?: () => void;
}

export function TextFields({
  value,
  onChange,
  mixed,
  words = true,
  onEscape,
}: TextFieldsProps) {
  const { t } = useTranslation();
  const style = value.style;
  const isMixed = (key: keyof TextClipStyle): boolean =>
    mixed?.has(key) === true;
  const setStyle = (patch: Partial<TextClipStyle>, commit: boolean): void =>
    onChange({ content: value.content, style: { ...style, ...patch } }, commit);

  return (
    <div className="clip-text-fields" data-testid="clip-text-fields">
      {words ? (
        <label className="clip-text-field">
          <span className="clip-text-label">
            {t("clip:textFields.content")}
          </span>
          <textarea
            aria-label={t("clip:textFields.content")}
            data-testid="clip-text-content"
            maxLength={MAX_TIMELINE_TEXT_CONTENT}
            onBlur={() => onChange(value, true)}
            onChange={(event) => {
              const content = clampTextContent(event.target.value);
              onChange({ content, style }, false);
            }}
            onKeyDown={(event) => {
              // Enter is a newline inside the box, which is a break the author
              // asked for; Escape is the way back to what the document holds.
              if (event.key === "Escape") {
                event.preventDefault();
                onEscape?.();
              }
            }}
            rows={3}
            value={value.content}
          />
          <span className="clip-text-count">
            {value.content.length}/{MAX_TIMELINE_TEXT_CONTENT}
          </span>
        </label>
      ) : (
        <p className="clip-text-hint">
          {t("clip:textFields.selectOneTextClip")}
        </p>
      )}

      <div className="clip-text-row">
        <label className="clip-text-field clip-text-grow">
          <Label mixed={isMixed("fontFamily")}>
            {t("clip:textFields.font")}
          </Label>
          <select
            aria-label={t("clip:textFields.font")}
            onChange={(event) =>
              setStyle({ fontFamily: event.target.value }, true)
            }
            value={isMixed("fontFamily") ? "" : style.fontFamily}
          >
            {isMixed("fontFamily") && (
              <option value="">{t("clip:common.mixed")}</option>
            )}
            {CLIP_FONTS.map((font) => (
              <option key={font.label} value={font.stack}>
                {font.label}
              </option>
            ))}
          </select>
        </label>
        <NumberStepper
          labelKey="clip:textFields.size"
          max={FONT_SIZE_MAX}
          min={FONT_SIZE_MIN}
          mixed={isMixed("fontSize")}
          onCommit={(size) => setStyle({ fontSize: size }, true)}
          value={isMixed("fontSize") ? null : style.fontSize}
        />
      </div>

      <div className="clip-text-row">
        <label className="clip-text-field">
          <Label mixed={isMixed("color")}>{t("clip:textFields.color")}</Label>
          <input
            aria-label={t("clip:textFields.color")}
            onChange={(event) => setStyle({ color: event.target.value }, true)}
            type="color"
            value={style.color}
          />
        </label>
        <label className="clip-text-field">
          <Label mixed={isMixed("strokeColor")}>
            {t("clip:textFields.stroke")}
          </Label>
          <input
            aria-label={t("clip:textFields.strokeColor")}
            onChange={(event) =>
              setStyle({ strokeColor: event.target.value }, true)
            }
            type="color"
            value={style.strokeColor}
          />
        </label>
        <NumberStepper
          labelKey="clip:textFields.strokeWidth"
          max={STROKE_WIDTH_MAX}
          min={0}
          mixed={isMixed("strokeWidth")}
          onCommit={(width) => setStyle({ strokeWidth: width }, true)}
          value={isMixed("strokeWidth") ? null : style.strokeWidth}
        />
        <div className="clip-text-toggles">
          <button
            aria-label={t("clip:textFields.bold")}
            aria-pressed={isMixed("bold") ? false : style.bold}
            className={
              isMixed("bold") || !style.bold
                ? "clip-text-toggle"
                : "clip-text-toggle is-on"
            }
            onClick={() => setStyle({ bold: !style.bold }, true)}
            type="button"
          >
            B
          </button>
          <button
            aria-label={t("clip:textFields.italic")}
            aria-pressed={isMixed("italic") ? false : style.italic}
            className={
              isMixed("italic") || !style.italic
                ? "clip-text-toggle"
                : "clip-text-toggle is-on"
            }
            onClick={() => setStyle({ italic: !style.italic }, true)}
            type="button"
          >
            I
          </button>
        </div>
      </div>

      <div className="clip-text-row">
        <div className="clip-text-group">
          <Label mixed={isMixed("align")}>{t("clip:textFields.align")}</Label>
          <div className="clip-text-toggles">
            {(["left", "center", "right"] as const).map((align) => (
              <button
                aria-label={t(ALIGN_KEYS[align].aria)}
                aria-pressed={isMixed("align") ? false : style.align === align}
                className={
                  isMixed("align") || style.align !== align
                    ? "clip-text-toggle"
                    : "clip-text-toggle is-on"
                }
                key={align}
                onClick={() => setStyle({ align }, true)}
                type="button"
              >
                {t(ALIGN_KEYS[align].word)}
              </button>
            ))}
          </div>
        </div>
        <div className="clip-text-group">
          <Label mixed={isMixed("position")}>
            {t("clip:textFields.position")}
          </Label>
          <div className="clip-text-toggles">
            {(["top", "center", "bottom"] as const).map((position) => (
              <button
                aria-label={t(POSITION_KEYS[position].aria)}
                aria-pressed={
                  isMixed("position") ? false : style.position === position
                }
                className={
                  isMixed("position") || style.position !== position
                    ? "clip-text-toggle"
                    : "clip-text-toggle is-on"
                }
                key={position}
                onClick={() => setStyle({ position }, true)}
                type="button"
              >
                {t(POSITION_KEYS[position].word)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="clip-text-row">
        <NumberStepper
          labelKey="clip:textFields.x"
          max={100}
          min={0}
          mixed={isMixed("x") || isMixed("y")}
          onCommit={(value) => {
            const rest = { ...style };
            delete rest.x;
            delete rest.y;
            setStyle({ ...rest, x: value / 100, y: style.y ?? 0.5 }, true);
          }}
          value={
            isMixed("x") || isMixed("y")
              ? null
              : Math.round((style.x ?? 0.5) * 100)
          }
        />
        <NumberStepper
          labelKey="clip:textFields.y"
          max={100}
          min={0}
          mixed={isMixed("x") || isMixed("y")}
          onCommit={(value) => {
            const rest = { ...style };
            delete rest.x;
            delete rest.y;
            setStyle({ ...rest, x: style.x ?? 0.5, y: value / 100 }, true);
          }}
          value={
            isMixed("x") || isMixed("y")
              ? null
              : Math.round((style.y ?? 0.5) * 100)
          }
        />
        <button
          className={
            style.x === undefined && style.y === undefined
              ? "clip-text-toggle is-on"
              : "clip-text-toggle"
          }
          onClick={() => setStyle({ x: undefined, y: undefined }, true)}
          type="button"
        >
          {t("clip:textFields.autoPlace")}
        </button>
      </div>

      <div className="clip-text-row">
        <NumberStepper
          labelKey="clip:textFields.rotation"
          max={180}
          min={-180}
          mixed={isMixed("rotation")}
          onCommit={(value) => setStyle({ rotation: value }, true)}
          value={isMixed("rotation") ? null : (style.rotation ?? 0)}
        />
        <NumberStepper
          labelKey="clip:textFields.letterSpacing"
          max={40}
          min={0}
          mixed={isMixed("letterSpacing")}
          onCommit={(value) => setStyle({ letterSpacing: value }, true)}
          value={isMixed("letterSpacing") ? null : (style.letterSpacing ?? 0)}
        />
        <NumberStepper
          labelKey="clip:textFields.fade"
          max={5_000}
          min={0}
          mixed={isMixed("fadeMs")}
          onCommit={(value) => setStyle({ fadeMs: value }, true)}
          value={isMixed("fadeMs") ? null : (style.fadeMs ?? 0)}
        />
      </div>

      <div className="clip-text-row">
        <div className="clip-text-group">
          <Label mixed={isMixed("background")}>
            {t("clip:textFields.plate")}
          </Label>
          <div className="clip-text-toggles">
            <input
              aria-label={t("clip:textFields.plateColor")}
              onChange={(event) =>
                setStyle({ background: event.target.value }, true)
              }
              type="color"
              value={style.background ?? "#000000"}
            />
            <button
              aria-label={t("clip:textFields.noPlate")}
              aria-pressed={style.background === null}
              className={
                style.background === null
                  ? "clip-text-toggle is-on"
                  : "clip-text-toggle"
              }
              onClick={() => setStyle({ background: null }, true)}
              type="button"
            >
              {t("clip:textFields.none")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
