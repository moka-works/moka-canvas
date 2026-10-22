-- Google Gemini · long-running (Veo) (video generation, async job)
--
-- A shot does not answer in one call: the job is started here, and what it left
-- behind is collected later by looking for it. The handle the provider issues is
-- a path under the root of the configured address, so polling one needs that
-- root rather than the endpoint the job was started at.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- The base64 inside an input's data URL, which is where the bytes a script was
-- handed live: a script cannot carry bytes of its own.
local function encoded(input)
  local url = input.data_url or ""
  local comma = url:find(",", 1, true)
  if not comma then
    return ""
  end
  return url:sub(comma + 1)
end

local function whole_param(params, key)
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

-- The image inputs, in the order the request carried them. What each one is for
-- is settled by the role it came with rather than by where it sits.
local function frames_of(inputs)
  local frames = {}
  for _, input in ipairs(inputs or {}) do
    local mime = input.mime or ""
    if mime:sub(1, 6) == "image/" then
      table.insert(frames, input)
    end
  end
  return frames
end

-- A frame as a job names it, which is a field of its own rather than a part of
-- a prompt.
local function named(frame)
  return {mimeType = frame.mime, bytesBase64Encoded = encoded(frame)}
end

function build_task_request(call, req, inputs)
  local shot = {prompt = req.prompt}
  -- The two pictures the caller labelled as the shot's ends are the frames it
  -- lands on, and anything given beside them travels as a reference: an act is
  -- filmed this way, opening on its first board and closing on its last with
  -- the shots in between asked for as references. Where no such pair is
  -- labelled there is only the count to go on — one picture opens the shot, two
  -- open and close it, and three or more are references, since no provider
  -- takes three frames — and a request that asked for references is given
  -- references and nothing else.
  local frames = frames_of(inputs)
  local opening, closing = nil, nil
  for _, frame in ipairs(frames) do
    if frame.role == "firstFrame" and opening == nil then
      opening = frame
    elseif frame.role == "lastFrame" and closing == nil then
      closing = frame
    end
  end

  local references = {}
  if req.params.mode == "reference" then
    references = frames
  elseif opening ~= nil and closing ~= nil then
    shot.image = named(opening)
    shot.lastFrame = named(closing)
    for _, frame in ipairs(frames) do
      if frame ~= opening and frame ~= closing then
        table.insert(references, frame)
      end
    end
  elseif #frames == 1 then
    shot.image = named(frames[1])
  elseif #frames == 2 then
    shot.image = named(frames[1])
    shot.lastFrame = named(frames[2])
  else
    references = frames
  end
  if #references > 0 then
    local images = {}
    for _, frame in ipairs(references) do
      table.insert(images, {referenceType = "ASSET", image = named(frame)})
    end
    shot.referenceImages = images
  end

  local parameters = {}
  if type(req.params.ratio) == "string" then
    parameters.aspectRatio = req.params.ratio
  end
  if type(req.params.resolution) == "string" then
    parameters.resolution = req.params.resolution
  end
  local seconds = whole_param(req.params, "seconds")
  if seconds ~= nil then
    parameters.durationSeconds = seconds
  end
  if type(req.params.generateAudio) == "boolean" then
    parameters.generateAudio = req.params.generateAudio
  end
  -- A watermark has no counterpart here, and inventing one would ask a
  -- provider for something it never offered.

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode({instances = {shot}, parameters = parameters}),
  }
end

function parse_task_response(status, headers, body)
  local payload = json.decode(body)
  -- Without a handle the job cannot be collected, which makes a 200 that lacks
  -- one a failure rather than an answer.
  local reference = payload.name
  if type(reference) ~= "string" or trimmed(reference) == "" then
    return {error = "the job started without a handle to poll"}
  end
  -- The provider does not say how often to look, and asking more often than
  -- this only adds refusals.
  return {reference = trimmed(reference), poll_interval_ms = 5000}
end

-- The root a job handle is relative to: everything before the `/models/`
-- segment of the configured address.
local function root_of(address)
  local root, under_models = url.before(address, "/models/")
  if under_models then
    return root
  end
  -- With no `/models/` to cut at, the handle is read against the host the
  -- configuration was reached on.
  return url.origin(address)
end

function build_poll_request(call, task)
  return {
    method = "GET",
    url = url.append(root_of(call.url), task.reference),
    headers = {},
  }
end

function parse_poll_response(status, headers, body)
  local payload = json.decode(body)
  if payload.done ~= true then
    return {status = "pending"}
  end
  -- A job that finished badly explains itself in the same document that says
  -- it finished.
  local explained = payload.error
  if type(explained) == "table" and type(explained.message) == "string" then
    local message = trimmed(explained.message)
    if message ~= "" then
      return {status = "failed", error = message}
    end
  end

  local items = {}
  local response = payload.response
  local generated = type(response) == "table" and response.generateVideoResponse or nil
  local samples = type(generated) == "table" and generated.generatedSamples or nil
  if type(samples) == "table" then
    for _, sample in ipairs(samples) do
      local video = sample.video
      local uri = type(video) == "table" and video.uri or nil
      -- A sample with nothing to collect is passed over rather than collected
      -- from nowhere.
      if type(uri) == "string" then
        table.insert(items, {url = uri, mime = "video/mp4"})
      end
    end
  end
  return {status = "succeeded", result = {items = items}}
end
