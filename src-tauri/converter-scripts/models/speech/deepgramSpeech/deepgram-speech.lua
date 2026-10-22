-- Deepgram · Aura Text to Speech
--
-- API reference:
--   https://developers.deepgram.com/docs/text-to-speech
--
-- The voice is the model, and it travels in the query beside the encoding the
-- recording is asked for in. A configuration carries the whole address, so a
-- voice chosen for one ask takes the place of the model the address names.
--
-- The answer is the recording itself, and its type comes from the answer.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
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

-- The encoding, and the container where one is needed, that the answer is
-- asked for in.
local function format_of(format)
  local word = trimmed(tostring(format or "")):lower()
  if word == "opus" then
    return "opus", nil
  end
  if word == "wav" then
    return "linear16", "wav"
  end
  return "mp3", nil
end

function build_request(call, req, inputs)
  local url = call.url
  local voice = trimmed(tostring(req.params.voice or ""))
  if voice ~= "" then
    url = set_query(url, "model", voice)
  end
  local encoding, container = format_of(req.params.format)
  url = set_query(url, "encoding", encoding)
  if container ~= nil then
    url = set_query(url, "container", container)
  end

  return {
    method = "POST",
    url = url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode({text = req.prompt or ""}),
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
