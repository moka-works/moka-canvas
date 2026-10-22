-- Black Forest Labs · FLUX image generation (a job started, then looked at)
--
-- API reference:
--   https://docs.bfl.ai/api-reference/tasks/generate-an-image
--
-- The address a configuration carries starts a job; the answer names where
-- the job may be looked at, and each look is the same reader until the job is
-- ready. A look that is not ready asks to be asked again shortly, which the
-- host turns into a pause rather than a request with nothing to read.
--
-- The picture is left at an address the provider names, and the host fetches
-- it from there.

local POLL_MS = 800

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function whole(value, default)
  local number = tonumber(value)
  if number == nil then
    return default
  end
  return math.floor(number + 0.5)
end

-- The size somebody picked, as the width and height this service asks for.
-- Its own sizes are multiples of sixteen, so a near miss is brought to the
-- nearest rather than sent to be refused.
local function extent(params)
  local size = trimmed(tostring(params.size or ""))
  local width, height = string.match(size, "^(%d+)[xX*](%d+)$")
  if width == nil then
    return nil
  end
  local function aligned(value)
    local number = whole(value, 0)
    return math.max(256, math.min(2048, math.floor((number + 8) / 16) * 16))
  end
  return aligned(width), aligned(height)
end

function build_request(call, req, inputs)
  local body = {prompt = req.prompt or ""}
  local width, height = extent(req.params)
  if width ~= nil then
    body.width = width
    body.height = height
  end
  if type(req.params.seed) == "number" then
    body.seed = math.floor(req.params.seed)
  end
  -- A picture beside the words is what the shot is built on or edited from.
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      body.input_image = input.data_url
      break
    end
  end

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

local function refusal(payload)
  local status = payload.status
  if status == "Error" or status == "Task not found" then
    return trimmed(tostring(payload.message or payload.error or "the job failed"))
  end
  if status == "Request Moderated" or status == "Content Moderated" then
    return "the request was moderated: " .. tostring(payload.message or status)
  end
  return nil
end

function parse_response(status, headers, body, state)
  local payload = json.decode(body)
  if type(payload) ~= "table" then
    return {error = "the service answered without a document"}
  end
  local refused = refusal(payload)
  if refused ~= nil then
    return {error = refused}
  end

  if payload.status == "Ready" then
    local result = payload.result or {}
    local url = result.sample or result.url
    if type(url) ~= "string" or url == "" then
      return {error = "the job finished without a picture"}
    end
    return {items = {{url = url}}, usage = {images = 1}}
  end

  local polling = (state and state.polling_url) or payload.polling_url or payload.pollingUrl
  if type(polling) ~= "string" or polling == "" then
    return {error = "the job started without an address to look at"}
  end
  return {
    state = {polling_url = polling},
    wait_ms = POLL_MS,
    next = {
      request = {method = "GET", url = polling, headers = {}},
      handler = "parse_response",
    },
  }
end
