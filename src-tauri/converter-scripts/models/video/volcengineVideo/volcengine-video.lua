-- Volcengine Ark (火山方舟) video generation: a job started, looked at until it
-- is done, and collected from the address the finished answer names.
--
-- API reference:
--   https://www.volcengine.com/docs/ark/create-video-generation-task-api
--   https://www.volcengine.com/docs/ark/get-video-generation-task-api
--
-- The address a configuration carries starts a job, and looking at one is that
-- same address beside the handle the start answered with.
--
-- A shot is described as a list of content: the words first, then the pictures
-- the shot is built on, each under the name of the end it belongs to. The
-- windows this service draws in are the tiers it names, spelled in the lower
-- case with a trailing p, so the bare number the room states is dressed before
-- it travels.

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

local function text_param(params, key)
  local value = params[key]
  if type(value) == "string" and trimmed(value) ~= "" then
    return trimmed(value)
  end
  return nil
end

local function flag_param(params, key)
  local value = params[key]
  if type(value) == "boolean" then
    return value
  end
  return nil
end

-- The window a shot is drawn in, as this service names its tiers: a bare
-- number of lines is the tier with a trailing p, and a tier already spelled is
-- read in the lower case the service writes.
local function window_of(value)
  if type(value) ~= "string" then
    return nil
  end
  local word = trimmed(value):lower()
  if word == "" then
    return nil
  end
  if string.match(word, "^%d+$") then
    return word .. "p"
  end
  return word
end

-- The pictures a shot is built on, each with the name of the end it belongs to.
--
-- The two pictures the caller labelled as the shot's ends are the frames it
-- lands on, and anything given beside them rides as a reference: an act is
-- filmed this way, opening on its first board and closing on its last with the
-- shots in between asked for as references. Where no such pair is labelled
-- there is only the count to go on — one picture opens the shot, two open and
-- close it, and three or more are references, since no model takes three
-- frames — and a request that asked for references is given references and
-- nothing else.
local function framed(req, inputs)
  local pictures = {}
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      table.insert(pictures, input)
    end
  end

  local opening, closing = nil, nil
  for _, picture in ipairs(pictures) do
    if picture.role == "firstFrame" and opening == nil then
      opening = picture
    elseif picture.role == "lastFrame" and closing == nil then
      closing = picture
    end
  end

  local carried = {}
  local function carry(picture, role)
    table.insert(carried, {picture = picture, role = role})
  end
  if text_param(req.params, "mode") == "reference" then
    for _, picture in ipairs(pictures) do
      carry(picture, "reference_image")
    end
  elseif opening ~= nil and closing ~= nil then
    for _, picture in ipairs(pictures) do
      if picture == opening then
        carry(picture, "first_frame")
      elseif picture == closing then
        carry(picture, "last_frame")
      else
        carry(picture, "reference_image")
      end
    end
  elseif #pictures == 1 then
    carry(pictures[1], "first_frame")
  elseif #pictures == 2 then
    carry(pictures[1], "first_frame")
    carry(pictures[2], "last_frame")
  else
    for _, picture in ipairs(pictures) do
      carry(picture, "reference_image")
    end
  end
  return carried
end

function build_task_request(call, req, inputs)
  local content = {}
  if req.prompt and trimmed(req.prompt) ~= "" then
    table.insert(content, {type = "text", text = req.prompt})
  end
  for _, one in ipairs(framed(req, inputs)) do
    table.insert(content, {
      type = "image_url",
      image_url = {url = one.picture.data_url},
      role = one.role,
    })
  end
  local body = {model = call.model, content = content}
  local ratio = text_param(req.params, "ratio")
  if ratio ~= nil then
    body.ratio = ratio
  end
  local seconds = integer_param(req.params, "seconds")
  if seconds ~= nil then
    body.duration = seconds
  end
  local resolution = window_of(req.params.resolution)
  if resolution ~= nil then
    body.resolution = resolution
  end
  local watermark = flag_param(req.params, "watermark")
  if watermark ~= nil then
    body.watermark = watermark
  end
  local audio = flag_param(req.params, "generateAudio")
  if audio ~= nil then
    body.generate_audio = audio
  end

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

function parse_task_response(status, headers, body)
  local payload = json.decode(body)
  local handle = payload.id
  if type(handle) ~= "string" or trimmed(handle) == "" then
    return {error = "the job started without a handle to poll"}
  end
  return {reference = handle, poll_interval_ms = POLL_MS}
end

function build_poll_request(call, task)
  return {
    method = "GET",
    url = url.append(call.url, task.reference),
    headers = {},
  }
end

function parse_poll_response(status, headers, body)
  local payload = json.decode(body)
  local state = tostring(payload.status or ""):lower()
  if state == "succeeded" then
    local items = {}
    local address = payload.content and payload.content.video_url
    if type(address) == "string" and trimmed(address) ~= "" then
      -- An address of the platform's own: the host fetches it, and the
      -- credential follows the address rather than the script.
      table.insert(items, {url = address, mime = "video/mp4"})
    end
    if #items == 0 then
      return {status = "failed", error = "the job succeeded without a film"}
    end
    return {status = "succeeded", result = {items = items}}
  end
  if state == "failed" or state == "cancelled" then
    local explanation = payload.error and payload.error.message
    if type(explanation) ~= "string" or trimmed(explanation) == "" then
      explanation = "the job ended as " .. state
    end
    return {status = "failed", error = trimmed(explanation)}
  end
  -- Queued, running, or a status this script has not met: the job is not
  -- finished, and saying anything else would end it early.
  return {status = "pending", poll_interval_ms = POLL_MS}
end
