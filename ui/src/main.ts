import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  Circle,
  FileText,
  Film,
  FolderOpen,
  HardDriveDownload,
  LoaderCircle,
  Play,
  Settings2,
  Square,
  Terminal,
  createIcons,
} from "lucide";

type ConversionStatus = {
  status: "idle" | "running" | "complete" | "error";
  phase: string;
  message: string;
  outputPath?: string;
};

type ConversionLog = {
  stream: string;
  line: string;
};

type RuntimeStatus = {
  ready: boolean;
  message: string;
};

const phases = [
  ["setup", "Prepare runtime"],
  ["inspect", "Inspect source"],
  ["extract", "Extract audio"],
  ["transcribe", "Transcribe German"],
  ["filter", "Filter dialogue"],
  ["render", "Render segments"],
  ["stitch", "Stitch MP4"],
] as const;

const app = document.querySelector<HTMLDivElement>("#app")!;
let currentStatus: ConversionStatus = {
  status: "idle",
  phase: "inspect",
  message: "Choose a movie file to begin",
};

app.innerHTML = `
  <header class="app-header">
    <div class="brand">
      <span class="brand-mark"><i data-lucide="film"></i></span>
      <div>
        <h1>Dialogue Cut</h1>
        <p>German dialogue review pipeline</p>
      </div>
    </div>
    <span id="status-chip" class="status-chip idle">Ready</span>
  </header>

  <div class="workspace">
    <section class="main-panel">
      <section class="section-block source-block">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Source</span>
            <h2>Select a movie</h2>
          </div>
          <i data-lucide="file-text"></i>
        </div>
        <div class="file-row">
          <input id="video-path" type="text" placeholder="/path/to/movie.mkv" spellcheck="false" />
          <button id="browse-button" class="icon-button" type="button" title="Choose video">
            <i data-lucide="folder-open"></i>
          </button>
        </div>
      </section>

      <section class="section-block">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Cut profile</span>
            <h2>Strict dialogue</h2>
          </div>
          <i data-lucide="settings-2"></i>
        </div>
        <div class="settings-grid">
          <label>
            <span>Pre-roll</span>
            <div class="number-field"><input id="pre-pad" type="number" min="0" step="0.1" value="0.3" /><em>s</em></div>
          </label>
          <label>
            <span>Post-roll</span>
            <div class="number-field"><input id="post-pad" type="number" min="0" step="0.1" value="0.5" /><em>s</em></div>
          </label>
          <label>
            <span>Merge gap</span>
            <div class="number-field"><input id="merge-gap" type="number" min="0" step="0.1" value="1.0" /><em>s</em></div>
          </label>
        </div>
        <div class="toggle-row">
          <label class="toggle-label">
            <input id="force-transcribe" type="checkbox" />
            <span class="toggle"></span>
            <span>
              <strong>Force Whisper transcript</strong>
              <small>Use when embedded subtitles are forced-only or incomplete.</small>
            </span>
          </label>
        </div>
        <div class="runtime-row">
          <i data-lucide="hard-drive-download"></i>
          <div>
            <strong>Processing runtime</strong>
            <small id="runtime-message">Checking private runtime...</small>
          </div>
          <span id="runtime-chip" class="runtime-chip pending">Checking</span>
        </div>
      </section>

      <section class="section-block run-block">
        <div class="section-heading compact">
          <div>
            <span class="eyebrow">Run</span>
            <h2 id="run-message">Choose a movie file to begin</h2>
          </div>
        </div>
        <div class="action-row">
          <button id="start-button" class="primary-button" type="button">
            <i data-lucide="play"></i>
            <span>Start conversion</span>
          </button>
          <button id="stop-button" class="secondary-button" type="button" disabled>
            <i data-lucide="square"></i>
            <span>Cancel</span>
          </button>
        </div>
        <p id="output-path" class="output-path"></p>
      </section>
    </section>

    <aside class="side-panel">
      <section class="progress-panel">
        <span class="eyebrow">Pipeline</span>
        <ol id="phase-list" class="phase-list"></ol>
      </section>
      <section class="log-panel">
        <div class="log-heading">
          <div>
            <span class="eyebrow">Activity</span>
            <h2>Process log</h2>
          </div>
          <i data-lucide="terminal"></i>
        </div>
        <pre id="log-output">Waiting for a conversion...</pre>
      </section>
    </aside>
  </div>
`;

createIcons({
  icons: {
    CheckCircle2,
    Circle,
    FileText,
    Film,
    FolderOpen,
    HardDriveDownload,
    LoaderCircle,
    Play,
    Settings2,
    Square,
    Terminal,
  },
});

const videoPath = document.querySelector<HTMLInputElement>("#video-path")!;
const browseButton = document.querySelector<HTMLButtonElement>("#browse-button")!;
const startButton = document.querySelector<HTMLButtonElement>("#start-button")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop-button")!;
const forceTranscribe = document.querySelector<HTMLInputElement>("#force-transcribe")!;
const statusChip = document.querySelector<HTMLElement>("#status-chip")!;
const runMessage = document.querySelector<HTMLElement>("#run-message")!;
const outputPath = document.querySelector<HTMLElement>("#output-path")!;
const logOutput = document.querySelector<HTMLElement>("#log-output")!;
const phaseList = document.querySelector<HTMLOListElement>("#phase-list")!;
const runtimeChip = document.querySelector<HTMLElement>("#runtime-chip")!;
const runtimeMessage = document.querySelector<HTMLElement>("#runtime-message")!;

function numberValue(id: string): number {
  return Number(document.querySelector<HTMLInputElement>(`#${id}`)!.value);
}

function phaseIndex(phase: string): number {
  const index = phases.findIndex(([id]) => id === phase);
  return index === -1 ? 0 : index;
}

function renderPhases() {
  const activeIndex = phaseIndex(currentStatus.phase);
  phaseList.innerHTML = phases
    .map(([, label], index) => {
      const complete = currentStatus.status === "complete" || index < activeIndex;
      const active = currentStatus.status === "running" && index === activeIndex;
      const icon = complete ? "check-circle-2" : active ? "loader-circle" : "circle";
      const state = complete ? "complete" : active ? "active" : "pending";
      return `<li class="${state}"><i data-lucide="${icon}"></i><span>${label}</span></li>`;
    })
    .join("");
  createIcons({ icons: { CheckCircle2, Circle, LoaderCircle } });
}

function setStatus(status: ConversionStatus) {
  currentStatus = status;
  const running = status.status === "running";
  statusChip.className = `status-chip ${status.status}`;
  statusChip.textContent =
    status.status === "complete"
      ? "Complete"
      : status.status === "error"
        ? "Stopped"
        : running
          ? "Running"
          : "Ready";
  runMessage.textContent = status.message;
  outputPath.textContent = status.outputPath ?? "";
  startButton.disabled = running;
  stopButton.disabled = !running;
  browseButton.disabled = running;
  renderPhases();
}

function appendLog(entry: ConversionLog) {
  if (logOutput.textContent === "Waiting for a conversion...") {
    logOutput.textContent = "";
  }
  const prefix = entry.stream === "stderr" ? "! " : "  ";
  logOutput.textContent += `${prefix}${entry.line}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function setRuntimeStatus(status: RuntimeStatus) {
  runtimeChip.className = `runtime-chip ${status.ready ? "ready" : "pending"}`;
  runtimeChip.textContent = status.ready ? "Ready" : "First-run setup";
  runtimeMessage.textContent = status.message;
}

browseButton.addEventListener("click", async () => {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Video", extensions: ["mkv", "mp4", "mov", "m4v", "webm"] }],
  });
  if (typeof selected === "string") {
    videoPath.value = selected;
    setStatus({ status: "idle", phase: "inspect", message: "Ready to convert" });
  }
});

startButton.addEventListener("click", async () => {
  logOutput.textContent = "";
  try {
    const expectedOutput = await invoke<string>("start_conversion", {
      options: {
        videoPath: videoPath.value.trim(),
        forceTranscribe: forceTranscribe.checked,
        prePad: numberValue("pre-pad"),
        postPad: numberValue("post-pad"),
        mergeGap: numberValue("merge-gap"),
        keepCueClasses: "dialogue",
        keepSources: "dialogue,mixed",
      },
    });
    outputPath.textContent = expectedOutput;
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
});

stopButton.addEventListener("click", async () => {
  try {
    await invoke("stop_conversion");
    appendLog({ stream: "stderr", line: "Cancel requested." });
  } catch (error) {
    appendLog({ stream: "stderr", line: String(error) });
  }
});

listen<ConversionLog>("conversion-log", ({ payload }) => appendLog(payload));
listen<ConversionStatus>("conversion-state", ({ payload }) => setStatus(payload));
listen<RuntimeStatus>("runtime-state", ({ payload }) => setRuntimeStatus(payload));
setStatus(currentStatus);
invoke<RuntimeStatus>("get_runtime_status")
  .then(setRuntimeStatus)
  .catch((error) =>
    setRuntimeStatus({ ready: false, message: String(error) }),
  );
