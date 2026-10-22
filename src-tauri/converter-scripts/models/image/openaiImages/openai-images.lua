-- OpenAI-compatible images: one call draws a picture, and one call with
-- pictures beside the words edits them.
--
-- A drawing is asked for as a JSON document at the address the configuration
-- names. An edit is a different endpoint and a different body shape — the
-- settings travel as form fields beside the bytes rather than as a JSON
-- document — so it is asked at the edit address this one implies:
-- `/images/generations` has its sibling at `/images/edits`, and an address
-- that names neither is used as it stands, because the address is the whole
-- endpoint a configuration carries.
--
-- A shape stated as a proportion is reduced to the nearest of the three sizes
-- this endpoint takes: a request refused for the word it used costs the same as
-- one answered, and a size already in pixels is one it takes.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- The edit address of the generation address a configuration names.
local function edit_url(address)
  return url.swap(address, "/images/generations", "/images/edits")
end

-- The width over the height a size stated as `16:9` describes, or nothing when
-- it is stated some other way.
local function proportion(size)
  local width, height = string.match(trimmed(size), "^(%d+):(%d+)$")
  if width == nil then
    return nil
  end
  local width_number = tonumber(width)
  local height_number = tonumber(height)
  if width_number == nil or height_number == nil then
    return nil
  end
  if width_number <= 0 or height_number <= 0 then
    return nil
  end
  return width_number / height_number
end

-- The size this endpoint is told for the shape a request asked for.
local function size_of(asked)
  if type(asked) ~= "string" or trimmed(asked) == "" then
    return nil
  end
  local ratio = proportion(asked)
  if ratio == nil then
    return asked
  end
  if ratio > 1.0 then
    return "1536x1024"
  end
  if ratio < 1.0 then
    return "1024x1536"
  end
  return "1024x1024"
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

-- The settings both body shapes carry, under the names this endpoint reads.
local function settings(req, editing)
  local told = {}
  local size = size_of(req.params.size)
  if size ~= nil then
    told.size = size
  end
  for _, key in ipairs({"quality", "background"}) do
    local value = req.params[key]
    if type(value) == "string" and trimmed(value) ~= "" then
      told[key] = value
    end
  end
  local count = integer_param(req.params, "count")
  -- A drawing that asked for no special number of copies is asked for one,
  -- which this endpoint says by saying nothing; an edit reads a lone `n` as
  -- the same request and is told only where more than one is wanted.
  if count ~= nil and (editing and count > 1 or not editing and count > 0) then
    told.n = count
  end
  return told
end

-- The pictures a request carried, and the mask that sits apart from them: one
-- mask beside one photograph is still a single-reference edit. Each picture
-- keeps the place it was carried in, which is how the host is told which of
-- the request's own inputs belongs in which file part.
local function divided(inputs)
  local references, masks = {}, {}
  for index, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      local carried = {index = index, input = input}
      if input.role == "mask" then
        table.insert(masks, carried)
      else
        table.insert(references, carried)
      end
    end
  end
  return references, masks
end

function build_request(call, req, inputs)
  local references, masks = divided(inputs)
  if #references == 0 then
    local body = {model = call.model, prompt = req.prompt or ""}
    for key, value in pairs(settings(req, false)) do
      body[key] = value
    end
    return {
      method = "POST",
      url = call.url,
      headers = {["Content-Type"] = "application/json"},
      body = json.encode(body),
    }
  end

  -- One reference travels as `image` and several as `image[]`, which is the
  -- shape the edit endpoint reads a list from. The mask keeps a field of its
  -- own even though it is a picture too; only the first is sent where several
  -- were attached, because the endpoint has one field for it and picking the
  -- first keeps the choice stable.
  local part = #references == 1 and "image" or "image[]"
  local fields = {model = call.model, prompt = req.prompt or ""}
  for key, value in pairs(settings(req, true)) do
    fields[key] = value
  end
  local files = {}
  for _, reference in ipairs(references) do
    table.insert(files, {part = part, input = reference.index})
  end
  if #masks > 0 then
    table.insert(files, {part = "mask", input = masks[1].index})
  end

  return {
    method = "POST",
    url = edit_url(call.url),
    body = {multipart = {fields = fields, files = files}},
  }
end

function parse_response(status, headers, body)
  local payload = json.decode(body)
  local items = {}
  local rewritten = {}
  for _, entry in ipairs(payload.data or {}) do
    if type(entry.b64_json) == "string" then
      table.insert(items, {base64 = entry.b64_json})
    elseif type(entry.url) == "string" then
      -- An address of the provider's own: the host fetches it, and the
      -- credential follows the address rather than the script.
      table.insert(items, {url = entry.url})
    end
    -- A prompt the provider rewrote is the one part of this answer that is
    -- text, and worth showing beside the drawing it produced.
    if type(entry.revised_prompt) == "string" and trimmed(entry.revised_prompt) ~= "" then
      table.insert(rewritten, trimmed(entry.revised_prompt))
    end
  end
  return {
    text = (#rewritten > 0) and table.concat(rewritten, "\n") or nil,
    items = items,
    usage = (#items > 0) and {images = #items} or nil,
  }
end
