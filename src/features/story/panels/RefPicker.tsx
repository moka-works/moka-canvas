import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { assetThumbUrl } from "../../../api/assets";
import type { StoryElement, StoryElementKind } from "../../../shared/domain";
import { currentTake } from "../../../shared/domain";

/** How wide a chip's little picture is asked for: it is drawn 20 px square. */
const AVATAR_THUMB_WIDTH = 64;

/** The little picture a reference is recognised by, or the empty it has not. */
function RefAvatar({ assetId }: { assetId?: string }) {
  if (assetId === undefined) {
    return <span className="story-ref-avatar is-empty" aria-hidden="true" />;
  }
  return (
    <img
      alt=""
      className="story-ref-avatar"
      decoding="async"
      loading="lazy"
      src={assetThumbUrl(assetId, AVATAR_THUMB_WIDTH)}
    />
  );
}

/**
 * Who and what an act is made of, as a row of names with a menu to change them.
 *
 * Three groups, and the difference between them is what the board means by
 * them: a character is one of several, a place is the one place it happens in,
 * and a thing is any number of them. A name the story no longer holds is kept
 * on show — greyed, with a way to take it off — because a board that named
 * someone who has since left says something the reader should see.
 */
export function RefPicker({
  label,
  kind,
  elements,
  chosen,
  many,
  disabled,
  onPick,
  pictureOf,
  onInspect,
}: {
  label: string;
  kind: StoryElementKind;
  /** Every element of this kind the story holds. */
  elements: StoryElement[];
  chosen: string[];
  /** Whether more than one may be picked, or exactly one. */
  many: boolean;
  disabled?: boolean;
  onPick: (ids: string[]) => void;
  /** The drawing an element is recognised by, where one is shown beside it. */
  pictureOf?: (element: StoryElement) => string | undefined;
  /** Opens one of the listed elements, for its picture and its card. */
  onInspect?: (element: StoryElement) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const held = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (held.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const pool = elements.filter((element) => element.kind === kind);
  const known = new Set(pool.map((element) => element.id));
  const gone = chosen.filter((id) => !known.has(id));
  const shown = pool.filter((element) =>
    element.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const toggle = (id: string) => {
    if (chosen.includes(id)) {
      onPick(chosen.filter((held) => held !== id));
      return;
    }
    onPick(many ? [...chosen, id] : [id]);
    if (!many) setOpen(false);
  };

  return (
    <div className="story-refs" ref={held}>
      <span className="story-refs-label">{label}</span>
      {chosen
        .filter((id) => known.has(id))
        .map((id) => {
          const element = pool.find((each) => each.id === id);
          if (element === undefined) return null;
          return (
            <span className="story-ref is-on" key={id}>
              {onInspect === undefined ? (
                element.name
              ) : (
                <button
                  className="story-ref-view"
                  data-testid={`story-ref-view-${element.name}`}
                  onClick={() => onInspect(element)}
                  title={t("story:storyboard.inspectRef", {
                    name: element.name,
                  })}
                  type="button"
                >
                  <RefAvatar assetId={pictureOf?.(element)} />
                  <span>{element.name}</span>
                </button>
              )}
              {!disabled && (
                <button
                  aria-label={t("story:storyboard.refOff", {
                    name: element.name,
                  })}
                  className="story-ref-off"
                  data-testid={`story-ref-off-${element.name}`}
                  onClick={() => onPick(chosen.filter((each) => each !== id))}
                  type="button"
                >
                  ✕
                </button>
              )}
            </span>
          );
        })}
      {gone.map((id) => (
        <span
          className="story-ref is-gone"
          key={id}
          title={t("story:storyboard.refGone")}
        >
          {t("story:storyboard.refGoneShort")}
          {!disabled && (
            <button
              aria-label={t("story:storyboard.refGone")}
              className="story-ref-off"
              onClick={() => onPick(chosen.filter((each) => each !== id))}
              type="button"
            >
              ✕
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <button
          className="story-ref-add"
          data-testid={`story-ref-add-${kind}`}
          onClick={() => setOpen(!open)}
          type="button"
        >
          +
        </button>
      )}
      {open && (
        <div
          aria-label={t("story:storyboard.refs", { label })}
          className="story-ref-menu"
          data-testid={`story-ref-menu-${kind}`}
          role="menu"
        >
          {pool.length > 6 && (
            <input
              aria-label={t("story:storyboard.refSearch")}
              className="story-ref-search"
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("story:storyboard.refSearch")}
              value={search}
            />
          )}
          {shown.length === 0 && (
            <span className="story-hint">{t("story:storyboard.refNone")}</span>
          )}
          {shown.map((element) => (
            <button
              aria-checked={chosen.includes(element.id)}
              className={`story-ref-choice${chosen.includes(element.id) ? " is-on" : ""}`}
              data-testid={`story-ref-choice-${element.name}`}
              key={element.id}
              onClick={() => toggle(element.id)}
              role="menuitemcheckbox"
              type="button"
            >
              <span className="story-ref-choice-name">
                <RefAvatar assetId={pictureOf?.(element)} />
                {element.name}
              </span>
              <span className="story-hint">
                {currentTake(element.main) === undefined
                  ? t("story:storyboard.refNoArt")
                  : t("story:storyboard.refHasArt")}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
