-- OpenAI-compatible chat completions: the shape most gateways and aggregators
-- speak.
--
-- The address a configuration carries is the whole endpoint, and this script
-- posts the question to it and nowhere else — a gateway that answers there
-- answers in this shape.
--
-- A question travels as a message: the words alone are a bare string, which is
-- what a gateway that cannot see pictures accepts, and a picture beside them
-- makes the same message a document of parts. Pieces are asked for in the body,
-- and each event carries what has been written since the last one; a gateway
-- that buffers answers the whole thing in one closing chunk instead, which is
-- read as the answer it is.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function pictures_of(inputs)
  local pictures = {}
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      table.insert(pictures, input)
    end
  end
  return pictures
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

-- What the question is, as one message: the words, with the pictures beside
-- them where there are any. Audio and video have no part in this shape, and a
-- clip sent as a picture no model can hear would be worse than one left out.
local function said(req, pictures)
  if #pictures == 0 then
    return req.prompt or ""
  end
  local content = {}
  table.insert(content, {type = "text", text = req.prompt or ""})
  for _, picture in ipairs(pictures) do
    table.insert(content, {type = "image_url", image_url = {url = picture.data_url}})
  end
  return content
end

-- "Auto" means the provider picks the effort itself, and some channels reject
-- it as a value they do not know, so it never travels.
local function reasoning_effort(params)
  local effort = params.reasoningEffort
  if type(effort) ~= "string" or trimmed(effort):lower() == "auto" then
    return nil
  end
  return effort
end

-- One turn of a conversation in this shape. Tool calls travel with the
-- arguments as text; a tool result is its own message rather than a field of
-- the assistant turn that asked for it.
local function turn(message)
  local content = message.text
  if type(content) ~= "string" then
    content = ""
  end
  local sent = {role = message.role, content = content}
  local calls = message.tool_calls or {}
  if #calls > 0 then
    sent.tool_calls = {}
    for _, call in ipairs(calls) do
      local arguments = call.arguments
      if type(arguments) ~= "string" then
        arguments = json.encode(arguments or {})
      end
      table.insert(sent.tool_calls, {
        id = call.id,
        type = "function",
        ["function"] = {name = call.name, arguments = arguments},
      })
    end
    if trimmed(content) == "" then
      sent.content = nil
    end
  end
  if message.tool_call_id then
    sent.tool_call_id = message.tool_call_id
  end
  if message.name then
    sent.name = message.name
  end
  return sent
end

local function conversation(req)
  local messages = {}
  if req.system and trimmed(req.system) ~= "" then
    table.insert(messages, {role = "system", content = req.system})
  end
  for _, message in ipairs(req.messages or {}) do
    if message.role ~= "system" or #messages == 0 then
      table.insert(messages, turn(message))
    end
  end
  return messages
end

local function tools_of(req)
  local tools = {}
  for _, tool in ipairs(req.tools or {}) do
    table.insert(tools, {
      type = "function",
      ["function"] = {
        name = tool.name,
        description = tool.description,
        parameters = tool.parameters,
      },
    })
  end
  return tools
end

local function describe(call, req, inputs, streaming)
  local messages = {}
  if req.messages and #req.messages > 0 then
    messages = conversation(req)
  else
    if req.system and trimmed(req.system) ~= "" then
      table.insert(messages, {role = "system", content = req.system})
    end
    table.insert(messages, {role = "user", content = said(req, pictures_of(inputs))})
  end

  local body = {model = call.model, messages = messages}
  local tools = tools_of(req)
  if #tools > 0 then
    body.tools = tools
    body.tool_choice = req.tool_choice or "auto"
  end
  if streaming then
    body.stream = true
  end
  local temperature = number_param(req.params, "temperature")
  if temperature ~= nil then
    body.temperature = temperature
  end
  local tokens = integer_param(req.params, "maxTokens")
  if tokens ~= nil then
    body.max_tokens = tokens
  end
  local effort = reasoning_effort(req.params)
  if effort ~= nil then
    body.reasoning_effort = effort
  end

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

local function tokens(payload)
  local counted = payload.usage
  if type(counted) ~= "table" then
    return nil
  end
  local input = counted.prompt_tokens
  local output = counted.completion_tokens
  if input == nil and output == nil then
    return nil
  end
  return {input_tokens = input, output_tokens = output}
end

function build_request(call, req, inputs)
  return describe(call, req, inputs, false)
end

function build_stream_request(call, req, inputs)
  return describe(call, req, inputs, true)
end

-- A tool call as the host reads it: arguments decoded where they are JSON,
-- and handed over as text otherwise, so a malformed call is reported rather
-- than silently becoming an empty one.
local function call_of(call)
  local function part()
    return call["function"] or {}
  end
  local raw = part().arguments
  local arguments = raw
  if type(raw) == "string" and trimmed(raw) ~= "" then
    local ok, decoded = pcall(json.decode, raw)
    if ok then
      arguments = decoded
    end
  end
  if arguments == nil then
    arguments = {}
  end
  return {id = call.id, name = part().name, arguments = arguments}
end

function parse_response(status, headers, body)
  local payload = json.decode(body)
  local choice = (payload.choices or {})[1] or {}
  local message = choice.message or {}
  local text = message.content
  if type(text) ~= "string" or trimmed(text) == "" then
    text = nil
  end
  local calls = {}
  for _, call in ipairs(message.tool_calls or {}) do
    table.insert(calls, call_of(call))
  end
  return {
    text = text,
    usage = tokens(payload),
    tool_calls = calls,
    finish_reason = choice.finish_reason,
  }
end

-- One event: the piece written since the last one, the totals where the
-- service reported them at the end, and the fragments of any tool call.
function parse_event(event)
  local payload = json.decode(event)
  local choice = (payload.choices or {})[1] or {}
  local delta = choice.delta or {}
  local text = delta.content
  if type(text) ~= "string" or text == "" then
    text = nil
  end
  -- A gateway that buffers answers the whole thing in one closing chunk.
  local complete = (choice.message or {}).content
  if type(complete) ~= "string" or complete == "" then
    complete = nil
  end
  local calls = {}
  for _, part in ipairs(delta.tool_calls or {}) do
    local function part_of()
      return part["function"] or {}
    end
    table.insert(calls, {
      index = part.index or 0,
      id = part.id,
      name = part_of().name,
      arguments_delta = part_of().arguments,
    })
  end
  return {
    text = text,
    complete = complete,
    usage = tokens(payload),
    tool_calls = calls,
    finish_reason = choice.finish_reason,
  }
end
