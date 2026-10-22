-- AssemblyAI · Speech recognition (a recording, as a job)
--
-- API reference:
--   https://www.assemblyai.com/docs/pre-recorded-audio/getting-started
--   https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/files/upload
--
-- The service takes a recording by address rather than by file, so one that
-- lives on somebody's machine is uploaded first. Four calls, chained by
-- returning the next one:
--
--   1. POST {api}/v2/upload            the recording, as the body itself
--   2. POST {api}/v2/transcript        submit the address the upload answered
--   3. GET  {api}/v2/transcript/{id}   poll until done
--
-- The last answer carries the words themselves, with their times and, where
-- speaker labels were asked for, who spoke.

local POLL_MS = 3000
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

local function api_base(url)
  local root = trimmed(url or ""):match("^(https?://[^/]+)")
  if root == nil then
    return "https://api.assemblyai.com"
  end
  return root
end

local function cues_of(payload, label)
  local cues = {}
  for _, utterance in ipairs(payload.utterances or {}) do
    local words = clean(utterance.text)
    if words ~= "" then
      local speaker = speaker_number(utterance.speaker)
      local prefix = ""
      if type(label) == "string" and speaker ~= nil then
        prefix = speaker_text(label, speaker)
      end
      table.insert(cues, {
        begin_ms = tonumber(utterance.start) or 0,
        end_ms = tonumber(utterance["end"]) or 0,
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
    local text = clean(word.text)
    if text ~= "" then
      local speaker = speaker_number(word.speaker)
      local begin_ms = tonumber(word.start) or 0
      local end_ms = tonumber(word["end"]) or 0
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

function build_task_request(call, req, inputs)
  local input = inputs[1]
  if input == nil then
    return {error = "no recording was sent to be recognized"}
  end
  local speaker_count = tonumber(req.params.speakerCount or 0) or 0
  return {
    state = {
      url = call.url,
      model = call.model,
      speakerLabel = req.params.speakerLabel,
      speakerCount = speaker_count,
      language = trimmed(tostring(req.params.language or "")),
    },
    request = {
      method = "POST",
      url = api_base(call.url) .. "/v2/upload",
      headers = {["Content-Type"] = input.mime or "application/octet-stream"},
      -- The recording travels in the body itself; this service's upload
      -- takes the bytes rather than a form around them.
      body = {raw = {input = 1}},
    },
    handler = "parse_upload",
  }
end

function parse_upload(status, headers, body, state)
  if status < 200 or status >= 300 then
    return {error = "the recording could not be uploaded (HTTP " .. tostring(status) .. "): " .. body}
  end
  local uploaded = json.decode(body) or {}
  local address = uploaded.upload_url
  if type(address) ~= "string" or address == "" then
    return {error = "the upload came back without an address: " .. body}
  end

  local transcript = {
    audio_url = address,
    punctuate = true,
    format_text = true,
  }
  if type(state.model) == "string" and state.model ~= "" then
    transcript.speech_model = state.model
  end
  if state.language ~= "" then
    transcript.language_code = state.language
  end
  if state.speakerLabel ~= nil or state.speakerCount > 0 then
    transcript.speaker_labels = true
    if state.speakerCount > 0 then
      transcript.speakers_expected = state.speakerCount
    end
  end

  state.upload_url = address
  return {
    state = state,
    next = {
      request = {
        method = "POST",
        url = api_base(state.url) .. "/v2/transcript",
        headers = {["Content-Type"] = "application/json"},
        body = json.encode(transcript),
      },
      handler = "parse_task_response",
    },
  }
end

function parse_task_response(status, headers, body, state)
  if status < 200 or status >= 300 then
    return {error = "HTTP " .. tostring(status) .. ": " .. body}
  end
  local payload = json.decode(body) or {}
  local reference = payload.id
  if type(reference) ~= "string" or reference == "" then
    return {error = "the job started without a handle to poll: " .. body}
  end
  -- The handle a later poll is given carries the label this script learned
  -- when the job started, because polling is a call of its own and what one
  -- step learned only reaches the next through what it says.
  local label = (state or {}).speakerLabel
  if type(label) ~= "string" then
    label = ""
  end
  return {reference = reference .. "|" .. label, poll_interval_ms = POLL_MS}
end

function build_poll_request(call, task)
  local base = api_base(call.url)
  local reference, label = string.match(task.reference, "^([^|]*)|?(.*)$")
  if reference == nil then
    reference = task.reference
  end
  return {
    state = {speakerLabel = label ~= "" and label or nil},
    method = "GET",
    url = base .. "/v2/transcript/" .. reference,
    headers = {},
  }
end

function parse_poll_response(status, headers, body, state)
  if status < 200 or status >= 300 then
    if status == 404 or status == 410 then
      return {status = "expired", error = "the job is gone"}
    end
    return {error = "HTTP " .. tostring(status) .. ": " .. body}
  end
  local payload = json.decode(body) or {}
  local job = payload.status or "unknown"
  if job == "error" then
    return {status = "failed", error = payload.error or "the job failed without saying why"}
  end
  if job ~= "completed" then
    return {status = "pending", poll_interval_ms = POLL_MS}
  end

  local label = (state or {}).speakerLabel
  local duration = tonumber(payload.audio_duration) or 0
  local cues = cues_of(payload, label)
  if #cues == 0 then
    local whole = clean(payload.text)
    if whole == "" then
      return {status = "failed", error = "no speech was found in the recording"}
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

  local result = {text = table.concat(blocks, "\n\n") .. "\n"}
  if duration > 0 then
    result.usage = {seconds = duration}
  end
  return {status = "succeeded", result = result}
end
