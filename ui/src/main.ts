import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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
  RefreshCw,
  Settings2,
  Square,
  Terminal,
  createIcons,
} from "lucide";

type Workflow = "dialogue" | "subtitles" | "processing" | "grabber";

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

type GrabQuality = {
  value: string;
  label: string;
};

type GrabSubtitleTrack = {
  language: string;
  label: string;
  hasManual: boolean;
  hasAutomatic: boolean;
};

type GrabMetadata = {
  title: string;
  webpageUrl: string;
  extractor: string;
  duration?: number;
  qualities: GrabQuality[];
  subtitles: GrabSubtitleTrack[];
};

type MaterialVideo = {
  path: string;
  fileName: string;
  duration?: number;
  sizeBytes?: number;
  modified?: number;
  thumbnailDataUrl?: string;
};

type SubtitleSegment = {
  id?: string;
  start: number;
  end: number;
  enabled?: boolean;
  text?: string;
  source?: string;
  review?: boolean;
  reviewReasons?: string[];
  duration?: number;
};

type SubtitleProject = {
  video?: string;
  segments: SubtitleSegment[];
  [key: string]: unknown;
};

type SubtitleProjectData = {
  projectPath: string;
  videoPath: string;
  outputPath: string;
  previewPath: string;
  previewReady: boolean;
  project: SubtitleProject;
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
  subtitles: [
    ["inspect", "Load project"],
    ["filter", "Edit subtitles"],
    ["render", "Render saved cut"],
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
let grabMetadata: GrabMetadata | null = null;
let materialGalleryLoadId = 0;
let subtitleProject: SubtitleProject | null = null;
let subtitleDirty = false;
let pendingPreparedProjectPath = "";
let subtitlePreviewPath = "";
let subtitlePreviewReady = false;
let selectedSubtitleSegmentIndex = 0;
let timelineDuration = 0;

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
        <button id="subtitles-tab" class="tab-button" type="button">
          <i data-lucide="file-text"></i>
          <span>Subtitle project</span>
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
            <button id="dialogue-prepare-button" class="primary-button" type="button">
              <i data-lucide="file-text"></i>
              <span>Prepare project</span>
            </button>
            <button id="dialogue-start-button" class="secondary-button" type="button">
              <i data-lucide="play"></i>
              <span>Render immediately</span>
            </button>
            <button id="dialogue-stop-button" class="secondary-button" type="button" disabled>
              <i data-lucide="square"></i>
              <span>Cancel</span>
            </button>
          </div>
          <p id="dialogue-output-path" class="output-path"></p>
        </section>
      </div>

      <div id="subtitles-panel" class="tab-panel">
        <section class="section-block source-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Project</span>
              <h2>Load editable subtitles</h2>
            </div>
            <i data-lucide="file-text"></i>
          </div>
          <div class="input-action-row project-row">
            <input id="subtitle-project-path" type="text" placeholder="/path/to/movie.dialogue-project.json" spellcheck="false" />
            <button id="subtitle-project-browse-button" class="icon-button" type="button" title="Choose project">
              <i data-lucide="folder-open"></i>
            </button>
            <button id="subtitle-load-button" class="secondary-button" type="button">
              <span>Load</span>
            </button>
          </div>
          <p id="subtitle-video-path" class="output-path"></p>
        </section>

        <section class="section-block subtitle-summary-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Plan</span>
              <h2 id="subtitle-project-title">No project loaded</h2>
            </div>
            <span id="subtitle-dirty-chip" class="runtime-chip ready">Saved</span>
          </div>
          <div class="subtitle-stats">
            <div>
              <span>Kept runtime</span>
              <strong id="subtitle-kept-runtime">0:00</strong>
            </div>
            <div>
              <span>Kept segments</span>
              <strong id="subtitle-kept-count">0</strong>
            </div>
            <div>
              <span>Dropped segments</span>
              <strong id="subtitle-dropped-count">0</strong>
            </div>
            <div>
              <span>Review marks</span>
              <strong id="subtitle-review-count">0</strong>
            </div>
          </div>
        </section>

        <section class="section-block subtitle-preview-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Preview</span>
              <h2 id="subtitle-preview-title">Timeline</h2>
            </div>
            <button id="subtitle-preview-button" class="secondary-button" type="button" disabled>
              <i data-lucide="film"></i>
              <span>Build preview MP4</span>
            </button>
          </div>
          <video id="subtitle-preview-video" class="subtitle-preview-video" controls preload="metadata"></video>
          <div class="timeline-toolbar">
            <label class="checkbox-label">
              <input id="subtitle-skip-toggle" type="checkbox" checked />
              <span>Skip gaps</span>
            </label>
            <button id="subtitle-play-kept-button" class="secondary-button" type="button" disabled>
              <i data-lucide="play"></i>
              <span>Play kept</span>
            </button>
            <span id="subtitle-current-time" class="timeline-time">0:00</span>
          </div>
          <div id="subtitle-timeline-shell" class="subtitle-timeline-shell">
            <div id="subtitle-timeline" class="subtitle-timeline">
              <div id="subtitle-timeline-ruler" class="subtitle-timeline-ruler"></div>
              <div id="subtitle-timeline-track" class="subtitle-timeline-track"></div>
              <div id="subtitle-timeline-playhead" class="subtitle-timeline-playhead"></div>
            </div>
          </div>
          <div class="selected-segment-panel">
            <label class="checkbox-label">
              <input id="selected-segment-enabled" type="checkbox" disabled />
              <span>Keep selected</span>
            </label>
            <label class="segment-time">
              <span>Start</span>
              <input id="selected-segment-start" type="number" min="0" step="0.01" disabled />
            </label>
            <label class="segment-time">
              <span>End</span>
              <input id="selected-segment-end" type="number" min="0" step="0.01" disabled />
            </label>
            <button id="selected-segment-drop-button" class="secondary-button" type="button" disabled>
              <span>Drop segment</span>
            </button>
            <p id="selected-segment-meta" class="selected-segment-meta">No segment selected.</p>
          </div>
        </section>

        <section class="section-block run-block">
          <div class="section-heading compact">
            <div>
              <span class="eyebrow">Commit</span>
              <h2 id="subtitle-run-message">Load a project to edit</h2>
            </div>
          </div>
          <div class="action-row">
            <button id="subtitle-save-button" class="secondary-button" type="button" disabled>
              <i data-lucide="file-text"></i>
              <span>Save project</span>
            </button>
            <button id="subtitle-render-button" class="primary-button" type="button" disabled>
              <i data-lucide="play"></i>
              <span>Commit render</span>
            </button>
            <button id="subtitle-stop-button" class="secondary-button" type="button" disabled>
              <i data-lucide="square"></i>
              <span>Cancel</span>
            </button>
          </div>
          <p id="subtitle-output-path" class="output-path"></p>
        </section>

        <section class="section-block subtitle-editor-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Segments</span>
              <h2>Keep, drop, or trim</h2>
            </div>
          </div>
          <div id="subtitle-segment-list" class="subtitle-segment-list">
            <p class="empty-note">Load a subtitle project first.</p>
          </div>
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

        <section class="section-block material-gallery-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Material</span>
              <h2>Output folder videos</h2>
            </div>
            <button id="material-refresh-button" class="icon-button" type="button" title="Refresh videos">
              <i data-lucide="refresh-cw"></i>
            </button>
          </div>
          <div id="material-gallery" class="material-gallery">
            <p class="empty-note">Loading videos...</p>
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
          <div class="input-action-row">
            <input id="grab-url" type="text" placeholder="https://..." spellcheck="false" />
            <button id="grabber-start-button" class="primary-button" type="button">
              <i data-lucide="play"></i>
              <span id="grabber-action-label">Start</span>
            </button>
            <button id="grabber-stop-button" class="secondary-button" type="button" disabled>
              <i data-lucide="square"></i>
              <span>Cancel</span>
            </button>
          </div>
          <p id="grabber-run-message" class="inline-status">Paste a URL to begin</p>
          <details class="settings-details">
            <summary>
              <i data-lucide="settings-2"></i>
              <span>Output settings</span>
            </summary>
            <div class="settings-details-body">
              <div class="file-row">
                <input id="grab-output-dir" type="text" placeholder="/path/to/material" spellcheck="false" />
                <button id="grab-output-browse-button" class="icon-button" type="button" title="Choose folder">
                  <i data-lucide="folder-open"></i>
                </button>
              </div>
              <p id="grabber-output-path" class="output-path"></p>
            </div>
          </details>
        </section>

        <section id="grabber-metadata-section" class="section-block metadata-block" hidden>
          <div class="section-heading">
            <div>
              <span class="eyebrow">Metadata</span>
              <h2 id="grabber-title">Start with a URL</h2>
            </div>
            <i data-lucide="settings-2"></i>
          </div>
          <p id="grabber-meta-line" class="meta-line"></p>
          <div class="metadata-grid">
            <label>
              <span>Video quality</span>
              <select id="grab-quality"></select>
            </label>
            <div>
              <span class="field-label">Subtitle tracks</span>
              <div id="grab-subtitle-options" class="subtitle-options"></div>
            </div>
          </div>
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
    RefreshCw,
    Settings2,
    Square,
    Terminal,
  },
});

const dialogueTab = document.querySelector<HTMLButtonElement>("#dialogue-tab")!;
const subtitlesTab = document.querySelector<HTMLButtonElement>("#subtitles-tab")!;
const processingTab = document.querySelector<HTMLButtonElement>("#processing-tab")!;
const grabberTab = document.querySelector<HTMLButtonElement>("#grabber-tab")!;
const dialoguePanel = document.querySelector<HTMLElement>("#dialogue-panel")!;
const subtitlesPanel = document.querySelector<HTMLElement>("#subtitles-panel")!;
const processingPanel = document.querySelector<HTMLElement>("#processing-panel")!;
const grabberPanel = document.querySelector<HTMLElement>("#grabber-panel")!;
const dialogueVideoPath = document.querySelector<HTMLInputElement>("#dialogue-video-path")!;
const subtitleProjectPath = document.querySelector<HTMLInputElement>("#subtitle-project-path")!;
const processingVideoPath = document.querySelector<HTMLInputElement>("#processing-video-path")!;
const grabUrl = document.querySelector<HTMLInputElement>("#grab-url")!;
const grabOutputDir = document.querySelector<HTMLInputElement>("#grab-output-dir")!;
const dialogueBrowseButton = document.querySelector<HTMLButtonElement>("#dialogue-browse-button")!;
const subtitleProjectBrowseButton = document.querySelector<HTMLButtonElement>(
  "#subtitle-project-browse-button",
)!;
const processingBrowseButton = document.querySelector<HTMLButtonElement>("#processing-browse-button")!;
const grabOutputBrowseButton = document.querySelector<HTMLButtonElement>(
  "#grab-output-browse-button",
)!;
const dialoguePrepareButton = document.querySelector<HTMLButtonElement>("#dialogue-prepare-button")!;
const dialogueStartButton = document.querySelector<HTMLButtonElement>("#dialogue-start-button")!;
const subtitleLoadButton = document.querySelector<HTMLButtonElement>("#subtitle-load-button")!;
const subtitleSaveButton = document.querySelector<HTMLButtonElement>("#subtitle-save-button")!;
const subtitleRenderButton = document.querySelector<HTMLButtonElement>("#subtitle-render-button")!;
const processingStartButton = document.querySelector<HTMLButtonElement>("#processing-start-button")!;
const grabberStartButton = document.querySelector<HTMLButtonElement>("#grabber-start-button")!;
const grabberActionLabel = document.querySelector<HTMLElement>("#grabber-action-label")!;
const materialRefreshButton = document.querySelector<HTMLButtonElement>("#material-refresh-button")!;
const dialogueStopButton = document.querySelector<HTMLButtonElement>("#dialogue-stop-button")!;
const subtitleStopButton = document.querySelector<HTMLButtonElement>("#subtitle-stop-button")!;
const processingStopButton = document.querySelector<HTMLButtonElement>("#processing-stop-button")!;
const grabberStopButton = document.querySelector<HTMLButtonElement>("#grabber-stop-button")!;
const forceTranscribe = document.querySelector<HTMLInputElement>("#force-transcribe")!;
const grabberMetadataSection = document.querySelector<HTMLElement>("#grabber-metadata-section")!;
const grabberTitle = document.querySelector<HTMLElement>("#grabber-title")!;
const grabberMetaLine = document.querySelector<HTMLElement>("#grabber-meta-line")!;
const grabQuality = document.querySelector<HTMLSelectElement>("#grab-quality")!;
const grabSubtitleOptions = document.querySelector<HTMLElement>("#grab-subtitle-options")!;
const statusChip = document.querySelector<HTMLElement>("#status-chip")!;
const dialogueRunMessage = document.querySelector<HTMLElement>("#dialogue-run-message")!;
const subtitleRunMessage = document.querySelector<HTMLElement>("#subtitle-run-message")!;
const processingRunMessage = document.querySelector<HTMLElement>("#processing-run-message")!;
const grabberRunMessage = document.querySelector<HTMLElement>("#grabber-run-message")!;
const dialogueOutputPath = document.querySelector<HTMLElement>("#dialogue-output-path")!;
const subtitleOutputPath = document.querySelector<HTMLElement>("#subtitle-output-path")!;
const subtitleVideoPath = document.querySelector<HTMLElement>("#subtitle-video-path")!;
const subtitleProjectTitle = document.querySelector<HTMLElement>("#subtitle-project-title")!;
const subtitleDirtyChip = document.querySelector<HTMLElement>("#subtitle-dirty-chip")!;
const subtitleKeptRuntime = document.querySelector<HTMLElement>("#subtitle-kept-runtime")!;
const subtitleKeptCount = document.querySelector<HTMLElement>("#subtitle-kept-count")!;
const subtitleDroppedCount = document.querySelector<HTMLElement>("#subtitle-dropped-count")!;
const subtitleReviewCount = document.querySelector<HTMLElement>("#subtitle-review-count")!;
const subtitlePreviewTitle = document.querySelector<HTMLElement>("#subtitle-preview-title")!;
const subtitlePreviewButton = document.querySelector<HTMLButtonElement>("#subtitle-preview-button")!;
const subtitlePreviewVideo = document.querySelector<HTMLVideoElement>("#subtitle-preview-video")!;
const subtitleSkipToggle = document.querySelector<HTMLInputElement>("#subtitle-skip-toggle")!;
const subtitlePlayKeptButton = document.querySelector<HTMLButtonElement>("#subtitle-play-kept-button")!;
const subtitleCurrentTime = document.querySelector<HTMLElement>("#subtitle-current-time")!;
const subtitleTimelineShell = document.querySelector<HTMLElement>("#subtitle-timeline-shell")!;
const subtitleTimeline = document.querySelector<HTMLElement>("#subtitle-timeline")!;
const subtitleTimelineRuler = document.querySelector<HTMLElement>("#subtitle-timeline-ruler")!;
const subtitleTimelineTrack = document.querySelector<HTMLElement>("#subtitle-timeline-track")!;
const subtitleTimelinePlayhead = document.querySelector<HTMLElement>("#subtitle-timeline-playhead")!;
const selectedSegmentEnabled = document.querySelector<HTMLInputElement>("#selected-segment-enabled")!;
const selectedSegmentStart = document.querySelector<HTMLInputElement>("#selected-segment-start")!;
const selectedSegmentEnd = document.querySelector<HTMLInputElement>("#selected-segment-end")!;
const selectedSegmentDropButton = document.querySelector<HTMLButtonElement>(
  "#selected-segment-drop-button",
)!;
const selectedSegmentMeta = document.querySelector<HTMLElement>("#selected-segment-meta")!;
const subtitleSegmentList = document.querySelector<HTMLElement>("#subtitle-segment-list")!;
const processingOutputPath = document.querySelector<HTMLElement>("#processing-output-path")!;
const grabberOutputPath = document.querySelector<HTMLElement>("#grabber-output-path")!;
const materialGallery = document.querySelector<HTMLElement>("#material-gallery")!;
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
  subtitlesTab.classList.toggle("active", workflow === "subtitles");
  processingTab.classList.toggle("active", workflow === "processing");
  grabberTab.classList.toggle("active", workflow === "grabber");
  dialoguePanel.classList.toggle("active", workflow === "dialogue");
  subtitlesPanel.classList.toggle("active", workflow === "subtitles");
  processingPanel.classList.toggle("active", workflow === "processing");
  grabberPanel.classList.toggle("active", workflow === "grabber");
  renderPhases();
}

function refreshSubtitleControls(running = currentStatus.status === "running") {
  const hasProject = subtitleProject !== null;
  subtitleLoadButton.disabled = running || !subtitleProjectPath.value.trim();
  subtitleProjectBrowseButton.disabled = running;
  subtitleSaveButton.disabled = running || !hasProject || !subtitleDirty;
  subtitleRenderButton.disabled = running || !hasProject;
  subtitlePreviewButton.disabled = running || !hasProject;
  subtitlePlayKeptButton.disabled = running || !hasProject || !subtitlePreviewReady;
  subtitleStopButton.disabled = !running;
  subtitleDirtyChip.className = `runtime-chip ${subtitleDirty ? "pending" : "ready"}`;
  subtitleDirtyChip.textContent = subtitleDirty ? "Unsaved" : "Saved";
}

function setRunControls(running: boolean) {
  dialoguePrepareButton.disabled = running;
  dialogueStartButton.disabled = running;
  processingStartButton.disabled = running;
  dialogueStopButton.disabled = !running;
  subtitleStopButton.disabled = !running;
  processingStopButton.disabled = !running;
  grabberStopButton.disabled = !running;
  dialogueBrowseButton.disabled = running;
  processingBrowseButton.disabled = running;
  grabOutputBrowseButton.disabled = running;
  materialRefreshButton.disabled = running;
  refreshSubtitleControls(running);
  applyGrabControlState(running);
}

function workflowForStatus(): Workflow {
  return runningWorkflow ?? activeWorkflow;
}

function runMessageFor(workflow: Workflow): HTMLElement {
  if (workflow === "dialogue") {
    return dialogueRunMessage;
  }
  if (workflow === "subtitles") {
    return subtitleRunMessage;
  }
  if (workflow === "processing") {
    return processingRunMessage;
  }
  return grabberRunMessage;
}

function outputPathFor(workflow: Workflow): HTMLElement {
  if (workflow === "dialogue") {
    return dialogueOutputPath;
  }
  if (workflow === "subtitles") {
    return subtitleOutputPath;
  }
  if (workflow === "processing") {
    return processingOutputPath;
  }
  return grabberOutputPath;
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

  const runMessage = runMessageFor(workflow);
  const outputPath = outputPathFor(workflow);
  runMessage.textContent = status.message;
  outputPath.textContent = status.outputPath ?? (workflow === "grabber" ? grabOutputDir.value.trim() : "");
  setRunControls(running);
  renderPhases();
  if (workflow === "grabber" && status.status === "complete" && status.message === "Material is ready") {
    void loadMaterialGallery();
  }
  if (workflow === "subtitles" && status.status === "complete" && status.message === "Preview MP4 is ready") {
    subtitlePreviewPath = status.outputPath ?? subtitlePreviewPath;
    subtitlePreviewReady = true;
    setSubtitlePreviewSource();
  }
  if (!running) {
    runningWorkflow = null;
  }
  if (
    workflow === "dialogue" &&
    status.status === "complete" &&
    status.message === "Subtitle project is ready" &&
    pendingPreparedProjectPath
  ) {
    const projectPath = pendingPreparedProjectPath;
    pendingPreparedProjectPath = "";
    void loadSubtitleProject(projectPath);
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

function segmentEnabled(segment: SubtitleSegment): boolean {
  return segment.enabled !== false;
}

function segmentDuration(segment: SubtitleSegment): number {
  const start = Number(segment.start);
  const end = Number(segment.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.max(0, end - start);
}

function formatSeconds(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "0.000";
}

function subtitleReviewReasons(segment: SubtitleSegment): string {
  return (segment.reviewReasons ?? []).join(", ");
}

function renderSubtitleStats() {
  if (!subtitleProject) {
    subtitleProjectTitle.textContent = "No project loaded";
    subtitleKeptRuntime.textContent = "0:00";
    subtitleKeptCount.textContent = "0";
    subtitleDroppedCount.textContent = "0";
    subtitleReviewCount.textContent = "0";
    subtitleVideoPath.textContent = "";
    refreshSubtitleControls();
    return;
  }

  const segments = subtitleProject.segments;
  const kept = segments.filter(segmentEnabled);
  const dropped = segments.length - kept.length;
  const reviewCount = segments.filter((segment) => segment.review).length;
  const keptDuration = kept.reduce((total, segment) => total + segmentDuration(segment), 0);
  subtitleProjectTitle.textContent = `${segments.length} planned segments`;
  subtitleKeptRuntime.textContent = formatDuration(keptDuration) ?? "0:00";
  subtitleKeptCount.textContent = String(kept.length);
  subtitleDroppedCount.textContent = String(dropped);
  subtitleReviewCount.textContent = String(reviewCount);
  subtitleVideoPath.textContent = subtitleProject.video ? `Source: ${subtitleProject.video}` : "";
  refreshSubtitleControls();
}

function markSubtitleDirty() {
  subtitleDirty = true;
  renderSubtitleStats();
}

function updateSegmentDuration(segment: SubtitleSegment) {
  segment.duration = Number(segmentDuration(segment).toFixed(3));
}

function projectMaxEnd(): number {
  if (!subtitleProject) {
    return 0;
  }
  return subtitleProject.segments.reduce((maxEnd, segment) => Math.max(maxEnd, segment.end), 0);
}

function updateTimelineDuration() {
  const videoDuration = Number.isFinite(subtitlePreviewVideo.duration)
    ? subtitlePreviewVideo.duration
    : 0;
  timelineDuration = Math.max(projectMaxEnd(), videoDuration, 1);
}

function enabledSubtitleSegments(): Array<{ segment: SubtitleSegment; index: number }> {
  if (!subtitleProject) {
    return [];
  }
  return subtitleProject.segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segmentEnabled(segment))
    .sort((first, second) => first.segment.start - second.segment.start);
}

function selectedSegment(): SubtitleSegment | null {
  if (!subtitleProject) {
    return null;
  }
  return subtitleProject.segments[selectedSubtitleSegmentIndex] ?? null;
}

function setSubtitlePreviewSource() {
  subtitlePreviewReady = subtitlePreviewReady && Boolean(subtitlePreviewPath);
  subtitlePreviewTitle.textContent = subtitlePreviewReady ? "Timeline preview ready" : "Timeline";
  if (subtitlePreviewReady) {
    subtitlePreviewVideo.src = convertFileSrc(subtitlePreviewPath);
    subtitlePreviewVideo.load();
  } else {
    subtitlePreviewVideo.removeAttribute("src");
    subtitlePreviewVideo.load();
  }
  refreshSubtitleControls();
}

function timeFromTimelinePointer(event: PointerEvent | MouseEvent): number {
  const rect = subtitleTimeline.getBoundingClientRect();
  const x = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
  return (x / Math.max(1, rect.width)) * timelineDuration;
}

function updateTimelinePlayhead() {
  updateTimelineDuration();
  const current = Math.min(Math.max(0, subtitlePreviewVideo.currentTime || 0), timelineDuration);
  subtitleTimelinePlayhead.style.left = `${(current / timelineDuration) * 100}%`;
  subtitleCurrentTime.textContent = formatDuration(current) ?? "0:00";
}

function renderTimelineRuler() {
  subtitleTimelineRuler.replaceChildren();
  const step = timelineDuration > 5400 ? 900 : timelineDuration > 1800 ? 300 : 60;
  for (let time = 0; time <= timelineDuration; time += step) {
    const tick = document.createElement("span");
    tick.className = "timeline-tick";
    tick.style.left = `${(time / timelineDuration) * 100}%`;
    tick.textContent = formatDuration(time) ?? "0:00";
    subtitleTimelineRuler.append(tick);
  }
}

function selectSubtitleSegment(index: number, seek = false) {
  if (!subtitleProject || !subtitleProject.segments[index]) {
    return;
  }
  selectedSubtitleSegmentIndex = index;
  const segment = subtitleProject.segments[index];
  if (seek && subtitlePreviewReady) {
    subtitlePreviewVideo.currentTime = Math.max(0, segment.start);
  }
  updateSelectedSegmentControls();
  renderSubtitleTimeline();
  renderSubtitleSegments();
}

function renderSubtitleTimeline() {
  updateTimelineDuration();
  subtitleTimelineTrack.replaceChildren();
  const width = Math.max(1200, Math.min(5200, Math.round(timelineDuration * 0.24)));
  subtitleTimeline.style.width = `${width}px`;
  renderTimelineRuler();

  if (!subtitleProject) {
    updateTimelinePlayhead();
    return;
  }

  subtitleProject.segments.forEach((segment, index) => {
    const block = document.createElement("button");
    block.className = "timeline-segment";
    block.type = "button";
    block.classList.toggle("disabled", !segmentEnabled(segment));
    block.classList.toggle("review", segment.review === true);
    block.classList.toggle("selected", index === selectedSubtitleSegmentIndex);
    block.style.left = `${(segment.start / timelineDuration) * 100}%`;
    block.style.width = `${(segmentDuration(segment) / timelineDuration) * 100}%`;
    block.title = `${segment.id ?? `segment-${index + 1}`} ${formatDuration(segment.start)} -> ${formatDuration(
      segment.end,
    )}`;
    block.addEventListener("click", (event) => {
      event.stopPropagation();
      selectSubtitleSegment(index, true);
    });

    const leftHandle = document.createElement("span");
    leftHandle.className = "timeline-handle left";
    leftHandle.addEventListener("pointerdown", (event) => startTimelineDrag(event, index, "start"));
    const rightHandle = document.createElement("span");
    rightHandle.className = "timeline-handle right";
    rightHandle.addEventListener("pointerdown", (event) => startTimelineDrag(event, index, "end"));
    block.append(leftHandle, rightHandle);
    subtitleTimelineTrack.append(block);
  });
  const selectedBlock = subtitleTimelineTrack.querySelector<HTMLElement>(".timeline-segment.selected");
  if (selectedBlock) {
    const targetScroll =
      selectedBlock.offsetLeft - subtitleTimelineShell.clientWidth / 2 + selectedBlock.offsetWidth / 2;
    subtitleTimelineShell.scrollLeft = Math.max(0, targetScroll);
  }
  updateTimelinePlayhead();
}

function findSegmentIndexAtTime(time: number): number {
  if (!subtitleProject) {
    return -1;
  }
  return subtitleProject.segments.findIndex((segment) => time >= segment.start && time <= segment.end);
}

function startTimelineDrag(event: PointerEvent, index: number, edge: "start" | "end") {
  event.preventDefault();
  event.stopPropagation();
  selectSubtitleSegment(index);
  const segment = selectedSegment();
  if (!segment) {
    return;
  }
  const onMove = (moveEvent: PointerEvent) => {
    const time = timeFromTimelinePointer(moveEvent);
    if (edge === "start") {
      segment.start = Number(Math.min(Math.max(0, time), segment.end - 0.05).toFixed(3));
    } else {
      segment.end = Number(Math.max(segment.start + 0.05, time).toFixed(3));
    }
    updateSegmentDuration(segment);
    subtitleDirty = true;
    renderSubtitleStats();
    updateSelectedSegmentControls();
    renderSubtitleTimeline();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

function updateSelectedSegmentControls() {
  const segment = selectedSegment();
  const hasSegment = Boolean(segment);
  selectedSegmentEnabled.disabled = !hasSegment;
  selectedSegmentStart.disabled = !hasSegment;
  selectedSegmentEnd.disabled = !hasSegment;
  selectedSegmentDropButton.disabled = !hasSegment;
  if (!segment) {
    selectedSegmentEnabled.checked = false;
    selectedSegmentStart.value = "";
    selectedSegmentEnd.value = "";
    selectedSegmentMeta.textContent = "No segment selected.";
    return;
  }

  selectedSegmentEnabled.checked = segmentEnabled(segment);
  selectedSegmentStart.value = formatSeconds(segment.start);
  selectedSegmentEnd.value = formatSeconds(segment.end);
  const id = segment.id ?? `segment-${selectedSubtitleSegmentIndex + 1}`;
  const source = segment.source ? ` | ${segment.source}` : "";
  const reasons = subtitleReviewReasons(segment);
  selectedSegmentMeta.textContent = `${id} | ${formatDuration(segmentDuration(segment)) ?? "0:00"}${source}${
    reasons ? ` | ${reasons}` : ""
  }`;
}

function applySelectedSegmentControls() {
  const segment = selectedSegment();
  if (!segment) {
    return;
  }
  const start = Math.max(0, Number(selectedSegmentStart.value) || 0);
  const end = Math.max(start + 0.05, Number(selectedSegmentEnd.value) || start + 0.05);
  segment.enabled = selectedSegmentEnabled.checked;
  segment.start = Number(start.toFixed(3));
  segment.end = Number(end.toFixed(3));
  updateSegmentDuration(segment);
  markSubtitleDirty();
  updateSelectedSegmentControls();
  renderSubtitleTimeline();
  renderSubtitleSegments();
}

function jumpToNextEnabledSegment(fromTime: number): boolean {
  const next = enabledSubtitleSegments().find(({ segment }) => segment.end > fromTime + 0.05);
  if (!next) {
    subtitlePreviewVideo.pause();
    return false;
  }
  subtitlePreviewVideo.currentTime = Math.max(next.segment.start, fromTime);
  selectSubtitleSegment(next.index);
  return true;
}

function enforceSkipPlayback() {
  if (!subtitleProject || !subtitlePreviewReady || !subtitleSkipToggle.checked || subtitlePreviewVideo.paused) {
    return;
  }
  const current = subtitlePreviewVideo.currentTime;
  const active = enabledSubtitleSegments().find(
    ({ segment }) => current >= segment.start && current < segment.end - 0.04,
  );
  if (active) {
    if (active.index !== selectedSubtitleSegmentIndex) {
      selectSubtitleSegment(active.index);
    }
    return;
  }
  const next = enabledSubtitleSegments().find(({ segment }) => segment.start > current);
  if (next) {
    subtitlePreviewVideo.currentTime = next.segment.start;
    selectSubtitleSegment(next.index);
  } else {
    subtitlePreviewVideo.pause();
  }
}

function renderSubtitleSegments() {
  subtitleSegmentList.replaceChildren();
  if (!subtitleProject) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "Load a subtitle project first.";
    subtitleSegmentList.append(empty);
    return;
  }

  subtitleProject.segments.forEach((segment, index) => {
    const row = document.createElement("article");
    row.className = "subtitle-segment";
    row.classList.toggle("disabled", !segmentEnabled(segment));
    row.classList.toggle("review", segment.review === true);
    row.classList.toggle("selected", index === selectedSubtitleSegmentIndex);
    row.addEventListener("click", () => selectSubtitleSegment(index, true));

    const keepLabel = document.createElement("label");
    keepLabel.className = "checkbox-label segment-keep";
    const keepInput = document.createElement("input");
    keepInput.type = "checkbox";
    keepInput.checked = segmentEnabled(segment);
    keepInput.addEventListener("change", (event) => {
      event.stopPropagation();
      segment.enabled = keepInput.checked;
      row.classList.toggle("disabled", !keepInput.checked);
      markSubtitleDirty();
      updateSelectedSegmentControls();
      renderSubtitleTimeline();
    });
    const keepText = document.createElement("span");
    keepText.textContent = "Keep";
    keepLabel.append(keepInput, keepText);

    const meta = document.createElement("div");
    meta.className = "segment-meta";
    const id = document.createElement("strong");
    id.textContent = segment.id ?? `segment-${String(index + 1).padStart(4, "0")}`;
    const details = document.createElement("small");
    const source = segment.source ? ` | ${segment.source}` : "";
    const reasons = subtitleReviewReasons(segment);
    details.textContent = `${formatDuration(segmentDuration(segment)) ?? "0:00"}${source}${
      reasons ? ` | ${reasons}` : ""
    }`;
    meta.append(id, details);

    const startLabel = document.createElement("label");
    startLabel.className = "segment-time";
    const startText = document.createElement("span");
    startText.textContent = "Start";
    const startInput = document.createElement("input");
    startInput.type = "number";
    startInput.min = "0";
    startInput.step = "0.01";
    startInput.value = formatSeconds(segment.start);
    startLabel.append(startText, startInput);

    const endLabel = document.createElement("label");
    endLabel.className = "segment-time";
    const endText = document.createElement("span");
    endText.textContent = "End";
    const endInput = document.createElement("input");
    endInput.type = "number";
    endInput.min = "0";
    endInput.step = "0.01";
    endInput.value = formatSeconds(segment.end);
    endLabel.append(endText, endInput);

    const updateTiming = () => {
      const start = Math.max(0, Number(startInput.value) || 0);
      const end = Math.max(start, Number(endInput.value) || start);
      segment.start = Number(start.toFixed(3));
      segment.end = Number(end.toFixed(3));
      startInput.value = formatSeconds(segment.start);
      endInput.value = formatSeconds(segment.end);
      updateSegmentDuration(segment);
      details.textContent = `${formatDuration(segmentDuration(segment)) ?? "0:00"}${source}${
        reasons ? ` | ${reasons}` : ""
      }`;
      markSubtitleDirty();
      updateSelectedSegmentControls();
      renderSubtitleTimeline();
    };
    startInput.addEventListener("click", (event) => event.stopPropagation());
    endInput.addEventListener("click", (event) => event.stopPropagation());
    startInput.addEventListener("change", updateTiming);
    endInput.addEventListener("change", updateTiming);

    const text = document.createElement("textarea");
    text.className = "segment-text";
    text.rows = 2;
    text.value = segment.text ?? "";
    text.placeholder = "Subtitle text";
    text.addEventListener("click", (event) => event.stopPropagation());
    text.addEventListener("input", () => {
      segment.text = text.value;
      markSubtitleDirty();
    });

    row.append(keepLabel, meta, startLabel, endLabel, text);
    subtitleSegmentList.append(row);
  });
}

async function loadSubtitleProject(path = subtitleProjectPath.value.trim()) {
  if (!path) {
    return;
  }
  setActiveWorkflow("subtitles");
  try {
    const data = await invoke<SubtitleProjectData>("load_subtitle_project", {
      options: { projectPath: path },
    });
    subtitleProject = data.project;
    subtitleDirty = false;
    selectedSubtitleSegmentIndex = 0;
    subtitlePreviewPath = data.previewPath;
    subtitlePreviewReady = data.previewReady;
    subtitleProjectPath.value = data.projectPath;
    subtitleOutputPath.textContent = data.outputPath;
    subtitleRunMessage.textContent = "Project loaded";
    setSubtitlePreviewSource();
    renderSubtitleStats();
    updateSelectedSegmentControls();
    renderSubtitleTimeline();
    renderSubtitleSegments();
    setStatus({
      status: "idle",
      phase: "filter",
      message: "Edit subtitles before commit",
      outputPath: data.outputPath,
    });
    if (!subtitlePreviewReady) {
      void buildSubtitlePreviewProxy();
    }
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
}

async function saveSubtitleProject() {
  if (!subtitleProject) {
    return;
  }
  await invoke("save_subtitle_project", {
    options: {
      projectPath: subtitleProjectPath.value.trim(),
      project: subtitleProject,
    },
  });
  subtitleDirty = false;
  subtitleRunMessage.textContent = "Project saved";
  renderSubtitleStats();
}

async function commitSubtitleProject() {
  if (!subtitleProject) {
    return;
  }
  setActiveWorkflow("subtitles");
  runningWorkflow = "subtitles";
  logOutput.textContent = "";
  try {
    if (subtitleDirty) {
      await saveSubtitleProject();
    }
    const outputPath = await invoke<string>("start_project_render", {
      options: {
        projectPath: subtitleProjectPath.value.trim(),
        outputPath: subtitleOutputPath.textContent?.trim() ?? "",
      },
    });
    subtitleOutputPath.textContent = outputPath;
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
}

async function buildSubtitlePreviewProxy() {
  if (!subtitleProject) {
    return;
  }
  setActiveWorkflow("subtitles");
  runningWorkflow = "subtitles";
  logOutput.textContent = "";
  try {
    const previewPath = await invoke<string>("start_preview_proxy", {
      options: {
        projectPath: subtitleProjectPath.value.trim(),
      },
    });
    subtitlePreviewPath = previewPath;
    subtitlePreviewReady = false;
    subtitlePreviewTitle.textContent = "Building preview MP4";
    refreshSubtitleControls();
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
}

function setGrabOutputDir(path: string) {
  grabOutputDir.value = path;
  grabberOutputPath.textContent = path;
  applyGrabControlState();
  if (activeWorkflow === "processing") {
    void loadMaterialGallery();
  }
}

function selectProcessingVideo(path: string) {
  processingVideoPath.value = path;
  setActiveWorkflow("processing");
  setStatus({
    status: "idle",
    phase: "inspect",
    message: "Ready to transcode",
  });
  renderMaterialSelection();
}

function renderMaterialSelection() {
  materialGallery
    .querySelectorAll<HTMLButtonElement>(".video-card")
    .forEach((button) => {
      button.classList.toggle("active", button.dataset.path === processingVideoPath.value);
    });
}

function renderMaterialGallery(videos: MaterialVideo[]) {
  materialGallery.replaceChildren();
  if (videos.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "No videos found in Output settings.";
    materialGallery.append(empty);
    return;
  }

  for (const video of videos) {
    const button = document.createElement("button");
    button.className = "video-card";
    button.type = "button";
    button.dataset.path = video.path;
    button.addEventListener("click", () => selectProcessingVideo(video.path));

    const thumb = document.createElement("span");
    thumb.className = "video-thumb";
    if (video.thumbnailDataUrl) {
      const image = document.createElement("img");
      image.src = video.thumbnailDataUrl;
      image.alt = "";
      thumb.append(image);
    } else {
      const fallback = document.createElement("i");
      fallback.setAttribute("data-lucide", "film");
      thumb.append(fallback);
    }

    const meta = document.createElement("span");
    meta.className = "video-card-meta";
    const name = document.createElement("strong");
    name.textContent = video.fileName;
    const duration = document.createElement("small");
    duration.textContent = formatDuration(video.duration) ?? "Video";
    meta.append(name, duration);
    button.append(thumb, meta);
    materialGallery.append(button);
  }

  createIcons({ icons: { Film } });
  renderMaterialSelection();
}

async function loadMaterialGallery() {
  if (currentStatus.status === "running") {
    return;
  }
  const loadId = ++materialGalleryLoadId;
  materialRefreshButton.disabled = true;
  materialGallery.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "empty-note";
  loading.textContent = "Loading videos...";
  materialGallery.append(loading);

  try {
    const videos = await invoke<MaterialVideo[]>("list_material_videos", {
      options: {
        directory: grabOutputDir.value.trim(),
      },
    });
    if (loadId === materialGalleryLoadId) {
      renderMaterialGallery(videos);
    }
  } catch (error) {
    if (loadId !== materialGalleryLoadId) {
      return;
    }
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = String(error);
    materialGallery.replaceChildren(empty);
  } finally {
    if (loadId === materialGalleryLoadId) {
      materialRefreshButton.disabled = false;
    }
  }
}

function selectedSubtitleLanguages(): string[] {
  return Array.from(
    grabSubtitleOptions.querySelectorAll<HTMLInputElement>("input[type='checkbox']:checked"),
  )
    .map((input) => input.dataset.language ?? "")
    .filter(Boolean);
}

function shouldDownloadVideo(): boolean {
  return grabQuality.value !== "none";
}

function canStartGrab(): boolean {
  if (!grabMetadata) {
    return false;
  }
  return shouldDownloadVideo() || selectedSubtitleLanguages().length > 0;
}

function applyGrabControlState(running = currentStatus.status === "running") {
  const hasMetadata = grabMetadata !== null;
  grabberActionLabel.textContent = hasMetadata ? "Download" : "Start";
  grabberStartButton.disabled = running || (!hasMetadata ? !grabUrl.value.trim() : !canStartGrab());
  grabQuality.disabled = running || !hasMetadata;
  grabSubtitleOptions
    .querySelectorAll<HTMLInputElement>("input[type='checkbox']")
    .forEach((input) => {
      input.disabled = running || !hasMetadata;
    });
}

function formatDuration(duration?: number): string | null {
  if (!duration || duration <= 0) {
    return null;
  }
  const totalSeconds = Math.round(duration);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function resetGrabMetadata() {
  grabMetadata = null;
  grabberMetadataSection.hidden = true;
  grabQuality.replaceChildren();
  grabSubtitleOptions.replaceChildren();
  applyGrabControlState();
}

function renderGrabMetadata(metadata: GrabMetadata) {
  grabberMetadataSection.hidden = false;
  grabberTitle.textContent = metadata.title;
  const detailParts = [metadata.extractor, formatDuration(metadata.duration)].filter(Boolean);
  grabberMetaLine.textContent = detailParts.join(" | ");

  const noVideoOption = document.createElement("option");
  noVideoOption.value = "none";
  noVideoOption.textContent = "No video";
  grabQuality.replaceChildren(
    noVideoOption,
    ...metadata.qualities.map((quality) => {
      const option = document.createElement("option");
      option.value = quality.value;
      option.textContent = quality.label;
      return option;
    }),
  );
  const defaultQuality =
    metadata.qualities.find((quality) => quality.value === "1080") ??
    metadata.qualities.find((quality) => {
      const height = Number(quality.value);
      return Number.isFinite(height) && height < 1080;
    }) ??
    metadata.qualities[0];
  if (defaultQuality) {
    grabQuality.value = defaultQuality.value;
  }

  grabSubtitleOptions.replaceChildren();
  if (metadata.subtitles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "No subtitle tracks found.";
    grabSubtitleOptions.append(empty);
  } else {
    const hasGerman = metadata.subtitles.some((track) => track.language === "de");
    metadata.subtitles.forEach((track) => {
      const id = `subtitle-${track.language.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      const label = document.createElement("label");
      label.className = "checkbox-label";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.dataset.language = track.language;
      input.checked = track.language === "de" || (!hasGerman && track.language === "en");
      input.addEventListener("change", () => applyGrabControlState());

      const span = document.createElement("span");
      span.textContent = track.label;

      label.append(input, span);
      grabSubtitleOptions.append(label);
    });
  }

  applyGrabControlState();
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

async function chooseVideo(target: HTMLInputElement, workflow: Workflow, defaultPath?: string) {
  const selected = await open({
    multiple: false,
    directory: false,
    defaultPath: defaultPath || undefined,
    filters: [{ name: "Video", extensions: ["mkv", "mp4", "mov", "m4v", "webm"] }],
  });
  if (typeof selected === "string") {
    target.value = selected;
    renderMaterialSelection();
    setActiveWorkflow(workflow);
    setStatus({
      status: "idle",
      phase: "inspect",
      message: workflow === "dialogue" ? "Ready to prepare" : "Ready to transcode",
    });
  }
}

async function chooseSubtitleProject() {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Dialogue project", extensions: ["json"] }],
  });
  if (typeof selected === "string") {
    subtitleProjectPath.value = selected;
    refreshSubtitleControls();
    await loadSubtitleProject(selected);
  }
}

async function chooseDirectory() {
  const selected = await open({
    multiple: false,
    directory: true,
  });
  if (typeof selected === "string") {
    setGrabOutputDir(selected);
    setActiveWorkflow("grabber");
    setStatus({
      status: "idle",
      phase: "fetch",
      message: "Ready to download",
    });
    applyGrabControlState();
  }
}

dialogueTab.addEventListener("click", () => setActiveWorkflow("dialogue"));
subtitlesTab.addEventListener("click", () => setActiveWorkflow("subtitles"));
processingTab.addEventListener("click", () => {
  setActiveWorkflow("processing");
  void loadMaterialGallery();
});
grabberTab.addEventListener("click", () => setActiveWorkflow("grabber"));
dialogueBrowseButton.addEventListener("click", () => chooseVideo(dialogueVideoPath, "dialogue"));
subtitleProjectBrowseButton.addEventListener("click", () => void chooseSubtitleProject());
subtitleLoadButton.addEventListener("click", () => void loadSubtitleProject());
subtitleProjectPath.addEventListener("input", () => refreshSubtitleControls());
subtitleSaveButton.addEventListener("click", async () => {
  try {
    await saveSubtitleProject();
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
});
subtitleRenderButton.addEventListener("click", () => void commitSubtitleProject());
subtitlePreviewButton.addEventListener("click", () => void buildSubtitlePreviewProxy());
subtitlePlayKeptButton.addEventListener("click", async () => {
  if (!subtitlePreviewReady) {
    return;
  }
  const selected = selectedSegment();
  if (selected && segmentEnabled(selected)) {
    subtitlePreviewVideo.currentTime = selected.start;
  } else {
    jumpToNextEnabledSegment(0);
  }
  await subtitlePreviewVideo.play();
});
selectedSegmentEnabled.addEventListener("change", applySelectedSegmentControls);
selectedSegmentStart.addEventListener("change", applySelectedSegmentControls);
selectedSegmentEnd.addEventListener("change", applySelectedSegmentControls);
selectedSegmentDropButton.addEventListener("click", () => {
  selectedSegmentEnabled.checked = false;
  applySelectedSegmentControls();
});
subtitleTimelineTrack.addEventListener("click", (event) => {
  if (!subtitleProject) {
    return;
  }
  const time = timeFromTimelinePointer(event);
  const index = findSegmentIndexAtTime(time);
  if (index >= 0) {
    selectSubtitleSegment(index, false);
  }
  if (subtitlePreviewReady) {
    subtitlePreviewVideo.currentTime = time;
  }
});
subtitlePreviewVideo.addEventListener("loadedmetadata", () => {
  updateTimelineDuration();
  renderSubtitleTimeline();
});
subtitlePreviewVideo.addEventListener("timeupdate", () => {
  enforceSkipPlayback();
  updateTimelinePlayhead();
});
subtitlePreviewVideo.addEventListener("error", () => {
  if (!subtitlePreviewVideo.currentSrc) {
    return;
  }
  subtitlePreviewTitle.textContent = "Preview failed to load";
  subtitleRunMessage.textContent = "Rebuild the preview MP4";
  subtitlePreviewReady = false;
  refreshSubtitleControls();
});
processingBrowseButton.addEventListener("click", () =>
  chooseVideo(processingVideoPath, "processing", grabOutputDir.value.trim()),
);
grabOutputBrowseButton.addEventListener("click", () => chooseDirectory());
grabOutputDir.addEventListener("input", () => {
  grabberOutputPath.textContent = grabOutputDir.value.trim();
  applyGrabControlState();
});
grabOutputDir.addEventListener("change", () => void loadMaterialGallery());
materialRefreshButton.addEventListener("click", () => void loadMaterialGallery());
grabUrl.addEventListener("input", () => {
  resetGrabMetadata();
  setStatus({
    status: "idle",
    phase: "fetch",
    message: grabUrl.value.trim() ? "Start to load options" : "Paste a URL to begin",
  });
});
grabQuality.addEventListener("change", () => applyGrabControlState());

slowSpeed.addEventListener("input", () => updateSpeed(slowSpeed.value));
slowSpeedRange.addEventListener("input", () => updateSpeed(slowSpeedRange.value));
presetButtons.forEach((button) => {
  button.addEventListener("click", () => updateSpeed(button.dataset.speed ?? "0.50"));
});

dialoguePrepareButton.addEventListener("click", async () => {
  setActiveWorkflow("dialogue");
  runningWorkflow = "dialogue";
  logOutput.textContent = "";
  pendingPreparedProjectPath = "";
  try {
    const expectedProject = await invoke<string>("start_project_prepare", {
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
    pendingPreparedProjectPath = expectedProject;
    subtitleProjectPath.value = expectedProject;
    dialogueOutputPath.textContent = expectedProject;
    refreshSubtitleControls();
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
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

async function inspectGrabUrl() {
  setActiveWorkflow("grabber");
  runningWorkflow = "grabber";
  logOutput.textContent = "";
  resetGrabMetadata();
  try {
    const metadata = await invoke<GrabMetadata>("probe_grab", {
      options: {
        url: grabUrl.value.trim(),
      },
    });
    grabMetadata = metadata;
    renderGrabMetadata(metadata);
    setStatus({
      status: "idle",
      phase: "download",
      message: "Choose quality and subtitle tracks",
    });
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  } finally {
    applyGrabControlState();
  }
}

async function downloadGrabSelection() {
  setActiveWorkflow("grabber");
  runningWorkflow = "grabber";
  logOutput.textContent = "";
  try {
    const subtitleLanguages = selectedSubtitleLanguages();
    const downloadVideo = shouldDownloadVideo();
    const downloadSubtitles = subtitleLanguages.length > 0;
    const outputDir = await invoke<string>("start_grab", {
      options: {
        url: grabUrl.value.trim(),
        outputDir: grabOutputDir.value.trim(),
        downloadVideo,
        downloadSubtitles,
        quality: grabQuality.value,
        subtitleLanguages: subtitleLanguages.join(","),
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
}

grabberStartButton.addEventListener("click", async () => {
  if (grabMetadata) {
    await downloadGrabSelection();
  } else {
    await inspectGrabUrl();
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
subtitleStopButton.addEventListener("click", stopCurrentRun);
processingStopButton.addEventListener("click", stopCurrentRun);
grabberStopButton.addEventListener("click", stopCurrentRun);

listen<ConversionLog>("conversion-log", ({ payload }) => appendLog(payload));
listen<ConversionStatus>("conversion-state", ({ payload }) => setStatus(payload));
listen<RuntimeStatus>("runtime-state", ({ payload }) => setRuntimeStatus(payload));
setActiveWorkflow(activeWorkflow);
setStatus(currentStatus);
renderSubtitleStats();
updateSelectedSegmentControls();
renderSubtitleTimeline();
updateSpeed(slowSpeed.value);
invoke<string>("get_default_grab_output_dir")
  .then((path) => {
    if (!grabOutputDir.value.trim()) {
      setGrabOutputDir(path);
    }
  })
  .catch((error) => appendLog({ stream: "stderr", line: String(error) }));
invoke<RuntimeStatus>("get_runtime_status")
  .then(setRuntimeStatus)
  .catch((error) =>
    setRuntimeStatus({ ready: false, message: String(error) }),
  );
