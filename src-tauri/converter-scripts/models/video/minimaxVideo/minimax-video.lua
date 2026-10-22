-- MiniMax video generation: a job started, looked at until it is done, and
-- collected from the address the finished job's file is left at.
--
-- API reference:
--   https://platform.minimax.io/docs/api-reference/video-generation-t2v
--   https://platform.minimax.io/docs/api-reference/video-generation-i2v
--   https://platform.minimax.io/docs/api-reference/video-generation-fl2v
--   https://platform.minimax.io/docs/api-reference/video-generation-s2v
--   https://platform.minimax.io/docs/api-reference/video-generation-query
--   https://platform.minimax.io/docs/api-reference/video-generation-download
--
-- The address a configuration carries starts a job; looking at one and
-- collecting its film are paths that live beside it rather than inside it, so
-- both are derived from the configured address — its own directory is where
-- the query and the file retrieval sit.
--
-- A shot is the words with the pictures the ports labelled: one end opens the
-- shot, and a second closes it. A shot built on a subject rather than on a
-- first frame — the request asked for references — hands the pictures over as
-- a subject reference instead. This service reads frames or a subject, never
-- both at once, so a picture that can be neither an end nor a reference is not
-- carried at all: the words are what say what it showed.
--
-- Each look is two asks where the platform's own job would need one: the
-- status names a file rather than an address, and the address is asked for
-- beside it.

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

-- The window a shot is drawn in, as this service names its tiers: a bare
-- number of lines is the tier with a trailing P, and a tier already spelled
-- is read in the case the service writes.
local function window_of(value)
  if type(value) ~= "string" then
    return nil
  end
  local word = trimmed(value):upper()
  if word == "" then
    return nil
  end
  if string.match(word, "^%d+$") then
    return word .. "P"
  end
  return word
end

-- A handle as the text it travelled as. This service numbers its files, and a
-- number written into an address is the same handle as the text of it.
local function handle_of(value)
  if type(value) == "number" then
    return string.format("%d", value)
  end
  if type(value) == "string" and trimmed(value) ~= "" then
    return trimmed(value)
  end
  return nil
end

-- The complaint this platform carries inside an answer: its endpoints report
-- a refusal as a success whose own status says otherwise.
local function refusal(payload)
  local response = payload.base_resp
  if type(response) ~= "table" then
    return nil
  end
  local code = tonumber(response.status_code or 0) or 0
  if code == 0 then
    return nil
  end
  local said = trimmed(tostring(response.status_msg or ""))
  if said == "" then
    said = "the service refused the request (code " .. tostring(response.status_code) .. ")"
  end
  return said
end

-- The pictures a shot is built on: the ends the ports labelled, and the
-- pictures given without a role filling the ends left over — one opens the
-- shot, two open and close it. A request that asked for references is given
-- references and nothing else.
local function framed(req, inputs, all)
  local pictures = {}
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      table.insert(pictures, input)
    end
  end

  if text_param(req.params, "mode") == "reference" then
    local references = {}
    for _, picture in ipairs(pictures) do
      table.insert(references, picture)
    end
    return {references = references}
  end

  local opening, closing = nil, nil
  local unlabelled = {}
  for _, picture in ipairs(pictures) do
    if picture.role == "firstFrame" and opening == nil then
      opening = picture
    elseif picture.role == "lastFrame" and closing == nil then
      closing = picture
    else
      table.insert(unlabelled, picture)
    end
  end

  local at = 1
  if opening == nil and unlabelled[at] ~= nil then
    opening = unlabelled[at]
    at = at + 1
  end
  if closing == nil and unlabelled[at] ~= nil then
    closing = unlabelled[at]
  end
  return {opening = opening, closing = closing}
end

function build_task_request(call, req, inputs)
  local framed_inputs = framed(req, inputs)
  local body = {model = call.model}
  if req.prompt and trimmed(req.prompt) ~= "" then
    body.prompt = req.prompt
  end
  if framed_inputs.references ~= nil then
    local pictures = {}
    for _, picture in ipairs(framed_inputs.references) do
      table.insert(pictures, picture.data_url)
    end
    if #pictures > 0 then
      body.subject_reference = {{type = "character", image = pictures}}
    end
  else
    if framed_inputs.opening ~= nil then
      body.first_frame_image = framed_inputs.opening.data_url
    end
    if framed_inputs.closing ~= nil then
      body.last_frame_image = framed_inputs.closing.data_url
    end
  end
  local seconds = integer_param(req.params, "seconds")
  if seconds ~= nil then
    body.duration = seconds
  end
  local resolution = window_of(req.params.resolution)
  if resolution ~= nil then
    body.resolution = resolution
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
  local refused = refusal(payload)
  if refused ~= nil then
    return {error = refused}
  end
  local handle = handle_of(payload.task_id)
  if handle == nil then
    return {error = "the job started without a handle to poll"}
  end
  return {reference = handle, poll_interval_ms = POLL_MS}
end

-- One look at a job. The base every path of this service is derived from
-- travels as state, because the reader of the answer is handed the answer
-- alone rather than the address it was asked at.
function build_poll_request(call, task)
  local base = url.drop(call.url, "/video_generation")
  return {
    state = {base = base},
    request = {
      method = "GET",
      url = url.set_query(url.append(base, "query/video_generation"), "task_id", task.reference),
      headers = {},
    },
  }
end

function parse_poll_response(status, headers, body, state)
  local payload = json.decode(body)
  local refused = refusal(payload)
  if refused ~= nil then
    return {status = "failed", error = refused}
  end
  local state_word = tostring(payload.status or ""):lower()
  if state_word == "success" then
    local handle = handle_of(payload.file_id)
    if handle == nil then
      return {status = "failed", error = "the job succeeded without a film"}
    end
    -- The film sits behind the file's own name, and only the address that
    -- knows the file can name where it was left: one more ask, and one more
    -- reader.
    return {
      next = {
        request = {
          method = "GET",
          url = url.set_query(url.append((state or {}).base, "files/retrieve"), "file_id", handle),
          headers = {},
        },
        handler = "parse_file_response",
      },
    }
  end
  if state_word == "fail" then
    local explanation = trimmed(tostring((payload.base_resp or {}).status_msg or ""))
    if explanation == "" then
      explanation = "the job ended as " .. tostring(payload.status)
    end
    return {status = "failed", error = explanation}
  end
  -- Preparing, queued, processing, or a status this script has not met: the
  -- job is not finished, and saying anything else would end it early.
  return {status = "pending", poll_interval_ms = POLL_MS}
end

function parse_file_response(status, headers, body)
  local payload = json.decode(body)
  local refused = refusal(payload)
  if refused ~= nil then
    return {error = refused}
  end
  local file = payload.file or {}
  local address = file.download_url
  if type(address) ~= "string" or trimmed(address) == "" then
    return {status = "failed", error = "the finished job named no film to collect"}
  end
  -- An address of the platform's own: the host fetches it, and the credential
  -- follows the address rather than the script.
  return {
    status = "succeeded",
    result = {items = {{url = address, mime = "video/mp4"}}},
  }
end
