-- MiniMax video generation, H3 (v2): a task started with multimodal content,
-- looked at until it is done, and collected from the address the finished
-- task names.
--
-- API reference:
--   https://platform.minimax.io/docs/api-reference/video-generation-v2-create
--   https://platform.minimax.io/docs/api-reference/video-generation-v2-query
--
-- The configured address starts a task. Looking at one is a path derived from
-- it: `/v2/video_generation` becomes `/v2/query/video_generation/<id>`. A
-- finished task names its film directly, so unlike the older v1 shape there
-- is no file handle to exchange.
--
-- One prompt is required. Pictures are either the frames a shot lands on or
-- references the shot is made from, never both: the service refuses the two
-- in one ask, so a reference ask sends every picture as a reference and a
-- frame ask drops pictures that are neither end.
--
-- A model's own switches — a prompt-expansion mode, for instance — reach the
-- script as ordinary parameters beside the ask's own, so they are read from
-- `req.params` and never from a table of this protocol's making.

local POLL_MS = 10000

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function integer_param(params, key)
  local value = params[key]
  if value == nil then
    return nil
  end
  if math.type(value) == "integer" then
    return value
  end
  if type(value) == "string" then
    local parsed = tonumber(trimmed(value))
    if parsed ~= nil and math.type(parsed) == "integer" then
      return parsed
    end
  end
  return nil
end

local function text_param(params, key)
  local value = params[key]
  if type(value) == "string" and trimmed(value) ~= "" then
    return trimmed(value)
  end
  return nil
end

-- The document an answer carries, or nil when it carries something else. An
-- error page is not JSON, and saying that is truer than a decode failure.
local function decode(text)
  local ok, payload = pcall(json.decode, text)
  if not ok or type(payload) ~= "table" then
    return nil
  end
  return payload
end

-- The complaint this service carries in an OpenAI-style error document.
local function refusal(body)
  local payload = decode(body)
  if payload == nil then
    return nil
  end
  local error = payload.error
  if type(error) ~= "table" then
    return nil
  end
  local said = trimmed(tostring(error.message or ""))
  if said == "" then
    return nil
  end
  return said
end

local function failed(status, body)
  local said = refusal(body)
  if said ~= nil then
    return said
  end
  return "HTTP " .. tostring(status) .. ": " .. tostring(body)
end

-- A resolution as this service names its tiers. The room speaks short edges
-- in the app's own numbers, and 720 is the same picture here as the
-- service's 768P.
local function window_of(value)
  if type(value) ~= "string" then
    return nil
  end
  local word = trimmed(value):upper()
  if word == "" then
    return nil
  end
  if word == "480" or word == "480P" then
    return "480P"
  end
  if word == "720" or word == "720P" or word == "768" or word == "768P" then
    return "768P"
  end
  if word == "1080" or word == "1080P" or word == "2K" then
    return "2K"
  end
  return word
end

-- A handle as the text it travelled as.
local function handle_of(value)
  if type(value) == "number" then
    return string.format("%d", value)
  end
  if type(value) == "string" and trimmed(value) ~= "" then
    return trimmed(value)
  end
  return nil
end

-- The media, split by what it is. A reference ask may carry all three; a
-- frame ask only reads the pictures.
local function media_of(inputs)
  local images, videos, audios = {}, {}, {}
  for _, input in ipairs(inputs or {}) do
    local mime = input.mime or ""
    if mime:sub(1, 6) == "image/" then
      table.insert(images, input)
    elseif mime:sub(1, 6) == "video/" then
      table.insert(videos, input)
    elseif mime:sub(1, 6) == "audio/" then
      table.insert(audios, input)
    end
  end
  return images, videos, audios
end

-- The two frames a shot lands on: the ends the ports labelled, and pictures
-- given without a role filling the ends left over. A last frame with no
-- opening is not a shot any service can film.
local function frames_of(images)
  local opening, closing = nil, nil
  local unlabelled = {}
  for _, picture in ipairs(images) do
    if picture.role == "firstFrame" and opening == nil then
      opening = picture
    elseif picture.role == "lastFrame" and closing == nil then
      closing = picture
    else
      table.insert(unlabelled, picture)
    end
  end
  local at = 1
  if opening == nil and unlabelled[at] ~= nil then
    opening = unlabelled[at]
    at = at + 1
  end
  if closing == nil and unlabelled[at] ~= nil then
    closing = unlabelled[at]
  end
  return opening, closing
end

function build_task_request(call, req, inputs)
  local prompt = req.prompt
  if type(prompt) ~= "string" or trimmed(prompt) == "" then
    return {error = "MiniMax needs a prompt describing the clip"}
  end
  local seconds = integer_param(req.params, "seconds") or 5
  if seconds < 4 or seconds > 15 then
    return {
      error = string.format(
        "MiniMax-H3 films clips of 4 to 15 seconds; this ask is %d seconds",
        seconds
      ),
    }
  end

  local images, videos, audios = media_of(inputs)
  local has_media = #images + #videos + #audios > 0
  local references = has_media
    and (text_param(req.params, "mode") == "reference" or #videos > 0 or #audios > 0)

  local content = {{type = "text", text = trimmed(prompt)}}
  local ratio
  if references then
    for _, picture in ipairs(images) do
      table.insert(content, {
        type = "image_url",
        image_url = {url = picture.data_url},
        role = "reference_image",
      })
    end
    for _, film in ipairs(videos) do
      table.insert(content, {
        type = "video_url",
        video_url = {url = film.data_url},
        role = "reference_video",
      })
    end
    for _, sound in ipairs(audios) do
      table.insert(content, {
        type = "audio_url",
        audio_url = {url = sound.data_url},
        role = "reference_audio",
      })
    end
    ratio = text_param(req.params, "ratio") or "adaptive"
  else
    local opening, closing = frames_of(images)
    if closing ~= nil and opening == nil then
      return {error = "a last frame needs the first frame beside it"}
    end
    if opening ~= nil then
      table.insert(content, {
        type = "image_url",
        image_url = {url = opening.data_url},
        role = "first_frame",
      })
    end
    if closing ~= nil then
      table.insert(content, {
        type = "image_url",
        image_url = {url = closing.data_url},
        role = "last_frame",
      })
    end
    if opening ~= nil then
      -- The service reads the ratio off the picture and ignores another.
      ratio = "adaptive"
    else
      -- Text-to-video needs a concrete ratio; adaptive is not one.
      ratio = text_param(req.params, "ratio")
      if ratio == nil or ratio:lower() == "adaptive" then
        ratio = "16:9"
      end
    end
  end

  local body = {
    model = call.model,
    content = content,
    resolution = window_of(req.params.resolution) or "768P",
    duration = seconds,
    ratio = ratio,
  }

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

function parse_task_response(status, headers, body)
  if status < 200 or status >= 300 then
    return {error = failed(status, body)}
  end
  local payload = decode(body)
  if payload == nil then
    return {error = "the service answered with a document that is not JSON"}
  end
  local handle = handle_of(payload.task_id)
  if handle == nil then
    return {error = "the job started without a handle to poll"}
  end
  return {reference = handle, poll_interval_ms = POLL_MS}
end

-- One look at a job. The base every path of this service is derived from
-- travels as state, because the reader of the answer is handed the answer
-- alone rather than the address it was asked at.
function build_poll_request(call, task)
  local base = url.drop(call.url, "/video_generation")
  return {
    state = {base = base},
    request = {
      method = "GET",
      url = url.append(base, "query/video_generation/" .. task.reference),
      headers = {},
    },
  }
end

function parse_poll_response(status, headers, body, state)
  if status < 200 or status >= 300 then
    return {status = "failed", error = failed(status, body)}
  end
  local payload = decode(body)
  if payload == nil then
    return {status = "failed", error = "the service answered with a document that is not JSON"}
  end
  -- The default response shape nests the task; the flat shape does not.
  local task = payload.task or payload
  local state_word = tostring(task.status or ""):lower()
  if state_word == "succeeded" then
    local content = task.content or {}
    local address = content.url
    if type(address) ~= "string" or trimmed(address) == "" then
      return {status = "failed", error = "the job succeeded without naming a film"}
    end
    return {
      status = "succeeded",
      result = {items = {{url = address, mime = "video/mp4"}}},
    }
  end
  if state_word == "failed" then
    local error = task.error or {}
    local said = trimmed(tostring(error.message or ""))
    if said == "" then
      said = "the job failed (code " .. tostring(error.code or "unknown") .. ")"
    end
    return {status = "failed", error = said}
  end
  if state_word == "cancelled" then
    return {status = "failed", error = "the job was cancelled"}
  end
  -- Queued, running, or a status this script has not met: the job is not
  -- finished, and saying anything else would end it early.
  return {status = "pending", poll_interval_ms = POLL_MS}
end
