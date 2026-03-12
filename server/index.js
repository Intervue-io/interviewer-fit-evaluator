require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ─── Static files — always try to serve dist ───
const distPath = path.join(__dirname, "../dist");
const distExists = fs.existsSync(distPath);
if (distExists) {
  app.use(express.static(distPath));
}

// Multer for file uploads (in-memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file
  fileFilter: (req, file, cb) => {
    const allowed = [".pdf", ".txt", ".docx", ".doc", ".md"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`File type ${ext} not supported`));
  },
});

// ─── Anthropic client ───
let anthropic;
try {
  const AnthropicModule = require("@anthropic-ai/sdk");
  const AnthropicClass = AnthropicModule.default || AnthropicModule;
  anthropic = new AnthropicClass({ apiKey: process.env.ANTHROPIC_API_KEY });
} catch (err) {
  console.error("Failed to initialize Anthropic SDK:", err.message);
}

// ─── System prompt ───
const SYSTEM_PROMPT = `You are an expert interviewer-fit evaluator for Intervue.io, a technical interviewing marketplace. Your job is to analyze whether an interviewer (whose CV/LinkedIn profile is provided) is a good fit to conduct interviews for given Job Description(s).

Intervue Interviewer Profile Taxonomy:
- Software Development: Frontend, Backend, Full Stack
- Mobile Development: iOS, Android, React Native, Flutter
- QA/Testing: Manual QA, SDET, Automation Testing
- Cloud/DevOps: AWS, Azure, GCP, Network & Infrastructure, SRE
- Data Science/Engineering: Data Engineering, Data Science, ML/AI, Analytics
- Cybersecurity: Application Security, Network Security, Cloud Security
- Enterprise Software: SAP, Salesforce, ServiceNow
- Embedded/Digital Hardware: Embedded Systems, VLSI, Firmware, IoT
- Business Functions: Finance, Sales, Customer Success, Product Management, HR

Key rules:
- IGNORE years of experience entirely — do NOT score or evaluate seniority, experience years, or the n+2 rule. The ops team handles experience checks separately.
- Focus ONLY on skills, technical competencies, domain expertise, and tools/technology overlap between the interviewer and JD.
- Evaluate each JD separately against the interviewer profile
- Score each skill/requirement on a 1-5 scale (1=no evidence, 5=strong match)
- Only score technical skills, tools, domain knowledge, and functional competencies — never score experience duration
- Be honest about gaps — do not inflate scores
- Classify the interviewer into Intervue primary and secondary profiles

You MUST respond with ONLY valid JSON (no markdown, no backticks, no preamble). Use this exact structure:
{
  "interviewer": {
    "name": "string",
    "currentRole": "string",
    "totalExperience": "string",
    "coreStrengths": ["string"],
    "primaryProfile": "string",
    "secondaryProfile": "string"
  },
  "evaluations": [
    {
      "jdTitle": "string",
      "company": "string",
      "requiredExperience": "string",
      "scores": [
        { "requirement": "string", "score": 1-5, "assessment": "string" }
      ],
      "overallScore": 1-5,
      "verdict": "STRONG|MODERATE|WEAK|POOR",
      "summary": "string",
      "canInterviewFor": "string"
    }
  ],
  "recommendation": "string",
  "idealInterviewerProfile": "string"
}`;

// ─── Text extraction helpers ───
const mammoth = require("mammoth");

function cleanText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    if (!seen.has(l)) { seen.add(l); out.push(l); }
  }
  const bp = [
    /^(Basic Skills|Basic Education|Vocational\/Technical|Discipline -|Several Disciplines|Single Function|Diverse -)/i,
    /^(Basic -|Applying -|Understanding -|Integrating -|Mastery -)/i,
    /^(Defined -|Routine -|Similar -|Varied -|Broad -|Complex -|Highly Complex|Novel -)/i,
    /^(Basic - Has minimal|Routine\s*-|Convey\/Exchange|Interpret -|Influence -|Negotiation -|Strategic Negotiation)/i,
    /^(Homogeneous -|Moderate -|Significant -|Global -)/i,
    /^(Team\/Unit|Department\/discipline|Local\/Country|Region -|Global - major)/i,
    /^(Personal Delivery|Personal Contribution|Personal Influence|Execution -|Operational Planning|Strategic Planning|Visionary Development)/i,
    /^(Individual Contributor|Managerial|Operational \(direct\)|Staff \(indirect\))/i,
    /^(Immediate|Intermediate|Broad)$/i,
    /^(Level of|Competency Level|Nature of Interaction|Breath of Accountability)/i,
    /^(Revenue Accountability|Operating Budget|TBD)$/i,
    /^(Knowledge & Application|Problem Solving|Interaction|Impact|Accountability|Role \(Select)$/i,
  ];
  return out.filter((l) => !bp.some((p) => p.test(l))).join("\n");
}

async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".docx" || ext === ".doc") {
    const result = await mammoth.extractRawText({ buffer });
    return cleanText(result.value);
  }
  if (ext === ".txt" || ext === ".md") {
    return buffer.toString("utf-8");
  }
  // PDF — return null, will be sent as base64 document
  return null;
}

// ─── API Routes ───

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    sdkLoaded: !!anthropic,
    timestamp: new Date().toISOString(),
  });
});

// Main evaluation endpoint
app.post(
  "/api/evaluate",
  upload.fields([
    { name: "jds", maxCount: 5 },
    { name: "profile", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const jdFiles = req.files?.jds || [];
      const profileFiles = req.files?.profile || [];

      if (jdFiles.length === 0) return res.status(400).json({ error: "No JD files uploaded" });
      if (profileFiles.length === 0) return res.status(400).json({ error: "No profile file uploaded" });

      const profileFile = profileFiles[0];

      // Build content parts for Claude
      const contentParts = [];

      // Process profile
      const profText = await extractText(profileFile.buffer, profileFile.originalname);
      if (profText) {
        contentParts.push({ type: "text", text: `=== INTERVIEWER PROFILE ===\n${profText}` });
      } else {
        const b64 = profileFile.buffer.toString("base64");
        contentParts.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: b64 },
        });
      }

      // Process JDs
      for (let i = 0; i < jdFiles.length; i++) {
        const jd = jdFiles[i];
        const jdText = await extractText(jd.buffer, jd.originalname);
        if (jdText) {
          contentParts.push({ type: "text", text: `=== JOB DESCRIPTION ${i + 1}: ${jd.originalname} ===\n${jdText}` });
        } else {
          const b64 = jd.buffer.toString("base64");
          contentParts.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: b64 },
          });
        }
      }

      contentParts.push({
        type: "text",
        text: `Evaluate the interviewer profile above against all ${jdFiles.length} JD(s). Return ONLY the JSON object as specified. No markdown, no backticks.`,
      });

      // Call Claude API
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: contentParts }],
      });

      const text = response.content.map((c) => c.text || "").join("");
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

      res.json({ success: true, result: parsed });
    } catch (err) {
      console.error("Evaluation error:", err);
      res.status(500).json({
        error: err.message || "Evaluation failed",
        details: err.status ? `API status: ${err.status}` : undefined,
      });
    }
  }
);

// Catch-all for SPA
if (distExists) {
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
} else {
  // Fallback if dist not found — helps debug deployment issues
  app.get("*", (req, res) => {
    res.status(200).json({
      error: "Frontend build not found",
      distPath,
      cwd: process.cwd(),
      dirname: __dirname,
      files: fs.existsSync(path.join(__dirname, "..")) ? fs.readdirSync(path.join(__dirname, "..")) : "parent dir not found",
    });
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Interviewer Fit Evaluator running on port ${PORT}`);
  console.log(`   API Key: ${process.env.ANTHROPIC_API_KEY ? "✓ configured" : "✗ MISSING"}`);
  console.log(`   SDK: ${anthropic ? "✓ loaded" : "✗ failed"}`);
  console.log(`   Mode: ${process.env.NODE_ENV || "development"}`);
  console.log(`   Dist path: ${distPath}`);
  console.log(`   Dist exists: ${distExists}\n`);
});
