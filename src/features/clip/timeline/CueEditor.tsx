import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TimelineDocument } from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { patchCommands } from "../inspector/clipFieldMath";
import { clampTextContent } from "../interactions/textActions";
import { useClipStore, type CueEditorSession } from "../stores/clipStore";
import { trackRows } from "./geometry";

/**
 * The words being rewritten where they stand on the timeline.
 *
 * A small textarea laid exactly over the cue's own block: the block is what
 * the editor is a view of, so its rectangle is the editor's, measured in the
 * canvas's own content coordinates — the same ones the spacer and the drawn
 * rows are measured in — and the scrolling that moves the block moves the
 * editor with it, with no following of its own.
 *
 * The words are the session's while it stands: every keystroke goes to the
 * store as a text draft, which the preview composites in place of the
 * document's own words, and a command is sent once, at the commit point —
 * Enter, or the blur that a click anywhere else is. Escape lets the session
 * go without a command, and a cue that was taken off the cut, or whose words
 * changed from under the session, closes it the same way rather than
 * overwriting what happened.
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
  const clip = timeline.clips.find(
    (candidate) => candidate.id === session.clipId,
  );
  const [words, setWords] = useState(session.seed);
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
  useEffect(() => {
    if (settled.current) return;
    if (!clip || clip.kind !== "text" || !clip.text) close();
    else if (clip.text.content !== session.seed) close();
  }, [clip, session.seed]);

  /** A keystroke: the words are the session's and the preview's, not the cut's. */
  const type = (next: string) => {
    setWords(next);
    const style = clip?.text?.style;
    if (!style) return;
    useClipStore.getState().setTextDraft({
      clipIds: [session.clipId],
      text: { content: clampTextContent(next), style },
    });
  };

  if (!clip || clip.kind !== "text" || !clip.text) return null;
  const row = trackRows(timeline).find(
    (candidate) => candidate.track.id === clip.trackId,
  );
  if (!row) return null;
  return (
    <div
      className="clip-tl-cue"
      style={{
        left: (clip.startMs / 1_000) * pxPerSec,
        top: row.top,
        width: (clip.durationMs / 1_000) * pxPerSec,
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
