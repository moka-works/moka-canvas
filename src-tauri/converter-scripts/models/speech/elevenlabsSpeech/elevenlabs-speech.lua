-- ElevenLabs · Text to Speech
--
-- API reference:
--   https://elevenlabs.io/docs/api-reference/text-to-speech/convert
--
-- The voice is part of the address rather than a field of the body, so a
-- configuration names it in the URL — `.../text-to-speech/{voiceId}` — and a
-- voice chosen for one ask takes its place. An address that stops at
-- `.../text-to-speech` takes the chosen voice after it.
--
-- The answer is the recording itself, in the format asked for in the query;
-- what it is comes from the answer's own type.

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

-- The format this service names its output by. Only the containers it serves
-- are asked for; anything else comes back as the usual mp3.
local function output_format(format)
  local word = trimmed(tostring(format or "")):lower()
  if word == "opus" then
    return "opus_48000_128"
  end
  if word == "pcm" then
    return "pcm_44100"
  end
  return "mp3_44100_128"
end

-- The address the chosen voice is asked at.
local function voice_url(address, voice)
  local chosen = trimmed(tostring(voice or ""))
  if chosen == "" then
    return address
  end
  local replaced = url.replace(address, "voiceId", chosen)
  replaced = url.replace(replaced, "voice", chosen)
  if replaced ~= address then
    return replaced
  end
  -- A configuration that names the service rather than one voice ends where
  -- the voice goes.
  local _, at_service = url.drop(address, "/text-to-speech")
  if at_service then
    return url.append(address, chosen)
  end
  return address
end

function build_request(call, req, inputs)
  local voice = req.params.voice
  local address = voice_url(call.url, voice)
  address = url.set_query(address, "output_format", output_format(req.params.format))

  local settings = {}
  local speed = number_param(req.params, "speed")
  if speed ~= nil then
    -- The service reads a pace between 0.7 and 1.2; one outside that is
    -- brought to the nearest end rather than sent to be refused.
    settings.speed = math.max(0.7, math.min(1.2, speed))
  end

  local body = {
    text = req.prompt or "",
    model_id = call.model,
  }
  if next(settings) ~= nil then
    body.voice_settings = settings
  end
  if type(req.params.language) == "string" and trimmed(req.params.language) ~= "" then
    body.language_code = trimmed(req.params.language)
  end

  return {
    method = "POST",
    url = address,
    headers = {["Content-Type"] = "application/json"},
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
