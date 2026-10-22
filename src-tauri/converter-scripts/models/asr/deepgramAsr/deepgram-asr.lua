-- Deepgram · Pre-recorded Speech Recognition
--
-- API reference:
--   https://developers.deepgram.com/docs/pre-recorded-audio
--
-- The recording travels in the body itself rather than in a form, and the
-- words come back with their times and, where more than one voice was heard,
-- who spoke. The subtitle file is those sentences gathered into cues short
-- enough to read; a speaker the service numbers from zero is numbered from
-- one, the way a viewer counts.

local CUE_MAX_MS = 12000
local CUE_MAX_CHARS = 48

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

local function set_query(url, key, value)
  local pattern = "([?&])" .. key .. "=[^&]*"
  if string.find(url, pattern) then
    return (string.gsub(url, pattern, "%1" .. key .. "=" .. value, 1))
  end
  local separator = "?"
  if string.find(url, "?", 1, true) then
    separator = "&"
  end
  return url .. separator .. key .. "=" .. value
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

local function speaker_number(speaker)
  if speaker == nil then
    return nil
  end
  local number = tonumber(speaker)
  if number ~= nil then
    return tostring(number + 1)
  end
  return tostring(speaker)
end

local function speaker_text(label, speaker)
  return (string.gsub(label, "{id}", function()
    return speaker
  end))
end

local function cues_of(payload, label)
  local cues = {}
  local results = payload.results or {}

  for _, utterance in ipairs(results.utterances or {}) do
    local words = clean(utterance.transcript)
    if words ~= "" then
      local speaker = speaker_number(utterance.speaker)
      local prefix = ""
      if type(label) == "string" and speaker ~= nil then
        prefix = speaker_text(label, speaker)
      end
      table.insert(cues, {
        begin_ms = (tonumber(utterance.start) or 0) * 1000,
        end_ms = (tonumber(utterance["end"]) or 0) * 1000,
        speaker = speaker,
        text = prefix .. words,
      })
    end
  end
  if #cues > 0 then
    return cues
  end

  local alternative = (((results.channels or {})[1] or {}).alternatives or {})[1] or {}
  local held = nil
  local function flush()
    if held ~= nil then
      table.insert(cues, held)
      held = nil
    end
  end

  for _, word in ipairs(alternative.words or {}) do
    local text = clean(word.punctuated_word or word.word)
    if text ~= "" then
      local speaker = speaker_number(word.speaker)
      local begin_ms = (tonumber(word.start) or 0) * 1000
      local end_ms = (tonumber(word["end"]) or 0) * 1000
      local prefix = ""
      if type(label) == "string" and speaker ~= nil then
        prefix = speaker_text(label, speaker)
      end
      local same = held ~= nil
        and held.speaker == speaker
        and (begin_ms - held.end_ms) <= 800
        and (end_ms - held.begin_ms) <= CUE_MAX_MS
        and (chars(held.text) + chars(text)) <= CUE_MAX_CHARS
      if same then
        held.end_ms = end_ms
        held.text = held.text .. " " .. text
      else
        flush()
        held = {
          begin_ms = begin_ms,
          end_ms = end_ms,
          speaker = speaker,
          text = prefix .. text,
        }
      end
    end
  end
  flush()
  return cues
end

function build_request(call, req, inputs)
  if inputs[1] == nil then
    return {error = "no recording was sent to be recognized"}
  end
  local url = set_query(call.url, "model", call.model)
  url = set_query(url, "smart_format", "true")
  url = set_query(url, "punctuate", "true")
  url = set_query(url, "utterances", "true")
  local language = trimmed(tostring(req.params.language or ""))
  if language ~= "" then
    url = set_query(url, "language", language)
  end
  if req.params.speakerLabel ~= nil or tonumber(req.params.speakerCount or 0) > 0 then
    url = set_query(url, "diarize", "true")
  end

  return {
    state = {speakerLabel = req.params.speakerLabel},
    method = "POST",
    url = url,
    headers = {},
    body = {raw = {input = 1}},
  }
end

function parse_response(status, headers, body, state)
  local payload = json.decode(body)
  if type(payload) ~= "table" then
    return {error = "the recognizer answered without a document"}
  end
  if type(payload.err_msg) == "string" and payload.err_msg ~= "" then
    return {error = payload.err_msg}
  end
  if type(payload.error) == "string" then
    return {error = payload.error}
  end

  local label = (state or {}).speakerLabel
  local cues = cues_of(payload, label)
  local duration = tonumber((payload.metadata or {}).duration) or 0

  if #cues == 0 then
    local alternative = ((((payload.results or {}).channels or {})[1] or {}).alternatives or {})[1] or {}
    local whole = clean(alternative.transcript)
    if whole == "" then
      return {error = "no speech was found in the recording"}
    end
    local end_ms = duration * 1000
    if end_ms <= 0 then
      end_ms = math.min(30000, math.max(2000, chars(whole) * 150))
    end
    table.insert(cues, {begin_ms = 0, end_ms = end_ms, text = whole})
  end

  local blocks = {}
  for index, cue in ipairs(cues) do
    table.insert(blocks, srt_block(index, cue.begin_ms, cue.end_ms, cue.text))
  end

  local usage = nil
  if duration > 0 then
    usage = {seconds = duration}
  end
  return {text = table.concat(blocks, "\n\n") .. "\n", usage = usage}
end
