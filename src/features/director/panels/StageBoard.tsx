import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DIRECTOR_ANIMAL_ARCHETYPES,
  DIRECTOR_HUMANOID_ARCHETYPES,
  DIRECTOR_SOLID_SHAPES,
  DIRECTOR_PALETTE,
  type DirectorActorArchetype,
  type DirectorLight,
  type DirectorScene,
  type DirectorSolidShape,
  type ResourceEntry,
} from "../../../shared/domain";
import {
  ACTOR_ARCHETYPE_KEYS,
  CAMERA_PRESETS,
  DIRECTOR_PROP_GROUPS,
  type DirectorProp,
} from "../staging";
import type { DirectorPlate, DirectorSelection } from "../types";

type BoardTab = "actors" | "props" | "cameras" | "lights" | "reference";

const TABS: { id: BoardTab; label: string }[] = [
  { id: "actors", label: "director:board.actors" },
  { id: "props", label: "director:board.props" },
  { id: "cameras", label: "director:board.cameras" },
  { id: "lights", label: "director:board.lights" },
  { id: "reference", label: "director:board.reference" },
];

export interface StageBoardProps {
  scene: DirectorScene;
  selection: DirectorSelection | null;
  models: ResourceEntry[];
  plates: DirectorPlate[];
  onSelect: (selection: DirectorSelection | null) => void;
  onAddPerformer: (archetype: DirectorActorArchetype) => void;
  onAddEnsemble: () => void;
  onAddProp: (prop: DirectorProp) => void;
  onAddSolid: (shape: DirectorSolidShape) => void;
  onAddModel: (assetId: string, name: string) => void;
  onUploadModel: (file: File) => void;
  onAddCamera: (presetIndex: number) => void;
  onAddLight: (type: DirectorLight["type"]) => void;
  onRemove: (selection: DirectorSelection) => void;
  onDuplicate: (selection: DirectorSelection) => void;
  onToggleVisible: (objectId: string) => void;
  onSetPanorama: (plate: DirectorPlate) => void;
  onSetPlate: (plate: DirectorPlate) => void;
  onViewImage: (plate: DirectorPlate) => void;
}

/**
 * The left board: what a scene is made of, one kind at a time.
 *
 * Five pages rather than one growing tree because the things are added and
 * found in different ways: actors from a cast list, props from a library,
 * cameras from positions, lights from four kinds, and references from what
 * the board is wired to.
 */
export function StageBoard({
  scene,
  selection,
  models,
  plates,
  onSelect,
  onAddPerformer,
  onAddEnsemble,
  onAddProp,
  onAddSolid,
  onAddModel,
  onUploadModel,
  onAddCamera,
  onAddLight,
  onRemove,
  onDuplicate,
  onToggleVisible,
  onSetPanorama,
  onSetPlate,
  onViewImage,
}: StageBoardProps) {
  const { t } = useTranslation(["director", "editor"]);
  const [tab, setTab] = useState<BoardTab>("actors");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const match = (name: string) => name.toLowerCase().includes(needle);

  const performers = scene.objects.filter(
    (object) => object.kind === "performer" && match(object.name),
  );
  const objects = scene.objects.filter(
    (object) => object.kind !== "performer" && match(object.name),
  );
  const cameras = scene.cameras.filter((camera) => match(camera.name));
  const lights = scene.lights.filter((light) => match(light.name));

  return (
    <aside
      aria-label={t("director:board.title")}
      className="director-board"
      id="director-board"
    >
      <div className="director-tablist" role="tablist">
        {TABS.map((item) => (
          <button
            aria-selected={tab === item.id}
            className="director-tab"
            key={item.id}
            onClick={() => {
              setTab(item.id);
              setQuery("");
            }}
            role="tab"
            type="button"
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <div className="director-board-search">
        <input
          aria-label={t("director:board.search")}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("director:board.search")}
          type="search"
          value={query}
        />
      </div>
      <div className="director-board-body" role="tabpanel">
        {tab === "actors" && (
          <>
            <p className="director-group-label">
              {t("director:actors.humanoid")}
            </p>
            <div className="director-button-grid">
              {DIRECTOR_HUMANOID_ARCHETYPES.map((archetype) => (
                <button
                  key={archetype}
                  onClick={() => onAddPerformer(archetype)}
                  type="button"
                >
                  {t(ACTOR_ARCHETYPE_KEYS[archetype])}
                </button>
              ))}
            </div>
            <p className="director-group-label">
              {t("director:actors.animal")}
            </p>
            <div className="director-button-grid">
              {DIRECTOR_ANIMAL_ARCHETYPES.map((archetype) => (
                <button
                  key={archetype}
                  onClick={() => onAddPerformer(archetype)}
                  type="button"
                >
                  {t(ACTOR_ARCHETYPE_KEYS[archetype])}
                </button>
              ))}
            </div>
            <button
              className="button director-wide-button"
              onClick={onAddEnsemble}
              type="button"
            >
              {t("director:actors.ensemble")}
            </button>
            <p className="director-group-label">{t("director:board.cast")}</p>
            {performers.map((object) => (
              <Row
                active={selection?.id === object.id}
                color={object.color}
                detail={t(ACTOR_ARCHETYPE_KEYS[object.archetype ?? "standard"])}
                key={object.id}
                name={object.name}
                onDuplicate={() =>
                  onDuplicate({ kind: "object", id: object.id })
                }
                onRemove={() => onRemove({ kind: "object", id: object.id })}
                onSelect={() => onSelect({ kind: "object", id: object.id })}
                onToggleVisible={() => onToggleVisible(object.id)}
                visible={object.visible}
              />
            ))}
            {performers.length === 0 && (
              <p className="director-empty">{t("director:board.noActors")}</p>
            )}
          </>
        )}

        {tab === "props" && (
          <>
            <p className="director-group-label">
              {t("director:props.geometry")}
            </p>
            <div className="director-button-grid">
              {DIRECTOR_SOLID_SHAPES.map((shape) => (
                <button
                  key={shape}
                  onClick={() => onAddSolid(shape)}
                  type="button"
                >
                  {t(`director:shapes.${shape}`)}
                </button>
              ))}
            </div>
            {DIRECTOR_PROP_GROUPS.map((group) => (
              <div key={group.id}>
                <p className="director-group-label">
                  {t(`director:propGroups.${group.id}`)}
                </p>
                <div className="director-button-grid">
                  {group.props.map((prop) => (
                    <button
                      key={prop.id}
                      onClick={() => onAddProp(prop)}
                      title={t(`director:props.${prop.id}`)}
                      type="button"
                    >
                      {t(`director:props.${prop.id}`)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="director-group-label">{t("director:board.models")}</p>
            <label className="director-file-button">
              <span>{t("director:models.upload")}</span>
              <input
                accept=".glb,.gltf"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUploadModel(file);
                  event.target.value = "";
                }}
                type="file"
              />
            </label>
            {models.map((model) => (
              <button
                className="director-model-row"
                key={model.id}
                onClick={() => onAddModel(model.id, model.name)}
                type="button"
              >
                <span aria-hidden="true">◈</span>
                {model.name}
              </button>
            ))}
            {models.length === 0 && (
              <p className="director-empty">{t("director:models.none")}</p>
            )}
            <p className="director-group-label">
              {t("director:board.objects")}
            </p>
            {objects.map((object) => (
              <Row
                active={selection?.id === object.id}
                color={object.color}
                detail={t(`director:objectKind.${object.kind}`)}
                key={object.id}
                name={object.name}
                onDuplicate={() =>
                  onDuplicate({ kind: "object", id: object.id })
                }
                onRemove={() => onRemove({ kind: "object", id: object.id })}
                onSelect={() => onSelect({ kind: "object", id: object.id })}
                onToggleVisible={() => onToggleVisible(object.id)}
                visible={object.visible}
              />
            ))}
            {objects.length === 0 && (
              <p className="director-empty">{t("director:board.noObjects")}</p>
            )}
          </>
        )}

        {tab === "cameras" && (
          <>
            <p className="director-group-label">
              {t("director:cameras.presets")}
            </p>
            <div className="director-button-grid">
              {CAMERA_PRESETS.map((preset, index) => (
                <button
                  key={preset.id}
                  onClick={() => onAddCamera(index)}
                  title={`${preset.focalLength}mm`}
                  type="button"
                >
                  {t(`director:cameraPresets.${preset.id}`)}
                </button>
              ))}
            </div>
            <button
              className="button director-wide-button"
              onClick={() => onAddCamera(-1)}
              type="button"
            >
              {t("director:cameras.add")}
            </button>
            <p className="director-group-label">
              {t("director:board.cameras")}
            </p>
            {cameras.map((camera) => (
              <Row
                active={selection?.id === camera.id}
                detail={`${camera.focalLength}mm${
                  scene.shots.some((shot) => shot.cameraId === camera.id)
                    ? " · " + t("director:cameras.inShot")
                    : ""
                }`}
                key={camera.id}
                name={camera.name}
                onDuplicate={() =>
                  onDuplicate({ kind: "camera", id: camera.id })
                }
                onRemove={() => onRemove({ kind: "camera", id: camera.id })}
                onSelect={() => onSelect({ kind: "camera", id: camera.id })}
              />
            ))}
          </>
        )}

        {tab === "lights" && (
          <>
            <p className="director-group-label">{t("director:lights.add")}</p>
            <div className="director-button-grid">
              {(["directional", "point", "spot", "ambient"] as const).map(
                (type) => (
                  <button
                    key={type}
                    onClick={() => onAddLight(type)}
                    type="button"
                  >
                    {t(`director:lights.${type}`)}
                  </button>
                ),
              )}
            </div>
            <p className="director-group-label">{t("director:board.lights")}</p>
            {lights.map((light) => (
              <Row
                active={selection?.id === light.id}
                color={light.color}
                detail={`${t(`director:lights.${light.type}`)} · ${light.intensity}`}
                key={light.id}
                name={light.name}
                onDuplicate={() => onDuplicate({ kind: "light", id: light.id })}
                onRemove={() => onRemove({ kind: "light", id: light.id })}
                onSelect={() => onSelect({ kind: "light", id: light.id })}
              />
            ))}
          </>
        )}

        {tab === "reference" && (
          <>
            <p className="director-group-label">
              {t("director:reference.title")}
            </p>
            <p className="director-board-note">
              {t("director:reference.note")}
            </p>
            {plates.map((plate) => (
              <div className="director-plate-row" key={plate.nodeId}>
                <strong>{plate.title}</strong>
                {plate.assetId ? (
                  <div className="director-plate-actions">
                    <button onClick={() => onSetPanorama(plate)} type="button">
                      {t("director:reference.panorama")}
                    </button>
                    <button onClick={() => onSetPlate(plate)} type="button">
                      {t("director:reference.plate")}
                    </button>
                    <button onClick={() => onViewImage(plate)} type="button">
                      {t("director:reference.view")}
                    </button>
                  </div>
                ) : (
                  <p className="director-empty">
                    {t("director:reference.noAsset")}
                  </p>
                )}
              </div>
            ))}
            {plates.length === 0 && (
              <p className="director-empty">{t("director:reference.empty")}</p>
            )}
          </>
        )}
      </div>
      <footer className="director-board-stats">
        {t("director:board.stats", {
          actors: scene.objects.filter((object) => object.kind === "performer")
            .length,
          props: scene.objects.filter((object) => object.kind !== "performer")
            .length,
          cameras: scene.cameras.length,
          lights: scene.lights.length,
        })}
      </footer>
    </aside>
  );
}

function Row({
  name,
  detail,
  color,
  active,
  visible,
  onSelect,
  onRemove,
  onDuplicate,
  onToggleVisible,
}: {
  name: string;
  detail: string;
  color?: string;
  active: boolean;
  visible?: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onDuplicate?: () => void;
  onToggleVisible?: () => void;
}) {
  const { t } = useTranslation("director");
  return (
    <div className={active ? "director-row is-active" : "director-row"}>
      <button className="director-row-main" onClick={onSelect} type="button">
        {color ? (
          <span
            aria-hidden="true"
            className="director-color-dot"
            style={{ background: color }}
          />
        ) : (
          <span aria-hidden="true" className="director-color-dot is-neutral" />
        )}
        <span>
          <strong>{name}</strong>
          <small>{detail}</small>
        </span>
      </button>
      <span className="director-row-actions">
        {onToggleVisible && visible !== undefined && (
          <button
            aria-label={t("board.toggleVisible", { name })}
            onClick={onToggleVisible}
            title={t("board.toggleVisible", { name })}
            type="button"
          >
            {visible ? "◉" : "○"}
          </button>
        )}
        {onDuplicate && (
          <button
            aria-label={t("board.duplicate", { name })}
            onClick={onDuplicate}
            title={t("board.duplicate", { name })}
            type="button"
          >
            ⧉
          </button>
        )}
        <button
          aria-label={t("board.remove", { name })}
          onClick={onRemove}
          title={t("board.remove", { name })}
          type="button"
        >
          ×
        </button>
      </span>
    </div>
  );
}

export const DIRECTOR_ACTOR_COLORS = DIRECTOR_PALETTE;
