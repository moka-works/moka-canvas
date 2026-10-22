-- MiniMax chat completions.
--
-- API reference:
--   https://platform.minimax.io/docs/api-reference/text-chat-openai
--
-- A question travels as a message: the words alone are a bare string, and a
-- picture beside them makes the same message a document of parts whose picture
-- is carried inside the message rather than left at an address the service has
-- to fetch.
--
-- How hard to think is two things here: a switch — the service's own middle
-- `adaptive`, or `disabled` to keep the answer to itself — and a word naming
-- one of the depths the service knows. The effort the room states is read as
-- the switch off for `none`, as the lightest word the service has for
-- `minimal` (a depth this service does not name), and as its own word for the
-- rest; `auto` is what saying nothing says, and travels as nothing.
--
-- The totals of a streamed answer travel only where they are asked for: a
-- stream that never counted its tokens leaves the answer uncounted, so the
-- closing event is asked to carry them.

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

-- The question as one message: the words alone where they are all it is, and
-- beside the pictures otherwise. A clip sent as a picture no model can hear is
-- left out rather than carried as a part nothing reads.
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

-- One turn of a conversation in this shape. Tool calls travel with their
-- arguments as text, and a tool result is a message of its own named by the
-- call it answers.
local function turn(message)
  local content = message.text or ""
  if message.role == "assistant" then
    local sent = {role = "assistant", content = content}
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
    end
    return sent
  end
  if message.role == "tool" then
    local sent = {
      role = "tool",
      tool_call_id = message.tool_call_id,
      content = content,
    }
    if message.name then
      sent.name = message.name
    end
    return sent
  end
  return {role = message.role, content = content}
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

local function tool_choice_of(req)
  local choice = req.tool_choice
  if type(choice) ~= "string" or trimmed(choice) == "" then
    return "auto"
  end
  if choice == "auto" or choice == "none" then
    return choice
  end
  return {type = "function", ["function"] = {name = choice}}
end

-- A call's arguments, decoded where the service sent JSON and handed over as
-- text otherwise, so a malformed call is reported rather than becoming empty.
local function arguments_of(raw)
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
  return arguments
end

local function call_of(call)
  local part = call["function"] or {}
  return {id = call.id, name = part.name, arguments = arguments_of(part.arguments)}
end

local function calls_of(message)
  local list = message and message.tool_calls or {}
  local calls = {}
  for _, call in ipairs(list) do
    local converted = call_of(call)
    if type(converted.name) == "string" then
      table.insert(calls, converted)
    end
  end
  return calls
end

-- The pieces of a streamed call, keyed by the position the service gave them.
local function call_deltas(delta)
  local list = delta and delta.tool_calls or {}
  local calls = {}
  for position, part in ipairs(list) do
    local function part_of()
      return part["function"] or {}
    end
    local arguments = part_of().arguments
    if type(arguments) == "table" then
      arguments = json.encode(arguments)
    end
    table.insert(calls, {
      index = part.index or (position - 1),
      id = part.id,
      name = part_of().name,
      arguments_delta = arguments,
    })
  end
  return calls
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

-- The depths this service names, with the lightest of its own standing in for
-- the one it does not.
local EFFORT_WORDS = {
  minimal = "low",
  low = "low",
  medium = "medium",
  high = "high",
  xhigh = "xhigh",
  max = "max",
}

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
    body.tool_choice = tool_choice_of(req)
  end
  if streaming then
    body.stream = true
    body.stream_options = {include_usage = true}
  end
  local temperature = number_param(req.params, "temperature")
  if temperature ~= nil then
    body.temperature = temperature
  end
  local tokens = integer_param(req.params, "maxTokens")
  if tokens ~= nil then
    -- This service names the ceiling `max_completion_tokens`; the older name
    -- is one it keeps for compatibility rather than reads.
    body.max_completion_tokens = tokens
  end
  local effort = req.params.reasoningEffort
  if type(effort) == "string" then
    local word = trimmed(effort):lower()
    if word == "none" then
      body.thinking = {type = "disabled"}
    elseif EFFORT_WORDS[word] ~= nil then
      body.reasoning_effort = EFFORT_WORDS[word]
    end
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

function parse_response(status, headers, body)
  local payload = json.decode(body)
  local choice = (payload.choices or {})[1] or {}
  local message = choice.message or {}
  local text = message.content
  if type(text) ~= "string" or trimmed(text) == "" then
    text = nil
  end
  local calls = calls_of(message)
  local finish = choice.finish_reason
  if #calls > 0 and finish == nil then
    finish = "tool_calls"
  end
  return {
    text = text,
    usage = tokens(payload),
    tool_calls = calls,
    finish_reason = finish,
  }
end

-- One event: the piece written since the last one, the totals where the
-- closing event carried them, the fragments of any tool call, and a complaint
-- where the service sent one instead of a piece — a stream that has opened has
-- no status left to refuse with.
function parse_event(event)
  local payload = json.decode(event)
  if type(payload.error) == "table" then
    local explanation = trimmed(tostring(payload.error.message or ""))
    if explanation == "" then
      explanation = tostring(payload.error.code or "the service refused the request")
    end
    return {failed = explanation}
  end
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
  local calls = call_deltas(delta)
  if #calls == 0 then
    local full = calls_of(choice.message)
    for position, call in ipairs(full) do
      calls[position] = {
        index = position - 1,
        id = call.id,
        name = call.name,
        arguments_delta = json.encode(call.arguments),
      }
    end
  end
  local finish = choice.finish_reason
  if #calls > 0 and finish == nil then
    finish = "tool_calls"
  end
  return {
    text = text,
    complete = complete,
    usage = tokens(payload),
    tool_calls = calls,
    finish_reason = finish,
  }
end
