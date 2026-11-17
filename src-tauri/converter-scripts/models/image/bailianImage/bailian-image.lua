-- Alibaba Cloud Bailian (Model Studio) image generation and editing.
--
-- One call makes a picture: the words alone are a drawing, and pictures beside
-- them are what makes it an edit. Both travel to the same address as parts of
-- one message, which is the shape this service reads either from.
--
-- The answer names each drawing rather than carrying it, so the host fetches
-- it from the address it was left at — unless the deployment inlined it as a
-- data URL, which is a drawing that needs no fetching.

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

-- A shape reduced to pixels: about a megapixel in the same proportion, both
-- sides a multiple of sixteen, which is the arithmetic the service's own
-- examples are written in.
local function about_a_megapixel(width, height)
  local scale = math.sqrt(1024.0 * 1024.0 / (width * height))
  local function side(value)
    local scaled = math.floor(value * scale / 16.0 + 0.5) * 16.0
    if scaled < 16.0 then
      scaled = 16.0
    end
    return scaled
  end
  return string.format("%d*%d", side(width), side(height))
end

-- The size this service is told for the shape a request asked for.
--
-- It takes a tier — `1K`, `2K`, `4K` — and a pixel size written width*height,
-- and a shape stated as a proportion is reduced to the pixels that describe
-- it, which is the way a shape travels to a service that has no name for
-- proportions. A size nobody stated is no size at all, and the service
-- chooses.
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
    return string.format("%d*%d", width, height)
  end
  width, height = sides(lowered, ":")
  if width == nil then
    return nil
  end
  return about_a_megapixel(width, height)
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

-- Wan 2.7 image models do not read prompt_extend; their own thinking mode is
-- a different switch. Every other model in this family takes the flag, and a
-- request that says nothing gets it off so the words are sent as they are.
local function accepts_prompt_extend(model)
  local lowered = tostring(model or ""):lower()
  return lowered:find("wan2.7-image", 1, true) == nil
end

local function image_parameters(req, model)
  local told = {}
  local size = size_of(req.params.size)
  if size ~= nil then
    told.size = size
  end
  local count = integer_param(req.params, "count")
  if count ~= nil and count > 0 then
    told.n = count
  end
  if accepts_prompt_extend(model) then
    told.prompt_extend = req.params.prompt_extend == true
  end
  return told
end

-- A picture asked for: the words alone are a drawing, and pictures beside them
-- are what makes it an edit.
local function content_of(req, inputs)
  local content = {}
  for _, input in ipairs(inputs) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      table.insert(content, {image = input.data_url})
    end
  end
  table.insert(content, {text = req.prompt or ""})
  return content
end

local function refusal(payload)
  local code = payload.code
  if code == nil or payload.output ~= nil then
    return nil
  end
  local explanation = trimmed(tostring(payload.message or ""))
  if explanation == "" then
    return "the service refused the request: " .. tostring(code)
  end
  return tostring(code) .. ": " .. explanation
end

local function tokens(payload)
  local counted = payload.usage
  if type(counted) ~= "table" then
    return nil
  end
  local input = counted.input_tokens
  local output = counted.output_tokens
  if input == nil and output == nil then
    return nil
  end
  return {input_tokens = input, output_tokens = output}
end

function build_request(call, req, inputs)
  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode({
      model = call.model,
      input = {messages = {{role = "user", content = content_of(req, inputs)}}},
      parameters = image_parameters(req, call.model),
    }),
  }
end

-- The drawings in an answer, each one named by the address it was left at —
-- unless it was inlined there, which is a drawing the host reads itself.
function parse_response(status, headers, body)
  local payload = json.decode(body)
  local refused = refusal(payload)
  if refused ~= nil then
    return {error = refused}
  end
  local items = {}
  local choice = payload.output and payload.output.choices and payload.output.choices[1]
  local parts = choice and choice.message and choice.message.content
  if type(parts) == "table" then
    for _, part in ipairs(parts) do
      local address = part.image
      if type(address) == "string" then
        if address:sub(1, 5) == "data:" then
          table.insert(items, {data_url = address})
        else
          table.insert(items, {url = address})
        end
      end
    end
  end
  -- The totals of a drawing answer: how many arrived, and the tokens the
  -- service counted beside them.
  local usage = tokens(payload) or {}
  if #items > 0 then
    usage.images = #items
  end
  return {items = items, usage = usage}
end
