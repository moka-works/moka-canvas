import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { TimelineDocument } from "../../../shared/domain";
import {
  approximateReason,
  previewCapabilities,
  type PreviewEngine,
} from "../preview/capabilities";
import { composeFrame, type FrameReport } from "../preview/compositor";
import { frameEngine, previewFrames } from "../preview/frames";
import { useClipStore, type PreviewQuality } from "../stores/clipStore";
import { formatTimecode } from "../timeline/timecode";
import { ClipTransport } from "./ClipTransport";

interface PreviewStageProps {
  timeline: TimelineDocument | null;
}

/**
 * The widest backing store each quality tier composes into.
 *
 * A 4K cut is judged through a pane a fraction of its size, so the picture is
 * drawn at the size it is looked at rather than the size it is cut at: Full is
 * the working resolution, Half and Quarter are for a machine that would rather
 * keep up than keep sharp. Nothing here reaches the export — what leaves is
 * always full size.
 */
const QUALITY_BACKING_WIDTH: Record<PreviewQuality, number> = {
  full: 1920,
  half: 960,
  quarter: 480,
};

/**
 * A value that is published to React only when it is news.
 *
 * A composition happens on every frame the playhead moves, and most of what
 * one reports — the engine, the moment drawn, whether a loading place was
 * drawn — is the same as the composition before: publishing it again would put
 * the room through a render for nothing. What a composition said is written on
 * the stage itself, so React only hears about the parts the markup is drawn
 * from.
 */
function usePublished<T>(initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState(initial);
  const kept = useRef(initial);
  const publish = useCallback((next: T) => {
    if (Object.is(kept.current, next)) return;
    kept.current = next;
    setValue(next);
  }, []);
  return [value, publish];
}

/**
 * The clock over the picture.
 *
 * A component of its own so that the moment moving repaints this line and
 * nothing else: the stage it sits over is the canvas's business, and a
 * timecode that re-rendered the pane around it would be the very coupling the
 * composition loop is kept out of.
 */
function PreviewTimecode({ fps }: { fps: number }) {
  const playheadMs = useClipStore((state) => state.playheadMs);
  return (
    <span className="clip-preview-time" data-testid="preview-timecode">
      {formatTimecode(playheadMs, fps)}
    </span>
  );
}

/**
 * The picture the cut is being judged against, and the transport under it.
 *
 * The frame under the playhead, composed from the document: the background,
 * each track's picture in order, the words on top. Composition is scheduled on
 * the animation frame so a drag across the ruler asks once a frame rather than
 * once a pointer event, and every composition carries a generation — a frame
 * the reader has already moved past is dropped rather than painted over a
 * newer one. What the frame is made with, and what about it is only an
 * approximation, is written on the stage itself: a degradation is shown, never
 * silently wrong.
 *
 * The transport row lives inside the pane rather than beside it, so going
 * fullscreen takes the controls with the picture and the same button brings
 * the reader back.
 */
export function PreviewStage({ timeline }: PreviewStageProps) {
  const { t } = useTranslation();
  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const sources = previewFrames();
  const capabilities = previewCapabilities();
  const quality = useClipStore((state) => state.quality);
  // A grade being dragged reaches the frame through the composition rather
  // than through the document, which is what makes the picture answer the
  // slider before any command has been sent.
  const adjustDraft = useClipStore((state) => state.adjustDraft);
  // Words being edited reach it the same way, through the same kind of draft.
  const textDraft = useClipStore((state) => state.textDraft);
  const [note, publishNote] = usePublished<string | null>(null);
  const fps = timeline?.settings.fps ?? 30;

  /**
   * What the last composition was made with, written on the stage itself.
   *
   * These are readings of a composition — which engine drew the frame, which
   * moment it shows, whether a loading place was drawn — and nothing in the
   * markup is drawn from them. Writing them through React would put the room
   * through a render for every frame the playhead moves; written here, a
   * composition costs the canvas and nothing else. The one thing React is told
   * is the badge: what the picture is an approximation of is worth a render.
   */
  const writeReadings = useCallback(
    (drawn: PreviewEngine, report: FrameReport, atMs: number): void => {
      const stage = sectionRef.current;
      if (!stage) return;
      stage.dataset.engine = drawn;
      stage.dataset.frameMs = String(atMs);
      if (report.materialMs === null) delete stage.dataset.frameMaterialMs;
      else stage.dataset.frameMaterialMs = String(report.materialMs);
      stage.dataset.pictureState = report.waiting
        ? "waiting"
        : report.materialMs !== null
          ? "picture"
          : "empty";
    },
    [],
  );

  const paint = useCallback(async () => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!timeline || !canvas || !frame) return;
    const cssWidth = frame.clientWidth;
    const cssHeight = frame.clientHeight;
    // A pane with no room in it — a folded column, a hidden stage — has nothing
    // to draw into, and a canvas of no pixels is not a picture.
    if (cssWidth <= 0 || cssHeight <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // The canvas's own pixels: the drawing works in them and the element is
    // scaled to fit by the browser, so what is composed is what is looked at.
    const dpr = window.devicePixelRatio || 1;
    const backingWidth = Math.min(
      QUALITY_BACKING_WIDTH[quality],
      Math.max(1, Math.round(cssWidth * dpr)),
    );
    const backingHeight = Math.max(
      1,
      Math.round(
        backingWidth * (timeline.settings.height / timeline.settings.width),
      ),
    );
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const generation = (generationRef.current += 1);
    const atMs = useClipStore.getState().playheadMs;
    let report: FrameReport | null = null;
    try {
      report = await composeFrame(ctx, {
        width: backingWidth,
        height: backingHeight,
        timeline,
        atMs,
        sources,
        filter: capabilities.filter,
        adjustDraft,
        textDraft,
        isCurrent: () => generation === generationRef.current,
      });
    } catch {
      // A frame that cannot be composed leaves the one already on the canvas
      // standing: a preview that stopped drawing is worse than a stale one.
      return;
    }
    if (!report) return;
    const drawn = frameEngine(report.clips, (assetId) =>
      sources.engineOf(assetId),
    );
    writeReadings(drawn, report, atMs);
    publishNote(approximateReason(capabilities, drawn, report.coloursSkipped));
  }, [
    timeline,
    sources,
    capabilities,
    quality,
    adjustDraft,
    textDraft,
    writeReadings,
    publishNote,
  ]);

  const schedule = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      void paint();
    });
  }, [paint]);

  // The playhead is what the frame answers to; the document reaches the stage
  // through the timeline it is handed, and a picture arriving late through the
  // sources' own signal.
  useEffect(
    () =>
      useClipStore.subscribe((state, previous) => {
        if (state.playheadMs !== previous.playheadMs) schedule();
      }),
    [schedule],
  );

  useEffect(() => sources.onArrive(schedule), [sources, schedule]);

  useEffect(() => {
    schedule();
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [schedule]);

  // The frame is the timeline's shape, as large as the pane leaves it: the
  // letterbox is the pane's letterbox, and what is drawn inside is the
  // composition itself. A room with no timeline yet keeps the shape a cut
  // would have rather than a box of no size.
  const layout = useCallback(() => {
    const stage = stageRef.current;
    const frame = frameRef.current;
    if (!stage || !frame) return;
    const boxWidth = stage.clientWidth;
    const boxHeight = stage.clientHeight;
    if (boxWidth <= 0 || boxHeight <= 0) return;
    const aspect =
      (timeline?.settings.width ?? 16) / (timeline?.settings.height ?? 9);
    const width = Math.min(boxWidth, boxHeight * aspect);
    frame.style.width = `${Math.floor(width)}px`;
    frame.style.height = `${Math.floor(width / aspect)}px`;
    schedule();
  }, [timeline, schedule]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(layout);
    observer.observe(stage);
    layout();
    return () => observer.disconnect();
  }, [layout]);

  return (
    <section
      aria-label={t("clip:preview.label")}
      className="clip-preview"
      data-quality={quality}
      ref={sectionRef}
    >
      <div className="clip-preview-stage" ref={stageRef}>
        <div className="clip-preview-frame" ref={frameRef}>
          {timeline === null ? (
            <p className="clip-preview-empty">{t("clip:preview.empty")}</p>
          ) : (
            <>
              <canvas className="clip-preview-canvas" ref={canvasRef} />
              <PreviewTimecode fps={fps} />
              {note !== null && (
                <span className="clip-preview-badge" title={note}>
                  {t("clip:preview.approximateBadge")}
                </span>
              )}
            </>
          )}
        </div>
      </div>
      {timeline !== null && <ClipTransport timeline={timeline} />}
    </section>
  );
}
