-- Black Forest Labs · FLUX image generation (a job started, then looked at)
--
-- API reference:
--   https://docs.bfl.ai/api-reference/tasks/generate-an-image
--
-- The address a configuration carries starts a job; the answer names where
-- the job may be looked at, which is the handle this script hands over. Each
-- look is a call of its own until the job is ready, and a look that is not
-- ready says how soon to come back.
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

function build_task_request(call, req, inputs)
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

-- The handle a look is asked at is the address the job named for it, carried
-- whole: this service's jobs are looked at where they say, not at a path the
-- configured address implies.
function parse_task_response(status, headers, body)
  local payload = json.decode(body)
  if type(payload) ~= "table" then
    return {error = "the service answered without a document"}
  end
  local refused = refusal(payload)
  if refused ~= nil then
    return {error = refused}
  end
  local polling = payload.polling_url or payload.pollingUrl
  if type(polling) ~= "string" or polling == "" then
    return {error = "the job started without an address to look at"}
  end
  return {reference = polling, poll_interval_ms = POLL_MS}
end

function build_poll_request(call, task)
  return {
    method = "GET",
    url = task.reference,
    headers = {},
  }
end

function parse_poll_response(status, headers, body)
  local payload = json.decode(body)
  if type(payload) ~= "table" then
    return {status = "failed", error = "the service answered without a document"}
  end
  local refused = refusal(payload)
  if refused ~= nil then
    return {status = "failed", error = refused}
  end

  if payload.status == "Ready" then
    local result = payload.result or {}
    local url = result.sample or result.url
    if type(url) ~= "string" or url == "" then
      return {status = "failed", error = "the job finished without a picture"}
    end
    return {
      status = "succeeded",
      result = {items = {{url = url}}, usage = {images = 1}},
    }
  end

  -- Pending, or a status this script has not met: the job is not finished, and
  -- saying anything else would end it early.
  return {status = "pending", poll_interval_ms = POLL_MS}
end
