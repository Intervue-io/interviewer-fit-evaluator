// Scoring logic ported from the Intervue CV Parser Colab pipeline

// ===========================
// Match Weights
// ===========================
const MATCH_WEIGHT = {
  strong: 1.0,
  moderate: 0.75,
  weak: 0.5,
};

// ===========================
// Profile → Cluster Mapping
// ===========================
const PROFILE_CLUSTER = {
  // Core Engineering
  Backend: "Core",
  "Full Stack": "Core",
  Frontend: "Core",
  IOS: "Core",
  Android: "Core",
  Flutter: "Core",
  "React Native": "Core",
  Drupal: "Core",
  "Adobe Experience Manager": "Core",
  "Embedded Engineer": "Core",

  // Data
  "Data Science": "Data",
  "Data Analyst": "Data",
  "Data Engineering": "Data",
  "ML/AI": "Data",
  MLOPS: "Data",
  "Data Modeler": "Data",
  "Database Performance Tuner": "Data",
  "Database Administrator": "Data",
  "Business Intelligence": "Data",

  // Infra
  DevOps: "Infra",
  "Cloud Engineering": "Infra",
  DevSecOps: "Infra",

  // QA
  "Automation QA": "QA",
  MANUAL_QA: "QA",

  // Security
  "Application Security Engineering": "Security",
  "Information Security": "Security",
  "Cyber Security": "Security",
  "Ethical Hacking": "Security",

  // Enterprise
  SAP: "Enterprise",
  SalesForce: "Enterprise",
  ServiceNow: "Enterprise",
  Pega: "Enterprise",
  "Dynamics 365": "Enterprise",

  // Management
  "Program Manager": "Management",
  "Technical Program Manager": "Management",
  "Product Manager": "Management",
  "Scrum Master": "Management",
  "Project Manager": "Management",
  "Business Analyst": "Management",

  // Emerging
  Blockchain: "Emerging",
  "Prompt Engineer": "Emerging",
};

// ===========================
// Cluster Similarity Matrix
// ===========================
const CLUSTER_SIMILARITY = {
  "Core|Core": 1.0,
  "Core|Infra": 0.85,
  "Core|Data": 0.8,
  "Core|QA": 0.75,
  "Core|Security": 0.8,
  "Core|Enterprise": 0.7,
  "Core|Management": 0.6,
  "Core|Emerging": 0.75,

  "Data|Data": 1.0,
  "Data|Infra": 0.85,
  "Data|Security": 0.75,
  "Data|Enterprise": 0.65,
  "Data|Management": 0.6,
  "Data|Emerging": 0.85,

  "Infra|Infra": 1.0,
  "Infra|Security": 0.9,
  "Infra|QA": 0.75,
  "Infra|Management": 0.65,

  "Security|Security": 1.0,
  "QA|QA": 1.0,
  "Enterprise|Enterprise": 1.0,
  "Management|Management": 1.0,
  "Emerging|Emerging": 1.0,
};

function getProfileSimilarity(jdProfile, resumeProfile) {
  const jdCluster = PROFILE_CLUSTER[jdProfile];
  const resumeCluster = PROFILE_CLUSTER[resumeProfile];

  if (!jdCluster || !resumeCluster) return 0.6;
  if (jdCluster === resumeCluster) return 1.0;

  return (
    CLUSTER_SIMILARITY[`${jdCluster}|${resumeCluster}`] ||
    CLUSTER_SIMILARITY[`${resumeCluster}|${jdCluster}`] ||
    0.6
  );
}

// ===========================
// Recency Factor
// ===========================
export function computeRecencyFactor(monthsSince) {
  if (monthsSince == null) return 0.6;
  if (monthsSince <= 6) return 1.0;
  if (monthsSince <= 12) return 0.9;
  if (monthsSince <= 24) return 0.75;
  if (monthsSince <= 48) return 0.6;
  return 0.4;
}

// ===========================
// Duration Factor
// ===========================
export function computeDurationFactor(durationMonths) {
  if (durationMonths == null) return 1.0;
  const totalYears = durationMonths / 12;
  const bonus = Math.min(0.15, totalYears * 0.03);
  return Math.round((1 + bonus) * 10000) / 10000;
}

// ===========================
// Parse Date Helpers
// ===========================
function parseDate(dateStr) {
  if (!dateStr) return null;
  if (dateStr.toLowerCase() === "present") return new Date();
  const parts = dateStr.split("-");
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1);
}

function monthDiff(start, end) {
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
}

function monthsSince(dateObj) {
  const now = new Date();
  return (now.getFullYear() - dateObj.getFullYear()) * 12 + (now.getMonth() - dateObj.getMonth());
}

// ===========================
// Add Time Factors to entries
// ===========================
export function addTimeFactors(entries) {
  const today = new Date();

  for (const entry of entries) {
    const startStr = entry.start_date;
    const endStr = entry.end_date;

    if (startStr && endStr) {
      const startDate = parseDate(startStr);
      const endDate = parseDate(endStr);
      const duration = monthDiff(startDate, endDate);
      const since = monthsSince(endDate);
      entry.duration_months = duration;
      entry.months_since_end = since;
      entry.recency_factor = computeRecencyFactor(since);
      entry.duration_factor = computeDurationFactor(duration);
    } else if (endStr && !startStr) {
      const endDate = parseDate(endStr);
      const since = monthsSince(endDate);
      entry.duration_months = null;
      entry.months_since_end = since;
      entry.recency_factor = computeRecencyFactor(since);
      entry.duration_factor = 1.0;
    } else if (startStr && !endStr) {
      const startDate = parseDate(startStr);
      const duration = monthDiff(startDate, today);
      entry.duration_months = duration;
      entry.months_since_end = 0;
      entry.recency_factor = 1.0;
      entry.duration_factor = computeDurationFactor(duration);
    } else {
      entry.duration_months = null;
      entry.months_since_end = null;
      entry.recency_factor = 0.6;
      entry.duration_factor = 1.0;
    }
  }

  return entries;
}

// ===========================
// Main Overall Score Calculator
// ===========================
export function calculateOverallScore(comparisons) {
  const jdSkillBestScores = {};
  let totalImportance = 0;

  for (const profile of comparisons) {
    const jdProfile = profile.JD_profile;
    const resumeProfile = profile.Resume_profile;
    const profileWeight = getProfileSimilarity(jdProfile, resumeProfile);

    for (const skill of profile.matched_skills) {
      const jdSkill = skill.JDskill;
      const importance = skill.JD_importance_score;

      if (!jdSkillBestScores[jdSkill]) {
        jdSkillBestScores[jdSkill] = {
          importance,
          best_score: 0,
        };
        totalImportance += importance;
      }

      if (!skill.matched_resume_skills || skill.matched_resume_skills.length === 0) {
        continue;
      }

      const bestResumeMatch = skill.matched_resume_skills.reduce((best, curr) =>
        curr.impact_score_max > best.impact_score_max ? curr : best
      );

      const matchWeight = MATCH_WEIGHT[bestResumeMatch.match_strength] || 0;
      const impactNormalized = bestResumeMatch.impact_score_max / 10;

      const skillScore =
        importance * (0.5 * matchWeight + 0.5 * impactNormalized) * profileWeight;

      jdSkillBestScores[jdSkill].best_score = Math.max(
        jdSkillBestScores[jdSkill].best_score,
        skillScore
      );
    }
  }

  const totalScore = Object.values(jdSkillBestScores).reduce(
    (sum, s) => sum + s.best_score,
    0
  );

  const overallPercentage =
    totalImportance > 0 ? (totalScore / totalImportance) * 100 : 0;

  return {
    overallPercentage: Math.round(overallPercentage * 100) / 100,
    totalScore: Math.round(totalScore * 100) / 100,
    totalImportance,
  };
}

// ===========================
// Verdict from percentage
// ===========================
export function getVerdict(percentage) {
  if (percentage >= 75) return "Strong";
  if (percentage >= 50) return "Moderate";
  if (percentage >= 30) return "Weak";
  return "Poor";
}

export { PROFILE_CLUSTER };
