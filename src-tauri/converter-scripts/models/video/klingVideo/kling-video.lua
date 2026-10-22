-- Kling AI · Video generation (text, first frame, or both)
--
-- API reference:
--   https://kling.ai/document-api/api/video/2-6/text-to-video/legacy
--   https://kling.ai/document-api/api/video/2-6/image-to-video/legacy
--
-- The operation is part of the configured address: words are asked at
-- `.../v1/videos/text2video`, a picture to animate at
-- `.../v1/videos/image2video`. The answer names a task, and every look is the
-- same address with the task's handle after it.
--
-- The frames a shot was built on travel as the opening and closing pictures;
-- a service with only one place for a picture is given the opening one.

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

local function ratio_of(params)
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
  if width == height then
    return "1:1"
  end
  if width > height then
    return "16:9"
  end
  return "9:16"
end

local function pictures(inputs)
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
  return opening, closing
end

function build_task_request(call, req, inputs)
  local body = {
    model_name = call.model,
    prompt = req.prompt or "",
  }
  local ratio = ratio_of(req.params)
  if ratio ~= nil then
    body.aspect_ratio = ratio
  end
  local seconds = integer_param(req.params, "seconds")
  if seconds ~= nil then
    body.duration = tostring(seconds)
  end
  if type(req.params.negativePrompt) == "string" and trimmed(req.params.negativePrompt) ~= "" then
    body.negative_prompt = trimmed(req.params.negativePrompt)
  end

  local opening, closing = pictures(inputs)
  if (call.url or ""):match("/image2video") then
    if opening == nil then
      return {error = "this image-to-video model needs a picture to animate"}
    end
    body.image = opening.data_url
    if closing ~= nil then
      body.image_tail = closing.data_url
    end
  elseif opening ~= nil then
    -- A text-to-video model that was handed a picture reads it as the shot's
    -- opening frame; the words still say what the shot is.
    body.image = opening.data_url
  end

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

function parse_task_response(status, headers, body)
  if status < 200 or status >= 300 then
    return {error = "HTTP " .. tostring(status) .. ": " .. body}
  end
  local payload = json.decode(body) or {}
  local code = tonumber(payload.code or 0) or 0
  if code ~= 0 then
    return {error = payload.message or ("the service refused the request (code " .. tostring(code) .. ")")}
  end
  local data = payload.data or {}
  local reference = data.task_id
  if type(reference) ~= "string" or reference == "" then
    return {error = "the job started without a handle to poll: " .. body}
  end
  return {reference = reference, poll_interval_ms = POLL_MS}
end

function build_poll_request(call, task)
  local base = trimmed(call.url or ""):gsub("/+$", "")
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
  local code = tonumber(payload.code or 0) or 0
  if code ~= 0 then
    return {status = "failed", error = payload.message or ("the service refused the request (code " .. tostring(code) .. ")")}
  end
  local data = payload.data or {}
  local job = data.task_status or "submitted"
  if job == "succeed" then
    local items = {}
    local result = data.task_result or {}
    for _, video in ipairs(result.videos or {}) do
      local url = video.url
      if type(url) == "string" and url ~= "" then
        table.insert(items, {url = url, mime = "video/mp4"})
      end
    end
    if #items == 0 then
      return {status = "failed", error = "the job finished without a film"}
    end
    return {status = "succeeded", result = {items = items}}
  end
  if job == "failed" then
    return {status = "failed", error = data.task_status_msg or data.task_status or "the job failed"}
  end
  return {status = "pending", poll_interval_ms = POLL_MS}
end
