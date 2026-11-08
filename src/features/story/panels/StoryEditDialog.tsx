import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { assetUrl } from "../../../api/assets";
import type { Point } from "../../../shared/domain";
import type { StoryDocument } from "../../../shared/domain/types";
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
} from "../../editor/canvas/repaint";
import {
  effectiveDefaultId,
  modelOptionsFor,
  protocolFeatures,
  useModelStore,
} from "../../settings/modelStore";
import { editSource, planPictureEdit, type EditPlace } from "../jobs/editPlan";
import { filePictureFromComputer } from "../panels/elementPictures";
import { useStoryJobStore } from "../stores/storyJobStore";
import { storyAskModel } from "../stores/storyModels";

const START_RADIUS = 24;
const START_SOFTNESS = 40;

/** The model a place is edited with, before the reader says otherwise. */
function defaultEditModel(
  place: EditPlace,
  view: ReturnType<typeof useModelStore.getState>["view"],
): string | null {
  if (place.kind === "element") {
    const own = (place.element.imageModel ?? "").trim();
    if (own !== "") return own;
  }
  const asked = storyAskModel(
    place.kind === "element" ? "elementArt" : "keyframeArt",
  );
  if (asked !== null) return asked;
  return view === null ? null : (effectiveDefaultId(view, "image") ?? null);
}

/**
 * One picture changed, rather than drawn again.
 *
 * The kept picture is handed back to the model with what should change: the
 * whole of it by an instruction, or a marked region by an instruction too. The
 * result is kept as another take of the same place, so nothing is overwritten
 * and the board reads the newest — and the old drawing is a version away if
 * the edit went the wrong way.
 *
 * Only models that say they take a picture as input are offered. A model that
 * quietly ignores the picture would answer with a redraw, which is a different
 * thing from an edit and must not be passed off as one.
 */
export function StoryEditDialog({
  story,
  place,
  onClose,
}: {
  story: StoryDocument;
  place: EditPlace;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const view = useModelStore((state) => state.view);
  const protocols = useModelStore((state) => state.protocols);
  const loadProtocols = useModelStore((state) => state.loadProtocols);
  const source = editSource(place);
  const label =
    place.kind === "element" ? place.element.name : t("story:storyboard.frame");
  const [model, setModel] = useState<string | null>(() =>
    defaultEditModel(place, view),
  );
  const [mode, setMode] = useState<"whole" | "mask">("whole");
  const [words, setWords] = useState("");
  const [size, setSize] = useState<Size | null>(null);
  const [unread, setUnread] = useState(false);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [draft, setDraft] = useState<Mark | null>(null);
  const [tool, setTool] = useState<MarkTool>("brush");
  const [radius, setRadius] = useState(START_RADIUS);
  const [softness, setSoftness] = useState(START_SOFTNESS);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const surface = useRef<HTMLCanvasElement | null>(null);
  const open = useRef<Mark | null>(null);
  open.current = draft;

  useEffect(() => {
    void loadProtocols();
  }, [loadProtocols]);

  const chosen = view?.models.find((each) => each.id === model);
  const features =
    chosen === undefined ? {} : protocolFeatures(protocols, chosen.protocol);
  const loading = protocols === null;
  const canInput = features.imageInput === true;
  const canMask = canInput && features.mask === true;
  const painting = mode === "mask" && canMask;
  // One picture, fitted into the dialog; the mask is written at the picture's
  // own size so that what is filed is the shape of the thing it covers.
  const shown = useMemo(
    () => (draft === null ? marks : [...marks, draft]),
    [draft, marks],
  );
  useEffect(() => {
    const sheet = surface.current;
    const context = sheet?.getContext("2d") ?? null;
    if (!sheet || !context || !size || !painting) return;
    if (sheet.width !== size.width || sheet.height !== size.height) {
      sheet.width = size.width;
      sheet.height = size.height;
    }
    context.clearRect(0, 0, size.width, size.height);
    drawMarks(context, shown);
  }, [shown, size, painting]);

  const closeOutline = () => {
    const outline = open.current;
    if (!outline || outline.tool !== "outline" || outline.points.length < 3) {
      return;
    }
    setMarks((state) => [...state, { ...outline, closed: true }]);
    setDraft(null);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    if (!draft || draft.tool === "outline") return;
    const at = pointOf(event);
    if (!at) return;
    setDraft((state) => {
      if (!state || state.tool === "outline") return state;
      const points = [...state.points];
      if (state.tool === "box") {
        points[1] = at;
      } else {
        const last = points[points.length - 1];
        if (Math.abs(last.x - at.x) < 1 && Math.abs(last.y - at.y) < 1) {
          return state;
        }
        points.push(at);
      }
      return { ...state, points };
    });
  };

  const letGo = () => {
    if (!draft || draft.tool === "outline") return;
    if (drawn(draft)) setMarks((state) => [...state, draft]);
    setDraft(null);
  };

  const marked = marks.some(drawn);
  const refusal = loading
    ? t("story:edit.loadingModels")
    : !canInput
      ? t("story:edit.noInput")
      : painting && !marked
        ? t("story:edit.maskPrompt")
        : words.trim() === ""
          ? t("story:edit.sayWhatChanges")
          : null;

  const submit = async () => {
    if (busy || refusal !== null || source === undefined) return;
    setBusy(true);
    setFailed(null);
    try {
      let maskAssetId: string | undefined;
      if (painting) {
        if (!size) return;
        const sheet = document.createElement("canvas");
        sheet.width = size.width;
        sheet.height = size.height;
        const context = sheet.getContext("2d");
        if (!context) {
          setFailed(t("editor:repaint.cannotDraw"));
          return;
        }
        traceMask(context, marks, size);
        if (
          !marksAnything(context.getImageData(0, 0, size.width, size.height))
        ) {
          setFailed(t("editor:repaint.nothingMarked"));
          return;
        }
        const blob = await new Promise<Blob | null>((resolve) =>
          sheet.toBlob(resolve, "image/png"),
        );
        if (!blob) {
          setFailed(t("editor:repaint.maskNotWritten"));
          return;
        }
        // The mask is the project's before the ask can name it.
        maskAssetId = await filePictureFromComputer(
          new File([blob], maskName("reference.png"), { type: "image/png" }),
        );
        if (maskAssetId === undefined) return;
      }
      const item = planPictureEdit(story, place, {
        instruction: words,
        ...(maskAssetId === undefined ? {} : { maskAssetId }),
      });
      if (item === undefined) {
        setFailed(t("story:edit.noSource"));
        return;
      }
      const record = await useStoryJobStore
        .getState()
        .start(
          story.id,
          item.target.kind as "elementArt" | "keyframeArt",
          [item],
          model,
        );
      if (record === null) {
        setFailed(useStoryJobStore.getState().error ?? t("story:edit.failed"));
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (source === undefined) {
    return createPortal(
      <div className="dialog-backdrop" role="presentation">
        <div className="dialog" role="dialog">
          <h2>{t("story:edit.title", { name: label })}</h2>
          <p className="dialog-error">{t("story:edit.noSource")}</p>
          <div className="dialog-actions">
            <button onClick={onClose} type="button">
              {t("story:panels.close")}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <form
        aria-labelledby="story-edit-title"
        aria-modal="true"
        className="dialog tool-dialog"
        data-testid="story-edit-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        role="dialog"
      >
        <h2 id="story-edit-title">{t("story:edit.title", { name: label })}</h2>
        <p className="dialog-note">{t("story:edit.note")}</p>

        <div className="story-edit-models">
          <label className="dialog-field">
            <span>{t("story:edit.model")}</span>
            <select
              data-testid="story-edit-model"
              onChange={(event) =>
                setModel(event.target.value === "" ? null : event.target.value)
              }
              value={model ?? ""}
            >
              <option value="">{t("story:edit.pickModel")}</option>
              {(view === null ? [] : modelOptionsFor(view, "image")).flatMap(
                (option) => {
                  const found = view?.models.find(
                    (each) => each.id === option.reference,
                  );
                  if (
                    found === undefined ||
                    protocolFeatures(protocols, found.protocol).imageInput !==
                      true
                  ) {
                    return [];
                  }
                  return [
                    <option key={option.reference} value={option.reference}>
                      {option.label}
                    </option>,
                  ];
                },
              )}
              {model !== null &&
                !modelOptionsFor(view, "image").some(
                  (option) => option.reference === model,
                ) && (
                  <option value={model}>
                    {t("story:edit.unsupportedModel", { model })}
                  </option>
                )}
            </select>
          </label>
          <span
            className={canInput ? "dialog-note" : "dialog-error"}
            data-testid="story-edit-capability"
          >
            {loading
              ? t("story:edit.loadingModels")
              : canInput
                ? t("story:edit.modelReady")
                : t("story:edit.noInput")}
          </span>
        </div>

        <div
          aria-label={t("story:edit.mode")}
          className="tool-choices"
          role="group"
        >
          <button
            aria-pressed={mode === "whole"}
            onClick={() => setMode("whole")}
            type="button"
          >
            {t("story:edit.modeWhole")}
          </button>
          <button
            aria-pressed={painting}
            disabled={!canMask}
            onClick={() => setMode("mask")}
            title={canMask ? undefined : t("story:edit.noMask")}
            type="button"
          >
            {t("story:edit.modeMask")}
          </button>
        </div>

        <div className="tool-stage">
          <div className="tool-frame">
            <img
              alt={label}
              onError={() => setUnread(true)}
              onLoad={(event) =>
                setSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              src={assetUrl(source)}
            />
            {painting && (
              <canvas
                aria-label={t("editor:repaint.regionAria")}
                className="repaint-sheet"
                onPointerCancel={letGo}
                onPointerDown={press}
                onPointerMove={drag}
                onPointerUp={letGo}
                ref={surface}
              />
            )}
          </div>
        </div>

        <p className="dialog-note">
          {unread
            ? t("editor:repaint.cannotShow")
            : size === null
              ? t("editor:repaint.reading")
              : t("story:edit.sourceSize", {
                  width: size.width.toLocaleString(),
                  height: size.height.toLocaleString(),
                })}
        </p>

        {painting && (
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
          </div>
        )}

        <label className="dialog-field">
          <span>{t("story:edit.instruction")}</span>
          <textarea
            data-testid="story-edit-instruction"
            onChange={(event) => setWords(event.target.value)}
            placeholder={t("story:edit.placeholder")}
            rows={3}
            value={words}
          />
        </label>

        {failed !== null && <p className="dialog-error">{failed}</p>}
        {refusal !== null && refusal !== t("story:edit.loadingModels") && (
          <p className="dialog-error">{refusal}</p>
        )}

        <div className="dialog-actions">
          <button disabled={busy} onClick={onClose} type="button">
            {t("editor:action.cancel")}
          </button>
          <button
            className="primary"
            disabled={busy || refusal !== null}
            title={refusal ?? undefined}
            type="submit"
          >
            {busy ? t("story:edit.filing") : t("story:edit.submit")}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
