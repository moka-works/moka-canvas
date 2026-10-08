-- Alibaba Cloud · Bailian Speech (CosyVoice TTS, voice cloning)
-- Protocol: bailianCloneSpeech  Capability: speech
--
-- API reference:
--   https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
--
-- The same shape as `bailianSpeech`, with one addition: an ask that carries a
-- reference recording — and names no voice — is answered in the voice that
-- recording speaks in. The engine takes no recording with the synthesis
-- itself (`input.ref_audio` is refused), so the voice is built first, and the
-- synthesis that follows names the id it was given.
--
-- Workflow:
--   1. POST the recording to the customization endpoint as a create_voice
--      ask, the audio travelling inside the document as a data URL — the
--      service reads one directly, where an `oss://` reference is refused and
--      a policy-uploaded object comes back 403 — so nothing needs hosting
--      anywhere
--   2. POST the synthesis request naming the voice that came back
--   3. Receive JSON with output.audio.url
--   4. Download the audio from that URL (handled by Rust)
--
-- The customization endpoint is derived from the configured one by spelling
-- `SpeechSynthesizer` as `customization`: a model configuration carries a
-- single URL, and a deployment serves both under
-- /api/v1/services/audio/tts/.
--
-- A voice built from a recording stays on the account — the service holds a
-- quota of them — so the id a recording earned is remembered under a key the
-- recording's digest built, and the next ask carrying the same file speaks
-- with it straight rather than building the voice again. The memo is the
-- process's memory: a restart, or another machine on the same account, builds
-- each voice once and reuses it from then on.

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

-- The recording the ask carried, if any: the input whose role says it is one.
function reference_input(inputs)
    for _, input in ipairs(inputs or {}) do
        if input.role == "reference" then
            return input
        end
    end
    return nil
end

-- The synthesis request: the room's audio settings under this service's own
-- names — the pace, pitch and volume arrive as `rate`, `pitch` and `volume`,
-- the sample rate as `sampleRate`, sent on as `sample_rate`, and the acting
-- direction as `instructions`, which this engine spells `instruction`. A
-- caller that stated only the generic `speed` is paced by it as well. The
-- engine takes a pace between 0.5 and 2, so one outside that is brought to
-- the nearest end rather than sent to be refused.
function synthesis_request(call, req, voice)
    local body = {model = call.model}
    body.input = {text = req.prompt}
    if voice then body.input.voice = voice end
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

-- The enrollment request: the recording as a data URL, and what the voice
-- being built is for — an id is forged per `target_model`, and a voice speaks
-- only on the family it was built for.
function enrollment_request(call, reference)
    return {
        method = "POST",
        url = (call.url:gsub("SpeechSynthesizer$", "customization")),
        headers = {["Content-Type"] = "application/json"},
        body = json.encode({
            model = "voice-enrollment",
            input = {
                action = "create_voice",
                target_model = call.model,
                prefix = "moka",
                url = reference.data_url,
            },
        }),
    }
end

-- The first exchange. A named voice speaks as named — a recording riding
-- along changes nothing. Otherwise the recording decides: a voice already
-- built from this file is spoken with straight, and one not yet built is
-- asked for first. The memo key holds the address and the model as well as
-- the digest, so a voice is remembered per deployment and per family, which
-- is what a voice id means.
function build_request(call, req, inputs)
    local voice = req.params.voice
    if type(voice) ~= "string" or voice:match("^%s*$") then voice = nil end
    if voice then
        return {request = synthesis_request(call, req, voice), handler = "parse_speech"}
    end

    local reference = reference_input(inputs)
    if reference then
        local key = call.url .. ":" .. call.model .. ":" .. reference.sha256
        local remembered = memo_get(key)
        if remembered then
            return {request = synthesis_request(call, req, remembered), handler = "parse_speech"}
        end
        return {
            request = enrollment_request(call, reference),
            handler = "after_enroll",
            state = {key = key, call = call, req = req},
        }
    end
    return {
        error = "the ask names no voice and carries no recording to copy one from",
    }
end

-- The voice a recording earned, remembered under the key the recording's
-- digest built so the next line in the same voice skips this call.
function after_enroll(status, headers, body, state)
    if status < 200 or status >= 300 then
        return {error = "HTTP " .. tostring(status) .. ": " .. body}
    end
    local output = (json.decode(body) or {}).output or {}
    local voice = output.voice_id
    if not voice or voice == "" then
        return {error = "No voice id in enrollment response: " .. body}
    end
    memo_set(state.key, voice)
    return {
        next = {
            request = synthesis_request(state.call, state.req, voice),
            handler = "parse_speech",
            state = state,
        },
    }
end

-- The answer to the synthesis, read the way `bailianSpeech` reads one: a link
-- whose extension names what the audio is.
function parse_speech(status, headers, body)
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
