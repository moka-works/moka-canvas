-- Zhipu GLM · Text to Speech
--
-- API reference:
--   https://docs.bigmodel.cn/api-reference/模型-api/语音合成
--
-- The shape is the familiar speech one: the words in `input`, the voice by
-- name, the container it comes back in, and the recording as the answer's own
-- bytes. A voice has no default here — the service answers in whichever one
-- the model was paired with when the name is missing — so the request names
-- the one the room chose.

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

function build_request(call, req, inputs)
  local body = {
    model = call.model,
    input = req.prompt or "",
  }
  local voice = trimmed(tostring(req.params.voice or ""))
  if voice ~= "" then
    body.voice = voice
  end
  local format = trimmed(tostring(req.params.format or ""))
  if format ~= "" then
    body.response_format = format
  end
  local speed = number_param(req.params, "speed")
  if speed ~= nil then
    body.speed = speed
  end

  return {
    method = "POST",
    url = call.url,
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
