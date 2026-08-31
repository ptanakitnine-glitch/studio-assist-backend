// Studio Assist backend
// This is the small server the Roblox Studio plugin (and the web tool) talk to.
// It receives a conversation (the new question + any prior turns), asks Claude
// for a Roblox/Luau answer, has Claude review its own code for bugs and
// completeness (fixing it if needed, up to a couple passes), and returns
// structured JSON including where to auto-place the script in Studio.

const express = require("express");
const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_REVIEW_PASSES = 2;

const VALID_SCRIPT_TYPES = ["Script", "LocalScript", "ModuleScript"];
const VALID_PARENTS = [
  "ServerScriptService",
  "StarterPlayerScripts",
  "StarterCharacterScripts",
  "StarterGui",
  "ReplicatedStorage",
  "ReplicatedFirst",
  "ServerStorage",
  "Workspace",
  "StarterPack",
  "Lighting",
];

const GENERATE_SYSTEM_PROMPT = `You are Studio Assist, a friendly and genuinely knowledgeable Roblox Studio and Luau (Roblox Lua) helper. Talk like a sharp, encouraging friend who's really good at this — not like a manual. Use "you," contractions, and a natural tone. It's fine to have a little personality (a quick "nice, that's a fun one" is welcome), but stay focused and don't ramble or over-praise.

The user asks about Roblox Studio (Explorer, Properties, Workspace, StarterPlayer, Toolbox, plugins, DataStores, publishing, etc.) and Luau scripting. This is a multi-turn conversation — later questions may refer back to earlier code you gave ("add a cooldown to that", "now make it also give points"). Use the conversation history to keep edits consistent with what you already wrote, unless the user asks for something new.

Write real, complete, working code — no "..." placeholders, no "add your logic here" stubs, no leaving out error handling that a working script needs. If something is genuinely ambiguous, make a sensible choice and mention the assumption briefly in the explanation rather than leaving a gap in the code.

Respond ONLY with valid JSON, no markdown fences, no preamble, in exactly this shape:
{
  "code": "a complete, working Luau code example relevant to the question, with comments",
  "explanation": "a natural, conversational explanation of how the code works and/or how to do this in Roblox Studio's interface — written like you're talking to the user, 2-5 short paragraphs or steps",
  "studioNotes": "one short practical tip specific to using Roblox Studio for this",
  "scriptType": "one of: Script, LocalScript, ModuleScript — pick based on whether this runs on the server, on the client, or is a reusable module",
  "suggestedParent": "one of: ServerScriptService, StarterPlayerScripts, StarterCharacterScripts, StarterGui, ReplicatedStorage, ReplicatedFirst, ServerStorage, Workspace, StarterPack, Lighting",
  "scriptName": "a short PascalCase or CamelCase name for the script, no spaces, no file extension"
}
If the question is purely conceptual and no code is the best answer, still include a short minimal illustrative snippet and pick sensible values for the other fields.`;

const REVIEW_SYSTEM_PROMPT = `You are a meticulous senior Roblox/Luau code reviewer. You will be given a user's question and a piece of Luau code someone wrote to answer it. Carefully check the code for:
- syntax errors or anything that wouldn't actually run in Roblox Studio
- wrong or outdated Roblox API usage (services, events, methods, properties)
- logic bugs, missing edge cases, race conditions, or memory leaks (e.g. unconnected events, missing debounce)
- incompleteness: placeholders, TODOs, or missing pieces needed for the code to actually do what was asked
- whether it's placed correctly as a Script vs LocalScript vs ModuleScript for what it does (client-only APIs in a Script, or server-only APIs in a LocalScript, are bugs)

Respond ONLY with valid JSON, no markdown fences, no preamble, in exactly this shape:
{
  "isComplete": true or false,
  "issuesFound": "a short plain-English list of what was wrong, or empty string if isComplete is true",
  "fixedCode": "the corrected, complete code — identical to the input if isComplete is true"
}
Be genuinely strict — only mark isComplete true if you'd be comfortable shipping this code as-is.`;

function sanitize(parsed) {
  if (!VALID_SCRIPT_TYPES.includes(parsed.scriptType)) parsed.scriptType = "Script";
  if (!VALID_PARENTS.includes(parsed.suggestedParent)) {
    parsed.suggestedParent =
      parsed.scriptType === "LocalScript" ? "StarterPlayerScripts" : "ServerScriptService";
  }
  if (!parsed.scriptName || typeof parsed.scriptName !== "string") {
    parsed.scriptName = "StudioAssistScript";
  }
  parsed.scriptName = parsed.scriptName.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40) || "StudioAssistScript";
  return parsed;
}

async function callClaude(system, messages, maxTokens, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: maxTokens,
          system: system,
          messages: messages,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        const errType = data && data.error && data.error.type;
        // Overloaded / rate-limited errors are worth one retry; auth/bad-request errors are not.
        const isTransient = errType === "overloaded_error" || errType === "rate_limit_error" || response.status >= 500;
        console.error("Anthropic API error:", data);
        if (isTransient && attempt < retries) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        throw new Error((data && data.error && data.error.message) || "Upstream API error.");
      }

      const rawText = (data.content || [])
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      const cleaned = rawText.replace(/```json|```/g, "").trim();

      try {
        return JSON.parse(cleaned);
      } catch (parseErr) {
        console.error("Failed to parse model output as JSON. Raw text was:\n", rawText);
        // Truncated output (hit max_tokens mid-JSON) is the most common cause — worth one retry.
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        throw new Error("Model response was truncated or malformed (try a shorter/simpler request).");
      }
    } catch (err) {
      if (attempt >= retries) throw err;
    }
  }
}

const FIX_SYSTEM_PROMPT = `You are Studio Assist, helping fix an existing Roblox Luau script. You'll be given the current source of a script (and maybe some context about it). Your job is to find and fix real problems — syntax errors, wrong/outdated Roblox API usage, logic bugs, missing debounces, unconnected events, incomplete pieces, wrong script type for what it does — while preserving the original author's structure, naming, and intent as much as possible. Don't rewrite it from scratch or change its style/approach unless it's actually broken.

Talk like a sharp, encouraging friend, not a manual — natural tone, contractions, no over-praise.

Respond ONLY with valid JSON, no markdown fences, no preamble, in exactly this shape:
{
  "code": "the fixed, complete script",
  "explanation": "a natural, conversational rundown of what was wrong and what you changed — if nothing was wrong, say so plainly",
  "issuesFound": "a short plain-English list of the specific bugs/issues found, or empty string if none"
}`;

app.post("/fix", async (req, res) => {
  const code = (req.body && req.body.code) || "";
  const context = (req.body && req.body.context) || "";
  if (!code.trim()) {
    return res.status(400).json({ error: "Missing 'code' in request body." });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
  }

  try {
    const userMsg = context
      ? `Context: ${context}\n\nScript to fix:\n${code}`
      : `Script to fix:\n${code}`;
    const result = await callClaude(FIX_SYSTEM_PROMPT, [{ role: "user", content: userMsg }], 2400);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err && err.message) || "Something went wrong." });
  }
});

const MAX_BUILD_PARTS = 120;

const BUILD_SYSTEM_PROMPT = `You are Studio Assist, helping build a simple structure in Roblox Studio out of basic parts. You do NOT write scripts for this — you output a literal list of parts to place, using plain Roblox primitives (Part, WedgePart, CornerWedgePart, SpherePart, CylinderPart).

Keep it simple and buildable with basic shapes — houses, platforms, towers, ramps, simple furniture, basic terrain features. Use a coordinate system where Y is up. Keep the whole structure within roughly a 100x100x100 stud area centered near the given origin. Use at most ${MAX_BUILD_PARTS} parts — if that's not enough for a good version of what was asked, build a smaller/simpler but still recognizable version rather than exceeding it.

Respond ONLY with valid JSON, no markdown fences, no preamble, in exactly this shape:
{
  "modelName": "short PascalCase name for the whole build, no spaces",
  "explanation": "a natural, conversational sentence or two about what you built",
  "parts": [
    {
      "name": "short descriptive name, no spaces",
      "shape": "one of: Part, WedgePart, CornerWedgePart, SpherePart, CylinderPart",
      "size": [x, y, z],
      "position": [x, y, z],
      "color": [r, g, b],
      "material": "one of the real Roblox Material enum names, e.g. Wood, Brick, Concrete, Metal, Grass, Plastic, Glass",
      "transparency": 0,
      "anchored": true
    }
  ]
}
Position is the absolute world position of each part's center. Color values are 0-255. Keep colors and materials sensible for what's being built.`;

app.post("/build", async (req, res) => {
  const prompt = (req.body && req.body.prompt) || "";
  const origin = (req.body && req.body.origin) || [0, 5, 0];
  if (!prompt.trim()) {
    return res.status(400).json({ error: "Missing 'prompt' in request body." });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
  }

  try {
    const userMsg = `Build request: ${prompt}\n\nBuild it centered near world position [${origin.join(", ")}].`;
    const result = await callClaude(BUILD_SYSTEM_PROMPT, [{ role: "user", content: userMsg }], 4000);

    if (!Array.isArray(result.parts)) {
      return res.status(502).json({ error: "Model did not return a valid parts list." });
    }
    // Hard cap enforced server-side too, regardless of what the model returned
    result.parts = result.parts.slice(0, MAX_BUILD_PARTS);
    if (!result.modelName || typeof result.modelName !== "string") {
      result.modelName = "StudioAssistBuild";
    }
    result.modelName = result.modelName.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40) || "StudioAssistBuild";

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err && err.message) || "Something went wrong." });
  }
});

app.post("/ask", async (req, res) => {
  // Accepts either:
  //   { question: "..." }                         -> single turn
  //   { messages: [{role, content}, ...] }         -> full conversation, last item is newest user question
  let messages = req.body && req.body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    const question = (req.body && req.body.question) || "";
    if (!question.trim()) {
      return res.status(400).json({ error: "Missing 'question' or 'messages' in request body." });
    }
    messages = [{ role: "user", content: question }];
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
  }

  const latestQuestion = messages[messages.length - 1].content;

  try {
    // Step 1: generate the initial answer
    let parsed;
    try {
      parsed = sanitize(await callClaude(GENERATE_SYSTEM_PROMPT, messages, 3000));
    } catch (e) {
      console.error("Generation step failed:", e);
      return res.status(502).json({ error: e.message || "Model did not return valid JSON." });
    }

    // Step 2: self-review and fix, up to MAX_REVIEW_PASSES times
    const fixesApplied = [];
    for (let pass = 0; pass < MAX_REVIEW_PASSES; pass++) {
      if (!parsed.code || !parsed.code.trim()) break;
      let review;
      try {
        review = await callClaude(
          REVIEW_SYSTEM_PROMPT,
          [
            {
              role: "user",
              content: `Question: ${latestQuestion}\n\nCode to review:\n${parsed.code}`,
            },
          ],
          3000
        );
      } catch (e) {
        console.error("Review step failed, keeping current code:", e);
        break;
      }

      if (review.isComplete) break;

      if (review.fixedCode && review.fixedCode.trim()) {
        parsed.code = review.fixedCode;
        fixesApplied.push(review.issuesFound || "made corrections");
      } else {
        break;
      }
    }

    parsed.reviewSummary =
      fixesApplied.length > 0
        ? "Caught and fixed on review: " + fixesApplied.join("; ")
        : "Checked it over — looks solid.";

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err && err.message) || "Something went wrong." });
  }
});

app.get("/", (req, res) => {
  res.send("Studio Assist backend is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Studio Assist backend listening on port ${PORT}`));
