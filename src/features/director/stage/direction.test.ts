import { describe, expect, it } from "vitest";
import {
  activeShotOf,
  createDirectorScene,
  createPerformer,
} from "../../../shared/domain";
import { compileDirection, formatPoint } from "./direction";

function duo() {
  const scene = createDirectorScene("Shot", "duo");
  const shot = activeShotOf(scene)!;
  return { scene, shot };
}

describe("director prompt compiler", () => {
  it("is deterministic for the same scene, shot, and language", () => {
    const { scene, shot } = duo();
    const first = compileDirection(scene, shot, "en");
    const again = compileDirection(structuredClone(scene), { ...shot }, "en");
    expect(first).toBe(again);
    expect(first).toContain(
      "Shot design: medium shot, static camera, 8 seconds.",
    );
    expect(first).toContain("Camera: 35mm lens");
    expect(first).toContain("Actor 1");
    expect(first).toContain("Actor 2");
    expect(first).not.toContain("NaN");
    expect(first).not.toContain("Infinity");
  });

  it("writes the Chinese prompt with the same structure", () => {
    const { scene, shot } = duo();
    const text = compileDirection(scene, shot, "zh");
    expect(text).toContain("镜头设计：中景，固定机位，时长 8 秒。");
    expect(text).toContain("摄影机：35mm 焦段");
    expect(text).toContain("角色形态、原型与颜色映射");
    expect(text).toContain("人形·标准成人");
    expect(text).not.toContain("undefined");
  });

  it("leads with the reader's own words", () => {
    const { scene, shot } = duo();
    const text = compileDirection(
      scene,
      { ...shot, prompt: "她把杯子放下，转身离开。" },
      "zh",
    );
    expect(text.startsWith("她把杯子放下，转身离开。")).toBe(true);
  });

  it("names the camera side from where it actually stands", () => {
    const { scene, shot } = duo();
    const camera = scene.cameras[0];
    camera.transform.position = [-4, 1.6, 0];
    camera.target = [0, 1, 0];
    const text = compileDirection(scene, shot, "en");
    expect(text).toContain("front left of the subject");
    camera.transform.position = [4, 1.6, 0];
    const other = compileDirection(scene, shot, "en");
    expect(other).toContain("front right of the subject");
  });

  it("carries bound assets by name and skips unbound ones", () => {
    const { scene, shot } = duo();
    scene.environment = { mode: "panorama", assetId: "pano" };
    const object = createPerformer("dog", "Dog", "#d98c3f", [1, 0, 0]);
    object.assetId = "dog-model";
    scene.objects.push(object);
    const text = compileDirection(scene, shot, "en", (id) =>
      id === "pano"
        ? "stage-pano.jpg"
        : id === "dog-model"
          ? "dog.glb"
          : undefined,
    );
    expect(text).toContain("360° panorama");
    expect(text).toContain("stage-pano.jpg");
    expect(text).toContain("dog.glb");
    expect(text).toContain("quadruped · dog");
  });

  it("formats points without trailing zeros and without negative zero", () => {
    expect(formatPoint([0, -0, 1.2345])).toBe("(0, 0, 1.23)");
    expect(formatPoint([1.006, 2, 3])).toBe("(1.01, 2, 3)");
  });
});
