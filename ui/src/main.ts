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

type Workflow = "dialogue" | "processing" | "grabber";

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

const workflowPhases: Record<Workflow, readonly (readonly [string, string])[]> = {
  dialogue: [
    ["setup", "Prepare runtime"],
    ["inspect", "Inspect source"],
    ["extract", "Extract audio"],
    ["transcribe", "Transcribe German"],
    ["filter", "Filter dialogue"],
    ["render", "Render segments"],
    ["stitch", "Stitch MP4"],
  ],
  processing: [
    ["setup", "Prepare tools"],
    ["inspect", "Inspect source"],
    ["transcode", "Transcode slower"],
  ],
  grabber: [
    ["setup", "Prepare downloader"],
    ["fetch", "Fetch metadata"],
    ["download", "Download material"],
    ["subtitles", "Save subtitles"],
  ],
};

const app = document.querySelector<HTMLDivElement>("#app")!;
let activeWorkflow: Workflow = "dialogue";
let runningWorkflow: Workflow | null = null;
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
      <nav class="mode-tabs" aria-label="Workflow">
        <button id="dialogue-tab" class="tab-button active" type="button">
          <i data-lucide="film"></i>
          <span>Dialogue cut</span>
        </button>
        <button id="processing-tab" class="tab-button" type="button">
          <i data-lucide="settings-2"></i>
          <span>Video processing</span>
        </button>
        <button id="grabber-tab" class="tab-button" type="button">
          <i data-lucide="hard-drive-download"></i>
          <span>Material grabber</span>
        </button>
      </nav>

      <div id="dialogue-panel" class="tab-panel active">
        <section class="section-block source-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Source</span>
              <h2>Select a movie</h2>
            </div>
            <i data-lucide="file-text"></i>
          </div>
          <div class="file-row">
            <input id="dialogue-video-path" type="text" placeholder="/path/to/movie.mkv" spellcheck="false" />
            <button id="dialogue-browse-button" class="icon-button" type="button" title="Choose video">
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
              <h2 id="dialogue-run-message">Choose a movie file to begin</h2>
            </div>
          </div>
          <div class="action-row">
            <button id="dialogue-start-button" class="primary-button" type="button">
              <i data-lucide="play"></i>
              <span>Start conversion</span>
            </button>
            <button id="dialogue-stop-button" class="secondary-button" type="button" disabled>
              <i data-lucide="square"></i>
              <span>Cancel</span>
            </button>
          </div>
          <p id="dialogue-output-path" class="output-path"></p>
        </section>
      </div>

      <div id="processing-panel" class="tab-panel">
        <section class="section-block source-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Source</span>
              <h2>Select a video</h2>
            </div>
            <i data-lucide="file-text"></i>
          </div>
          <div class="file-row">
            <input id="processing-video-path" type="text" placeholder="/path/to/video.mkv" spellcheck="false" />
            <button id="processing-browse-button" class="icon-button" type="button" title="Choose video">
              <i data-lucide="folder-open"></i>
            </button>
          </div>
        </section>

        <section class="section-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Speed profile</span>
              <h2>Dubbing slow-down</h2>
            </div>
            <i data-lucide="settings-2"></i>
          </div>
          <div class="speed-grid">
            <label>
              <span>Playback speed</span>
              <div class="number-field"><input id="slow-speed" type="number" min="0.1" max="1" step="0.05" value="0.50" /><em>x</em></div>
            </label>
            <div class="range-field">
              <input id="slow-speed-range" type="range" min="0.1" max="1" step="0.05" value="0.50" />
              <div class="range-labels"><span>0.10x</span><span>1.00x</span></div>
            </div>
          </div>
          <div class="preset-row">
            <button class="preset-button active" type="button" data-speed="0.50">0.50x</button>
            <button class="preset-button" type="button" data-speed="0.65">0.65x</button>
            <button class="preset-button" type="button" data-speed="0.75">0.75x</button>
            <button class="preset-button" type="button" data-speed="0.85">0.85x</button>
          </div>
        </section>

        <section class="section-block run-block">
          <div class="section-heading compact">
            <div>
              <span class="eyebrow">Run</span>
              <h2 id="processing-run-message">Choose a video file to begin</h2>
            </div>
          </div>
          <div class="action-row">
            <button id="processing-start-button" class="primary-button" type="button">
              <i data-lucide="play"></i>
              <span>Start transcode</span>
            </button>
            <button id="processing-stop-button" class="secondary-button" type="button" disabled>
              <i data-lucide="square"></i>
              <span>Cancel</span>
            </button>
          </div>
          <p id="processing-output-path" class="output-path"></p>
        </section>
      </div>

      <div id="grabber-panel" class="tab-panel">
        <section class="section-block source-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Source</span>
              <h2>Paste a URL</h2>
            </div>
            <i data-lucide="hard-drive-download"></i>
          </div>
          <div class="url-row">
            <input id="grab-url" type="text" placeholder="https://..." spellcheck="false" />
          </div>
        </section>

        <section class="section-block source-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Destination</span>
              <h2>Choose a folder</h2>
            </div>
            <i data-lucide="folder-open"></i>
          </div>
          <div class="file-row">
            <input id="grab-output-dir" type="text" placeholder="/path/to/material" spellcheck="false" />
            <button id="grab-output-browse-button" class="icon-button" type="button" title="Choose folder">
              <i data-lucide="folder-open"></i>
            </button>
          </div>
        </section>

        <section class="section-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Grab profile</span>
              <h2>Video and subtitles</h2>
            </div>
            <i data-lucide="settings-2"></i>
          </div>
          <div class="toggle-stack">
            <label class="toggle-label">
              <input id="grab-video" type="checkbox" checked />
              <span class="toggle"></span>
              <span>
                <strong>Download video</strong>
                <small>Use best 1080p-or-lower media and remux to MP4.</small>
              </span>
            </label>
            <label class="toggle-label">
              <input id="grab-subtitles" type="checkbox" checked />
              <span class="toggle"></span>
              <span>
                <strong>Download subtitles</strong>
                <small>Save available manual or generated captions as SRT.</small>
              </span>
            </label>
          </div>
          <div class="subtitle-row">
            <label>
              <span>Subtitle languages</span>
              <input id="grab-subtitle-languages" type="text" value="de,en" spellcheck="false" />
            </label>
          </div>
        </section>

        <section class="section-block run-block">
          <div class="section-heading compact">
            <div>
              <span class="eyebrow">Run</span>
              <h2 id="grabber-run-message">Paste a URL to begin</h2>
            </div>
          </div>
          <div class="action-row">
            <button id="grabber-start-button" class="primary-button" type="button">
              <i data-lucide="play"></i>
              <span>Start download</span>
            </button>
            <button id="grabber-stop-button" class="secondary-button" type="button" disabled>
              <i data-lucide="square"></i>
              <span>Cancel</span>
            </button>
          </div>
          <p id="grabber-output-path" class="output-path"></p>
        </section>
      </div>
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
        <pre id="log-output">Waiting for a run...</pre>
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

const dialogueTab = document.querySelector<HTMLButtonElement>("#dialogue-tab")!;
const processingTab = document.querySelector<HTMLButtonElement>("#processing-tab")!;
const grabberTab = document.querySelector<HTMLButtonElement>("#grabber-tab")!;
const dialoguePanel = document.querySelector<HTMLElement>("#dialogue-panel")!;
const processingPanel = document.querySelector<HTMLElement>("#processing-panel")!;
const grabberPanel = document.querySelector<HTMLElement>("#grabber-panel")!;
const dialogueVideoPath = document.querySelector<HTMLInputElement>("#dialogue-video-path")!;
const processingVideoPath = document.querySelector<HTMLInputElement>("#processing-video-path")!;
const grabUrl = document.querySelector<HTMLInputElement>("#grab-url")!;
const grabOutputDir = document.querySelector<HTMLInputElement>("#grab-output-dir")!;
const dialogueBrowseButton = document.querySelector<HTMLButtonElement>("#dialogue-browse-button")!;
const processingBrowseButton = document.querySelector<HTMLButtonElement>("#processing-browse-button")!;
const grabOutputBrowseButton = document.querySelector<HTMLButtonElement>(
  "#grab-output-browse-button",
)!;
const dialogueStartButton = document.querySelector<HTMLButtonElement>("#dialogue-start-button")!;
const processingStartButton = document.querySelector<HTMLButtonElement>("#processing-start-button")!;
const grabberStartButton = document.querySelector<HTMLButtonElement>("#grabber-start-button")!;
const dialogueStopButton = document.querySelector<HTMLButtonElement>("#dialogue-stop-button")!;
const processingStopButton = document.querySelector<HTMLButtonElement>("#processing-stop-button")!;
const grabberStopButton = document.querySelector<HTMLButtonElement>("#grabber-stop-button")!;
const forceTranscribe = document.querySelector<HTMLInputElement>("#force-transcribe")!;
const grabVideo = document.querySelector<HTMLInputElement>("#grab-video")!;
const grabSubtitles = document.querySelector<HTMLInputElement>("#grab-subtitles")!;
const grabSubtitleLanguages = document.querySelector<HTMLInputElement>("#grab-subtitle-languages")!;
const statusChip = document.querySelector<HTMLElement>("#status-chip")!;
const dialogueRunMessage = document.querySelector<HTMLElement>("#dialogue-run-message")!;
const processingRunMessage = document.querySelector<HTMLElement>("#processing-run-message")!;
const grabberRunMessage = document.querySelector<HTMLElement>("#grabber-run-message")!;
const dialogueOutputPath = document.querySelector<HTMLElement>("#dialogue-output-path")!;
const processingOutputPath = document.querySelector<HTMLElement>("#processing-output-path")!;
const grabberOutputPath = document.querySelector<HTMLElement>("#grabber-output-path")!;
const logOutput = document.querySelector<HTMLElement>("#log-output")!;
const phaseList = document.querySelector<HTMLOListElement>("#phase-list")!;
const runtimeChip = document.querySelector<HTMLElement>("#runtime-chip")!;
const runtimeMessage = document.querySelector<HTMLElement>("#runtime-message")!;
const slowSpeed = document.querySelector<HTMLInputElement>("#slow-speed")!;
const slowSpeedRange = document.querySelector<HTMLInputElement>("#slow-speed-range")!;
const presetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".preset-button"));

function numberValue(id: string): number {
  return Number(document.querySelector<HTMLInputElement>(`#${id}`)!.value);
}

function phasesForRender() {
  return workflowPhases[runningWorkflow ?? activeWorkflow];
}

function phaseIndex(phase: string): number {
  const phases = phasesForRender();
  if (phase === "complete") {
    return phases.length;
  }
  const index = phases.findIndex(([id]) => id === phase);
  return index === -1 ? 0 : index;
}

function renderPhases() {
  const phases = phasesForRender();
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

function setActiveWorkflow(workflow: Workflow) {
  activeWorkflow = workflow;
  dialogueTab.classList.toggle("active", workflow === "dialogue");
  processingTab.classList.toggle("active", workflow === "processing");
  grabberTab.classList.toggle("active", workflow === "grabber");
  dialoguePanel.classList.toggle("active", workflow === "dialogue");
  processingPanel.classList.toggle("active", workflow === "processing");
  grabberPanel.classList.toggle("active", workflow === "grabber");
  renderPhases();
}

function setRunControls(running: boolean) {
  dialogueStartButton.disabled = running;
  processingStartButton.disabled = running;
  grabberStartButton.disabled = running;
  dialogueStopButton.disabled = !running;
  processingStopButton.disabled = !running;
  grabberStopButton.disabled = !running;
  dialogueBrowseButton.disabled = running;
  processingBrowseButton.disabled = running;
  grabOutputBrowseButton.disabled = running;
}

function workflowForStatus(): Workflow {
  return runningWorkflow ?? activeWorkflow;
}

function setStatus(status: ConversionStatus) {
  currentStatus = status;
  const running = status.status === "running";
  const workflow = workflowForStatus();
  statusChip.className = `status-chip ${status.status}`;
  statusChip.textContent =
    status.status === "complete"
      ? "Complete"
      : status.status === "error"
        ? "Stopped"
        : running
          ? "Running"
          : "Ready";

  const runMessage =
    workflow === "dialogue"
      ? dialogueRunMessage
      : workflow === "processing"
        ? processingRunMessage
        : grabberRunMessage;
  const outputPath =
    workflow === "dialogue"
      ? dialogueOutputPath
      : workflow === "processing"
        ? processingOutputPath
        : grabberOutputPath;
  runMessage.textContent = status.message;
  outputPath.textContent = status.outputPath ?? "";
  setRunControls(running);
  renderPhases();
  if (!running) {
    runningWorkflow = null;
  }
}

function appendLog(entry: ConversionLog) {
  if (logOutput.textContent === "Waiting for a run...") {
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

function updateSpeed(value: string) {
  const numeric = Math.min(1, Math.max(0.1, Number(value) || 0.5));
  const formatted = numeric.toFixed(2);
  slowSpeed.value = formatted;
  slowSpeedRange.value = formatted;
  presetButtons.forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.speed) === numeric);
  });
}

async function chooseVideo(target: HTMLInputElement, workflow: Workflow) {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Video", extensions: ["mkv", "mp4", "mov", "m4v", "webm"] }],
  });
  if (typeof selected === "string") {
    target.value = selected;
    setActiveWorkflow(workflow);
    setStatus({
      status: "idle",
      phase: "inspect",
      message: workflow === "dialogue" ? "Ready to convert" : "Ready to transcode",
    });
  }
}

async function chooseDirectory(target: HTMLInputElement) {
  const selected = await open({
    multiple: false,
    directory: true,
  });
  if (typeof selected === "string") {
    target.value = selected;
    setActiveWorkflow("grabber");
    setStatus({
      status: "idle",
      phase: "fetch",
      message: "Ready to download",
    });
  }
}

dialogueTab.addEventListener("click", () => setActiveWorkflow("dialogue"));
processingTab.addEventListener("click", () => setActiveWorkflow("processing"));
grabberTab.addEventListener("click", () => setActiveWorkflow("grabber"));
dialogueBrowseButton.addEventListener("click", () => chooseVideo(dialogueVideoPath, "dialogue"));
processingBrowseButton.addEventListener("click", () =>
  chooseVideo(processingVideoPath, "processing"),
);
grabOutputBrowseButton.addEventListener("click", () => chooseDirectory(grabOutputDir));

slowSpeed.addEventListener("input", () => updateSpeed(slowSpeed.value));
slowSpeedRange.addEventListener("input", () => updateSpeed(slowSpeedRange.value));
presetButtons.forEach((button) => {
  button.addEventListener("click", () => updateSpeed(button.dataset.speed ?? "0.50"));
});

dialogueStartButton.addEventListener("click", async () => {
  setActiveWorkflow("dialogue");
  runningWorkflow = "dialogue";
  logOutput.textContent = "";
  try {
    const expectedOutput = await invoke<string>("start_conversion", {
      options: {
        videoPath: dialogueVideoPath.value.trim(),
        forceTranscribe: forceTranscribe.checked,
        prePad: numberValue("pre-pad"),
        postPad: numberValue("post-pad"),
        mergeGap: numberValue("merge-gap"),
        keepCueClasses: "dialogue",
        keepSources: "dialogue,mixed",
      },
    });
    dialogueOutputPath.textContent = expectedOutput;
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
});

processingStartButton.addEventListener("click", async () => {
  setActiveWorkflow("processing");
  runningWorkflow = "processing";
  logOutput.textContent = "";
  try {
    const expectedOutput = await invoke<string>("start_slowdown", {
      options: {
        videoPath: processingVideoPath.value.trim(),
        speed: Number(slowSpeed.value),
      },
    });
    processingOutputPath.textContent = expectedOutput;
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
});

grabberStartButton.addEventListener("click", async () => {
  setActiveWorkflow("grabber");
  runningWorkflow = "grabber";
  logOutput.textContent = "";
  try {
    const outputDir = await invoke<string>("start_grab", {
      options: {
        url: grabUrl.value.trim(),
        outputDir: grabOutputDir.value.trim(),
        downloadVideo: grabVideo.checked,
        downloadSubtitles: grabSubtitles.checked,
        subtitleLanguages: grabSubtitleLanguages.value.trim(),
      },
    });
    grabberOutputPath.textContent = outputDir;
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
});

async function stopCurrentRun() {
  try {
    await invoke("stop_conversion");
    appendLog({ stream: "stderr", line: "Cancel requested." });
  } catch (error) {
    appendLog({ stream: "stderr", line: String(error) });
  }
}

dialogueStopButton.addEventListener("click", stopCurrentRun);
processingStopButton.addEventListener("click", stopCurrentRun);
grabberStopButton.addEventListener("click", stopCurrentRun);

listen<ConversionLog>("conversion-log", ({ payload }) => appendLog(payload));
listen<ConversionStatus>("conversion-state", ({ payload }) => setStatus(payload));
listen<RuntimeStatus>("runtime-state", ({ payload }) => setRuntimeStatus(payload));
setActiveWorkflow(activeWorkflow);
setStatus(currentStatus);
updateSpeed(slowSpeed.value);
invoke<RuntimeStatus>("get_runtime_status")
  .then(setRuntimeStatus)
  .catch((error) =>
    setRuntimeStatus({ ready: false, message: String(error) }),
  );
