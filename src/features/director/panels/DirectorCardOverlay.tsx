import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { assetThumbUrl } from "../../../api";
import {
  LOW_DETAIL_ZOOM,
  activeShotOf,
  directorSceneOf,
  type DirectorScene,
  type WorkflowNode,
} from "../../../shared/domain";
import { worldToClient } from "../../editor/canvas/canvasControl";
import { NODE_HEADER_HEIGHT } from "../../editor/canvas/theme";
import {
  useEditorStore,
  type ActiveGesture,
} from "../../editor/stores/editorStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { openDirector } from "../stores/directorStore";

const INSET = 8;
const TOP = NODE_HEADER_HEIGHT + INSET;

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
 * A scene seen from above, without opening a 3D context.
 *
 * The card has to say what is on the stage before the room is entered, and a
 * second renderer per card would be a WebGL context for every desk on the
 * board. A plan drawing is enough to read who stands where and where the
 * camera looks.
 */
export function DirectorPlan({ scene }: { scene: DirectorScene }) {
  const spots = [
    ...scene.objects.map((object) => [
      object.transform.position[0],
      object.transform.position[2],
    ]),
    ...scene.cameras.map((camera) => [
      camera.transform.position[0],
      camera.transform.position[2],
    ]),
    ...scene.lights.map((light) => [
      light.transform.position[0],
      light.transform.position[2],
    ]),
  ] as [number, number][];
  const minX = Math.min(-1, ...spots.map(([x]) => x));
  const maxX = Math.max(1, ...spots.map(([x]) => x));
  const minZ = Math.min(-1, ...spots.map(([, z]) => z));
  const maxZ = Math.max(1, ...spots.map(([, z]) => z));
  const scale = Math.min(180 / (maxX - minX || 1), 100 / (maxZ - minZ || 1));
  const project = (x: number, z: number): [number, number] => [
    100 + (x - (minX + maxX) / 2) * scale,
    60 + (z - (minZ + maxZ) / 2) * scale,
  ];
  const grid = [];
  for (let line = 0; line <= 12; line += 1) {
    grid.push(
      <line
        key={`v${line}`}
        stroke="#ffffff14"
        x1={line * (200 / 12)}
        x2={line * (200 / 12)}
        y1={0}
        y2={120}
      />,
      <line
        key={`h${line}`}
        stroke="#ffffff14"
        x1={0}
        x2={200}
        y1={line * 10}
        y2={line * 10}
      />,
    );
  }
  return (
    <svg
      aria-hidden="true"
      className="director-plan"
      preserveAspectRatio="xMidYMid meet"
      viewBox="0 0 200 120"
    >
      <rect fill="#202630" height={120} width={200} />
      {grid}
      {scene.objects.map((object) => {
        const [x, z] = project(
          object.transform.position[0],
          object.transform.position[2],
        );
        const heading = object.transform.rotation[1];
        if (object.kind === "performer") {
          return (
            <g
              key={object.id}
              transform={`translate(${x} ${z}) rotate(${(heading * 180) / Math.PI})`}
            >
              <circle fill={object.color} r={4} />
              <path d="M0 -4 L6 0 L0 4 Z" fill={object.color} />
            </g>
          );
        }
        if (object.kind === "solid") {
          const width = Math.max(
            3,
            Math.abs(object.transform.scale[0]) * scale,
          );
          const depth = Math.max(
            3,
            Math.abs(object.transform.scale[2]) * scale,
          );
          return (
            <rect
              fill={object.color}
              fillOpacity={0.55}
              height={depth}
              key={object.id}
              stroke={object.color}
              width={width}
              x={x - width / 2}
              y={z - depth / 2}
            />
          );
        }
        return (
          <rect
            fill={object.color}
            fillOpacity={0.5}
            height={4}
            key={object.id}
            width={4}
            x={x - 2}
            y={z - 2}
          />
        );
      })}
      {scene.cameras.map((camera) => {
        const [x, z] = project(
          camera.transform.position[0],
          camera.transform.position[2],
        );
        const [tx, tz] = project(camera.target[0], camera.target[2]);
        return (
          <g key={camera.id}>
            <line
              stroke="#61afef"
              strokeWidth={1.5}
              x1={x}
              x2={tx}
              y1={z}
              y2={tz}
            />
            <rect
              fill="#61afef"
              height={6}
              transform={`translate(${x - 3} ${z - 3})`}
              width={6}
            />
          </g>
        );
      })}
      {scene.lights.map((light) => {
        const [x, z] = project(
          light.transform.position[0],
          light.transform.position[2],
        );
        return (
          <circle
            cx={x}
            cy={z}
            fill={light.color}
            fillOpacity={0.8}
            key={light.id}
            r={2}
          >
            <title>{light.name}</title>
          </circle>
        );
      })}
    </svg>
  );
}

/**
 * The face of a director card: its delivered frame, or a plan of the scene.
 */
export function DirectorCardOverlay() {
  const { t } = useTranslation(["director", "editor"]);
  const camera = useEditorStore((state) => state.camera);
  const gesture = useEditorStore((state) => state.gesture);
  const moka = useProjectStore((state) => state.moka);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  const [brokenFrames, setBrokenFrames] = useState<Set<string>>(new Set());

  const canvas =
    moka?.canvas.find((entry) => entry.id === activeCanvasId) ??
    moka?.canvas[0] ??
    null;
  const nodes = useMemo(
    () => canvas?.nodes.filter((node) => node.kind === "director") ?? [],
    [canvas],
  );
  if (!moka || !canvas || nodes.length === 0) return null;
  const zoom = camera?.zoom ?? canvas.viewport.zoom ?? 1;
  if (zoom < LOW_DETAIL_ZOOM) return null;

  return (
    <>
      {nodes.map((node) => {
        const scene = directorSceneOf(moka, node);
        const state = (
          node.data as {
            director?: { frameAssetId?: string; frameShotId?: string };
          }
        ).director;
        const shot = scene ? activeShotOf(scene) : undefined;
        const stale =
          scene !== undefined &&
          state?.frameShotId !== undefined &&
          state.frameShotId !== scene.activeShotId;
        const frame =
          state?.frameAssetId && !brokenFrames.has(state.frameAssetId)
            ? state.frameAssetId
            : undefined;
        const bounds = liveBounds(node, gesture);
        const origin = worldToClient({ x: bounds.x, y: bounds.y }) ?? {
          x: 0,
          y: 0,
        };
        const style: React.CSSProperties = {
          left: origin.x + INSET * zoom,
          top: origin.y + TOP * zoom,
          width: Math.max(0, (bounds.width - INSET * 2) * zoom),
          height: Math.max(
            0,
            (bounds.height - NODE_HEADER_HEIGHT - INSET * 2) * zoom,
          ),
        };
        return (
          <div
            className="director-card-face"
            data-testid="director-card-face"
            key={node.id}
            style={style}
          >
            {frame ? (
              <img
                alt=""
                onError={() =>
                  setBrokenFrames((held) => new Set(held).add(frame))
                }
                src={assetThumbUrl(frame, 768)}
              />
            ) : scene ? (
              <DirectorPlan scene={scene} />
            ) : (
              <div className="director-card-empty">
                {t("director:card.sceneMissing")}
              </div>
            )}
            <span className="director-card-badge">3D</span>
            {stale && (
              <span className="director-card-stale">
                {t("director:card.shotNotDelivered")}
              </span>
            )}
            <div className="director-card-status">
              <span>
                {shot
                  ? t("director:card.shotLine", {
                      name: shot.name,
                      seconds: shot.duration,
                    })
                  : t("director:card.noShot")}
              </span>
              <span>
                {scene
                  ? t("director:card.counts", {
                      objects: scene.objects.length,
                      cameras: scene.cameras.length,
                      lights: scene.lights.length,
                    })
                  : ""}
              </span>
              <span>
                {frame
                  ? t("director:card.delivered")
                  : t("director:card.notDelivered")}
              </span>
            </div>
            <button
              className="director-card-enter"
              onClick={(event) => {
                event.stopPropagation();
                openDirector(node.id);
              }}
              type="button"
            >
              {t("director:card.enter")}
            </button>
          </div>
        );
      })}
    </>
  );
}
