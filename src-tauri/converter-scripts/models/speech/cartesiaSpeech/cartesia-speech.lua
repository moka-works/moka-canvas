-- Cartesia · Sonic Text to Speech (bytes)
--
-- API reference:
--   https://docs.cartesia.ai/api-reference/tts/bytes
--
-- A request states the model, the words, the voice by its identifier and the
-- shape of the recording; the answer is the bytes themselves. The version the
-- request is read as travels in a header of its own, and the key in the
-- authorization header as it stands rather than behind a scheme.

local VERSION = "2024-06-10"

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function number_param(params, key)
  local value = params[key]
  if type(value) == "number" then
    return value
  end
  if type(value) == "string" then
    return tonumber(trimmed(value))
  end
  return nil
end

-- The container this service is asked for. Wav is linear samples in a wav
-- wrapper; the rest is the usual mp3.
local function output_format(format)
  local word = trimmed(tostring(format or "")):lower()
  if word == "wav" then
    return {container = "wav", encoding = "pcm_s16le", sample_rate = 44100}
  end
  return {container = "mp3", sample_rate = 44100, bit_rate = 128000}
end

function build_request(call, req, inputs)
  local voice = trimmed(tostring(req.params.voice or ""))
  local generation = {}
  local speed = number_param(req.params, "speed")
  if speed ~= nil then
    generation.speed = speed
  end

  local body = {
    model_id = call.model,
    transcript = req.prompt or "",
    voice = {mode = "id", id = voice},
    output_format = output_format(req.params.format),
  }
  if next(generation) ~= nil then
    body.generation_config = generation
  end
  if type(req.params.language) == "string" and trimmed(req.params.language) ~= "" then
    body.language = trimmed(req.params.language)
  end

  return {
    method = "POST",
    url = call.url,
    headers = {
      ["Content-Type"] = "application/json",
      ["Cartesia-Version"] = VERSION,
    },
    body = json.encode(body),
  }
end

function parse_response(status, headers, body)
  local announced = headers["content-type"]
  local claimed = nil
  if type(announced) == "string" then
    claimed = trimmed(announced:match("^[^;]+") or announced)
    if claimed == "" then
      claimed = nil
    end
  end
  return {items = {{raw = true, mime = claimed}}}
end
