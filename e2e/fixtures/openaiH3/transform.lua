-- OpenAI Videos protocol, written for an H3-family model.
--
-- The wire shape is the OpenAI videos one: a job is started at the address a
-- configuration carries, looked at until it is done, and collected from
-- `<address>/<id>/content`, which answers with bytes rather than a document.
-- A form is what is sent, because that is what the videos endpoint reads: the
-- model, the prompt, the length, the frame size, and optionally a seed.
--
-- The prompt is not touched here. It is written for the H3 family — English
-- narration, spoken lines inside `<d>[language] … </d>`, stable speaker ids —
-- and the client composes it through the protocol's prompt guide before the
-- ask is made, where the reader can read and change every word. A script that
-- rewrote it again would send words nobody saw.
--
-- One picture may ride with the ask: OpenAI's videos API takes a single
-- `input_reference`, so a second end or a list of references cannot travel
-- over this protocol and is left out with a warning rather than silently
-- changed into something else.

local POLL_MS = 5000

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function text_param(params, key)
  local value = params[key]
  if type(value) == "string" and trimmed(value) ~= "" then
    return trimmed(value)
  end
  return nil
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

-- A frame dimension the service will take, kept even so that a half pixel is
-- never asked for.
local function even(measure)
  if measure % 2 == 1 then
    return measure + 1
  end
  return measure
end

-- The frame a shot is asked in, as OpenAI's `size` spells one: `WxH`.
--
-- A size stated by the ask travels as it stands. Otherwise the short side is
-- the resolution tier — 720 for 720P, the tier the settings name — and the
-- long side follows the frame's ratio, so 16:9 at 720P is 1280x720 and 9:16
-- is 720x1280, the sizes the OpenAI videos endpoint expects.
local function size_of(params)
  local stated = text_param(params, "size")
  if stated ~= nil and string.match(stated, "^%d+x%d+$") then
    return stated
  end
  local ratio = text_param(params, "ratio") or "16:9"
  local across, down = string.match(ratio, "^(%d+):(%d+)$")
  if across == nil then
    return nil
  end
  across, down = tonumber(across), tonumber(down)
  if across == nil or down == nil or across <= 0 or down <= 0 then
    return nil
  end
  local tier = 720
  local resolution = text_param(params, "resolution")
  if resolution ~= nil then
    local digits = string.match(resolution, "%d+")
    if digits ~= nil then
      tier = tonumber(digits)
    end
  end
  local wide = math.floor(tier * math.max(across, down) / math.min(across, down) + 0.5)
  if across >= down then
    return string.format("%dx%d", even(wide), even(tier))
  end
  return string.format("%dx%d", even(tier), even(wide))
end

-- The pictures a shot is built on, in the order the request carried them.
local function pictures_of(inputs)
  local pictures = {}
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      table.insert(pictures, input)
    end
  end
  return pictures
end

-- The one picture the protocol can carry: the opening frame where the request
-- labelled one, and otherwise the first picture given.
local function reference_of(pictures)
  local opening = nil
  for _, picture in ipairs(pictures) do
    if picture.role == "firstFrame" then
      opening = picture
      break
    end
  end
  return opening or pictures[1]
end

function build_task_request(call, req, inputs)
  local prompt = ""
  if type(req.prompt) == "string" then
    prompt = trimmed(req.prompt)
  end
  if prompt == "" then
    return {error = "the H3 prompt contract needs a prompt"}
  end

  local fields = {prompt = prompt}
  if type(call.model) == "string" and trimmed(call.model) ~= "" then
    fields.model = trimmed(call.model)
  end
  local seconds = integer_param(req.params, "seconds")
  if seconds ~= nil then
    fields.seconds = seconds
  end
  local size = size_of(req.params)
  if size ~= nil then
    fields.size = size
  end
  -- Not part of OpenAI's own surface; H3 workers read it, and a service that
  -- does not simply leaves an unknown form field alone.
  local seed = integer_param(req.params, "seed")
  if seed ~= nil then
    fields.seed = seed
  end

  local files = {}
  local pictures = pictures_of(inputs)
  if #pictures > 0 then
    if #pictures > 1 then
      log.warn("the OpenAI videos API carries one input_reference; the other pictures were left out")
    end
    table.insert(files, {part = "input_reference", input = reference_of(pictures)})
  end

  local multipart = {fields = fields}
  if #files > 0 then
    multipart.files = files
  end
  return {
    method = "POST",
    url = call.url,
    -- The form's boundary and content type are the host's to write.
    headers = {},
    body = {multipart = multipart},
  }
end

function parse_task_response(status, headers, body)
  local payload = json.decode(body) or {}
  local handle = payload.id
  if type(handle) == "number" then
    handle = string.format("%d", handle)
  end
  if type(handle) ~= "string" or trimmed(handle) == "" then
    return {error = "the job started without an id: " .. tostring(body)}
  end
  return {reference = trimmed(handle), poll_interval_ms = POLL_MS}
end

function build_poll_request(call, task)
  return {
    request = {
      method = "GET",
      url = url.append(call.url, task.reference),
      headers = {},
    },
    handler = "parse_poll_response",
    state = {endpoint = call.url, reference = task.reference},
  }
end

local function reason_of(payload)
  local error = payload.error
  if type(error) == "table" then
    local said = error.message or error.detail or error.description
    if type(said) == "string" and trimmed(said) ~= "" then
      return trimmed(said)
    end
  end
  if type(error) == "string" and trimmed(error) ~= "" then
    return trimmed(error)
  end
  return nil
end

function parse_poll_response(status, headers, body, state)
  local payload = json.decode(body) or {}
  local job = tostring(payload.status or ""):lower()
  if job == "completed" or job == "succeeded" then
    return {
      status = "succeeded",
      result = {
        items = {
          {
            url = url.append(url.append(state.endpoint, state.reference), "content"),
            mime = "video/mp4",
          },
        },
      },
    }
  end
  if job == "expired" then
    return {status = "expired", error = "the job is no longer known"}
  end
  if job == "failed" or job == "cancelled" or job == "canceled" or job == "incomplete" then
    return {
      status = "failed",
      error = reason_of(payload) or ("the job ended as " .. job),
    }
  end
  -- Queued, in progress, or a status this script has not met: the job is not
  -- finished, and saying anything else would end it early.
  return {status = "pending", poll_interval_ms = POLL_MS}
end
