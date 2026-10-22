-- Zhipu GLM · Image generation (CogView / GLM-Image)
--
-- API reference:
--   https://docs.bigmodel.cn/api-reference/模型-api/图像生成
--
-- A picture is asked for in one call and answered in one: the request names
-- the model, the words and the shape, and the answer carries the picture,
-- usually as an address the host fetches and sometimes inside the document as
-- base64.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function whole(value)
  local number = tonumber(value)
  if number == nil then
    return nil
  end
  return math.floor(number + 0.5)
end

local function size_of(params)
  local size = trimmed(tostring(params.size or ""))
  if string.match(size, "^%d+[xX]%d+$") then
    return string.lower(size)
  end
  return nil
end

function build_request(call, req, inputs)
  local body = {
    model = call.model,
    prompt = req.prompt or "",
  }
  local size = size_of(req.params)
  if size ~= nil then
    body.size = size
  end
  local quality = trimmed(tostring(req.params.quality or ""))
  if quality ~= "" then
    body.quality = quality
  end
  local count = whole(req.params.count)
  if count ~= nil and count > 0 then
    body.n = count
  end
  if type(req.params.watermark) == "boolean" then
    body.watermark_enabled = req.params.watermark
  end

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

local function mime_of(url)
  local lower = string.lower(url or "")
  if string.match(lower, "%.jpe?g$") then
    return "image/jpeg"
  end
  if string.match(lower, "%.webp$") then
    return "image/webp"
  end
  return "image/png"
end

function parse_response(status, headers, body)
  local payload = json.decode(body)
  if type(payload) ~= "table" then
    return {error = "the service answered without a document"}
  end
  if type(payload.error) == "table" then
    return {error = payload.error.message or "the request was refused"}
  end
  if type(payload.error) == "string" and payload.error ~= "" then
    return {error = payload.error}
  end

  local items = {}
  for _, picture in ipairs(payload.data or {}) do
    if type(picture.url) == "string" and picture.url ~= "" then
      table.insert(items, {url = picture.url, mime = mime_of(picture.url)})
    elseif type(picture.b64_json) == "string" and picture.b64_json ~= "" then
      table.insert(items, {base64 = picture.b64_json, mime = "image/png"})
    end
  end
  if #items == 0 then
    return {error = "the answer carried no picture"}
  end
  return {items = items, usage = {images = #items}}
end
