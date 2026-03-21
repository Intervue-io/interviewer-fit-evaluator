import { useState, useRef, useEffect, useCallback } from "react";

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function getVerdictColor(verdict) {
  if (verdict === "Strong") return "strong";
  if (verdict === "Moderate") return "moderate";
  if (verdict === "Weak") return "weak";
  return "poor";
}

function formatTime() {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export default function App() {
  const [jdFiles, setJdFiles] = useState([]);
  const [interviewerFiles, setInterviewerFiles] = useState([]);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [progressLog, setProgressLog] = useState([]);
  const [results, setResults] = useState(null);
  const [parsedJDs, setParsedJDs] = useState(null);
  const [streamResults, setStreamResults] = useState([]);
  const [hasEvaluated, setHasEvaluated] = useState(false);

  const jdInputRef = useRef(null);
  const intInputRef = useRef(null);
  const logEndRef = useRef(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [progressLog]);

  const addLog = useCallback((msg) => {
    setProgressLog((prev) => [...prev, { time: formatTime(), msg }]);
  }, []);

  const handleJDFiles = (e) => {
    const files = Array.from(e.target.files);
    setJdFiles((prev) => [...prev, ...files].slice(0, 5));
    e.target.value = "";
  };

  const handleInterviewerFiles = (e) => {
    const files = Array.from(e.target.files);
    setInterviewerFiles((prev) => [...prev, ...files].slice(0, 10));
    e.target.value = "";
  };

  const removeJD = (idx) => setJdFiles((prev) => prev.filter((_, i) => i !== idx));
  const removeInterviewer = (idx) => setInterviewerFiles((prev) => prev.filter((_, i) => i !== idx));

  const handleEvaluate = async () => {
    if (jdFiles.length === 0 && !parsedJDs) return;
    if (interviewerFiles.length === 0) return;

    setIsEvaluating(true);
    setProgressLog([]);
    setStreamResults([]);
    setResults(null);
    addLog("Starting evaluation pipeline...");

    const formData = new FormData();

    if (parsedJDs) {
      formData.append("parsedJDs", JSON.stringify(parsedJDs));
    }

    for (const file of jdFiles) formData.append("jds", file);
    for (const file of interviewerFiles) formData.append("interviewers", file);

    try {
      const response = await fetch("/api/evaluate", { method: "POST", body: formData });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6);
          if (!jsonStr.trim()) continue;

          try {
            const event = JSON.parse(jsonStr);

            switch (event.type) {
              case "progress":
                addLog(event.message);
                break;
              case "jds_parsed":
                addLog(`JDs parsed: ${event.jds.map((j) => `${j.filename} (${j.jdProfile}, ${j.mustHaveCount}M / ${j.goodToHaveCount}G)`).join("; ")}`);
                break;
              case "interviewer_complete":
                addLog(`✓ ${event.result.interviewerName} — ${event.result.jdResults.map((r) => `${r.verdict} ${r.overallPercentage}%`).join(", ")} [${event.result.processingTime}]`);
                setStreamResults((prev) => [...prev, event.result]);
                break;
              case "interviewer_error":
                addLog(`✗ Error: ${event.filename} — ${event.error}`);
                setStreamResults((prev) => [...prev, { interviewerFile: event.filename, interviewerName: "Error", error: event.error, jdResults: [], profiles: [] }]);
                break;
              case "complete":
                addLog("Evaluation complete.");
                setResults(event.results);
                setParsedJDs(event.parsedJDs);
                setHasEvaluated(true);
                break;
              case "error":
                addLog(`Error: ${event.message}`);
                break;
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      addLog(`Fatal error: ${err.message}`);
    }

    setIsEvaluating(false);
  };

  const handleEvaluateMore = () => {
    setInterviewerFiles([]);
    setStreamResults([]);
    setResults(null);
    setProgressLog([]);
  };

  const handleStartFresh = () => {
    setJdFiles([]);
    setInterviewerFiles([]);
    setResults(null);
    setParsedJDs(null);
    setStreamResults([]);
    setProgressLog([]);
    setHasEvaluated(false);
  };

  const displayResults = results || (streamResults.length > 0 ? streamResults : null);

  return (
    <div className="app-container">
      {/* Header with Intervue Logo */}
      <header className="app-header">
        <div className="header-logo-row">
          <img src="/intervue-logo.svg" alt="Intervue" className="intervue-logo" />
          <h1>
            Interviewer Fit Evaluator
            <span className="version-badge">v3</span>
          </h1>
        </div>
        <div className="header-subtitle">
          <p>LinkedIn profile ↔ JD skill matching</p>
          <span className="pipeline-badge">4-call pipeline</span>
        </div>
      </header>

      {/* Upload Section */}
      <div className="upload-section">
        <div className="upload-card">
          <h2>Job Descriptions</h2>
          <p className="upload-subtitle">
            Upload up to 5 JDs (.pdf, .txt, .docx)
            {parsedJDs && (
              <span style={{ color: "var(--intervue-green)", marginLeft: 8 }}>
                — {parsedJDs.length} JD{parsedJDs.length > 1 ? "s" : ""} already parsed
              </span>
            )}
          </p>
          <div
            className={`file-drop-zone ${jdFiles.length > 0 || parsedJDs ? "has-files" : ""}`}
            onClick={() => jdInputRef.current?.click()}
          >
            <input ref={jdInputRef} type="file" multiple accept=".pdf,.txt,.docx" onChange={handleJDFiles} />
            <p>{jdFiles.length === 0 && !parsedJDs ? "Click to upload JD files" : "Click to add more JDs"}</p>
          </div>

          {parsedJDs && (
            <div className="file-list">
              {parsedJDs.map((jd, i) => (
                <div key={`parsed-${i}`} className="file-item">
                  <span className="file-name">✓ {jd.filename}</span>
                  <span className="file-size">{jd.jdProfile} · {jd.mustHaveCount}M / {jd.goodToHaveCount}G</span>
                </div>
              ))}
            </div>
          )}

          {jdFiles.length > 0 && (
            <div className="file-list">
              {jdFiles.map((file, i) => (
                <div key={i} className="file-item">
                  <span className="file-name">{file.name}</span>
                  <span className="file-size">{formatFileSize(file.size)}</span>
                  <button className="remove-btn" onClick={() => removeJD(i)}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="upload-card">
          <h2>Interviewer Profiles</h2>
          <p className="upload-subtitle">Upload up to 10 LinkedIn PDFs (.pdf, .txt, .docx)</p>
          <div
            className={`file-drop-zone ${interviewerFiles.length > 0 ? "has-files" : ""}`}
            onClick={() => intInputRef.current?.click()}
          >
            <input ref={intInputRef} type="file" multiple accept=".pdf,.txt,.docx" onChange={handleInterviewerFiles} />
            <p>{interviewerFiles.length === 0 ? "Click to upload LinkedIn PDFs" : "Click to add more interviewers"}</p>
          </div>

          {interviewerFiles.length > 0 && (
            <div className="file-list">
              {interviewerFiles.map((file, i) => (
                <div key={i} className="file-item">
                  <span className="file-name">{file.name}</span>
                  <span className="file-size">{formatFileSize(file.size)}</span>
                  <button className="remove-btn" onClick={() => removeInterviewer(i)}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="button-row">
        <button
          className="btn-primary"
          disabled={isEvaluating || (jdFiles.length === 0 && !parsedJDs) || interviewerFiles.length === 0}
          onClick={handleEvaluate}
        >
          {isEvaluating && <span className="spinner" />}
          {isEvaluating ? "Evaluating..." : "Evaluate Fit"}
        </button>

        {hasEvaluated && !isEvaluating && (
          <>
            <button className="btn-secondary" onClick={handleEvaluateMore}>Evaluate More</button>
            <button className="btn-secondary" onClick={handleStartFresh}>Start Fresh</button>
          </>
        )}
      </div>

      {/* Progress Log */}
      {progressLog.length > 0 && (
        <div className="progress-section">
          <h3>{isEvaluating && <span className="spinner" />}Pipeline Progress</h3>
          <div className="progress-log">
            {progressLog.map((entry, i) => (
              <div key={i} className="log-entry">
                <span className="log-time">{entry.time}</span>
                <span>{entry.msg}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {/* JD Skills Breakdown */}
      {parsedJDs && results && (
        <div className="jd-parsed-summary">
          <h3>JD Skills Breakdown</h3>
          {parsedJDs.map((jd, i) => (
            <div key={i} style={{ marginBottom: i < parsedJDs.length - 1 ? 16 : 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
                {jd.filename}
                <span style={{ color: "var(--text-muted)", fontWeight: 400, marginLeft: 8 }}>— {jd.jdProfile}</span>
              </div>
              <div className="jd-parsed-chips">
                {(jd.parsed?.must_have || []).map((s, j) => (
                  <span key={`m-${j}`} className="jd-chip must-have">{s.skill}</span>
                ))}
                {(jd.parsed?.good_to_have || []).map((s, j) => (
                  <span key={`g-${j}`} className="jd-chip good-to-have">{s.skill}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Results */}
      {displayResults && (
        <div className="results-section">
          <h2>Evaluation Results</h2>

          {(Array.isArray(displayResults) ? displayResults : []).map((result, i) => {
            if (result.error) {
              return (
                <div key={i} className="error-card">
                  <div className="error-title">{result.interviewerFile}</div>
                  <div className="error-msg">{result.error}</div>
                </div>
              );
            }

            return (
              <div key={i} className="interviewer-card">
                <div className="interviewer-header">
                  <div>
                    <span className="int-name">{result.interviewerName}</span>
                    <span className="int-meta">{result.interviewerFile}</span>
                    {result.processingTime && <span className="int-time">{result.processingTime}</span>}
                    {result.totalExperienceYears && (
                      <span className="int-meta"> · {result.totalExperienceYears}+ yrs exp</span>
                    )}
                  </div>
                  <div className="int-profiles">
                    {result.primaryProfile && (
                      <span className="int-profile">{result.primaryProfile}</span>
                    )}
                    {result.secondaryProfile && (
                      <span className="int-profile secondary">{result.secondaryProfile}</span>
                    )}
                    {!result.primaryProfile && (result.profiles || []).map((p, j) => (
                      <span key={j} className="int-profile">{p}</span>
                    ))}
                  </div>
                </div>

                <div className="jd-results-grid">
                  {(result.jdResults || []).map((jdResult, j) => {
                    const color = getVerdictColor(jdResult.verdict);
                    return (
                      <div key={j} className="jd-result-row">
                        <div className="jd-name">
                          {jdResult.jdFilename}
                          <span className="jd-profile-tag">{jdResult.jdProfile}</span>
                        </div>
                        <div className={`match-percentage ${color}`}>{jdResult.overallPercentage}%</div>
                        <span className={`verdict-badge verdict-${jdResult.verdict}`}>{jdResult.verdict}</span>
                        <div className="jd-summary">{jdResult.summary}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
