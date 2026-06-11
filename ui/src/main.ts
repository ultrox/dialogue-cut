import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowRightLeft,
  Captions,
  CheckCircle2,
  Circle,
  FileText,
  Film,
  FolderOpen,
  HardDriveDownload,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  SkipBack,
  SkipForward,
  Square,
  Terminal,
  Trash2,
  createIcons,
} from "lucide";

// Workflows that run backend jobs and report status/output into a run block.
type JobWorkflow = "dialogue" | "processing" | "converter" | "transcribe" | "grabber";
type Workflow = JobWorkflow | "player";

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

type ConversionProgress = {
  percent?: number;
  detail: string;
};

type WhisperModel = {
  id: string;
  label: string;
  sizeMb: number;
  downloaded: boolean;
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
  converter: [
    ["setup", "Prepare tools"],
    ["inspect", "Inspect source"],
    ["convert", "Convert to MP4"],
  ],
  transcribe: [
    ["setup", "Prepare runtime"],
    ["extract", "Extract audio"],
    ["transcribe", "Transcribe speech"],
    ["collect", "Write subtitles"],
  ],
  grabber: [
    ["setup", "Prepare downloader"],
    ["fetch", "Fetch metadata"],
    ["download", "Download material"],
    ["subtitles", "Save subtitles"],
  ],
  // The player is interactive; it has no pipeline.
  player: [],
};

const app = document.querySelector<HTMLDivElement>("#app")!;
let activeWorkflow: Workflow = "dialogue";
let runningWorkflow: JobWorkflow | null = null;
let currentStatus: ConversionStatus = {
  status: "idle",
  phase: "inspect",
  message: "Choose a movie file to begin",
};
let grabMetadata: GrabMetadata | null = null;
let materialGalleryLoadId = 0;

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
        <button id="converter-tab" class="tab-button" type="button">
          <i data-lucide="arrow-right-left"></i>
          <span>Converter</span>
        </button>
        <button id="transcribe-tab" class="tab-button" type="button">
          <i data-lucide="captions"></i>
          <span>Transcription</span>
        </button>
        <button id="player-tab" class="tab-button" type="button">
          <i data-lucide="play"></i>
          <span>Player</span>
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
          <div id="processing-progress" class="progress-track" hidden>
            <span id="processing-progress-fill"></span>
          </div>
          <p id="processing-progress-detail" class="field-note"></p>
          <p id="processing-output-path" class="output-path"></p>
        </section>
      </div>

      <div id="converter-panel" class="tab-panel">
        <section class="section-block source-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Source</span>
              <h2>Select a video</h2>
            </div>
            <i data-lucide="file-text"></i>
          </div>
          <div class="file-row">
            <input id="converter-video-path" type="text" placeholder="/path/to/movie.mkv" spellcheck="false" />
            <button id="converter-browse-button" class="icon-button" type="button" title="Choose video">
              <i data-lucide="folder-open"></i>
            </button>
          </div>
        </section>

        <section class="section-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Output profile</span>
              <h2>MP4 conversion</h2>
            </div>
            <i data-lucide="settings-2"></i>
          </div>
          <div class="preset-row">
            <button class="convert-mode-button preset-button active" type="button" data-mode="reencode">Re-encode H.264/AAC</button>
            <button class="convert-mode-button preset-button" type="button" data-mode="remux">Fast remux</button>
          </div>
          <p id="converter-mode-note" class="field-note"></p>
        </section>

        <section class="section-block run-block">
          <div class="section-heading compact">
            <div>
              <span class="eyebrow">Run</span>
              <h2 id="converter-run-message">Choose a video file to begin</h2>
            </div>
          </div>
          <div class="action-row">
            <button id="converter-start-button" class="primary-button" type="button">
              <i data-lucide="play"></i>
              <span>Start conversion</span>
            </button>
            <button id="converter-stop-button" class="secondary-button" type="button" disabled>
              <i data-lucide="square"></i>
              <span>Cancel</span>
            </button>
          </div>
          <div id="converter-progress" class="progress-track" hidden>
            <span id="converter-progress-fill"></span>
          </div>
          <p id="converter-progress-detail" class="field-note"></p>
          <p id="converter-output-path" class="output-path"></p>
        </section>
      </div>

      <div id="transcribe-panel" class="tab-panel">
        <section class="section-block source-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Source</span>
              <h2>Select a video or audio file</h2>
            </div>
            <i data-lucide="file-text"></i>
          </div>
          <div class="file-row">
            <input id="transcribe-video-path" type="text" placeholder="/path/to/movie.mkv" spellcheck="false" />
            <button id="transcribe-browse-button" class="icon-button" type="button" title="Choose file">
              <i data-lucide="folder-open"></i>
            </button>
          </div>
        </section>

        <section class="section-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Transcript profile</span>
              <h2>Whisper transcription</h2>
            </div>
            <i data-lucide="settings-2"></i>
          </div>
          <div class="metadata-grid">
            <div class="stacked-fields">
              <label>
                <span>Spoken language</span>
                <select id="transcribe-language">
                  <option value="de" selected>German</option>
                  <option value="en">English</option>
                  <option value="auto">Detect automatically</option>
                </select>
              </label>
              <div>
                <span class="field-label">Whisper model</span>
                <select id="transcribe-model"></select>
                <div class="model-actions">
                  <button id="transcribe-model-download" class="secondary-button" type="button" disabled>
                    <i data-lucide="hard-drive-download"></i>
                    <span>Download</span>
                  </button>
                  <button id="transcribe-model-delete" class="secondary-button" type="button" disabled>
                    <i data-lucide="trash-2"></i>
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            </div>
            <div>
              <span class="field-label">Output files</span>
              <div class="subtitle-options">
                <label class="checkbox-label">
                  <input type="checkbox" class="transcribe-format" data-format="srt" checked />
                  <span>SRT subtitles</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" class="transcribe-format" data-format="vtt" checked />
                  <span>VTT subtitles</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" class="transcribe-format" data-format="txt" checked />
                  <span>Plain text transcript</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" class="transcribe-format" data-format="json" />
                  <span>JSON (raw Whisper output)</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" class="transcribe-format" data-format="tsv" />
                  <span>TSV (timestamp table)</span>
                </label>
              </div>
            </div>
          </div>
          <p class="field-note">The selected files are written beside the source file.</p>
        </section>

        <section class="section-block run-block">
          <div class="section-heading compact">
            <div>
              <span class="eyebrow">Run</span>
              <h2 id="transcribe-run-message">Choose a file to begin</h2>
            </div>
          </div>
          <div class="action-row">
            <button id="transcribe-start-button" class="primary-button" type="button">
              <i data-lucide="play"></i>
              <span>Start transcription</span>
            </button>
            <button id="transcribe-stop-button" class="secondary-button" type="button" disabled>
              <i data-lucide="square"></i>
              <span>Cancel</span>
            </button>
          </div>
          <div id="transcribe-progress" class="progress-track" hidden>
            <span id="transcribe-progress-fill"></span>
          </div>
          <p id="transcribe-progress-detail" class="field-note"></p>
          <p id="transcribe-output-path" class="output-path"></p>
        </section>
      </div>

      <div id="player-panel" class="tab-panel">
        <section class="section-block source-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Source</span>
              <h2>Select a video and subtitles</h2>
            </div>
            <i data-lucide="file-text"></i>
          </div>
          <div class="file-row">
            <input id="player-video-path" type="text" placeholder="/path/to/movie.mp4" spellcheck="false" />
            <button id="player-video-browse" class="icon-button" type="button" title="Choose video">
              <i data-lucide="folder-open"></i>
            </button>
          </div>
          <div class="file-row subtitle-row">
            <select id="player-subtitle"></select>
            <button id="player-subtitle-browse" class="icon-button" type="button" title="Choose subtitle file">
              <i data-lucide="folder-open"></i>
            </button>
          </div>
          <p id="player-note" class="field-note"></p>
        </section>

        <section class="section-block">
          <video id="player-video" class="player-video" controls preload="metadata"></video>
          <div class="player-controls">
            <label class="player-offset">
              <span>Jump offset</span>
              <div class="number-field">
                <input id="player-offset" type="number" min="0" max="5" step="0.1" value="0.5" />
                <em>s</em>
              </div>
            </label>
            <div class="preset-row player-offset-presets">
              <button class="offset-preset preset-button" type="button" data-offset="0">0s</button>
              <button class="offset-preset preset-button active" type="button" data-offset="0.5">0.5s</button>
              <button class="offset-preset preset-button" type="button" data-offset="1">1s</button>
              <button class="offset-preset preset-button" type="button" data-offset="2">2s</button>
            </div>
            <div class="cue-nav">
              <button id="player-prev-cue" class="secondary-button" type="button" title="Previous cue">
                <i data-lucide="skip-back"></i>
              </button>
              <button id="player-replay-cue" class="secondary-button" type="button" title="Replay cue">
                <i data-lucide="rotate-ccw"></i>
              </button>
              <button id="player-next-cue" class="secondary-button" type="button" title="Next cue">
                <i data-lucide="skip-forward"></i>
              </button>
            </div>
            <label class="checkbox-label follow-toggle">
              <input id="player-follow" type="checkbox" checked />
              <span>Follow playback</span>
            </label>
          </div>
        </section>

        <section class="section-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Subtitles</span>
              <h2 id="player-cue-count">No cues loaded</h2>
            </div>
            <i data-lucide="captions"></i>
          </div>
          <div id="player-cues" class="cue-list">
            <p class="empty-note">Choose a video to load its subtitles.</p>
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
    ArrowRightLeft,
    Captions,
    CheckCircle2,
    Circle,
    FileText,
    Film,
    FolderOpen,
    HardDriveDownload,
    LoaderCircle,
    Play,
    RefreshCw,
    RotateCcw,
    Settings2,
    SkipBack,
    SkipForward,
    Square,
    Terminal,
    Trash2,
  },
});

function byId<T extends HTMLElement>(id: string): T {
  return document.querySelector<T>(`#${id}`)!;
}

const workflowTabs: Record<Workflow, HTMLButtonElement> = {
  dialogue: byId("dialogue-tab"),
  processing: byId("processing-tab"),
  converter: byId("converter-tab"),
  transcribe: byId("transcribe-tab"),
  player: byId("player-tab"),
  grabber: byId("grabber-tab"),
};
const workflowPanels: Record<Workflow, HTMLElement> = {
  dialogue: byId("dialogue-panel"),
  processing: byId("processing-panel"),
  converter: byId("converter-panel"),
  transcribe: byId("transcribe-panel"),
  player: byId("player-panel"),
  grabber: byId("grabber-panel"),
};
const workflowRunMessages: Record<JobWorkflow, HTMLElement> = {
  dialogue: byId("dialogue-run-message"),
  processing: byId("processing-run-message"),
  converter: byId("converter-run-message"),
  transcribe: byId("transcribe-run-message"),
  grabber: byId("grabber-run-message"),
};
const workflowOutputPaths: Record<JobWorkflow, HTMLElement> = {
  dialogue: byId("dialogue-output-path"),
  processing: byId("processing-output-path"),
  converter: byId("converter-output-path"),
  transcribe: byId("transcribe-output-path"),
  grabber: byId("grabber-output-path"),
};

const dialogueVideoPath = byId<HTMLInputElement>("dialogue-video-path");
const processingVideoPath = byId<HTMLInputElement>("processing-video-path");
const converterVideoPath = byId<HTMLInputElement>("converter-video-path");
const transcribeVideoPath = byId<HTMLInputElement>("transcribe-video-path");
const grabUrl = byId<HTMLInputElement>("grab-url");
const grabOutputDir = byId<HTMLInputElement>("grab-output-dir");
const dialogueBrowseButton = byId<HTMLButtonElement>("dialogue-browse-button");
const processingBrowseButton = byId<HTMLButtonElement>("processing-browse-button");
const converterBrowseButton = byId<HTMLButtonElement>("converter-browse-button");
const transcribeBrowseButton = byId<HTMLButtonElement>("transcribe-browse-button");
const grabOutputBrowseButton = byId<HTMLButtonElement>("grab-output-browse-button");
const dialogueStartButton = byId<HTMLButtonElement>("dialogue-start-button");
const processingStartButton = byId<HTMLButtonElement>("processing-start-button");
const converterStartButton = byId<HTMLButtonElement>("converter-start-button");
const transcribeStartButton = byId<HTMLButtonElement>("transcribe-start-button");
const grabberStartButton = byId<HTMLButtonElement>("grabber-start-button");
const grabberActionLabel = byId<HTMLElement>("grabber-action-label");
const materialRefreshButton = byId<HTMLButtonElement>("material-refresh-button");
const dialogueStopButton = byId<HTMLButtonElement>("dialogue-stop-button");
const processingStopButton = byId<HTMLButtonElement>("processing-stop-button");
const converterStopButton = byId<HTMLButtonElement>("converter-stop-button");
const transcribeStopButton = byId<HTMLButtonElement>("transcribe-stop-button");
const grabberStopButton = byId<HTMLButtonElement>("grabber-stop-button");
const forceTranscribe = byId<HTMLInputElement>("force-transcribe");
const transcribeLanguage = byId<HTMLSelectElement>("transcribe-language");
const transcribeModel = byId<HTMLSelectElement>("transcribe-model");
const transcribeModelDownloadButton = byId<HTMLButtonElement>("transcribe-model-download");
const transcribeModelDeleteButton = byId<HTMLButtonElement>("transcribe-model-delete");
const converterModeNote = byId<HTMLElement>("converter-mode-note");
const playerVideoPath = byId<HTMLInputElement>("player-video-path");
const playerVideoBrowse = byId<HTMLButtonElement>("player-video-browse");
const playerSubtitle = byId<HTMLSelectElement>("player-subtitle");
const playerSubtitleBrowse = byId<HTMLButtonElement>("player-subtitle-browse");
const playerNote = byId<HTMLElement>("player-note");
const playerVideo = byId<HTMLVideoElement>("player-video");
const playerOffsetInput = byId<HTMLInputElement>("player-offset");
const playerFollow = byId<HTMLInputElement>("player-follow");
const playerPrevCue = byId<HTMLButtonElement>("player-prev-cue");
const playerReplayCue = byId<HTMLButtonElement>("player-replay-cue");
const playerNextCue = byId<HTMLButtonElement>("player-next-cue");
const playerCueCount = byId<HTMLElement>("player-cue-count");
const playerCueList = byId<HTMLElement>("player-cues");
const offsetPresetButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".offset-preset"),
);
type ProgressElements = {
  track: HTMLElement;
  fill: HTMLElement;
  detail: HTMLElement;
};

// Workflows whose backend reports ffmpeg progress.
const workflowProgress: Partial<Record<Workflow, ProgressElements>> = {
  processing: {
    track: byId("processing-progress"),
    fill: byId("processing-progress-fill"),
    detail: byId("processing-progress-detail"),
  },
  converter: {
    track: byId("converter-progress"),
    fill: byId("converter-progress-fill"),
    detail: byId("converter-progress-detail"),
  },
  transcribe: {
    track: byId("transcribe-progress"),
    fill: byId("transcribe-progress-fill"),
    detail: byId("transcribe-progress-detail"),
  },
};
const grabberMetadataSection = document.querySelector<HTMLElement>("#grabber-metadata-section")!;
const grabberTitle = document.querySelector<HTMLElement>("#grabber-title")!;
const grabberMetaLine = document.querySelector<HTMLElement>("#grabber-meta-line")!;
const grabQuality = document.querySelector<HTMLSelectElement>("#grab-quality")!;
const grabSubtitleOptions = document.querySelector<HTMLElement>("#grab-subtitle-options")!;
const statusChip = document.querySelector<HTMLElement>("#status-chip")!;
const materialGallery = document.querySelector<HTMLElement>("#material-gallery")!;
const logOutput = document.querySelector<HTMLElement>("#log-output")!;
const phaseList = document.querySelector<HTMLOListElement>("#phase-list")!;
const runtimeChip = document.querySelector<HTMLElement>("#runtime-chip")!;
const runtimeMessage = document.querySelector<HTMLElement>("#runtime-message")!;
const slowSpeed = document.querySelector<HTMLInputElement>("#slow-speed")!;
const slowSpeedRange = document.querySelector<HTMLInputElement>("#slow-speed-range")!;
const presetButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("#processing-panel .preset-button"),
);
const convertModeButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".convert-mode-button"),
);

const convertModeNotes: Record<string, string> = {
  reencode: "Most compatible for editing. Re-encodes everything, so it takes a while.",
  remux: "Copies the video stream into MP4 and converts audio to AAC. Fast, but editors may struggle with HEVC/AV1 sources.",
};
let convertMode = "reencode";

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
  const workflow = runningWorkflow ?? activeWorkflow;
  const activeIndex = phaseIndex(currentStatus.phase);
  phaseList.innerHTML = phases
    .map(([id, label], index) => {
      let display = label;
      if (workflow === "transcribe" && id === "transcribe") {
        const model = selectedWhisperModel();
        if (model) {
          display = `${label} (${shortModelName(model)})`;
        }
      }
      const complete = currentStatus.status === "complete" || index < activeIndex;
      const active = currentStatus.status === "running" && index === activeIndex;
      const icon = complete ? "check-circle-2" : active ? "loader-circle" : "circle";
      const state = complete ? "complete" : active ? "active" : "pending";
      return `<li class="${state}"><i data-lucide="${icon}"></i><span>${display}</span></li>`;
    })
    .join("");
  createIcons({ icons: { CheckCircle2, Circle, LoaderCircle } });
}

function setActiveWorkflow(workflow: Workflow) {
  activeWorkflow = workflow;
  for (const [name, tab] of Object.entries(workflowTabs)) {
    tab.classList.toggle("active", name === workflow);
  }
  for (const [name, panel] of Object.entries(workflowPanels)) {
    panel.classList.toggle("active", name === workflow);
  }
  renderPhases();
}

function setRunControls(running: boolean) {
  dialogueStartButton.disabled = running;
  processingStartButton.disabled = running;
  converterStartButton.disabled = running;
  transcribeStartButton.disabled = running;
  dialogueStopButton.disabled = !running;
  processingStopButton.disabled = !running;
  converterStopButton.disabled = !running;
  transcribeStopButton.disabled = !running;
  grabberStopButton.disabled = !running;
  dialogueBrowseButton.disabled = running;
  processingBrowseButton.disabled = running;
  converterBrowseButton.disabled = running;
  transcribeBrowseButton.disabled = running;
  grabOutputBrowseButton.disabled = running;
  materialRefreshButton.disabled = running;
  applyGrabControlState(running);
  updateTranscribeModelControls(running);
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

  if (workflow !== "player") {
    workflowRunMessages[workflow].textContent = status.message;
    workflowOutputPaths[workflow].textContent =
      status.outputPath ?? (workflow === "grabber" ? grabOutputDir.value.trim() : "");
  }
  if (!running) {
    resetRunProgress();
  }
  setRunControls(running);
  renderPhases();
  if (workflow === "grabber" && status.status === "complete" && status.message === "Material is ready") {
    void loadMaterialGallery();
  }
  if (workflow === "transcribe" && status.status === "complete" && status.message === "Whisper model is ready") {
    void loadWhisperModels();
  }
  if (!running) {
    runningWorkflow = null;
  }
}

function resetRunProgress() {
  for (const elements of Object.values(workflowProgress)) {
    elements.track.hidden = true;
    elements.fill.style.width = "0%";
    elements.detail.textContent = "";
  }
}

function updateRunProgress(progress: ConversionProgress) {
  const elements = workflowProgress[workflowForStatus()];
  if (!elements) {
    return;
  }
  elements.track.hidden = false;
  if (typeof progress.percent === "number") {
    elements.fill.style.width = `${progress.percent.toFixed(1)}%`;
  }
  elements.detail.textContent = progress.detail;
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
  workflowOutputPaths.grabber.textContent = path;
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

const videoExtensions = ["mkv", "mp4", "mov", "m4v", "webm"];
const audioExtensions = ["mp3", "m4a", "wav", "aac", "flac", "ogg"];

const workflowReadyMessages: Partial<Record<Workflow, string>> = {
  dialogue: "Ready to convert",
  processing: "Ready to transcode",
  converter: "Ready to convert",
  transcribe: "Ready to transcribe",
};

async function chooseVideo(
  target: HTMLInputElement,
  workflow: Workflow,
  defaultPath?: string,
  extensions: string[] = videoExtensions,
) {
  const selected = await open({
    multiple: false,
    directory: false,
    defaultPath: defaultPath || undefined,
    filters: [{ name: "Media", extensions }],
  });
  if (typeof selected === "string") {
    target.value = selected;
    renderMaterialSelection();
    setActiveWorkflow(workflow);
    setStatus({
      status: "idle",
      phase: "inspect",
      message: workflowReadyMessages[workflow] ?? "Ready",
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

workflowTabs.dialogue.addEventListener("click", () => setActiveWorkflow("dialogue"));
workflowTabs.processing.addEventListener("click", () => {
  setActiveWorkflow("processing");
  void loadMaterialGallery();
});
workflowTabs.converter.addEventListener("click", () => setActiveWorkflow("converter"));
workflowTabs.transcribe.addEventListener("click", () => setActiveWorkflow("transcribe"));
workflowTabs.player.addEventListener("click", () => setActiveWorkflow("player"));
workflowTabs.grabber.addEventListener("click", () => setActiveWorkflow("grabber"));
dialogueBrowseButton.addEventListener("click", () => chooseVideo(dialogueVideoPath, "dialogue"));
processingBrowseButton.addEventListener("click", () =>
  chooseVideo(processingVideoPath, "processing", grabOutputDir.value.trim()),
);
converterBrowseButton.addEventListener("click", () => chooseVideo(converterVideoPath, "converter"));
transcribeBrowseButton.addEventListener("click", () =>
  chooseVideo(transcribeVideoPath, "transcribe", undefined, [
    ...videoExtensions,
    ...audioExtensions,
  ]),
);
grabOutputBrowseButton.addEventListener("click", () => chooseDirectory());
grabOutputDir.addEventListener("input", () => {
  workflowOutputPaths.grabber.textContent = grabOutputDir.value.trim();
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

function updateConvertMode(mode: string) {
  convertMode = mode;
  convertModeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  converterModeNote.textContent = convertModeNotes[mode] ?? "";
}

convertModeButtons.forEach((button) => {
  button.addEventListener("click", () => updateConvertMode(button.dataset.mode ?? "reencode"));
});

// Shared lifecycle for every start button: focus the workflow, clear the log,
// invoke the backend command, and show its expected output path (or the error).
async function startRun(workflow: JobWorkflow, command: string, options: Record<string, unknown>) {
  setActiveWorkflow(workflow);
  runningWorkflow = workflow;
  logOutput.textContent = "";
  try {
    const expectedOutput = await invoke<string>(command, { options });
    workflowOutputPaths[workflow].textContent = expectedOutput;
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  }
}

dialogueStartButton.addEventListener("click", () =>
  startRun("dialogue", "start_conversion", {
    videoPath: dialogueVideoPath.value.trim(),
    forceTranscribe: forceTranscribe.checked,
    prePad: numberValue("pre-pad"),
    postPad: numberValue("post-pad"),
    mergeGap: numberValue("merge-gap"),
    keepCueClasses: "dialogue",
    keepSources: "dialogue,mixed",
  }),
);

processingStartButton.addEventListener("click", () =>
  startRun("processing", "start_slowdown", {
    videoPath: processingVideoPath.value.trim(),
    speed: Number(slowSpeed.value),
  }),
);

converterStartButton.addEventListener("click", () =>
  startRun("converter", "start_convert", {
    videoPath: converterVideoPath.value.trim(),
    mode: convertMode,
  }),
);

let whisperModels: WhisperModel[] = [];

function formatModelSize(sizeMb: number): string {
  return sizeMb >= 1000 ? `${(sizeMb / 1000).toFixed(1)} GB` : `${sizeMb} MB`;
}

function selectedWhisperModel(): WhisperModel | undefined {
  return whisperModels.find((model) => model.id === transcribeModel.value);
}

function shortModelName(model: WhisperModel): string {
  return model.label.split(" — ")[0];
}

function updateTranscribeModelControls(running = currentStatus.status === "running") {
  const model = selectedWhisperModel();
  const installed = model?.downloaded ?? false;
  transcribeModelDownloadButton.disabled = running || model === undefined || installed;
  transcribeModelDeleteButton.disabled = running || model === undefined || !installed;
  transcribeModel.disabled = running;
  transcribeStartButton.disabled = running || !installed;
}

function renderWhisperModels() {
  const previous = transcribeModel.value;
  transcribeModel.replaceChildren(
    ...whisperModels.map((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.downloaded
        ? `${model.label} — installed`
        : `${model.label} — ${formatModelSize(model.sizeMb)} download`;
      return option;
    }),
  );
  const fallback =
    whisperModels.find((model) => model.id === previous) ??
    whisperModels.find((model) => model.id.includes("whisper-small")) ??
    whisperModels.find((model) => model.downloaded);
  if (fallback) {
    transcribeModel.value = fallback.id;
  }
  updateTranscribeModelControls();
  renderPhases();
}

async function loadWhisperModels() {
  try {
    whisperModels = await invoke<WhisperModel[]>("list_whisper_models");
    renderWhisperModels();
  } catch (error) {
    appendLog({ stream: "stderr", line: String(error) });
  }
}

function selectedTranscribeFormats(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(".transcribe-format:checked"),
  )
    .map((input) => input.dataset.format ?? "")
    .filter(Boolean);
}

transcribeStartButton.addEventListener("click", () =>
  startRun("transcribe", "start_transcribe", {
    videoPath: transcribeVideoPath.value.trim(),
    language: transcribeLanguage.value,
    model: transcribeModel.value,
    formats: selectedTranscribeFormats(),
  }),
);

transcribeModel.addEventListener("change", () => {
  updateTranscribeModelControls();
  renderPhases();
});
transcribeModelDownloadButton.addEventListener("click", () =>
  startRun("transcribe", "start_model_download", {
    model: transcribeModel.value,
  }),
);
transcribeModelDeleteButton.addEventListener("click", async () => {
  const model = selectedWhisperModel();
  if (!model) {
    return;
  }
  try {
    await invoke("delete_whisper_model", { options: { model: model.id } });
    appendLog({ stream: "stdout", line: `Deleted model ${model.id}` });
    await loadWhisperModels();
  } catch (error) {
    appendLog({ stream: "stderr", line: String(error) });
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
    workflowOutputPaths.grabber.textContent = outputDir;
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

// ---------- Subtitle player ----------

type SubtitleFileEntry = { path: string; fileName: string };
type SubtitleCue = { start: number; end: number; text: string };

let playerCues: SubtitleCue[] = [];
let playerCueButtons: HTMLButtonElement[] = [];
let playerActiveCue = -1;
let playerOffset = 0.5;

function parseSubtitleTimestamp(raw: string): number | null {
  const match = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4].padEnd(3, "0"));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

// Handles both SRT and WebVTT: blocks separated by blank lines, one
// "start --> end" timing line per block, optional index line and cue settings.
function parseSubtitles(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = content.replace(/^﻿/, "").replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) {
      continue;
    }
    const [rawStart, rawRest] = lines[timingIndex].split("-->");
    const start = parseSubtitleTimestamp(rawStart ?? "");
    const end = parseSubtitleTimestamp(rawRest?.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null) {
      continue;
    }
    const text = lines
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .trim();
    if (text) {
      cues.push({ start, end, text });
    }
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function formatCueTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function cueIndexAt(time: number): number {
  let low = 0;
  let high = playerCues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (playerCues[mid].start <= time) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate >= 0 && time <= playerCues[candidate].end + 0.05) {
    return candidate;
  }
  return -1;
}

function seekToCue(index: number) {
  const cue = playerCues[index];
  if (!cue) {
    return;
  }
  playerVideo.currentTime = Math.max(0, cue.start - playerOffset);
  void playerVideo.play();
}

function setActivePlayerCue(index: number) {
  if (index === playerActiveCue) {
    return;
  }
  playerCueButtons[playerActiveCue]?.classList.remove("active");
  playerActiveCue = index;
  const button = playerCueButtons[index];
  if (button) {
    button.classList.add("active");
    if (playerFollow.checked) {
      // Keep the active cue pinned to the top of the scroll window so the
      // upcoming dialogue is always visible below it.
      playerCueList.scrollTo({ top: button.offsetTop, behavior: "smooth" });
    }
  }
}

function renderPlayerCues() {
  playerCueList.replaceChildren();
  playerCueButtons = [];
  playerActiveCue = -1;
  if (playerCues.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "No cues found in the selected subtitles.";
    playerCueList.append(empty);
    playerCueCount.textContent = "No cues loaded";
    return;
  }
  playerCueCount.textContent = `${playerCues.length} cues`;
  playerCues.forEach((cue, index) => {
    const button = document.createElement("button");
    button.className = "cue-row";
    button.type = "button";
    button.addEventListener("click", () => seekToCue(index));

    const time = document.createElement("span");
    time.className = "cue-time";
    time.textContent = `${formatCueTime(cue.start)} → ${formatCueTime(cue.end)}`;
    const text = document.createElement("span");
    text.className = "cue-text";
    text.textContent = cue.text;

    button.append(time, text);
    playerCueList.append(button);
    playerCueButtons.push(button);
  });
}

async function loadPlayerSubtitleFile(path: string) {
  try {
    const content = await invoke<string>("read_subtitle_file", { options: { path } });
    playerCues = parseSubtitles(content);
    renderPlayerCues();
  } catch (error) {
    playerCues = [];
    renderPlayerCues();
    playerCueCount.textContent = "Could not load subtitles";
    appendLog({ stream: "stderr", line: String(error) });
  }
}

function addPlayerSubtitleOption(entry: SubtitleFileEntry, select = false) {
  const option = document.createElement("option");
  option.value = entry.path;
  option.textContent = entry.fileName;
  playerSubtitle.append(option);
  if (select) {
    playerSubtitle.value = entry.path;
  }
}

async function loadPlayerSubtitleOptions(videoPath: string) {
  playerSubtitle.replaceChildren();
  const entries = await invoke<SubtitleFileEntry[]>("list_subtitle_files", {
    options: { videoPath },
  });
  entries.forEach((entry, index) => addPlayerSubtitleOption(entry, index === 0));
  if (entries.length > 0) {
    await loadPlayerSubtitleFile(entries[0].path);
  } else {
    playerCues = [];
    renderPlayerCues();
    playerCueCount.textContent = "No subtitles found beside the video";
  }
}

async function loadPlayerVideo(path: string) {
  playerVideoPath.value = path;
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  playerNote.textContent = ["mp4", "m4v", "mov"].includes(extension)
    ? ""
    : "This container may not play in the built-in player; convert it to MP4 in the Converter tab first.";
  try {
    // Streamed over a local HTTP server; the asset protocol cannot handle
    // multi-gigabyte videos on macOS.
    playerVideo.src = await invoke<string>("serve_media", { options: { path } });
  } catch (error) {
    playerNote.textContent = String(error);
  }
}

async function choosePlayerVideo() {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Video", extensions: videoExtensions }],
  });
  if (typeof selected === "string") {
    await loadPlayerVideo(selected);
    await loadPlayerSubtitleOptions(selected);
  }
}

async function choosePlayerSubtitle() {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Subtitles", extensions: ["srt", "vtt"] }],
  });
  if (typeof selected === "string") {
    const fileName = selected.split("/").pop() ?? selected;
    addPlayerSubtitleOption({ path: selected, fileName }, true);
    await loadPlayerSubtitleFile(selected);
  }
}

function updatePlayerOffset(value: string) {
  playerOffset = Math.min(5, Math.max(0, Number(value) || 0));
  playerOffsetInput.value = playerOffset.toFixed(1);
  offsetPresetButtons.forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.offset) === playerOffset);
  });
}

function stepPlayerCue(direction: -1 | 1) {
  if (playerCues.length === 0) {
    return;
  }
  const time = playerVideo.currentTime;
  let target: number;
  if (direction === 1) {
    target = playerCues.findIndex((cue) => cue.start > time + 0.05);
    if (target === -1) {
      return;
    }
  } else {
    // A margin so that pressing back twice moves to the previous cue
    // instead of restarting the current one each time.
    target = playerCues.length - 1;
    while (target >= 0 && playerCues[target].start >= time - 1) {
      target -= 1;
    }
    if (target < 0) {
      target = 0;
    }
  }
  seekToCue(target);
}

playerVideoBrowse.addEventListener("click", () => void choosePlayerVideo());
playerVideoPath.addEventListener("change", () => {
  const path = playerVideoPath.value.trim();
  if (path) {
    void loadPlayerVideo(path);
    void loadPlayerSubtitleOptions(path);
  }
});
playerVideo.addEventListener("error", () => {
  const mediaError = playerVideo.error;
  if (!mediaError) {
    return;
  }
  playerNote.textContent =
    mediaError.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || mediaError.code === MediaError.MEDIA_ERR_DECODE
      ? "This video format is not supported by the built-in player. Convert it to MP4 (H.264/AAC) in the Converter tab first."
      : `Could not play this video (media error ${mediaError.code}).`;
});
playerSubtitleBrowse.addEventListener("click", () => void choosePlayerSubtitle());
playerSubtitle.addEventListener("change", () => {
  if (playerSubtitle.value) {
    void loadPlayerSubtitleFile(playerSubtitle.value);
  }
});
playerOffsetInput.addEventListener("input", () => updatePlayerOffset(playerOffsetInput.value));
offsetPresetButtons.forEach((button) => {
  button.addEventListener("click", () => updatePlayerOffset(button.dataset.offset ?? "0.5"));
});
playerPrevCue.addEventListener("click", () => stepPlayerCue(-1));
playerNextCue.addEventListener("click", () => stepPlayerCue(1));
playerReplayCue.addEventListener("click", () => {
  const index = playerActiveCue >= 0 ? playerActiveCue : cueIndexAt(playerVideo.currentTime);
  if (index >= 0) {
    seekToCue(index);
  }
});
playerVideo.addEventListener("timeupdate", () => {
  setActivePlayerCue(cueIndexAt(playerVideo.currentTime));
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
converterStopButton.addEventListener("click", stopCurrentRun);
transcribeStopButton.addEventListener("click", stopCurrentRun);
grabberStopButton.addEventListener("click", stopCurrentRun);

listen<ConversionLog>("conversion-log", ({ payload }) => appendLog(payload));
listen<ConversionProgress>("conversion-progress", ({ payload }) =>
  updateRunProgress(payload),
);
listen<ConversionStatus>("conversion-state", ({ payload }) => setStatus(payload));
listen<RuntimeStatus>("runtime-state", ({ payload }) => setRuntimeStatus(payload));
setActiveWorkflow(activeWorkflow);
setStatus(currentStatus);
updateSpeed(slowSpeed.value);
updateConvertMode(convertMode);
updatePlayerOffset(playerOffsetInput.value);
void loadWhisperModels();
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
