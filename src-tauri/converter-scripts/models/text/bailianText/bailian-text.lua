-- Alibaba Cloud Bailian (Model Studio) text generation.
--
-- Words alone are asked at the text-generation endpoint a configuration names.
-- A question carrying a picture is asked at the multimodal sibling beside it,
-- which is the same service reading a message as parts rather than as one
-- string — and an address that already names the multimodal service is left
-- where it is, since a model that only answers there is reachable without a
-- second setting.
--
-- Which of the two services a model answers at is not something an address
-- says: this platform serves its multimodal models — qwen3.8-flash among them
-- — only at the multimodal service, and answers one asked at the other service
-- with a complaint that the url is wrong. So a question of words alone is
-- asked at the address the configuration names and, when the service refuses
-- it for that reason, the same question is asked at the sibling service rather
-- than the complaint being the answer. A question carrying a picture has no
-- sibling: the text service reads no picture.
--
-- The answer arrives in one document, or in a stream when the service was
-- asked for one. Streaming is asked for in a header here rather than in the
-- body, and each piece is asked for as a piece rather than as the whole answer
-- so far.
--
-- A refusal can arrive as a success, with the explanation in the body beside a
-- code rather than in a status, which reading as an empty answer would blame
-- on the model being quiet.

local WORDS = "text-generation"
local MULTIMODAL = "multimodal-generation"

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- The other service of the same deployment: an address that names either of
-- the two is rewritten to name the one asked for, and any other address is
-- left as it is, a sibling being nothing that can be derived from it.
local function service_url(address, service)
  for _, named in ipairs({WORDS, MULTIMODAL}) do
    local base, names_service = url.drop(address, "/" .. named .. "/generation")
    if names_service then
      return url.append(base, service .. "/generation")
    end
  end
  return address
end

local function is_multimodal(url)
  return url:find("/" .. MULTIMODAL .. "/", 1, true) ~= nil
end

local function pictures_of(inputs)
  local pictures = {}
  for _, input in ipairs(inputs) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      table.insert(pictures, input)
    end
  end
  return pictures
end

-- One message's content as the chosen service reads it: a bare string where it
-- reads one, and a document of parts where it reads that.
local function said(text, parts)
  if parts then
    return {{text = text}}
  end
  return text
end

-- The question itself: the words alone where that is all it is, and beside the
-- pictures otherwise.
local function asked(req, pictures, parts)
  if not parts then
    return req.prompt or ""
  end
  local content = {}
  if req.prompt and trimmed(req.prompt) ~= "" then
    table.insert(content, {text = req.prompt})
  end
  for _, picture in ipairs(pictures) do
    table.insert(content, {image = picture.data_url})
  end
  return content
end

-- One turn of a conversation in this shape. Tool calls travel with their
-- arguments as text, and a tool result is a message of its own named by the
-- call it answers.
local function turn(message, parts)
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
    return {
      role = "tool",
      tool_call_id = message.tool_call_id,
      content = content,
    }
  end
  return {role = message.role, content = said(content, parts)}
end

local function conversation(req, parts)
  local messages = {}
  if req.system and trimmed(req.system) ~= "" then
    table.insert(messages, {role = "system", content = said(req.system, parts)})
  end
  for _, message in ipairs(req.messages or {}) do
    if message.role ~= "system" or #messages == 0 then
      table.insert(messages, turn(message, parts))
    end
  end
  return messages
end

-- What the model may ask to run, under the names this platform reads: a tool
-- is a function beside the parameters, and the choice is a word or a named
-- function.
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

local function choice_of(req)
  local choice = req.tool_choice
  if type(choice) ~= "string" or trimmed(choice) == "" then
    return nil
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

-- The pieces of a streamed call: this service keeps them in the message as
-- written so far, and the host puts the fragments back together.
local function call_deltas(message, delta)
  local list = (message and message.tool_calls) or (delta and delta.tool_calls) or {}
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

local function finish_of(choice)
  return choice.finish_reason or choice.finishReason
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

-- What the service is told about the answer, under the names it uses.
local function parameters(req, streaming)
  -- A message is asked for rather than a bare string, which is also the shape
  -- an answer with a picture's parts in it arrives under.
  local told = {result_format = "message"}
  if streaming then
    -- Without this, every piece repeats the whole answer so far, and a reader
    -- of pieces collects it over and over.
    told.incremental_output = true
  end
  local temperature = number_param(req.params, "temperature")
  if temperature ~= nil then
    told.temperature = temperature
  end
  local tokens = integer_param(req.params, "maxTokens")
  if tokens ~= nil then
    told.max_tokens = tokens
  end
  return told
end

-- Where one question is asked first: the address the configuration names,
-- which reads words alone as one string and a message carrying a picture as
-- parts at the multimodal service.
local function address(call, pictures)
  if #pictures > 0 then
    return service_url(call.url, MULTIMODAL), true
  end
  if is_multimodal(call.url) then
    return call.url, true
  end
  return call.url, false
end

-- The sibling service a question of words alone may be asked at instead: a
-- model that only answers at the multimodal service is asked there, and one
-- that only answers at the text service is asked here. A question carrying a
-- picture has nowhere else to go, so it is not moved.
local function sibling(url, pictures, parts)
  if #pictures > 0 then
    return nil
  end
  local other = service_url(url, parts and WORDS or MULTIMODAL)
  if other == url then
    return nil
  end
  return other
end

-- The question as it is sent to one of the two services: the address, and
-- whether that service reads a message as parts rather than as one string.
local function describe(call, req, pictures, url, parts, streaming)
  local messages = {}
  if req.messages and #req.messages > 0 then
    messages = conversation(req, parts)
  else
    if req.system and trimmed(req.system) ~= "" then
      table.insert(messages, {role = "system", content = said(req.system, parts)})
    end
    table.insert(messages, {role = "user", content = asked(req, pictures, parts)})
  end
  local told = parameters(req, streaming)
  local tools = tools_of(req)
  if #tools > 0 then
    told.tools = tools
    local choice = choice_of(req)
    if choice ~= nil then
      told.tool_choice = choice
    end
  end
  return {
    method = "POST",
    url = url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode({
      model = call.model,
      input = {messages = messages},
      parameters = told,
    }),
  }
end

-- The question as the two doors it may be asked at: the one the configuration
-- points at, and the sibling service beside it. The first door is asked to be
-- read even when refused, because a refusal that names the address is what
-- moves the question to the second one.
local function doors(call, req, inputs, streaming)
  local pictures = pictures_of(inputs)
  local url, parts = address(call, pictures)
  local first = describe(call, req, pictures, url, parts, streaming)
  local other = sibling(url, pictures, parts)
  if other == nil then
    return {request = first}
  end
  first.read_failure = true
  return {
    request = first,
    handler = "parse_response",
    state = {sibling = describe(call, req, pictures, other, not parts, streaming)},
  }
end

-- The complaint in an answer that carried one instead of a generation: this
-- service names it in a `code` beside a `message`, where an answer would carry
-- an `output`.
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

-- The complaint that means "not at this address": this platform serves its
-- multimodal models — qwen3.8-flash among them — only at the multimodal
-- service, and answers one asked at the other service with this.
local function wrong_address(status, payload)
  if status ~= 400 or type(payload) ~= "table" then
    return false
  end
  if tostring(payload.code or "") ~= "InvalidParameter" then
    return false
  end
  return tostring(payload.message or ""):find("url error", 1, true) ~= nil
end

-- A refused answer's body as a document, where it is one: the rider of a
-- refusal is not always this service's json, and a body that does not read is
-- not a complaint this script can act on.
local function complaint_of(body)
  local ok, payload = pcall(json.decode, body)
  if not ok or type(payload) ~= "table" then
    return nil
  end
  return payload
end

local function answered(status)
  return status ~= nil and status >= 200 and status < 300
end

-- The text of the first choice, which this service spells either as one string
-- or as a document of parts.
local function choice_content(payload)
  local choice = payload.output and payload.output.choices and payload.output.choices[1]
  local content = choice and choice.message and choice.message.content
  local text = nil
  if type(content) == "string" then
    text = content
  elseif type(content) == "table" then
    local parts = {}
    for _, part in ipairs(content) do
      if type(part.text) == "string" then
        table.insert(parts, part.text)
      end
    end
    text = table.concat(parts)
  else
    -- `result_format: "text"` is the older default, where the answer is a bare
    -- string rather than a message.
    text = payload.output and payload.output.text
  end
  if text == nil or trimmed(text) == "" then
    return nil
  end
  return text
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
  return doors(call, req, inputs, false)
end

-- A stream is asked for in a header here rather than in the body, which is
-- what the raw HTTP shape of the service reads. The sibling door is a stream
-- too, since it is only ever asked the question the first door refused.
local function asked_in_pieces(request)
  request.headers["X-Dashscope-Sse"] = "enable"
end

function build_stream_request(call, req, inputs)
  local both = doors(call, req, inputs, true)
  asked_in_pieces(both.request)
  if both.state ~= nil and both.state.sibling ~= nil then
    asked_in_pieces(both.state.sibling)
  end
  return both
end

function parse_response(status, headers, body, state)
  if not answered(status) then
    local complaint = complaint_of(body)
    if state ~= nil and state.sibling ~= nil and wrong_address(status, complaint) then
      -- The model answers at the sibling service: ask it there rather than
      -- hand the caller a complaint about the address.
      return {next = {request = state.sibling}}
    end
    -- Not this script's to say: the host reads the status as what it means,
    -- and a rate limit among them stays something a caller may retry.
    return {}
  end
  local payload = json.decode(body)
  local refused = refusal(payload)
  if refused ~= nil then
    return {error = refused}
  end
  local choice = ((payload.output or {}).choices or {})[1] or {}
  local calls = calls_of(choice.message)
  local finish = finish_of(choice)
  if #calls > 0 and finish == nil then
    finish = "tool_calls"
  end
  return {
    text = choice_content(payload),
    usage = tokens(payload),
    tool_calls = calls,
    finish_reason = finish,
  }
end

-- One event in a stream, which carries the piece written since the last one
-- and, where the service reported them, the totals so far. A stream that has
-- opened has no status left to refuse with, so a failure arrives as an event
-- carrying the complaint instead of a piece.
function parse_event(event)
  local payload = json.decode(event)
  local refused = refusal(payload)
  if refused ~= nil then
    return {failed = refused}
  end
  local choice = ((payload.output or {}).choices or {})[1] or {}
  local text = choice_content(payload)
  if text == nil then
    local delta = choice.delta or {}
    if type(delta.content) == "string" and trimmed(delta.content) ~= "" then
      text = delta.content
    end
  end
  local calls = call_deltas(choice.message, choice.delta)
  local finish = finish_of(choice)
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
