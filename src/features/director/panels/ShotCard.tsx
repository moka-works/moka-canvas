import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DIRECTOR_ACCESSORIES,
  DIRECTOR_ASPECT_RATIOS,
  DIRECTOR_CAMERA_MOVES,
  DIRECTOR_SHOT_FPS,
  DIRECTOR_SHOT_SIZES,
  MAX_PROMPT_LENGTH,
  activeShotOf,
  actorFormFor,
  bonesFor,
  posesFor,
  type DirectorActorArchetype,
  type DirectorCamera,
  type DirectorLight,
  type DirectorObject,
  type DirectorScene,
  type DirectorShot,
  type DirectorSolidShape,
  type ResourceEntry,
} from "../../../shared/domain";
import { ACTOR_ARCHETYPE_KEYS } from "../staging";
import type { DirectorSelection } from "../types";
import {
  DirectorColor,
  DirectorNumber,
  DirectorSection,
  DirectorSelect,
  DirectorText,
  DirectorToggle,
} from "../components/DirectorFields";

type CardTab = "object" | "shot" | "scene";

export interface ShotCardProps {
  scene: DirectorScene;
  selection: DirectorSelection | null;
  models: ResourceEntry[];
  images: ResourceEntry[];
  onSelect: (selection: DirectorSelection | null) => void;
  onObject: (id: string, patch: Partial<DirectorObject>) => void;
  onCamera: (id: string, patch: Partial<DirectorCamera>) => void;
  onLight: (id: string, patch: Partial<DirectorLight>) => void;
  onShot: (id: string, patch: Partial<DirectorShot>) => void;
  onScene: (patch: Partial<DirectorScene>) => void;
  onArchetype: (id: string, archetype: DirectorActorArchetype) => void;
  onCameraSelect: (shotId: string, cameraId: string) => void;
}

/**
 * The right card: the selected thing, the current shot, or the stage itself.
 *
 * Which page is open follows the reader: selecting an object brings its page
 * forward, and the shot and scene pages are always a click away because a
 * shot is confirmed there before anything is delivered.
 */
export function ShotCard({
  scene,
  selection,
  models,
  images,
  onSelect,
  onObject,
  onCamera,
  onLight,
  onShot,
  onScene,
  onArchetype,
  onCameraSelect,
}: ShotCardProps) {
  const { t } = useTranslation(["director", "editor"]);
  const [tab, setTab] = useState<CardTab>("object");
  const shot = activeShotOf(scene);
  useEffect(() => {
    if (selection) setTab("object");
  }, [selection?.id, selection?.kind]);

  const object =
    selection?.kind === "object"
      ? scene.objects.find((entry) => entry.id === selection.id)
      : undefined;
  const camera =
    selection?.kind === "camera"
      ? scene.cameras.find((entry) => entry.id === selection.id)
      : undefined;
  const light =
    selection?.kind === "light"
      ? scene.lights.find((entry) => entry.id === selection.id)
      : undefined;

  return (
    <aside
      aria-label={t("director:cardPanel.title")}
      className="director-shot-card"
      id="director-shot-card"
    >
      <div className="director-tablist" role="tablist">
        {(["object", "shot", "scene"] as CardTab[]).map((id) => (
          <button
            aria-selected={tab === id}
            className="director-tab"
            key={id}
            onClick={() => setTab(id)}
            role="tab"
            type="button"
          >
            {t(`director:cardPanel.${id}`)}
          </button>
        ))}
      </div>
      <div className="director-card-body" role="tabpanel">
        {tab === "object" &&
          (object ? (
            <ObjectPage
              object={object}
              onChange={(patch) => onObject(object.id, patch)}
              onArchetype={(archetype) => onArchetype(object.id, archetype)}
              onRemove={() => onSelect(null)}
              onSelect={onSelect}
              models={models}
              scene={scene}
            />
          ) : camera ? (
            <CameraPage
              camera={camera}
              onChange={(patch) => onCamera(camera.id, patch)}
            />
          ) : light ? (
            <LightPage
              light={light}
              onChange={(patch) => onLight(light.id, patch)}
            />
          ) : (
            <p className="director-empty">{t("director:cardPanel.nothing")}</p>
          ))}

        {tab === "shot" &&
          (shot ? (
            <ShotPage
              fpsOptions={DIRECTOR_SHOT_FPS.map((fps) => ({
                value: String(fps),
                label: `${fps} fps`,
              }))}
              onCameraSelect={(cameraId) => onCameraSelect(shot.id, cameraId)}
              onChange={(patch) => onShot(shot.id, patch)}
              scene={scene}
              shot={shot}
            />
          ) : (
            <p className="director-empty">{t("director:cardPanel.noShot")}</p>
          ))}

        {tab === "scene" && (
          <ScenePage images={images} onChange={onScene} scene={scene} />
        )}
      </div>
    </aside>
  );
}

function ObjectPage({
  object,
  scene,
  models,
  onChange,
  onArchetype,
  onSelect,
}: {
  object: DirectorObject;
  scene: DirectorScene;
  models: ResourceEntry[];
  onChange: (patch: Partial<DirectorObject>) => void;
  onArchetype: (archetype: DirectorActorArchetype) => void;
  onSelect: (selection: DirectorSelection | null) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("director");
  const humanoid = object.archetype
    ? actorFormFor(object.archetype) === "humanoid"
    : true;
  const poses = posesFor(humanoid ? "humanoid" : "quadruped");
  const build = object.actorBuild;
  const animal = object.animalBuild;
  return (
    <>
      <DirectorSection title={t("cardPanel.objectSection")}>
        <DirectorText
          label={t("field.name")}
          onCommit={(name) => name.trim() && onChange({ name: name.trim() })}
          value={object.name}
        />
        <p className="director-kind-line">
          {t(`objectKind.${object.kind}`)}
          {object.kind === "solid" && object.shape
            ? ` · ${t(`shapes.${object.shape as DirectorSolidShape}`)}`
            : ""}
        </p>
        <DirectorToggle
          checked={object.visible}
          label={t("field.visible")}
          onChange={(visible) => onChange({ visible })}
        />
        <DirectorToggle
          checked={object.castShadow}
          label={t("field.castShadow")}
          onChange={(castShadow) => onChange({ castShadow })}
        />
        <DirectorToggle
          checked={object.receiveShadow}
          label={t("field.receiveShadow")}
          onChange={(receiveShadow) => onChange({ receiveShadow })}
        />
      </DirectorSection>
      <TransformFields
        onChange={(transform) => onChange({ transform })}
        transform={object.transform}
      />
      <DirectorSection title={t("field.appearance")}>
        <DirectorColor
          label={t("field.color")}
          onChange={(color) => onChange({ color })}
          value={object.color}
        />
      </DirectorSection>
      {object.kind === "performer" && (
        <DirectorSection title={t("cardPanel.performer")}>
          <DirectorSelect
            label={t("field.archetype")}
            onChange={(value) => onArchetype(value)}
            options={Object.entries(ACTOR_ARCHETYPE_KEYS).map(
              ([value, label]) => ({
                value: value as DirectorActorArchetype,
                label: t(label.replace("director:", "")),
              }),
            )}
            value={object.archetype ?? "standard"}
          />
          <DirectorSelect
            disabled={object.assetId !== undefined}
            label={t("field.pose")}
            onChange={(pose) => onChange({ pose })}
            options={poses.map((pose) => ({
              value: pose,
              label: t(`poses.${pose}`),
            }))}
            value={object.pose ?? poses[0]}
          />
          {build && (
            <>
              <DirectorNumber
                label={t("field.stature")}
                max={2.5}
                min={0.5}
                onChange={(stature) =>
                  onChange({ actorBuild: { ...build, stature } })
                }
                step={0.01}
                suffix="m"
                value={build.stature}
              />
              <DirectorNumber
                label={t("field.headScale")}
                max={2}
                min={0.5}
                onChange={(headScale) =>
                  onChange({ actorBuild: { ...build, headScale } })
                }
                step={0.01}
                value={build.headScale}
              />
              <DirectorNumber
                label={t("field.shoulderSpan")}
                max={1.2}
                min={0.1}
                onChange={(shoulderSpan) =>
                  onChange({ actorBuild: { ...build, shoulderSpan } })
                }
                step={0.01}
                suffix="m"
                value={build.shoulderSpan}
              />
              <DirectorNumber
                label={t("field.torsoShare")}
                max={0.4}
                min={0.25}
                onChange={(torsoShare) =>
                  onChange({ actorBuild: { ...build, torsoShare } })
                }
                step={0.01}
                value={build.torsoShare}
              />
              <DirectorSelect
                label={t("field.accessory")}
                onChange={(accessory) =>
                  onChange({ actorBuild: { ...build, accessory } })
                }
                options={DIRECTOR_ACCESSORIES.map((accessory) => ({
                  value: accessory,
                  label: t(`accessory.${accessory}`),
                }))}
                value={build.accessory}
              />
            </>
          )}
          {animal && (
            <>
              <DirectorNumber
                label={t("field.shoulderHeight")}
                max={2.5}
                min={0.15}
                onChange={(shoulderHeight) =>
                  onChange({ animalBuild: { ...animal, shoulderHeight } })
                }
                step={0.01}
                suffix="m"
                value={animal.shoulderHeight}
              />
              <DirectorNumber
                label={t("field.bodyLength")}
                max={4}
                min={0.2}
                onChange={(bodyLength) =>
                  onChange({ animalBuild: { ...animal, bodyLength } })
                }
                step={0.01}
                suffix="m"
                value={animal.bodyLength}
              />
              <DirectorNumber
                label={t("field.bodyWidth")}
                max={1.2}
                min={0.05}
                onChange={(bodyWidth) =>
                  onChange({ animalBuild: { ...animal, bodyWidth } })
                }
                step={0.01}
                suffix="m"
                value={animal.bodyWidth}
              />
              <DirectorNumber
                label={t("field.headScale")}
                max={2}
                min={0.5}
                onChange={(headScale) =>
                  onChange({ animalBuild: { ...animal, headScale } })
                }
                step={0.01}
                value={animal.headScale}
              />
            </>
          )}
          <p className="director-note">
            {t("cardPanel.bones", {
              count: object.archetype
                ? bonesFor(actorFormFor(object.archetype)).length
                : 0,
            })}
          </p>
        </DirectorSection>
      )}
      {(object.kind === "model" || object.kind === "plate") && (
        <DirectorSection title={t("cardPanel.asset")}>
          <p className="director-kind-line">
            {models.find((entry) => entry.id === object.assetId)?.name ??
              scene.objects.find((entry) => entry.id === object.id)?.name ??
              t("cardPanel.assetMissing")}
          </p>
        </DirectorSection>
      )}
      {object.keyframes.length > 0 && (
        <DirectorSection title={t("cardPanel.keyframes")}>
          <p className="director-kind-line">
            {t("cardPanel.keyframeCount", { count: object.keyframes.length })}
          </p>
        </DirectorSection>
      )}
      <button
        className="button director-danger"
        onClick={() => onSelect(null)}
        type="button"
      >
        {t("cardPanel.clearSelection")}
      </button>
    </>
  );
}

function TransformFields({
  transform,
  onChange,
}: {
  transform: DirectorObject["transform"];
  onChange: (transform: DirectorObject["transform"]) => void;
}) {
  const { t } = useTranslation("director");
  return (
    <DirectorSection title={t("field.transform")}>
      {(["position", "rotation", "scale"] as const).map((axis) => (
        <div className="director-axis-row" key={axis}>
          <span>{t(`field.${axis}`)}</span>
          {[0, 1, 2].map((index) => (
            <DirectorNumber
              key={index}
              label={["X", "Y", "Z"][index]}
              min={axis === "scale" ? 0.001 : undefined}
              onChange={(value) => {
                const next: [number, number, number] = [...transform[axis]];
                next[index] = value;
                onChange({ ...transform, [axis]: next });
              }}
              step={axis === "rotation" ? 0.05 : 0.05}
              value={transform[axis][index]}
            />
          ))}
        </div>
      ))}
    </DirectorSection>
  );
}

function CameraPage({
  camera,
  onChange,
}: {
  camera: DirectorScene["cameras"][number];
  onChange: (patch: Partial<DirectorScene["cameras"][number]>) => void;
}) {
  const { t } = useTranslation("director");
  return (
    <>
      <DirectorSection title={t("cardPanel.camera")}>
        <DirectorText
          label={t("field.name")}
          onCommit={(name) => name.trim() && onChange({ name: name.trim() })}
          value={camera.name}
        />
        <DirectorNumber
          label={t("field.focalLength")}
          max={300}
          min={12}
          onChange={(focalLength) => onChange({ focalLength })}
          step={1}
          suffix="mm"
          value={camera.focalLength}
        />
        <DirectorNumber
          label={t("field.aperture")}
          max={22}
          min={1.2}
          onChange={(aperture) => onChange({ aperture })}
          step={0.1}
          value={camera.aperture}
        />
        <DirectorNumber
          label={t("field.focusDistance")}
          max={1000}
          min={0.1}
          onChange={(focusDistance) => onChange({ focusDistance })}
          step={0.1}
          suffix="m"
          value={camera.focusDistance}
        />
        <p className="director-note">{t("cardPanel.apertureNote")}</p>
        <DirectorNumber
          label={t("field.near")}
          min={0.001}
          onChange={(near) => onChange({ near })}
          step={0.01}
          suffix="m"
          value={camera.near}
        />
        <DirectorNumber
          label={t("field.far")}
          min={0.01}
          onChange={(far) => onChange({ far })}
          step={1}
          suffix="m"
          value={camera.far}
        />
        <p className="director-note">
          {t("cardPanel.fovReadout", {
            value: (
              (2 * Math.atan(36 / (2 * camera.focalLength)) * 180) /
              Math.PI
            ).toFixed(1),
          })}
        </p>
      </DirectorSection>
      <DirectorSection title={t("field.position")}>
        {[0, 1, 2].map((index) => (
          <DirectorNumber
            key={index}
            label={["X", "Y", "Z"][index]}
            onChange={(value) => {
              const position: [number, number, number] = [
                ...camera.transform.position,
              ];
              position[index] = value;
              onChange({ transform: { ...camera.transform, position } });
            }}
            suffix="m"
            value={camera.transform.position[index]}
          />
        ))}
      </DirectorSection>
      <DirectorSection title={t("field.target")}>
        {[0, 1, 2].map((index) => (
          <DirectorNumber
            key={index}
            label={["X", "Y", "Z"][index]}
            onChange={(value) => {
              const target: [number, number, number] = [...camera.target];
              target[index] = value;
              onChange({ target });
            }}
            suffix="m"
            value={camera.target[index]}
          />
        ))}
      </DirectorSection>
    </>
  );
}

function LightPage({
  light,
  onChange,
}: {
  light: DirectorLight;
  onChange: (patch: Partial<DirectorLight>) => void;
}) {
  const { t } = useTranslation("director");
  return (
    <>
      <DirectorSection title={t("cardPanel.light")}>
        <DirectorText
          label={t("field.name")}
          onCommit={(name) => name.trim() && onChange({ name: name.trim() })}
          value={light.name}
        />
        <p className="director-kind-line">{t(`lights.${light.type}`)}</p>
        <DirectorColor
          label={t("field.color")}
          onChange={(color) => onChange({ color })}
          value={light.color}
        />
        <DirectorNumber
          label={t("field.intensity")}
          max={100}
          min={0}
          onChange={(intensity) => onChange({ intensity })}
          step={0.1}
          value={light.intensity}
        />
        <DirectorToggle
          checked={light.castShadow}
          label={t("field.castShadow")}
          onChange={(castShadow) => onChange({ castShadow })}
        />
        {light.type === "spot" && (
          <>
            <DirectorNumber
              label={t("field.angle")}
              max={90}
              min={1}
              onChange={(degrees) =>
                onChange({ angle: (degrees * Math.PI) / 180 })
              }
              step={1}
              suffix="°"
              value={((light.angle ?? Math.PI / 6) * 180) / Math.PI}
            />
            <DirectorNumber
              label={t("field.penumbra")}
              max={1}
              min={0}
              onChange={(penumbra) => onChange({ penumbra })}
              step={0.05}
              value={light.penumbra ?? 0.4}
            />
          </>
        )}
      </DirectorSection>
    </>
  );
}

function ShotPage({
  scene,
  shot,
  fpsOptions,
  onChange,
  onCameraSelect,
}: {
  scene: DirectorScene;
  shot: DirectorShot;
  fpsOptions: { value: string; label: string }[];
  onChange: (patch: Partial<DirectorShot>) => void;
  onCameraSelect: (cameraId: string) => void;
}) {
  const { t } = useTranslation("director");
  return (
    <>
      <DirectorSection title={t("cardPanel.shot")}>
        <DirectorText
          label={t("field.name")}
          onCommit={(name) => name.trim() && onChange({ name: name.trim() })}
          value={shot.name}
        />
        <DirectorSelect
          label={t("field.camera")}
          onChange={(cameraId) => onCameraSelect(cameraId)}
          options={scene.cameras.map((camera) => ({
            value: camera.id,
            label: camera.name,
          }))}
          value={shot.cameraId}
        />
        <DirectorNumber
          label={t("field.duration")}
          max={60}
          min={0.5}
          onChange={(duration) => onChange({ duration })}
          step={0.5}
          suffix="s"
          value={shot.duration}
        />
        <DirectorSelect
          label={t("field.fps")}
          onChange={(value) =>
            onChange({ fps: Number(value) as DirectorShot["fps"] })
          }
          options={fpsOptions}
          value={String(shot.fps)}
        />
        <DirectorSelect
          label={t("field.aspectRatio")}
          onChange={(aspectRatio) => onChange({ aspectRatio })}
          options={DIRECTOR_ASPECT_RATIOS.map((ratio) => ({
            value: ratio,
            label: ratio,
          }))}
          value={shot.aspectRatio}
        />
        <DirectorSelect
          label={t("field.shotSize")}
          onChange={(shotSize) => onChange({ shotSize })}
          options={DIRECTOR_SHOT_SIZES.map((size) => ({
            value: size,
            label: t(`shotSize.${size}`),
          }))}
          value={shot.shotSize}
        />
        <DirectorSelect
          label={t("field.cameraMove")}
          onChange={(cameraMove) => onChange({ cameraMove })}
          options={DIRECTOR_CAMERA_MOVES.map((move) => ({
            value: move,
            label: t(`cameraMove.${move}`),
          }))}
          value={shot.cameraMove}
        />
        <DirectorText
          hint={t("cardPanel.promptHint")}
          label={t("field.prompt")}
          maxLength={MAX_PROMPT_LENGTH}
          multiline
          onCommit={(prompt) => onChange({ prompt })}
          rows={5}
          value={shot.prompt}
        />
      </DirectorSection>
    </>
  );
}

function ScenePage({
  scene,
  images,
  onChange,
}: {
  scene: DirectorScene;
  images: ResourceEntry[];
  onChange: (patch: Partial<DirectorScene>) => void;
}) {
  const { t } = useTranslation("director");
  const environment = scene.environment;
  return (
    <>
      <DirectorSection title={t("cardPanel.scene")}>
        <DirectorText
          label={t("field.sceneTitle")}
          onCommit={(title) =>
            title.trim() && onChange({ title: title.trim() })
          }
          value={scene.title}
        />
        <DirectorColor
          label={t("field.background")}
          onChange={(background) => onChange({ background })}
          value={scene.background}
        />
        <DirectorNumber
          label={t("field.environmentIntensity")}
          max={10}
          min={0}
          onChange={(environmentIntensity) =>
            onChange({ environmentIntensity })
          }
          step={0.05}
          value={scene.environmentIntensity}
        />
        <DirectorToggle
          checked={scene.gridVisible}
          label={t("field.gridVisible")}
          onChange={(gridVisible) => onChange({ gridVisible })}
        />
      </DirectorSection>
      <DirectorSection title={t("cardPanel.environment")}>
        <DirectorSelect
          label={t("field.environmentMode")}
          onChange={(mode) =>
            onChange({
              environment:
                mode === "color"
                  ? { mode: "color" }
                  : {
                      mode: "panorama",
                      assetId: environment?.assetId ?? images[0]?.id,
                      rotationY: environment?.rotationY ?? 0,
                      exposure: environment?.exposure ?? 1,
                      useAsLighting: environment?.useAsLighting ?? false,
                      lightingIntensity: environment?.lightingIntensity ?? 1,
                    },
            })
          }
          options={[
            { value: "color", label: t("environment.color") },
            { value: "panorama", label: t("environment.panorama") },
          ]}
          value={environment?.mode ?? "color"}
        />
        {environment?.mode === "panorama" && (
          <>
            <DirectorSelect
              label={t("field.panorama")}
              onChange={(assetId) =>
                onChange({ environment: { ...environment, assetId } })
              }
              options={images.map((image) => ({
                value: image.id,
                label: image.name,
              }))}
              value={environment.assetId ?? ""}
            />
            <DirectorNumber
              label={t("field.rotationY")}
              onChange={(rotationY) =>
                onChange({ environment: { ...environment, rotationY } })
              }
              step={0.05}
              value={environment.rotationY ?? 0}
            />
            <DirectorToggle
              checked={environment.useAsLighting ?? false}
              label={t("field.useAsLighting")}
              onChange={(useAsLighting) =>
                onChange({ environment: { ...environment, useAsLighting } })
              }
            />
            {environment.useAsLighting && (
              <DirectorNumber
                label={t("field.lightingIntensity")}
                max={10}
                min={0}
                onChange={(lightingIntensity) =>
                  onChange({
                    environment: { ...environment, lightingIntensity },
                  })
                }
                step={0.05}
                value={environment.lightingIntensity ?? 1}
              />
            )}
          </>
        )}
      </DirectorSection>
      <DirectorSection title={t("cardPanel.limits")}>
        <p className="director-note">
          {t("cardPanel.counts", {
            objects: scene.objects.length,
            cameras: scene.cameras.length,
            lights: scene.lights.length,
            shots: scene.shots.length,
          })}
        </p>
      </DirectorSection>
    </>
  );
}
