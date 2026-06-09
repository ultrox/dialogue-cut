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
  Save,
  Scissors,
  Settings2,
  SkipBack,
  SkipForward,
  Square,
  Terminal,
  Trash2,
  createIcons,
} from "lucide";

type Workflow = "dialogue" | "review" | "processing" | "grabber";

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

type ReviewCue = {
  id?: string;
  start?: number;
  end?: number;
  text?: string;
  class?: string;
  review?: boolean;
  reviewReasons?: string[];
};

type ReviewSegment = {
  id: string;
  start: number;
  end: number;
  enabled?: boolean;
  source?: string;
  text?: string;
  classes?: string[];
  review?: boolean;
  reviewReasons?: string[];
  duration?: number;
  cues?: ReviewCue[];
  incidentalCues?: ReviewCue[];
  manualEdit?: boolean;
};

type ReviewProject = {
  video: string;
  segments: ReviewSegment[];
  [key: string]: unknown;
};

type ReviewProjectData = {
  projectPath: string;
  videoPath: string;
  previewPath: string;
  previewReady: boolean;
  outputPath: string;
  project: ReviewProject;
};

type ReviewPreviewState = "idle" | "preparing" | "ready" | "error";

const workflowPhases: Record<Workflow, readonly (readonly [string, string])[]> = {
  dialogue: [
    ["setup", "Prepare runtime"],
    ["prepare", "Normalize source"],
    ["inspect", "Inspect source"],
    ["extract", "Extract audio"],
    ["transcribe", "Transcribe German"],
    ["filter", "Filter dialogue"],
    ["render", "Render segments"],
    ["stitch", "Stitch MP4"],
  ],
  review: [
    ["setup", "Prepare tools"],
    ["preview", "Prepare preview"],
    ["render", "Render edited cut"],
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
let reviewProject: ReviewProject | null = null;
let reviewProjectPathValue = "";
let reviewOutputPathValue = "";
let reviewPreviewReady = false;
let reviewPreviewState: ReviewPreviewState = "idle";
let selectedSegmentIndex = -1;
let reviewDirty = false;
let reviewPlaybackMode: "idle" | "segment" | "cut" = "idle";

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
        <button id="review-tab" class="tab-button" type="button">
          <i data-lucide="scissors"></i>
          <span>Segment review</span>
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

      <div id="review-panel" class="tab-panel">
        <section class="section-block source-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Project</span>
              <h2>Review automatic segments</h2>
            </div>
            <i data-lucide="scissors"></i>
          </div>
          <div class="input-action-row">
            <input id="review-project-path" type="text" placeholder="/path/to/movie.dialogue-project.json" spellcheck="false" />
            <button id="review-browse-button" class="icon-button" type="button" title="Choose project">
              <i data-lucide="folder-open"></i>
            </button>
            <button id="review-load-button" class="primary-button" type="button">
              <i data-lucide="play"></i>
              <span>Load</span>
            </button>
          </div>
          <p id="review-run-message" class="inline-status">Choose a dialogue project JSON</p>
          <div class="action-row source-action-row">
            <button id="review-save-button" class="primary-button" type="button" disabled>
              <i data-lucide="save"></i>
              <span>Save project</span>
            </button>
            <button id="review-render-button" class="primary-button" type="button" disabled>
              <i data-lucide="play"></i>
              <span>Render saved cut</span>
            </button>
            <button id="review-stop-button" class="secondary-button" type="button" disabled>
              <i data-lucide="square"></i>
              <span>Cancel</span>
            </button>
          </div>
          <p id="review-output-path" class="output-path"></p>
        </section>

        <section class="section-block review-editor-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Preview</span>
              <h2 id="review-selection-title">No segment selected</h2>
            </div>
            <span id="review-dirty-chip" class="runtime-chip ready">Saved</span>
          </div>
          <div class="review-grid">
            <div class="review-player-pane">
              <div class="review-video-shell">
                <video id="review-video" class="review-video" controls preload="metadata"></video>
                <div id="review-preview-overlay" class="review-preview-overlay">Load a project to prepare preview</div>
              </div>
              <div class="review-player-actions">
                <button id="review-prepare-preview-button" class="secondary-button" type="button" disabled>
                  <i data-lucide="refresh-cw"></i>
                  <span>Prepare preview</span>
                </button>
                <button id="review-prev-button" class="secondary-button" type="button" disabled>
                  <i data-lucide="skip-back"></i>
                  <span>Previous</span>
                </button>
                <button id="review-preview-button" class="primary-button" type="button" disabled>
                  <i data-lucide="play"></i>
                  <span>Preview segment</span>
                </button>
                <button id="review-play-cut-button" class="primary-button" type="button" disabled>
                  <i data-lucide="play"></i>
                  <span>Play kept cut</span>
                </button>
                <button id="review-next-button" class="secondary-button" type="button" disabled>
                  <i data-lucide="skip-forward"></i>
                  <span>Next</span>
                </button>
              </div>
              <div class="review-stats">
                <span><strong id="review-total-duration">0:00</strong><small>Kept runtime</small></span>
                <span><strong id="review-kept-count">0</strong><small>Kept</small></span>
                <span><strong id="review-dropped-count">0</strong><small>Dropped</small></span>
                <span><strong id="review-marked-count">0</strong><small>Marked</small></span>
              </div>
            </div>

            <div class="segment-edit-pane">
              <div class="segment-text" id="review-segment-text">Load a project to begin.</div>
              <div class="segment-time-grid">
                <label>
                  <span>Start</span>
                  <div class="number-field"><input id="review-start" type="number" min="0" step="0.05" value="0" disabled /><em>s</em></div>
                </label>
                <label>
                  <span>End</span>
                  <div class="number-field"><input id="review-end" type="number" min="0" step="0.05" value="0" disabled /><em>s</em></div>
                </label>
              </div>
              <div class="segment-button-grid">
                <button id="review-set-start-button" class="secondary-button" type="button" disabled>Set start</button>
                <button id="review-set-end-button" class="secondary-button" type="button" disabled>Set end</button>
                <button id="review-trim-start-back-button" class="secondary-button" type="button" disabled>Start -0.25s</button>
                <button id="review-trim-start-forward-button" class="secondary-button" type="button" disabled>Start +0.25s</button>
                <button id="review-trim-end-back-button" class="secondary-button" type="button" disabled>End -0.25s</button>
                <button id="review-trim-end-forward-button" class="secondary-button" type="button" disabled>End +0.25s</button>
              </div>
              <div class="action-row">
                <button id="review-toggle-button" class="secondary-button" type="button" disabled>
                  <i data-lucide="trash-2"></i>
                  <span>Drop segment</span>
                </button>
                <button id="review-split-button" class="secondary-button" type="button" disabled>
                  <i data-lucide="scissors"></i>
                  <span>Split here</span>
                </button>
              </div>
            </div>
          </div>
          <div id="review-timeline" class="review-timeline"></div>
        </section>

        <section class="section-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Segments</span>
              <h2>Automatic cut list</h2>
            </div>
            <i data-lucide="file-text"></i>
          </div>
          <div id="review-segment-list" class="review-segment-list">
            <p class="empty-note">No project loaded.</p>
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
          <p id="processing-run-message" class="inline-status">Choose a video file to begin</p>
          <div class="action-row source-action-row">
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
    Save,
    Scissors,
    Settings2,
    SkipBack,
    SkipForward,
    Square,
    Terminal,
    Trash2,
  },
});

const dialogueTab = document.querySelector<HTMLButtonElement>("#dialogue-tab")!;
const reviewTab = document.querySelector<HTMLButtonElement>("#review-tab")!;
const processingTab = document.querySelector<HTMLButtonElement>("#processing-tab")!;
const grabberTab = document.querySelector<HTMLButtonElement>("#grabber-tab")!;
const dialoguePanel = document.querySelector<HTMLElement>("#dialogue-panel")!;
const reviewPanel = document.querySelector<HTMLElement>("#review-panel")!;
const processingPanel = document.querySelector<HTMLElement>("#processing-panel")!;
const grabberPanel = document.querySelector<HTMLElement>("#grabber-panel")!;
const dialogueVideoPath = document.querySelector<HTMLInputElement>("#dialogue-video-path")!;
const reviewProjectPath = document.querySelector<HTMLInputElement>("#review-project-path")!;
const processingVideoPath = document.querySelector<HTMLInputElement>("#processing-video-path")!;
const grabUrl = document.querySelector<HTMLInputElement>("#grab-url")!;
const grabOutputDir = document.querySelector<HTMLInputElement>("#grab-output-dir")!;
const dialogueBrowseButton = document.querySelector<HTMLButtonElement>("#dialogue-browse-button")!;
const reviewBrowseButton = document.querySelector<HTMLButtonElement>("#review-browse-button")!;
const reviewLoadButton = document.querySelector<HTMLButtonElement>("#review-load-button")!;
const processingBrowseButton = document.querySelector<HTMLButtonElement>("#processing-browse-button")!;
const grabOutputBrowseButton = document.querySelector<HTMLButtonElement>(
  "#grab-output-browse-button",
)!;
const dialogueStartButton = document.querySelector<HTMLButtonElement>("#dialogue-start-button")!;
const reviewSaveButton = document.querySelector<HTMLButtonElement>("#review-save-button")!;
const reviewRenderButton = document.querySelector<HTMLButtonElement>("#review-render-button")!;
const processingStartButton = document.querySelector<HTMLButtonElement>("#processing-start-button")!;
const grabberStartButton = document.querySelector<HTMLButtonElement>("#grabber-start-button")!;
const grabberActionLabel = document.querySelector<HTMLElement>("#grabber-action-label")!;
const materialRefreshButton = document.querySelector<HTMLButtonElement>("#material-refresh-button")!;
const dialogueStopButton = document.querySelector<HTMLButtonElement>("#dialogue-stop-button")!;
const reviewStopButton = document.querySelector<HTMLButtonElement>("#review-stop-button")!;
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
const reviewRunMessage = document.querySelector<HTMLElement>("#review-run-message")!;
const processingRunMessage = document.querySelector<HTMLElement>("#processing-run-message")!;
const grabberRunMessage = document.querySelector<HTMLElement>("#grabber-run-message")!;
const dialogueOutputPath = document.querySelector<HTMLElement>("#dialogue-output-path")!;
const reviewOutputPath = document.querySelector<HTMLElement>("#review-output-path")!;
const processingOutputPath = document.querySelector<HTMLElement>("#processing-output-path")!;
const grabberOutputPath = document.querySelector<HTMLElement>("#grabber-output-path")!;
const materialGallery = document.querySelector<HTMLElement>("#material-gallery")!;
const reviewVideo = document.querySelector<HTMLVideoElement>("#review-video")!;
const reviewPreviewOverlay = document.querySelector<HTMLElement>("#review-preview-overlay")!;
const reviewSelectionTitle = document.querySelector<HTMLElement>("#review-selection-title")!;
const reviewDirtyChip = document.querySelector<HTMLElement>("#review-dirty-chip")!;
const reviewPreparePreviewButton = document.querySelector<HTMLButtonElement>(
  "#review-prepare-preview-button",
)!;
const reviewPrevButton = document.querySelector<HTMLButtonElement>("#review-prev-button")!;
const reviewPreviewButton = document.querySelector<HTMLButtonElement>("#review-preview-button")!;
const reviewPlayCutButton = document.querySelector<HTMLButtonElement>("#review-play-cut-button")!;
const reviewNextButton = document.querySelector<HTMLButtonElement>("#review-next-button")!;
const reviewTotalDuration = document.querySelector<HTMLElement>("#review-total-duration")!;
const reviewKeptCount = document.querySelector<HTMLElement>("#review-kept-count")!;
const reviewDroppedCount = document.querySelector<HTMLElement>("#review-dropped-count")!;
const reviewMarkedCount = document.querySelector<HTMLElement>("#review-marked-count")!;
const reviewSegmentText = document.querySelector<HTMLElement>("#review-segment-text")!;
const reviewStartInput = document.querySelector<HTMLInputElement>("#review-start")!;
const reviewEndInput = document.querySelector<HTMLInputElement>("#review-end")!;
const reviewSetStartButton = document.querySelector<HTMLButtonElement>("#review-set-start-button")!;
const reviewSetEndButton = document.querySelector<HTMLButtonElement>("#review-set-end-button")!;
const reviewTrimStartBackButton = document.querySelector<HTMLButtonElement>(
  "#review-trim-start-back-button",
)!;
const reviewTrimStartForwardButton = document.querySelector<HTMLButtonElement>(
  "#review-trim-start-forward-button",
)!;
const reviewTrimEndBackButton = document.querySelector<HTMLButtonElement>("#review-trim-end-back-button")!;
const reviewTrimEndForwardButton = document.querySelector<HTMLButtonElement>(
  "#review-trim-end-forward-button",
)!;
const reviewToggleButton = document.querySelector<HTMLButtonElement>("#review-toggle-button")!;
const reviewSplitButton = document.querySelector<HTMLButtonElement>("#review-split-button")!;
const reviewTimeline = document.querySelector<HTMLElement>("#review-timeline")!;
const reviewSegmentList = document.querySelector<HTMLElement>("#review-segment-list")!;
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
  reviewTab.classList.toggle("active", workflow === "review");
  processingTab.classList.toggle("active", workflow === "processing");
  grabberTab.classList.toggle("active", workflow === "grabber");
  dialoguePanel.classList.toggle("active", workflow === "dialogue");
  reviewPanel.classList.toggle("active", workflow === "review");
  processingPanel.classList.toggle("active", workflow === "processing");
  grabberPanel.classList.toggle("active", workflow === "grabber");
  renderPhases();
}

function setRunControls(running: boolean) {
  dialogueStartButton.disabled = running;
  reviewLoadButton.disabled = running;
  reviewRenderButton.disabled = running || !reviewProject || reviewDirty;
  reviewSaveButton.disabled = running || !reviewProject || !reviewDirty;
  reviewPreparePreviewButton.disabled =
    running || !reviewProject || reviewPreviewState === "preparing" || reviewPreviewState === "ready";
  processingStartButton.disabled = running;
  dialogueStopButton.disabled = !running;
  reviewStopButton.disabled = !running;
  processingStopButton.disabled = !running;
  grabberStopButton.disabled = !running;
  dialogueBrowseButton.disabled = running;
  reviewBrowseButton.disabled = running;
  processingBrowseButton.disabled = running;
  grabOutputBrowseButton.disabled = running;
  materialRefreshButton.disabled = running;
  applyGrabControlState(running);
}

function workflowForStatus(): Workflow {
  return runningWorkflow ?? activeWorkflow;
}

function workflowStatusElements(workflow: Workflow): { runMessage: HTMLElement; outputPath: HTMLElement } {
  switch (workflow) {
    case "dialogue":
      return { runMessage: dialogueRunMessage, outputPath: dialogueOutputPath };
    case "review":
      return { runMessage: reviewRunMessage, outputPath: reviewOutputPath };
    case "processing":
      return { runMessage: processingRunMessage, outputPath: processingOutputPath };
    case "grabber":
      return { runMessage: grabberRunMessage, outputPath: grabberOutputPath };
  }
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

  const { runMessage, outputPath } = workflowStatusElements(workflow);
  runMessage.textContent = status.message;
  if (workflow === "review" && status.phase === "preview") {
    if (status.status === "running") {
      setReviewPreviewState("preparing", status.message);
    } else if (status.status === "complete") {
      reviewPreviewOverlay.textContent = status.message;
    } else if (status.status === "error") {
      setReviewPreviewState("error", status.message);
    }
  } else if (workflow === "review" && status.status === "error" && reviewPreviewState === "preparing") {
    setReviewPreviewState("error", status.message);
  }
  const displayedOutput =
    workflow === "review" && status.phase === "preview"
      ? reviewOutputPathValue
      : status.outputPath ?? (workflow === "grabber" ? grabOutputDir.value.trim() : "");
  outputPath.textContent = displayedOutput;
  setRunControls(running);
  renderPhases();
  if (workflow === "grabber" && status.status === "complete" && status.message === "Material is ready") {
    void loadMaterialGallery();
  }
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

function formatRuntime(duration: number): string {
  const totalSeconds = Math.max(0, Math.round(duration));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatTimecode(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const fraction = Math.round((safe - Math.floor(safe)) * 10);
  const base =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`
      : `${minutes}:${String(wholeSeconds).padStart(2, "0")}`;
  return `${base}.${fraction}`;
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isSegmentEnabled(segment: ReviewSegment): boolean {
  return segment.enabled !== false && segment.end > segment.start;
}

function segmentDuration(segment: ReviewSegment): number {
  return Math.max(0, segment.end - segment.start);
}

function selectedSegment(): ReviewSegment | null {
  if (!reviewProject || selectedSegmentIndex < 0) {
    return null;
  }
  return reviewProject.segments[selectedSegmentIndex] ?? null;
}

function segmentNeedsReview(segment: ReviewSegment): boolean {
  return Boolean(
    segment.review ||
      segment.reviewReasons?.length ||
      segment.source !== "dialogue" ||
      segment.classes?.some((value) => value !== "dialogue"),
  );
}

function segmentBadgeText(segment: ReviewSegment): string {
  if (!isSegmentEnabled(segment)) {
    return "Dropped";
  }
  if (segmentNeedsReview(segment)) {
    return "Marked";
  }
  return segment.source ?? "dialogue";
}

function segmentTranscript(segment: ReviewSegment): string {
  return segment.text || segment.cues?.map((cue) => cue.text).filter(Boolean).join(" ") || "";
}

function setReviewDirty(dirty: boolean) {
  reviewDirty = dirty;
  reviewDirtyChip.className = dirty ? "runtime-chip" : "runtime-chip ready";
  reviewDirtyChip.textContent = dirty ? "Unsaved" : "Saved";
  setRunControls(currentStatus.status === "running");
}

function updateSegmentDuration(segment: ReviewSegment) {
  segment.start = roundTime(Math.max(0, segment.start));
  segment.end = roundTime(Math.max(segment.start, segment.end));
  segment.duration = roundTime(segmentDuration(segment));
  segment.manualEdit = true;
}

function enabledSegmentIndices(): number[] {
  if (!reviewProject) {
    return [];
  }
  return reviewProject.segments
    .map((segment, index) => (isSegmentEnabled(segment) ? index : -1))
    .filter((index) => index >= 0);
}

function nearestEnabledSegmentIndex(fromIndex: number): number {
  const indices = enabledSegmentIndices();
  if (indices.length === 0) {
    return -1;
  }
  return indices.find((index) => index >= fromIndex) ?? indices[0];
}

function uniqueSegmentId(base: string): string {
  const existing = new Set(reviewProject?.segments.map((segment) => segment.id));
  if (!existing.has(base)) {
    return base;
  }
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function setReviewMessage(message: string) {
  reviewRunMessage.textContent = message;
}

function setReviewPreviewState(state: ReviewPreviewState, message?: string) {
  reviewPreviewState = state;
  reviewPreviewReady = state === "ready";
  reviewPreviewOverlay.hidden = state === "ready";
  reviewPreviewOverlay.textContent =
    message ??
    (state === "preparing"
      ? "Preparing browser-safe preview..."
      : state === "error"
        ? "Preview failed. Check the process log, then retry."
        : state === "idle"
          ? "Load a project to prepare preview"
          : "");
  reviewPreparePreviewButton.disabled =
    !reviewProject || currentStatus.status === "running" || state === "preparing" || state === "ready";
  const label = reviewPreparePreviewButton.querySelector("span");
  if (label) {
    label.textContent = state === "error" ? "Retry preview" : "Prepare preview";
  }
}

function setReviewVideoSource(path: string) {
  setReviewPreviewState("ready");
  reviewVideo.src = convertFileSrc(path);
  reviewVideo.load();
  reviewVideo.addEventListener(
    "loadedmetadata",
    () => {
      const segment = selectedSegment();
      if (segment) {
        reviewVideo.currentTime = segment.start;
      }
    },
    { once: true },
  );
  renderReview();
}

function renderReviewStats() {
  const segments = reviewProject?.segments ?? [];
  const kept = segments.filter(isSegmentEnabled);
  const dropped = segments.length - kept.length;
  const marked = segments.filter(segmentNeedsReview).length;
  const totalDuration = kept.reduce((total, segment) => total + segmentDuration(segment), 0);

  reviewTotalDuration.textContent = formatRuntime(totalDuration);
  reviewKeptCount.textContent = String(kept.length);
  reviewDroppedCount.textContent = String(dropped);
  reviewMarkedCount.textContent = String(marked);
}

function renderReviewTimeline() {
  reviewTimeline.replaceChildren();
  if (!reviewProject || reviewProject.segments.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "No segments.";
    reviewTimeline.append(empty);
    return;
  }

  for (const [index, segment] of reviewProject.segments.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "timeline-segment",
      isSegmentEnabled(segment) ? "kept" : "dropped",
      segmentNeedsReview(segment) ? "marked" : "",
      index === selectedSegmentIndex ? "active" : "",
    ]
      .filter(Boolean)
      .join(" ");
    button.style.flexGrow = String(Math.max(1, segmentDuration(segment)));
    button.title = `${segment.id} ${formatTimecode(segment.start)} -> ${formatTimecode(segment.end)}`;
    button.addEventListener("click", () => selectReviewSegment(index));
    reviewTimeline.append(button);
  }
}

function renderReviewSegmentList() {
  reviewSegmentList.replaceChildren();
  if (!reviewProject || reviewProject.segments.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "No project loaded.";
    reviewSegmentList.append(empty);
    return;
  }

  for (const [index, segment] of reviewProject.segments.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "review-segment-row",
      isSegmentEnabled(segment) ? "kept" : "dropped",
      segmentNeedsReview(segment) ? "marked" : "",
      index === selectedSegmentIndex ? "active" : "",
    ]
      .filter(Boolean)
      .join(" ");
    button.addEventListener("click", () => selectReviewSegment(index));

    const meta = document.createElement("span");
    meta.className = "segment-row-meta";
    const id = document.createElement("strong");
    id.textContent = segment.id;
    const timing = document.createElement("small");
    timing.textContent = `${formatTimecode(segment.start)} -> ${formatTimecode(segment.end)} | ${formatRuntime(segmentDuration(segment))}`;
    meta.append(id, timing);

    const text = document.createElement("span");
    text.className = "segment-row-text";
    text.textContent = segmentTranscript(segment);

    const badge = document.createElement("span");
    badge.className = "segment-row-badge";
    badge.textContent = segmentBadgeText(segment);

    button.append(meta, text, badge);
    reviewSegmentList.append(button);
  }
}

function renderReviewSelection() {
  const segment = selectedSegment();
  const hasSegment = Boolean(segment);
  const running = currentStatus.status === "running";
  reviewPreparePreviewButton.disabled =
    !reviewProject || running || reviewPreviewState === "preparing" || reviewPreviewState === "ready";
  reviewPrevButton.disabled = !reviewProject || selectedSegmentIndex <= 0;
  reviewNextButton.disabled = !reviewProject || selectedSegmentIndex >= (reviewProject?.segments.length ?? 0) - 1;
  reviewPreviewButton.disabled = !hasSegment || running || reviewPreviewState === "preparing";
  reviewPlayCutButton.disabled = !reviewPreviewReady || enabledSegmentIndices().length === 0;
  reviewStartInput.disabled = !hasSegment || running;
  reviewEndInput.disabled = !hasSegment || running;
  reviewSetStartButton.disabled = !hasSegment || running;
  reviewSetEndButton.disabled = !hasSegment || running;
  reviewTrimStartBackButton.disabled = !hasSegment || running;
  reviewTrimStartForwardButton.disabled = !hasSegment || running;
  reviewTrimEndBackButton.disabled = !hasSegment || running;
  reviewTrimEndForwardButton.disabled = !hasSegment || running;
  reviewToggleButton.disabled = !hasSegment || running;
  reviewSplitButton.disabled = !hasSegment || running;

  if (!segment) {
    reviewSelectionTitle.textContent = "No segment selected";
    reviewSegmentText.textContent = reviewProject ? "No segment selected." : "Load a project to begin.";
    reviewStartInput.value = "0";
    reviewEndInput.value = "0";
    return;
  }

  reviewSelectionTitle.textContent = `${segment.id} | ${formatRuntime(segmentDuration(segment))}`;
  reviewSegmentText.textContent = segmentTranscript(segment) || "(no transcript text)";
  reviewStartInput.value = segment.start.toFixed(3);
  reviewEndInput.value = segment.end.toFixed(3);
  const toggleLabel = reviewToggleButton.querySelector("span");
  if (toggleLabel) {
    toggleLabel.textContent = isSegmentEnabled(segment) ? "Drop segment" : "Keep segment";
  }
}

function renderReview() {
  renderReviewStats();
  renderReviewSelection();
  renderReviewTimeline();
  renderReviewSegmentList();
  setRunControls(currentStatus.status === "running");
}

function selectReviewSegment(index: number, seek = true) {
  if (!reviewProject || reviewProject.segments.length === 0) {
    selectedSegmentIndex = -1;
    renderReview();
    return;
  }
  selectedSegmentIndex = Math.min(Math.max(index, 0), reviewProject.segments.length - 1);
  const segment = selectedSegment();
  if (seek && segment && reviewPreviewReady) {
    reviewPlaybackMode = "idle";
    reviewVideo.currentTime = segment.start;
  }
  renderReview();
}

function updateSelectedBounds(start: number, end: number, seekToStart = false) {
  const segment = selectedSegment();
  if (!segment) {
    return;
  }
  const maxDuration = Number.isFinite(reviewVideo.duration) ? reviewVideo.duration : Number.MAX_SAFE_INTEGER;
  const safeStart = Math.max(0, Math.min(start, maxDuration));
  const safeEnd = Math.max(safeStart + 0.05, Math.min(end, maxDuration));
  segment.start = roundTime(safeStart);
  segment.end = roundTime(safeEnd);
  updateSegmentDuration(segment);
  setReviewDirty(true);
  if (seekToStart) {
    reviewVideo.currentTime = segment.start;
  }
  renderReview();
}

function nudgeSelectedBounds(startDelta: number, endDelta: number) {
  const segment = selectedSegment();
  if (!segment) {
    return;
  }
  updateSelectedBounds(segment.start + startDelta, segment.end + endDelta, true);
}

function toggleSelectedSegment() {
  const segment = selectedSegment();
  if (!segment) {
    return;
  }
  segment.enabled = !isSegmentEnabled(segment);
  updateSegmentDuration(segment);
  setReviewDirty(true);
  renderReview();
}

function splitSelectedSegment() {
  const segment = selectedSegment();
  if (!reviewProject || !segment) {
    return;
  }
  const splitAt = roundTime(reviewVideo.currentTime);
  if (splitAt <= segment.start + 0.1 || splitAt >= segment.end - 0.1) {
    setReviewMessage("Move the playhead inside the segment before splitting.");
    return;
  }

  const left: ReviewSegment = structuredClone(segment);
  const right: ReviewSegment = structuredClone(segment);
  left.id = uniqueSegmentId(`${segment.id}-a`);
  right.id = uniqueSegmentId(`${segment.id}-b`);
  left.end = splitAt;
  right.start = splitAt;
  updateSegmentDuration(left);
  updateSegmentDuration(right);
  reviewProject.segments.splice(selectedSegmentIndex, 1, left, right);
  selectedSegmentIndex += 1;
  setReviewDirty(true);
  setReviewMessage("Segment split.");
  renderReview();
}

function firstReviewSegmentIndex(project: ReviewProject): number {
  const marked = project.segments.findIndex(segmentNeedsReview);
  if (marked >= 0) {
    return marked;
  }
  const kept = project.segments.findIndex(isSegmentEnabled);
  return kept >= 0 ? kept : project.segments.length > 0 ? 0 : -1;
}

async function prepareReviewPreview() {
  if (!reviewProjectPathValue) {
    return;
  }
  runningWorkflow = "review";
  setReviewPreviewState("preparing", "Preparing browser-safe preview...");
  setRunControls(true);
  try {
    const previewPath = await invoke<string>("start_review_proxy", {
      options: { projectPath: reviewProjectPathValue },
    });
    setReviewVideoSource(previewPath);
  } catch (error) {
    setReviewPreviewState("error", String(error));
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
}

async function loadReviewProject() {
  const path = reviewProjectPath.value.trim();
  if (!path) {
    setReviewMessage("Choose a dialogue project JSON first.");
    return;
  }
  setActiveWorkflow("review");
  try {
    const data = await invoke<ReviewProjectData>("load_review_project", {
      options: { projectPath: path },
    });
    reviewProject = data.project;
    reviewProjectPathValue = data.projectPath;
    reviewOutputPathValue = data.outputPath;
    reviewPreviewReady = data.previewReady;
    reviewProjectPath.value = data.projectPath;
    reviewOutputPath.textContent = data.outputPath;
    selectedSegmentIndex = firstReviewSegmentIndex(data.project);
    if (data.previewReady) {
      setReviewVideoSource(data.previewPath);
    } else {
      reviewVideo.removeAttribute("src");
      reviewVideo.load();
      setReviewPreviewState("idle", "Project source is not browser-playable. Rerun Dialogue cut or prepare preview.");
    }
    setReviewDirty(false);
    setStatus({
      status: "idle",
      phase: "render",
      message: data.previewReady ? "Project loaded" : "Project loaded without playable source",
      outputPath: data.outputPath,
    });
    renderReview();
    if (selectedSegmentIndex >= 0) {
      selectReviewSegment(selectedSegmentIndex);
    }
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
}

async function chooseReviewProject() {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Dialogue project", extensions: ["json"] }],
  });
  if (typeof selected === "string") {
    reviewProjectPath.value = selected;
    await loadReviewProject();
  }
}

async function saveReviewProject() {
  if (!reviewProject) {
    return;
  }
  try {
    await invoke("save_review_project", {
      options: {
        projectPath: reviewProjectPathValue || reviewProjectPath.value.trim(),
        project: reviewProject,
      },
    });
    setReviewDirty(false);
    setReviewMessage("Project saved.");
    renderReview();
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
}

function playReviewSegment() {
  const segment = selectedSegment();
  if (!segment) {
    return;
  }
  if (!reviewPreviewReady) {
    setReviewMessage("Preview is still being prepared.");
    return;
  }
  reviewPlaybackMode = "segment";
  reviewVideo.currentTime = segment.start;
  void reviewVideo.play();
}

function playReviewCut() {
  if (!reviewPreviewReady) {
    setReviewMessage("Preview is still being prepared.");
    return;
  }
  const nextIndex = nearestEnabledSegmentIndex(selectedSegmentIndex < 0 ? 0 : selectedSegmentIndex);
  if (nextIndex < 0) {
    return;
  }
  selectedSegmentIndex = nextIndex;
  const segment = selectedSegment();
  if (!segment) {
    return;
  }
  reviewPlaybackMode = "cut";
  reviewVideo.currentTime = segment.start;
  renderReview();
  void reviewVideo.play();
}

function handleReviewPlayback() {
  const segment = selectedSegment();
  if (!segment || reviewPlaybackMode === "idle") {
    return;
  }
  if (reviewVideo.currentTime < segment.end) {
    return;
  }

  if (reviewPlaybackMode === "segment") {
    reviewVideo.currentTime = segment.start;
    void reviewVideo.play();
    return;
  }

  const enabled = enabledSegmentIndices();
  if (enabled.length === 0) {
    reviewVideo.pause();
    reviewPlaybackMode = "idle";
    return;
  }
  const currentEnabledIndex = enabled.indexOf(selectedSegmentIndex);
  const nextIndex = enabled[(currentEnabledIndex + 1) % enabled.length] ?? enabled[0];
  selectedSegmentIndex = nextIndex;
  const nextSegment = selectedSegment();
  if (!nextSegment) {
    return;
  }
  reviewVideo.currentTime = nextSegment.start;
  renderReview();
  void reviewVideo.play();
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
      message: workflow === "dialogue" ? "Ready to convert" : "Ready to transcode",
    });
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

function projectPathFromDialogueOutput(outputPath: string): string | null {
  if (outputPath.endsWith(".dialogue-only.mp4")) {
    return outputPath.slice(0, -".dialogue-only.mp4".length) + ".dialogue-project.json";
  }
  return null;
}

dialogueTab.addEventListener("click", () => setActiveWorkflow("dialogue"));
reviewTab.addEventListener("click", () => setActiveWorkflow("review"));
processingTab.addEventListener("click", () => {
  setActiveWorkflow("processing");
  void loadMaterialGallery();
});
grabberTab.addEventListener("click", () => setActiveWorkflow("grabber"));
dialogueBrowseButton.addEventListener("click", () => chooseVideo(dialogueVideoPath, "dialogue"));
reviewBrowseButton.addEventListener("click", () => void chooseReviewProject());
reviewLoadButton.addEventListener("click", () => void loadReviewProject());
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

reviewProjectPath.addEventListener("input", () => {
  if (reviewProjectPath.value.trim() !== reviewProjectPathValue) {
    reviewProject = null;
    selectedSegmentIndex = -1;
    reviewOutputPathValue = "";
    reviewOutputPath.textContent = "";
    reviewVideo.removeAttribute("src");
    reviewVideo.load();
    setReviewPreviewState("idle", "Load the selected project to prepare preview");
    setReviewDirty(false);
    setReviewMessage(reviewProjectPath.value.trim() ? "Load the selected project" : "Choose a dialogue project JSON");
    renderReview();
  }
});
reviewSaveButton.addEventListener("click", () => void saveReviewProject());
reviewPreparePreviewButton.addEventListener("click", () => void prepareReviewPreview());
reviewPrevButton.addEventListener("click", () => selectReviewSegment(selectedSegmentIndex - 1));
reviewNextButton.addEventListener("click", () => selectReviewSegment(selectedSegmentIndex + 1));
reviewPreviewButton.addEventListener("click", () => playReviewSegment());
reviewPlayCutButton.addEventListener("click", () => playReviewCut());
reviewStartInput.addEventListener("change", () =>
  updateSelectedBounds(Number(reviewStartInput.value), Number(reviewEndInput.value), true),
);
reviewEndInput.addEventListener("change", () =>
  updateSelectedBounds(Number(reviewStartInput.value), Number(reviewEndInput.value), true),
);
reviewSetStartButton.addEventListener("click", () => {
  const segment = selectedSegment();
  if (segment) {
    updateSelectedBounds(reviewVideo.currentTime, segment.end, true);
  }
});
reviewSetEndButton.addEventListener("click", () => {
  const segment = selectedSegment();
  if (segment) {
    updateSelectedBounds(segment.start, reviewVideo.currentTime, true);
  }
});
reviewTrimStartBackButton.addEventListener("click", () => nudgeSelectedBounds(-0.25, 0));
reviewTrimStartForwardButton.addEventListener("click", () => nudgeSelectedBounds(0.25, 0));
reviewTrimEndBackButton.addEventListener("click", () => nudgeSelectedBounds(0, -0.25));
reviewTrimEndForwardButton.addEventListener("click", () => nudgeSelectedBounds(0, 0.25));
reviewToggleButton.addEventListener("click", () => toggleSelectedSegment());
reviewSplitButton.addEventListener("click", () => splitSelectedSegment());
reviewVideo.addEventListener("timeupdate", () => handleReviewPlayback());
reviewVideo.addEventListener("pause", () => {
  reviewPlaybackMode = "idle";
});
reviewVideo.addEventListener("error", () => {
  if (reviewVideo.currentSrc) {
    setReviewPreviewState("error", "Preview file could not be played. Retry preview.");
    renderReview();
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
    const projectPath = projectPathFromDialogueOutput(expectedOutput);
    if (projectPath) {
      reviewProjectPath.value = projectPath;
      reviewProjectPathValue = "";
    }
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
});

reviewRenderButton.addEventListener("click", async () => {
  if (!reviewProject) {
    return;
  }
  setActiveWorkflow("review");
  runningWorkflow = "review";
  logOutput.textContent = "";
  try {
    const expectedOutput = await invoke<string>("start_review_render", {
      options: {
        projectPath: reviewProjectPathValue || reviewProjectPath.value.trim(),
        outputPath: reviewOutputPathValue,
      },
    });
    reviewOutputPath.textContent = expectedOutput;
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
reviewStopButton.addEventListener("click", stopCurrentRun);
processingStopButton.addEventListener("click", stopCurrentRun);
grabberStopButton.addEventListener("click", stopCurrentRun);

listen<ConversionLog>("conversion-log", ({ payload }) => appendLog(payload));
listen<ConversionStatus>("conversion-state", ({ payload }) => setStatus(payload));
listen<RuntimeStatus>("runtime-state", ({ payload }) => setRuntimeStatus(payload));
setActiveWorkflow(activeWorkflow);
setStatus(currentStatus);
updateSpeed(slowSpeed.value);
renderReview();
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
