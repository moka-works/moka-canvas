-- Alibaba Cloud · Bailian speech recognition (a recording, as an async job)
-- Protocol: bailianAsr  Capability: asr
--
-- API reference:
--   https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-http-api
--   https://help.aliyun.com/zh/model-studio/get-temporary-file-url
--
-- Workflow. The endpoint takes a URL rather than a file, so a recording that
-- lives on somebody's machine is put somewhere the provider can fetch it from
-- first. Five calls, chained by returning the next one (see the converter
-- protocol):
--
--   1. GET  {api}/uploads?action=getPolicy&model={model}  where to put the audio
--   2. POST {upload_host}                                 the audio, multipart
--   3. POST {configured endpoint}                         submit, file_urls = oss://…
--   4. GET  {api}/tasks/{task_id}                         poll until done
--   5. GET  {transcription_url}                           the transcript itself
--
-- The answer is read as timed cues: one per sentence, times measured from the
-- beginning of the audio that was sent. The host writes them as the subtitle
-- document; where that audio sits on a timeline is the caller's business, not
-- this script's.

-- How long one speaker's cue may run before the next sentence starts a new
-- one, and how much of it may say. A recognizer's sentence is often a clause;
-- a viewer reads by the line, and two lines are what fits on one.
local CUE_MAX_MS = 12000
local CUE_MAX_CHARS = 48

-- Where the provider's own API lives, derived from the configured endpoint:
--   https://{ws}.{region}.maas.aliyuncs.com/api/v1/services/audio/asr/transcription
--   -> https://{ws}.{region}.maas.aliyuncs.com/api/v1
function api_base(address)
    local base, under_services = url.before(address, "/services/")
    if under_services then
        return base
    end
    return url.append(url.origin(address), "api/v1")
end

-- The parameters the recognition is asked with. Absent ones are left out
-- rather than sent empty: the API fills a silence of its own with a default,
-- and "" is not a language.
function recognition_parameters(req)
    local asked = req.params or {}
    local params = {}
    if asked.channelId then params.channel_id = numbers(asked.channelId) end
    if asked.language and asked.language ~= "" then
        params.language_hints = {asked.language}
    end
    if asked.disfluency ~= nil then
        params.disfluency_removal_enabled = asked.disfluency and true or false
    end
    local speakers = tonumber(asked.speakerCount) or 0
    -- A count is only a hint — the model judges the number itself — so asking
    -- for labels is enough to ask for diarization, and the count is passed on
    -- only when the caller named one.
    if speakers > 0 or (asked.speakerLabel and asked.speakerLabel ~= "") then
        params.diarization_enabled = true
        if speakers > 0 then params.speaker_count = speakers end
    end
    return params
end

-- "0" or "0,1" as the list of channel numbers the API wants.
function numbers(value)
    local list = {}
    for part in string.gmatch(tostring(value), "[^,]+") do
        local number = tonumber(part)
        if number then table.insert(list, number) end
    end
    if #list == 0 then table.insert(list, 0) end
    return list
end

-- The first call: ask where the audio may be put. Nothing is uploaded to a
-- host the provider has not named, and the ask is also where this script
-- learns what the caller asked for, which it carries from here on.
function build_task_request(call, req, inputs)
    local input = inputs[1]
    if not input then
        return {error = "no recording was sent to be recognized"}
    end
    local policy = url.set_query(url.append(api_base(call.url), "uploads"), "action", "getPolicy")
    policy = url.set_query(policy, "model", call.model)
    return {
        state = {
            url = call.url,
            model = call.model,
            filename = input.filename or "audio.wav",
            parameters = recognition_parameters(req),
            -- Handed to the answer so a cue can say who is speaking. The
            -- words around {id} belong to whoever is reading, which is why
            -- they arrive as a template rather than as text decided here.
            speakerLabel = req.params.speakerLabel,
        },
        request = {
            method = "GET",
            url = policy,
            headers = {},
        },
        handler = "parse_policy",
    }
end

-- The second call: put the audio where the policy says. The credential for
-- this one is inside the policy rather than in the headers, which is what
-- makes it safe for the host to send it to a host of the provider's choosing.
function parse_policy(status, headers, body, state)
    if status < 200 or status >= 300 then
        return {error = "the upload policy was refused (HTTP " .. tostring(status) .. "): " .. body}
    end
    local policy = (json.decode(body) or {}).data
    if not policy or not policy.upload_host then
        return {error = "the upload policy came back without a host: " .. body}
    end
    local key = policy.upload_dir .. "/" .. state.filename
    state.key = key
    return {
        state = state,
        next = {
            request = {
                method = "POST",
                url = policy.upload_host,
                headers = {},
                body = {
                    multipart = {
                        fields = {
                            OSSAccessKeyId = policy.oss_access_key_id,
                            policy = policy.policy,
                            Signature = policy.signature,
                            key = key,
                            ["x-oss-object-acl"] = policy.x_oss_object_acl,
                            ["x-oss-forbid-overwrite"] = policy.x_oss_forbid_overwrite,
                            success_action_status = 200,
                        },
                        file = {part = "file", input = 1},
                    },
                },
            },
            handler = "parse_upload",
        },
    }
end

-- The third call: submit the job, now that the recording has an address.
function parse_upload(status, headers, body, state)
    if status < 200 or status >= 300 then
        return {error = "the recording could not be uploaded (HTTP " .. tostring(status) .. "): " .. body}
    end
    return {
        state = state,
        next = {
            request = {
                method = "POST",
                url = state.url,
                headers = {
                    ["Content-Type"] = "application/json",
                    ["X-DashScope-Async"] = "enable",
                    -- The file is ours to hand over rather than a link anybody
                    -- could follow, so the provider is told to look in its own
                    -- storage for it.
                    ["X-DashScope-OssResourceResolve"] = "enable",
                },
                body = json.encode({
                    model = state.model,
                    input = {file_urls = {"oss://" .. state.key}},
                    parameters = state.parameters,
                }),
            },
            handler = "parse_task_response",
        },
    }
end

function parse_task_response(status, headers, body)
    if status < 200 or status >= 300 then
        return {error = "HTTP " .. tostring(status) .. ": " .. body}
    end
    local output = (json.decode(body) or {}).output or {}
    local reference = output.task_id
    if not reference or reference == "" then
        return {error = "No task_id in response: " .. body}
    end
    -- A short recording is read in seconds; asking every three is often enough
    -- to catch it and seldom enough not to hammer.
    return {reference = reference, poll_interval_ms = 3000}
end

function build_poll_request(call, task)
    return {
        method = "GET",
        url = url.append(url.append(api_base(call.url), "tasks"), task.reference),
        headers = {},
    }
end

function parse_poll_response(status, headers, body)
    if status < 200 or status >= 300 then
        if status == 404 or status == 410 then
            return {status = "expired", error = "Task not found (expired)"}
        end
        return {error = "HTTP " .. tostring(status) .. ": " .. body}
    end
    local output = (json.decode(body) or {}).output or {}
    local task_status = output.task_status or "UNKNOWN"

    if task_status == "SUCCEEDED" then
        local url = transcript_url(output)
        if not url then
            return {error = "the job finished without a transcript"}
        end
        -- The transcript is a document of its own, at an address only this
        -- answer knows. One more call, and one more reader.
        return {
            next = {
                request = {method = "GET", url = url, headers = {}},
                handler = "parse_transcription",
            },
        }
    elseif task_status == "FAILED" then
        return {status = "failed", error = output.message or output.code or "Job failed"}
    elseif task_status == "CANCELED" then
        return {status = "failed", error = "Job cancelled"}
    elseif task_status == "UNKNOWN" then
        return {status = "expired", error = "Task unknown (24h expiry)"}
    end
    return {status = "pending", poll_interval_ms = 3000}
end

-- Where the document with the words in it is. A job can carry more than one
-- file — one per channel — and they are read together rather than one of them
-- being picked.
function transcript_url(output)
    for _, result in ipairs(output.results or {}) do
        if result.transcription_url and result.transcription_url ~= "" then
            return result.transcription_url
        end
    end
    return nil
end

-- The last call: the document itself, read into timed cues.
function parse_transcription(status, headers, body, state)
    if status < 200 or status >= 300 then
        return {error = "the transcript could not be read (HTTP " .. tostring(status) .. ")"}
    end
    local document = json.decode(body) or {}
    local label = state and state.speakerLabel or nil
    local cues = transcript_cues(document, label)
    if #cues == 0 then
        return {error = "no speech was found in the recording"}
    end
    return {status = "succeeded", result = {cues = cues}}
end

-- The sentences, as cues.
--
-- Without speaker labels this is one cue per sentence. With them, consecutive
-- sentences from one speaker are gathered into a cue — a turn rather than a
-- clause — while the cue stays short enough to read.
function transcript_cues(document, label)
    local cues = {}
    local held = nil

    local function flush()
        if not held then return end
        table.insert(cues, {start_ms = held.start_ms, end_ms = held.end_ms, text = held.text})
        held = nil
    end

    for _, transcript in ipairs(document.transcripts or {}) do
        for _, sentence in ipairs(transcript.sentences or {}) do
            local words = clean(sentence.text)
            if words ~= "" then
                local speaker = sentence.speaker_id
                local prefix = ""
                if label and speaker ~= nil then
                    prefix = speaker_text(label, speaker)
                end
                local start_ms = sentence.begin_time or 0
                local end_ms = sentence.end_time or start_ms
                local grouped = label and speaker ~= nil
                -- The label is already part of what is held, so only the words
                -- joining it are counted.
                local same = grouped
                    and held
                    and held.speaker == speaker
                    and (end_ms - held.start_ms) <= CUE_MAX_MS
                    and (chars(held.text) + chars(words) + 1) <= CUE_MAX_CHARS
                if same then
                    held.end_ms = end_ms
                    held.text = held.text .. " " .. words
                else
                    flush()
                    held = {
                        speaker = speaker,
                        start_ms = start_ms,
                        end_ms = end_ms,
                        text = prefix .. words,
                    }
                end
            end
        end
    end
    flush()
    return cues
end

-- "说话人{id}：" with the number filled in. The provider counts speakers from
-- zero; a viewer counts from one. The substitution is a function rather than a
-- string so that a template with a % in it is replaced rather than read as a
-- capture.
function speaker_text(label, speaker)
    local text = string.gsub(label, "{id}", function()
        return tostring(speaker + 1)
    end)
    return text
end

-- A sentence's words on one line, whatever the recognizer spaced them with.
function clean(text)
    if type(text) ~= "string" then return "" end
    local collapsed = string.gsub(text, "%s+", " ")
    return string.gsub(collapsed, "^%s*(.-)%s*$", "%1")
end

-- How many characters a line is. A subtitle is read by the character, so
-- counting bytes would make a Chinese cue three times as long as an English
-- one of the same length.
function chars(text)
    return utf8.len(text) or #text
end
