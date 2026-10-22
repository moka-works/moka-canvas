-- Zhipu GLM · CogVideoX video generation (a job started, then looked at)
--
-- API reference:
--   https://docs.bigmodel.cn/api-reference/模型-api/视频生成
--
-- The address a configuration carries starts a job; the answer names the job
-- and every look is at `/api/paas/v4/async-result/{id}` until the job says it
-- has succeeded and where its film was left.
--
-- A shot may be built on a picture as well as on words: the opening frame the
-- ports labelled is handed over as the image the first shot grows from.

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

local function size_of(params)
  local size = trimmed(tostring(params.size or ""))
  if string.match(size, "^%d+[xX]%d+$") then
    return string.lower(size)
  end
  return nil
end

local function first_picture(inputs)
  local unlabelled = nil
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      if input.role == "firstFrame" then
        return input
      end
      if unlabelled == nil then
        unlabelled = input
      end
    end
  end
  return unlabelled
end

local function api_prefix(url)
  local prefix = trimmed(url or ""):match("^(https?://[^/]+/api/paas/v4)/videos/")
  if prefix ~= nil then
    return prefix
  end
  local root = trimmed(url or ""):match("^(https?://[^/]+)")
  return (root or "https://open.bigmodel.cn") .. "/api/paas/v4"
end

function build_task_request(call, req, inputs)
  local body = {
    model = call.model,
    prompt = req.prompt or "",
  }
  local picture = first_picture(inputs)
  if picture ~= nil then
    body.image_url = picture.data_url
  end
  local size = size_of(req.params)
  if size ~= nil then
    body.size = size
  end
  local quality = trimmed(tostring(req.params.quality or ""))
  if quality ~= "" then
    body.quality = quality
  end
  local fps = integer_param(req.params, "fps")
  if fps ~= nil then
    body.fps = fps
  end
  local seconds = integer_param(req.params, "seconds")
  if seconds ~= nil then
    body.duration = seconds
  end
  if type(req.params.generateAudio) == "boolean" then
    body.with_audio = req.params.generateAudio
  end

  return {
    state = {base = api_prefix(call.url), seconds = seconds},
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
  local reference = payload.id or payload.request_id
  if type(reference) ~= "string" or reference == "" then
    return {error = "the job started without a handle to poll: " .. body}
  end
  local job = payload.task_status
  if job == "FAIL" or job == "FAILED" then
    return {error = payload.error or payload.message or "the job was refused"}
  end
  return {state = state, reference = reference, poll_interval_ms = POLL_MS}
end

function build_poll_request(call, task)
  return {
    method = "GET",
    url = api_prefix(call.url) .. "/async-result/" .. task.reference,
    headers = {},
  }
end

-- The film a finished job left. Some answers carry one address per result,
-- and some name the field differently; both are read.
local function film_of(payload)
  for _, video in ipairs(payload.video_result or {}) do
    local url = video.url or video.video_url
    if type(url) == "string" and url ~= "" then
      return url
    end
  end
  if type(payload.video_url) == "string" and payload.video_url ~= "" then
    return payload.video_url
  end
  return nil
end

function parse_poll_response(status, headers, body)
  if status < 200 or status >= 300 then
    if status == 404 or status == 410 then
      return {status = "expired", error = "the job is gone"}
    end
    return {error = "HTTP " .. tostring(status) .. ": " .. body}
  end
  local payload = json.decode(body) or {}
  local job = payload.task_status or "PROCESSING"
  if job == "SUCCESS" then
    local url = film_of(payload)
    if url == nil then
      return {status = "failed", error = "the job finished without a film"}
    end
    return {status = "succeeded", result = {items = {{url = url, mime = "video/mp4"}}}}
  end
  if job == "FAIL" or job == "FAILED" then
    return {
      status = "failed",
      error = payload.error or payload.message or "the job failed without saying why",
    }
  end
  return {status = "pending", poll_interval_ms = POLL_MS}
end
