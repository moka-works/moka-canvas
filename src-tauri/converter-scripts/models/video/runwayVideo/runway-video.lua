-- Runway · Video generation (a task started, then looked at)
--
-- API reference:
--   https://docs.dev.runwayml.com/api/
--
-- The operation is part of the configured address: a text-to-video model is
-- asked at `.../v1/text_to_video`, an image-to-video one at
-- `.../v1/image_to_video`. The request names the model, the words and the
-- shape; the answer names a task, and every look at it is at
-- `.../v1/tasks/{id}` until it has succeeded.
--
-- The API version travels in a header of its own, because the task shape
-- changes while the address does not.

local VERSION = "2024-11-06"
local POLL_MS = 5000

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

-- The ratios this service accepts, with the nearest one standing in for a
-- shape it does not name.
local function ratio_of(params)
  local ratio = trimmed(tostring(params.ratio or ""))
  if ratio ~= "" then
    return ratio
  end
  local size = trimmed(tostring(params.size or ""))
  local width, height = string.match(size, "^(%d+)[xX](%d+)$")
  if width == nil then
    return nil
  end
  width, height = tonumber(width), tonumber(height)
  if width == height then
    return "960:960"
  end
  if width > height then
    return "1280:720"
  end
  return "720:1280"
end

local function operation(url)
  local name = trimmed(url or ""):match("/v1/([%w_]+)")
  return name or "text_to_video"
end

local function first_picture(inputs, role)
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" and (role == nil or input.role == role) then
      return input
    end
  end
  return nil
end

local function first_video(inputs)
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "video/" then
      return input
    end
  end
  return nil
end

local function tasks_base(url)
  local root = trimmed(url or ""):match("^(https?://[^/]+)")
  return (root or "https://api.dev.runwayml.com") .. "/v1/tasks"
end

function build_task_request(call, req, inputs)
  local body = {model = call.model}
  if type(req.prompt) == "string" and trimmed(req.prompt) ~= "" then
    body.promptText = req.prompt
  end
  local ratio = ratio_of(req.params)
  if ratio ~= nil then
    body.ratio = ratio
  end
  local seconds = integer_param(req.params, "seconds")
  if seconds ~= nil then
    body.duration = seconds
  end

  local op = operation(call.url)
  if op == "image_to_video" then
    local picture = first_picture(inputs, "firstFrame") or first_picture(inputs)
    if picture == nil then
      return {error = "this image-to-video model needs a picture to animate"}
    end
    body.promptImage = picture.data_url
  elseif op == "video_to_video" then
    local clip = first_video(inputs)
    if clip == nil then
      return {error = "this video-to-video model needs a clip to edit"}
    end
    body.videoUri = clip.data_url
  end

  return {
    state = {base = tasks_base(call.url)},
    method = "POST",
    url = call.url,
    headers = {
      ["Content-Type"] = "application/json",
      ["X-Runway-Version"] = VERSION,
    },
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
    return {error = "the task started without a handle to poll: " .. body}
  end
  return {state = state, reference = reference, poll_interval_ms = POLL_MS}
end

function build_poll_request(call, task)
  return {
    method = "GET",
    url = tasks_base(call.url) .. "/" .. task.reference,
    headers = {["X-Runway-Version"] = VERSION},
  }
end

function parse_poll_response(status, headers, body)
  if status < 200 or status >= 300 then
    if status == 404 or status == 410 then
      return {status = "expired", error = "the task is gone"}
    end
    return {error = "HTTP " .. tostring(status) .. ": " .. body}
  end
  local payload = json.decode(body) or {}
  local job = payload.status
  if job == "SUCCEEDED" then
    local items = {}
    for _, url in ipairs(payload.output or {}) do
      if type(url) == "string" and url ~= "" then
        table.insert(items, {url = url, mime = "video/mp4"})
      end
    end
    if #items == 0 then
      return {status = "failed", error = "the task finished without a film"}
    end
    return {status = "succeeded", result = {items = items}}
  end
  if job == "FAILED" then
    return {
      status = "failed",
      error = payload.failure or payload.failureCode or "the task failed without saying why",
    }
  end
  if job == "CANCELLED" then
    return {status = "failed", error = "the task was cancelled"}
  end
  return {status = "pending", poll_interval_ms = POLL_MS}
end
