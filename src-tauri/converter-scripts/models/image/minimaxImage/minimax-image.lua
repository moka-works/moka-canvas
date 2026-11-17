-- MiniMax image generation and reference.
--
-- API reference:
--   https://platform.minimax.io/docs/api-reference/image-generation-t2i
--   https://platform.minimax.io/docs/api-reference/image-generation-i2i
--
-- One call makes a picture. The words alone are a drawing, and pictures beside
-- them are what the drawing is built on: this service keeps the character it
-- is shown and draws it again, so a picture travels as a subject reference
-- rather than as parts of a message.
--
-- A shape travels the way this service asks for shapes. A proportion is a
-- proportion here — the room's own list is a part of the list this service
-- names — and a shape stated in pixels travels as the two sides, with the
-- rounding this service computes in; a tier or the `auto` of a request that
-- leaves the shape open travels as nothing, and the service chooses.
--
-- A refusal may arrive as a success: the status of this platform rides inside
-- the answer's own base_resp, so a 200 is read for it before anything else.

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

-- The proportions this service names. A proportion outside the list describes
-- no shape it would draw, so it is said nowhere.
local RATIOS = {
  ["1:1"] = true,
  ["16:9"] = true,
  ["4:3"] = true,
  ["3:2"] = true,
  ["2:3"] = true,
  ["3:4"] = true,
  ["9:16"] = true,
  ["21:9"] = true,
}

-- What the request is told about the shape it asked for, as `{ratio}`,
-- `{width, height}`, or nothing at all.
local function shape_of(asked)
  if type(asked) ~= "string" then
    return nil
  end
  local lowered = trimmed(asked):lower()
  if lowered == "" or lowered == "auto" then
    return nil
  end
  if RATIOS[lowered] then
    return {ratio = lowered}
  end
  local width, height = sides(lowered, "x")
  if width == nil then
    width, height = sides(lowered, "*")
  end
  if width ~= nil then
    -- Both sides are drawn to a multiple of eight, which is the arithmetic
    -- this service takes: a size between two of its steps is brought to the
    -- nearer one rather than refused.
    local function step(value)
      local rounded = math.floor(value / 8.0 + 0.5) * 8
      if rounded < 512 then
        rounded = 512
      elseif rounded > 2048 then
        rounded = 2048
      end
      return rounded
    end
    return {width = step(width), height = step(height)}
  end
  return nil
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

-- The pictures the drawing is built on, each as the reference entry this
-- service reads: the kind of reference, and the picture itself as the bytes.
-- Every picture travels, a mask beside them included: this service has no
-- field of its own for a mask, and the words are what tell the model which of
-- the pictures says where to draw.
local function references_of(inputs)
  local references = {}
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      table.insert(references, {type = "character", image_file = input.data_url})
    end
  end
  return references
end

function build_request(call, req, inputs)
  local body = {model = call.model, prompt = req.prompt or ""}
  local shape = shape_of(req.params.size)
  if shape ~= nil then
    if shape.ratio ~= nil then
      body.aspect_ratio = shape.ratio
    else
      body.width = shape.width
      body.height = shape.height
    end
  end
  local count = integer_param(req.params, "count")
  if count ~= nil and count > 1 then
    -- Several copies are one ask here, and the ceiling is the service's own
    -- rather than the number beyond which it refuses to draw.
    if count > 9 then
      count = 9
    end
    body.n = count
  end
  if req.params.prompt_optimizer ~= nil then
    body.prompt_optimizer = req.params.prompt_optimizer == true
  end
  local references = references_of(inputs)
  if #references > 0 then
    body.subject_reference = references
  end
  -- The answer names where each drawing was left rather than carrying it, so
  -- the host fetches it; a drawing inlined would be the same picture said
  -- larger.
  body.response_format = "url"

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

-- The complaint this platform carries inside an answer: its endpoints report
-- a refusal as a success whose own status says otherwise.
local function refusal(payload)
  local response = payload.base_resp
  if type(response) ~= "table" then
    return nil
  end
  local code = tonumber(response.status_code or 0) or 0
  if code == 0 then
    return nil
  end
  local said = trimmed(tostring(response.status_msg or ""))
  if said == "" then
    said = "the service refused the request (code " .. tostring(response.status_code) .. ")"
  end
  return said
end

-- The drawings in an answer, each one named by the address it was left at, or
-- carried inside the answer where the deployment inlined it.
function parse_response(status, headers, body)
  local payload = json.decode(body)
  local refused = refusal(payload)
  if refused ~= nil then
    return {error = refused}
  end
  local data = payload.data or {}
  local items = {}
  for _, address in ipairs(data.image_urls or {}) do
    if type(address) == "string" and trimmed(address) ~= "" then
      -- An address of the platform's own: the host fetches it, and the
      -- credential follows the address rather than the script.
      table.insert(items, {url = address})
    end
  end
  for _, drawing in ipairs(data.image_base64 or {}) do
    if type(drawing) == "string" and trimmed(drawing) ~= "" then
      table.insert(items, {base64 = drawing})
    end
  end
  if #items == 0 then
    return {error = "the service answered without a drawing"}
  end
  -- The totals of a drawing answer: how many drawings arrived.
  return {items = items, usage = {images = #items}}
end
