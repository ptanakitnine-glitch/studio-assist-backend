// Studio Assist backend
// This is the small server the Roblox Studio plugin talks to.
// It receives a question, asks Claude for a Roblox/Luau answer, and returns JSON.

const express = require("express");
const app = express();
app.use(express.json());

// CORS isn't needed for Roblox's HttpService, but doesn't hurt if you also
// want to call this from a browser artifact later.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SYSTEM_PROMPT = `You are an expert Roblox Studio and Luau (Roblox Lua) tutor.
The user asks questions about Roblox Studio (Explorer, Properties, Workspace,
StarterPlayer, Toolbox, plugins, DataStores, publishing, etc.) and Luau scripting.

Respond ONLY with valid JSON, no markdown fences, no preamble, in exactly this shape:
{
  "code": "a complete, working Luau code example relevant to the question, with comments",
  "explanation": "a clear, beginner-friendly explanation of how the code works and/or how to do this in Roblox Studio's interface, written as 2-5 short paragraphs or steps",
  "studioNotes": "one short practical tip specific to using Roblox Studio for this (e.g. where to place the script, or a common pitfall)"
}`;

app.post("/ask", async (req, res) => {
  const question = (req.body && req.body.question) || "";
  if (!question.trim()) {
    return res.status(400).json({ error: "Missing 'question' in request body." });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: question }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Anthropic API error:", data);
      return res.status(502).json({ error: "Upstream API error." });
    }

    const rawText = (data.content || [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");

    const cleaned = rawText.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("Failed to parse model output as JSON:", rawText);
      return res.status(502).json({ error: "Model did not return valid JSON." });
    }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

app.get("/", (req, res) => {
  res.send("Studio Assist backend is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Studio Assist backend listening on port ${PORT}`));
