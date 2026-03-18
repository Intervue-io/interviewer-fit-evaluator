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
  PERSONAL_INFORMATION_PROMPT,
  PROFESSIONAL_EXPERIENCE_PROMPT,
  TECHNICAL_NONTECHNICAL_SKILLS_PROMPT,
  EDUCATIONAL_BACKGROUND_PROMPT,
  SOCIAL_MEDIA_LINKS_DEV_LINKS_PROMPT,
  CERTIFICATIONS_LANGUAGES_PROMPT,
  PROJECT_EXTRACTION_PROMPT,
  PROJECTS_PROFILE_CLASSIFIER,
  PROFESSIONAL_EXPERIENCE_PROFILE_CLASSIFIER_PROMPT,
  SKILL_EXTRACTION_PROJECTS,
  SKILL_EXTRACTION_EXPERIENCES,
  SKILL_AGGREGATION_PROMPT,
  COMPARING_RESUME_JD_PROMPT,
} from "./prompts.js";

import {
  addTimeFactors,
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
  const messages = [{ role: "user", content: userContent }];
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  return text;
}

// ===========================
// Claude with PDF (vision)
// ===========================
async function callClaudeWithPDF(systemPrompt, pdfBase64, userText, maxTokens = 16000) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
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

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  return text;
}

// ===========================
// Safe JSON parse
// ===========================
function safeJsonParse(text, fallback = null) {
  try {
    // Strip markdown code fences if present
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
// Extract text from uploaded file
// ===========================
async function extractText(file) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === ".txt") {
    return file.buffer.toString("utf-8");
  }

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }

  if (ext === ".pdf") {
    // Return base64 for PDF — we'll send to Claude vision
    return { isPdf: true, base64: file.buffer.toString("base64") };
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

// ===========================
// JD Parsing (Step 0)
// ===========================
async function parseJD(jdText) {
  console.log("  [JD Parse] Extracting must-have / good-to-have skills...");
  const raw = await callClaude(JD_PARSER_PROMPT, `Job Description:\n${jdText}`);
  const parsed = safeJsonParse(raw, { must_have: [], good_to_have: [] });

  // Add importance scores: must_have = 9, good_to_have = 5
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

  return { parsed, jdSkills };
}

// ===========================
// Infer dominant JD profile
// ===========================
function inferJDProfile(jdSkills) {
  // Simple heuristic: look at the skills and map to most likely profile
  // This will be refined by the matching prompt which handles cross-profile matching
  const skillText = jdSkills.map((s) => s.JDskill).join(", ");

  // Common patterns
  const patterns = [
    { keywords: ["react", "angular", "vue", "css", "html", "frontend", "ui", "ux"], profile: "Frontend" },
    { keywords: ["node", "express", "django", "flask", "spring", "api", "backend", "microservice"], profile: "Backend" },
    { keywords: ["fullstack", "full-stack", "full stack", "mern", "mean"], profile: "Full Stack" },
    { keywords: ["ios", "swift", "objective-c", "xcode"], profile: "IOS" },
    { keywords: ["android", "kotlin", "java mobile"], profile: "Android" },
    { keywords: ["flutter", "dart"], profile: "Flutter" },
    { keywords: ["react native"], profile: "React Native" },
    { keywords: ["devops", "ci/cd", "jenkins", "terraform", "ansible", "kubernetes", "docker", "helm"], profile: "DevOps" },
    { keywords: ["cloud", "aws", "azure", "gcp", "cloud engineer"], profile: "Cloud Engineering" },
    { keywords: ["devsecops"], profile: "DevSecOps" },
    { keywords: ["data science", "machine learning", "deep learning", "nlp", "computer vision"], profile: "Data Science" },
    { keywords: ["data engineer", "etl", "data pipeline", "spark", "airflow", "databricks"], profile: "Data Engineering" },
    { keywords: ["data analy", "tableau", "power bi", "looker", "analytics"], profile: "Data Analyst" },
    { keywords: ["ml/ai", "mlops", "model deployment", "mlflow"], profile: "MLOPS" },
    { keywords: ["automation", "selenium", "cypress", "test automation", "playwright"], profile: "Automation QA" },
    { keywords: ["manual testing", "test case", "manual qa"], profile: "MANUAL_QA" },
    { keywords: ["sap"], profile: "SAP" },
    { keywords: ["salesforce"], profile: "SalesForce" },
    { keywords: ["servicenow"], profile: "ServiceNow" },
    { keywords: ["cybersecurity", "cyber security", "soc", "siem", "threat"], profile: "Cyber Security" },
    { keywords: ["information security", "iso 27001", "compliance"], profile: "Information Security" },
    { keywords: ["penetration", "ethical hacking", "vulnerability"], profile: "Ethical Hacking" },
    { keywords: ["embedded", "firmware", "rtos", "microcontroller"], profile: "Embedded Engineer" },
    { keywords: ["blockchain", "solidity", "web3"], profile: "Blockchain" },
    { keywords: ["product manager", "product management", "roadmap", "user stories"], profile: "Product Manager" },
    { keywords: ["scrum master", "agile", "sprint planning"], profile: "Scrum Master" },
    { keywords: ["project manager", "project management", "pmp"], profile: "Project Manager" },
    { keywords: ["business analyst", "requirement gathering", "brd"], profile: "Business Analyst" },
    { keywords: ["pega"], profile: "Pega" },
    { keywords: ["dynamics 365"], profile: "Dynamics 365" },
    { keywords: ["drupal"], profile: "Drupal" },
  ];

  const lower = skillText.toLowerCase();
  let bestMatch = "Backend"; // default
  let bestScore = 0;

  for (const p of patterns) {
    const score = p.keywords.filter((k) => lower.includes(k)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = p.profile;
    }
  }

  return bestMatch;
}

// ===========================
// CV Pipeline (13 steps)
// ===========================
async function runCVPipeline(cvContent, progressCallback) {
  // cvContent is either { isPdf: true, base64 } or a text string
  const isPdf = typeof cvContent === "object" && cvContent.isPdf;
  const cvText = isPdf ? null : cvContent;
  const pdfBase64 = isPdf ? cvContent.base64 : null;

  async function callCV(prompt, userMsg) {
    if (isPdf) {
      return callClaudeWithPDF(prompt, pdfBase64, userMsg || "Extract information from this CV/resume.");
    }
    return callClaude(prompt, `CV Text:\n${cvText}`);
  }

  // Step 1: Personal Information
  progressCallback("Extracting personal information...");
  const personalInfoRaw = await callCV(PERSONAL_INFORMATION_PROMPT, "Extract personal information from this CV/resume.");
  const personalInfo = safeJsonParse(personalInfoRaw, {});

  // Step 2: Professional Experience
  progressCallback("Extracting professional experience...");
  const profExpRaw = await callCV(PROFESSIONAL_EXPERIENCE_PROMPT, "Extract the candidate's professional experience from this CV/resume.");
  const profExp = safeJsonParse(profExpRaw, { experience: [] });

  // Step 3: Education
  progressCallback("Extracting education...");
  const educationRaw = await callCV(EDUCATIONAL_BACKGROUND_PROMPT, "Extract the candidate's educational background from this CV/resume.");
  const education = safeJsonParse(educationRaw, { education: [] });

  // Step 4: Technical & Non-Technical Skills
  progressCallback("Extracting skills...");
  const skillsRaw = await callCV(TECHNICAL_NONTECHNICAL_SKILLS_PROMPT, "Extract all skills from this CV/resume.");
  const skills = safeJsonParse(skillsRaw, { skills: { technical: [], non_technical: [] } });

  // Step 5: Social Media & Developer Links
  progressCallback("Extracting links...");
  const linksRaw = await callCV(SOCIAL_MEDIA_LINKS_DEV_LINKS_PROMPT, "Extract all online, social, and developer links from this CV/resume.");
  const links = safeJsonParse(linksRaw, {});

  // Step 6: Certifications & Languages
  progressCallback("Extracting certifications...");
  const certsRaw = await callCV(CERTIFICATIONS_LANGUAGES_PROMPT, "Extract certifications and languages from this CV/resume.");
  const certs = safeJsonParse(certsRaw, { certifications: [], languages: [] });

  // Step 7: Project Extraction
  progressCallback("Extracting projects...");
  const projectsRaw = await callCV(PROJECT_EXTRACTION_PROMPT, "Extract the candidate's project experience from this CV/resume.");
  const projects = safeJsonParse(projectsRaw, { projects: [] });

  // Step 8: Project Profile Classification
  progressCallback("Classifying project profiles...");
  let classifiedProjects = [];
  const projectsList = projects.projects || [];
  if (projectsList.length > 0) {
    const filteredProjects = projectsList.map((p, idx) => ({
      title: p.title,
      company: p.company,
      technologies: p.technologies || [],
      responsibilities: p.responsibilities || [],
      description: p.description,
    }));

    const projClassRaw = await callClaude(
      PROJECTS_PROFILE_CLASSIFIER,
      `NOW PROCESS THE FOLLOWING INPUT:\n${JSON.stringify(filteredProjects)}`
    );
    const projClassification = safeJsonParse(projClassRaw, []);

    // Merge classification back into projects
    for (const project of projectsList) {
      const match = (projClassification || []).find(
        (pc) => pc.title === project.title && pc.company === project.company
      );
      if (match) {
        project.profile = match.profile;
        project.reasoning = match.reason;
        project.confidence = match.confidence;
      }
    }

    // Add time factors
    classifiedProjects = addTimeFactors(projectsList);
  }

  // Step 9: Experience Profile Classification
  progressCallback("Classifying experience profiles...");
  let classifiedExperiences = [];
  const experiencesList = profExp.experience || [];
  if (experiencesList.length > 0) {
    const filteredExperiences = experiencesList.map((e) => ({
      company: e.company,
      designation: e.designation,
      responsibilities: e.responsibilities || [],
      tech_stack: e.tech_stack || [],
      projects: e.projects,
    }));

    const expClassRaw = await callClaude(
      PROFESSIONAL_EXPERIENCE_PROFILE_CLASSIFIER_PROMPT,
      `NOW PROCESS THE FOLLOWING INPUT:\n${JSON.stringify(filteredExperiences)}`
    );
    const expClassification = safeJsonParse(expClassRaw, []);

    // Merge classification and calculate experience
    for (const exp of experiencesList) {
      const match = (expClassification || []).find(
        (ec) => ec.designation === exp.designation && ec.company === exp.company
      );
      if (match) {
        exp.profile = match.profile;
        exp.reasoning = match.reason;
        exp.confidence = match.confidence;
      }
    }

    // Add time factors
    classifiedExperiences = addTimeFactors(experiencesList);
  }

  // Step 10: Skill Extraction from Projects
  progressCallback("Extracting skills from projects...");
  let projectSkills = [];
  if (classifiedProjects.length > 0) {
    const filteredForSkills = classifiedProjects.map((p) => ({
      title: p.title,
      company: p.company,
      profile: p.profile || null,
      technologies: p.technologies || [],
      responsibilities: p.responsibilities || [],
      description: p.description,
      recency_factor: p.recency_factor,
      duration_factor: p.duration_factor,
    }));

    const projSkillsRaw = await callClaude(
      SKILL_EXTRACTION_PROJECTS,
      `NOW PROCESS THE FOLLOWING INPUT:\n${JSON.stringify(filteredForSkills)}`
    );
    projectSkills = safeJsonParse(projSkillsRaw, []) || [];

    // Add impact_score
    for (const proj of projectSkills) {
      for (const skill of proj.skills || []) {
        skill.impact_score = Math.round(
          (proj.recency_factor || 1) * (proj.duration_factor || 1) * (skill.score || 0) * 10
        ) / 10;
      }
    }
  }

  // Step 11: Skill Extraction from Experiences
  progressCallback("Extracting skills from experiences...");
  let experienceSkills = [];
  if (classifiedExperiences.length > 0) {
    const filteredForExpSkills = classifiedExperiences.map((e) => ({
      designation: e.designation,
      company: e.company,
      profile: e.profile || null,
      responsibilities: e.responsibilities || [],
      tech_stack: e.tech_stack || [],
      projects: e.projects || [],
      recency_factor: e.recency_factor,
      duration_factor: e.duration_factor,
    }));

    const expSkillsRaw = await callClaude(
      SKILL_EXTRACTION_EXPERIENCES,
      `NOW PROCESS THE FOLLOWING INPUT:\n${JSON.stringify(filteredForExpSkills)}`
    );
    experienceSkills = safeJsonParse(expSkillsRaw, []) || [];

    // Add impact_score
    for (const exp of experienceSkills) {
      for (const skill of exp.skills || []) {
        skill.impact_score = Math.round(
          (exp.recency_factor || 1) * (exp.duration_factor || 1) * (skill.score || 0) * 10
        ) / 10;
      }
    }
  }

  // Step 12: Skill Aggregation per profile
  progressCallback("Aggregating skills by profile...");
  // Group skills by profile
  const profileSkillsMap = {};

  for (const proj of projectSkills) {
    const profile = proj.profile || "Unknown";
    if (!profileSkillsMap[profile]) {
      profileSkillsMap[profile] = { skills: [], selfDeclared: [] };
    }
    for (const skill of proj.skills || []) {
      profileSkillsMap[profile].skills.push({
        ResumeSkill: skill.ResumeSkill,
        impact_score: skill.impact_score,
        source_type: "project",
        title: proj.title,
        company: proj.company,
        source_line: skill.source_line,
      });
    }
  }

  for (const exp of experienceSkills) {
    const profile = exp.profile || "Unknown";
    if (!profileSkillsMap[profile]) {
      profileSkillsMap[profile] = { skills: [], selfDeclared: [] };
    }
    for (const skill of exp.skills || []) {
      profileSkillsMap[profile].skills.push({
        ResumeSkill: skill.ResumeSkill,
        impact_score: skill.impact_score,
        source_type: "experience",
        designation: exp.designation,
        company: exp.company,
        source_line: skill.source_line,
      });
    }
  }

  // Add self-declared skills to all profiles
  const techSkills = skills?.skills?.technical || [];
  const selfDeclaredSkills = techSkills.map((s) => ({
    ResumeSkill: s,
    score: 5,
    source_line: "Technical Skills section",
  }));

  for (const profile of Object.keys(profileSkillsMap)) {
    profileSkillsMap[profile].selfDeclared = selfDeclaredSkills;
  }

  // If no profiles from projects/experience, create one with self-declared
  if (Object.keys(profileSkillsMap).length === 0 && selfDeclaredSkills.length > 0) {
    profileSkillsMap["Unknown"] = { skills: [], selfDeclared: selfDeclaredSkills };
  }

  // Run aggregation per profile
  const aggregatedProfiles = [];
  for (const [profile, data] of Object.entries(profileSkillsMap)) {
    if (data.skills.length === 0) continue;

    const input = {
      profile,
      skills: data.skills,
      self_declared_skills: data.selfDeclared,
    };

    const aggRaw = await callClaude(
      SKILL_AGGREGATION_PROMPT,
      `INPUT:${JSON.stringify(input)}`
    );
    const aggregated = safeJsonParse(aggRaw, { profile, aggregated_skills: [] });

    // Compute impact_score_max for each aggregated skill
    if (aggregated.aggregated_skills) {
      for (const skill of aggregated.aggregated_skills) {
        const scores = skill.impact_score || [];
        skill.impact_score_max = scores.length > 0 ? Math.max(...scores) : 0;
      }
    }

    aggregatedProfiles.push(aggregated);
  }

  return {
    personalInfo,
    experience: classifiedExperiences,
    education,
    skills,
    links,
    certifications: certs,
    projects: classifiedProjects,
    projectSkills,
    experienceSkills,
    aggregatedProfiles,
    interviewerName: personalInfo?.name || "Unknown Interviewer",
  };
}

// ===========================
// JD ↔ Resume Matching (Step 13)
// ===========================
async function matchResumeToJD(jdSkills, jdProfile, aggregatedProfiles, progressCallback) {
  progressCallback("Matching resume skills to JD requirements...");

  const comparisons = [];

  for (const profileData of aggregatedProfiles) {
    const jdInput = {
      profile: jdProfile,
      skills: jdSkills,
    };

    const resumeInput = {
      profile: profileData.profile,
      aggregated_skills: (profileData.aggregated_skills || []).map((s) => ({
        ResumeSkill: s.ResumeSkill,
        impact_score_max: s.impact_score_max,
        source_lines: s.source_lines || [],
        supporting_self_declared_skills: s.supporting_self_declared_skills || [],
      })),
    };

    const matchRaw = await callClaude(
      COMPARING_RESUME_JD_PROMPT,
      `JD_SKILL_LIST:${JSON.stringify(jdInput)}\nRESUME_SKILL_LIST:${JSON.stringify(resumeInput)}`
    );

    const matchResult = safeJsonParse(matchRaw, {
      JD_profile: jdProfile,
      Resume_profile: profileData.profile,
      matched_skills: [],
    });

    comparisons.push(matchResult);
  }

  // Calculate overall score
  const { overallPercentage, totalScore, totalImportance } = calculateOverallScore(comparisons);
  const verdict = getVerdict(overallPercentage);

  return {
    comparisons,
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
  const { overallPercentage, verdict, comparisons } = matchResult;

  const strongMatches = [];
  const moderateMatches = [];
  const gaps = [];

  for (const comp of comparisons) {
    for (const skill of comp.matched_skills || []) {
      if (!skill.matched_resume_skills || skill.matched_resume_skills.length === 0) {
        gaps.push(skill.JDskill);
      } else {
        const bestMatch = skill.matched_resume_skills[0];
        if (bestMatch.match_strength === "strong") {
          strongMatches.push(skill.JDskill);
        } else if (bestMatch.match_strength === "moderate") {
          moderateMatches.push(skill.JDskill);
        }
      }
    }
  }

  const mustHaveGaps = gaps.filter((g) =>
    (jdParsed.must_have || []).some((m) => m.skill === g)
  );

  let summary = `${interviewerName} scores ${overallPercentage}% match (${verdict}).`;

  if (strongMatches.length > 0) {
    summary += ` Strong alignment on: ${strongMatches.slice(0, 5).join(", ")}.`;
  }

  if (moderateMatches.length > 0) {
    summary += ` Moderate alignment on: ${moderateMatches.slice(0, 3).join(", ")}.`;
  }

  if (mustHaveGaps.length > 0) {
    summary += ` Missing must-have skills: ${mustHaveGaps.join(", ")}.`;
  } else if (gaps.length > 0) {
    summary += ` Gaps in: ${gaps.slice(0, 3).join(", ")}.`;
  }

  return summary;
}

// ===========================
// Determine dominant profile from aggregated data
// ===========================
function getDominantProfile(aggregatedProfiles) {
  if (!aggregatedProfiles || aggregatedProfiles.length === 0) return "Unknown";

  // Return the profile with the most aggregated skills
  let best = aggregatedProfiles[0];
  for (const p of aggregatedProfiles) {
    if ((p.aggregated_skills || []).length > (best.aggregated_skills || []).length) {
      best = p;
    }
  }
  return best.profile || "Unknown";
}

// ===========================
// SSE Endpoint for evaluation with progress
// ===========================
app.post(
  "/api/evaluate",
  upload.fields([
    { name: "jds", maxCount: 5 },
    { name: "interviewers", maxCount: 10 },
  ]),
  async (req, res) => {
    try {
      // Set up SSE
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      function sendProgress(data) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }

      const jdFiles = req.files["jds"] || [];
      const interviewerFiles = req.files["interviewers"] || [];

      // Also accept pre-parsed JDs from the request body
      let preParsedJDs = [];
      if (req.body.parsedJDs) {
        try {
          preParsedJDs = JSON.parse(req.body.parsedJDs);
        } catch (e) {}
      }

      if (jdFiles.length === 0 && preParsedJDs.length === 0) {
        sendProgress({ type: "error", message: "No JD files uploaded" });
        res.end();
        return;
      }

      if (interviewerFiles.length === 0) {
        sendProgress({ type: "error", message: "No interviewer files uploaded" });
        res.end();
        return;
      }

      // Step 0: Parse JDs (or use pre-parsed)
      const parsedJDs = [...preParsedJDs];

      for (let i = 0; i < jdFiles.length; i++) {
        const jdFile = jdFiles[i];
        sendProgress({
          type: "progress",
          step: "jd_parse",
          message: `Parsing JD ${i + 1}/${jdFiles.length}: ${jdFile.originalname}`,
        });

        const jdContent = await extractText(jdFile);
        const jdText = typeof jdContent === "string" ? jdContent : "Unable to extract JD text from PDF.";
        const { parsed, jdSkills } = await parseJD(jdText);
        const jdProfile = inferJDProfile(jdSkills);

        parsedJDs.push({
          filename: jdFile.originalname,
          jdText,
          parsed,
          jdSkills,
          jdProfile,
        });
      }

      sendProgress({
        type: "jds_parsed",
        jds: parsedJDs.map((jd) => ({
          filename: jd.filename,
          jdProfile: jd.jdProfile,
          mustHaveCount: (jd.parsed.must_have || []).length,
          goodToHaveCount: (jd.parsed.good_to_have || []).length,
        })),
      });

      // Process each interviewer
      const allResults = [];

      for (let i = 0; i < interviewerFiles.length; i++) {
        const intFile = interviewerFiles[i];
        sendProgress({
          type: "progress",
          step: "cv_pipeline",
          interviewer: i + 1,
          total: interviewerFiles.length,
          message: `Processing interviewer ${i + 1}/${interviewerFiles.length}: ${intFile.originalname}`,
        });

        try {
          // Extract CV content
          const cvContent = await extractText(intFile);

          // Run full 13-step CV pipeline
          const cvData = await runCVPipeline(cvContent, (stepMsg) => {
            sendProgress({
              type: "progress",
              step: "cv_pipeline",
              interviewer: i + 1,
              total: interviewerFiles.length,
              message: `[${intFile.originalname}] ${stepMsg}`,
            });
          });

          const dominantProfile = getDominantProfile(cvData.aggregatedProfiles);

          // Match against each JD
          const jdResults = [];
          for (let j = 0; j < parsedJDs.length; j++) {
            const jd = parsedJDs[j];

            sendProgress({
              type: "progress",
              step: "matching",
              interviewer: i + 1,
              message: `[${intFile.originalname}] Matching against JD: ${jd.filename}`,
            });

            const matchResult = await matchResumeToJD(
              jd.jdSkills,
              jd.jdProfile,
              cvData.aggregatedProfiles,
              (msg) => {
                sendProgress({
                  type: "progress",
                  step: "matching",
                  interviewer: i + 1,
                  message: `[${intFile.originalname}] ${msg}`,
                });
              }
            );

            const summary = generateSummary(matchResult, jd.parsed, cvData.interviewerName);

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

          allResults.push({
            interviewerFile: intFile.originalname,
            interviewerName: cvData.interviewerName,
            dominantProfile,
            profiles: cvData.aggregatedProfiles.map((p) => p.profile).filter(Boolean),
            jdResults,
          });

          sendProgress({
            type: "interviewer_complete",
            interviewer: i + 1,
            total: interviewerFiles.length,
            result: allResults[allResults.length - 1],
          });
        } catch (err) {
          console.error(`Error processing interviewer ${intFile.originalname}:`, err);
          allResults.push({
            interviewerFile: intFile.originalname,
            interviewerName: "Error",
            dominantProfile: "Unknown",
            profiles: [],
            jdResults: [],
            error: err.message,
          });

          sendProgress({
            type: "interviewer_error",
            interviewer: i + 1,
            filename: intFile.originalname,
            error: err.message,
          });
        }
      }

      // Final result
      sendProgress({
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
        res.write(
          `data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`
        );
      } catch (e) {}
      res.end();
    }
  }
);

// ===========================
// Health check
// ===========================
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", version: "2.0.0" });
});

// ===========================
// Serve static files in production
// ===========================
const distPath = path.join(__dirname, "..", "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Interviewer Fit Evaluator v2 running on port ${PORT}`);
});
