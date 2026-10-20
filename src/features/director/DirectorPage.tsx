import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Euler, Vector3 } from "three";
import {
  actorFormFor,
  createDirectorScene,
  directorSceneOf,
  freePosition,
  objectFootprint,
  type DirectorActorArchetype,
  type DirectorLight,
  type DirectorNodeData,
  type DirectorQuat,
  type DirectorScene,
  type DirectorSolidShape,
  type DirectorTransform,
} from "../../shared/domain";
import { assetUrl, assetsApi } from "../../api";
import { i18n } from "../../shared/i18n";
import { execute } from "../editor/commands/execute";
import { useAppStore } from "../editor/stores/appStore";
import { useProjectStore } from "../editor/stores/projectStore";
import {
  canRender3d,
  lowTextureBudget,
  probeDirectorCapabilities,
} from "./capabilities";
import { DirectorOnboarding } from "./components/DirectorOnboarding";
import { BlockingLanePlaceholder } from "./panels/BlockingLane";
import { DirectorTopBar } from "./panels/DirectorTopBar";
import { ShotCard } from "./panels/ShotCard";
import { StageBoard } from "./panels/StageBoard";
import { ViewportDock } from "./panels/ViewportDock";
import {
  CAMERA_PRESETS,
  addCamera,
  addEnsemble,
  addLight,
  addModelObject,
  addPerformer,
  addPlateObject,
  addShot,
  addSolid,
  cameraFromPreset,
  changeArchetype,
  duplicateObject,
  removeCamera,
  removeLight,
  removeObject,
  setActiveShot,
  updateCamera,
  updateLight,
  updateObject,
  updateScene,
  updateShot,
  type DirectorProp,
} from "./staging";
import {
  StageViewport,
  type DirectorCaptureContext,
} from "./stage/StageViewport";
import type { ModelAnimation } from "./stage/ModelView";
import { autoBoneMap, rigReady } from "./stage/rig";
import { closeDirector, useDirectorStore } from "./stores/directorStore";
import type {
  DirectorPlate,
  DirectorSelection,
  DirectorViewportApi,
} from "./types";

const ONBOARDING_KEY = "moka-canvas:director-onboarding:v1";
const PANEL_MIN = 248;
const PANEL_MAX = 420;

function saveToneOf(
  status: string,
): "saved" | "saving" | "failed" | "conflict" {
  if (status === "saving") return "saving";
  if (status === "conflicted") return "conflict";
  if (status === "error") return "failed";
  return "saved";
}

/**
 * The director desk: a page of its own where a scene is staged.
 *
 * The room reads the scene from the document and writes every committed
 * change back as a whole-scene replacement. The draft in the room's store is
 * the authority while the page is open; the document is what survives it.
 */
export function DirectorPage() {
  const { t } = useTranslation(["director", "editor"]);
  const nodeId = useDirectorStore((state) => state.nodeId);
  const draft = useDirectorStore((state) => state.draft);
  const mode = useDirectorStore((state) => state.mode);
  const view = useDirectorStore((state) => state.view);
  const renderMode = useDirectorStore((state) => state.renderMode);
  const transformMode = useDirectorStore((state) => state.transformMode);
  const selection = useDirectorStore((state) => state.selection);
  const playhead = useDirectorStore((state) => state.playhead);
  const saveError = useDirectorStore((state) => state.saveError);
  const past = useDirectorStore((state) => state.past);
  const future = useDirectorStore((state) => state.future);
  const moka = useProjectStore((state) => state.moka);
  const saveStatus = useProjectStore((state) => state.saveStatus);
  const projectSaveError = useProjectStore((state) => state.saveError);
  const [capabilities] = useState(probeDirectorCapabilities);
  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(330);
  const [leftOpen, setLeftOpen] = useState(
    () => !window.matchMedia("(max-width: 960px)").matches,
  );
  const [rightOpen, setRightOpen] = useState(
    () => !window.matchMedia("(max-width: 1180px)").matches,
  );
  const [motionOpen, setMotionOpen] = useState(true);
  const [onboarding, setOnboarding] = useState(0);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [exit, setExit] = useState<"conflict" | "error" | null>(null);
  const [uploading, setUploading] = useState(false);
  const capture = useRef<DirectorCaptureContext | null>(null);
  const viewportApi = useRef<DirectorViewportApi | null>(null);

  const canvas = moka?.canvas.find((item) =>
    item.nodes.some((node) => node.id === nodeId),
  );
  const node = canvas?.nodes.find((item) => item.id === nodeId);
  const documentScene = moka && node ? directorSceneOf(moka, node) : undefined;
  const scene =
    draft && documentScene && draft.id === documentScene.id
      ? draft
      : documentScene;
  const selectionAvailable =
    selection &&
    scene &&
    (selection.kind === "object"
      ? scene.objects.some((object) => object.id === selection.id)
      : selection.kind === "camera"
        ? scene.cameras.some((camera) => camera.id === selection.id)
        : scene.lights.some((light) => light.id === selection.id));

  // The room opens onto the card's scene and follows the document when it is
  // replaced elsewhere; its own writes carry the same timestamp and are left
  // alone.
  useEffect(() => {
    if (!node || !documentScene) return;
    const room = useDirectorStore.getState();
    if (room.nodeId !== node.id || room.draft?.id !== documentScene.id) {
      room.open(node.id, documentScene);
    } else {
      room.sync(documentScene);
    }
  }, [node, documentScene]);

  useEffect(() => {
    if (!selectionAvailable && selection) {
      useDirectorStore.getState().setSelection(null);
    }
  }, [selectionAvailable, selection]);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(ONBOARDING_KEY) === null) {
        setOnboardingOpen(true);
      }
    } catch {
      // A machine that will not remember the guide shows it once on each
      // visit; the guide itself still works.
    }
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 960px)");
    const follow = () => {
      if (!query.matches) return;
      setLeftOpen(false);
      setRightOpen(false);
    };
    follow();
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);

  const edit = useCallback(
    (recipe: (scene: DirectorScene) => DirectorScene) =>
      useDirectorStore.getState().edit(recipe),
    [],
  );

  const anchor = useCallback((): [number, number] => {
    const current = useDirectorStore.getState().selection;
    const active = current ? useDirectorStore.getState().draft : null;
    const object =
      active && current?.kind === "object"
        ? active.objects.find((entry) => entry.id === current.id)
        : undefined;
    if (object) {
      return [object.transform.position[0], object.transform.position[2]];
    }
    return [0, 0];
  }, []);

  const notify = (message: string, detail?: string) =>
    useAppStore.getState().pushToast("error", message, undefined, detail);

  const addPerformerOf = (archetype: DirectorActorArchetype) => {
    let created: string | null = null;
    edit((current) => {
      const result = addPerformer(current, archetype, anchor());
      created = result.id;
      return result.scene;
    });
    if (created) {
      useDirectorStore.getState().setSelection({ kind: "object", id: created });
    }
  };

  const addEnsembleOf = () => {
    let first: string | null = null;
    edit((current) => {
      const result = addEnsemble(current, anchor());
      first = result.ids[0] ?? null;
      return result.scene;
    });
    if (first) {
      useDirectorStore.getState().setSelection({ kind: "object", id: first });
    }
  };

  const addPropOf = (prop: DirectorProp) => {
    let created: string | null = null;
    edit((current) => {
      const result = addSolid(
        current,
        prop.shape,
        prop.size,
        i18n.t(`director:props.${prop.id}`),
        anchor(),
        prop.color,
      );
      created = result.id;
      return result.scene;
    });
    if (created) {
      useDirectorStore.getState().setSelection({ kind: "object", id: created });
    }
  };

  const addSolidOf = (shape: DirectorSolidShape) => {
    const size: [number, number, number] =
      shape === "sphere"
        ? [0.5, 0.5, 0.5]
        : shape === "cylinder"
          ? [0.5, 1, 0.5]
          : shape === "plane"
            ? [2, 2, 1]
            : [1, 1, 1];
    let created: string | null = null;
    edit((current) => {
      const result = addSolid(
        current,
        shape,
        size,
        i18n.t(`director:shapes.${shape}`),
        anchor(),
      );
      created = result.id;
      return result.scene;
    });
    if (created) {
      useDirectorStore.getState().setSelection({ kind: "object", id: created });
    }
  };

  const addModelOf = (assetId: string, name: string) => {
    let created: string | null = null;
    edit((current) => {
      const result = addModelObject(current, assetId, name, anchor());
      created = result.id;
      return result.scene;
    });
    if (created) {
      useDirectorStore.getState().setSelection({ kind: "object", id: created });
    }
  };

  const addCameraOf = (presetIndex: number) => {
    let created: string | null = null;
    edit((current) => {
      const result =
        presetIndex >= 0
          ? cameraFromPreset(current, CAMERA_PRESETS[presetIndex])
          : addCamera(current);
      created = result.id;
      return result.scene;
    });
    if (created) {
      useDirectorStore.getState().setSelection({ kind: "camera", id: created });
      useDirectorStore.getState().setView("camera");
    }
  };

  const addLightOf = (type: DirectorLight["type"]) => {
    let created: string | null = null;
    edit((current) => {
      const result = addLight(current, type);
      created = result.id;
      return result.scene;
    });
    if (created) {
      useDirectorStore.getState().setSelection({ kind: "light", id: created });
    }
  };

  const removeSelected = (target: DirectorSelection | null = selection) => {
    if (!target) return;
    if (target.kind === "camera" && (scene?.cameras.length ?? 0) <= 1) {
      notify(t("director:cameras.lastOne"));
      return;
    }
    edit((current) =>
      target.kind === "object"
        ? removeObject(current, target.id)
        : target.kind === "light"
          ? removeLight(current, target.id)
          : removeCamera(current, target.id),
    );
    useDirectorStore.getState().setSelection(null);
  };

  const duplicateSelected = (target: DirectorSelection | null = selection) => {
    if (!target) return;
    if (target.kind === "object") {
      let created: string | null = null;
      edit((current) => {
        const result = duplicateObject(current, target.id);
        if (!result) return current;
        created = result.id;
        return result.scene;
      });
      if (created) {
        useDirectorStore
          .getState()
          .setSelection({ kind: "object", id: created });
      }
      return;
    }
    if (target.kind === "camera") {
      const source = scene?.cameras.find((camera) => camera.id === target.id);
      if (!source) return;
      const settings = structuredClone(source);
      delete (settings as { id?: string }).id;
      let created: string | null = null;
      edit((current) => {
        const result = addCamera(current, {
          ...settings,
          name: i18n.t("director:staging.copyOf", { name: source.name }),
        });
        created = result.id;
        return result.scene;
      });
      if (created) {
        useDirectorStore
          .getState()
          .setSelection({ kind: "camera", id: created });
      }
      return;
    }
    const source = scene?.lights.find((light) => light.id === target.id);
    if (!source) return;
    let created: string | null = null;
    edit((current) => {
      const result = addLight(current, source.type);
      created = result.id;
      return updateLight(result.scene, result.id, {
        ...structuredClone(source),
        id: result.id,
        name: i18n.t("director:staging.copyOf", { name: source.name }),
      });
    });
    if (created) {
      useDirectorStore.getState().setSelection({ kind: "light", id: created });
    }
  };

  const toggleVisible = (objectId: string) => {
    edit((current) => {
      const object = current.objects.find((entry) => entry.id === objectId);
      return object
        ? updateObject(current, objectId, { visible: !object.visible })
        : current;
    });
  };

  const changeArchetypeOf = (id: string, archetype: DirectorActorArchetype) => {
    const object = scene?.objects.find((entry) => entry.id === id);
    if (!object) return;
    if (object.archetype) {
      const before = actorFormFor(object.archetype);
      const after = actorFormFor(archetype);
      if (
        before !== after &&
        !window.confirm(t("director:actors.crossFormConfirm"))
      ) {
        return;
      }
    }
    edit((current) => changeArchetype(current, id, archetype));
  };

  const onTransformPreview = (
    target: DirectorSelection,
    transform: DirectorTransform,
  ) => {
    const room = useDirectorStore.getState();
    const base = room.gesture ?? room.draft;
    if (!base) return;
    room.update((current) => {
      if (target.kind === "object") {
        return updateObject(current, target.id, { transform });
      }
      if (target.kind === "light") {
        return updateLight(current, target.id, { transform });
      }
      const baseCamera = base.cameras.find((camera) => camera.id === target.id);
      if (!baseCamera) return current;
      let nextTarget = baseCamera.target;
      if (transformMode === "translate") {
        nextTarget = [
          baseCamera.target[0] +
            (transform.position[0] - baseCamera.transform.position[0]),
          baseCamera.target[1] +
            (transform.position[1] - baseCamera.transform.position[1]),
          baseCamera.target[2] +
            (transform.position[2] - baseCamera.transform.position[2]),
        ];
      } else if (transformMode === "rotate") {
        const distance = Math.max(
          1e-4,
          new Vector3(...baseCamera.target)
            .sub(new Vector3(...baseCamera.transform.position))
            .length(),
        );
        const direction = new Vector3(0, 0, -1).applyEuler(
          new Euler(...transform.rotation),
        );
        nextTarget = [
          transform.position[0] + direction.x * distance,
          transform.position[1] + direction.y * distance,
          transform.position[2] + direction.z * distance,
        ];
      }
      return updateCamera(current, target.id, {
        transform: { ...transform, scale: [1, 1, 1] },
        target: nextTarget,
      });
    });
  };

  const onBonePreview = (target: DirectorSelection, rotation: DirectorQuat) => {
    if (!target.bone) return;
    useDirectorStore.getState().update((current) => {
      const object = current.objects.find((entry) => entry.id === target.id);
      if (!object) return current;
      return updateObject(current, target.id, {
        boneOverrides: {
          ...(object.boneOverrides ?? {}),
          [target.bone!]: rotation,
        },
      });
    });
  };

  const handleModelLoaded = useCallback(
    (objectId: string, animations: ModelAnimation[], boneNames: string[]) => {
      const current = useDirectorStore.getState().draft;
      const object = current?.objects.find((entry) => entry.id === objectId);
      if (!object) return;
      const names = animations.map((animation) => animation.name);
      const heldNames = object.rig?.animationNames ?? [];
      const sameRig =
        [...heldNames].sort().join("\u0000") ===
        [...names].sort().join("\u0000");
      const hasClips = (object.motionClips?.length ?? 0) > 0;
      const boneMap = object.kind === "performer" ? autoBoneMap(boneNames) : {};
      // A model turned into a performer needs its joints read again even when
      // its animation list has not changed: the first loading saw a model and
      // deliberately mapped nothing.
      const needsMapping =
        object.kind === "performer" &&
        rigReady(boneMap) &&
        object.rig?.status !== "ready";
      if (sameRig && (hasClips || animations.length === 0) && !needsMapping) {
        return;
      }
      const rig = {
        status: (object.kind === "performer" && rigReady(boneMap)
          ? "ready"
          : "unmapped") as "ready" | "unmapped",
        boneMap,
        animationNames: names,
      };
      const clips =
        sameRig && object.motionClips?.length
          ? object.motionClips
          : animations.map((animation) => ({
              id: crypto.randomUUID(),
              name: animation.name,
              sourceAnimation: animation.name,
              start: 0,
              duration: animation.duration,
              playbackRate: 1,
              loop: true,
            }));
      const active = clips.some((clip) => clip.id === object.activeMotionClipId)
        ? object.activeMotionClipId
        : clips[0]?.id;
      edit((scene) =>
        updateObject(scene, objectId, {
          rig,
          motionClips: clips,
          ...(active !== undefined ? { activeMotionClipId: active } : {}),
        }),
      );
    },
    [edit],
  );

  const useAsPerformer = (id: string) => {
    edit((current) => {
      const object = current.objects.find((entry) => entry.id === id);
      if (!object) return current;
      return updateObject(current, id, {
        kind: "performer",
        archetype: object.archetype ?? "standard",
        pose: object.pose ?? "neutral",
      });
    });
  };

  const placeOnGround = (x: number, z: number) => {
    const target = useDirectorStore.getState().selection;
    if (target?.kind !== "object") return;
    edit((current) => {
      const object = current.objects.find((entry) => entry.id === target.id);
      if (!object) return current;
      const others = current.objects.filter((entry) => entry.id !== target.id);
      const [placedX, placedZ] = freePosition(others, objectFootprint(object), {
        x,
        z,
      });
      return updateObject(current, target.id, {
        transform: {
          ...object.transform,
          position: [placedX, object.transform.position[1], placedZ],
        },
      });
    });
  };

  const uploadModel = async (file: File) => {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (extension !== "glb" && extension !== "gltf") {
      notify(
        t("director:models.unsupported", { ext: extension || file.name }),
        t("director:models.exportGlb"),
      );
      return;
    }
    setUploading(true);
    try {
      await useProjectStore.getState().flush();
      const saved = await assetsApi.upload(file, { categoryHint: "models" });
      useProjectStore.getState().integrateAssetEntry(saved.entry, {
        revision: saved.revision,
        updatedAt: saved.updatedAt,
      });
      addModelOf(saved.entry.id, saved.entry.name);
      useAppStore
        .getState()
        .pushToast(
          "success",
          t("director:models.uploaded", { name: saved.entry.name }),
        );
    } catch (error) {
      notify(
        error instanceof Error ? error.message : String(error),
        t("director:models.uploadFailed"),
      );
    } finally {
      setUploading(false);
    }
  };

  const plates: DirectorPlate[] = useMemo(() => {
    if (!canvas || !node) return [];
    return canvas.edges
      .filter(
        (edge) =>
          edge.target.nodeId === node.id && edge.target.portId === "plates",
      )
      .map((edge) => {
        const source = canvas.nodes.find(
          (candidate) => candidate.id === edge.source.nodeId,
        );
        const assetId = (source?.data as { assetId?: string })?.assetId;
        return {
          nodeId: edge.source.nodeId,
          title: source?.title ?? edge.source.nodeId,
          assetId,
        };
      });
  }, [canvas, node]);

  const leave = async () => {
    const project = useProjectStore.getState();
    if (project.saveStatus === "conflicted") {
      setExit("conflict");
      return;
    }
    await project.flush();
    const after = useProjectStore.getState().saveStatus;
    if (after === "conflicted" || after === "error") {
      setExit(after === "conflicted" ? "conflict" : "error");
      return;
    }
    closeDirector();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        target.closest(
          "input, textarea, select, [contenteditable='true'], [role='textbox']",
        )
      ) {
        return;
      }
      const room = useDirectorStore.getState();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) room.redo();
        else room.undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        room.redo();
        return;
      }
      if (event.key === "Escape") {
        if (room.gesture) room.cancelGesture();
        else room.setSelection(null);
        return;
      }
      if (event.key === "w" || event.key === "W")
        room.setTransformMode("translate");
      if (event.key === "e" || event.key === "E")
        room.setTransformMode("rotate");
      if (event.key === "r" || event.key === "R")
        room.setTransformMode("scale");
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        room.selection
      ) {
        event.preventDefault();
        removeSelected(room.selection);
      }
      if (
        (event.key === "h" || event.key === "H") &&
        room.selection?.kind === "object"
      ) {
        toggleVisible(room.selection.id);
      }
      if (event.key === " ") {
        event.preventDefault();
        room.setPlaying(!room.playing);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const beginResize = (side: "left" | "right", event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === "left" ? leftWidth : rightWidth;
    const move = (pointer: PointerEvent) => {
      const delta =
        side === "left" ? pointer.clientX - startX : startX - pointer.clientX;
      const width = Math.max(
        PANEL_MIN,
        Math.min(PANEL_MAX, startWidth + delta),
      );
      if (side === "left") setLeftWidth(width);
      else setRightWidth(width);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const recover = () => {
    if (!node || !canvas) return;
    const fresh = createDirectorScene(node.title);
    const data = node.data as DirectorNodeData;
    execute(i18n.t("editor:history.createDirector"), [
      { type: "addDirectorScene", scene: fresh },
      {
        type: "updateNode",
        canvasId: canvas.id,
        nodeId: node.id,
        patch: { data: { director: { ...data.director, sceneId: fresh.id } } },
      },
    ]);
  };

  const saveTone = saveToneOf(saveStatus);
  const saveLabel = t(`director:save.${saveTone}`);
  const rawSaveError = projectSaveError ?? saveError ?? null;

  if (!node || !canvas) {
    return (
      <main
        aria-label={t("director:page.title")}
        className="director-page"
        data-testid="director-page"
      >
        <header className="director-topbar">
          <button className="button" onClick={closeDirector} type="button">
            {t("director:page.back")}
          </button>
          <h1>{t("director:page.title")}</h1>
        </header>
        <section className="director-capability" role="alert">
          <h2>{t("director:page.nodeMissing.title")}</h2>
          <p>{t("director:page.nodeMissing.body")}</p>
        </section>
      </main>
    );
  }

  if (!scene) {
    return (
      <main
        aria-label={t("director:page.title")}
        className="director-page"
        data-testid="director-page"
      >
        <header className="director-topbar">
          <button className="button" onClick={closeDirector} type="button">
            {t("director:page.back")}
          </button>
          <h1>{node.title}</h1>
        </header>
        <section className="director-capability" role="alert">
          <h2>{t("director:page.sceneMissing.title")}</h2>
          <p>{t("director:page.sceneMissing.body", { title: node.title })}</p>
          <button className="button" onClick={recover} type="button">
            {t("director:page.sceneMissing.recover")}
          </button>
        </section>
      </main>
    );
  }

  const models = moka?.resources.models ?? [];
  const images = moka?.resources.images ?? [];

  return (
    <main
      aria-label={t("director:page.title")}
      className="director-page"
      data-testid="director-page"
    >
      <DirectorTopBar
        canRedo={future.length > 0}
        canUndo={past.length > 0}
        deliverDisabled
        delivering={false}
        mode={mode}
        onAddShot={() => {
          let created: string | null = null;
          edit((current) => {
            const result = addShot(current);
            created = result.id;
            return result.scene;
          });
          if (created) useDirectorStore.getState().setPlayhead(0);
        }}
        onBack={() => void leave()}
        onDeliver={() => undefined}
        onMode={(next) => useDirectorStore.getState().setMode(next)}
        onRedo={() => useDirectorStore.getState().redo()}
        onRenderMode={(next) => useDirectorStore.getState().setRenderMode(next)}
        onRetrySave={() => void useProjectStore.getState().flush()}
        onSelectShot={(id) => {
          edit((current) => setActiveShot(current, id));
          useDirectorStore.getState().setPlayhead(0);
        }}
        onUndo={() => useDirectorStore.getState().undo()}
        onOnboarding={() => {
          setOnboarding(0);
          setOnboardingOpen(true);
        }}
        saveLabel={saveLabel}
        saveTone={saveTone}
        scene={scene}
        renderMode={renderMode}
      />

      {saveStatus === "conflicted" && (
        <div className="director-conflict" role="alert">
          <span>{t("director:save.conflictBanner")}</span>
          <button
            className="button"
            onClick={() =>
              void useProjectStore.getState().reload({ discardPending: true })
            }
            type="button"
          >
            {t("director:save.reload")}
          </button>
        </div>
      )}
      {rawSaveError && saveStatus !== "conflicted" && (
        <details className="director-save-error" role="alert">
          <summary>{saveLabel}</summary>
          <pre>{rawSaveError}</pre>
          <button
            className="button"
            onClick={() => void useProjectStore.getState().flush()}
            type="button"
          >
            {t("director:save.retry")}
          </button>
        </details>
      )}

      {!canRender3d(capabilities) ? (
        <section className="director-capability" role="alert">
          <h2>{t("director:capability.title")}</h2>
          <p>{t("director:capability.body")}</p>
          <pre>
            {t("director:capability.reason", {
              reason: capabilities.failure,
            })}
          </pre>
        </section>
      ) : (
        <div className="director-body">
          {leftOpen && (
            <>
              <div style={{ width: leftWidth }}>
                <StageBoard
                  models={models}
                  onAddCamera={addCameraOf}
                  onAddEnsemble={addEnsembleOf}
                  onAddLight={addLightOf}
                  onAddModel={addModelOf}
                  onAddPerformer={addPerformerOf}
                  onAddProp={addPropOf}
                  onAddSolid={addSolidOf}
                  onDuplicate={duplicateSelected}
                  onRemove={removeSelected}
                  onSelect={(next) =>
                    useDirectorStore.getState().setSelection(next)
                  }
                  onSetPanorama={(plate) => {
                    if (!plate.assetId) return;
                    edit((current) =>
                      updateScene(current, {
                        environment: {
                          mode: "panorama",
                          assetId: plate.assetId,
                          rotationY: 0,
                          exposure: 1,
                          useAsLighting: false,
                          lightingIntensity: 1,
                        },
                      }),
                    );
                  }}
                  onSetPlate={(plate) => {
                    if (!plate.assetId) return;
                    let created: string | null = null;
                    edit((current) => {
                      const result = addPlateObject(
                        current,
                        plate.assetId!,
                        plate.title,
                        plate.nodeId,
                      );
                      created = result.id;
                      return result.scene;
                    });
                    if (created) {
                      useDirectorStore
                        .getState()
                        .setSelection({ kind: "object", id: created });
                    }
                  }}
                  onToggleVisible={toggleVisible}
                  onUploadModel={(file) => void uploadModel(file)}
                  onViewImage={(plate) => {
                    if (plate.assetId) setLightbox(plate.assetId);
                  }}
                  plates={plates}
                  scene={scene}
                  selection={selection}
                />
              </div>
              <div
                aria-label={t("director:board.resize")}
                className="director-resizer"
                onPointerDown={(event) => beginResize("left", event)}
                role="separator"
              />
            </>
          )}
          <div className="director-center">
            <StageViewport
              apiRef={viewportApi}
              onBonePreview={onBonePreview}
              onCameraFallback={() => {
                useDirectorStore.getState().setView("free");
              }}
              onCaptureContext={(context) => {
                capture.current = context;
              }}
              onGestureEnd={() => useDirectorStore.getState().commitGesture()}
              onGestureStart={() => useDirectorStore.getState().beginGesture()}
              onGroundPoint={placeOnGround}
              onModelLoaded={handleModelLoaded}
              onSelect={(next) =>
                useDirectorStore.getState().setSelection(next)
              }
              onTransformPreview={onTransformPreview}
              playhead={playhead}
              renderMode={renderMode}
              scene={scene}
              selection={selection}
              transformMode={transformMode}
              view={view}
            />
            <ViewportDock
              canTransform={selection !== null && view === "free"}
              leftOpen={leftOpen}
              onDolly={(factor) => viewportApi.current?.dolly(factor)}
              onFitAll={() => viewportApi.current?.fitAll()}
              onFocusSelection={() => viewportApi.current?.focusSelection()}
              onResetView={() => viewportApi.current?.resetView()}
              onToggleLeft={() => setLeftOpen((held) => !held)}
              onToggleMotion={() => {
                if (mode !== "motion") {
                  useDirectorStore.getState().setMode("motion");
                  setMotionOpen(true);
                } else {
                  setMotionOpen((held) => !held);
                }
              }}
              onToggleRight={() => setRightOpen((held) => !held)}
              onTransformMode={(next) =>
                useDirectorStore.getState().setTransformMode(next)
              }
              onView={(next) => useDirectorStore.getState().setView(next)}
              rightOpen={rightOpen}
              transformMode={transformMode}
              view={view}
            />
            {mode === "motion" && (
              <BlockingLanePlaceholder
                collapsed={!motionOpen}
                onCollapse={() => setMotionOpen((held) => !held)}
              />
            )}
          </div>
          {rightOpen && (
            <>
              <div
                aria-label={t("director:cardPanel.resize")}
                className="director-resizer"
                onPointerDown={(event) => beginResize("right", event)}
                role="separator"
              />
              <div style={{ width: rightWidth }}>
                <ShotCard
                  images={images}
                  models={models}
                  onArchetype={changeArchetypeOf}
                  onBone={(id, bone, rotation) =>
                    edit((current) => {
                      const object = current.objects.find(
                        (entry) => entry.id === id,
                      );
                      if (!object) return current;
                      const overrides = { ...(object.boneOverrides ?? {}) };
                      if (rotation) overrides[bone] = rotation;
                      else delete overrides[bone];
                      return updateObject(current, id, {
                        boneOverrides: overrides,
                      });
                    })
                  }
                  onCamera={(id, patch) =>
                    edit((current) => updateCamera(current, id, patch))
                  }
                  onCameraSelect={(shotId, cameraId) =>
                    edit((current) => updateShot(current, shotId, { cameraId }))
                  }
                  onLight={(id, patch) =>
                    edit((current) => updateLight(current, id, patch))
                  }
                  onObject={(id, patch) =>
                    edit((current) => updateObject(current, id, patch))
                  }
                  onScene={(patch) =>
                    edit((current) => updateScene(current, patch))
                  }
                  onSelect={(next) =>
                    useDirectorStore.getState().setSelection(next)
                  }
                  onShot={(id, patch) =>
                    edit((current) => updateShot(current, id, patch))
                  }
                  onUseAsPerformer={useAsPerformer}
                  playhead={playhead}
                  scene={scene}
                  selection={selection}
                />
              </div>
            </>
          )}
        </div>
      )}

      {lowTextureBudget(capabilities) && (
        <p className="director-capability-note" role="status">
          {t("director:capability.lowTexture", {
            size: capabilities.maxTextureSize,
          })}
        </p>
      )}
      {uploading && (
        <p className="director-capability-note" role="status">
          {t("director:models.uploading")}
        </p>
      )}
      <DirectorOnboarding
        onBack={() => setOnboarding((held) => Math.max(0, held - 1))}
        onFinish={() => {
          try {
            window.localStorage.setItem(ONBOARDING_KEY, "done");
          } catch {
            // The guide is still finished for this visit.
          }
          setOnboardingOpen(false);
        }}
        onNext={() => setOnboarding((held) => held + 1)}
        onSkip={() => {
          try {
            window.localStorage.setItem(ONBOARDING_KEY, "skipped");
          } catch {
            // The guide is still skipped for this visit.
          }
          setOnboardingOpen(false);
        }}
        open={onboardingOpen}
        step={onboarding}
      />
      {lightbox && (
        <div
          className="dialog-backdrop"
          onClick={() => setLightbox(null)}
          role="presentation"
        >
          <div className="dialog director-lightbox" role="dialog">
            <img alt="" src={assetUrl(lightbox)} />
            <div className="dialog-actions">
              <button
                className="button"
                onClick={() => setLightbox(null)}
                type="button"
              >
                {t("editor:action.close")}
              </button>
            </div>
          </div>
        </div>
      )}
      {exit && (
        <div className="dialog-backdrop" role="presentation">
          <div aria-modal="true" className="dialog" role="alertdialog">
            <h2>
              {exit === "conflict"
                ? t("director:exit.conflictTitle")
                : t("director:exit.errorTitle")}
            </h2>
            <p>{t("director:exit.body")}</p>
            <pre>{rawSaveError ?? ""}</pre>
            <div className="dialog-actions">
              <button
                className="button"
                onClick={() => setExit(null)}
                type="button"
              >
                {t("director:exit.stay")}
              </button>
              {exit === "conflict" && (
                <button
                  className="button"
                  onClick={() => {
                    void useProjectStore
                      .getState()
                      .reload({ discardPending: true })
                      .then((ok) => {
                        if (ok) setExit(null);
                      });
                  }}
                  type="button"
                >
                  {t("director:save.reload")}
                </button>
              )}
              <button
                className="button is-primary"
                onClick={() => {
                  setExit(null);
                  void useProjectStore
                    .getState()
                    .flush()
                    .then(() => {
                      if (useProjectStore.getState().saveStatus === "saved") {
                        closeDirector();
                      }
                    });
                }}
                type="button"
              >
                {t("director:exit.retry")}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
