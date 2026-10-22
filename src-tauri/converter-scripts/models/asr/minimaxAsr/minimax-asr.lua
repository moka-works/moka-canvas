-- MiniMax speech recognition: one call, answered with the words.
--
-- API reference:
--   https://platform.minimax.io/docs/api-reference/speech-to-text
--
-- The recording travels as the file part of one multipart request — this
-- service takes the bytes themselves rather than an address to fetch them
-- from — and the words come back in the answer rather than behind a job, so
-- there is nothing to poll: where a job-serving script would have started a
-- job, this one answers whole.
--
-- The answer is asked for in its verbose shape, where the sentences carry
-- their own times and, where more than one voice was heard, who spoke: the
-- cues are those sentences, one each, measured from the beginning of the
-- audio that was sent. Where the answer came back without them the words are
-- one cue under the recording's own length, which is what a recognizer that
-- heard one thing has to say.
--
-- The language rides as a header of the request rather than as a field of the
-- form. A room's field is free text, so a value that is no language tag is
-- left out rather than sent, and the recognizer decides.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- A sentence's words on one line, whatever the recognizer spaced them with.
local function clean(text)
  if type(text) ~= "string" then
    return ""
  end
  local collapsed = string.gsub(text, "%s+", " ")
  return string.gsub(collapsed, "^%s*(.-)%s*$", "%1")
end

-- A language tag, as this service reads one: letters, digits, and the dashes
-- between them.
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

-- "说话人{id}：" with the speaker filled in. The service names its speakers
-- itself, so the value stands in as it was said; the words around {id} belong
-- to whoever is reading, which is why they arrive as a template rather than as
-- text decided here.
local function speaker_text(label, speaker)
  local text = string.gsub(label, "{id}", function()
    return tostring(speaker)
  end)
  return text
end

function build_request(call, req, inputs)
  local recording = inputs[1]
  if recording == nil then
    return {error = "no recording was sent to be recognized"}
  end
  local headers = {}
  local language = language_of(req.params.language)
  if language ~= nil then
    headers["language"] = language
  end
  return {
    -- Handed to the answer so a cue can say who is speaking.
    state = {speakerLabel = req.params.speakerLabel},
    method = "POST",
    url = call.url,
    headers = headers,
    body = {
      multipart = {
        fields = {
          model = call.model,
          -- The verbose shape is where the sentences carry their own times,
          -- which is what a subtitle is written from.
          response_format = "verbose_json",
          timestamp_level = "sentence",
        },
        file = {part = "file", input = 1},
      },
    },
  }
end

function parse_response(status, headers, body, state)
  local payload = json.decode(body)
  local label = (state or {}).speakerLabel
  local duration = tonumber(payload.duration) or 0
  local durationMs = duration * 1000.0

  local cues = {}
  for _, sentence in ipairs(payload.segments or {}) do
    local words = clean(sentence.text)
    if words ~= "" then
      local prefix = ""
      if type(label) == "string" and label ~= "" and sentence.speaker ~= nil then
        prefix = speaker_text(label, sentence.speaker)
      end
      local beginMs = (tonumber(sentence.start) or 0) * 1000.0
      -- `end` is a word Lua keeps for itself, so the field is read by name.
      local endMs = (tonumber(sentence["end"]) or 0) * 1000.0
      if endMs < beginMs then
        endMs = beginMs
      end
      table.insert(cues, {start_ms = beginMs, end_ms = endMs, text = prefix .. words})
    end
  end

  if #cues == 0 then
    -- No sentences, so whatever was heard is one cue under the recording's
    -- own length; a recording with nothing to say is a refusal rather than an
    -- empty subtitle.
    local whole = clean(payload.text)
    if whole == "" then
      return {error = "no speech was found in the recording"}
    end
    table.insert(cues, {start_ms = 0, end_ms = durationMs, text = whole})
  end

  local usage = nil
  if duration > 0 then
    usage = {seconds = duration}
  end
  return {cues = cues, usage = usage}
end
