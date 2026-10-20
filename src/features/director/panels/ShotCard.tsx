import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Euler, Quaternion } from "three";
import {
  DIRECTOR_ACCESSORIES,
  DIRECTOR_ASPECT_RATIOS,
  DIRECTOR_CAMERA_MOVES,
  DIRECTOR_HUMANOID_BODY_BONES,
  DIRECTOR_SHOT_FPS,
  DIRECTOR_SHOT_SIZES,
  MAX_PROMPT_LENGTH,
  activeShotOf,
  actorFormFor,
  bonesFor,
  posesFor,
  type DirectorActorArchetype,
  type DirectorBone,
  type DirectorCamera,
  type DirectorHumanoidBone,
  type DirectorLight,
  type DirectorObject,
  type DirectorQuat,
  type DirectorScene,
  type DirectorShot,
  type DirectorSolidShape,
  type ResourceEntry,
} from "../../../shared/domain";
import { ACTOR_ARCHETYPE_KEYS } from "../staging";
import { MAPPABLE_BONES, rigReady } from "../stage/rig";
import { boneRotation } from "../stage/poses";
import { useRigNames } from "../stores/rigNames";
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
  onBone: (
    id: string,
    bone: DirectorBone,
    rotation: DirectorQuat | null,
  ) => void;
  onUseAsPerformer: (id: string) => void;
  playhead: number;
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
  onBone,
  onUseAsPerformer,
  playhead,
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
              onBone={(bone, rotation) => onBone(object.id, bone, rotation)}
              onRemove={() => onSelect(null)}
              onSelect={onSelect}
              onUseAsPerformer={() => onUseAsPerformer(object.id)}
              models={models}
              playhead={playhead}
              scene={scene}
              selection={selection}
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
  selection,
  playhead,
  onChange,
  onArchetype,
  onBone,
  onSelect,
  onUseAsPerformer,
}: {
  object: DirectorObject;
  scene: DirectorScene;
  models: ResourceEntry[];
  selection: DirectorSelection | null;
  playhead: number;
  onChange: (patch: Partial<DirectorObject>) => void;
  onArchetype: (archetype: DirectorActorArchetype) => void;
  onBone: (bone: DirectorBone, rotation: DirectorQuat | null) => void;
  onSelect: (selection: DirectorSelection | null) => void;
  onRemove: () => void;
  onUseAsPerformer: () => void;
}) {
  const { t } = useTranslation("director");
  const NO_BONES: string[] = [];

  const humanoid = object.archetype
    ? actorFormFor(object.archetype) === "humanoid"
    : true;
  const poses = posesFor(humanoid ? "humanoid" : "quadruped");
  const build = object.actorBuild;
  const animal = object.animalBuild;
  const boneNames =
    useRigNames((state) => state.boneNames[object.id]) ?? NO_BONES;
  const editableBones: readonly DirectorBone[] = object.assetId
    ? MAPPABLE_BONES
    : humanoid
      ? DIRECTOR_HUMANOID_BODY_BONES
      : bonesFor("quadruped");
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
            onChange={(pose) =>
              onChange({
                pose,
                activeMotionClipId: undefined,
                boneOverrides: {},
              })
            }
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
                ? humanoid
                  ? DIRECTOR_HUMANOID_BODY_BONES.length
                  : bonesFor("quadruped").length
                : 0,
            })}
          </p>
        </DirectorSection>
      )}
      {object.kind === "performer" && (
        <BoneSection
          bones={editableBones}
          object={object}
          onBone={onBone}
          onSelectBone={(bone) =>
            onSelect(
              bone
                ? { kind: "object", id: object.id, bone }
                : { kind: "object", id: object.id },
            )
          }
          playhead={playhead}
          selectedBone={selection?.bone}
        />
      )}
      {object.motionClips && object.motionClips.length > 0 && (
        <MotionClipsSection object={object} onChange={onChange} />
      )}
      {object.kind === "performer" && object.assetId && (
        <RigMappingSection
          boneNames={boneNames}
          object={object}
          onChange={onChange}
        />
      )}
      {(object.kind === "model" || object.kind === "plate") && (
        <DirectorSection title={t("cardPanel.asset")}>
          <p className="director-kind-line">
            {models.find((entry) => entry.id === object.assetId)?.name ??
              scene.objects.find((entry) => entry.id === object.id)?.name ??
              t("cardPanel.assetMissing")}
          </p>
          {object.kind === "model" && (
            <button
              className="button director-wide-button"
              onClick={onUseAsPerformer}
              type="button"
            >
              {t("cardPanel.useAsPerformer")}
            </button>
          )}
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

function BoneSection({
  bones,
  object,
  selectedBone,
  playhead,
  onSelectBone,
  onBone,
}: {
  bones: readonly DirectorBone[];
  object: DirectorObject;
  selectedBone?: DirectorBone;
  playhead: number;
  onSelectBone: (bone: DirectorBone | null) => void;
  onBone: (bone: DirectorBone, rotation: DirectorQuat | null) => void;
}) {
  const { t } = useTranslation("director");
  const rotation = selectedBone
    ? (boneRotation(object, selectedBone, playhead) ?? [0, 0, 0, 1])
    : null;
  const euler = rotation
    ? new Euler().setFromQuaternion(
        new Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]),
      )
    : null;
  const setAxis = (axis: "x" | "y" | "z", degrees: number) => {
    if (!selectedBone || !euler) return;
    const next = new Euler(euler.x, euler.y, euler.z);
    next[axis] = (degrees * Math.PI) / 180;
    const quaternion = new Quaternion().setFromEuler(next);
    onBone(selectedBone, [
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
    ]);
  };
  return (
    <DirectorSection title={t("cardPanel.boneTitle")}>
      <DirectorSelect
        label={t("field.bone")}
        onChange={(value) =>
          onSelectBone(value ? (value as DirectorBone) : null)
        }
        options={[
          { value: "", label: t("cardPanel.noBone") },
          ...bones.map((bone) => ({
            value: bone as string,
            label: t(`bones.${bone}`),
          })),
        ]}
        value={selectedBone ?? ""}
      />
      {selectedBone && euler && (
        <>
          {(["x", "y", "z"] as const).map((axis) => (
            <DirectorNumber
              key={axis}
              label={`${axis.toUpperCase()}°`}
              onChange={(degrees) => setAxis(axis, degrees)}
              step={1}
              suffix="°"
              value={(euler[axis] * 180) / Math.PI}
            />
          ))}
          <div className="director-inline-actions">
            <button
              className="button"
              onClick={() => onBone(selectedBone, null)}
              type="button"
            >
              {t("cardPanel.resetBone")}
            </button>
            <button
              className="button"
              onClick={() => onSelectBone(null)}
              type="button"
            >
              {t("cardPanel.noBone")}
            </button>
          </div>
          <p className="director-note">{t("cardPanel.bonePriority")}</p>
        </>
      )}
    </DirectorSection>
  );
}

function MotionClipsSection({
  object,
  onChange,
}: {
  object: DirectorObject;
  onChange: (patch: Partial<DirectorObject>) => void;
}) {
  const { t } = useTranslation("director");
  const clips = object.motionClips ?? [];
  const active = clips.find((clip) => clip.id === object.activeMotionClipId);
  const patchClip = (patch: Partial<(typeof clips)[number]>) => {
    if (!active) return;
    onChange({
      motionClips: clips.map((clip) =>
        clip.id === active.id ? { ...clip, ...patch } : clip,
      ),
    });
  };
  return (
    <DirectorSection title={t("cardPanel.clips")}>
      <DirectorSelect
        label={t("field.clip")}
        onChange={(value) =>
          onChange({ activeMotionClipId: value || undefined })
        }
        options={[
          { value: "", label: t("cardPanel.noClip") },
          ...clips.map((clip) => ({
            value: clip.id,
            label: `${clip.name} · ${clip.duration.toFixed(1)}s`,
          })),
        ]}
        value={active?.id ?? ""}
      />
      {active && (
        <>
          <DirectorNumber
            label={t("field.playbackRate")}
            max={10}
            min={0.1}
            onChange={(playbackRate) => patchClip({ playbackRate })}
            step={0.05}
            value={active.playbackRate}
          />
          <DirectorNumber
            label={t("field.clipStart")}
            max={60}
            min={0}
            onChange={(start) => patchClip({ start })}
            step={0.1}
            suffix="s"
            value={active.start}
          />
          <DirectorToggle
            checked={active.loop}
            label={t("field.loop")}
            onChange={(loop) => patchClip({ loop })}
          />
        </>
      )}
    </DirectorSection>
  );
}

function RigMappingSection({
  object,
  boneNames,
  onChange,
}: {
  object: DirectorObject;
  boneNames: string[];
  onChange: (patch: Partial<DirectorObject>) => void;
}) {
  const { t } = useTranslation("director");
  const rig = object.rig;
  const boneMap = rig?.boneMap ?? {};
  const mapped = Object.values(boneMap).filter(Boolean).length;
  return (
    <DirectorSection title={t("cardPanel.rig.title")}>
      <p className="director-kind-line">
        {t(`cardPanel.rig.${rig?.status ?? "unmapped"}`, { count: mapped })}
      </p>
      <details>
        <summary className="director-details-summary">
          {t("cardPanel.rig.manual")}
        </summary>
        {MAPPABLE_BONES.map((bone) => (
          <DirectorSelect
            key={bone}
            label={t(`bones.${bone}`)}
            onChange={(name) => {
              const next = { ...boneMap };
              if (name) {
                next[bone] = name;
              } else {
                delete next[bone];
              }
              onChange({
                rig: {
                  status: rigReady(next) ? "ready" : "unmapped",
                  boneMap: next,
                  animationNames: rig?.animationNames ?? [],
                },
              });
            }}
            options={[
              { value: "", label: t("cardPanel.rig.none") },
              ...boneNames.map((name) => ({ value: name, label: name })),
            ]}
            value={boneMap[bone as DirectorHumanoidBone] ?? ""}
          />
        ))}
      </details>
    </DirectorSection>
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
