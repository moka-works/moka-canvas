-- Anthropic · Messages API (text, vision, tools, streaming)
--
-- API reference:
--   https://docs.anthropic.com/en/api/messages
--   https://docs.anthropic.com/en/api/messages-streaming
--
-- A message is a document of content blocks rather than a bare string, which
-- is how one turn can carry words, pictures and tool calls together. The
-- system instruction is a field of the request rather than a message, and the
-- version this shape is read as travels in a header of its own.
--
-- A stream is a sequence of events whose `data` names its own kind: the
-- message opens with the prompt's token count, each block writes its pieces,
-- and the stop reason arrives in an event of its own. The input count from the
-- opening event is kept for the closing one, because an event reports only what
-- it knows and the totals are split between two of them.

local ANTHROPIC_VERSION = "2023-06-01"

-- Anthropic requires a ceiling. The largest output most current models allow is
-- used when the request did not name one.
local DEFAULT_MAX_TOKENS = 8192

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
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

local function headers()
  return {
    ["Content-Type"] = "application/json",
    ["anthropic-version"] = ANTHROPIC_VERSION,
  }
end

-- The base64 inside an input's data URL, which is where the bytes a script was
-- handed live: a script cannot carry bytes of its own.
local function encoded(input)
  local url = input.data_url or ""
  local comma = url:find(",", 1, true)
  if not comma then
    return ""
  end
  return url:sub(comma + 1)
end

-- One reference as a content block, for the types this protocol reads. A clip
-- of sound or film has no block here and is left out rather than sent as a type
-- the provider rejects; the words still say what was meant.
local function reference(input)
  local mime = input.mime or ""
  if mime:sub(1, 6) == "image/" then
    return {
      type = "image",
      source = {type = "base64", media_type = mime, data = encoded(input)},
    }
  end
  if mime == "application/pdf" then
    return {
      type = "document",
      source = {type = "base64", media_type = mime, data = encoded(input)},
    }
  end
  return nil
end

-- The arguments of a tool call as a table. The host hands them over decoded
-- where they were JSON; a provider's own text is the fallback.
local function arguments_of(call)
  local arguments = call.arguments
  if type(arguments) == "string" then
    local ok, decoded = pcall(json.decode, arguments)
    if ok then
      return decoded
    end
    return {}
  end
  if type(arguments) ~= "table" then
    return {}
  end
  return arguments
end

local function assistant_blocks(message)
  local blocks = {}
  if type(message.text) == "string" and trimmed(message.text) ~= "" then
    table.insert(blocks, {type = "text", text = message.text})
  end
  for _, call in ipairs(message.tool_calls or {}) do
    table.insert(blocks, {
      type = "tool_use",
      id = call.id,
      name = call.name,
      input = arguments_of(call),
    })
  end
  return blocks
end

-- A conversation as turns of blocks. Several tool results in a row are one
-- user turn here rather than one turn each, which is the shape this protocol
-- insists on: the answer to every call made in one assistant turn arrives
-- together.
local function conversation(req)
  local messages = {}
  local system = {}
  if type(req.system) == "string" and trimmed(req.system) ~= "" then
    table.insert(system, req.system)
  end
  local results = {}

  local function flush_results()
    if #results == 0 then
      return
    end
    table.insert(messages, {role = "user", content = results})
    results = {}
  end

  for _, message in ipairs(req.messages or {}) do
    if message.role == "system" then
      if type(message.text) == "string" and trimmed(message.text) ~= "" then
        table.insert(system, message.text)
      end
    elseif message.role == "tool" then
      table.insert(results, {
        type = "tool_result",
        tool_use_id = message.tool_call_id,
        content = message.text or "",
      })
    else
      flush_results()
      if message.role == "assistant" then
        local blocks = assistant_blocks(message)
        if #blocks > 0 then
          table.insert(messages, {role = "assistant", content = blocks})
        end
      else
        table.insert(messages, {
          role = "user",
          content = {{type = "text", text = message.text or ""}},
        })
      end
    end
  end
  flush_results()

  return messages, table.concat(system, "\n\n")
end

local function tool_choice(req)
  local choice = req.tool_choice
  if type(choice) ~= "string" or trimmed(choice) == "" then
    return nil
  end
  if choice == "auto" then
    return {type = "auto"}
  end
  if choice == "none" then
    return {type = "none"}
  end
  if choice == "any" then
    return {type = "any"}
  end
  return {type = "tool", name = choice}
end

local function tools_of(req)
  local tools = {}
  for _, tool in ipairs(req.tools or {}) do
    table.insert(tools, {
      name = tool.name,
      description = tool.description,
      input_schema = tool.parameters or {type = "object"},
    })
  end
  return tools
end

local function describe(call, req, inputs, streaming)
  local body = {
    model = call.model,
    max_tokens = integer_param(req.params, "maxTokens") or DEFAULT_MAX_TOKENS,
  }

  if req.messages and #req.messages > 0 then
    local messages, system = conversation(req)
    body.messages = messages
    if system ~= "" then
      body.system = system
    end
  else
    local content = {}
    if type(req.prompt) == "string" and trimmed(req.prompt) ~= "" then
      table.insert(content, {type = "text", text = req.prompt})
    end
    for _, input in ipairs(inputs or {}) do
      local block = reference(input)
      if block ~= nil then
        table.insert(content, block)
      end
    end
    body.messages = {{role = "user", content = content}}
    if type(req.system) == "string" and trimmed(req.system) ~= "" then
      body.system = req.system
    end
  end

  local tools = tools_of(req)
  if #tools > 0 then
    body.tools = tools
    local choice = tool_choice(req)
    if choice ~= nil then
      body.tool_choice = choice
    end
  end
  local temperature = number_param(req.params, "temperature")
  if temperature ~= nil then
    body.temperature = temperature
  end
  if streaming then
    body.stream = true
  end

  return {
    method = "POST",
    url = call.url,
    headers = headers(),
    body = json.encode(body),
  }
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

local function finish_of(reason)
  if reason == "tool_use" then
    return "tool_calls"
  end
  if reason == "max_tokens" then
    return "length"
  end
  if reason == "refusal" then
    return "content_filter"
  end
  if reason == "end_turn" or reason == "stop_sequence" then
    return "stop"
  end
  return reason
end

local function call_of(block)
  -- A turn this program sent carries `arguments`; the answer's `tool_use`
  -- block calls the same table `input`.
  return {id = block.id, name = block.name, arguments = arguments_of({arguments = block.input})}
end

function build_request(call, req, inputs)
  return describe(call, req, inputs, false)
end

function build_stream_request(call, req, inputs)
  return describe(call, req, inputs, true)
end

function parse_response(status, headers, body)
  local payload = json.decode(body)
  if type(payload.error) == "table" then
    return {error = payload.error.message or "the request was refused"}
  end
  local text = ""
  local calls = {}
  for _, block in ipairs(payload.content or {}) do
    if block.type == "text" and type(block.text) == "string" then
      text = text .. block.text
    elseif block.type == "tool_use" then
      table.insert(calls, call_of(block))
    end
  end
  if trimmed(text) == "" then
    text = nil
  end
  return {
    text = text,
    usage = tokens(payload),
    tool_calls = calls,
    finish_reason = finish_of(payload.stop_reason),
  }
end

-- The prompt's token count arrives with the opening event and the completion's
-- with the closing one, so the opening's is kept for the event that reports the
-- other half. The runtime lives for the whole stream, which is what makes this
-- a place to keep it.
local stream_input_tokens = nil

function parse_event(event)
  local payload = json.decode(event)
  local kind = payload.type

  if kind == "message_start" then
    local usage = ((payload.message or {}).usage) or {}
    stream_input_tokens = usage.input_tokens
    return {usage = tokens({usage = usage})}
  end

  if kind == "content_block_start" then
    local block = payload.content_block or {}
    if block.type == "tool_use" then
      return {tool_calls = {{
        index = payload.index or 0,
        id = block.id,
        name = block.name,
        arguments_delta = "",
      }}}
    end
    return {}
  end

  if kind == "content_block_delta" then
    local delta = payload.delta or {}
    if delta.type == "text_delta" then
      return {text = delta.text}
    end
    if delta.type == "input_json_delta" then
      return {tool_calls = {{
        index = payload.index or 0,
        arguments_delta = delta.partial_json,
      }}}
    end
    return {}
  end

  if kind == "message_delta" then
    local usage = payload.usage or {}
    return {
      finish_reason = finish_of((payload.delta or {}).stop_reason),
      usage = {
        input_tokens = stream_input_tokens,
        output_tokens = usage.output_tokens,
      },
    }
  end

  if kind == "error" then
    local said = payload.error or {}
    return {failed = said.message or "the stream failed"}
  end

  return {}
end
