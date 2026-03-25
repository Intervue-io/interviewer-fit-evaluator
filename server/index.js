import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";

import {
  JD_PARSER_PROMPT,
  LINKEDIN_PROFILE_PARSER_PROMPT,
  LINKEDIN_SKILL_EXTRACTION_PROMPT,
  MATCHING_PROMPT,
} from "./prompts.js";

import {
  calculateOverallScore,
  getVerdict,
  PROFILE_CLUSTER,
} from "./scoring.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const anthropic = new Anthropic();

// ===========================
// Claude API helper
// ===========================
async function callClaude(systemPrompt, userContent, maxTokens = 16000) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// ===========================
// Claude with PDF (vision)
// ===========================
async function callClaudeWithPDF(systemPrompt, pdfBase64, userText, maxTokens = 16000) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    temperature: 0,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfBase64,
            },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// ===========================
// Safe JSON parse
// ===========================
function safeJsonParse(text, fallback = null) {
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    return JSON.parse(cleaned.trim());
  } catch (e) {
    console.error("JSON parse error:", e.message);
    console.error("Raw text (first 500 chars):", text?.substring(0, 500));
    return fallback;
  }
}

// ===========================
// Extract text/base64 from uploaded file
// ===========================
async function extractContent(file) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === ".txt") {
    return { type: "text", content: file.buffer.toString("utf-8") };
  }

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return { type: "text", content: result.value };
  }

  if (ext === ".pdf") {
    return { type: "pdf", base64: file.buffer.toString("base64") };
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

// ===========================
// CALL 1: JD Parsing
// ===========================
async function parseJD(jdContent) {
  const jdText = jdContent.type === "text"
    ? jdContent.content
    : "Extract skills from this job description.";

  let raw;
  if (jdContent.type === "pdf") {
    raw = await callClaudeWithPDF(
      JD_PARSER_PROMPT,
      jdContent.base64,
      "Parse this Job Description and extract must-have and good-to-have skills."
    );
  } else {
    raw = await callClaude(JD_PARSER_PROMPT, `Job Description:\n${jdText}`);
  }

  const parsed = safeJsonParse(raw, { must_have: [], good_to_have: [] });

  // Build JD skills list with importance scores
  const jdSkills = [];
  for (const item of parsed.must_have || []) {
    jdSkills.push({
      JDskill: item.skill,
      score: 9,
      reason: item.reason,
      source_line: item.reason,
      category: "must_have",
    });
  }
  for (const item of parsed.good_to_have || []) {
    jdSkills.push({
      JDskill: item.skill,
      score: 5,
      reason: item.reason,
      source_line: item.reason,
      category: "good_to_have",
    });
  }

  return { parsed, jdSkills, jdText };
}

// ===========================
// Infer JD profile from skills
// ===========================
function inferJDProfile(jdSkills) {
  const skillText = jdSkills.map((s) => s.JDskill).join(", ").toLowerCase();

  const patterns = [
    { keywords: ["react", "angular", "vue", "css", "html", "frontend", "ui", "ux", "next.js", "tailwind"], profile: "Frontend" },
    { keywords: ["node", "express", "django", "flask", "spring", "api", "backend", "microservice", "java", "python backend", "rest api"], profile: "Backend" },
    { keywords: ["fullstack", "full-stack", "full stack", "mern", "mean"], profile: "Full Stack" },
    { keywords: ["ios", "swift", "objective-c", "xcode", "swiftui"], profile: "IOS" },
    { keywords: ["android", "kotlin"], profile: "Android" },
    { keywords: ["flutter", "dart"], profile: "Flutter" },
    { keywords: ["react native"], profile: "React Native" },
    { keywords: ["devops", "ci/cd", "jenkins", "terraform", "ansible", "kubernetes", "docker", "helm", "argocd", "gitops"], profile: "DevOps" },
    { keywords: ["cloud", "aws", "azure", "gcp", "cloud engineer", "ec2", "s3", "lambda", "cloudformation"], profile: "Cloud Engineering" },
    { keywords: ["devsecops", "security scanning", "container security"], profile: "DevSecOps" },
    { keywords: ["data science", "machine learning", "deep learning", "nlp", "computer vision", "pytorch", "tensorflow"], profile: "Data Science" },
    { keywords: ["data engineer", "etl", "data pipeline", "spark", "airflow", "databricks", "data lake"], profile: "Data Engineering" },
    { keywords: ["data analy", "tableau", "power bi", "looker", "analytics"], profile: "Data Analyst" },
    { keywords: ["mlops", "model deployment", "mlflow", "sagemaker", "model serving"], profile: "MLOPS" },
    { keywords: ["automation", "selenium", "cypress", "test automation", "playwright", "appium"], profile: "Automation QA" },
    { keywords: ["manual testing", "test case", "manual qa", "functional testing"], profile: "MANUAL_QA" },
    { keywords: ["sap"], profile: "SAP" },
    { keywords: ["salesforce"], profile: "SalesForce" },
    { keywords: ["servicenow"], profile: "ServiceNow" },
    { keywords: ["cybersecurity", "cyber security", "soc", "siem", "threat", "vulnerability"], profile: "Cyber Security" },
    { keywords: ["information security", "iso 27001", "compliance", "grc"], profile: "Information Security" },
    { keywords: ["penetration", "ethical hacking", "vulnerability assessment", "pentest"], profile: "Ethical Hacking" },
    { keywords: ["application security", "sast", "dast", "secure sdlc", "appsec", "product security"], profile: "Application Security Engineering" },
    { keywords: ["embedded", "firmware", "rtos", "microcontroller", "functional safety", "iso 26262", "autosar"], profile: "Embedded Engineer" },
    { keywords: ["blockchain", "solidity", "web3", "smart contract"], profile: "Blockchain" },
    { keywords: ["product manager", "product management", "roadmap", "user stories", "product owner"], profile: "Product Manager" },
    { keywords: ["scrum master", "agile coach", "sprint planning"], profile: "Scrum Master" },
    { keywords: ["project manager", "project management", "pmp", "prince2"], profile: "Project Manager" },
    { keywords: ["business analyst", "requirement gathering", "brd", "gap analysis"], profile: "Business Analyst" },
    { keywords: ["networking", "network", "routing", "switching", "ospf", "bgp", "mpls", "cisco", "sd-wan", "firewall"], profile: "Networking Engineer" },
    { keywords: ["pega"], profile: "Pega" },
    { keywords: ["dynamics 365"], profile: "Dynamics 365" },
    { keywords: ["drupal"], profile: "Drupal" },
    { keywords: ["solarwinds", "monitoring", "observability", "nagios", "zabbix"], profile: "DevOps" },
  ];

  let bestMatch = "Backend";
  let bestScore = 0;

  for (const p of patterns) {
    const score = p.keywords.filter((k) => skillText.includes(k)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = p.profile;
    }
  }

  return bestMatch;
}

// ===========================
// CALL 2: LinkedIn Profile Parse
// ===========================
async function parseLinkedInProfile(fileContent, progressCb) {
  progressCb("Parsing LinkedIn profile structure...");

  let raw;
  if (fileContent.type === "pdf") {
    raw = await callClaudeWithPDF(
      LINKEDIN_PROFILE_PARSER_PROMPT,
      fileContent.base64,
      "Parse this LinkedIn PDF profile. Extract all information following the schema."
    );
  } else {
    raw = await callClaude(
      LINKEDIN_PROFILE_PARSER_PROMPT,
      `LinkedIn Profile Text:\n${fileContent.content}`
    );
  }

  return safeJsonParse(raw, {
    name: "Unknown",
    headline: "",
    top_skills: [],
    all_technical_skills: [],
    certifications: [],
    experience: [],
    education: [],
  });
}

// ===========================
// CALL 3: Skill Extraction + Profile Classification
// ===========================
async function extractSkillsAndClassify(parsedProfile, progressCb) {
  progressCb("Extracting skills & classifying profile...");

  const raw = await callClaude(
    LINKEDIN_SKILL_EXTRACTION_PROMPT,
    `LINKEDIN PROFILE DATA:\n${JSON.stringify(parsedProfile)}`,
    20000
  );

  return safeJsonParse(raw, {
    name: parsedProfile.name || "Unknown",
    primary_profile: "Unknown",
    secondary_profile: null,
    aggregated_skills: [],
  });
}

// ===========================
// Build LinkedIn context string for matching
// ===========================
function buildLinkedInContext(parsedProfile) {
  const parts = [];

  if (parsedProfile.headline) {
    parts.push(`HEADLINE: ${parsedProfile.headline}`);
  }

  if (parsedProfile.summary_text) {
    parts.push(`SUMMARY: ${parsedProfile.summary_text}`);
  }

  if (parsedProfile.top_skills && parsedProfile.top_skills.length > 0) {
    parts.push(`TOP SKILLS: ${parsedProfile.top_skills.join(", ")}`);
  }

  if (parsedProfile.all_technical_skills && parsedProfile.all_technical_skills.length > 0) {
    parts.push(`ALL TECHNICAL SKILLS: ${parsedProfile.all_technical_skills.join(", ")}`);
  }

  if (parsedProfile.certifications && parsedProfile.certifications.length > 0) {
    parts.push(`CERTIFICATIONS: ${parsedProfile.certifications.join(", ")}`);
  }

  if (parsedProfile.experience && parsedProfile.experience.length > 0) {
    const expLines = parsedProfile.experience.map((exp) => {
      let line = `${exp.designation || "Unknown Role"} at ${exp.company || "Unknown Company"}`;
      if (exp.start_date) line += ` (${exp.start_date} - ${exp.end_date || "Present"})`;
      if (exp.responsibilities && exp.responsibilities.length > 0) {
        line += "\n  " + exp.responsibilities.join("\n  ");
      }
      if (exp.tech_stack_mentioned && exp.tech_stack_mentioned.length > 0) {
        line += `\n  Tech: ${exp.tech_stack_mentioned.join(", ")}`;
      }
      return line;
    });
    parts.push(`EXPERIENCE:\n${expLines.join("\n\n")}`);
  }

  return parts.join("\n\n");
}

// ===========================
// CALL 4: JD ↔ Resume Matching (with full context)
// ===========================
async function matchProfileToJD(jdSkills, jdProfile, jdFullText, skillData, linkedinContext, progressCb) {
  progressCb("Matching skills to JD requirements...");

  const jdInput = {
    profile: jdProfile,
    skills: jdSkills,
  };

  const resumeInput = {
    primary_profile: skillData.primary_profile,
    secondary_profile: skillData.secondary_profile,
    aggregated_skills: (skillData.aggregated_skills || []).map((s) => ({
      ResumeSkill: s.ResumeSkill,
      impact_score_max: s.impact_score_max,
      source_details: s.source_details || [],
      signal_sources: s.signal_sources || [],
    })),
  };

  // Build the rich context input
  const userContent = `JD_SKILL_LIST:${JSON.stringify(jdInput)}

RESUME_SKILL_LIST:${JSON.stringify(resumeInput)}

JD_FULL_TEXT:
${jdFullText || "(not available)"}

LINKEDIN_EXPERIENCE_CONTEXT:
${linkedinContext || "(not available)"}`;

  const raw = await callClaude(
    MATCHING_PROMPT,
    userContent,
    20000
  );

  const matchResult = safeJsonParse(raw, {
    JD_profile: jdProfile,
    Resume_primary_profile: skillData.primary_profile,
    matched_skills: [],
  });

  // Adapt to the scoring function's expected format
  const comparison = {
    JD_profile: matchResult.JD_profile || jdProfile,
    Resume_profile: matchResult.Resume_primary_profile || skillData.primary_profile,
    matched_skills: matchResult.matched_skills || [],
  };

  const { overallPercentage, totalScore, totalImportance } = calculateOverallScore([comparison]);
  const verdict = getVerdict(overallPercentage);

  return {
    comparison,
    overallPercentage,
    totalScore,
    totalImportance,
    verdict,
  };
}

// ===========================
// Generate summary text
// ===========================
function generateSummary(matchResult, jdParsed, interviewerName) {
  const { overallPercentage, verdict, comparison } = matchResult;

  const strongMatches = [];
  const moderateMatches = [];
  const gaps = [];

  for (const skill of comparison.matched_skills || []) {
    if (!skill.matched_resume_skills || skill.matched_resume_skills.length === 0) {
      gaps.push({ name: skill.JDskill, category: skill.category });
    } else {
      const best = skill.matched_resume_skills[0];
      if (best.match_strength === "strong") strongMatches.push(skill.JDskill);
      else if (best.match_strength === "moderate") moderateMatches.push(skill.JDskill);
    }
  }

  const mustHaveGaps = gaps.filter((g) => g.category === "must_have").map((g) => g.name);
  const goodToHaveGaps = gaps.filter((g) => g.category === "good_to_have").map((g) => g.name);

  let summary = `${interviewerName} scores ${overallPercentage}% match (${verdict}).`;

  if (strongMatches.length > 0) {
    summary += ` Strong alignment on: ${strongMatches.slice(0, 5).join(", ")}.`;
  }

  if (moderateMatches.length > 0) {
    summary += ` Moderate alignment on: ${moderateMatches.slice(0, 3).join(", ")}.`;
  }

  if (mustHaveGaps.length > 0) {
    summary += ` Missing must-have skills: ${mustHaveGaps.join(", ")}.`;
  } else if (goodToHaveGaps.length > 0) {
    summary += ` Gaps in good-to-have: ${goodToHaveGaps.slice(0, 3).join(", ")}.`;
  }

  return summary;
}

// ===========================
// SSE Evaluation Endpoint
// ===========================
app.post(
  "/api/evaluate",
  upload.fields([
    { name: "jds", maxCount: 5 },
    { name: "interviewers", maxCount: 10 },
  ]),
  async (req, res) => {
    try {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      function send(data) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }

      const jdFiles = req.files["jds"] || [];
      const interviewerFiles = req.files["interviewers"] || [];

      // Accept pre-parsed JDs
      let preParsedJDs = [];
      if (req.body.parsedJDs) {
        try { preParsedJDs = JSON.parse(req.body.parsedJDs); } catch (e) {}
      }

      if (jdFiles.length === 0 && preParsedJDs.length === 0) {
        send({ type: "error", message: "No JD files uploaded" });
        return res.end();
      }
      if (interviewerFiles.length === 0) {
        send({ type: "error", message: "No interviewer files uploaded" });
        return res.end();
      }

      // ---- CALL 1: Parse JDs ----
      const parsedJDs = [...preParsedJDs];
      const existingJDNames = new Set(preParsedJDs.map((jd) => jd.filename));

      for (let i = 0; i < jdFiles.length; i++) {
        const jdFile = jdFiles[i];

        // Skip if this JD was already pre-parsed (dedup safety net)
        if (existingJDNames.has(jdFile.originalname)) {
          send({ type: "progress", step: "jd_parse", message: `Skipping already-parsed JD: ${jdFile.originalname}` });
          continue;
        }

        send({ type: "progress", step: "jd_parse", message: `Parsing JD ${i + 1}/${jdFiles.length}: ${jdFile.originalname}` });

        const jdContent = await extractContent(jdFile);
        const { parsed, jdSkills, jdText } = await parseJD(jdContent);
        const jdProfile = inferJDProfile(jdSkills);

        parsedJDs.push({
          filename: jdFile.originalname,
          jdText: jdContent.type === "text" ? jdContent.content : "(PDF)",
          parsed,
          jdSkills,
          jdProfile,
        });

        existingJDNames.add(jdFile.originalname);
      }

      send({
        type: "jds_parsed",
        jds: parsedJDs.map((jd) => ({
          filename: jd.filename,
          jdProfile: jd.jdProfile,
          mustHaveCount: (jd.parsed.must_have || []).length,
          goodToHaveCount: (jd.parsed.good_to_have || []).length,
        })),
      });

      // ---- Process each interviewer ----
      const allResults = [];

      for (let i = 0; i < interviewerFiles.length; i++) {
        const intFile = interviewerFiles[i];
        const startTime = Date.now();

        send({
          type: "progress",
          step: "interviewer",
          interviewer: i + 1,
          total: interviewerFiles.length,
          message: `Processing interviewer ${i + 1}/${interviewerFiles.length}: ${intFile.originalname}`,
        });

        try {
          const fileContent = await extractContent(intFile);

          // CALL 2: Parse LinkedIn Profile
          const parsedProfile = await parseLinkedInProfile(fileContent, (msg) => {
            send({ type: "progress", step: "parse", interviewer: i + 1, message: `[${intFile.originalname}] ${msg}` });
          });

          // CALL 3: Classify + Extract Skills
          const skillData = await extractSkillsAndClassify(parsedProfile, (msg) => {
            send({ type: "progress", step: "skills", interviewer: i + 1, message: `[${intFile.originalname}] ${msg}` });
          });

          const interviewerName = skillData.name || parsedProfile.name || "Unknown";

          // Build LinkedIn context string for richer matching
          const linkedinContext = buildLinkedInContext(parsedProfile);

          // CALL 4: Match against each JD
          const jdResults = [];
          for (let j = 0; j < parsedJDs.length; j++) {
            const jd = parsedJDs[j];

            send({
              type: "progress",
              step: "matching",
              interviewer: i + 1,
              message: `[${intFile.originalname}] Matching against: ${jd.filename}`,
            });

            const matchResult = await matchProfileToJD(
              jd.jdSkills,
              jd.jdProfile,
              jd.jdText || "",
              skillData,
              linkedinContext,
              (msg) => send({ type: "progress", step: "matching", interviewer: i + 1, message: `[${intFile.originalname}] ${msg}` })
            );

            const summary = generateSummary(matchResult, jd.parsed, interviewerName);

            jdResults.push({
              jdFilename: jd.filename,
              jdProfile: jd.jdProfile,
              mustHaveSkills: jd.parsed.must_have || [],
              goodToHaveSkills: jd.parsed.good_to_have || [],
              overallPercentage: matchResult.overallPercentage,
              verdict: matchResult.verdict,
              summary,
              totalScore: matchResult.totalScore,
              totalImportance: matchResult.totalImportance,
            });
          }

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

          const result = {
            interviewerFile: intFile.originalname,
            interviewerName,
            primaryProfile: skillData.primary_profile,
            secondaryProfile: skillData.secondary_profile,
            profileConfidence: skillData.profile_confidence,
            profiles: [skillData.primary_profile, skillData.secondary_profile].filter(Boolean),
            totalExperienceYears: skillData.total_experience_years,
            jdResults,
            processingTime: `${elapsed}s`,
          };

          allResults.push(result);

          send({
            type: "interviewer_complete",
            interviewer: i + 1,
            total: interviewerFiles.length,
            result,
          });
        } catch (err) {
          console.error(`Error processing ${intFile.originalname}:`, err);
          allResults.push({
            interviewerFile: intFile.originalname,
            interviewerName: "Error",
            profiles: [],
            jdResults: [],
            error: err.message,
          });

          send({
            type: "interviewer_error",
            interviewer: i + 1,
            filename: intFile.originalname,
            error: err.message,
          });
        }
      }

      // Final result
      send({
        type: "complete",
        results: allResults,
        parsedJDs: parsedJDs.map((jd) => ({
          filename: jd.filename,
          jdProfile: jd.jdProfile,
          mustHaveCount: (jd.parsed.must_have || []).length,
          goodToHaveCount: (jd.parsed.good_to_have || []).length,
          parsed: jd.parsed,
          jdSkills: jd.jdSkills,
        })),
      });

      res.end();
    } catch (err) {
      console.error("Evaluation error:", err);
      try {
        res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
      } catch (e) {}
      res.end();
    }
  }
);

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", version: "3.0.0", pipeline: "4-call LinkedIn-optimized" });
});

// ===========================
// Non-streaming endpoint (Safari fallback)
// Returns a single JSON response instead of SSE
// ===========================
app.post(
  "/api/evaluate-sync",
  upload.fields([
    { name: "jds", maxCount: 5 },
    { name: "interviewers", maxCount: 10 },
  ]),
  async (req, res) => {
    try {
      const jdFiles = req.files["jds"] || [];
      const interviewerFiles = req.files["interviewers"] || [];

      let preParsedJDs = [];
      if (req.body.parsedJDs) {
        try { preParsedJDs = JSON.parse(req.body.parsedJDs); } catch (e) {}
      }

      if (jdFiles.length === 0 && preParsedJDs.length === 0) {
        return res.status(400).json({ error: "No JD files uploaded" });
      }
      if (interviewerFiles.length === 0) {
        return res.status(400).json({ error: "No interviewer files uploaded" });
      }

      // Parse JDs
      const parsedJDs = [...preParsedJDs];
      const existingJDNames = new Set(preParsedJDs.map((jd) => jd.filename));

      for (const jdFile of jdFiles) {
        if (existingJDNames.has(jdFile.originalname)) continue;
        const jdContent = await extractContent(jdFile);
        const { parsed, jdSkills, jdText } = await parseJD(jdContent);
        const jdProfile = inferJDProfile(jdSkills);
        parsedJDs.push({
          filename: jdFile.originalname,
          jdText: jdContent.type === "text" ? jdContent.content : "(PDF)",
          parsed, jdSkills, jdProfile,
        });
        existingJDNames.add(jdFile.originalname);
      }

      // Process interviewers
      const allResults = [];

      for (const intFile of interviewerFiles) {
        const startTime = Date.now();
        try {
          const fileContent = await extractContent(intFile);
          const parsedProfile = await parseLinkedInProfile(fileContent, () => {});
          const skillData = await extractSkillsAndClassify(parsedProfile, () => {});
          const interviewerName = skillData.name || parsedProfile.name || "Unknown";
          const linkedinContext = buildLinkedInContext(parsedProfile);

          const jdResults = [];
          for (const jd of parsedJDs) {
            const matchResult = await matchProfileToJD(jd.jdSkills, jd.jdProfile, jd.jdText || "", skillData, linkedinContext, () => {});
            const summary = generateSummary(matchResult, jd.parsed, interviewerName);
            jdResults.push({
              jdFilename: jd.filename,
              jdProfile: jd.jdProfile,
              mustHaveSkills: jd.parsed.must_have || [],
              goodToHaveSkills: jd.parsed.good_to_have || [],
              overallPercentage: matchResult.overallPercentage,
              verdict: matchResult.verdict,
              summary,
              totalScore: matchResult.totalScore,
              totalImportance: matchResult.totalImportance,
            });
          }

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          allResults.push({
            interviewerFile: intFile.originalname,
            interviewerName,
            primaryProfile: skillData.primary_profile,
            secondaryProfile: skillData.secondary_profile,
            profileConfidence: skillData.profile_confidence,
            profiles: [skillData.primary_profile, skillData.secondary_profile].filter(Boolean),
            totalExperienceYears: skillData.total_experience_years,
            jdResults,
            processingTime: `${elapsed}s`,
          });
        } catch (err) {
          console.error(`Error processing ${intFile.originalname}:`, err);
          allResults.push({
            interviewerFile: intFile.originalname,
            interviewerName: "Error",
            profiles: [],
            jdResults: [],
            error: err.message,
          });
        }
      }

      res.json({
        results: allResults,
        parsedJDs: parsedJDs.map((jd) => ({
          filename: jd.filename,
          jdProfile: jd.jdProfile,
          mustHaveCount: (jd.parsed.must_have || []).length,
          goodToHaveCount: (jd.parsed.good_to_have || []).length,
          parsed: jd.parsed,
          jdSkills: jd.jdSkills,
        })),
      });
    } catch (err) {
      console.error("Evaluation error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Serve static files in production
const distPath = path.join(__dirname, "..", "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Interviewer Fit Evaluator v3 — LinkedIn-optimized pipeline — port ${PORT}`);
});
