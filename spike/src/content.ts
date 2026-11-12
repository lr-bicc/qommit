// Throwaway spike: injects a "Run spike probes" button on Qlik Sense app pages,
// runs the probes and downloads the JSON report.
import { parseAppLocation, runProbes, type SpikeReport } from "./probes";

const CONTAINER_ID = "qlik-git-spike";
const LABEL = "Run spike probes";
const DOSAVE_LABEL = "Include DoSave probe (P7)";
const NEWAPP_LABEL = "Include new-app probe (P9)";

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

function createControls(): HTMLDivElement {
  const container = document.createElement("div");
  container.id = CONTAINER_ID;
  Object.assign(container.style, {
    position: "fixed",
    left: "12px",
    bottom: "12px",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "6px 10px",
    background: "rgba(255,255,255,0.95)",
    borderRadius: "8px",
    boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
    font: "13px/1.2 sans-serif",
    color: "#222",
  });

  const option = (text: string, checked: boolean) => {
    const label = document.createElement("label");
    Object.assign(label.style, { display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" });
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    label.append(checkbox, document.createTextNode(text));
    return { label, checkbox };
  };
  const doSave = option(DOSAVE_LABEL, false);
  const newApp = option(NEWAPP_LABEL, true);

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = LABEL;
  Object.assign(button.style, {
    padding: "8px 14px",
    font: "13px/1.2 sans-serif",
    color: "#fff",
    background: "#1f6feb",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
  });
  button.addEventListener("click", () => void onClick(button, doSave.checkbox, newApp.checkbox));

  container.append(button, doSave.label, newApp.label);
  return container;
}

async function onClick(button: HTMLButtonElement, doSaveBox: HTMLInputElement, newAppBox: HTMLInputElement): Promise<void> {
  if (running) return;
  const loc = parseAppLocation(location);
  if (!loc) return;
  const includeDoSave = doSaveBox.checked;
  const includeNewApp = newAppBox.checked;
  running = true;
  button.disabled = true;
  doSaveBox.disabled = true;
  newAppBox.disabled = true;
  button.style.cursor = "wait";
  const setLabel = (text: string) => {
    button.textContent = text;
  };
  let report: SpikeReport;
  try {
    report = await runProbes(loc, setLabel, { includeDoSave, includeNewApp });
  } catch (e) {
    // runProbes catches per probe; this only guards against a bug in the runner itself.
    report = {
      server: loc.host,
      virtualProxyPrefix: loc.prefix,
      appId: loc.appId,
      includeDoSave,
      includeNewApp,
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
  doSaveBox.disabled = false;
  newAppBox.disabled = false;
  button.style.cursor = "pointer";
  setTimeout(() => {
    if (!running) setLabel(LABEL);
  }, 10_000);
}

/** Shows the button on app pages only. The Qlik client is a single-page app, so this is polled. */
function sync(): void {
  const existing = document.getElementById(CONTAINER_ID);
  const onAppPage = parseAppLocation(location) !== null;
  if (onAppPage && !existing && document.body) {
    document.body.appendChild(createControls());
  } else if (!onAppPage && existing && !running) {
    existing.remove();
  }
}

sync();
setInterval(sync, 1_000);
window.addEventListener("popstate", sync);
