-- Clone speech: a request of words read in the voice of a recording that
-- travels beside them.
--
-- The provider learns a voice from a recording rather than from a name, so the
-- reference the caller attached is what the request speaks of: its file name
-- stands in the voice field, which is how the stand-in down the wire can say
-- which recording it was asked to copy. A name is only sent when no recording
-- came with the ask, and the ask itself is refused upstream of here when the
-- model needs one and none was given.
--
-- The answer is bytes rather than a document, so what it is comes from the
-- answer's own type; the host sniffs the bytes and stores them under the type
-- they turn out to be, because a container's name is not always one a file can
-- be kept as.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- The reference recording, wherever the caller put it in the list of inputs.
local function reference_input(inputs)
  for _, input in ipairs(inputs or {}) do
    if input.role == "reference" then
      return input
    end
  end
  return nil
end

function build_request(call, req, inputs)
  local body = {model = call.model, input = req.prompt or ""}
  local reference = reference_input(inputs)
  if reference ~= nil then
    body.voice = "ref:" .. reference.filename
  elseif type(req.params.voice) == "string" and trimmed(req.params.voice) ~= "" then
    body.voice = req.params.voice
  end

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

function parse_response(status, headers, body)
  -- The recording is the answer's own bytes, which the host takes as they
  -- stand; the type it was announced with is a claim the bytes are checked
  -- against rather than trusted over.
  local announced = headers["content-type"]
  local claimed = nil
  if type(announced) == "string" then
    -- Whatever follows the type — a charset, for instance — is not part of it.
    claimed = trimmed(announced:match("^[^;]+") or announced)
    if claimed == "" then
      claimed = nil
    end
  end
  return {items = {{raw = true, mime = claimed}}}
end
