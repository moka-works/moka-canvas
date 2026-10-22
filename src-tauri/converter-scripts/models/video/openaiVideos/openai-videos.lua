-- OpenAI-compatible videos: a job is started, looked at until it is done, and
-- then collected from the address the handle names.
--
-- The address a configuration carries is the whole endpoint for starting a job.
-- Looking at one is `<address>/<handle>`, and the finished film is
-- `<address>/<handle>/content`, which answers with the bytes rather than with a
-- document — so what they are comes from sniffing them, and the type the answer
-- announced is a claim checked against the bytes rather than trusted over.
--
-- The pictures a shot is built on travel under names rather than as a list: the
-- opening frame, then the closing one, because the provider does not guess
-- which end of a list is which. A picture that is not one of the labelled ends
-- rides beside them as a reference, which is a different field.

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
    return value
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

-- The pictures a shot uses, in the order the request carried them: what each
-- one is for is settled by the role it came with rather than by where it sits.
local function pictures_of(inputs)
  local pictures = {}
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      table.insert(pictures, input)
    end
  end
  return pictures
end

function build_task_request(call, req, inputs)
  local body = {model = call.model, prompt = req.prompt or ""}
  for _, key in ipairs({"resolution", "ratio"}) do
    local value = text_param(req.params, key)
    if value ~= nil then
      body[key] = value
    end
  end
  local seconds = integer_param(req.params, "seconds")
  if seconds ~= nil then
    body.seconds = seconds
  end
  local audio = flag_param(req.params, "generateAudio")
  if audio ~= nil then
    body.generate_audio = audio
  end
  local watermark = flag_param(req.params, "watermark")
  if watermark ~= nil then
    body.watermark = watermark
  end

  -- The two pictures the caller labelled as the shot's ends are the frames it
  -- lands on, and anything given beside them travels as a reference: an act is
  -- filmed this way, opening on its first board and closing on its last with
  -- the shots in between asked for as references. Where no such pair is
  -- labelled there is only the count to go on — one picture opens the shot, two
  -- open and close it, and three or more are references, since no provider
  -- takes three frames — and a request that asked for references is given
  -- references and nothing else.
  local pictures = pictures_of(inputs)
  local opening, closing = nil, nil
  for _, picture in ipairs(pictures) do
    if picture.role == "firstFrame" and opening == nil then
      opening = picture
    elseif picture.role == "lastFrame" and closing == nil then
      closing = picture
    end
  end

  local references = {}
  if text_param(req.params, "mode") == "reference" then
    references = pictures
  elseif opening ~= nil and closing ~= nil then
    body.first_frame = opening.data_url
    body.last_frame = closing.data_url
    for _, picture in ipairs(pictures) do
      if picture ~= opening and picture ~= closing then
        table.insert(references, picture)
      end
    end
  elseif #pictures == 1 then
    body.first_frame = pictures[1].data_url
  elseif #pictures == 2 then
    body.first_frame = pictures[1].data_url
    body.last_frame = pictures[2].data_url
  else
    references = pictures
  end
  if #references > 0 then
    local sent = {}
    for _, picture in ipairs(references) do
      table.insert(sent, picture.data_url)
    end
    body.reference_images = sent
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
  return {reference = handle}
end

-- Looking at a job: the address, and what the reader of the answer will need to
-- name the finished film — the host hands the script's state to the handler it
-- names, which is how an address built here reaches the reading below.
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

function parse_poll_response(status, headers, body, state)
  local payload = json.decode(body)
  local state_of_job = (payload.status or ""):lower()
  if state_of_job == "succeeded" or state_of_job == "completed" then
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
  if state_of_job == "expired" then
    return {status = "expired", error = "the job is no longer known"}
  end
  if state_of_job == "failed" or state_of_job == "cancelled" or state_of_job == "canceled" or state_of_job == "incomplete" then
    local explanation = (payload.error or {}).message
    if type(explanation) ~= "string" or trimmed(explanation) == "" then
      explanation = "the job ended as " .. state_of_job
    end
    return {status = "failed", error = trimmed(explanation)}
  end
  -- Queued, in progress, or a status this script has not met: the job is not
  -- finished, and saying anything else would end it early.
  return {status = "pending", poll_interval_ms = POLL_MS}
end
