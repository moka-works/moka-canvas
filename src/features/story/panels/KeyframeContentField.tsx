import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { i18n } from "../../../shared/i18n";
import { storyMentions } from "../../../shared/domain";
import {
  insertStoryMention,
  narrowStoryMentions,
  storyMentionBeingTyped,
  type StoryMentionOption,
} from "./storyMentions";

/** What a chip is found by, and the name it stands for. */
const CHIP_SELECTOR = "[data-mention-name]";

/** How a mentioned name stands in the ask: sent, left behind, or only words. */
export type MentionKind = "carried" | "beyond" | "undrawn" | "unknown";

/**
 * The words of the field as one string, a chip as the token it stands for.
 *
 * A `<br>` is the line it breaks and a block that holds nothing is the line it
 * is without counting the `<br>` the field drew inside it to keep the line
 * visible — a newline and its placeholder are one newline, not two.
 */
function serialize(root: Node): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const name = el.dataset?.mentionName;
    if (name !== undefined) {
      out += `\`${name}\``;
      return;
    }
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    if (el.tagName === "DIV" || el.tagName === "P") {
      if (out !== "" && !out.endsWith("\n")) out += "\n";
      if (el.textContent === "" && !el.querySelector(CHIP_SELECTOR)) return;
    }
    for (const child of Array.from(el.childNodes)) walk(child);
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return out;
}

/**
 * Where the caret sits in the field's words, counting a chip as the token it
 * stands for — or null when the caret is not in this field to be counted.
 */
function caretOffset(area: HTMLElement): number | null {
  const selection = area.ownerDocument.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (range.startContainer !== area && !area.contains(range.startContainer)) {
    return null;
  }
  try {
    const before = range.cloneRange();
    before.selectNodeContents(area);
    before.setEnd(range.startContainer, range.startOffset);
    return serialize(before.cloneContents()).length;
  } catch {
    return null;
  }
}

/** Stands the caret at a place in the words, counting chips as their tokens. */
function placeCaret(area: HTMLElement, target: number): void {
  const selection = area.ownerDocument.getSelection?.();
  if (!selection) return;
  let seen = 0;
  let lastChar = "";
  let hit: { node: Node; offset: number } | null = null;
  const walkChildren = (parent: Node) => {
    const kids = Array.from(parent.childNodes);
    for (let index = 0; index < kids.length; index += 1) {
      if (hit) return;
      const node = kids[index];
      if (node.nodeType === Node.TEXT_NODE) {
        const words = node.nodeValue ?? "";
        if (target <= seen + words.length) {
          hit = { node, offset: Math.max(0, target - seen) };
          return;
        }
        seen += words.length;
        lastChar = words.slice(-1) || lastChar;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const name = el.dataset?.mentionName;
        if (name !== undefined) {
          const length = name.length + 2;
          if (target <= seen) {
            hit = { node: parent, offset: index };
            return;
          }
          if (target <= seen + length) {
            hit = { node: parent, offset: index + 1 };
            return;
          }
          seen += length;
          lastChar = "`";
        } else if (el.tagName === "BR") {
          if (target <= seen) {
            hit = { node: parent, offset: index };
            return;
          }
          seen += 1;
          lastChar = "\n";
          if (target <= seen) {
            hit = { node: parent, offset: index + 1 };
            return;
          }
        } else {
          if (
            (el.tagName === "DIV" || el.tagName === "P") &&
            seen > 0 &&
            lastChar !== "\n"
          ) {
            seen += 1;
            lastChar = "\n";
            if (target <= seen) {
              hit = { node: el, offset: 0 };
              return;
            }
          }
          walkChildren(el);
        }
      }
    }
  };
  walkChildren(area);
  if (!hit) hit = { node: area, offset: area.childNodes.length };
  const range = area.ownerDocument.createRange();
  range.setStart(hit.node, hit.offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** A mention drawn: the name it stands for, in the style of a code span. */
function chipFor(
  document: Document,
  name: string,
  kind: MentionKind,
  title: string,
): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `story-mention is-${kind}`;
  chip.contentEditable = "false";
  chip.dataset.mentionName = name;
  chip.title = title;
  chip.textContent = name;
  return chip;
}

/**
 * Draws the words into the field: prose as prose, and every mention as the
 * chip that stands for it. The field is taken apart and put back together
 * rather than patched, since a patch that missed would leave a token among
 * the words where a chip belongs.
 */
function renderValue(
  area: HTMLElement,
  value: string,
  kinds: Record<string, MentionKind>,
  titleOf: (name: string, kind: MentionKind) => string,
): void {
  const document = area.ownerDocument;
  const kids: Node[] = [];
  let cursor = 0;
  for (const span of storyMentions(value)) {
    if (span.start > cursor) {
      kids.push(document.createTextNode(value.slice(cursor, span.start)));
    }
    const kind = kinds[span.name] ?? "unknown";
    kids.push(chipFor(document, span.name, kind, titleOf(span.name, kind)));
    cursor = span.end;
  }
  if (cursor < value.length) {
    kids.push(document.createTextNode(value.slice(cursor)));
  }
  area.replaceChildren(...kids);
}

/** What the field last drew, so its own edits are not drawn over again. */
function signatureOf(
  value: string,
  kinds: Record<string, MentionKind>,
): string {
  const marks = Object.keys(kinds)
    .sort()
    .map((name) => `${name}:${kinds[name]}`)
    .join(",");
  return `${value}\u0001${marks}\u0001${i18n.resolvedLanguage ?? ""}`;
}

/**
 * A shot's own words, as a field that knows what a mention is: `` `name` `` is
 * drawn as the chip the ask travels with, and everything around it is prose.
 *
 * A rich field rather than a textarea with the backticks among the words: the
 * chip is one thing the caret walks over and the backspace takes out whole,
 * and a reader can see at a glance which of the names they wrote are pictures
 * the model will be given — plainly, over the story's limit, or not drawn at
 * all. What reaches the document is still the text with its backticks, which
 * is what the plan reads; the chips are only how the field shows one.
 */
export function KeyframeContentField({
  value,
  kinds,
  label,
  testId,
  mentionOptions,
  onChooseMention,
  onChange,
  onCommit,
}: {
  value: string;
  /** How each mentioned name stands, by the name it is mentioned with. */
  kinds: Record<string, MentionKind>;
  label: string;
  testId?: string;
  /** The names an @ offers: the cast's forms, then the shot's extras. */
  mentionOptions: StoryMentionOption[];
  /** A cast form was chosen, which is the form this shot now draws it in. */
  onChooseMention?: (option: StoryMentionOption) => void;
  onChange: (next: string) => void;
  onCommit: () => void;
}) {
  const { t } = useTranslation();
  const areaRef = useRef<HTMLDivElement>(null);
  const drawn = useRef<string | null>(null);
  const [offer, setOffer] = useState<{ start: number; query: string } | null>(
    null,
  );
  const [active, setActive] = useState(0);
  // What the handlers read without being rebuilt on every keystroke.
  const held = useRef({ value, kinds, t, mentionOptions });
  held.current = { value, kinds, t, mentionOptions };
  const rows = narrowStoryMentions(mentionOptions, offer?.query ?? "");
  const chosen = rows.length === 0 ? 0 : active % rows.length;

  const titleOf = (name: string, kind: MentionKind): string => {
    switch (kind) {
      case "carried":
        return t("story:storyboard.mentionCarried", { name });
      case "beyond":
        return t("story:storyboard.notCarried", { name });
      case "undrawn":
        return t("story:storyboard.mentionUndrawn", { name });
      case "unknown":
        return t("story:storyboard.mentionUnknown", { name });
    }
  };

  /**
   * Draws the field to match what it was given, when what it was given is not
   * what it last drew. Its own edits are left alone: redrawing a field that is
   * being typed in would take the caret away from where the words put it.
   */
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    if (drawn.current === signatureOf(value, kinds)) return;
    const at = area.contains(area.ownerDocument.activeElement)
      ? caretOffset(area)
      : null;
    renderValue(area, value, kinds, titleOf);
    if (at !== null) placeCaret(area, Math.min(at, value.length));
    drawn.current = signatureOf(value, kinds);
  });

  /** Reads the field after an edit of its own and says what changed. */
  const retake = (words: string) => {
    const area = areaRef.current;
    if (!area) return;
    const next = storyMentionBeingTyped(
      words,
      caretOffset(area) ?? words.length,
    );
    setOffer(next);
    if (next?.query !== offer?.query) setActive(0);
  };

  /** Reads the field after an edit of its own and says what changed. */
  const sync = () => {
    const area = areaRef.current;
    if (!area) return;
    const now = held.current;
    const next = serialize(area);
    drawn.current = signatureOf(next, now.kinds);
    if (next !== now.value) onChange(next);
    retake(next);
  };

  /**
   * Reads the field after the reader edited it.
   *
   * A token that arrived as words — typed backtick and all, or pasted — is
   * drawn as the chip it is, so the field never shows the syntax where a
   * picture's name is meant.
   */
  const emit = () => {
    const area = areaRef.current;
    if (!area) return;
    const now = held.current;
    const next = serialize(area);
    const chips = area.querySelectorAll(CHIP_SELECTOR).length;
    if (storyMentions(next).length !== chips) {
      const at = caretOffset(area) ?? next.length;
      renderValue(area, next, now.kinds, now.t);
      placeCaret(area, at);
    }
    drawn.current = signatureOf(next, now.kinds);
    if (next !== now.value) onChange(next);
    retake(next);
  };

  /** Takes one offered name up, written as the mention the words already use. */
  const choose = (option: StoryMentionOption) => {
    if (offer === null) return;
    const area = areaRef.current;
    const at = area ? (caretOffset(area) ?? value.length) : value.length;
    const inserted = insertStoryMention(
      held.current.value,
      offer.start,
      at,
      option.name,
    );
    setOffer(null);
    setActive(0);
    drawn.current = signatureOf(inserted.value, held.current.kinds);
    onChange(inserted.value);
    onChooseMention?.(option);
    if (area) {
      renderValue(area, inserted.value, held.current.kinds, titleOf);
      area.focus();
      placeCaret(area, inserted.caret);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (offer !== null) {
      const step = (move: number) => {
        event.preventDefault();
        const count = Math.max(1, rows.length);
        setActive((index) => (((index + move) % count) + count) % count);
      };
      if (event.key === "ArrowDown") return step(1);
      if (event.key === "ArrowUp") return step(-1);
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.nativeEvent.isComposing
      ) {
        const row = rows[chosen];
        if (row !== undefined) {
          event.preventDefault();
          choose(row);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setOffer(null);
        return;
      }
    }
    // Backspace behind a chip takes the whole of it. One character at a time
    // is not a thing a chip can lose, but a field left to the browser could
    // ask for the key twice, and a reader should not have to press twice for
    // one thing undone.
    if (event.key !== "Backspace") return;
    const area = areaRef.current;
    if (!area) return;
    const at = caretOffset(area);
    if (at === null) return;
    const spans = storyMentions(held.current.value);
    const index = spans.findIndex((span) => span.end === at);
    if (index < 0) return;
    event.preventDefault();
    const chip = area.querySelectorAll(CHIP_SELECTOR)[index];
    if (chip) chip.remove();
    placeCaret(area, spans[index].start);
    sync();
  };

  /** Words are taken in as words: a paste never brings another field's shapes. */
  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const area = event.currentTarget;
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    const document = area.ownerDocument;
    const selection = document.getSelection?.();
    const range =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (range && area.contains(range.startContainer)) {
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      area.appendChild(document.createTextNode(text));
      placeCaret(area, serialize(area).length);
    }
    emit();
  };

  return (
    <div className="story-prompt-field-wrap">
      <div
        aria-activedescendant={
          offer !== null && rows[chosen]
            ? `${testId}-offer-${chosen}`
            : undefined
        }
        aria-expanded={offer !== null}
        aria-label={label}
        aria-multiline="true"
        className="story-prompt-field"
        contentEditable
        data-testid={testId}
        onBlur={() => {
          setOffer(null);
          onCommit();
        }}
        onClick={(event) => retake(serialize(event.currentTarget))}
        onInput={emit}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => retake(serialize(event.currentTarget))}
        onPaste={onPaste}
        ref={areaRef}
        role="textbox"
        suppressContentEditableWarning
      />
      {offer !== null && rows.length > 0 && (
        <div
          className="story-mention-offer"
          data-testid={testId === undefined ? undefined : `${testId}-offer`}
          role="listbox"
        >
          {rows.map((option, at) => (
            <div key={option.key}>
              {option.group !== rows[at - 1]?.group && (
                <p className="story-mention-offer-label">
                  {t(
                    option.group === "cast"
                      ? "story:storyboard.mentionCast"
                      : "story:storyboard.mentionExtras",
                  )}
                </p>
              )}
              <button
                aria-selected={at === chosen}
                className={at === chosen ? "is-active" : ""}
                id={testId === undefined ? undefined : `${testId}-offer-${at}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
                role="option"
                type="button"
              >
                {option.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
