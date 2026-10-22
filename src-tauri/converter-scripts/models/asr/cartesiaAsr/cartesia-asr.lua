-- Cartesia · Ink speech recognition
--
-- API reference:
--   https://docs.cartesia.ai/api-reference/stt/transcribe
--
-- The recording travels as the file part of a multipart request; the words
-- come back with their times, and they are gathered into cues short enough to
-- read. The version the request is read as travels in a header of its own.

local VERSION = "2024-06-10"
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

local function cues_of(payload)
  local cues = {}
  local held = nil
  local function flush()
    if held ~= nil then
      table.insert(cues, held)
      held = nil
    end
  end

  for _, word in ipairs(payload.words or {}) do
    local text = clean(word.word or word.text)
    if text ~= "" then
      local start_ms = (tonumber(word.start) or 0) * 1000
      local end_ms = (tonumber(word["end"]) or 0) * 1000
      local same = held ~= nil
        and (start_ms - held.end_ms) <= 800
        and (end_ms - held.start_ms) <= CUE_MAX_MS
        and (chars(held.text) + chars(text)) <= CUE_MAX_CHARS
      if same then
        held.end_ms = end_ms
        held.text = held.text .. " " .. text
      else
        flush()
        held = {start_ms = start_ms, end_ms = end_ms, text = text}
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
  local fields = {
    model = call.model,
    ["timestamp_granularities[]"] = "word",
  }
  if type(req.params.language) == "string" and trimmed(req.params.language) ~= "" then
    fields.language = trimmed(req.params.language)
  end

  return {
    method = "POST",
    url = call.url,
    headers = {["Cartesia-Version"] = VERSION},
    body = {
      multipart = {
        fields = fields,
        file = {part = "file", input = 1},
      },
    },
  }
end

function parse_response(status, headers, body)
  local payload = json.decode(body)
  if type(payload) ~= "table" then
    return {error = "the recognizer answered without a document"}
  end
  if type(payload.error) == "table" then
    return {error = payload.error.message or "the recording was refused"}
  end
  if type(payload.error) == "string" and payload.error ~= "" then
    return {error = payload.error}
  end

  local duration = tonumber(payload.duration) or 0
  local cues = cues_of(payload)
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
