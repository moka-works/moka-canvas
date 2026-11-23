import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { assetUrl } from "../../../api";
import type { GenerationSpec, MokaFile, Point } from "../../../shared/domain";
import { buildResourceIndex } from "../canvas/mediaCards";
import {
  BRUSH_NARROWEST,
  BRUSH_WIDEST,
  closesOutline,
  drawMarks,
  drawn,
  MARK_HINTS,
  MARK_LABELS,
  MARK_TOOLS,
  maskName,
  marksAnything,
  newMark,
  traceMask,
  type Mark,
  type MarkTool,
  type Size,
} from "../canvas/repaint";
import { useModelStore } from "../../settings/modelStore";
import { imageNodeTakesMask } from "../modelCapabilities";
import { fileRepaint } from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import { TOOL_LABELS } from "../stores/toolPrefs";

/** How wide a brush starts, and how soft, before anybody has said otherwise. */
const START_RADIUS = 24;
const START_SOFTNESS = 40;

/** What a node asks a model for, if it asks for anything. */
function askOf(moka: MokaFile | null, nodeId: string): GenerationSpec | null {
  const node = moka?.canvas
    .flatMap((entry) => entry.nodes)
    .find((entry) => entry.id === nodeId);
  return (
    (node?.data as { generation?: GenerationSpec } | undefined)?.generation ??
    null
  );
}

/** The node a repaint is being filed for, wherever on the document it sits. */
function nodeOf(moka: MokaFile | null, nodeId: string) {
  return moka?.canvas
    .flatMap((entry) => entry.nodes)
    .find((entry) => entry.id === nodeId);
}

/**
 * Marks the part of a picture that may change, and files the marking beside it.
 *
 * Painting happens over the picture itself rather than in a field of numbers,
 * because a region worth repainting is a shape somebody can see and not one they
 * can describe in four integers. The marking is kept as the points it went
 * through, so taking one back is dropping it and drawing the rest again — a
 * picture can be tens of millions of pixels, and a copy of it per stroke would
 * cost more than the strokes do.
 *
 * What it makes is the two halves of an ask rather than a repainted picture: the
 * mask becomes a node wired into the picture's mask port, and the words go into
 * the picture's own ask, which is then one press from being run. Nothing is spent
 * from here, and a reader who wants different words wants a field and not a new
 * painting.
 */
export function RepaintDialog() {
  const { t } = useTranslation();
  const asked = useEditorStore((state) => state.pictureTool);
  const moka = useProjectStore((state) => state.moka);
  const view = useModelStore((state) => state.view);
  const protocols = useModelStore((state) => state.protocols);
  const loadProtocols = useModelStore((state) => state.loadProtocols);
  const surface = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [draft, setDraft] = useState<Mark | null>(null);
  const [tool, setTool] = useState<MarkTool>("brush");
  const [radius, setRadius] = useState(START_RADIUS);
  const [softness, setSoftness] = useState(START_SOFTNESS);
  const [words, setWords] = useState("");
  const [unread, setUnread] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const painting = asked?.tool === "repaint" ? asked : null;
  const key = painting ? `${painting.nodeId}:${painting.assetId}` : null;
  const visible = useMemo(
    () => (draft ? [...marks, draft] : marks),
    [marks, draft],
  );
  // Read through a ref so the key that closes an outline can see the outline as
  // it stands, without the listener being taken down and put up at every point
  // a drag adds.
  const open = useRef<Mark | null>(null);
  open.current = draft;

  // What a protocol takes a mask as is declared in its own model.json, so the
  // registry is read before the note below is drawn. A read already held is
  // reused; one that failed leaves the cautious note in place, which is what
  // an unknown protocol deserves.
  useEffect(() => {
    void loadProtocols();
  }, [loadProtocols]);

  useEffect(() => {
    if (!painting) return;
    setSize(null);
    setMarks([]);
    setDraft(null);
    setUnread(false);
    setFailed(null);
    setBusy(false);
    // What a picture is already asked for is offered as the words to start from:
    // a repaint is usually that same ask with a region held back.
    setWords(askOf(moka, painting.nodeId)?.prompt ?? "");
    // The key is the ask: what was painted belongs to the picture this dialog
    // came up for, and not to the one before it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Draws the marking over the picture, at the picture's own size: the sheet is
  // the mask that gets filed, so its pixels are the picture's pixels and only
  // what is on screen is fitted down.
  useEffect(() => {
    const sheet = surface.current;
    const context = sheet?.getContext("2d") ?? null;
    if (!sheet || !context || !size) return;
    if (sheet.width !== size.width || sheet.height !== size.height) {
      sheet.width = size.width;
      sheet.height = size.height;
    }
    context.clearRect(0, 0, size.width, size.height);
    drawMarks(context, visible);
  }, [visible, size]);

  function closeOutline() {
    const outline = open.current;
    if (!outline || outline.tool !== "outline" || outline.points.length < 3) {
      return;
    }
    setMarks((state) => [...state, { ...outline, closed: true }]);
    setDraft(null);
  }

  // Escape closes the dialog, unless an outline is still being clicked round, in
  // which case it lets go of that instead: one key, and the nearer thing first.
  // Enter finishes an outline, which is the other way of saying "that shape".
  useEffect(() => {
    if (!painting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const outline = open.current?.tool === "outline";
      if (event.key === "Enter" && outline) {
        event.preventDefault();
        closeOutline();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (outline) {
        setDraft(null);
        return;
      }
      useEditorStore.getState().closePictureTool();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!painting) return null;
  const entry = moka
    ? buildResourceIndex(moka).get(painting.assetId)
    : undefined;
  if (!entry) return null;

  const close = () => useEditorStore.getState().closePictureTool();
  // Whether the model this will be asked through can take a mask at all. The
  // port is not offered for one that cannot, so a marking filed here would be
  // an edge to a port the card does not show; the dialog says so instead of
  // letting the reader paint something that cannot be used.
  const reference =
    askOf(moka, painting.nodeId)?.model || view?.defaults.image || null;
  const protocol =
    (reference !== null
      ? view?.models.find((model) => model.id === reference)?.protocol
      : null) ?? null;
  const node = nodeOf(moka, painting.nodeId);
  const takesMask =
    node !== undefined && imageNodeTakesMask(node, view, protocols);
  const blocked =
    takesMask === true
      ? null
      : protocol === null
        ? t("editor:repaint.noModel")
        : t("editor:repaint.noMaskField");
  const marked = marks.some(drawn);
  const refusal = unread
    ? t("editor:repaint.unreadable")
    : size === null
      ? t("editor:repaint.reading")
      : !marked
        ? t("editor:repaint.markPrompt")
        : words.trim() === ""
          ? t("editor:repaint.sayWhatItBecomes")
          : null;

  /**
   * Where the pointer is, in the picture's own pixels.
   *
   * What is on screen is the picture fitted into the dialog, so the two are not
   * the same numbers, and the mask that gets filed has to be the size of the
   * picture rather than of the space it happened to be shown in.
   */
  const pointOf = (
    event: React.PointerEvent<HTMLCanvasElement>,
  ): Point | null => {
    if (!size) return null;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    return {
      x: ((event.clientX - box.left) / box.width) * size.width,
      y: ((event.clientY - box.top) / box.height) * size.height,
    };
  };

  const press = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (blocked !== null) return;
    const at = pointOf(event);
    if (!at) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (draft?.tool === "outline") {
      if (closesOutline(draft, at)) closeOutline();
      else setDraft({ ...draft, points: [...draft.points, at] });
      return;
    }
    setDraft({
      ...newMark(tool, radius, softness),
      points: tool === "box" ? [at, at] : [at],
    });
  };

  const drag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (blocked !== null) return;
    if (!draft || draft.tool === "outline") return;
    const at = pointOf(event);
    if (!at) return;
    setDraft((state) => {
      if (!state || state.tool === "outline") return state;
      const points = [...state.points];
      if (state.tool === "box") {
        // A box holds its two corners, and the second one follows the pointer.
        points[1] = at;
      } else {
        const last = points[points.length - 1];
        // A brush holds the whole way it went, so a curve stays a curve rather
        // than a straight line between presses — but a pointer that has not
        // moved has nothing to add.
        if (Math.abs(last.x - at.x) < 1 && Math.abs(last.y - at.y) < 1) {
          return state;
        }
        points.push(at);
      }
      return { ...state, points };
    });
  };

  const letGo = () => {
    if (blocked !== null) return;
    if (!draft || draft.tool === "outline") return;
    if (drawn(draft)) setMarks((state) => [...state, draft]);
    setDraft(null);
  };

  const submit = async () => {
    if (busy || refusal || blocked !== null || !size) return;
    setBusy(true);
    setFailed(null);
    try {
      const sheet = document.createElement("canvas");
      sheet.width = size.width;
      sheet.height = size.height;
      const context = sheet.getContext("2d");
      if (!context) {
        setFailed(t("editor:repaint.cannotDraw"));
        return;
      }
      traceMask(context, marks, size);
      // Asked of the pixels rather than of the list: a region painted and then
      // erased all over leaves something in the list and nothing in the picture,
      // and an all-black mask would ask for the whole picture to be repainted.
      if (!marksAnything(context.getImageData(0, 0, size.width, size.height))) {
        setFailed(t("editor:repaint.nothingMarked"));
        return;
      }
      const mask = await new Promise<Blob | null>((done) =>
        sheet.toBlob(done, "image/png"),
      );
      if (!mask) {
        setFailed(t("editor:repaint.maskNotWritten"));
        return;
      }
      const filed = await fileRepaint({
        nodeId: painting.nodeId,
        assetId: painting.assetId,
        sourceName: entry.name,
        mask,
        prompt: words.trim(),
      });
      if (filed) close();
    } finally {
      setBusy(false);
    }
  };

  /** What the note under the picture says about the model's mask field. */
  const takesMaskNotice = blocked ?? t("editor:repaint.hasMaskField");

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <form
        aria-labelledby="repaint-title"
        aria-modal="true"
        className="dialog tool-dialog"
        data-testid="repaint-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        role="dialog"
      >
        <h2 id="repaint-title">
          {t(TOOL_LABELS.repaint)} — {entry.name}
        </h2>
        <p className="dialog-note">{t("editor:repaint.note")}</p>

        <div className="tool-stage">
          <div className="tool-frame">
            <img
              alt=""
              onError={() => setUnread(true)}
              onLoad={(event) =>
                setSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              src={assetUrl(painting.assetId)}
            />
            <canvas
              aria-label={t("editor:repaint.regionAria")}
              className="repaint-sheet"
              onPointerCancel={letGo}
              onPointerDown={press}
              onPointerMove={drag}
              onPointerUp={letGo}
              ref={surface}
            />
          </div>
        </div>

        <p className="dialog-note">
          {unread
            ? t("editor:repaint.cannotShow")
            : size
              ? t("editor:repaint.maskSize", {
                  width: size.width.toLocaleString(),
                  height: size.height.toLocaleString(),
                  name: maskName(entry.name),
                })
              : t("editor:repaint.reading")}
        </p>

        <div className="tool-params">
          <div
            aria-label={t("editor:repaint.howMarked")}
            className="tool-choices"
            role="group"
          >
            {MARK_TOOLS.map((offered) => (
              <button
                aria-pressed={tool === offered}
                key={offered}
                onClick={() => setTool(offered)}
                title={t(MARK_HINTS[offered])}
                type="button"
              >
                {t(MARK_LABELS[offered])}
              </button>
            ))}
          </div>
          <p className="dialog-note">{t(MARK_HINTS[tool])}</p>
          <div className="settings-columns">
            <label className="dialog-field">
              <span>{t("editor:repaint.brush", { radius })}</span>
              <input
                aria-label={t("editor:field.brushWidth")}
                max={BRUSH_WIDEST}
                min={BRUSH_NARROWEST}
                onChange={(event) => setRadius(Number(event.target.value))}
                step={1}
                type="range"
                value={radius}
              />
            </label>
            <label className="dialog-field">
              <span>{t("editor:repaint.softEdge", { softness })}</span>
              <input
                aria-label={t("editor:field.softEdge")}
                max={100}
                min={0}
                onChange={(event) => setSoftness(Number(event.target.value))}
                step={1}
                type="range"
                value={softness}
              />
            </label>
          </div>
          <div
            aria-label={t("editor:repaint.takingBack")}
            className="tool-choices"
            role="group"
          >
            <button
              disabled={draft === null && marks.length === 0}
              onClick={() => {
                setDraft(null);
                setMarks((state) => state.slice(0, -1));
              }}
              type="button"
            >
              {t("editor:action.undoLastMark")}
            </button>
            <button
              disabled={draft === null && marks.length === 0}
              onClick={() => {
                setDraft(null);
                setMarks([]);
              }}
              type="button"
            >
              {t("editor:action.clearMarking")}
            </button>
          </div>
          <label className="dialog-field">
            <span>{t("editor:repaint.whatItBecomes")}</span>
            <textarea
              onChange={(event) => setWords(event.target.value)}
              placeholder={t("editor:repaint.becomesPlaceholder")}
              rows={3}
              value={words}
            />
          </label>
        </div>

        <p
          className={
            takesMask || protocol === null ? "dialog-note" : "dialog-error"
          }
        >
          {takesMaskNotice}
        </p>

        {failed && <p className="dialog-error">{failed}</p>}
        {refusal && <p className="dialog-error">{refusal}</p>}

        <div className="dialog-actions">
          <button disabled={busy} onClick={close} type="button">
            {t("editor:action.cancel")}
          </button>
          <button
            autoFocus
            className="primary"
            disabled={busy || refusal !== null || blocked !== null}
            title={blocked ?? refusal ?? undefined}
            type="submit"
          >
            {busy ? t("editor:repaint.filing") : t("editor:repaint.fileMask")}
          </button>
        </div>
      </form>
    </div>
  );
}
