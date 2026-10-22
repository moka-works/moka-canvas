-- Luma AI · Dream Machine video generation
--
-- API reference:
--   https://docs.lumalabs.ai/docs/js-video-generation
--
-- The address a configuration carries starts a generation. The answer names
-- the job, and each look at it says whether it is still being dreamed or has
-- finished and where its film was left.
--
-- A shot is the words plus the frames the ports labelled: the first opens the
-- shot and the second closes it. This service reads those as keyframes. A
-- picture with no role opens the shot, because that is what a reference means
-- to a video service that has only one place to put it.

local POLL_MS = 4000

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

local function aspect_ratio(params)
  local ratio = trimmed(tostring(params.ratio or ""))
  if string.match(ratio, "^%d+:%d+$") then
    return ratio
  end
  local size = trimmed(tostring(params.size or ""))
  local width, height = string.match(size, "^(%d+)[xX](%d+)$")
  if width == nil then
    return nil
  end
  width, height = tonumber(width), tonumber(height)
  local function reduce(a, b)
    while b ~= 0 do
      a, b = b, a % b
    end
    return a
  end
  local shared = reduce(width, height)
  return (width // shared) .. ":" .. (height // shared)
end

-- The pictures a shot is built on, under the names this service uses. The
-- first frame is the first picture the ports labelled, or the first picture at
-- all; the last frame is the one labelled as such.
local function keyframes(inputs)
  local opening, closing, unlabelled = nil, nil, nil
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      if input.role == "firstFrame" and opening == nil then
        opening = input
      elseif input.role == "lastFrame" and closing == nil then
        closing = input
      elseif unlabelled == nil then
        unlabelled = input
      end
    end
  end
  if opening == nil then
    opening = unlabelled
  end
  if opening == nil and closing == nil then
    return nil
  end
  local frames = {}
  if opening ~= nil then
    frames.frame0 = {type = "image", url = opening.data_url}
  end
  if closing ~= nil then
    frames.frame1 = {type = "image", url = closing.data_url}
  end
  return frames
end

-- Where every path of this service is derived from: the configured address
-- without the operation it names.
--   .../generations/video -> .../generations
local function generations_base(url)
  local base = trimmed(url or ""):gsub("/+$", "")
  local without = base:gsub("/video$", "")
  if without ~= base then
    return without
  end
  return base
end

function build_task_request(call, req, inputs)
  local body = {model = call.model, prompt = req.prompt or ""}
  local ratio = aspect_ratio(req.params)
  if ratio ~= nil then
    body.aspect_ratio = ratio
  end
  local seconds = integer_param(req.params, "seconds")
  if seconds ~= nil then
    body.duration = tostring(seconds) .. "s"
  end
  local resolution = trimmed(tostring(req.params.resolution or ""))
  if resolution ~= "" then
    body.resolution = resolution
  end
  local frames = keyframes(inputs)
  if frames ~= nil then
    body.keyframes = frames
  end

  return {
    state = {base = generations_base(call.url)},
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

function parse_task_response(status, headers, body, state)
  if status < 200 or status >= 300 then
    return {error = "HTTP " .. tostring(status) .. ": " .. body}
  end
  local payload = json.decode(body) or {}
  local reference = payload.id
  if type(reference) ~= "string" or reference == "" then
    return {error = "the job started without a handle to poll: " .. body}
  end
  return {
    state = state,
    reference = reference,
    poll_interval_ms = POLL_MS,
  }
end

function build_poll_request(call, task)
  local base = generations_base(call.url)
  return {
    method = "GET",
    url = base .. "/" .. task.reference,
    headers = {},
  }
end

function parse_poll_response(status, headers, body)
  if status < 200 or status >= 300 then
    if status == 404 or status == 410 then
      return {status = "expired", error = "the job is gone"}
    end
    return {error = "HTTP " .. tostring(status) .. ": " .. body}
  end
  local payload = json.decode(body) or {}
  local job = payload.state or payload.status or "queued"
  if job == "completed" then
    local assets = payload.assets or {}
    local url = assets.video or assets.video_url
    if type(url) ~= "string" or url == "" then
      return {status = "failed", error = "the job finished without a film"}
    end
    return {status = "succeeded", result = {items = {{url = url, mime = "video/mp4"}}}}
  end
  if job == "failed" then
    return {
      status = "failed",
      error = payload.failure_reason or payload.failure or "the job failed without saying why",
    }
  end
  return {status = "pending", poll_interval_ms = POLL_MS}
end
