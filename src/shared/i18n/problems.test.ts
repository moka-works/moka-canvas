import { beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "../../api/client";
import { i18n } from ".";
import { failureText, problemKey, problemMessage } from "./problems";

// The suite is pinned to English by the shared setup; each case says which
// language it reads in, and this puts the catalogue back afterwards.
beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("problemKey", () => {
  it("names a code the way the catalogues file it", () => {
    expect(problemKey("PROVIDER_AUTH")).toBe("providerAuth");
    expect(problemKey("MOKA_TOO_LARGE")).toBe("mokaTooLarge");
    expect(problemKey("CONFIG_METADATA_DIR_INVALID")).toBe(
      "configMetadataDirInvalid",
    );
  });
});

describe("problemMessage in English", () => {
  it("hands back the server's own words, whatever the code", () => {
    expect(
      problemMessage(
        "PROVIDER_AUTH",
        "the provider rejected the stored credential: bad key",
      ),
    ).toBe("the provider rejected the stored credential: bad key");
    expect(problemMessage("MOKA_TOO_LARGE", "canvas.moka is too big")).toBe(
      "canvas.moka is too big",
    );
  });

  it("hands back the words a code has no entry for", () => {
    expect(problemMessage("VALIDATION_FAILED", "Duplicate node id n-1")).toBe(
      "Duplicate node id n-1",
    );
  });
});

describe("problemMessage in Chinese", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh");
  });

  it("shows a known code in Chinese rather than the server's English", () => {
    // A trouble whose sentence has a hole in it takes the provider's own
    // words: the Chinese says what the trouble is, the detail says what the
    // provider said about it.
    expect(
      problemMessage(
        "PROVIDER_AUTH",
        "the provider rejected the stored credential: bad key",
        { detail: "bad key" },
      ),
    ).toBe("服务商拒绝了凭据（401/403）：bad key");
    expect(
      problemMessage(
        "PROVIDER_BAD_REQUEST",
        "the provider rejected the request: status 400: 6 image items",
        { detail: "status 400: 6 image items" },
      ),
    ).toBe("服务商拒绝了该请求：status 400: 6 image items");
    expect(
      problemMessage("REVISION_CONFLICT", "canvas.moka changed on disk"),
    ).toBe("文档已被其他窗口修改，请刷新后重试");
    expect(problemMessage("MOKA_TOO_LARGE", "canvas.moka is too big")).toBe(
      "文件超过大小限制",
    );
  });

  it("interpolates the status a request failed with", () => {
    expect(
      problemMessage("INTERNAL", "Request failed with status 500", {
        status: 500,
      }),
    ).toBe("请求失败，状态码 500");
    expect(
      problemMessage(
        "PARSE",
        "The server returned an unreadable response (502)",
        {
          status: 502,
        },
      ),
    ).toBe("服务端返回了无法解析的响应（502）");
  });

  it("interpolates the cause under a transport failure", () => {
    expect(
      problemMessage(
        "TRANSPORT",
        "Cannot reach the local process: Failed to fetch",
        { message: "Failed to fetch" },
      ),
    ).toBe("无法连接本地服务：Failed to fetch");
  });

  it("interpolates the model a capability mismatch names", () => {
    expect(
      problemMessage(
        "MODEL_CAPABILITY_MISMATCH",
        "a::b generates image, not text",
        { reference: "a::b", requested: "text", actual: "image" },
      ),
    ).toBe("a::b 生成的是 image，不是 text");
  });

  it("says which scenario has no group, in the reader's own words", () => {
    expect(
      problemMessage(
        "MODEL_SCENE_UNCONFIGURED",
        "the model filmer has no group for the referenceToVideo scene",
        { reference: "filmer", capability: "video", scene: "referenceToVideo" },
      ),
    ).toBe(
      "模型「filmer」没有为「参考图生视频」场景配置分组，请到设置里补充后再试",
    );
  });

  it("says which speech model has no voice to speak in", () => {
    expect(
      problemMessage(
        "MODEL_VOICE_REQUIRED",
        "the model a-voice has no voice set, and its speech converter needs one",
        { model: "a-voice" },
      ),
    ).toBe(
      "模型「a-voice」还没有可用的音色：语音合成必须指定音色，请先设置音色后再试",
    );
  });

  it("says which speech model is waiting for a reference recording", () => {
    expect(
      problemMessage(
        "MODEL_REFERENCE_AUDIO_REQUIRED",
        "the model cloner reads a voice from a reference recording, and none was sent",
        { model: "cloner" },
      ),
    ).toBe(
      "模型「cloner」需要一段参考音频才能出声：请先把录音连到卡片的音频输入，或从素材里挑一段",
    );
  });

  it("falls back to the server's English for a code nobody translated", () => {
    expect(problemMessage("VALIDATION_FAILED", "Duplicate node id n-1")).toBe(
      "Duplicate node id n-1",
    );
    expect(problemMessage("NOT_A_CODE_YET", "Words of its own")).toBe(
      "Words of its own",
    );
  });

  it("falls back rather than leaving a placeholder standing", () => {
    // A server's own INTERNAL carries no status for the message to read, and a
    // sentence reading "请求失败，状态码 {{status}}" would be worse than the
    // English it replaced.
    expect(problemMessage("INTERNAL", "io error: disk full")).toBe(
      "io error: disk full",
    );
    expect(
      problemMessage("MODEL_CAPABILITY_MISMATCH", "a::b generates image"),
    ).toBe("a::b generates image");
    // A refusal whose record carries no detail is the same case: the Chinese
    // sentence would stand there with a hole where the reason belongs.
    expect(
      problemMessage(
        "PROVIDER_BAD_REQUEST",
        "the provider rejected the request",
      ),
    ).toBe("the provider rejected the request");
  });
});

describe("failureText", () => {
  // The one renderer for the trouble a record carries: a job's piece, a run's
  // step, both saying what was said and what kind of thing it was.
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("says nothing for a piece with nothing to report", () => {
    expect(failureText({})).toBeNull();
    expect(failureText({ error: "" })).toBeNull();
  });

  it("takes an old record's words as they are", () => {
    expect(failureText({ error: "the provider refused it" })).toBe(
      "the provider refused it",
    );
  });

  it("says a talked-about code in the reader's language", async () => {
    const failed = {
      error: "model gpt-4o-mini has no stored API key",
      errorCode: "PROVIDER_KEY_MISSING",
      errorDetails: { model: "gpt-4o-mini" },
    };
    expect(failureText(failed)).toBe("model gpt-4o-mini has no stored API key");
    await i18n.changeLanguage("zh");
    expect(failureText(failed)).toBe(
      "模型 gpt-4o-mini 还没有保存 API 密钥，请到设置里填写",
    );
  });

  it("falls back to the recorded words for a code with no translation", async () => {
    await i18n.changeLanguage("zh");
    expect(
      failureText({
        error: "The piece stopped without an answer",
        errorCode: "STEP_FAILED",
      }),
    ).toBe("The piece stopped without an answer");
  });
});

describe("ApiError", () => {
  it("shows a Chinese problem body in Chinese and keeps its parts", async () => {
    await i18n.changeLanguage("zh");
    const error = new ApiError({
      code: "PROVIDER_RATE_LIMIT",
      message: "the provider is rate limiting requests: come back in 42s",
      status: 429,
      details: { detail: "come back in 42s", retryable: true },
    });

    expect(error.message).toBe("服务商正在限流：come back in 42s");
    expect(error.code).toBe("PROVIDER_RATE_LIMIT");
    expect(error.status).toBe(429);
    expect(error.details).toEqual({
      detail: "come back in 42s",
      retryable: true,
    });
    // What only the provider could say is kept as it said it, for a reader who
    // wants the whole of it.
    expect(error.rawMessage).toBe(
      "the provider is rate limiting requests: come back in 42s",
    );
  });

  it("keeps the server's sentence whole and says which model has no key", async () => {
    await i18n.changeLanguage("zh");
    const error = new ApiError({
      code: "PROVIDER_KEY_MISSING",
      message: "model gpt-4o-mini has no stored API key",
      status: 422,
      details: { model: "gpt-4o-mini" },
    });

    expect(error.message).toBe(
      "模型 gpt-4o-mini 还没有保存 API 密钥，请到设置里填写",
    );
    expect(error.rawMessage).toBe("model gpt-4o-mini has no stored API key");
  });

  it("shows the client's own transport words in Chinese", async () => {
    await i18n.changeLanguage("zh");
    const error = ApiError.transport(
      "Cannot reach the local process: Failed to fetch",
      "Failed to fetch",
    );

    expect(error.message).toBe("无法连接本地服务：Failed to fetch");
    expect(error.code).toBe("TRANSPORT");
    expect(error.status).toBe(0);
    expect(error.details).toBeUndefined();
  });

  it("shows the server's words when the interface is English", () => {
    const error = new ApiError({
      code: "PROVIDER_RATE_LIMIT",
      message: "the provider is rate limiting requests: come back in 42s",
      status: 429,
      details: { retryable: true },
    });

    expect(error.message).toBe(
      "the provider is rate limiting requests: come back in 42s",
    );
    expect(error.code).toBe("PROVIDER_RATE_LIMIT");
    expect(error.status).toBe(429);
    expect(error.details).toEqual({ retryable: true });
  });

  it("keeps a transport failure verbatim in English, cause and all", () => {
    const error = ApiError.transport(
      "Cannot reach the local process: Failed to fetch",
      "Failed to fetch",
    );

    expect(error.message).toBe(
      "Cannot reach the local process: Failed to fetch",
    );
    expect(error.code).toBe("TRANSPORT");
    expect(error.details).toBeUndefined();
  });
});
