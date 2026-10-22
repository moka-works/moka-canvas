-- OpenAI-compatible · Audio Transcriptions (a recording, answered whole)
--
-- API reference:
--   https://platform.openai.com/docs/api-reference/audio/createTranscription
--
-- The recording travels as the file part of a multipart request, and the
-- answer is asked for in its verbose shape so its sentences carry the times a
-- subtitle is written from. A recognizer that answers without sentences is
-- still an answer: what it heard becomes one cue under the recording's own
-- length.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function clean(text)
  if type(text) ~= "string" then
    return ""
  end
  local collapsed = string.gsub(text, "%s+", " ")
  return string.gsub(collapsed, "^%s*(.-)%s*$", "%1")
end

local function language_of(value)
  if type(value) ~= "string" then
    return nil
  end
  local word = trimmed(value)
  if word == "" or string.match(word, "^[%w%-_]+$") == nil then
    return nil
  end
  return word
end

local function srt_time(ms)
  local total = math.max(0, math.floor((tonumber(ms) or 0) + 0.5))
  local hours = total // 3600000
  local minutes = (total // 60000) % 60
  local seconds = (total // 1000) % 60
  local millis = total % 1000
  return string.format("%02d:%02d:%02d,%03d", hours, minutes, seconds, millis)
end

local function srt_block(index, begin_ms, end_ms, text)
  return tostring(index)
    .. "\n"
    .. srt_time(begin_ms)
    .. " --> "
    .. srt_time(end_ms)
    .. "\n"
    .. text
end

-- The first sentence's length stands in for a recognizer that gave no length
-- at all: a subtitle needs an end, and words per second is a better guess than
-- a cue that never closes.
local function guessed_ms(text)
  local length = math.max(1, utf8.len(text) or #text)
  return math.min(30000, math.max(2000, length * 150))
end

function build_request(call, req, inputs)
  if inputs[1] == nil then
    return {error = "no recording was sent to be recognized"}
  end
  local fields = {
    model = call.model,
    response_format = "verbose_json",
  }
  local language = language_of(req.params.language)
  if language ~= nil then
    fields.language = language
  end
  local prompt = trimmed(tostring(req.params.prompt or ""))
  if prompt ~= "" then
    fields.prompt = prompt
  end

  return {
    state = {speakerLabel = req.params.speakerLabel},
    method = "POST",
    url = call.url,
    headers = {},
    body = {
      multipart = {
        fields = fields,
        file = {part = "file", input = 1},
      },
    },
  }
end

function parse_response(status, headers, body, state)
  local payload = json.decode(body)
  if type(payload) ~= "table" then
    return {error = "the recognizer answered without a document"}
  end
  if type(payload.error) == "table" then
    return {error = payload.error.message or "the recording was refused"}
  end

  local label = (state or {}).speakerLabel
  local duration = tonumber(payload.duration) or 0
  local blocks = {}
  local count = 0
  for _, segment in ipairs(payload.segments or {}) do
    local words = clean(segment.text)
    if words ~= "" then
      local begin_ms = (tonumber(segment.start) or 0) * 1000
      local end_ms = (tonumber(segment["end"]) or 0) * 1000
      if end_ms < begin_ms then
        end_ms = begin_ms
      end
      count = count + 1
      table.insert(blocks, srt_block(count, begin_ms, end_ms, words))
    end
  end

  if count == 0 then
    local whole = clean(payload.text)
    if whole == "" then
      return {error = "no speech was found in the recording"}
    end
    local end_ms = duration * 1000
    if end_ms <= 0 then
      end_ms = guessed_ms(whole)
    end
    count = 1
    table.insert(blocks, srt_block(1, 0, end_ms, whole))
  end

  local usage = nil
  if duration > 0 then
    usage = {seconds = duration}
  end
  return {text = table.concat(blocks, "\n\n") .. "\n", usage = usage}
end
