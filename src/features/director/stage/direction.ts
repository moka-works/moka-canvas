import {
  shotCamera,
  type DirectorActorArchetype,
  type DirectorCameraMove,
  type DirectorObject,
  type DirectorPose,
  type DirectorScene,
  type DirectorShot,
  type DirectorShotSize,
} from "../../../shared/domain";

/** How a file an object reads is named in the prompt. */
export type DirectionAssetName = (assetId: string) => string | undefined;

function number(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function formatPoint(point: [number, number, number]): string {
  return `(${number(point[0])}, ${number(point[1])}, ${number(point[2])})`;
}

const SHOT_SIZE_EN: Record<DirectorShotSize, string> = {
  extreme_wide: "extreme wide shot",
  wide: "wide shot",
  full: "full shot",
  medium: "medium shot",
  close_up: "close-up",
  extreme_close_up: "extreme close-up",
};
const SHOT_SIZE_ZH: Record<DirectorShotSize, string> = {
  extreme_wide: "大远景",
  wide: "远景",
  full: "全身景",
  medium: "中景",
  close_up: "近景特写",
  extreme_close_up: "大特写",
};
const MOVE_EN: Record<DirectorCameraMove, string> = {
  static: "static camera",
  push_in: "slow push-in",
  pull_out: "slow pull-out",
  pan_left: "pan left",
  pan_right: "pan right",
  tilt_up: "tilt up",
  tilt_down: "tilt down",
  orbit_left: "orbit left around the subject",
  orbit_right: "orbit right around the subject",
  handheld: "restrained handheld movement",
};
const MOVE_ZH: Record<DirectorCameraMove, string> = {
  static: "固定机位",
  push_in: "镜头缓慢推进",
  pull_out: "镜头缓慢拉远",
  pan_left: "镜头向左横摇",
  pan_right: "镜头向右横摇",
  tilt_up: "镜头向上摇摄",
  tilt_down: "镜头向下摇摄",
  orbit_left: "镜头向左环绕主体",
  orbit_right: "镜头向右环绕主体",
  handheld: "克制的手持摄影运动",
};
const ARCHETYPE_EN: Record<DirectorActorArchetype, string> = {
  standard: "humanoid · standard",
  youth: "humanoid · youth",
  senior: "humanoid · senior",
  broad: "humanoid · broad",
  slim: "humanoid · slim",
  stylized: "humanoid · stylized",
  dog: "quadruped · dog",
  horse: "quadruped · horse",
};
const ARCHETYPE_ZH: Record<DirectorActorArchetype, string> = {
  standard: "人形·标准成人",
  youth: "人形·少年",
  senior: "人形·长者",
  broad: "人形·魁梧",
  slim: "人形·纤细",
  stylized: "人形·卡通比例",
  dog: "四足·犬型",
  horse: "四足·马型",
};
const POSE_EN: Record<DirectorPose, string> = {
  neutral: "natural stance",
  stand: "standing",
  t_pose: "T-pose",
  walk: "walking",
  run: "running",
  sit: "sitting",
  squat: "squatting",
  kneel_single: "kneeling on one knee",
  kneel_double: "kneeling",
  hands_hips: "hands on hips",
  lean: "leaning",
  bow: "bowing",
  think: "thinking",
  fight: "fighting stance",
  kick: "kicking",
  throw: "throwing",
  push: "pushing",
  wave: "waving",
  reach: "reaching out",
  arms_crossed: "arms crossed",
  phone: "looking at a phone",
  animal_stand: "standing",
  animal_sit: "sitting",
  animal_lie: "lying down",
  animal_walk: "walking",
  animal_run: "running",
  animal_alert: "alert",
};
const POSE_ZH: Record<DirectorPose, string> = {
  neutral: "自然站立",
  stand: "站立",
  t_pose: "T 型",
  walk: "行走",
  run: "跑步",
  sit: "坐姿",
  squat: "蹲下",
  kneel_single: "单膝跪",
  kneel_double: "双膝跪",
  hands_hips: "叉腰",
  lean: "倚靠",
  bow: "鞠躬",
  think: "思考",
  fight: "格斗",
  kick: "踢",
  throw: "投掷",
  push: "推",
  wave: "招手",
  reach: "伸手",
  arms_crossed: "抱臂",
  phone: "看手机",
  animal_stand: "站立",
  animal_sit: "坐",
  animal_lie: "卧",
  animal_walk: "走",
  animal_run: "跑",
  animal_alert: "警觉",
};

function cameraPlacement(
  scene: DirectorScene,
  shot: DirectorShot,
  locale: "en" | "zh",
): string | null {
  const camera = shotCamera(scene, shot);
  if (!camera) return null;
  const [cx, cy, cz] = camera.transform.position;
  const [tx, ty, tz] = camera.target;
  const height =
    cy < ty - 0.4
      ? locale === "zh"
        ? "低机位"
        : "low angle"
      : cy > ty + 1.2
        ? locale === "zh"
          ? "高机位"
          : "high angle"
        : locale === "zh"
          ? "平视机位"
          : "eye level";
  const side =
    cx < tx - 0.8
      ? locale === "zh"
        ? "主体左前侧"
        : "front left of the subject"
      : cx > tx + 0.8
        ? locale === "zh"
          ? "主体右前侧"
          : "front right of the subject"
        : locale === "zh"
          ? "主体正面"
          : "in front of the subject";
  const distance = Math.hypot(cx - tx, cy - ty, cz - tz);
  if (locale === "zh") {
    return `摄影机：${number(camera.focalLength)}mm 焦段，f/${number(camera.aperture)} 光圈，焦点距离 ${number(camera.focusDistance)} 米，${height}，位于${side}，机位距离约 ${number(distance)} 米，焦点指向 ${formatPoint(camera.target)}，景深遵循真实镜头光学。`;
  }
  return `Camera: ${number(camera.focalLength)}mm lens, f/${number(camera.aperture)}, focus distance ${number(camera.focusDistance)} m, ${height}, ${side}, about ${number(distance)} m away, looking at ${formatPoint(camera.target)}, with true lens depth of field.`;
}

function actorLine(object: DirectorObject, locale: "en" | "zh"): string | null {
  if (object.kind !== "performer") return null;
  const archetype =
    object.archetype &&
    (locale === "zh"
      ? ARCHETYPE_ZH[object.archetype]
      : ARCHETYPE_EN[object.archetype]);
  if (!archetype) return null;
  const pose = object.pose
    ? locale === "zh"
      ? POSE_ZH[object.pose]
      : POSE_EN[object.pose]
    : locale === "zh"
      ? "自然站立"
      : "natural stance";
  return locale === "zh"
    ? `${object.name}，${archetype}，${object.color} 参考色位于 ${formatPoint(object.transform.position)}，姿势${pose}`
    : `${object.name}, ${archetype}, ${object.color} reference colour at ${formatPoint(object.transform.position)}, ${pose}`;
}

function objectLine(
  object: DirectorObject,
  locale: "en" | "zh",
  assetName: DirectionAssetName,
): string | null {
  if (object.kind === "performer") return null;
  const asset = object.assetId ? assetName(object.assetId) : undefined;
  if (locale === "zh") {
    return asset
      ? `${object.name}（读取素材 ${asset}）位于 ${formatPoint(object.transform.position)}`
      : `${object.name}位于 ${formatPoint(object.transform.position)}`;
  }
  return asset
    ? `${object.name} (asset ${asset}) at ${formatPoint(object.transform.position)}`
    : `${object.name} at ${formatPoint(object.transform.position)}`;
}

/**
 * A shot as the video model is told it, in one deterministic piece.
 *
 * Everything that is read is read from the document in a fixed order, and
 * every number is rounded the same way, so compiling the same scene twice
 * gives the same bytes. The words are fixed when the shot is delivered: a
 * language change afterwards does not rewrite a prompt the downstream run
 * was already handed.
 */
export function compileDirection(
  scene: DirectorScene,
  shot: DirectorShot,
  locale: "en" | "zh",
  assetName: DirectionAssetName = () => undefined,
): string {
  const zh = locale === "zh";
  const parts: string[] = [];
  if (shot.prompt.trim()) parts.push(shot.prompt.trim());
  parts.push(
    zh
      ? `镜头设计：${SHOT_SIZE_ZH[shot.shotSize]}，${MOVE_ZH[shot.cameraMove]}，时长 ${number(shot.duration)} 秒。`
      : `Shot design: ${SHOT_SIZE_EN[shot.shotSize]}, ${MOVE_EN[shot.cameraMove]}, ${number(shot.duration)} seconds.`,
  );
  const placement = cameraPlacement(scene, shot, locale);
  if (placement) parts.push(placement);

  if (scene.environment?.mode === "panorama" && scene.environment.assetId) {
    parts.push(
      zh
        ? "背景环境：使用已绑定的 360° 全景图作为空间背景，保持全景图的水平朝向与镜头旋转连续；白模角色只参考站位、比例、动作和遮挡，不把全景图拉伸成普通平面。"
        : "Environment: use the bound 360° panorama as the spatial background; keep its horizontal orientation continuous with camera rotation. The blockout characters are a blocking reference only; do not flatten the panorama.",
    );
  } else {
    parts.push(
      zh
        ? `背景环境：中性深灰背景 ${scene.background}，不添加环境内容。`
        : `Environment: neutral dark background ${scene.background}, with no added scenery.`,
    );
  }

  const visible = scene.objects.filter((object) => object.visible);
  const actors = visible
    .map((object) => actorLine(object, locale))
    .filter((line): line is string => line !== null);
  if (actors.length > 0) {
    parts.push(
      zh
        ? `角色形态、原型与颜色映射：${actors.join("；")}。生成视频时保持每个角色的体型、轮廓和身份稳定。`
        : `Cast forms, archetypes, and colours: ${actors.join("; ")}. Keep every character's build, silhouette, and identity stable in the generated video.`,
    );
  }
  const objects = visible
    .map((object) => objectLine(object, locale, assetName))
    .filter((line): line is string => line !== null);
  if (objects.length > 0) {
    parts.push(
      zh
        ? `空间调度：${objects.join("；")}。`
        : `Blocking: ${objects.join("; ")}.`,
    );
  }

  const referenced: string[] = [];
  if (scene.environment?.assetId) {
    const name = assetName(scene.environment.assetId);
    if (name) referenced.push(name);
  }
  for (const object of visible) {
    if (!object.assetId) continue;
    const name = assetName(object.assetId);
    if (name) referenced.push(`${object.name} (${name})`);
  }
  if (referenced.length > 0) {
    parts.push(
      zh
        ? `资产引用：${referenced.join("，")}。生成时优先参考这些已绑定资产，并保持其主体身份、构图关系和空间方向。`
        : `Asset references: ${referenced.join(", ")}. Prefer these bound assets, keeping their subject identity, composition, and spatial direction.`,
    );
  }

  const lights = scene.lights
    .filter((light) => light.type !== "ambient")
    .map((light) =>
      zh
        ? `${light.name}强度${number(light.intensity)}颜色${light.color}`
        : `${light.name} intensity ${number(light.intensity)} colour ${light.color}`,
    );
  const ambient = scene.lights.find((light) => light.type === "ambient");
  if (ambient) {
    lights.push(
      zh
        ? `环境光强度${number(ambient.intensity)}颜色${ambient.color}`
        : `ambient light intensity ${number(ambient.intensity)} colour ${ambient.color}`,
    );
  }
  if (lights.length > 0) {
    parts.push(
      zh
        ? `灯光：${lights.join("，")}。保持光线方向连续。`
        : `Lighting: ${lights.join(", ")}. Keep the light direction continuous.`,
    );
  }

  parts.push(
    zh
      ? "保持角色、道具、空间方向、光线方向和镜头轴线连续，遵循真实摄影机透视与物理遮挡。"
      : "Keep characters, props, spatial directions, light directions, and the camera axis continuous, following true camera perspective and physical occlusion.",
  );
  return parts.join("\n");
}
