-- Volcengine · Seed TTS (unidirectional HTTP)
--
-- API reference:
--   https://www.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http
--
-- A request names the voice, the words and the shape of the recording; the
-- answer is a sequence of JSON chunks, each carrying a base64 piece of the
-- same recording and a code of its own. The resource the key is spent against
-- travels in a header, so the configured address stays the same while the
-- version of the engine changes.
--
-- The chunks are decoded here rather than inside the host, because a piece's
-- base64 length has nothing to do with the bytes around it: joining the
-- encoded pieces would join the padded ends of each.

local RESOURCE = "seed-tts-2.0"

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

local function format_of(value)
  local word = trimmed(tostring(value or "")):lower()
  if word == "wav" or word == "opus" or word == "ogg" or word == "pcm" then
    return word
  end
  return "mp3"
end

local function mime_of(format)
  if format == "wav" then
    return "audio/wav"
  end
  if format == "opus" then
    return "audio/opus"
  end
  if format == "ogg" then
    return "audio/ogg"
  end
  if format == "pcm" then
    return "audio/l16"
  end
  return "audio/mpeg"
end

function build_request(call, req, inputs)
  local format = format_of(req.params.format)
  local sample_rate = number_param(req.params, "sampleRate") or 24000
  local audio = {format = format, sample_rate = math.floor(sample_rate)}
  local speed = number_param(req.params, "speed")
  if speed ~= nil then
    -- This service states pace as a percentage away from the normal one.
    audio.speech_rate = math.floor(math.max(-50, math.min(100, (speed - 1) * 100)))
  end

  local body = {
    user = {uid = "moka-canvas"},
    req_params = {
      text = req.prompt or "",
      speaker = trimmed(tostring(req.params.voice or "")),
      audio_params = audio,
    },
  }

  return {
    state = {format = format},
    method = "POST",
    url = call.url,
    headers = {
      ["Content-Type"] = "application/json",
      ["X-Api-Resource-Id"] = RESOURCE,
    },
    body = json.encode(body),
  }
end

-- One chunk's payload, wherever this service put it. The bytes live in `data`;
-- a wrapper around them is read as well so a version that nests the payload is
-- not mistaken for one that said nothing.
local function piece(payload)
  local data = payload.data
  if type(data) == "string" and trimmed(data) ~= "" then
    return data
  end
  if type(payload.result) == "table" then
    local nested = payload.result.data
    if type(nested) == "string" and trimmed(nested) ~= "" then
      return nested
    end
  end
  return nil
end

function parse_response(status, headers, body, state)
  local format = (state or {}).format or "mp3"
  local audio = {}
  local refusal = nil

  for line in string.gmatch(body, "[^\r\n]+") do
    local payload_text = trimmed(line)
    payload_text = string.gsub(payload_text, "^data:%s*", "")
    if payload_text:sub(1, 1) == "{" then
      local ok, payload = pcall(json.decode, payload_text)
      if ok and type(payload) == "table" then
        local code = tonumber(payload.code or 0) or 0
        local encoded = piece(payload)
        if encoded ~= nil then
          local decoded_ok, bytes = pcall(base64.decode, encoded)
          if decoded_ok then
            table.insert(audio, bytes)
          end
        elseif code ~= 0 and code ~= 20000000 then
          refusal = trimmed(tostring(payload.message or ""))
          if refusal == "" then
            refusal = "the service refused the request (code " .. tostring(code) .. ")"
          end
        end
      end
    end
  end

  if #audio == 0 then
    if refusal ~= nil then
      return {error = refusal}
    end
    return {error = "the service answered without any audio"}
  end

  return {
    items = {{
      base64 = base64.encode(table.concat(audio)),
      mime = mime_of(format),
    }},
  }
end
