import { useState } from "react";

// ─── UI atoms ───

const ScoreBadge = ({ score }) => {
  const c =
    score >= 4
      ? { bg: "#e8f5e9", co: "#2e7d32", l: "Strong" }
      : score >= 3
      ? { bg: "#fff8e1", co: "#f57f17", l: "Moderate" }
      : { bg: "#fce4ec", co: "#c62828", l: "Weak" };
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700,
        background: c.bg, color: c.co,
      }}
    >
      {score}/5 <span style={{ fontWeight: 500 }}>{c.l}</span>
    </span>
  );
};

const VerdictBadge = ({ verdict }) => {
  const c =
    {
      STRONG: { bg: "#e8f5e9", co: "#1b5e20", bd: "#a5d6a7" },
      MODERATE: { bg: "#fff8e1", co: "#e65100", bd: "#ffe082" },
      WEAK: { bg: "#fff3e0", co: "#bf360c", bd: "#ffcc80" },
      POOR: { bg: "#fce4ec", co: "#b71c1c", bd: "#ef9a9a" },
    }[verdict] || { bg: "#f5f5f5", co: "#333", bd: "#ccc" };
  return (
    <span
      style={{
        display: "inline-block", padding: "4px 14px", borderRadius: 6,
        fontSize: 13, fontWeight: 800, letterSpacing: 1.2,
        background: c.bg, color: c.co, border: `1.5px solid ${c.bd}`,
      }}
    >
      {verdict}
    </span>
  );
};

const Bar = ({ score }) => {
  const pct = (score / 5) * 100;
  const co = score >= 4 ? "#43a047" : score >= 3 ? "#fb8c00" : "#e53935";
  return (
    <div style={{ width: "100%", height: 6, borderRadius: 3, background: "#1a1a2e", overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", borderRadius: 3, background: co, transition: "width 0.8s ease" }} />
    </div>
  );
};

// ─── Main App ───

export default function App() {
  const [jdFiles, setJdFiles] = useState([]);
  const [profileFiles, setProfileFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [activeJd, setActiveJd] = useState(0);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [serverOk, setServerOk] = useState(null);

  // Check server health on first render
  useState(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setServerOk(d.hasApiKey))
      .catch(() => setServerOk(false));
  });

  const handleJdChange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) setJdFiles((prev) => [...prev, ...files].slice(0, 5));
    e.target.value = "";
  };

  const handleProfileChange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) setProfileFiles((prev) => [...prev, ...files].slice(0, 10));
    e.target.value = "";
  };

  const removeJd = (i) => setJdFiles((prev) => prev.filter((_, j) => j !== i));
  const removeProfile = (i) => setProfileFiles((prev) => prev.filter((_, j) => j !== i));

  // ─── Evaluation via backend ───
  const runEvaluation = async () => {
    if (jdFiles.length === 0 || profileFiles.length === 0) {
      setError("Upload at least one JD and one interviewer profile.");
      return;
    }
    setError("");
    setLoading(true);
    setShowResults(false);

    const newResults = [...results];
    const startIdx = newResults.length;

    for (let p = 0; p < profileFiles.length; p++) {
      const pf = profileFiles[p];
      setProgress(`Evaluating interviewer ${p + 1}/${profileFiles.length}: ${pf.name}...`);

      try {
        const formData = new FormData();
        // Add all JDs
        for (const jd of jdFiles) {
          formData.append("jds", jd);
        }
        // Add this profile
        formData.append("profile", pf);

        const resp = await fetch("/api/evaluate", {
          method: "POST",
          body: formData,
        });

        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `Server error ${resp.status}`);

        newResults.push({ file: pf.name, result: data.result, error: null });
      } catch (err) {
        newResults.push({ file: pf.name, result: null, error: err.message });
      }
      setResults([...newResults]);
    }

    setActiveIdx(startIdx);
    setActiveJd(0);
    setProfileFiles([]);
    setShowResults(true);
    setLoading(false);
    setProgress("");
  };

  const resetAll = () => {
    setJdFiles([]); setProfileFiles([]); setResults([]); setShowResults(false);
    setActiveIdx(0); setActiveJd(0); setError(""); setProgress("");
  };

  const cur = results[activeIdx];

  return (
    <div style={{ minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ padding: "20px 28px 14px", borderBottom: "1px solid #1a1a35", background: "linear-gradient(135deg, #0c0c1d, #141432)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 980, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, color: "#fff", fontFamily: "'Space Mono', monospace" }}>iv</div>
            <div>
              <h1 style={{ fontSize: 19, fontWeight: 700, color: "#f0f0f0", fontFamily: "'Space Mono', monospace" }}>Interviewer Fit Evaluator</h1>
              <p style={{ fontSize: 11, color: "#555" }}>Intervue.io Supply Ops — AI-powered interviewer-JD matching</p>
            </div>
          </div>
          {serverOk !== null && (
            <span style={{ fontSize: 11, color: serverOk ? "#66bb6a" : "#ef5350" }}>
              {serverOk ? "● Server connected" : "● Server not connected"}
            </span>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "20px 20px 60px" }}>
        {/* ═══ UPLOAD SECTION ═══ */}
        {!showResults && (
          <div style={{ animation: "slideUp 0.3s ease" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
              {/* JDs */}
              <div style={{ background: "#12122a", border: "1px solid #1e1e40", borderRadius: 14, padding: 20 }}>
                <h2 style={{ fontSize: 14, fontWeight: 700, color: "#c4b5fd", fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>Job Descriptions</h2>
                <p style={{ fontSize: 11, color: "#555", marginBottom: 14 }}>Up to 5 files (.pdf, .txt, .docx)</p>
                <div className="upload-zone" style={{ marginBottom: jdFiles.length > 0 ? 10 : 0 }}>
                  <input type="file" multiple accept=".pdf,.txt,.docx,.doc" onChange={handleJdChange} />
                  <p style={{ fontSize: 12, color: "#666" }}>📄 {jdFiles.length === 0 ? "Click to select JDs" : "+ Add more JDs"}</p>
                </div>
                {jdFiles.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {jdFiles.map((f, i) => (
                      <div key={`jd-${i}-${f.name}`} className="file-chip">
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <span style={{ width: 20, height: 20, borderRadius: 5, background: "#6366f120", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#a5b4fc", fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
                          <span className="name">{f.name}</span>
                          <span className="size">({(f.size / 1024).toFixed(0)}KB)</span>
                        </div>
                        <button className="rm" onClick={() => removeJd(i)}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Profiles */}
              <div style={{ background: "#12122a", border: "1px solid #1e1e40", borderRadius: 14, padding: 20 }}>
                <h2 style={{ fontSize: 14, fontWeight: 700, color: "#c4b5fd", fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>Interviewer Profiles</h2>
                <p style={{ fontSize: 11, color: "#555", marginBottom: 14 }}>Up to 10 CVs / LinkedIn PDFs</p>
                <div className="upload-zone" style={{ marginBottom: profileFiles.length > 0 ? 10 : 0 }}>
                  <input type="file" multiple accept=".pdf,.txt,.docx,.doc" onChange={handleProfileChange} />
                  <p style={{ fontSize: 12, color: "#666" }}>👤 {profileFiles.length === 0 ? "Click to select profiles" : "+ Add more profiles"}</p>
                </div>
                {profileFiles.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {profileFiles.map((f, i) => (
                      <div key={`pf-${i}-${f.name}`} className="file-chip">
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <span style={{ width: 20, height: 20, borderRadius: 5, background: "#8b5cf620", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#c4b5fd", fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
                          <span className="name">{f.name}</span>
                          <span className="size">({(f.size / 1024).toFixed(0)}KB)</span>
                        </div>
                        <button className="rm" onClick={() => removeProfile(i)}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Status */}
            <div style={{ fontSize: 12, color: "#555", marginBottom: 12, display: "flex", gap: 16 }}>
              <span>{jdFiles.length} JD{jdFiles.length !== 1 ? "s" : ""} selected</span>
              <span>{profileFiles.length} interviewer{profileFiles.length !== 1 ? "s" : ""} selected</span>
              {results.length > 0 && <span style={{ color: "#66bb6a" }}>✓ {results.length} previously evaluated</span>}
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={runEvaluation} disabled={jdFiles.length === 0 || profileFiles.length === 0 || loading}
                style={{
                  flex: 1, padding: "14px 24px", borderRadius: 12, border: "none",
                  background: (jdFiles.length > 0 && profileFiles.length > 0 && !loading) ? "linear-gradient(135deg, #6366f1, #8b5cf6)" : "#1e1e40",
                  color: (jdFiles.length > 0 && profileFiles.length > 0) ? "#fff" : "#555",
                  fontSize: 14, fontWeight: 700, cursor: loading ? "wait" : "pointer",
                  fontFamily: "'Space Mono', monospace", opacity: loading ? 0.7 : 1, transition: "all 0.3s",
                }}>
                {loading ? progress : `Evaluate ${profileFiles.length} Interviewer${profileFiles.length !== 1 ? "s" : ""} against ${jdFiles.length} JD${jdFiles.length !== 1 ? "s" : ""} →`}
              </button>
              {results.length > 0 && (
                <button onClick={() => setShowResults(true)} style={{
                  padding: "14px 20px", borderRadius: 12, border: "1px solid #6366f1",
                  background: "transparent", color: "#a5b4fc", fontSize: 13, fontWeight: 600,
                  cursor: "pointer", fontFamily: "'Space Mono', monospace",
                }}>View Results ({results.length})</button>
              )}
            </div>

            {error && (
              <div style={{ marginTop: 12, padding: "12px 16px", background: "#2d1020", borderRadius: 10, border: "1px solid #5c2030", fontSize: 13, color: "#ef9a9a" }}>{error}</div>
            )}

            {loading && (
              <div style={{ marginTop: 14, padding: "12px 16px", background: "#1a1a38", borderRadius: 10, border: "1px solid #252550" }}>
                <div style={{ width: "100%", height: 4, borderRadius: 2, background: "#0e0e22", marginBottom: 8, overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 2, background: "linear-gradient(90deg, #6366f1, #8b5cf6)", transition: "width 0.5s ease", width: "30%" }} />
                </div>
                <p style={{ textAlign: "center", animation: "pulse 1.5s ease infinite", fontSize: 12, color: "#a5b4fc" }}>{progress}</p>
              </div>
            )}
          </div>
        )}

        {/* ═══ RESULTS ═══ */}
        {showResults && results.length > 0 && (
          <div style={{ animation: "slideUp 0.3s ease" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "#6366f1", fontWeight: 600 }}>📄 {jdFiles.length} JD{jdFiles.length !== 1 ? "s" : ""}</span>
                <span style={{ color: "#2a2a50" }}>|</span>
                <span style={{ fontSize: 12, color: "#8b5cf6", fontWeight: 600 }}>👤 {results.length} evaluated</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setShowResults(false)} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #6366f1", background: "transparent", color: "#a5b4fc", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ Evaluate More</button>
                <button onClick={resetAll} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #ef5350", background: "transparent", color: "#ef9a9a", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Start Fresh</button>
              </div>
            </div>

            {/* Interviewer cards */}
            <div style={{ display: "flex", gap: 8, marginBottom: 20, overflowX: "auto", paddingBottom: 4 }}>
              {results.map((r, i) => {
                const active = i === activeIdx;
                const name = r.result?.interviewer?.name || r.file.replace(/\.[^.]+$/, "");
                const avg = r.result ? (r.result.evaluations.reduce((a, e) => a + e.overallScore, 0) / r.result.evaluations.length).toFixed(1) : null;
                const best = r.result ? r.result.evaluations.reduce((b, e) => {
                  const o = { STRONG: 4, MODERATE: 3, WEAK: 2, POOR: 1 };
                  return (o[e.verdict] || 0) > (o[b] || 0) ? e.verdict : b;
                }, "POOR") : null;
                return (
                  <button key={i} onClick={() => { setActiveIdx(i); setActiveJd(0); }} style={{
                    minWidth: 170, padding: "12px 14px", borderRadius: 12,
                    border: `1.5px solid ${active ? "#6366f1" : "#1e1e40"}`,
                    background: active ? "#1a1040" : "#12122a",
                    cursor: "pointer", textAlign: "left", flexShrink: 0,
                  }}>
                    <p style={{ fontSize: 12, fontWeight: 700, color: active ? "#e0e0f0" : "#888", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</p>
                    {r.error ? <span style={{ fontSize: 11, color: "#ef5350" }}>Error</span> : (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 17, fontWeight: 800, color: avg >= 4 ? "#43a047" : avg >= 3 ? "#fb8c00" : "#e53935" }}>{avg}</span>
                        <span style={{ fontSize: 10, color: "#555" }}>avg</span>
                        {best && <VerdictBadge verdict={best} />}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {cur?.error && (
              <div style={{ padding: "14px 18px", background: "#2d1020", borderRadius: 12, border: "1px solid #5c2030", marginBottom: 20 }}>
                <p style={{ fontSize: 13, color: "#ef9a9a" }}>Failed: {cur.error}</p>
              </div>
            )}

            {cur?.result && (() => {
              const r = cur.result;
              return (
                <>
                  <div style={{ background: "linear-gradient(135deg, #1a1040, #12122a)", border: "1px solid #2a2060", borderRadius: 14, padding: 22, marginBottom: 18 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
                      <div>
                        <p style={{ fontSize: 10, color: "#8b5cf6", fontWeight: 700, letterSpacing: 1.5, marginBottom: 4 }}>INTERVIEWER</p>
                        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f0f0f0", marginBottom: 2 }}>{r.interviewer.name}</h2>
                        <p style={{ fontSize: 12, color: "#888" }}>{r.interviewer.currentRole}</p>
                        <p style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{r.interviewer.totalExperience}</p>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <p style={{ fontSize: 10, color: "#6366f1", fontWeight: 600, marginBottom: 3 }}>PRIMARY</p>
                        <p style={{ fontSize: 11, color: "#c4b5fd", background: "#6366f115", padding: "3px 8px", borderRadius: 5, display: "inline-block", marginBottom: 5 }}>{r.interviewer.primaryProfile}</p>
                        <p style={{ fontSize: 10, color: "#6366f1", fontWeight: 600, marginBottom: 3 }}>SECONDARY</p>
                        <p style={{ fontSize: 11, color: "#c4b5fd", background: "#6366f115", padding: "3px 8px", borderRadius: 5, display: "inline-block" }}>{r.interviewer.secondaryProfile}</p>
                      </div>
                    </div>
                    {r.interviewer.coreStrengths && (
                      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {r.interviewer.coreStrengths.map((s, i) => (
                          <span key={i} style={{ padding: "2px 8px", borderRadius: 16, fontSize: 10, background: "#1e1e40", color: "#a0a0c0", border: "1px solid #2a2a50" }}>{s}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", gap: 4, marginBottom: 2, overflowX: "auto" }}>
                    {r.evaluations.map((ev, i) => (
                      <button key={i} onClick={() => setActiveJd(i)} style={{
                        padding: "8px 16px", borderRadius: "8px 8px 0 0", border: "1px solid",
                        borderBottom: "none", fontSize: 11, fontWeight: 600, cursor: "pointer",
                        fontFamily: "'Space Mono', monospace", whiteSpace: "nowrap",
                        background: activeJd === i ? "#12122a" : "transparent",
                        borderColor: activeJd === i ? "#1e1e40" : "transparent",
                        color: activeJd === i ? "#c4b5fd" : "#555",
                      }}>
                        JD {i + 1}: {ev.jdTitle?.slice(0, 26)}{ev.jdTitle?.length > 26 ? "…" : ""}
                      </button>
                    ))}
                  </div>

                  {r.evaluations[activeJd] && (() => {
                    const ev = r.evaluations[activeJd];
                    return (
                      <div style={{ background: "#12122a", border: "1px solid #1e1e40", borderRadius: "0 12px 12px 12px", padding: 22, marginBottom: 18 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
                          <div>
                            <h3 style={{ fontSize: 16, fontWeight: 700, color: "#e0e0e0" }}>{ev.jdTitle}</h3>
                            <p style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{ev.company}</p>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span style={{ fontSize: 26, fontWeight: 800, color: ev.overallScore >= 4 ? "#43a047" : ev.overallScore >= 3 ? "#fb8c00" : "#e53935" }}>
                              {ev.overallScore}<span style={{ fontSize: 13, color: "#555" }}>/5</span>
                            </span>
                            <VerdictBadge verdict={ev.verdict} />
                          </div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
                          {ev.scores?.map((s, i) => (
                            <div key={i} style={{ padding: "10px 14px", background: "#0e0e22", borderRadius: 9, border: "1px solid #1a1a35" }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                                <span style={{ fontSize: 12, fontWeight: 600, color: "#c0c0d0" }}>{s.requirement}</span>
                                <ScoreBadge score={s.score} />
                              </div>
                              <Bar score={s.score} />
                              <p style={{ fontSize: 11, color: "#777", marginTop: 5, lineHeight: 1.5 }}>{s.assessment}</p>
                            </div>
                          ))}
                        </div>
                        <div style={{ padding: "12px 16px", background: "#0e0e22", borderRadius: 9, border: "1px solid #1a1a35", marginBottom: 10 }}>
                          <p style={{ fontSize: 10, color: "#6366f1", fontWeight: 700, letterSpacing: 1, marginBottom: 5 }}>SUMMARY</p>
                          <p style={{ fontSize: 12, color: "#aaa", lineHeight: 1.6 }}>{ev.summary}</p>
                        </div>
                        {ev.canInterviewFor && (
                          <div style={{ padding: "12px 16px", background: "#101028", borderRadius: 9, border: "1px solid #1e1e40" }}>
                            <p style={{ fontSize: 10, color: "#8b5cf6", fontWeight: 700, letterSpacing: 1, marginBottom: 5 }}>CAN INTERVIEW FOR</p>
                            <p style={{ fontSize: 12, color: "#aaa", lineHeight: 1.6 }}>{ev.canInterviewFor}</p>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  <div style={{ background: "linear-gradient(135deg, #0e1a0e, #12122a)", border: "1px solid #1e3a1e", borderRadius: 14, padding: 22, marginBottom: 18 }}>
                    <p style={{ fontSize: 10, color: "#66bb6a", fontWeight: 700, letterSpacing: 1.5, marginBottom: 6 }}>RECOMMENDATION</p>
                    <p style={{ fontSize: 13, color: "#c0c0d0", lineHeight: 1.7 }}>{r.recommendation}</p>
                  </div>

                  {r.idealInterviewerProfile && (
                    <div style={{ background: "#12122a", border: "1px solid #1e1e40", borderRadius: 14, padding: 22, marginBottom: 18 }}>
                      <p style={{ fontSize: 10, color: "#6366f1", fontWeight: 700, letterSpacing: 1.5, marginBottom: 6 }}>IDEAL INTERVIEWER PROFILE</p>
                      <p style={{ fontSize: 12, color: "#999", lineHeight: 1.6 }}>{r.idealInterviewerProfile}</p>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
