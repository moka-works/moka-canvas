import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  TimelineDocument,
  TimelineTrack,
  TrackId,
  TrackKind,
} from "../../../shared/domain";
import { useClampedMenuPosition } from "../../editor/panels/useClampedMenuPosition";
import { PlusIcon } from "./ClipIcons";
import {
  addTrackOfKind,
  alignSelection,
  clipsCrossingPlayhead,
  deleteSelection,
  duplicateSelection,
  removeTrack,
  renameTrack,
  selectAll,
  selectedClips,
  splitSelectionAtPlayhead,
} from "../interactions/clipActions";
import { useClipStore } from "../stores/clipStore";
import { editCue, newCueAt } from "../interactions/textActions";

/**
 * The cut's own menus.
 *
 * Written here rather than borrowing the board's `ContextMenu`, which is
 * wound through the editor's store and its node kinds; what a timeline offers
 * is a different list of verbs about different things. The look is the same
 * `.menu` surface everywhere, so the two read as one application.
 *
 * Every item is a thin call into the room's actions: this file decides what
 * to offer and when an item is available, never what a command does or why
 * one was refused.
 */

/** What a right-click landed on, which decides the list. */
export type TimelineMenuTarget =
  | {
      kind: "clips";
      onClip: boolean;
      /**
       * The blank of a row it landed on, and the moment under the pointer:
       * where a cue can be written if the row takes words. Null on a clip.
       */
      blank: { trackId: TrackId; atMs: number } | null;
    }
  | { kind: "track"; trackId: TrackId };

interface TimelineMenuProps {
  timeline: TimelineDocument;
  target: TimelineMenuTarget;
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * The menu a right-click on the canvas or a track header opens.
 *
 * A clip that was not chosen is chosen before the menu shows, so everything
 * on it reads as being about what was pointed at. An already tidy selection
 * sends no command at all — the actions decide that — and a refusal that only
 * the document can see is spoken by the document's own words.
 */
export function TimelineMenu({
  timeline,
  target,
  x,
  y,
  onClose,
}: TimelineMenuProps) {
  const { t } = useTranslation();
  const selection = useClipStore((state) => state.selection);
  const playheadMs = useClipStore((state) => state.playheadMs);
  if (target.kind === "track") {
    const track = timeline.tracks.find((row) => row.id === target.trackId);
    if (!track) return null;
    return (
      <MenuPanel label={t("clip:menu.trackMenu")} onClose={onClose} x={x} y={y}>
        <TrackItems onClose={onClose} timeline={timeline} track={track} />
      </MenuPanel>
    );
  }
  const chosen = selectedClips(timeline, selection);
  const crosses = clipsCrossingPlayhead(timeline, playheadMs).length > 0;
  // A blank on a text row is somewhere a cue can be written; a blank on any
  // other row offers nothing, since pictures and sounds are not typed.
  const blank = target.blank;
  const blankTrack = blank
    ? (timeline.tracks.find((row) => row.id === blank.trackId) ?? null)
    : null;
  const takesWords = blankTrack?.kind === "text";
  return (
    <MenuPanel
      label={t("clip:menu.timelineMenu")}
      onClose={onClose}
      x={x}
      y={y}
    >
      {target.onClip ? (
        <>
          {chosen.length === 1 && chosen[0].kind === "text" && (
            <MenuItem
              label={t("clip:menu.editSubtitle")}
              onSelect={() => {
                onClose();
                editCue(chosen[0]);
              }}
            />
          )}
          <MenuItem
            disabled={!crosses}
            label={t("clip:common.splitAtPlayhead")}
            onSelect={() => {
              onClose();
              splitSelectionAtPlayhead();
            }}
          />
          <MenuItem
            disabled={chosen.length === 0}
            label={t("clip:common.duplicate")}
            onSelect={() => {
              onClose();
              duplicateSelection();
            }}
          />
          <MenuItem
            disabled={chosen.length === 0 && selection.transitionId === null}
            label={t("clip:common.delete")}
            onSelect={() => {
              onClose();
              deleteSelection();
            }}
          />
          {chosen.length >= 2 && (
            <>
              <div className="menu-sep" />
              <p className="menu-title">{t("clip:menu.align")}</p>
              <MenuItem
                label={t("clip:menu.alignLeft")}
                onSelect={() => {
                  onClose();
                  alignSelection("left");
                }}
              />
              <MenuItem
                disabled={chosen.length < 3}
                label={t("clip:menu.distributeEvenly")}
                onSelect={() => {
                  onClose();
                  alignSelection("distribute");
                }}
              />
              <MenuItem
                label={t("clip:menu.joinButted")}
                onSelect={() => {
                  onClose();
                  alignSelection("butted");
                }}
              />
            </>
          )}
        </>
      ) : (
        <>
          {takesWords && blank && (
            <>
              <MenuItem
                label={t("clip:menu.addSubtitle")}
                onSelect={() => {
                  onClose();
                  newCueAt(blank.trackId, blank.atMs);
                }}
              />
              <div className="menu-sep" />
            </>
          )}
          <MenuItem
            disabled={timeline.clips.length === 0}
            label={t("clip:common.selectAll")}
            onSelect={() => {
              onClose();
              selectAll();
            }}
          />
        </>
      )}
    </MenuPanel>
  );
}

/** Naming a row in place, or the rest of what a row can have done to it. */
function TrackItems({
  timeline,
  track,
  onClose,
}: {
  timeline: TimelineDocument;
  track: TimelineTrack;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(track.name);
  const [renaming, setRenaming] = useState(false);
  const index = timeline.tracks.findIndex((row) => row.id === track.id);
  const holdsClips = timeline.clips.some((clip) => clip.trackId === track.id);

  if (renaming) {
    const commit = () => {
      onClose();
      renameTrack(timeline, track.id, name);
    };
    return (
      <input
        aria-label={t("clip:menu.trackName")}
        autoFocus
        className="menu-input"
        maxLength={80}
        onBlur={onClose}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        value={name}
      />
    );
  }

  return (
    <>
      <MenuItem
        label={t("clip:menu.rename")}
        onSelect={() => setRenaming(true)}
      />
      <MenuItem
        label={t("clip:menu.addTrackAbove")}
        onSelect={() => {
          onClose();
          // The list's tail is the top of the stack, so one row higher on
          // screen is one place later in the document.
          addTrackOfKind(timeline, track.kind, index + 1);
        }}
      />
      <MenuItem
        label={t("clip:menu.addTrackBelow")}
        onSelect={() => {
          onClose();
          addTrackOfKind(timeline, track.kind, index);
        }}
      />
      <div className="menu-sep" />
      <MenuItem
        disabled={holdsClips}
        label={t("clip:menu.removeTrack")}
        onSelect={() => {
          onClose();
          removeTrack(timeline, track.id);
        }}
      />
    </>
  );
}

/** The corner's plus: the three kinds of row a cut can grow. */
export function AddTrackButton({ timeline }: { timeline: TimelineDocument }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const kinds: { kind: TrackKind; label: string }[] = [
    { kind: "video", label: t("clip:menu.trackVideo") },
    { kind: "audio", label: t("clip:menu.trackAudio") },
    { kind: "text", label: t("clip:menu.trackText") },
  ];
  return (
    <>
      <button
        aria-haspopup="menu"
        aria-label={t("clip:menu.addTrack")}
        className="clip-tl-button"
        data-testid="track-add"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 4 });
        }}
        title={t("clip:menu.addTrack")}
        type="button"
      >
        <PlusIcon size={15} />
      </button>
      {anchor && (
        <MenuPanel
          label={t("clip:menu.addTrack")}
          onClose={() => setAnchor(null)}
          x={anchor.x}
          y={anchor.y}
        >
          {kinds.map(({ kind, label }) => (
            <MenuItem
              key={kind}
              label={label}
              onSelect={() => {
                setAnchor(null);
                // A new row lands at the end of the list, which is the top of
                // the stack: the reader sees it arrive.
                addTrackOfKind(timeline, kind);
              }}
            />
          ))}
        </MenuPanel>
      )}
    </>
  );
}

/** One line of a menu: a verb, available or greyed, never a command of its own. */
function MenuItem({
  label,
  disabled = false,
  onSelect,
}: {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onSelect}
      role="menuitem"
      type="button"
    >
      {label}
    </button>
  );
}

/**
 * The floating surface a menu is drawn on.
 *
 * Fixed to the window rather than the room, since a menu opened near an edge
 * is pulled inside it; a pointer anywhere else, or Escape, puts it down. The
 * board's own menus behave the same way, which is why the classes are shared.
 */
function MenuPanel({
  x,
  y,
  label,
  onClose,
  children,
}: {
  x: number;
  y: number;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { ref, pos } = useClampedMenuPosition(x, y);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (
        ref.current &&
        event.target instanceof Node &&
        !ref.current.contains(event.target)
      ) {
        onClose();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [onClose, ref]);
  return (
    <div
      aria-label={label}
      className="menu"
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
    >
      {children}
    </div>
  );
}
