import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TimelineDocument } from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { patchCommands } from "../inspector/clipFieldMath";
import { addTextClipAt, clampTextContent } from "../interactions/textActions";
import { useClipStore, type CueEditorSession } from "../stores/clipStore";
import { trackRows } from "./geometry";

/**
 * The words being written where they stand on the timeline.
 *
 * A small textarea laid exactly over the cue's own block — the block a cue the
 * document holds already is, or the window a new cue would take: the editor is
 * a view of the rectangle, so it is measured in the canvas's own content
 * coordinates, the same ones the spacer and the drawn rows are measured in,
 * and the scrolling that moves the block moves the editor with it, with no
 * following of its own.
 *
 * The words are the session's while it stands: for a cue already on the cut
 * every keystroke goes to the store as a text draft, which the preview
 * composites in place of the document's own words, and a command is sent once,
 * at the commit point — Enter, or the blur that a click anywhere else is. A
 * session for a cue not written yet has nothing to preview and lands through
 * its own single command at the same point. Escape lets the session go without
 * a command; a cue that was taken off the cut, or whose words changed from
 * under the session, closes it the same way rather than overwriting what
 * happened.
 */
export function CueEditor({
  timeline,
  session,
}: {
  timeline: TimelineDocument;
  session: CueEditorSession;
}) {
  const { t } = useTranslation();
  const pxPerSec = useClipStore((state) => state.view.pxPerSec);
  const clip =
    session.kind === "clip"
      ? timeline.clips.find((candidate) => candidate.id === session.clipId)
      : undefined;
  const trackId = session.kind === "clip" ? clip?.trackId : session.trackId;
  const [words, setWords] = useState(
    session.kind === "clip" ? session.seed : "",
  );
  // One gesture leaves one command: a blur and an Enter are both endings of
  // the same session, and whichever comes second finds it already gone.
  const settled = useRef(false);

  const close = () => {
    settled.current = true;
    useClipStore.getState().setCueEditor(null);
  };

  /** Writes what has been typed, when it is a change, and lets the session go. */
  const commit = () => {
    if (settled.current) return;
    if (session.kind === "new") {
      // Empty words are a cue nobody wrote: the command is not sent at all.
      addTextClipAt(
        session.trackId,
        session.startMs,
        session.durationMs,
        session.style,
        words,
      );
      close();
      return;
    }
    const text = clip?.kind === "text" ? clip.text : undefined;
    if (clip && text) {
      const content = clampTextContent(words);
      // Measured against the document, never against the draft: a draft is
      // different by definition, and reading it as written would leave the
      // words in the store and out of the cut.
      if (content !== text.content) {
        execute(
          t("clip:history.editTextClip"),
          patchCommands(timeline.id, [
            {
              clipId: clip.id,
              patch: { text: { content, style: text.style } },
            },
          ]),
        );
      }
    }
    close();
  };

  // A cue taken off the cut, or one whose words have drifted from the seed,
  // was changed from under the session; it closes without writing anything.
  // A session for a cue not written yet closes when its row goes away, since
  // the window it was drawn in no longer exists.
  useEffect(() => {
    if (settled.current) return;
    if (session.kind === "new") {
      const track = timeline.tracks.find((row) => row.id === session.trackId);
      if (!track || track.kind !== "text") close();
      return;
    }
    if (!clip || clip.kind !== "text" || !clip.text) close();
    else if (clip.text.content !== session.seed) close();
  }, [clip, session, timeline.tracks]);

  /** A keystroke: the words are the session's and the preview's, not the cut's. */
  const type = (next: string) => {
    setWords(next);
    if (session.kind !== "clip") return;
    const style = clip?.text?.style;
    if (!style) return;
    useClipStore.getState().setTextDraft({
      clipIds: [session.clipId],
      text: { content: clampTextContent(next), style },
    });
  };

  const startMs = session.kind === "clip" ? clip?.startMs : session.startMs;
  const durationMs =
    session.kind === "clip" ? clip?.durationMs : session.durationMs;
  const row = trackRows(timeline).find(
    (candidate) => candidate.track.id === trackId,
  );
  if (session.kind === "clip" && (!clip || clip.kind !== "text" || !clip.text))
    return null;
  if (startMs === undefined || durationMs === undefined || !row) return null;
  return (
    <div
      className="clip-tl-cue"
      style={{
        left: (startMs / 1_000) * pxPerSec,
        top: row.top,
        width: (durationMs / 1_000) * pxPerSec,
        height: row.height - 1,
      }}
    >
      <textarea
        aria-label={t("clip:cues.editor")}
        autoFocus
        className="clip-tl-cue-input"
        onBlur={commit}
        onChange={(event) => type(event.target.value)}
        // The caret starts at the end: a cue is usually being corrected, and
        // replacing the whole line should never be one keystroke away.
        onFocus={(event) => {
          const caret = event.target.value.length;
          event.target.setSelectionRange(caret, caret);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            commit();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        placeholder={t("clip:cues.placeholder")}
        value={words}
      />
    </div>
  );
}
