import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Captions,
  CheckCircle2,
  Circle,
  FileText,
  Film,
  FolderOpen,
  HardDriveDownload,
  ListPlus,
  LoaderCircle,
  Merge,
  Music,
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

type Workflow =
  | "dialogue"
  | "processing"
  | "converter"
  | "audioVideo"
  | "merger"
  | "transcribe"
  | "player"
  | "grabber";
// Since the player gained the dialogue-cut export it runs jobs like the rest.
type JobWorkflow = Workflow;

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
  audioVideo: [
    ["setup", "Prepare tools"],
    ["inspect", "Inspect audio"],
    ["render", "Render MP4"],
  ],
  merger: [
    ["setup", "Prepare tools"],
    ["inspect", "Inspect sources"],
    ["merge", "Merge videos"],
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
  player: [
    ["setup", "Prepare tools"],
    ["render", "Render segments"],
    ["stitch", "Stitch MP4"],
    ["subtitles", "Write subtitles"],
  ],
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
let mergeVideoPaths: string[] = [];

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
        <button id="audio-video-tab" class="tab-button" type="button">
          <i data-lucide="music"></i>
          <span>Audio video</span>
        </button>
        <button id="merger-tab" class="tab-button" type="button">
          <i data-lucide="merge"></i>
          <span>Merger</span>
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

      <div id="audio-video-panel" class="tab-panel">
        <section class="section-block source-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Source</span>
              <h2>Select audio</h2>
            </div>
            <i data-lucide="music"></i>
          </div>
          <div class="file-row">
            <input id="audio-video-audio-path" type="text" placeholder="/path/to/audio.mp3" spellcheck="false" />
            <button id="audio-video-browse-button" class="icon-button" type="button" title="Choose audio">
              <i data-lucide="folder-open"></i>
            </button>
          </div>
        </section>

        <section class="section-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Frame</span>
              <h2>Static background</h2>
            </div>
            <i data-lucide="settings-2"></i>
          </div>
          <div class="metadata-grid">
            <div>
              <span class="field-label">Resolution</span>
              <div class="preset-row frame-preset-row">
                <button class="audio-video-resolution-button preset-button active" type="button" data-resolution="1920x1080">1080p</button>
                <button class="audio-video-resolution-button preset-button" type="button" data-resolution="1280x720">720p</button>
                <button class="audio-video-resolution-button preset-button" type="button" data-resolution="1080x1080">Square</button>
              </div>
            </div>
            <div>
              <span class="field-label">Background</span>
              <div class="color-swatch-row">
                <button class="audio-video-background-button color-swatch-button active" type="button" data-background="111827" title="Charcoal">
                  <span style="background:#111827"></span>
                </button>
                <button class="audio-video-background-button color-swatch-button" type="button" data-background="0f766e" title="Teal">
                  <span style="background:#0f766e"></span>
                </button>
                <button class="audio-video-background-button color-swatch-button" type="button" data-background="7c2d12" title="Copper">
                  <span style="background:#7c2d12"></span>
                </button>
                <button class="audio-video-background-button color-swatch-button" type="button" data-background="f8fafc" title="Light">
                  <span style="background:#f8fafc"></span>
                </button>
              </div>
            </div>
          </div>
        </section>

        <section class="section-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Output</span>
              <h2>Final MP4</h2>
            </div>
            <i data-lucide="file-text"></i>
          </div>
          <div class="file-row">
            <input id="audio-video-output-path" type="text" placeholder="/path/to/audio-video.mp4" spellcheck="false" />
            <button id="audio-video-output-browse-button" class="icon-button" type="button" title="Choose output file">
              <i data-lucide="folder-open"></i>
            </button>
          </div>
        </section>

        <section class="section-block run-block">
          <div class="section-heading compact">
            <div>
              <span class="eyebrow">Run</span>
              <h2 id="audio-video-run-message">Choose an audio file to begin</h2>
            </div>
          </div>
          <div class="action-row">
            <button id="audio-video-start-button" class="primary-button" type="button">
              <i data-lucide="play"></i>
              <span>Create video</span>
            </button>
            <button id="audio-video-stop-button" class="secondary-button" type="button" disabled>
              <i data-lucide="square"></i>
              <span>Cancel</span>
            </button>
          </div>
          <div id="audio-video-progress" class="progress-track" hidden>
            <span id="audio-video-progress-fill"></span>
          </div>
          <p id="audio-video-progress-detail" class="field-note"></p>
          <p id="audio-video-output-display" class="output-path"></p>
        </section>
      </div>

      <div id="merger-panel" class="tab-panel">
        <section class="section-block source-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Source</span>
              <h2>Merge order</h2>
            </div>
            <i data-lucide="list-plus"></i>
          </div>
          <div class="action-row">
            <button id="merger-add-button" class="primary-button" type="button">
              <i data-lucide="list-plus"></i>
              <span>Add videos</span>
            </button>
            <button id="merger-clear-button" class="secondary-button" type="button">
              <i data-lucide="trash-2"></i>
              <span>Clear</span>
            </button>
          </div>
          <div id="merger-file-list" class="merge-file-list">
            <p class="empty-note">No videos selected.</p>
          </div>
        </section>

        <section class="section-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Output</span>
              <h2>Final MP4</h2>
            </div>
            <i data-lucide="file-text"></i>
          </div>
          <div class="file-row">
            <input id="merger-output-path" type="text" placeholder="/path/to/merged.mp4" spellcheck="false" />
            <button id="merger-output-browse-button" class="icon-button" type="button" title="Choose output file">
              <i data-lucide="folder-open"></i>
            </button>
          </div>
        </section>

        <section class="section-block run-block">
          <div class="section-heading compact">
            <div>
              <span class="eyebrow">Run</span>
              <h2 id="merger-run-message">Select at least two videos</h2>
            </div>
          </div>
          <div class="action-row">
            <button id="merger-start-button" class="primary-button" type="button">
              <i data-lucide="play"></i>
              <span>Start merge</span>
            </button>
            <button id="merger-stop-button" class="secondary-button" type="button" disabled>
              <i data-lucide="square"></i>
              <span>Cancel</span>
            </button>
          </div>
          <div id="merger-progress" class="progress-track" hidden>
            <span id="merger-progress-fill"></span>
          </div>
          <p id="merger-progress-detail" class="field-note"></p>
          <p id="merger-output-display" class="output-path"></p>
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
        <section class="section-block player-main">
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
            <div class="player-toggles">
              <label class="checkbox-label">
                <input id="player-dialogue-only" type="checkbox" />
                <span>Dialogue only</span>
              </label>
              <label class="checkbox-label">
                <input id="player-follow" type="checkbox" checked />
                <span>Follow playback</span>
              </label>
            </div>
          </div>
        </section>

        <section class="section-block player-cues-block">
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

        <section class="section-block run-block">
          <div class="section-heading compact">
            <div>
              <span class="eyebrow">Run</span>
              <h2 id="player-run-message">Review the cues, then create the cut</h2>
            </div>
          </div>
          <div class="action-row">
            <button id="player-start-button" class="primary-button" type="button">
              <i data-lucide="play"></i>
              <span>Create dialogue cut</span>
            </button>
            <button id="player-stop-button" class="secondary-button" type="button" disabled>
              <i data-lucide="square"></i>
              <span>Cancel</span>
            </button>
          </div>
          <div id="player-progress" class="progress-track" hidden>
            <span id="player-progress-fill"></span>
          </div>
          <p id="player-progress-detail" class="field-note"></p>
          <p id="player-output-path" class="output-path"></p>
        </section>

        <section class="section-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Source</span>
              <h2>Files</h2>
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
      <section id="pipeline-panel" class="progress-panel">
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
    ArrowDown,
    ArrowRightLeft,
    ArrowUp,
    Captions,
    CheckCircle2,
    Circle,
    FileText,
    Film,
    FolderOpen,
    HardDriveDownload,
    ListPlus,
    LoaderCircle,
    Merge,
    Music,
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
  audioVideo: byId("audio-video-tab"),
  merger: byId("merger-tab"),
  transcribe: byId("transcribe-tab"),
  player: byId("player-tab"),
  grabber: byId("grabber-tab"),
};
const workflowPanels: Record<Workflow, HTMLElement> = {
  dialogue: byId("dialogue-panel"),
  processing: byId("processing-panel"),
  converter: byId("converter-panel"),
  audioVideo: byId("audio-video-panel"),
  merger: byId("merger-panel"),
  transcribe: byId("transcribe-panel"),
  player: byId("player-panel"),
  grabber: byId("grabber-panel"),
};
const workflowRunMessages: Record<JobWorkflow, HTMLElement> = {
  dialogue: byId("dialogue-run-message"),
  processing: byId("processing-run-message"),
  converter: byId("converter-run-message"),
  audioVideo: byId("audio-video-run-message"),
  merger: byId("merger-run-message"),
  transcribe: byId("transcribe-run-message"),
  player: byId("player-run-message"),
  grabber: byId("grabber-run-message"),
};
const workflowOutputPaths: Record<JobWorkflow, HTMLElement> = {
  dialogue: byId("dialogue-output-path"),
  processing: byId("processing-output-path"),
  converter: byId("converter-output-path"),
  audioVideo: byId("audio-video-output-display"),
  merger: byId("merger-output-display"),
  transcribe: byId("transcribe-output-path"),
  player: byId("player-output-path"),
  grabber: byId("grabber-output-path"),
};

const dialogueVideoPath = byId<HTMLInputElement>("dialogue-video-path");
const processingVideoPath = byId<HTMLInputElement>("processing-video-path");
const converterVideoPath = byId<HTMLInputElement>("converter-video-path");
const audioVideoAudioPath = byId<HTMLInputElement>("audio-video-audio-path");
const audioVideoOutputPath = byId<HTMLInputElement>("audio-video-output-path");
const mergerOutputPath = byId<HTMLInputElement>("merger-output-path");
const transcribeVideoPath = byId<HTMLInputElement>("transcribe-video-path");
const grabUrl = byId<HTMLInputElement>("grab-url");
const grabOutputDir = byId<HTMLInputElement>("grab-output-dir");
const dialogueBrowseButton = byId<HTMLButtonElement>("dialogue-browse-button");
const processingBrowseButton = byId<HTMLButtonElement>("processing-browse-button");
const converterBrowseButton = byId<HTMLButtonElement>("converter-browse-button");
const audioVideoBrowseButton = byId<HTMLButtonElement>("audio-video-browse-button");
const audioVideoOutputBrowseButton = byId<HTMLButtonElement>("audio-video-output-browse-button");
const mergerAddButton = byId<HTMLButtonElement>("merger-add-button");
const mergerClearButton = byId<HTMLButtonElement>("merger-clear-button");
const mergerOutputBrowseButton = byId<HTMLButtonElement>("merger-output-browse-button");
const transcribeBrowseButton = byId<HTMLButtonElement>("transcribe-browse-button");
const grabOutputBrowseButton = byId<HTMLButtonElement>("grab-output-browse-button");
const dialogueStartButton = byId<HTMLButtonElement>("dialogue-start-button");
const processingStartButton = byId<HTMLButtonElement>("processing-start-button");
const converterStartButton = byId<HTMLButtonElement>("converter-start-button");
const audioVideoStartButton = byId<HTMLButtonElement>("audio-video-start-button");
const mergerStartButton = byId<HTMLButtonElement>("merger-start-button");
const transcribeStartButton = byId<HTMLButtonElement>("transcribe-start-button");
const grabberStartButton = byId<HTMLButtonElement>("grabber-start-button");
const grabberActionLabel = byId<HTMLElement>("grabber-action-label");
const materialRefreshButton = byId<HTMLButtonElement>("material-refresh-button");
const dialogueStopButton = byId<HTMLButtonElement>("dialogue-stop-button");
const processingStopButton = byId<HTMLButtonElement>("processing-stop-button");
const converterStopButton = byId<HTMLButtonElement>("converter-stop-button");
const audioVideoStopButton = byId<HTMLButtonElement>("audio-video-stop-button");
const mergerStopButton = byId<HTMLButtonElement>("merger-stop-button");
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
const playerDialogueOnly = byId<HTMLInputElement>("player-dialogue-only");
const playerPrevCue = byId<HTMLButtonElement>("player-prev-cue");
const playerReplayCue = byId<HTMLButtonElement>("player-replay-cue");
const playerNextCue = byId<HTMLButtonElement>("player-next-cue");
const playerCueCount = byId<HTMLElement>("player-cue-count");
const playerCueList = byId<HTMLElement>("player-cues");
const playerStartButton = byId<HTMLButtonElement>("player-start-button");
const playerStopButton = byId<HTMLButtonElement>("player-stop-button");
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
  audioVideo: {
    track: byId("audio-video-progress"),
    fill: byId("audio-video-progress-fill"),
    detail: byId("audio-video-progress-detail"),
  },
  merger: {
    track: byId("merger-progress"),
    fill: byId("merger-progress-fill"),
    detail: byId("merger-progress-detail"),
  },
  transcribe: {
    track: byId("transcribe-progress"),
    fill: byId("transcribe-progress-fill"),
    detail: byId("transcribe-progress-detail"),
  },
  player: {
    track: byId("player-progress"),
    fill: byId("player-progress-fill"),
    detail: byId("player-progress-detail"),
  },
};
const grabberMetadataSection = document.querySelector<HTMLElement>("#grabber-metadata-section")!;
const grabberTitle = document.querySelector<HTMLElement>("#grabber-title")!;
const grabberMetaLine = document.querySelector<HTMLElement>("#grabber-meta-line")!;
const grabQuality = document.querySelector<HTMLSelectElement>("#grab-quality")!;
const grabSubtitleOptions = document.querySelector<HTMLElement>("#grab-subtitle-options")!;
const statusChip = document.querySelector<HTMLElement>("#status-chip")!;
const materialGallery = document.querySelector<HTMLElement>("#material-gallery")!;
const mergerFileList = document.querySelector<HTMLElement>("#merger-file-list")!;
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
const audioVideoResolutionButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".audio-video-resolution-button"),
);
const audioVideoBackgroundButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".audio-video-background-button"),
);

const convertModeNotes: Record<string, string> = {
  reencode: "Most compatible for editing. Re-encodes everything, so it takes a while.",
  remux: "Copies the video stream into MP4 and converts audio to AAC. Fast, but editors may struggle with HEVC/AV1 sources.",
};
let convertMode = "reencode";
let audioVideoResolution = "1920x1080";
let audioVideoBackground = "111827";

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
  audioVideoStartButton.disabled = running || !audioVideoAudioPath.value.trim();
  mergerStartButton.disabled = running || mergeVideoPaths.length < 2;
  transcribeStartButton.disabled = running;
  playerStartButton.disabled = running;
  dialogueStopButton.disabled = !running;
  processingStopButton.disabled = !running;
  converterStopButton.disabled = !running;
  audioVideoStopButton.disabled = !running;
  mergerStopButton.disabled = !running;
  transcribeStopButton.disabled = !running;
  playerStopButton.disabled = !running;
  grabberStopButton.disabled = !running;
  dialogueBrowseButton.disabled = running;
  processingBrowseButton.disabled = running;
  converterBrowseButton.disabled = running;
  audioVideoBrowseButton.disabled = running;
  audioVideoOutputBrowseButton.disabled = running;
  audioVideoResolutionButtons.forEach((button) => {
    button.disabled = running;
  });
  audioVideoBackgroundButtons.forEach((button) => {
    button.disabled = running;
  });
  mergerAddButton.disabled = running;
  mergerClearButton.disabled = running || mergeVideoPaths.length === 0;
  mergerOutputBrowseButton.disabled = running;
  transcribeBrowseButton.disabled = running;
  grabOutputBrowseButton.disabled = running;
  materialRefreshButton.disabled = running;
  applyMergeControlState(running);
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

  workflowRunMessages[workflow].textContent = status.message;
  workflowOutputPaths[workflow].textContent =
    status.outputPath ??
    (workflow === "grabber"
      ? grabOutputDir.value.trim()
      : workflow === "audioVideo"
        ? audioVideoOutputPath.value.trim()
        : workflow === "merger"
        ? mergerOutputPath.value.trim()
        : "");
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

// The log is kept as a bounded buffer and flushed once per frame; naive
// per-line textContent appends are quadratic and freeze the UI when a job
// emits thousands of lines.
const logLines: string[] = [];
const MAX_LOG_LINES = 400;
let logFlushQueued = false;

function flushLog() {
  logFlushQueued = false;
  logOutput.textContent =
    logLines.length > 0 ? `${logLines.join("\n")}\n` : "Waiting for a run...";
  logOutput.scrollTop = logOutput.scrollHeight;
}

function appendLog(entry: ConversionLog) {
  const prefix = entry.stream === "stderr" ? "! " : "  ";
  logLines.push(`${prefix}${entry.line}`);
  if (logLines.length > MAX_LOG_LINES) {
    logLines.splice(0, logLines.length - MAX_LOG_LINES);
  }
  if (!logFlushQueued) {
    logFlushQueued = true;
    requestAnimationFrame(flushLog);
  }
}

function clearLog() {
  logLines.length = 0;
  logOutput.textContent = "";
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
  audioVideo: "Ready to create video",
  merger: "Ready to merge",
  transcribe: "Ready to transcribe",
};

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function defaultMergeOutputPath(): string {
  const firstPath = mergeVideoPaths[0];
  if (!firstPath) {
    return "";
  }
  const separatorIndex = Math.max(firstPath.lastIndexOf("/"), firstPath.lastIndexOf("\\"));
  const directory = separatorIndex === -1 ? "" : firstPath.slice(0, separatorIndex + 1);
  const name = firstPath.slice(separatorIndex + 1);
  const stem = name.replace(/\.[^.]*$/, "") || "merged";
  return `${directory}${stem}.merged.mp4`;
}

function defaultAudioVideoOutputPath(): string {
  const sourcePath = audioVideoAudioPath.value.trim();
  if (!sourcePath) {
    return "";
  }
  const separatorIndex = Math.max(sourcePath.lastIndexOf("/"), sourcePath.lastIndexOf("\\"));
  const directory = separatorIndex === -1 ? "" : sourcePath.slice(0, separatorIndex + 1);
  const name = sourcePath.slice(separatorIndex + 1);
  const stem = name.replace(/\.[^.]*$/, "") || "audio";
  return `${directory}${stem}.audio-video.mp4`;
}

function setAudioVideoStatus() {
  setStatus({
    status: "idle",
    phase: "inspect",
    message: audioVideoAudioPath.value.trim() ? "Ready to create video" : "Choose an audio file to begin",
  });
}

function updateAudioVideoResolution(resolution: string) {
  audioVideoResolution = resolution;
  audioVideoResolutionButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.resolution === resolution);
  });
}

function updateAudioVideoBackground(background: string) {
  audioVideoBackground = background;
  audioVideoBackgroundButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.background === background);
  });
}

async function chooseAudioForVideo() {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Audio", extensions: audioExtensions }],
  });
  if (typeof selected === "string") {
    audioVideoAudioPath.value = selected;
    if (!audioVideoOutputPath.value.trim()) {
      audioVideoOutputPath.value = defaultAudioVideoOutputPath();
    }
    setActiveWorkflow("audioVideo");
    setAudioVideoStatus();
  }
}

async function chooseAudioVideoOutput() {
  const selected = await save({
    defaultPath: audioVideoOutputPath.value.trim() || defaultAudioVideoOutputPath() || "audio-video.mp4",
    filters: [{ name: "MP4 video", extensions: ["mp4"] }],
  });
  if (selected) {
    audioVideoOutputPath.value = selected;
    workflowOutputPaths.audioVideo.textContent = selected;
    setActiveWorkflow("audioVideo");
    setAudioVideoStatus();
  }
}

function setMergerStatus() {
  setStatus({
    status: "idle",
    phase: "inspect",
    message: mergeVideoPaths.length >= 2 ? "Ready to merge" : "Select at least two videos",
  });
}

function applyMergeControlState(running = currentStatus.status === "running") {
  mergerStartButton.disabled = running || mergeVideoPaths.length < 2;
  mergerClearButton.disabled = running || mergeVideoPaths.length === 0;
  mergerFileList
    .querySelectorAll<HTMLButtonElement>("button")
    .forEach((button) => {
      if (running) {
        button.disabled = true;
        return;
      }
      if (button.dataset.direction === "up") {
        button.disabled = button.dataset.index === "0";
      } else if (button.dataset.direction === "down") {
        button.disabled = Number(button.dataset.index) === mergeVideoPaths.length - 1;
      } else {
        button.disabled = false;
      }
    });
}

function moveMergeVideo(index: number, direction: -1 | 1) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= mergeVideoPaths.length) {
    return;
  }
  const [path] = mergeVideoPaths.splice(index, 1);
  mergeVideoPaths.splice(targetIndex, 0, path);
  renderMergeList();
  setMergerStatus();
}

function removeMergeVideo(index: number) {
  mergeVideoPaths.splice(index, 1);
  if (mergeVideoPaths.length === 0) {
    mergerOutputPath.value = "";
  }
  renderMergeList();
  setMergerStatus();
}

function renderMergeList() {
  mergerFileList.replaceChildren();
  if (mergeVideoPaths.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "No videos selected.";
    mergerFileList.append(empty);
    applyMergeControlState();
    return;
  }

  mergeVideoPaths.forEach((path, index) => {
    const row = document.createElement("div");
    row.className = "merge-file-row";

    const indexLabel = document.createElement("span");
    indexLabel.className = "merge-file-index";
    indexLabel.textContent = String(index + 1);

    const meta = document.createElement("span");
    meta.className = "merge-file-meta";
    const name = document.createElement("strong");
    name.textContent = fileName(path);
    const fullPath = document.createElement("small");
    fullPath.textContent = path;
    meta.append(name, fullPath);

    const actions = document.createElement("span");
    actions.className = "merge-file-actions";

    const up = document.createElement("button");
    up.className = "icon-button";
    up.type = "button";
    up.title = "Move up";
    up.dataset.direction = "up";
    up.dataset.index = String(index);
    up.disabled = index === 0;
    up.innerHTML = `<i data-lucide="arrow-up"></i>`;
    up.addEventListener("click", () => moveMergeVideo(index, -1));

    const down = document.createElement("button");
    down.className = "icon-button";
    down.type = "button";
    down.title = "Move down";
    down.dataset.direction = "down";
    down.dataset.index = String(index);
    down.disabled = index === mergeVideoPaths.length - 1;
    down.innerHTML = `<i data-lucide="arrow-down"></i>`;
    down.addEventListener("click", () => moveMergeVideo(index, 1));

    const remove = document.createElement("button");
    remove.className = "icon-button";
    remove.type = "button";
    remove.title = "Remove";
    remove.innerHTML = `<i data-lucide="trash-2"></i>`;
    remove.addEventListener("click", () => removeMergeVideo(index));

    actions.append(up, down, remove);
    row.append(indexLabel, meta, actions);
    mergerFileList.append(row);
  });

  createIcons({ icons: { ArrowDown, ArrowUp, Trash2 } });
  applyMergeControlState();
}

async function chooseMergeVideos() {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Video", extensions: videoExtensions }],
  });
  const paths = Array.isArray(selected)
    ? selected
    : typeof selected === "string"
      ? [selected]
      : [];
  if (paths.length === 0) {
    return;
  }
  const existing = new Set(mergeVideoPaths);
  mergeVideoPaths = [...mergeVideoPaths, ...paths.filter((path) => !existing.has(path))];
  if (!mergerOutputPath.value.trim()) {
    mergerOutputPath.value = defaultMergeOutputPath();
  }
  setActiveWorkflow("merger");
  renderMergeList();
  setMergerStatus();
}

async function chooseMergeOutput() {
  const selected = await save({
    defaultPath: mergerOutputPath.value.trim() || defaultMergeOutputPath() || "merged.mp4",
    filters: [{ name: "MP4 video", extensions: ["mp4"] }],
  });
  if (selected) {
    mergerOutputPath.value = selected;
    workflowOutputPaths.merger.textContent = selected;
    setActiveWorkflow("merger");
    setMergerStatus();
  }
}

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
workflowTabs.audioVideo.addEventListener("click", () => setActiveWorkflow("audioVideo"));
workflowTabs.merger.addEventListener("click", () => setActiveWorkflow("merger"));
workflowTabs.transcribe.addEventListener("click", () => setActiveWorkflow("transcribe"));
workflowTabs.player.addEventListener("click", () => setActiveWorkflow("player"));
workflowTabs.grabber.addEventListener("click", () => setActiveWorkflow("grabber"));
dialogueBrowseButton.addEventListener("click", () => chooseVideo(dialogueVideoPath, "dialogue"));
processingBrowseButton.addEventListener("click", () =>
  chooseVideo(processingVideoPath, "processing", grabOutputDir.value.trim()),
);
converterBrowseButton.addEventListener("click", () => chooseVideo(converterVideoPath, "converter"));
audioVideoBrowseButton.addEventListener("click", () => void chooseAudioForVideo());
audioVideoAudioPath.addEventListener("change", () => {
  if (!audioVideoOutputPath.value.trim()) {
    audioVideoOutputPath.value = defaultAudioVideoOutputPath();
  }
  setAudioVideoStatus();
});
audioVideoOutputBrowseButton.addEventListener("click", () => void chooseAudioVideoOutput());
audioVideoOutputPath.addEventListener("input", () => {
  workflowOutputPaths.audioVideo.textContent = audioVideoOutputPath.value.trim();
});
audioVideoResolutionButtons.forEach((button) => {
  button.addEventListener("click", () =>
    updateAudioVideoResolution(button.dataset.resolution ?? "1920x1080"),
  );
});
audioVideoBackgroundButtons.forEach((button) => {
  button.addEventListener("click", () =>
    updateAudioVideoBackground(button.dataset.background ?? "111827"),
  );
});
mergerAddButton.addEventListener("click", () => void chooseMergeVideos());
mergerClearButton.addEventListener("click", () => {
  mergeVideoPaths = [];
  mergerOutputPath.value = "";
  workflowOutputPaths.merger.textContent = "";
  renderMergeList();
  setMergerStatus();
});
mergerOutputBrowseButton.addEventListener("click", () => void chooseMergeOutput());
mergerOutputPath.addEventListener("input", () => {
  workflowOutputPaths.merger.textContent = mergerOutputPath.value.trim();
});
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
  clearLog();
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

audioVideoStartButton.addEventListener("click", () =>
  startRun("audioVideo", "start_audio_video", {
    audioPath: audioVideoAudioPath.value.trim(),
    outputPath: audioVideoOutputPath.value.trim(),
    resolution: audioVideoResolution,
    background: audioVideoBackground,
  }),
);

mergerStartButton.addEventListener("click", () =>
  startRun("merger", "start_merge", {
    videoPaths: mergeVideoPaths,
    outputPath: mergerOutputPath.value.trim(),
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
  clearLog();
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
  clearLog();
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
let playerDroppedCues = 0;
let playerClampedCues = 0;
let playerSubtitleFile = "";
let playerIgnoredKeys = new Set<string>();

// Identifies a cue across reloads of the same subtitle file.
function cueKey(cue: SubtitleCue): string {
  return `${Math.round(cue.start * 1000)}|${cue.text.slice(0, 24)}`;
}

function isCueIgnored(cue: SubtitleCue): boolean {
  return playerIgnoredKeys.has(cueKey(cue));
}

async function persistCueIgnores() {
  if (!playerSubtitleFile) {
    return;
  }
  try {
    await invoke("save_cue_ignores", {
      options: { subtitlePath: playerSubtitleFile, keys: [...playerIgnoredKeys] },
    });
  } catch (error) {
    appendLog({ stream: "stderr", line: String(error) });
  }
}

function toggleCueIgnore(index: number) {
  const cue = playerCues[index];
  const key = cueKey(cue);
  if (playerIgnoredKeys.has(key)) {
    playerIgnoredKeys.delete(key);
  } else {
    playerIgnoredKeys.add(key);
  }
  playerCueButtons[index]?.classList.toggle("ignored", playerIgnoredKeys.has(key));
  updatePlayerSummary();
  void persistCueIgnores();
}

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

// Whisper transcripts hallucinate in silence and music: cues with no real
// text, the same line tiled across back-to-back cues, and short phrases
// stretched over 30-second decode windows. Clean those up so playback,
// dialogue-only skipping, and the runtime estimate stay honest.
const MAX_CUE_SECONDS = 12;

// Non-speech annotations: Whisper hallucinates broadcast-subtitle credits
// ("Musik", "Untertitel im Auftrag des ZDF", "Copyright WDR"), and SDH
// tracks describe sounds in brackets or asterisks ("*Spannende Musik*").
function isNonSpeechCue(text: string): boolean {
  const trimmed = text.trim();
  if (!/[\p{L}\p{N}]/u.test(trimmed)) {
    return true;
  }
  if (/^[(\[*♪♫].*[)\]*♪♫]$/u.test(trimmed)) {
    return true;
  }
  const words = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return (
    /^(\p{L}+ )?musik$/u.test(words) ||
    words.startsWith("untertitel") ||
    words.startsWith("copyright")
  );
}

function cleanCues(cues: SubtitleCue[]): SubtitleCue[] {
  const cleaned: SubtitleCue[] = [];
  playerDroppedCues = 0;
  playerClampedCues = 0;
  for (const cue of cues) {
    if (isNonSpeechCue(cue.text)) {
      playerDroppedCues += 1;
      continue;
    }
    const previous = cleaned[cleaned.length - 1];
    if (previous && previous.text === cue.text && cue.start - previous.end < 1) {
      // A contiguous duplicate is a hallucination loop, not a repeated line.
      playerDroppedCues += 1;
      continue;
    }
    if (cue.end - cue.start > MAX_CUE_SECONDS) {
      cleaned.push({ ...cue, end: cue.start + MAX_CUE_SECONDS });
      playerClampedCues += 1;
    } else {
      cleaned.push(cue);
    }
  }
  return cleaned;
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

type ExportPlan = {
  ranges: { start: number; end: number }[];
  // Kept cues retimed to the cut's compressed timeline.
  cues: SubtitleCue[];
  totalSeconds: number;
};

// Mirrors dialogue-only playback: each kept cue plays from (start - offset)
// to its end, and gaps short enough to play through are included. The same
// plan drives the runtime estimate and the exported cut.
function buildExportPlan(): ExportPlan {
  const ranges: { start: number; end: number }[] = [];
  const cues: SubtitleCue[] = [];
  let elapsedBefore = 0;
  for (const cue of playerCues) {
    if (isCueIgnored(cue)) {
      continue;
    }
    const start = Math.max(0, cue.start - playerOffset);
    let range = ranges[ranges.length - 1];
    if (range && start <= range.end + 0.35) {
      range.end = Math.max(range.end, cue.end);
    } else {
      if (range) {
        elapsedBefore += range.end - range.start;
      }
      range = { start, end: cue.end };
      ranges.push(range);
    }
    cues.push({
      start: elapsedBefore + (cue.start - range.start),
      end: elapsedBefore + (cue.end - range.start),
      text: cue.text,
    });
  }
  const last = ranges[ranges.length - 1];
  const totalSeconds = elapsedBefore + (last ? last.end - last.start : 0);
  return { ranges, cues, totalSeconds };
}

function dialogueOnlyDuration(): number {
  return buildExportPlan().totalSeconds;
}

function srtTimestamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function buildExportSrt(cues: SubtitleCue[]): string {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cue.text}\n`,
    )
    .join("\n");
}

function updatePlayerSummary() {
  if (playerCues.length === 0) {
    playerCueCount.textContent = "No cues loaded";
    return;
  }
  const dialogue = dialogueOnlyDuration();
  let summary = `${playerCues.length} cues`;
  const ignoredCount = playerCues.filter(isCueIgnored).length;
  const cleanupParts = [
    ignoredCount > 0 ? `${ignoredCount} ignored` : "",
    playerDroppedCues > 0 ? `${playerDroppedCues} removed` : "",
    playerClampedCues > 0 ? `${playerClampedCues} shortened` : "",
  ].filter(Boolean);
  if (cleanupParts.length > 0) {
    summary += ` (${cleanupParts.join(", ")})`;
  }
  summary += ` · dialogue only ≈ ${formatCueTime(dialogue)}`;
  const total = playerVideo.duration;
  if (Number.isFinite(total) && total > 0) {
    summary += ` of ${formatCueTime(total)} (${Math.round((dialogue / total) * 100)}%)`;
  }
  playerCueCount.textContent = summary;
}

function renderPlayerCues() {
  playerCueList.replaceChildren();
  playerCueButtons = [];
  playerActiveCue = -1;
  updatePlayerSummary();
  if (playerCues.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "No cues found in the selected subtitles.";
    playerCueList.append(empty);
    return;
  }
  playerCues.forEach((cue, index) => {
    const button = document.createElement("button");
    button.className = "cue-row";
    button.classList.toggle("ignored", isCueIgnored(cue));
    button.type = "button";
    button.addEventListener("click", () => seekToCue(index));

    const time = document.createElement("span");
    time.className = "cue-time";
    time.textContent = `${formatCueTime(cue.start)} → ${formatCueTime(cue.end)}`;
    const text = document.createElement("span");
    text.className = "cue-text";
    text.textContent = cue.text;
    const ignore = document.createElement("span");
    ignore.className = "cue-ignore";
    ignore.textContent = "✕";
    ignore.title = "Ignore this segment";
    ignore.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleCueIgnore(index);
    });

    button.append(time, text, ignore);
    playerCueList.append(button);
    playerCueButtons.push(button);
  });
}

async function loadPlayerSubtitleFile(path: string) {
  try {
    const content = await invoke<string>("read_subtitle_file", { options: { path } });
    const ignoredKeys = await invoke<string[]>("load_cue_ignores", {
      options: { subtitlePath: path },
    });
    playerSubtitleFile = path;
    playerIgnoredKeys = new Set(ignoredKeys);
    playerCues = cleanCues(parseSubtitles(content));
    renderPlayerCues();
  } catch (error) {
    playerSubtitleFile = "";
    playerIgnoredKeys = new Set();
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
  updatePlayerSummary();
}

function stepPlayerCue(direction: -1 | 1) {
  if (playerCues.length === 0) {
    return;
  }
  const time = playerVideo.currentTime;
  let target: number;
  if (direction === 1) {
    target = playerCues.findIndex((cue) => cue.start > time + 0.05 && !isCueIgnored(cue));
    if (target === -1) {
      return;
    }
  } else {
    // A margin so that pressing back twice moves to the previous cue
    // instead of restarting the current one each time.
    target = playerCues.length - 1;
    while (
      target >= 0 &&
      (playerCues[target].start >= time - 1 || isCueIgnored(playerCues[target]))
    ) {
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
// In dialogue-only mode, gaps between cues are skipped: once playback leaves
// a cue and the next one is still ahead, jump to it (minus the jump offset).
// The 0.35s margin keeps tiny gaps playing through and prevents re-jumping
// inside the offset lead-in we just landed on.
function skipGapIfNeeded(time: number) {
  if (
    !playerDialogueOnly.checked ||
    playerVideo.paused ||
    playerVideo.seeking ||
    playerCues.length === 0
  ) {
    return;
  }
  const insideIndex = cueIndexAt(time);
  if (insideIndex !== -1 && !isCueIgnored(playerCues[insideIndex])) {
    return;
  }
  const next = playerCues.find((cue) => cue.start > time && !isCueIgnored(cue));
  if (!next) {
    return;
  }
  const target = next.start - playerOffset;
  if (target > time + 0.35) {
    playerVideo.currentTime = target;
  }
}

playerVideo.addEventListener("timeupdate", () => {
  const time = playerVideo.currentTime;
  setActivePlayerCue(cueIndexAt(time));
  skipGapIfNeeded(time);
});
playerVideo.addEventListener("loadedmetadata", updatePlayerSummary);

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
audioVideoStopButton.addEventListener("click", stopCurrentRun);
mergerStopButton.addEventListener("click", stopCurrentRun);
transcribeStopButton.addEventListener("click", stopCurrentRun);
playerStopButton.addEventListener("click", stopCurrentRun);
grabberStopButton.addEventListener("click", stopCurrentRun);

playerStartButton.addEventListener("click", () => {
  const videoPath = playerVideoPath.value.trim();
  const plan = buildExportPlan();
  if (!videoPath || plan.ranges.length === 0) {
    setStatus({
      status: "error",
      phase: "error",
      message: "Load a video and subtitles before creating a cut",
    });
    return;
  }
  void startRun("player", "start_dialogue_export", {
    videoPath,
    ranges: plan.ranges,
    subtitles: buildExportSrt(plan.cues),
  });
});

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
updateAudioVideoResolution(audioVideoResolution);
updateAudioVideoBackground(audioVideoBackground);
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
