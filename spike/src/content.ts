// Throwaway spike: injects a "Run spike probes" button on Qlik Sense app pages,
// runs the probes and downloads the JSON report.
import { parseAppLocation, runProbes, type SpikeReport } from "./probes";

const BUTTON_ID = "qlik-git-spike-button";
const LABEL = "Run spike probes";

let running = false;

function downloadReport(report: SpikeReport): void {
  const json = JSON.stringify(report, null, 2);
  // Fallback in case the download is blocked: the report is also in the console.
  console.log("[qlik-git-spike] report", json);
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `spike-report-${stamp}.json`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function createButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.textContent = LABEL;
  Object.assign(button.style, {
    position: "fixed",
    left: "12px",
    bottom: "12px",
    zIndex: "2147483647",
    padding: "8px 14px",
    font: "13px/1.2 sans-serif",
    color: "#fff",
    background: "#1f6feb",
    border: "none",
    borderRadius: "6px",
    boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
    cursor: "pointer",
  });
  button.addEventListener("click", () => void onClick(button));
  return button;
}

async function onClick(button: HTMLButtonElement): Promise<void> {
  if (running) return;
  const loc = parseAppLocation(location);
  if (!loc) return;
  running = true;
  button.disabled = true;
  button.style.cursor = "wait";
  const setLabel = (text: string) => {
    button.textContent = text;
  };
  let report: SpikeReport;
  try {
    report = await runProbes(loc, setLabel);
  } catch (e) {
    // runProbes catches per probe; this only guards against a bug in the runner itself.
    report = {
      server: loc.host,
      virtualProxyPrefix: loc.prefix,
      appId: loc.appId,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      probes: [
        {
          id: "runner",
          question: "Did the probe runner itself complete?",
          ok: false,
          detail: `runner error: ${e instanceof Error ? e.message : String(e)}`,
          evidence: { stack: e instanceof Error ? e.stack : null },
          durationMs: 0,
        },
      ],
    };
  }
  try {
    downloadReport(report);
    const passed = report.probes.filter((p) => p.ok).length;
    setLabel(`Done: ${passed}/${report.probes.length} ok, report downloaded`);
  } catch (e) {
    setLabel(`Download failed, see console: ${e instanceof Error ? e.message : String(e)}`);
  }
  running = false;
  button.disabled = false;
  button.style.cursor = "pointer";
  setTimeout(() => {
    if (!running) setLabel(LABEL);
  }, 10_000);
}

/** Shows the button on app pages only. The Qlik client is a single-page app, so this is polled. */
function sync(): void {
  const existing = document.getElementById(BUTTON_ID);
  const onAppPage = parseAppLocation(location) !== null;
  if (onAppPage && !existing && document.body) {
    document.body.appendChild(createButton());
  } else if (!onAppPage && existing && !running) {
    existing.remove();
  }
}

sync();
setInterval(sync, 1_000);
window.addEventListener("popstate", sync);
