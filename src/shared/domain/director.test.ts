import { describe, expect, it } from "vitest";
import {
  DIRECTOR_BACKGROUND,
  DIRECTOR_HUMANOID_BUILDS,
  DIRECTOR_LIMITS,
  DIRECTOR_PALETTE,
  activeShotOf,
  actorFormFor,
  createDirectorScene,
  createPerformer,
  defaultDirectorCamera,
  defaultDirectorShot,
  directorSceneIssues,
  directorTransform,
  freePosition,
  type DirectorScene,
} from "./director";
import { createDirectorNode, createProject, emptyResources } from "./factories";
import { applyCommands } from "./commands";
import { decodeMokaFile, encodeMokaFile } from "./codec";
import { collectAssetReferences, nodeAssetIds } from "./validate";
import type { MokaFile, ResourceEntry } from "./types";

const WHEN = "2026-10-20T00:00:00.000Z";

function resource(id: string, name: string, path: string): ResourceEntry {
  return {
    id,
    name,
    path,
    mime: "image/png",
    bytes: 10,
    sha256: "0".repeat(64),
    createdAt: WHEN,
    updatedAt: WHEN,
  };
}

function projectWithScene(template = "duo"): {
  project: MokaFile;
  scene: DirectorScene;
  nodeId: string;
} {
  const base = createProject("Director");
  const scene = createDirectorScene("Shot 1 · Duo", template);
  const node = createDirectorNode(scene, { x: 0, y: 0 });
  const { next } = applyCommands(base, [
    { type: "addDirectorScene", scene },
    { type: "addNode", canvasId: base.canvas[0].id, node },
  ]);
  return { project: next, scene, nodeId: node.id };
}

describe("director scenes", () => {
  it("builds every template as a valid scene", () => {
    for (const template of [
      "empty",
      "solo",
      "duo",
      "ensemble",
      "tabletop",
    ] as const) {
      const scene = createDirectorScene("Shot", template);
      expect(directorSceneIssues(scene), template).toEqual([]);
      expect(scene.background).toBe(DIRECTOR_BACKGROUND);
    }
    expect(createDirectorScene("Empty", "empty").objects).toEqual([]);
  });

  it("starts at the documented sizes and defaults", () => {
    const scene = createDirectorScene("Shot", "empty");
    expect(scene.cameras[0].focalLength).toBe(40);
    expect(activeShotOf(scene)?.duration).toBe(6);
    expect(activeShotOf(scene)?.fps).toBe(30);
    expect(activeShotOf(scene)?.aspectRatio).toBe("16:9");
    expect(DIRECTOR_HUMANOID_BUILDS.standard.stature).toBe(1.68);
    expect(DIRECTOR_HUMANOID_BUILDS.standard.shoulderSpan).toBe(0.44);
    expect(DIRECTOR_PALETTE).toHaveLength(16);
  });

  it("derives the actor form from the archetype", () => {
    expect(actorFormFor("standard")).toBe("humanoid");
    expect(actorFormFor("dog")).toBe("quadruped");
    expect(actorFormFor("horse")).toBe("quadruped");
  });

  it("keeps template performers out of each other's footprints", () => {
    const scene = createDirectorScene("Shot", "ensemble");
    const spots = scene.objects.map((object) => [
      object.transform.position[0],
      object.transform.position[2],
    ]);
    expect(new Set(spots.map(String)).size).toBe(spots.length);
  });

  it("places a new object beside what is already there", () => {
    const scene = createDirectorScene("Shot", "empty");
    const actor = createPerformer("standard", "Actor", "#e06c75", [0, 0, 0]);
    scene.objects.push(actor);
    const [x, z] = freePosition(
      scene.objects,
      { halfX: 0.4, halfZ: 0.4 },
      {
        x: 0,
        z: 0,
      },
    );
    expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(0.8);
  });

  it("refuses a scene whose shot looks through a missing camera", () => {
    const scene = createDirectorScene("Shot", "empty");
    const camera = defaultDirectorCamera("B");
    scene.cameras.push(camera);
    const shot = defaultDirectorShot("Shot 2", "missing-camera");
    scene.shots.push(shot);
    const issues = directorSceneIssues(scene);
    expect(issues.some((issue) => issue.path === "shots[1].cameraId")).toBe(
      true,
    );
  });

  it("refuses a quadruped carrying humanoid bones", () => {
    const scene = createDirectorScene("Shot", "empty");
    const dog = createPerformer("dog", "Dog", "#d98c3f", [0, 0, 0]);
    dog.boneTracks = [
      {
        bone: "leftHand",
        keyframes: [
          {
            id: "k1",
            time: 0,
            rotation: [0, 0, 0, 1],
          },
        ],
      },
    ];
    scene.objects.push(dog);
    expect(
      directorSceneIssues(scene).some((issue) =>
        issue.message.includes("does not belong"),
      ),
    ).toBe(true);
  });

  it("enforces the object limit and the scene size", () => {
    const scene = createDirectorScene("Shot", "empty");
    scene.objects = Array.from(
      { length: DIRECTOR_LIMITS.maxObjectsPerScene + 1 },
      (_, index) =>
        createPerformer("standard", `Actor ${index}`, "#e06c75", [0, 0, 0]),
    );
    expect(
      directorSceneIssues(scene).some(
        (issue) => issue.code === "DIRECTOR_LIMIT_EXCEEDED",
      ),
    ).toBe(true);
    expect(
      directorSceneIssues(createDirectorScene("Shot"), {
        bytes: DIRECTOR_LIMITS.maxSceneBytes + 1,
      }).some((issue) => issue.code === "DIRECTOR_SCENE_TOO_LARGE"),
    ).toBe(true);
  });

  it("round-trips a scene through the document codec", () => {
    const scene = createDirectorScene("Shot 1 · Duo", "duo");
    scene.title = "把这里设成主角走近的长镜头";
    scene.environment = {
      mode: "panorama",
      assetId: "asset-pano",
      rotationY: 0.5,
      useAsLighting: true,
      lightingIntensity: 0.8,
    };
    scene.objects[1].boneOverrides = { head: [0, 0.2, 0, 0.98] };
    scene.objects[1].keyframes = [
      {
        id: "k1",
        time: 0,
        transform: directorTransform([0, 0, 0]),
        easing: "smooth",
      },
    ];
    const project = createProject("Director");
    project.directorScenes = [scene];
    const decoded = decodeMokaFile(encodeMokaFile(project));
    expect(decoded.directorScenes).toEqual([scene]);
  });

  it("refuses a scene version it does not read", () => {
    const scene = createDirectorScene("Shot");
    scene.schemaVersion = 2 as never;
    const project = createProject("Director");
    project.directorScenes = [scene];
    expect(() => decodeMokaFile(encodeMokaFile(project))).toThrowError(
      /version 2/,
    );
  });
});

describe("director commands", () => {
  it("adds a scene and a card and undoes both", () => {
    const { project, scene, nodeId } = projectWithScene();
    expect(project.directorScenes).toHaveLength(1);
    expect(project.canvas[0].nodes.some((node) => node.id === nodeId)).toBe(
      true,
    );
    const base = createProject("Director");
    const card = createDirectorNode(scene, { x: 0, y: 0 });
    const batch = [
      { type: "addDirectorScene" as const, scene },
      {
        type: "addNode" as const,
        canvasId: base.canvas[0].id,
        node: card,
      },
    ];
    const applied = applyCommands(base, batch);
    const undone = applyCommands(applied.next, applied.inverse).next;
    expect(undone.directorScenes).toBeUndefined();
    expect(undone.canvas[0].nodes).toEqual([]);
  });

  it("replaces a scene whole and restores the previous one", () => {
    const { project, scene } = projectWithScene();
    const nextScene = structuredClone(scene);
    nextScene.title = "Changed";
    nextScene.updatedAt = WHEN;
    const replaced = applyCommands(project, [
      { type: "replaceDirectorScene", sceneId: scene.id, scene: nextScene },
    ]);
    expect(replaced.next.directorScenes?.[0].title).toBe("Changed");
    const undone = applyCommands(replaced.next, replaced.inverse).next;
    expect(undone.directorScenes?.[0].title).toBe(scene.title);
  });

  it("deletes the scene with the last card that opened it", () => {
    const { project, nodeId } = projectWithScene();
    const removed = applyCommands(project, [
      {
        type: "removeNodes",
        canvasId: project.canvas[0].id,
        nodeIds: [nodeId],
      },
    ]);
    expect(removed.next.directorScenes).toBeUndefined();
    // Undoing puts the scene back before the card that opens onto it.
    const undone = applyCommands(removed.next, removed.inverse).next;
    expect(undone.directorScenes).toHaveLength(1);
    expect(undone.canvas[0].nodes[0].id).toBe(nodeId);
  });

  it("does not delete a scene another card still opens", () => {
    const { project, scene, nodeId } = projectWithScene();
    const twin = createDirectorNode(scene, { x: 500, y: 0 });
    const withTwin = applyCommands(project, [
      { type: "addNode", canvasId: project.canvas[0].id, node: twin },
    ]).next;
    const removed = applyCommands(withTwin, [
      {
        type: "removeNodes",
        canvasId: project.canvas[0].id,
        nodeIds: [nodeId],
      },
    ]).next;
    expect(removed.directorScenes).toHaveLength(1);
  });

  it("counts the files its scene reads as in use", () => {
    const { project, scene, nodeId } = projectWithScene();
    const panorama = resource("asset-pano", "stage.jpg", "assets/images/a.jpg");
    const model = resource("asset-model", "actor.glb", "assets/models/a.glb");
    const withAssets: MokaFile = {
      ...project,
      resources: {
        ...emptyResources(),
        images: [panorama],
        models: [model],
      },
    };
    const nextScene = structuredClone(scene);
    nextScene.environment = { mode: "panorama", assetId: panorama.id };
    nextScene.objects[1].assetId = model.id;
    const withScene = applyCommands(withAssets, [
      { type: "replaceDirectorScene", sceneId: scene.id, scene: nextScene },
    ]).next;
    const refs = collectAssetReferences(withScene);
    expect(refs.get(panorama.id)).toEqual([nodeId]);
    expect(refs.get(model.id)).toEqual([nodeId]);
    // The card itself holds no asset; the scene is what points at them.
    const card = withScene.canvas[0].nodes.find((node) => node.id === nodeId);
    expect(card && nodeAssetIds(card)).toEqual([]);
  });
});
