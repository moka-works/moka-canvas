-- Volcengine Ark (火山方舟) image generation and editing.
--
-- API reference:
--   https://www.volcengine.com/docs/ark/image-generation-api
--
-- One call makes a picture. The words alone are a drawing, and pictures beside
-- them are what makes it an edit: this service takes the pictures as a list of
-- its own rather than as parts of a message, and each one travels as the bytes
-- themselves so that nothing has to be fetched before the drawing starts.
--
-- A shape stated as a proportion is reduced to pixels — about two megapixels in
-- the same proportion, both sides a multiple of sixteen — because this service
-- takes a tier or a pixel size and has no name for proportions. The base is two
-- megapixels rather than one because the service's own floor is a million
-- pixels of whatever shape is asked for: a wide shape reduced to a megapixel
-- would be a size it refuses.
--
-- Several copies of one drawing are asked for as a group, which is this
-- service's own way of saying how many are wanted: it draws them in one run
-- over the same words, and the answer may carry fewer than were asked for.
--
-- A drawing carries no mark of the platform's own: this service stamps one by
-- default and the request has no field for it, so the mark is turned off where
-- the room states nothing — a picture made to be used in a film is asked for
-- without the stamp it would otherwise be delivered wearing.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function whole(text)
  local number = tonumber(trimmed(text))
  if number == nil or math.type(number) ~= "integer" or number <= 0 then
    return nil
  end
  return number
end

-- Two whole numbers out of the two sides of a size, in whatever spacing it
-- arrived. A side of nothing or of zero describes no shape at all.
local function sides(size, separator)
  local at = size:find(separator, 1, true)
  if at == nil then
    return nil
  end
  local width = whole(size:sub(1, at - 1))
  local height = whole(size:sub(at + 1))
  if width == nil or height == nil then
    return nil
  end
  return width, height
end

-- A shape reduced to pixels: about two megapixels in the same proportion, both
-- sides a multiple of sixteen, which is the arithmetic the service's own
-- examples are written in.
local function about_two_megapixels(width, height)
  local scale = 2048.0 / math.max(width, height)
  local function side(value)
    local scaled = math.floor(value * scale / 16.0 + 0.5) * 16.0
    if scaled < 16.0 then
      scaled = 16.0
    end
    return scaled
  end
  return string.format("%dx%d", side(width), side(height))
end

-- The size this service is told for the shape a request asked for.
--
-- It takes a tier — `1K`, `2K`, `4K` — and a pixel size written widthxheight,
-- and a shape stated as a proportion is reduced to the pixels that describe it.
-- A size nobody stated is no size at all, and the service chooses.
local function size_of(asked)
  if type(asked) ~= "string" then
    return nil
  end
  local lowered = trimmed(asked):lower()
  if lowered == "" or lowered == "auto" then
    return nil
  end
  if lowered == "1k" or lowered == "2k" or lowered == "4k" then
    return lowered:upper()
  end
  local width, height = sides(lowered, "x")
  if width == nil then
    width, height = sides(lowered, "*")
  end
  if width ~= nil then
    return string.format("%dx%d", width, height)
  end
  width, height = sides(lowered, ":")
  if width == nil then
    return nil
  end
  return about_two_megapixels(width, height)
end

local function integer_param(params, key)
  local value = params[key]
  if value == nil then
    return nil
  end
  if math.type(value) == "integer" then
    return value
  end
  if type(value) == "string" then
    local parsed = tonumber(trimmed(value))
    if parsed ~= nil and math.type(parsed) == "integer" then
      return parsed
    end
  end
  return nil
end

-- The background, for the two words this service knows. Anything else — the
-- `auto` of a request that leaves the choice open among them — travels as
-- nothing, which is the same ask said the service's own way.
local function background_of(value)
  if type(value) ~= "string" then
    return nil
  end
  local word = trimmed(value):lower()
  if word == "transparent" or word == "opaque" then
    return word
  end
  return nil
end

-- The pictures a request carried, each one as the bytes themselves. Every
-- picture travels, a mask beside them included: this service has no field of
-- its own for a mask, and the words are what tell the model which of the
-- pictures says where to draw.
local function pictures_of(inputs)
  local pictures = {}
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      table.insert(pictures, input.data_url)
    end
  end
  return pictures
end

function build_request(call, req, inputs)
  local body = {model = call.model, prompt = req.prompt or ""}
  local size = size_of(req.params.size)
  if size ~= nil then
    body.size = size
  end
  local count = integer_param(req.params, "count")
  if count ~= nil and count > 1 then
    body.sequential_image_generation = "auto"
    body.sequential_image_generation_options = {max_images = count}
  end
  local background = background_of(req.params.background)
  if background ~= nil then
    body.background = background
  end
  -- The service states its prompt optimization as a mode, not a flag; the
  -- switch this model offers turns the standard mode on and says nothing
  -- when it is off, which is the service's own way of leaving words alone.
  if req.params.optimize_prompt == true then
    body.optimize_prompt_options = {mode = "standard"}
  end
  local pictures = pictures_of(inputs)
  if #pictures > 0 then
    body.image = pictures
  end
  body.watermark = false

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

-- The drawings in an answer, each one named by the address it was left at, or
-- carried inside the answer where the deployment inlined it.
function parse_response(status, headers, body)
  local payload = json.decode(body)
  local items = {}
  for _, entry in ipairs(payload.data or {}) do
    if type(entry.b64_json) == "string" then
      table.insert(items, {base64 = entry.b64_json})
    elseif type(entry.url) == "string" then
      -- An address of the platform's own: the host fetches it, and the
      -- credential follows the address rather than the script.
      table.insert(items, {url = entry.url})
    end
  end
  if #items == 0 then
    return {error = "the service answered without a drawing"}
  end
  -- The totals of a drawing answer: how many arrived, and the tokens the
  -- service counted beside them where it counted any.
  local usage = {images = #items}
  local counted = payload.usage
  if type(counted) == "table" and type(counted.output_tokens) == "number" then
    usage.output_tokens = counted.output_tokens
  end
  return {items = items, usage = usage}
end
