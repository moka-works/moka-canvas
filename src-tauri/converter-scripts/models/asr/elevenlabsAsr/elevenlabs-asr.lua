-- ElevenLabs · Scribe speech recognition
--
-- API reference:
--   https://elevenlabs.io/docs/api-reference/speech-to-text/convert
--
-- The recording travels as the file part of one multipart request and the
-- words come back in the answer, each with the time it was said and, where
-- more than one voice was heard, who said it. The cues are those words
-- gathered short enough to read.

local CUE_MAX_MS = 12000
local CUE_MAX_CHARS = 48
local CUE_GAP_MS = 800

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

local function chars(text)
  return utf8.len(text) or #text
end

-- A Latin word is separated from the one before it; a CJK character is not.
local function joins_without_space(previous, next_word)
  local offset = utf8.offset(previous, -1)
  local last = offset ~= nil and utf8.codepoint(previous, offset) or nil
  local first = utf8.codepoint(next_word, 1)
  if last == nil or first == nil then
    return false
  end
  local function cjk(code)
    return (code >= 0x2E80 and code <= 0x9FFF)
      or (code >= 0xF900 and code <= 0xFAFF)
      or (code >= 0x3040 and code <= 0x30FF)
      or (code >= 0xAC00 and code <= 0xD7AF)
  end
  return cjk(last) or cjk(first)
end

local function join_words(held, word)
  if held == "" then
    return word
  end
  if string.match(word, "^[%p%)%]}]") or joins_without_space(held, word) then
    return held .. word
  end
  return held .. " " .. word
end

-- This service names its speakers `speaker_0`; a viewer counts from one.
local function speaker_number(speaker)
  if speaker == nil then
    return nil
  end
  local digits = tostring(speaker):match("(%d+)$")
  if digits ~= nil then
    return tostring(tonumber(digits) + 1)
  end
  return tostring(speaker)
end

local function speaker_text(label, speaker)
  local text = string.gsub(label, "{id}", function()
    return speaker
  end)
  return text
end

-- The cues, gathered from utterances where the answer carries them and from
-- the timed words where it does not.
local function cues_of(payload, label)
  local cues = {}
  for _, utterance in ipairs(payload.utterances or {}) do
    local words = clean(utterance.text)
    if words ~= "" then
      local speaker = speaker_number(utterance.speaker_id or utterance.speaker)
      local prefix = ""
      if type(label) == "string" and speaker ~= nil then
        prefix = speaker_text(label, speaker)
      end
      table.insert(cues, {
        start_ms = (tonumber(utterance.start) or 0) * 1000,
        end_ms = (tonumber(utterance["end"]) or 0) * 1000,
        speaker = speaker,
        text = prefix .. words,
      })
    end
  end
  if #cues > 0 then
    return cues
  end

  local held = nil
  local function flush()
    if held ~= nil then
      table.insert(cues, held)
      held = nil
    end
  end

  for _, word in ipairs(payload.words or {}) do
    local text = clean(word.text or word.word)
    local kind = word.type
    if text ~= "" and (kind == nil or kind == "word") then
      local speaker = speaker_number(word.speaker_id or word.speaker)
      local start_ms = (tonumber(word.start) or 0) * 1000
      local end_ms = (tonumber(word["end"]) or 0) * 1000
      local prefix = ""
      if type(label) == "string" and speaker ~= nil then
        prefix = speaker_text(label, speaker)
      end
      local same = held ~= nil
        and held.speaker == speaker
        and (start_ms - held.end_ms) <= CUE_GAP_MS
        and (end_ms - held.start_ms) <= CUE_MAX_MS
        and (chars(held.text) + chars(text)) <= CUE_MAX_CHARS
      if same then
        held.end_ms = end_ms
        held.text = join_words(held.text, text)
      else
        flush()
        held = {
          start_ms = start_ms,
          end_ms = end_ms,
          speaker = speaker,
          text = prefix .. text,
        }
      end
    elseif text ~= "" and held ~= nil and kind == "spacing" then
      held.text = held.text .. text
    end
  end
  flush()
  return cues
end

function build_request(call, req, inputs)
  if inputs[1] == nil then
    return {error = "no recording was sent to be recognized"}
  end
  local fields = {
    model_id = call.model,
    timestamps_granularity = "word",
  }
  if type(req.params.language) == "string" and trimmed(req.params.language) ~= "" then
    fields.language_code = trimmed(req.params.language)
  end
  if req.params.speakerLabel ~= nil or tonumber(req.params.speakerCount or 0) > 0 then
    fields.diarize = true
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
  if type(payload.detail) == "string" and payload.detail ~= "" then
    return {error = payload.detail}
  end

  local label = (state or {}).speakerLabel
  local cues = cues_of(payload, label)
  local duration = tonumber(payload.audio_duration_secs) or 0

  if #cues == 0 then
    local whole = clean(payload.text)
    if whole == "" then
      return {error = "no speech was found in the recording"}
    end
    local end_ms = duration * 1000
    if end_ms <= 0 then
      end_ms = math.min(30000, math.max(2000, chars(whole) * 150))
    end
    table.insert(cues, {start_ms = 0, end_ms = end_ms, text = whole})
  end

  local usage = nil
  if duration > 0 then
    usage = {seconds = duration}
  end
  return {cues = cues, usage = usage}
end
