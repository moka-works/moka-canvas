-- Alibaba Cloud · Bailian Speech (CosyVoice TTS, non-streaming)
-- Protocol: bailianSpeech  Capability: audio
--
-- API reference:
--   https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
--
-- Workflow:
--   1. POST to the TTS endpoint
--   2. Receive JSON with output.audio.url
--   3. Download the audio from that URL (handled by Rust)

-- Whether the model takes the room's free-form direction as written.
--
-- A name this does not recognise keeps the direction: the v2 and v3 names are
-- the ones heard to refuse it, and everything else the platform serves under
-- this shape is left as it was.
function reads_free_instruction(model)
    model = model or ""
    local reads_none = model:match("^cosyvoice%-v2") ~= nil
    local fixed_pair = model:match("^cosyvoice%-v3") ~= nil
        and model:match("^cosyvoice%-v3%.5") == nil
    return not (reads_none or fixed_pair)
end

function build_request(call, req, inputs)
    local body = {model = call.model}
    body.input = {text = req.prompt}

    -- The room's audio settings, under this service's own names: the pace,
    -- pitch and volume arrive as `rate`, `pitch` and `volume`, the sample
    -- rate as `sampleRate` — the room's name for it — sent on as
    -- `sample_rate`, and the acting direction as `instructions`, which this
    -- engine spells `instruction`. A caller that stated only the generic
    -- `speed` is paced by it as well. The engine takes a pace between 0.5 and
    -- 2, so one outside that is brought to the nearest end rather than sent to
    -- be refused.
    if req.params.voice then body.input.voice = req.params.voice end
    if req.params.format then body.input.format = req.params.format end
    if req.params.sampleRate then body.input.sample_rate = tonumber(req.params.sampleRate) end
    if req.params.volume then body.input.volume = tonumber(req.params.volume) end
    local rate = tonumber(req.params.rate or req.params.speed)
    if rate then
        if rate < 0.5 then rate = 0.5 end
        if rate > 2 then rate = 2 end
        body.input.rate = rate
    end
    if req.params.pitch then body.input.pitch = tonumber(req.params.pitch) end
    -- The room's direction is free text, and the engine families read it
    -- differently: v2 reads none at all, and the v3 pair take only their own
    -- fixed phrasing — a free sentence comes back as engine code 428 rather
    -- than being obeyed. v3.5 and later read it as sent, so a direction a
    -- family cannot take is left unsaid rather than sent to be refused.
    local instruction = req.params.instructions
    if instruction and instruction ~= "" and reads_free_instruction(call.model) then
        body.input.instruction = instruction
    end

    return {
        method = "POST",
        url = call.url,
        headers = {["Content-Type"] = "application/json"},
        body = json.encode(body),
    }
end

function parse_response(status, headers, body)
    if status < 200 or status >= 300 then
        return {error = "HTTP " .. tostring(status) .. ": " .. body}
    end
    local data = json.decode(body)
    local output = data.output or {}
    local audio = output.audio or {}
    local url = audio.url
    if not url or url == "" then
        return {error = "No audio URL in response"}
    end

    -- Infer mime from the URL extension; default to wav
    local mime = "audio/wav"
    if url:match("%.mp3") then mime = "audio/mpeg"
    elseif url:match("%.wav") then mime = "audio/wav"
    elseif url:match("%.opus") then mime = "audio/opus"
    elseif url:match("%.pcm") then mime = "audio/l16" end

    local items = {{url = url, mime = mime}}
    return {text = nil, items = items, usage = nil}
end