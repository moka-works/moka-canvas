-- Luma AI · Uni-1 image generation
--
-- API reference:
--   https://docs.agents.lumalabs.ai/
--
-- The address a configuration carries starts a generation; the answer names
-- the generation and whether it is still being reasoned about. Each look is
-- the same address with the generation's handle after it, and the finished
-- answer carries the picture among its assets.
--
-- A picture beside the words is what the image is built on or edited from,
-- and travels as the reference this service reads.

local POLL_MS = 2000

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
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

local function first_picture(inputs)
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      return input
    end
  end
  return nil
end

-- Where every generation of this service is looked at: the collection the
-- configured address either names or sits beside.
local function collection(address)
  return url.append(url.drop(address or "", "/generations"), "generations")
end

local function picture_of(payload)
  local assets = payload.assets or {}
  if type(assets.image) == "string" and assets.image ~= "" then
    return assets.image
  end
  if type(assets.image_url) == "string" and assets.image_url ~= "" then
    return assets.image_url
  end
  if type(assets.images) == "table" then
    for _, picture in ipairs(assets.images) do
      local url = type(picture) == "string" and picture or (picture.url or picture.image)
      if type(url) == "string" and url ~= "" then
        return url
      end
    end
  end
  if type(payload.image) == "string" and payload.image ~= "" then
    return payload.image
  end
  for _, picture in ipairs(payload.output or {}) do
    local url = type(picture) == "string" and picture or (picture.url or picture.image)
    if type(url) == "string" and url ~= "" then
      return url
    end
  end
  return nil
end

function build_task_request(call, req, inputs)
  local body = {model = call.model, prompt = req.prompt or ""}
  local ratio = aspect_ratio(req.params)
  if ratio ~= nil then
    body.aspect_ratio = ratio
  end
  local reference = first_picture(inputs)
  if reference ~= nil then
    body.image_ref = reference.data_url
  end

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

-- The handle is the generation's own name; the collection it is looked at in
-- is derived from the configured address, which every look is handed.
function parse_task_response(status, headers, body)
  local payload = json.decode(body)
  if type(payload) ~= "table" then
    return {error = "the service answered without a document"}
  end
  if type(payload.error) == "table" then
    return {error = payload.error.message or "the request was refused"}
  end

  local job = payload.state or payload.status
  if job == "failed" then
    return {error = payload.failure_reason or payload.failure or "the generation failed"}
  end
  local reference = payload.id
  if type(reference) ~= "string" or reference == "" then
    return {error = "the generation started without a handle to look at"}
  end
  return {reference = reference, poll_interval_ms = POLL_MS}
end

function build_poll_request(call, task)
  return {
    method = "GET",
    url = url.append(collection(call.url), task.reference),
    headers = {},
  }
end

function parse_poll_response(status, headers, body)
  local payload = json.decode(body)
  if type(payload) ~= "table" then
    return {status = "failed", error = "the service answered without a document"}
  end
  if type(payload.error) == "table" then
    return {status = "failed", error = payload.error.message or "the request was refused"}
  end

  local job = payload.state or payload.status
  if job == "failed" then
    return {
      status = "failed",
      error = payload.failure_reason or payload.failure or "the generation failed",
    }
  end
  if job == "completed" or job == "succeeded" then
    local picture = picture_of(payload)
    if picture == nil then
      return {status = "failed", error = "the generation finished without a picture"}
    end
    return {
      status = "succeeded",
      result = {items = {{url = picture}}, usage = {images = 1}},
    }
  end

  -- Reasoned about, queued, or a state this script has not met: the generation
  -- is not finished, and saying anything else would end it early.
  return {status = "pending", poll_interval_ms = POLL_MS}
end
