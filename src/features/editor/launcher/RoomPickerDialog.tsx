import type { ComponentType } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CanvasIcon, ClipIcon, StoryIcon } from "../components/HomeMenu";
import { CanvasPreview, ClipPreview, StoryPreview } from "./RoomPreviews";

/** The rooms a new project can open onto. */
export type StartRoom = "story" | "canvas" | "clip";

const ROOM_PREVIEWS: Record<StartRoom, ComponentType> = {
  story: StoryPreview,
  canvas: CanvasPreview,
  clip: ClipPreview,
};

interface Option {
  room: StartRoom;
  icon: ComponentType<{ size?: number }>;
  name: string;
  kicker: string;
  line: string;
  enter: string;
  detail: string;
}

const OPTIONS: Option[] = [
  {
    room: "story",
    icon: StoryIcon,
    name: "app:roomPicker.rooms.story.name",
    kicker: "app:roomPicker.rooms.story.kicker",
    line: "app:roomPicker.rooms.story.line",
    enter: "app:roomPicker.rooms.story.enter",
    detail: "app:roomPicker.rooms.story.detail",
  },
  {
    room: "canvas",
    icon: CanvasIcon,
    name: "app:roomPicker.rooms.canvas.name",
    kicker: "app:roomPicker.rooms.canvas.kicker",
    line: "app:roomPicker.rooms.canvas.line",
    enter: "app:roomPicker.rooms.canvas.enter",
    detail: "app:roomPicker.rooms.canvas.detail",
  },
  {
    room: "clip",
    icon: ClipIcon,
    name: "app:roomPicker.rooms.clip.name",
    kicker: "app:roomPicker.rooms.clip.kicker",
    line: "app:roomPicker.rooms.clip.line",
    enter: "app:roomPicker.rooms.clip.enter",
    detail: "app:roomPicker.rooms.clip.detail",
  },
];

interface Props {
  projectName: string;
  onChoose: (room: StartRoom) => void;
  onDismiss: () => void;
}

/**
 * The question a new project asks before it opens: where to begin.
 *
 * Making a project and choosing where to start are two acts. The project is
 * already saved when this stands, so the choice costs nothing and can be
 * stepped out of; what it decides is only which room the reader lands in.
 * Each room's face keeps its one-line purpose, and the longer scene it fits
 * is read on hover or focus rather than spent on the dialog.
 */
export function RoomPickerDialog({ projectName, onChoose, onDismiss }: Props) {
  const { t } = useTranslation();
  const base = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<StartRoom | null>(null);

  // The dialog itself holds the first focus, not a card: a card under focus
  // would put its whole scene on the face before anything was asked for. The
  // first Tab reaches the story card, and its scene is read then.
  useEffect(() => {
    dialog.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  return (
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
      role="presentation"
    >
      <div
        aria-describedby={`${base}-subtitle`}
        aria-labelledby={`${base}-title`}
        aria-modal="true"
        className="dialog room-picker"
        data-testid="room-picker"
        onClick={(event) => event.stopPropagation()}
        ref={dialog}
        role="dialog"
        tabIndex={-1}
      >
        <header className="room-picker-head">
          <span className="room-picker-status">
            <svg
              aria-hidden="true"
              fill="none"
              height="14"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.6"
              viewBox="0 0 16 16"
              width="14"
            >
              <circle cx="8" cy="8" r="6.2" />
              <path d="m5.2 8.2 1.9 1.9 3.7-4" />
            </svg>
            {t("app:roomPicker.status")}
          </span>
          <h2 id={`${base}-title`}>{t("app:roomPicker.title")}</h2>
          <p className="room-picker-subtitle" id={`${base}-subtitle`}>
            {t("app:roomPicker.subtitle", { name: projectName })}
          </p>
        </header>

        <div className="room-picker-grid">
          {OPTIONS.map((option) => {
            const Icon = option.icon;
            const Preview = ROOM_PREVIEWS[option.room];
            return (
              <button
                aria-describedby={`${base}-${option.room}-detail`}
                aria-labelledby={`${base}-${option.room}-name`}
                className={`room-choice is-${option.room}`}
                data-testid={`room-choice-${option.room}`}
                key={option.room}
                onClick={() => onChoose(option.room)}
                onBlur={() =>
                  setActive((current) =>
                    current === option.room ? null : current,
                  )
                }
                onFocus={() => setActive(option.room)}
                onMouseEnter={() => setActive(option.room)}
                onMouseLeave={() =>
                  setActive((current) =>
                    current === option.room ? null : current,
                  )
                }
                type="button"
              >
                <Preview />
                <span className="room-choice-body">
                  <span className="room-choice-head">
                    <Icon size={16} />
                    <span
                      className="room-choice-title"
                      id={`${base}-${option.room}-name`}
                    >
                      {t(option.name)}
                    </span>
                    <span className="room-choice-kicker">
                      {t(option.kicker)}
                    </span>
                  </span>
                  <span className="room-choice-line">{t(option.line)}</span>
                  <span className="room-choice-cta">
                    {t(option.enter)}
                    <span aria-hidden="true" className="room-choice-arrow">
                      →
                    </span>
                  </span>
                </span>
                <span className="sr-only" id={`${base}-${option.room}-detail`}>
                  {t(option.detail)}
                </span>
              </button>
            );
          })}
        </div>

        <p
          aria-hidden="true"
          className={`room-picker-detail${active ? " is-showing" : ""}`}
          data-testid="room-picker-detail"
        >
          {active
            ? t(OPTIONS.find((option) => option.room === active)!.detail)
            : t("app:roomPicker.hoverHint")}
        </p>

        <footer className="room-picker-foot">
          <button onClick={onDismiss} type="button">
            {t("app:roomPicker.back")}
          </button>
        </footer>
      </div>
    </div>
  );
}
