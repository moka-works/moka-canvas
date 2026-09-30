import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LOW_DETAIL_ZOOM, type WorkflowNode } from "../../../shared/domain";
import { worldToClient } from "../canvas/canvasControl";
import {
  buildIssueIndex,
  buildResourceIndex,
  mediaInfoForNode,
  type MediaCardInfo,
} from "../canvas/mediaCards";
import { NODE_HEADER_HEIGHT } from "../canvas/theme";
import { useEditorStore, type ActiveGesture } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";

/** How far the face is set in from the card, matching the drawn media box. */
const MEDIA_INSET = 8;
const MEDIA_TOP = NODE_HEADER_HEIGHT + MEDIA_INSET;

/**
 * The mark on the play button: a solid triangle, drawn rather than typed.
 *
 * A font's own ▶ brings its bearings with it — small, and leaning off the
 * centre of whatever box holds it. Drawn, the triangle fills a known part of
 * the button, and steps a touch right, which is where a pointing shape reads
 * as still.
 */
function PlayMark() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="30"
      viewBox="0 0 24 24"
      width="30"
    >
      <path d="M8.4 5.4v13.2l10.8-6.6z" />
    </svg>
  );
}

/**
 * Where the face goes while the card under it is being dragged: the position
 * the gesture started from plus how far it has come, which is where the drawn
 * card is a frame ahead of the document.
 */
function liveBounds(node: WorkflowNode, gesture: ActiveGesture) {
  if (gesture.kind !== "draggingNodes") return node.bounds;
  if (!gesture.nodeIds.includes(node.id)) return node.bounds;
  const start = gesture.startPositions[node.id];
  if (!start) return node.bounds;
  return {
    ...node.bounds,
    x: start.x + gesture.currentDelta.x,
    y: start.y + gesture.currentDelta.y,
  };
}

/**
 * One video seen where it stands: the file's own first frame — which a
 * `<video>` shows as soon as it has read the header — with a play button over
 * it. Pressing it hands the face to the file itself, controls and all.
 *
 * Only the button and a playing file take the pointer; the rest lets a press
 * through to the canvas, so the card underneath is still dragged, selected,
 * and wired by its picture.
 */
function VideoFace({
  media,
  name,
  style,
}: {
  media: MediaCardInfo;
  name: string;
  style: React.CSSProperties;
}) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const face = useRef<HTMLVideoElement>(null);
  return (
    <div
      className={playing ? "video-card is-playing" : "video-card"}
      data-testid="video-card-face"
      style={style}
    >
      <video
        controls={playing}
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        playsInline
        preload="metadata"
        ref={face}
        src={media.playable}
      />
      {!playing && (
        <button
          aria-label={t("editor:canvas.playVideo", { name })}
          className="video-card-play"
          onClick={() => void face.current?.play()}
          type="button"
        >
          <PlayMark />
        </button>
      )}
      {media.label && <span className="video-card-label">{media.label}</span>}
    </div>
  );
}

/**
 * Every video on the canvas, seen where it stands.
 *
 * A card drawn on a canvas cannot play anything, so the face of a video node is
 * put over it in the DOM. The drawn card keeps everything else about the node —
 * its frame, its name, its run — and hands this one part away.
 */
export function VideoCardOverlays() {
  const camera = useEditorStore((state) => state.camera);
  const gesture = useEditorStore((state) => state.gesture);
  const moka = useProjectStore((state) => state.moka);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  const selfCheck = useProjectStore((state) => state.selfCheck);

  // Built once per document rather than once per render: a project may hold
  // thousands of assets and every video asks after its own.
  const indexes = useMemo(
    () =>
      moka
        ? {
            assets: buildResourceIndex(moka),
            issues: buildIssueIndex(selfCheck),
          }
        : null,
    [moka, selfCheck],
  );

  const canvas =
    moka?.canvas.find((entry) => entry.id === activeCanvasId) ??
    moka?.canvas[0] ??
    null;
  if (!canvas || !indexes) return null;
  // The card hides its media past this zoom, and a face where the card shows
  // nothing would be the one thing left standing.
  const zoom = camera?.zoom ?? canvas.viewport.zoom ?? 1;
  if (zoom < LOW_DETAIL_ZOOM) return null;

  const faces: { node: WorkflowNode; media: MediaCardInfo }[] = [];
  for (const node of canvas.nodes) {
    if (node.kind !== "video") continue;
    const media = mediaInfoForNode(node, indexes.assets, indexes.issues);
    if (media?.state !== "ready" || !media.playable) continue;
    faces.push({ node, media });
  }
  if (faces.length === 0) return null;

  return (
    <>
      {faces.map(({ node, media }) => {
        const bounds = liveBounds(node, gesture);
        const origin = worldToClient({ x: bounds.x, y: bounds.y }) ?? {
          x: 0,
          y: 0,
        };
        const style: React.CSSProperties = {
          left: origin.x + MEDIA_INSET * zoom,
          top: origin.y + MEDIA_TOP * zoom,
          width: Math.max(0, (bounds.width - MEDIA_INSET * 2) * zoom),
          height: Math.max(
            0,
            (bounds.height - NODE_HEADER_HEIGHT - MEDIA_INSET * 2) * zoom,
          ),
        };
        return (
          <VideoFace
            key={`${node.id}:${media.playable}`}
            media={media}
            name={node.title}
            style={style}
          />
        );
      })}
    </>
  );
}
