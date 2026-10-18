-- Expand a short text into a prompt an image model can draw from.
--
-- The node asks one text model for words and hands them back on its single
-- output port. It is deliberately small: it shows what a definition with one
-- input, one output and one slot looks like, and it is the shape most
-- prompt-shaping nodes will take.

local STYLE_NOTES = {
  photographic = "photographic, true-to-life materials, natural light",
  illustration = "illustration, clean shapes, deliberate line work",
  cinematic = "cinematic still, film framing, dramatic lighting",
  watercolor = "watercolor, soft washes, visible paper grain",
  ["3d"] = "3D render, physically based materials, studio lighting",
  anime = "anime key visual, expressive staging, crisp colour",
}

local DETAIL_NOTES = {
  concise = "Keep it to one or two sentences: subject, setting, light.",
  balanced = "Write one short paragraph: subject, setting, light, composition.",
  rich = "Write a detailed paragraph covering subject, setting, light, colour, composition and mood. Include concrete visual nouns, not abstract praise.",
}

local function first(list)
  return list and list[1] or nil
end

function validate(ctx)
  local input = first(ctx.inputs.text)
  if not input or input.type ~= "text" then
    ctx.fail("Connect a text node to \"Text\".", { port = "text" })
  end
  if input.text == nil or input.text:match("^%s*$") then
    ctx.fail("The connected text is empty.", { port = "text" })
  end
end

function run(ctx)
  local input = first(ctx.inputs.text)
  local style = ctx.params.style or "photographic"
  local detail = ctx.params.detail or "rich"
  local language = ctx.params.language or "en"
  local direction = ctx.params.instructions or ""

  local language_note = language == "zh"
    and "Write the prompt in Simplified Chinese."
    or "Write the prompt in English."

  local instruction_note = ""
  if direction ~= "" then
    instruction_note = "\nAdditional direction from the user, which must be respected:\n" .. direction
  end

  ctx.progress(0.1, "Expanding")
  local asked = ctx.models.writer:generate{
    system = "You rewrite short ideas into vivid, concrete image-generation prompts. " ..
      "Return only the prompt itself, with no heading, commentary or quotation marks.",
    prompt = string.format(
      "%s\n\nStyle: %s.\n%s\n\nIdea:\n%s%s",
      language_note,
      STYLE_NOTES[style] or style,
      DETAIL_NOTES[detail] or DETAIL_NOTES.rich,
      input.text,
      instruction_note
    ),
    params = { temperature = 0.8, maxTokens = 900 },
  }

  local prompt = asked.text
  if prompt == nil or prompt:match("^%s*$") then
    ctx.fail("The writer returned no prompt.", { slot = "writer" })
  end
  prompt = prompt:match("^%s*(.-)%s*$")

  ctx.progress(0.9, "Done")
  ctx.log("info", string.format("expanded %d characters in %s style", #input.text, style))
  return {
    outputs = {
      prompt = { { type = "text", text = prompt } },
    },
    summary = "An image prompt in " .. style .. " style.",
  }
end
