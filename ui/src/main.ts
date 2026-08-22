import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Captions,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileImage,
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
  Target,
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

type DownloaderStatus = {
  installed: boolean;
  outdated: boolean;
  repairNeeded: boolean;
  installedVersion?: string;
  latestVersion?: string;
  message: string;
};

type GrabQuality = {
  height: number;
  label: string;
  codec: string;
  sizeBytes?: number;
};

type GrabAudioTrack = {
  id: string;
  name: string;
  original: boolean;
  sizeBytes?: number;
};

type GrabSubtitleTrack = {
  id: string;
  language: string;
  name: string;
  auto: boolean;
};

type GrabChapter = {
  start: number;
  end: number;
  title: string;
};

type GrabMetadata = {
  title: string;
  webpageUrl: string;
  extractor: string;
  duration?: number;
  thumbnail: string;
  qualities: GrabQuality[];
  audioTracks: GrabAudioTrack[];
  subtitles: GrabSubtitleTrack[];
  chapters: GrabChapter[];
};

type GrabSelection = {
  video: boolean;
  audio: boolean;
  subs: boolean;
  quality: number | null;
  audioSel: string[];
  mux: "muxed" | "separate";
  subSel: string[];
  fmtSel: string[];
  chapters: boolean;
  chapFmtSel: string[];
};

type GrabManifestFile = {
  kind: string;
  tone: "vid" | "aud" | "sub" | "chp";
  name: string;
  detail: string;
  sizeBytes: number | null;
};

type MaterialVideo = {
  path: string;
  fileName: string;
  duration?: number;
  sizeBytes?: number;
  modified?: number;
  thumbnailDataUrl?: string;
};

type GrabTextFileEntry = {
  path: string;
  fileName: string;
  folderName: string;
  sizeBytes?: number;
  modified?: number;
};

type GrabMetadataView = "download" | "preview";

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
    ["merge", "Merge media"],
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
    ["chapters", "Save chapters"],
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
let downloaderStatus: DownloaderStatus | null = null;
let downloaderStatusLoading = true;
let materialGalleryLoadId = 0;
let grabContentLoadId = 0;
let grabTextFiles: GrabTextFileEntry[] = [];
let currentGrabContentText = "";
let currentGrabContentUrl = "";
let grabMetadataView: GrabMetadataView = "download";
let pendingGrabDeletePath = "";
let pendingGrabDeleteTimer: number | undefined;
let grabPreviewPath = "";

function defaultGrabSelection(): GrabSelection {
  return {
    video: true,
    audio: true,
    subs: true,
    quality: null,
    audioSel: [],
    mux: "muxed",
    subSel: [],
    fmtSel: ["srt"],
    chapters: false,
    chapFmtSel: ["json"],
  };
}

let grabSel: GrabSelection = defaultGrabSelection();
let mergeMediaPaths: string[] = [];

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
            <i data-lucide="file-image"></i>
          </div>
          <div class="audio-video-image-field">
            <span class="field-label">Image</span>
            <div class="file-row">
              <input id="audio-video-image-path" type="text" placeholder="/path/to/image.png" spellcheck="false" />
              <button id="audio-video-image-browse-button" class="icon-button" type="button" title="Choose image">
                <i data-lucide="folder-open"></i>
              </button>
            </div>
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
              <span>Add media</span>
            </button>
            <button id="merger-clear-button" class="secondary-button" type="button">
              <i data-lucide="trash-2"></i>
              <span>Clear</span>
            </button>
          </div>
        </section>

        <section class="section-block">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Output</span>
              <h2>Final file</h2>
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
              <h2 id="merger-run-message">Select at least two media files</h2>
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

        <section class="section-block">
          <div class="section-heading compact">
            <div>
              <span class="eyebrow">Queue</span>
              <h2>Merge order</h2>
            </div>
            <i data-lucide="list-plus"></i>
          </div>
          <div id="merger-file-list" class="merge-file-list">
            <p class="empty-note">No media selected.</p>
          </div>
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
        <div class="mg-page">
          <div class="mg-column">
            <div class="mg-source-row">
              <div class="mg-source-field">
                <div class="mg-source-main">
                  <span class="mg-source-label">Source</span>
                  <input id="grab-url" class="mg-url-input" type="text" placeholder="https://..." spellcheck="false" />
                </div>
                <div id="mg-source-status" class="mg-source-status" hidden>
                  <span class="mg-source-dot"></span>
                  <span id="mg-source-status-text"></span>
                </div>
              </div>
              <button id="grabber-start-button" class="mg-rescan-button" type="button">Scan</button>
              <button id="grabber-stop-button" class="mg-rescan-button mg-cancel-button" type="button" hidden>Cancel</button>
            </div>
            <p id="grabber-run-message" class="mg-run-message">Paste a URL to begin</p>

            <div class="mg-downloader-row">
              <i data-lucide="hard-drive-download"></i>
              <div class="mg-downloader-copy">
                <strong>yt-dlp downloader</strong>
                <small id="mg-downloader-message">Checking the managed downloader...</small>
              </div>
              <span id="mg-downloader-chip" class="runtime-chip pending">Checking</span>
              <button id="mg-downloader-action" class="mg-downloader-action" type="button" hidden>Download</button>
            </div>

            <div id="mg-metadata" hidden>
              <div class="mg-meta-header">
                <div class="mg-thumb">
                  <span class="mg-thumb-placeholder">Thumbnail</span>
                  <img id="mg-thumb-image" alt="" hidden />
                  <span id="mg-thumb-duration" class="mg-thumb-duration" hidden></span>
                </div>
                <div class="mg-meta-text">
                  <div class="mg-eyebrow">Metadata</div>
                  <h2 id="grabber-title" class="mg-title"></h2>
                  <div id="grabber-meta-line" class="mg-meta-line"></div>
                </div>
              </div>

              <div class="mg-view-tabs" role="tablist" aria-label="Grabber result views">
                <button id="grabber-download-view-button" class="mg-view-tab active" type="button" role="tab" aria-selected="true" aria-controls="grabber-download-view">Download</button>
                <button id="grabber-preview-view-button" class="mg-view-tab" type="button" role="tab" aria-selected="false" aria-controls="grabber-preview-view">Preview</button>
              </div>

              <div id="grabber-download-view" class="mg-download-grid">
                <div class="mg-track-cards">
                  <section id="mg-audio-card" class="mg-card">
                    <div class="mg-card-header">
                      <div class="mg-card-badge mg-badge-aud">AUD</div>
                      <div class="mg-card-heading">
                        <div class="mg-card-title">Audio tracks</div>
                        <div class="mg-card-subtitle">Pick one language per file, or several to get one file each</div>
                      </div>
                      <button id="mg-audio-switch" class="mg-switch" type="button" role="switch" aria-label="Audio tracks"><span class="mg-switch-knob"></span></button>
                    </div>
                    <div id="mg-audio-body" class="mg-card-body">
                      <div id="mg-audio-combo"></div>
                      <div id="mg-mux-section" class="mg-mux-section" hidden>
                        <div class="mg-field-eyebrow">How to package it</div>
                        <div class="mg-mux-row">
                          <button id="mg-mux-muxed" class="mg-mux-option" type="button">
                            <span class="mg-mux-title">Muxed video file</span>
                            <span class="mg-mux-note">One .mp4 per language, picture + audio inside</span>
                          </button>
                          <button id="mg-mux-separate" class="mg-mux-option" type="button">
                            <span class="mg-mux-title">Keep separate</span>
                            <span class="mg-mux-note">Silent video + one .m4a per language</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section id="mg-video-card" class="mg-card">
                    <div class="mg-card-header">
                      <div class="mg-card-badge mg-badge-vid">VID</div>
                      <div class="mg-card-heading">
                        <div class="mg-card-title">Video track</div>
                        <div class="mg-card-subtitle">Picture only — language lives in the audio track</div>
                      </div>
                      <button id="mg-video-switch" class="mg-switch" type="button" role="switch" aria-label="Video track"><span class="mg-switch-knob"></span></button>
                    </div>
                    <div id="mg-video-body" class="mg-card-body">
                      <div class="mg-field-eyebrow">Quality</div>
                      <div id="mg-quality-pills" class="mg-pill-row"></div>
                    </div>
                  </section>

                  <section id="mg-subs-card" class="mg-card">
                    <div class="mg-card-header">
                      <div class="mg-card-badge mg-badge-sub">SUB</div>
                      <div class="mg-card-heading">
                        <div class="mg-card-title">Subtitles</div>
                        <div class="mg-card-subtitle">Independent of video and audio — take them on their own if you like</div>
                      </div>
                      <button id="mg-subs-switch" class="mg-switch" type="button" role="switch" aria-label="Subtitles"><span class="mg-switch-knob"></span></button>
                    </div>
                    <div id="mg-subs-body" class="mg-card-body">
                      <div class="mg-subs-langs-row">
                        <div class="mg-field-eyebrow">Languages</div>
                        <button id="mg-match-audio" class="mg-match-audio" type="button">Match my audio languages</button>
                      </div>
                      <div id="mg-sub-combo"></div>
                      <div class="mg-format-row">
                        <div class="mg-field-eyebrow">Format</div>
                        <span id="mg-format-pills" class="mg-format-pills"></span>
                      </div>
                    </div>
                  </section>

                  <section id="mg-chapters-card" class="mg-card" hidden>
                    <div class="mg-card-header">
                      <div class="mg-card-badge mg-badge-chp">CHP</div>
                      <div class="mg-card-heading">
                        <div class="mg-card-title">Chapters</div>
                        <div class="mg-card-subtitle" id="mg-chapters-subtitle">Timestamped sections the uploader wrote in the description</div>
                      </div>
                      <button id="mg-chapters-switch" class="mg-switch" type="button" role="switch" aria-label="Chapters"><span class="mg-switch-knob"></span></button>
                    </div>
                    <div id="mg-chapters-body" class="mg-card-body">
                      <div class="mg-format-row mg-format-row-first">
                        <div class="mg-field-eyebrow">Format</div>
                        <span id="mg-chapter-format-pills" class="mg-format-pills"></span>
                        <button id="mg-chapters-copy" class="mg-match-audio mg-chapters-copy" type="button">Copy</button>
                      </div>
                      <div id="mg-chapters-list" class="mg-chapter-list"></div>
                    </div>
                  </section>
                </div>

                <aside class="mg-manifest">
                  <div class="mg-manifest-header">
                    <div class="mg-eyebrow-sm">You will get</div>
                    <div id="mg-file-count" class="mg-file-count">0 files</div>
                  </div>
                  <div id="mg-manifest-list" class="mg-manifest-list"></div>
                  <div class="mg-manifest-footer">
                    <div class="mg-total-row"><span>Estimated total</span><span id="mg-total-size" class="mg-total-value">—</span></div>
                    <button id="mg-download-button" class="mg-download-button" type="button" disabled>Download nothing</button>
                    <button id="mg-output-settings-button" class="mg-output-settings-button" type="button">Output settings</button>
                    <div id="mg-output-settings" class="mg-output-settings" hidden>
                      <div class="mg-output-row">
                        <input id="grab-output-dir" class="mg-output-input" type="text" placeholder="/path/to/material" spellcheck="false" />
                        <button id="grab-output-browse-button" class="mg-output-action" type="button" title="Choose folder">Browse</button>
                        <button id="grab-output-open-button" class="mg-output-action" type="button" title="Open output folder">Open</button>
                      </div>
                      <p id="grabber-output-path" class="mg-output-path"></p>
                    </div>
                  </div>
                </aside>
              </div>

              <div id="grabber-preview-view" class="mg-preview-card" hidden>
                <div class="mg-eyebrow-sm">Downloaded text</div>
                <div class="mg-preview-toolbar">
                  <div id="mg-preview-pills" class="mg-preview-pills"></div>
                  <button id="grab-content-refresh-button" class="mg-toolbar-button mg-refetch-button" type="button">Refetch</button>
                  <button id="grab-content-delete-button" class="mg-toolbar-button mg-delete-button" type="button" title="Delete selected file" disabled>Delete</button>
                  <button id="grab-content-copy-button" class="mg-toolbar-button mg-copy-button" type="button" disabled>Copy</button>
                </div>
                <p id="grab-content-path" class="mg-preview-path"></p>
                <pre id="grab-content-preview" class="mg-preview-text">No downloaded text files.</pre>
              </div>
            </div>
          </div>
        </div>
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
    Copy,
    Circle,
    ExternalLink,
    FileImage,
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
    Target,
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
const audioVideoImagePath = byId<HTMLInputElement>("audio-video-image-path");
const audioVideoOutputPath = byId<HTMLInputElement>("audio-video-output-path");
const mergerOutputPath = byId<HTMLInputElement>("merger-output-path");
const transcribeVideoPath = byId<HTMLInputElement>("transcribe-video-path");
const grabUrl = byId<HTMLInputElement>("grab-url");
const grabOutputDir = byId<HTMLInputElement>("grab-output-dir");
const dialogueBrowseButton = byId<HTMLButtonElement>("dialogue-browse-button");
const processingBrowseButton = byId<HTMLButtonElement>("processing-browse-button");
const converterBrowseButton = byId<HTMLButtonElement>("converter-browse-button");
const audioVideoBrowseButton = byId<HTMLButtonElement>("audio-video-browse-button");
const audioVideoImageBrowseButton = byId<HTMLButtonElement>("audio-video-image-browse-button");
const audioVideoOutputBrowseButton = byId<HTMLButtonElement>("audio-video-output-browse-button");
const mergerAddButton = byId<HTMLButtonElement>("merger-add-button");
const mergerClearButton = byId<HTMLButtonElement>("merger-clear-button");
const mergerOutputBrowseButton = byId<HTMLButtonElement>("merger-output-browse-button");
const transcribeBrowseButton = byId<HTMLButtonElement>("transcribe-browse-button");
const grabOutputBrowseButton = byId<HTMLButtonElement>("grab-output-browse-button");
const grabOutputOpenButton = byId<HTMLButtonElement>("grab-output-open-button");
const grabContentRefreshButton = byId<HTMLButtonElement>("grab-content-refresh-button");
const grabContentDeleteButton = byId<HTMLButtonElement>("grab-content-delete-button");
const grabContentCopyButton = byId<HTMLButtonElement>("grab-content-copy-button");
const dialogueStartButton = byId<HTMLButtonElement>("dialogue-start-button");
const processingStartButton = byId<HTMLButtonElement>("processing-start-button");
const converterStartButton = byId<HTMLButtonElement>("converter-start-button");
const audioVideoStartButton = byId<HTMLButtonElement>("audio-video-start-button");
const mergerStartButton = byId<HTMLButtonElement>("merger-start-button");
const transcribeStartButton = byId<HTMLButtonElement>("transcribe-start-button");
const grabberStartButton = byId<HTMLButtonElement>("grabber-start-button");
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
const playerFollow = byId<HTMLInputElement>("player-follow");
const playerDialogueOnly = byId<HTMLInputElement>("player-dialogue-only");
const playerPrevCue = byId<HTMLButtonElement>("player-prev-cue");
const playerReplayCue = byId<HTMLButtonElement>("player-replay-cue");
const playerNextCue = byId<HTMLButtonElement>("player-next-cue");
const playerCueCount = byId<HTMLElement>("player-cue-count");
const playerCueList = byId<HTMLElement>("player-cues");
const playerStartButton = byId<HTMLButtonElement>("player-start-button");
const playerStopButton = byId<HTMLButtonElement>("player-stop-button");
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
const grabberMetadataSection = byId<HTMLElement>("mg-metadata");
const grabberDownloadViewButton = byId<HTMLButtonElement>("grabber-download-view-button");
const grabberPreviewViewButton = byId<HTMLButtonElement>("grabber-preview-view-button");
const grabberDownloadView = document.querySelector<HTMLElement>("#grabber-download-view")!;
const grabberPreviewView = document.querySelector<HTMLElement>("#grabber-preview-view")!;
const grabberTitle = document.querySelector<HTMLElement>("#grabber-title")!;
const grabberMetaLine = document.querySelector<HTMLElement>("#grabber-meta-line")!;
const grabSourceStatus = byId<HTMLElement>("mg-source-status");
const grabSourceStatusText = byId<HTMLElement>("mg-source-status-text");
const grabThumbImage = byId<HTMLImageElement>("mg-thumb-image");
const grabThumbDuration = byId<HTMLElement>("mg-thumb-duration");
const grabVideoCard = byId<HTMLElement>("mg-video-card");
const grabAudioCard = byId<HTMLElement>("mg-audio-card");
const grabSubsCard = byId<HTMLElement>("mg-subs-card");
const grabVideoSwitch = byId<HTMLButtonElement>("mg-video-switch");
const grabAudioSwitch = byId<HTMLButtonElement>("mg-audio-switch");
const grabSubsSwitch = byId<HTMLButtonElement>("mg-subs-switch");
const grabVideoBody = byId<HTMLElement>("mg-video-body");
const grabAudioBody = byId<HTMLElement>("mg-audio-body");
const grabSubsBody = byId<HTMLElement>("mg-subs-body");
const grabQualityPills = byId<HTMLElement>("mg-quality-pills");
const grabMuxSection = byId<HTMLElement>("mg-mux-section");
const grabMuxMuxedButton = byId<HTMLButtonElement>("mg-mux-muxed");
const grabMuxSeparateButton = byId<HTMLButtonElement>("mg-mux-separate");
const grabMatchAudioButton = byId<HTMLButtonElement>("mg-match-audio");
const grabAudioComboRoot = byId<HTMLElement>("mg-audio-combo");
const grabSubComboRoot = byId<HTMLElement>("mg-sub-combo");
const grabFormatPills = byId<HTMLElement>("mg-format-pills");
const grabChaptersCard = byId<HTMLElement>("mg-chapters-card");
const grabChaptersSwitch = byId<HTMLButtonElement>("mg-chapters-switch");
const grabChaptersBody = byId<HTMLElement>("mg-chapters-body");
const grabChaptersSubtitle = byId<HTMLElement>("mg-chapters-subtitle");
const grabChapterFormatPills = byId<HTMLElement>("mg-chapter-format-pills");
const grabChaptersCopyButton = byId<HTMLButtonElement>("mg-chapters-copy");
const grabChaptersList = byId<HTMLElement>("mg-chapters-list");
const grabFileCount = byId<HTMLElement>("mg-file-count");
const grabManifestList = byId<HTMLElement>("mg-manifest-list");
const grabTotalSize = byId<HTMLElement>("mg-total-size");
const grabDownloadButton = byId<HTMLButtonElement>("mg-download-button");
const grabDownloaderMessage = byId<HTMLElement>("mg-downloader-message");
const grabDownloaderChip = byId<HTMLElement>("mg-downloader-chip");
const grabDownloaderAction = byId<HTMLButtonElement>("mg-downloader-action");
const grabOutputSettingsButton = byId<HTMLButtonElement>("mg-output-settings-button");
const grabOutputSettings = byId<HTMLElement>("mg-output-settings");
const grabPreviewPills = byId<HTMLElement>("mg-preview-pills");
const grabContentPath = document.querySelector<HTMLElement>("#grab-content-path")!;
const grabContentPreview = document.querySelector<HTMLElement>("#grab-content-preview")!;
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
  reencode: "Most compatible for editing. Re-encodes video and writes stereo AAC, so it takes a while.",
  remux: "Copies the video stream into MP4 and writes stereo AAC. Fast, but editors may struggle with HEVC/AV1 sources.",
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

function isProcessRunning(): boolean {
  return currentStatus.status === "running";
}

function setRunControls(running: boolean) {
  dialogueStartButton.disabled = running;
  processingStartButton.disabled = running;
  converterStartButton.disabled = running;
  audioVideoStartButton.disabled = running || !audioVideoAudioPath.value.trim();
  mergerStartButton.disabled = running || mergeMediaPaths.length < 2;
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
  audioVideoImageBrowseButton.disabled = running;
  audioVideoImagePath.disabled = running;
  audioVideoOutputBrowseButton.disabled = running;
  audioVideoResolutionButtons.forEach((button) => {
    button.disabled = running;
  });
  audioVideoBackgroundButtons.forEach((button) => {
    button.disabled = running;
  });
  mergerAddButton.disabled = running;
  mergerClearButton.disabled = running || mergeMediaPaths.length === 0;
  mergerOutputBrowseButton.disabled = running;
  transcribeBrowseButton.disabled = running;
  grabOutputBrowseButton.disabled = running;
  grabOutputOpenButton.disabled = running || !grabOutputDir.value.trim();
  updateGrabMetadataViewState(running);
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
    void loadGrabContentFiles();
  }
  if (workflow === "transcribe" && status.status === "complete" && status.message === "Whisper model is ready") {
    void loadWhisperModels();
  }
  if (workflow === "grabber" && status.status === "complete" && status.message === "Downloader is ready") {
    void loadDownloaderStatus();
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

function waitForVisibleUpdate(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function setRuntimeStatus(status: RuntimeStatus) {
  runtimeChip.className = `runtime-chip ${status.ready ? "ready" : "pending"}`;
  runtimeChip.textContent = status.ready ? "Ready" : "First-run setup";
  runtimeMessage.textContent = status.message;
}

function downloaderActionRequired(): boolean {
  return (downloaderStatus?.outdated || downloaderStatus?.repairNeeded) ?? false;
}

function renderDownloaderStatus() {
  if (downloaderStatusLoading) {
    grabDownloaderChip.className = "runtime-chip pending";
    grabDownloaderChip.textContent = "Checking";
    grabDownloaderMessage.textContent = "Checking the managed downloader...";
    grabDownloaderAction.hidden = true;
  } else if (!downloaderStatus) {
    grabDownloaderChip.className = "runtime-chip pending";
    grabDownloaderChip.textContent = "Unknown";
    grabDownloaderAction.hidden = true;
  } else {
    const { installed, outdated, repairNeeded, message } = downloaderStatus;
    let chipState = "pending";
    let chipLabel = "On demand";
    if (outdated) {
      chipState = "outdated";
      chipLabel = "Update needed";
    } else if (repairNeeded) {
      chipState = "outdated";
      chipLabel = "Repair needed";
    } else if (installed) {
      chipState = "ready";
      chipLabel = "Ready";
    }
    grabDownloaderMessage.textContent = message;
    grabDownloaderChip.className = `runtime-chip ${chipState}`;
    grabDownloaderChip.textContent = chipLabel;
    grabDownloaderAction.hidden = installed && !outdated && !repairNeeded;
    grabDownloaderAction.textContent = outdated ? "Update" : repairNeeded ? "Repair" : "Download";
  }
  grabDownloaderAction.disabled = currentStatus.status === "running" || downloaderStatusLoading;
  applyGrabControlState();
}

async function loadDownloaderStatus() {
  downloaderStatusLoading = true;
  renderDownloaderStatus();
  try {
    downloaderStatus = await invoke<DownloaderStatus>("get_downloader_status");
  } catch (error) {
    downloaderStatus = null;
    grabDownloaderMessage.textContent = `Could not check yt-dlp: ${String(error)}`;
    appendLog({ stream: "stderr", line: String(error) });
  } finally {
    downloaderStatusLoading = false;
    renderDownloaderStatus();
  }
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

function grabTextFileLabel(file: GrabTextFileEntry): string {
  const extensionMatch = file.fileName.match(/\.([^.]+)$/);
  const extension = extensionMatch?.[1]?.toLowerCase() ?? "txt";
  const stem = extensionMatch ? file.fileName.slice(0, -extension.length - 1) : file.fileName;
  let track = stem;
  if (file.folderName && track.startsWith(file.folderName)) {
    track = track.slice(file.folderName.length).replace(/^\.+/, "");
  }
  if (!track || track === stem) {
    const pieces = stem.split(".").filter(Boolean);
    track = pieces[pieces.length - 1] ?? stem;
  }
  // The downloader writes auto captions as `<base>.auto.<lang>.<ext>`.
  const autoMatch = track.match(/^auto\.(.+)$/i);
  return autoMatch ? `${autoMatch[1]}-auto.${extension}` : `${track}-manual.${extension}`;
}

function updateGrabMetadataViewState(running = currentStatus.status === "running") {
  const hasPreview = grabTextFiles.length > 0;
  const previewActive = grabMetadataView === "preview";
  grabberDownloadViewButton.classList.toggle("active", !previewActive);
  grabberPreviewViewButton.classList.toggle("active", previewActive);
  grabberDownloadViewButton.setAttribute("aria-selected", String(!previewActive));
  grabberPreviewViewButton.setAttribute("aria-selected", String(previewActive));
  grabberDownloadView.hidden = previewActive;
  grabberPreviewView.hidden = !previewActive;
  grabContentRefreshButton.disabled = running;
  grabContentDeleteButton.disabled = running || !hasPreview;
  grabContentCopyButton.disabled = running || !currentGrabContentText;
}

function setGrabMetadataView(view: GrabMetadataView) {
  grabMetadataView = view;
  updateGrabMetadataViewState();
  if (view === "preview" && grabTextFiles.length === 0) {
    void loadGrabContentFiles();
  }
}

function resetGrabPreviewScroll() {
  grabContentPreview.scrollTop = 0;
}

function disarmGrabDeleteButton() {
  pendingGrabDeletePath = "";
  if (pendingGrabDeleteTimer !== undefined) {
    window.clearTimeout(pendingGrabDeleteTimer);
    pendingGrabDeleteTimer = undefined;
  }
  grabContentDeleteButton.classList.remove("confirm");
  grabContentDeleteButton.title = "Delete selected file";
}

function armGrabDeleteButton(path: string) {
  pendingGrabDeletePath = path;
  grabContentDeleteButton.classList.add("confirm");
  grabContentDeleteButton.title = "Click again to delete";
  if (pendingGrabDeleteTimer !== undefined) {
    window.clearTimeout(pendingGrabDeleteTimer);
  }
  pendingGrabDeleteTimer = window.setTimeout(disarmGrabDeleteButton, 2500);
}

function renderGrabPreviewPills() {
  grabPreviewPills.replaceChildren();
  if (grabTextFiles.length === 0) {
    const empty = document.createElement("span");
    empty.className = "mg-preview-empty";
    empty.textContent = "No subtitle tracks selected yet.";
    grabPreviewPills.append(empty);
    return;
  }
  for (const file of grabTextFiles) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "mg-preview-pill";
    pill.classList.toggle("active", file.path === grabPreviewPath);
    pill.textContent = grabTextFileLabel(file);
    pill.addEventListener("click", () => {
      disarmGrabDeleteButton();
      void previewGrabContentFile(file.path);
    });
    grabPreviewPills.append(pill);
  }
}

function resetGrabContentPreview(_hidden = true, message = "No downloaded text files for this URL.") {
  grabContentLoadId += 1;
  currentGrabContentUrl = "";
  grabMetadataView = "download";
  setGrabContentEmpty(message);
}

function setGrabContentEmpty(message: string) {
  currentGrabContentText = "";
  grabTextFiles = [];
  grabPreviewPath = "";
  disarmGrabDeleteButton();
  grabContentCopyButton.disabled = true;
  grabContentDeleteButton.disabled = true;
  grabContentPath.textContent = "";
  grabContentPreview.textContent = message;
  resetGrabPreviewScroll();
  renderGrabPreviewPills();
  updateGrabMetadataViewState();
}

function renderGrabContentFiles(files: GrabTextFileEntry[], selectedPath?: string) {
  grabTextFiles = files;
  if (files.length === 0) {
    setGrabContentEmpty("No downloaded text files for this URL.");
    return;
  }

  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  grabContentRefreshButton.disabled = currentStatus.status === "running";
  grabContentDeleteButton.disabled = currentStatus.status === "running";
  void previewGrabContentFile(selected.path);
}

async function loadGrabContentFiles(preferredPath = grabPreviewPath) {
  if (currentStatus.status === "running") {
    return;
  }
  const url = grabUrl.value.trim();
  if (!url) {
    resetGrabContentPreview(true);
    return;
  }
  const loadId = ++grabContentLoadId;
  currentGrabContentUrl = url;
  grabContentRefreshButton.disabled = true;
  if (grabMetadataView === "preview") {
    grabContentPreview.textContent = "Loading text files...";
    resetGrabPreviewScroll();
  }

  try {
    const files = await invoke<GrabTextFileEntry[]>("list_grab_text_files", {
      options: {
        directory: grabOutputDir.value.trim(),
        url,
      },
    });
    if (loadId === grabContentLoadId && currentGrabContentUrl === url) {
      renderGrabContentFiles(files, preferredPath);
    }
  } catch (error) {
    if (loadId === grabContentLoadId && currentGrabContentUrl === url) {
      setGrabContentEmpty(String(error));
    }
  } finally {
    if (loadId === grabContentLoadId && currentGrabContentUrl === url) {
      grabContentRefreshButton.disabled = grabTextFiles.length === 0;
      grabContentDeleteButton.disabled = grabTextFiles.length === 0;
      setRunControls(isProcessRunning());
    }
  }
}

async function previewGrabContentFile(path: string) {
  const file = grabTextFiles.find((entry) => entry.path === path);
  if (!file) {
    setGrabContentEmpty("No downloaded text files for this URL.");
    return;
  }
  disarmGrabDeleteButton();
  grabPreviewPath = path;
  grabContentPath.textContent = path;
  grabContentCopyButton.disabled = true;
  renderGrabPreviewPills();
  updateGrabMetadataViewState();
  try {
    const content = await invoke<string>("read_grab_text_file", { options: { path } });
    currentGrabContentText = content;
    grabContentPreview.textContent = content || "(empty file)";
    resetGrabPreviewScroll();
    grabContentCopyButton.disabled = currentStatus.status === "running" || !content;
  } catch (error) {
    currentGrabContentText = "";
    grabContentPreview.textContent = String(error);
    resetGrabPreviewScroll();
    grabContentCopyButton.disabled = true;
  }
}

/// Writes to the system clipboard, reporting whether it actually worked.
///
/// The packaged app serves from the `tauri://` scheme, which is not a secure
/// context, so `navigator.clipboard` is undefined there and `execCommand`
/// returns false without throwing. Going through the clipboard plugin means
/// Rust performs the write, which also avoids needing the transient user
/// activation that an `await` before the copy would have consumed.
async function copyText(text: string): Promise<boolean> {
  try {
    await writeClipboardText(text);
    return true;
  } catch {
    // Fall through to the browser paths, which work in `npm run dev`.
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function flashCopied(button: HTMLButtonElement, restore: string, ok: boolean) {
  button.textContent = ok ? "Copied" : "Copy failed";
  window.setTimeout(() => {
    button.textContent = restore;
  }, 1200);
}

async function copyGrabContent() {
  disarmGrabDeleteButton();
  if (!currentGrabContentText) {
    return;
  }
  flashCopied(grabContentCopyButton, "Copy", await copyText(currentGrabContentText));
}

/// Copies the chapter list in the selected format. With both formats on,
/// plain text wins — it is the one you would paste into notes — and the
/// button label always names what it will put on the clipboard.
function chapterCopyFormat(): string {
  return grabSel.chapFmtSel.includes("txt") ? "txt" : "json";
}

async function copyGrabChapters() {
  const chapters = grabMetadata?.chapters ?? [];
  if (chapters.length === 0) {
    return;
  }
  const format = chapterCopyFormat();
  grabChaptersCopyButton.disabled = true;
  try {
    const text = await invoke<string>("render_grab_chapters", {
      options: { chapters, format },
    });
    flashCopied(grabChaptersCopyButton, chapterCopyLabel(), await copyText(text));
  } catch (error) {
    setStatus({ status: "error", phase: "error", message: String(error) });
  } finally {
    grabChaptersCopyButton.disabled = currentStatus.status === "running";
  }
}

function chapterCopyLabel(): string {
  return chapterCopyFormat() === "txt" ? "Copy plain text" : "Copy JSON";
}

async function deleteGrabContentFile() {
  const path = grabPreviewPath;
  const file = grabTextFiles.find((entry) => entry.path === path);
  if (!file || currentStatus.status === "running") {
    return;
  }
  if (pendingGrabDeletePath !== path) {
    armGrabDeleteButton(path);
    return;
  }

  disarmGrabDeleteButton();
  grabContentDeleteButton.disabled = true;
  try {
    await invoke("delete_grab_text_file", { options: { path } });
    const nextFile = grabTextFiles.find((entry) => entry.path !== path);
    await loadGrabContentFiles(nextFile?.path ?? "");
  } catch (error) {
    grabContentPreview.textContent = String(error);
    resetGrabPreviewScroll();
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  } finally {
    setRunControls(isProcessRunning());
  }
}

// ---------- Material grabber: multi-select language combobox ----------

type ComboOption = {
  id: string;
  name: string;
  code: string;
  badge: string;
  badgeKind: "primary" | "muted";
};

type ComboConfig = {
  root: HTMLElement;
  tone: "aud" | "sub";
  noun: string;
  options: () => ComboOption[];
  selected: () => string[];
  toggle: (id: string) => void;
};

function createLanguageCombobox(config: ComboConfig) {
  let query = "";
  let open = false;

  const control = document.createElement("div");
  control.className = `mg-combo mg-combo-${config.tone}`;
  const field = document.createElement("div");
  field.className = "mg-combo-field";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "mg-combo-input";
  input.spellcheck = false;
  const counter = document.createElement("span");
  counter.className = "mg-combo-counter";
  const dropdown = document.createElement("div");
  dropdown.className = "mg-combo-dropdown";
  dropdown.hidden = true;
  control.append(field, dropdown);
  config.root.replaceChildren(control);

  function close() {
    if (!open) {
      return;
    }
    open = false;
    query = "";
    input.value = "";
    render();
  }

  function render() {
    const options = config.options();
    const selected = config.selected();
    const chosen = selected
      .map((id) => options.find((option) => option.id === id))
      .filter((option): option is ComboOption => option !== undefined);

    field.replaceChildren();
    for (const option of chosen) {
      const pill = document.createElement("span");
      pill.className = "mg-combo-pill";
      const label = document.createElement("span");
      label.textContent = option.name;
      const badge = document.createElement("span");
      badge.className = `mg-combo-pill-badge ${option.badgeKind}`;
      badge.textContent = option.badge;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "mg-combo-pill-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${option.name}`);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        config.toggle(option.id);
      });
      pill.append(label, badge, remove);
      field.append(pill);
    }
    input.placeholder = chosen.length
      ? "Add a language…"
      : `Search ${options.length} ${config.noun}…`;
    counter.textContent = `${chosen.length} of ${options.length}`;
    field.append(input, counter);

    dropdown.hidden = !open;
    if (!open) {
      return;
    }
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? options.filter(
          (option) =>
            option.name.toLowerCase().includes(needle) ||
            option.code.toLowerCase().includes(needle),
        )
      : options;

    dropdown.replaceChildren();
    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mg-combo-empty";
      empty.textContent = "No track matches that.";
      dropdown.append(empty);
      return;
    }
    for (const option of matches) {
      const on = selected.includes(option.id);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mg-combo-row";
      row.classList.toggle("selected", on);
      const box = document.createElement("span");
      box.className = "mg-combo-check";
      box.textContent = on ? "✓" : "";
      const name = document.createElement("span");
      name.className = "mg-combo-name";
      name.textContent = option.name;
      const code = document.createElement("span");
      code.className = "mg-combo-code";
      code.textContent = option.code;
      const badge = document.createElement("span");
      badge.className = `mg-combo-row-badge ${option.badgeKind}`;
      badge.textContent = option.badge;
      row.append(box, name, code, badge);
      row.addEventListener("click", () => config.toggle(option.id));
      dropdown.append(row);
    }
  }

  field.addEventListener("click", () => {
    open = true;
    input.focus();
    render();
  });
  input.addEventListener("focus", () => {
    open = true;
    render();
  });
  input.addEventListener("input", () => {
    query = input.value;
    open = true;
    render();
  });
  document.addEventListener("mousedown", (event) => {
    if (open && !control.contains(event.target as Node)) {
      close();
    }
  });

  return { render, close };
}

// ---------- Material grabber: derived manifest ----------

function grabQualityFor(height: number | null): GrabQuality | undefined {
  return grabMetadata?.qualities.find((quality) => quality.height === height);
}

function grabAudioTrackFor(id: string): GrabAudioTrack | undefined {
  return grabMetadata?.audioTracks.find((track) => track.id === id);
}

function grabSubtitleTrackFor(id: string): GrabSubtitleTrack | undefined {
  return grabMetadata?.subtitles.find((track) => track.id === id);
}

function grabBaseName(): string {
  const title = grabMetadata?.title ?? "material";
  return (
    title
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 60) || "material"
  );
}

/// Subtitle sizes are not in the probe; scale from duration the way captions do.
function grabSubtitleSize(format: string): number | null {
  const duration = grabMetadata?.duration;
  if (!duration) {
    return null;
  }
  const bytesPerSecond = format === "json3" ? 190 : 50;
  return Math.round(duration * bytesPerSecond);
}

function grabManifest(): GrabManifestFile[] {
  if (!grabMetadata) {
    return [];
  }
  const files: GrabManifestFile[] = [];
  const base = grabBaseName();
  const quality = grabQualityFor(grabSel.quality);
  const heightLabel = quality ? `${quality.height}p` : "best";
  const videoSize = quality?.sizeBytes ?? null;
  const audioLangs = grabSel.audio ? grabSel.audioSel : [];
  const muxed = grabSel.mux === "muxed";

  if (grabSel.video && audioLangs.length > 0 && muxed) {
    for (const id of audioLangs) {
      const track = grabAudioTrackFor(id);
      const suffix = id ? `.${id}` : "";
      files.push({
        kind: "MP4",
        tone: "vid",
        name: `${base}.${heightLabel}${suffix}.mp4`,
        detail: `Video ${heightLabel} + ${track?.name ?? id} audio`,
        sizeBytes:
          videoSize === null && track?.sizeBytes === undefined
            ? null
            : (videoSize ?? 0) + (track?.sizeBytes ?? 0),
      });
    }
  } else if (grabSel.video) {
    files.push({
      kind: "MP4",
      tone: "vid",
      name: `${base}.${heightLabel}.video.mp4`,
      detail: `Silent video ${heightLabel}`,
      sizeBytes: videoSize,
    });
  }

  if (audioLangs.length > 0 && (!grabSel.video || !muxed)) {
    for (const id of audioLangs) {
      const track = grabAudioTrackFor(id);
      files.push({
        kind: "M4A",
        tone: "aud",
        name: `${base}.${id || "audio"}.m4a`,
        detail: `${track?.name ?? id} audio`,
        sizeBytes: track?.sizeBytes ?? null,
      });
    }
  }

  if (grabSel.subs) {
    for (const id of grabSel.subSel) {
      const track = grabSubtitleTrackFor(id);
      if (!track) {
        continue;
      }
      for (const format of grabSel.fmtSel) {
        const prefix = track.auto ? "auto." : "";
        files.push({
          kind: format.toUpperCase(),
          tone: "sub",
          name: `${base}.${prefix}${track.language}.${format}`,
          detail: `${track.name} · ${track.auto ? "auto" : "manual"} captions`,
          sizeBytes: grabSubtitleSize(format),
        });
      }
    }
  }

  const chapters = grabMetadata.chapters ?? [];
  if (grabSel.chapters && chapters.length > 0) {
    for (const format of grabSel.chapFmtSel) {
      files.push({
        kind: format === "txt" ? "TXT" : "JSON",
        tone: "chp",
        name: `${base}.chapters.${format}`,
        detail: `${chapters.length} chapters · ${
          format === "json" ? "start and end times" : "description style"
        }`,
        sizeBytes: grabChapterSize(chapters, format),
      });
    }
  }

  return files;
}

/// Chapter files are written locally from data already in hand, so their size
/// is the rendered text rather than anything the probe reports.
function grabChapterSize(chapters: GrabChapter[], format: string): number {
  const titles = chapters.reduce((sum, chapter) => sum + chapter.title.length, 0);
  return titles + chapters.length * (format === "json" ? 78 : 8) + 2;
}

function formatByteSize(bytes: number | null): string {
  if (bytes === null || bytes <= 0) {
    return "—";
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ---------- Material grabber: rendering ----------

function renderGrabQualityPills() {
  grabQualityPills.replaceChildren();
  for (const quality of grabMetadata?.qualities ?? []) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "mg-pill";
    pill.classList.toggle("selected", grabSel.quality === quality.height);
    const label = document.createElement("span");
    label.className = "mg-pill-label";
    label.textContent = quality.label;
    pill.append(label);
    if (quality.codec) {
      const codec = document.createElement("span");
      codec.className = "mg-pill-meta";
      codec.textContent = quality.codec;
      pill.append(codec);
    }
    pill.addEventListener("click", () => {
      grabSel.quality = quality.height;
      renderGrabSelection();
    });
    grabQualityPills.append(pill);
  }
}

/// Renders the format pills for one track. At least one format must stay
/// selected, so deselecting the last one is a no-op.
function renderFormatPills(
  host: HTMLElement,
  formats: readonly (readonly [string, string])[],
  selected: () => string[],
  apply: (next: string[]) => void,
) {
  host.replaceChildren();
  for (const [id, label] of formats) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "mg-pill mg-pill-sm";
    pill.classList.toggle("selected", selected().includes(id));
    pill.textContent = label;
    pill.addEventListener("click", () => {
      const current = selected();
      if (current.includes(id)) {
        if (current.length === 1) {
          return;
        }
        apply(current.filter((value) => value !== id));
      } else {
        apply([...current, id]);
      }
      renderGrabSelection();
    });
    host.append(pill);
  }
}

function renderGrabFormatPills() {
  renderFormatPills(
    grabFormatPills,
    [
      ["srt", "SRT"],
      ["vtt", "WebVTT"],
      ["json3", "JSON3"],
    ],
    () => grabSel.fmtSel,
    (next) => {
      grabSel.fmtSel = next;
    },
  );
}

/// Unlike a duration, a chapter start of 0 is a real value rather than
/// "unknown", so this cannot fall back the way formatDuration does.
function formatChapterTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const paddedSeconds = String(secs).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`
    : `${minutes}:${paddedSeconds}`;
}

function renderGrabChapterCard() {
  const chapters = grabMetadata?.chapters ?? [];
  // Nothing to offer when the uploader never wrote any.
  grabChaptersCard.hidden = chapters.length === 0;
  if (chapters.length === 0) {
    return;
  }
  grabChaptersSubtitle.textContent = `${chapters.length} section${
    chapters.length === 1 ? "" : "s"
  } the uploader marked in the description`;

  renderFormatPills(
    grabChapterFormatPills,
    [
      ["json", "JSON"],
      ["txt", "Plain text"],
    ],
    () => grabSel.chapFmtSel,
    (next) => {
      grabSel.chapFmtSel = next;
    },
  );

  grabChaptersCopyButton.textContent = chapterCopyLabel();

  grabChaptersList.replaceChildren();
  for (const chapter of chapters) {
    const row = document.createElement("div");
    row.className = "mg-chapter-row";
    const time = document.createElement("span");
    time.className = "mg-chapter-time";
    time.textContent = formatChapterTime(chapter.start);
    const title = document.createElement("span");
    title.className = "mg-chapter-title";
    title.textContent = chapter.title;
    row.append(time, title);
    grabChaptersList.append(row);
  }
}

function renderGrabManifest() {
  const files = grabManifest();
  grabFileCount.textContent = files.length === 1 ? "1 file" : `${files.length} files`;

  grabManifestList.replaceChildren();
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mg-manifest-empty";
    empty.textContent = "Nothing selected yet. Turn on a track above.";
    grabManifestList.append(empty);
  } else {
    for (const file of files) {
      const row = document.createElement("div");
      row.className = "mg-manifest-row";
      const chip = document.createElement("div");
      chip.className = `mg-kind-chip mg-tone-${file.tone}`;
      chip.textContent = file.kind;
      const middle = document.createElement("div");
      middle.className = "mg-manifest-main";
      const name = document.createElement("div");
      name.className = "mg-manifest-name";
      name.textContent = file.name;
      const detail = document.createElement("div");
      detail.className = "mg-manifest-detail";
      detail.textContent = file.detail;
      middle.append(name, detail);
      const size = document.createElement("div");
      size.className = "mg-manifest-size";
      size.textContent = formatByteSize(file.sizeBytes);
      row.append(chip, middle, size);
      grabManifestList.append(row);
    }
  }

  const known = files.filter((file) => file.sizeBytes !== null);
  const total = known.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
  grabTotalSize.textContent =
    files.length === 0 ? "—" : known.length === 0 ? "unknown" : formatByteSize(total);

  grabDownloadButton.textContent = files.length
    ? `Download ${files.length === 1 ? "1 file" : `${files.length} files`}`
    : "Download nothing";
}

function renderGrabSelection() {
  if (!grabMetadata) {
    return;
  }
  for (const [card, body, toggle, on] of [
    [grabVideoCard, grabVideoBody, grabVideoSwitch, grabSel.video],
    [grabAudioCard, grabAudioBody, grabAudioSwitch, grabSel.audio],
    [grabSubsCard, grabSubsBody, grabSubsSwitch, grabSel.subs],
    [grabChaptersCard, grabChaptersBody, grabChaptersSwitch, grabSel.chapters],
  ] as const) {
    card.classList.toggle("off", !on);
    body.hidden = !on;
    toggle.classList.toggle("on", on);
    toggle.setAttribute("aria-checked", String(on));
  }

  renderGrabQualityPills();
  grabAudioCombo?.render();
  grabSubCombo?.render();
  renderGrabFormatPills();
  renderGrabChapterCard();

  // Packaging is only meaningful when both video and audio are on.
  grabMuxSection.hidden = !(grabSel.video && grabSel.audio);
  grabMuxMuxedButton.classList.toggle("selected", grabSel.mux === "muxed");
  grabMuxSeparateButton.classList.toggle("selected", grabSel.mux === "separate");

  renderGrabManifest();
  applyGrabControlState();
}

let grabAudioCombo: ReturnType<typeof createLanguageCombobox> | null = null;
let grabSubCombo: ReturnType<typeof createLanguageCombobox> | null = null;

function toggleGrabAudioLanguage(id: string) {
  grabSel.audioSel = grabSel.audioSel.includes(id)
    ? grabSel.audioSel.filter((value) => value !== id)
    : [...grabSel.audioSel, id];
  renderGrabSelection();
}

function toggleGrabSubtitleTrack(id: string) {
  grabSel.subSel = grabSel.subSel.includes(id)
    ? grabSel.subSel.filter((value) => value !== id)
    : [...grabSel.subSel, id];
  renderGrabSelection();
}

function canStartGrab(): boolean {
  return !downloaderActionRequired() && grabMetadata !== null && grabManifest().length > 0;
}

function applyGrabControlState(running = currentStatus.status === "running") {
  const hasMetadata = grabMetadata !== null;
  const downloaderBlocked = downloaderActionRequired();
  grabberStartButton.textContent = running && !hasMetadata ? "Scanning" : hasMetadata ? "Re-scan" : "Scan";
  grabberStartButton.disabled = running || downloaderBlocked || !grabUrl.value.trim();
  grabberStartButton.hidden = running && hasMetadata;
  grabberStopButton.hidden = !running;
  grabDownloadButton.disabled = running || !canStartGrab();
  grabDownloaderAction.disabled = running || downloaderStatusLoading;
  for (const control of [
    grabVideoSwitch,
    grabAudioSwitch,
    grabSubsSwitch,
    grabChaptersSwitch,
    grabChaptersCopyButton,
    grabMatchAudioButton,
    grabMuxMuxedButton,
    grabMuxSeparateButton,
  ]) {
    control.disabled = running || !hasMetadata;
  }
  grabOutputBrowseButton.disabled = running;
  grabOutputOpenButton.disabled = running || !grabOutputDir.value.trim();
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
  resetGrabContentPreview(true);
  grabMetadata = null;
  grabberMetadataSection.hidden = true;
  grabSourceStatus.hidden = true;
  grabSel = defaultGrabSelection();
  applyGrabControlState();
}

function renderGrabMetadata(metadata: GrabMetadata) {
  grabberMetadataSection.hidden = false;
  grabberTitle.textContent = metadata.title;

  const durationLabel = formatDuration(metadata.duration);
  grabThumbImage.hidden = !metadata.thumbnail;
  if (metadata.thumbnail) {
    grabThumbImage.src = metadata.thumbnail;
  }
  grabThumbDuration.hidden = !durationLabel;
  grabThumbDuration.textContent = durationLabel ?? "";

  const original = metadata.audioTracks.find((track) => track.original);
  const maxHeight = metadata.qualities[0]?.label;
  grabberMetaLine.replaceChildren();
  const parts = [
    metadata.extractor,
    durationLabel,
    maxHeight ? `up to ${maxHeight}` : null,
    original ? `original audio: ${original.name}` : null,
  ].filter((part): part is string => Boolean(part));
  parts.forEach((part, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "mg-meta-separator";
      separator.textContent = "/";
      grabberMetaLine.append(separator);
    }
    const span = document.createElement("span");
    span.textContent = part;
    grabberMetaLine.append(span);
  });

  const audioCount = metadata.audioTracks.length;
  const subCount = metadata.subtitles.length;
  grabSourceStatus.hidden = false;
  grabSourceStatusText.textContent = `${audioCount} audio · ${subCount} subtitle ${
    subCount === 1 ? "track" : "tracks"
  } found`;

  // Default to 1080p (or the closest lower option), the original audio track,
  // and any German/English subtitles the video happens to carry.
  grabSel.quality =
    (metadata.qualities.find((quality) => quality.height === 1080) ??
      metadata.qualities.find((quality) => quality.height < 1080) ??
      metadata.qualities[0])?.height ?? null;
  grabSel.audioSel = original ? [original.id] : metadata.audioTracks.slice(0, 1).map((t) => t.id);
  const preferred = metadata.subtitles.filter(
    (track) => track.language === "de" || track.language === "en" || track.language.startsWith("en-"),
  );
  const manualPreferred = preferred.filter((track) => !track.auto);
  grabSel.subSel = (manualPreferred.length > 0 ? manualPreferred : preferred.slice(0, 1)).map(
    (track) => track.id,
  );
  grabSel.subs = grabSel.subSel.length > 0;
  grabSel.audio = metadata.audioTracks.length > 0;
  grabSel.video = metadata.qualities.length > 0;
  grabSel.chapters = metadata.chapters.length > 0;

  grabAudioCombo = createLanguageCombobox({
    root: grabAudioComboRoot,
    tone: "aud",
    noun: "audio tracks",
    options: () =>
      (grabMetadata?.audioTracks ?? []).map((track) => ({
        id: track.id,
        name: track.name,
        code: track.id || "und",
        badge: track.original ? "original" : "dubbed",
        badgeKind: track.original ? "primary" : "muted",
      })),
    selected: () => grabSel.audioSel,
    toggle: toggleGrabAudioLanguage,
  });
  grabSubCombo = createLanguageCombobox({
    root: grabSubComboRoot,
    tone: "sub",
    noun: "subtitle tracks",
    options: () =>
      (grabMetadata?.subtitles ?? []).map((track) => ({
        id: track.id,
        name: track.name,
        code: track.language,
        badge: track.auto ? "auto" : "manual",
        badgeKind: track.auto ? "muted" : "primary",
      })),
    selected: () => grabSel.subSel,
    toggle: toggleGrabSubtitleTrack,
  });

  renderGrabSelection();
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
const imageExtensions = ["png", "jpg", "jpeg", "webp", "bmp"];

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

function pathExtension(path: string): string {
  const name = fileName(path);
  const dotIndex = name.lastIndexOf(".");
  return dotIndex === -1 ? "" : name.slice(dotIndex + 1).toLowerCase();
}

function pathHasAudioExtension(path: string): boolean {
  return audioExtensions.includes(pathExtension(path));
}

function mergeOutputExtension(): "m4a" | "mp4" {
  return mergeMediaPaths[0] && pathHasAudioExtension(mergeMediaPaths[0]) ? "m4a" : "mp4";
}

function defaultMergeOutputPath(): string {
  const firstPath = mergeMediaPaths[0];
  if (!firstPath) {
    return "";
  }
  const separatorIndex = Math.max(firstPath.lastIndexOf("/"), firstPath.lastIndexOf("\\"));
  const directory = separatorIndex === -1 ? "" : firstPath.slice(0, separatorIndex + 1);
  const name = firstPath.slice(separatorIndex + 1);
  const stem = name.replace(/\.[^.]*$/, "") || "merged";
  const extension = mergeOutputExtension();
  return `${directory}${stem}.merged.${extension}`;
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

function syncAudioVideoOutputPath() {
  const outputPath = defaultAudioVideoOutputPath();
  audioVideoOutputPath.value = outputPath;
  workflowOutputPaths.audioVideo.textContent = outputPath;
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
    syncAudioVideoOutputPath();
    setActiveWorkflow("audioVideo");
    setAudioVideoStatus();
  }
}

async function chooseImageForVideo() {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Image", extensions: imageExtensions }],
  });
  if (typeof selected === "string") {
    audioVideoImagePath.value = selected;
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
    message: mergeMediaPaths.length >= 2 ? "Ready to merge" : "Select at least two media files",
  });
}

function applyMergeControlState(running = currentStatus.status === "running") {
  mergerStartButton.disabled = running || mergeMediaPaths.length < 2;
  mergerClearButton.disabled = running || mergeMediaPaths.length === 0;
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
        button.disabled = Number(button.dataset.index) === mergeMediaPaths.length - 1;
      } else {
        button.disabled = false;
      }
    });
}

function moveMergeMedia(index: number, direction: -1 | 1) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= mergeMediaPaths.length) {
    return;
  }
  const [path] = mergeMediaPaths.splice(index, 1);
  mergeMediaPaths.splice(targetIndex, 0, path);
  renderMergeList();
  setMergerStatus();
}

function removeMergeMedia(index: number) {
  mergeMediaPaths.splice(index, 1);
  if (mergeMediaPaths.length === 0) {
    mergerOutputPath.value = "";
  }
  renderMergeList();
  setMergerStatus();
}

function renderMergeList() {
  mergerFileList.replaceChildren();
  if (mergeMediaPaths.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "No media selected.";
    mergerFileList.append(empty);
    applyMergeControlState();
    return;
  }

  mergeMediaPaths.forEach((path, index) => {
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
    up.addEventListener("click", () => moveMergeMedia(index, -1));

    const down = document.createElement("button");
    down.className = "icon-button";
    down.type = "button";
    down.title = "Move down";
    down.dataset.direction = "down";
    down.dataset.index = String(index);
    down.disabled = index === mergeMediaPaths.length - 1;
    down.innerHTML = `<i data-lucide="arrow-down"></i>`;
    down.addEventListener("click", () => moveMergeMedia(index, 1));

    const remove = document.createElement("button");
    remove.className = "icon-button";
    remove.type = "button";
    remove.title = "Remove";
    remove.innerHTML = `<i data-lucide="trash-2"></i>`;
    remove.addEventListener("click", () => removeMergeMedia(index));

    actions.append(up, down, remove);
    row.append(indexLabel, meta, actions);
    mergerFileList.append(row);
  });

  createIcons({ icons: { ArrowDown, ArrowUp, Trash2 } });
  applyMergeControlState();
}

async function chooseMergeMedia() {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Media", extensions: [...videoExtensions, ...audioExtensions] }],
  });
  const paths = Array.isArray(selected)
    ? selected
    : typeof selected === "string"
      ? [selected]
      : [];
  if (paths.length === 0) {
    return;
  }
  const existing = new Set(mergeMediaPaths);
  mergeMediaPaths = [...mergeMediaPaths, ...paths.filter((path) => !existing.has(path))];
  if (!mergerOutputPath.value.trim()) {
    mergerOutputPath.value = defaultMergeOutputPath();
  }
  setActiveWorkflow("merger");
  renderMergeList();
  setMergerStatus();
}

async function chooseMergeOutput() {
  const extension = mergeOutputExtension();
  const selected = await save({
    defaultPath: mergerOutputPath.value.trim() || defaultMergeOutputPath() || `merged.${extension}`,
    filters: [
      {
        name: extension === "m4a" ? "M4A audio" : "MP4 video",
        extensions: [extension],
      },
    ],
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

async function openGrabOutputDirectory() {
  const directory = grabOutputDir.value.trim();
  if (!directory) {
    return;
  }
  try {
    await invoke("open_directory", { options: { path: directory } });
  } catch (error) {
    setActiveWorkflow("grabber");
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
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
audioVideoAudioPath.addEventListener("input", () => {
  syncAudioVideoOutputPath();
  setAudioVideoStatus();
});
audioVideoImageBrowseButton.addEventListener("click", () => void chooseImageForVideo());
audioVideoAudioPath.addEventListener("change", () => {
  syncAudioVideoOutputPath();
  setAudioVideoStatus();
});
audioVideoImagePath.addEventListener("change", setAudioVideoStatus);
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
mergerAddButton.addEventListener("click", () => void chooseMergeMedia());
mergerClearButton.addEventListener("click", () => {
  mergeMediaPaths = [];
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
grabOutputOpenButton.addEventListener("click", () => void openGrabOutputDirectory());
grabberDownloadViewButton.addEventListener("click", () => setGrabMetadataView("download"));
grabberPreviewViewButton.addEventListener("click", () => setGrabMetadataView("preview"));
grabOutputDir.addEventListener("input", () => {
  workflowOutputPaths.grabber.textContent = grabOutputDir.value.trim();
  setRunControls(currentStatus.status === "running");
  applyGrabControlState();
});
grabOutputDir.addEventListener("change", () => {
  void loadMaterialGallery();
  resetGrabContentPreview(true);
});
materialRefreshButton.addEventListener("click", () => void loadMaterialGallery());
grabContentRefreshButton.addEventListener("click", () => {
  disarmGrabDeleteButton();
  void loadGrabContentFiles(grabPreviewPath);
});
grabContentDeleteButton.addEventListener("click", () => void deleteGrabContentFile());
grabContentCopyButton.addEventListener("click", () => void copyGrabContent());
grabUrl.addEventListener("input", () => {
  resetGrabMetadata();
  setStatus({
    status: "idle",
    phase: "fetch",
    message: grabUrl.value.trim() ? "Scan to load options" : "Paste a URL to begin",
  });
});
grabUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !grabberStartButton.disabled) {
    void inspectGrabUrl();
  }
});
grabVideoSwitch.addEventListener("click", () => {
  grabSel.video = !grabSel.video;
  renderGrabSelection();
});
grabAudioSwitch.addEventListener("click", () => {
  grabSel.audio = !grabSel.audio;
  renderGrabSelection();
});
grabSubsSwitch.addEventListener("click", () => {
  grabSel.subs = !grabSel.subs;
  renderGrabSelection();
});
grabChaptersSwitch.addEventListener("click", () => {
  grabSel.chapters = !grabSel.chapters;
  renderGrabSelection();
});
grabChaptersCopyButton.addEventListener("click", () => void copyGrabChapters());
grabMuxMuxedButton.addEventListener("click", () => {
  grabSel.mux = "muxed";
  renderGrabSelection();
});
grabMuxSeparateButton.addEventListener("click", () => {
  grabSel.mux = "separate";
  renderGrabSelection();
});
grabMatchAudioButton.addEventListener("click", () => {
  // Copy the audio selection across, preferring a manual track per language.
  const tracks = grabMetadata?.subtitles ?? [];
  grabSel.subSel = grabSel.audioSel
    .map((id) => {
      const language = id.split("-")[0];
      const forLanguage = tracks.filter(
        (track) => track.language === id || track.language.split("-")[0] === language,
      );
      return (forLanguage.find((track) => !track.auto) ?? forLanguage[0])?.id;
    })
    .filter((id): id is string => id !== undefined);
  grabSel.subs = true;
  renderGrabSelection();
});
grabOutputSettingsButton.addEventListener("click", () => {
  grabOutputSettings.hidden = !grabOutputSettings.hidden;
});
grabDownloadButton.addEventListener("click", () => void downloadGrabSelection());

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
    imagePath: audioVideoImagePath.value.trim(),
    outputPath: audioVideoOutputPath.value.trim(),
    resolution: audioVideoResolution,
    background: audioVideoBackground,
  }),
);

mergerStartButton.addEventListener("click", () =>
  startRun("merger", "start_merge", {
    mediaPaths: mergeMediaPaths,
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
  if (downloaderActionRequired()) {
    setStatus({
      status: "error",
      phase: "error",
      message: downloaderStatus?.message ?? "Update yt-dlp before scanning this URL.",
    });
    return;
  }
  setActiveWorkflow("grabber");
  runningWorkflow = "grabber";
  clearLog();
  resetGrabMetadata();
  setStatus({
    status: "running",
    phase: "fetch",
    message: "Fetching material metadata",
  });
  await waitForVisibleUpdate();
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
      message: "Choose the tracks you want",
    });
  } catch (error) {
    setStatus({
      status: "error",
      phase: "error",
      message: String(error),
    });
  } finally {
    applyGrabControlState();
    void loadDownloaderStatus();
  }
}

async function downloadGrabSelection() {
  if (!canStartGrab()) {
    return;
  }
  setActiveWorkflow("grabber");
  runningWorkflow = "grabber";
  clearLog();
  try {
    const wantsVideo = grabSel.video;
    const wantsAudio = grabSel.audio && grabSel.audioSel.length > 0;
    const subTracks = grabSel.subs
      ? grabSel.subSel
          .map((id) => grabSubtitleTrackFor(id))
          .filter((track): track is GrabSubtitleTrack => track !== undefined)
      : [];
    setStatus({
      status: "running",
      phase: wantsVideo || wantsAudio ? "download" : "subtitles",
      message: wantsVideo
        ? "Downloading video"
        : wantsAudio
          ? "Downloading audio"
          : "Saving subtitles",
    });
    await waitForVisibleUpdate();
    const outputDir = await invoke<string>("start_grab", {
      options: {
        url: grabUrl.value.trim(),
        outputDir: grabOutputDir.value.trim(),
        video: wantsVideo,
        quality: grabSel.quality === null ? "best" : String(grabSel.quality),
        audio: wantsAudio,
        audioLangs: wantsAudio ? grabSel.audioSel : [],
        mux: grabSel.mux === "separate" ? "separate" : "single",
        subs: subTracks.length > 0,
        manualLangs: subTracks.filter((track) => !track.auto).map((track) => track.language),
        autoLangs: subTracks.filter((track) => track.auto).map((track) => track.language),
        subtitleFormats: grabSel.fmtSel,
        chapters: grabSel.chapters && (grabMetadata?.chapters.length ?? 0) > 0,
        chapterFormats: grabSel.chapFmtSel,
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

grabberStartButton.addEventListener("click", () => void inspectGrabUrl());
grabDownloaderAction.addEventListener("click", () =>
  void startRun("grabber", "start_downloader_install", {
    outputDir: grabOutputDir.value.trim(),
  }),
);

// ---------- Subtitle player ----------

type SubtitleFileEntry = { path: string; fileName: string };
type SubtitleCue = { start: number; end: number; text: string };
type CueTimingAdjustment = { startDelta: number; endDelta: number };
type CueJumpInfo = { after: number | null };

const JUMP_GAP_SECONDS = 0.35;

let playerCues: SubtitleCue[] = [];
let playerCueItems: HTMLElement[] = [];
let playerActiveCue = -1;
let playerEditingCue = -1;
let playerReplayUntil: number | null = null;
let playerCueAdjustments = new Map<string, CueTimingAdjustment>();
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
  playerCueItems[index]?.classList.toggle("ignored", playerIgnoredKeys.has(key));
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

function cueAdjustment(cue: SubtitleCue): CueTimingAdjustment {
  return playerCueAdjustments.get(cueKey(cue)) ?? { startDelta: 0, endDelta: 0 };
}

function adjustedCueStart(cue: SubtitleCue): number {
  return Math.max(0, cue.start + cueAdjustment(cue).startDelta);
}

function adjustedCueEnd(cue: SubtitleCue): number {
  return Math.max(adjustedCueStart(cue), cue.end + cueAdjustment(cue).endDelta);
}

function cuePlaybackStart(cue: SubtitleCue): number {
  return adjustedCueStart(cue);
}

function cuePlaybackEnd(cue: SubtitleCue): number {
  return adjustedCueEnd(cue);
}

function formatSignedSeconds(value: number): string {
  return (value >= 0 ? "+" : "") + value.toFixed(1) + "s";
}

function formatGapSeconds(value: number): string {
  return value < 10 ? value.toFixed(1) + "s" : formatCueTime(value);
}

function cueAdjustmentStorageKey(path = playerSubtitleFile): string {
  return "dialogue-cut:cue-adjustments:" + path;
}

function loadCueAdjustments(path: string): Map<string, CueTimingAdjustment> {
  try {
    const raw = window.localStorage.getItem(cueAdjustmentStorageKey(path));
    if (!raw) {
      return new Map();
    }
    const parsed = JSON.parse(raw) as Record<string, CueTimingAdjustment>;
    return new Map(
      Object.entries(parsed).filter(
        ([, value]) =>
          typeof value?.startDelta === "number" && typeof value?.endDelta === "number",
      ),
    );
  } catch {
    return new Map();
  }
}

function persistCueAdjustments() {
  if (!playerSubtitleFile) {
    return;
  }
  const entries = [...playerCueAdjustments.entries()].filter(
    ([, value]) => value.startDelta !== 0 || value.endDelta !== 0,
  );
  if (entries.length === 0) {
    window.localStorage.removeItem(cueAdjustmentStorageKey());
    return;
  }
  window.localStorage.setItem(cueAdjustmentStorageKey(), JSON.stringify(Object.fromEntries(entries)));
}

function cueJumpInfos(): CueJumpInfo[] {
  const infos = playerCues.map(() => ({ after: null }) as CueJumpInfo);
  let previousIndex: number | null = null;

  playerCues.forEach((cue, index) => {
    if (isCueIgnored(cue)) {
      return;
    }
    if (previousIndex !== null) {
      const previous = playerCues[previousIndex];
      const gap = cuePlaybackStart(cue) - cuePlaybackEnd(previous);
      if (gap > JUMP_GAP_SECONDS) {
        infos[previousIndex].after = gap;
      }
    }
    previousIndex = index;
  });

  return infos;
}

function cueJumpCount(): number {
  return cueJumpInfos().filter((info) => info.after !== null).length;
}

function cueIndexAt(time: number): number {
  let candidate = -1;
  for (let index = 0; index < playerCues.length; index += 1) {
    const cue = playerCues[index];
    const start = cuePlaybackStart(cue);
    if (start > time + 0.05) {
      break;
    }
    if (time <= cuePlaybackEnd(cue) + 0.05) {
      candidate = index;
    }
  }
  return candidate;
}

function seekToCue(index: number) {
  const cue = playerCues[index];
  if (!cue) {
    return;
  }
  playerVideo.currentTime = cuePlaybackStart(cue);
  void playerVideo.play();
}

function setActivePlayerCue(index: number) {
  if (index === playerActiveCue) {
    return;
  }
  playerCueItems[playerActiveCue]?.classList.remove("active");
  playerActiveCue = index;
  const item = playerCueItems[index];
  if (item) {
    item.classList.add("active");
    if (playerFollow.checked) {
      // Keep the active cue pinned to the top of the scroll window so the
      // upcoming dialogue is always visible below it.
      playerCueList.scrollTo({ top: item.offsetTop, behavior: "smooth" });
    }
  }
}

type ExportPlan = {
  ranges: { start: number; end: number }[];
  // Kept cues retimed to the cut's compressed timeline.
  cues: SubtitleCue[];
  totalSeconds: number;
};

// Mirrors dialogue-only playback: each kept cue plays through its adjusted
// per-segment window. The same plan drives the runtime estimate and export.
function buildExportPlan(): ExportPlan {
  const ranges: { start: number; end: number }[] = [];
  const cues: SubtitleCue[] = [];
  let elapsedBefore = 0;
  for (const cue of playerCues) {
    if (isCueIgnored(cue)) {
      continue;
    }
    const start = cuePlaybackStart(cue);
    const end = cuePlaybackEnd(cue);
    const textStart = adjustedCueStart(cue);
    const textEnd = adjustedCueEnd(cue);
    let range = ranges[ranges.length - 1];
    if (range && start <= range.end + JUMP_GAP_SECONDS) {
      range.end = Math.max(range.end, end);
    } else {
      if (range) {
        elapsedBefore += range.end - range.start;
      }
      range = { start, end };
      ranges.push(range);
    }
    cues.push({
      start: elapsedBefore + Math.max(0, textStart - range.start),
      end: elapsedBefore + Math.max(0, textEnd - range.start),
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
  const jumpCount = cueJumpCount();
  const cleanupParts = [
    jumpCount > 0 ? `${jumpCount} jumps` : "",
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
  playerCueItems = [];
  playerActiveCue = -1;
  updatePlayerSummary();
  if (playerCues.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "No cues found in the selected subtitles.";
    playerCueList.append(empty);
    return;
  }
  const jumpInfos = cueJumpInfos();
  playerCues.forEach((cue, index) => {
    const jumpInfo = jumpInfos[index] ?? { after: null };
    const adjustment = cueAdjustment(cue);
    const isAdjusted = adjustment.startDelta !== 0 || adjustment.endDelta !== 0;
    const item = document.createElement("div");
    item.className = "cue-item";
    item.classList.toggle("editing", playerEditingCue === index);
    item.classList.toggle("ignored", isCueIgnored(cue));
    item.classList.toggle("adjusted", isAdjusted);
    item.classList.toggle("jump-after", jumpInfo.after !== null);

    const row = document.createElement("div");
    row.className = "cue-row";

    const seekButton = document.createElement("button");
    seekButton.className = "cue-seek";
    seekButton.type = "button";
    seekButton.addEventListener("click", () => seekToCue(index));

    const time = document.createElement("span");
    time.className = "cue-time";
    time.textContent = `${formatCueTime(adjustedCueStart(cue))} → ${formatCueTime(adjustedCueEnd(cue))}`;
    const text = document.createElement("span");
    text.className = "cue-text";
    text.textContent = cue.text;

    const jumpMarkers = document.createElement("span");
    jumpMarkers.className = "cue-jump-markers";
    if (jumpInfo.after !== null) {
      const jumpOut = document.createElement("span");
      jumpOut.className = "cue-jump-badge out";
      jumpOut.textContent = `Jump out · ${formatGapSeconds(jumpInfo.after)}`;
      jumpMarkers.append(jumpOut);
    }

    const actions = document.createElement("span");
    actions.className = "cue-actions";
    const adjust = document.createElement("button");
    adjust.className = "cue-adjust";
    adjust.classList.toggle("has-adjustment", isAdjusted);
    adjust.type = "button";
    adjust.textContent = playerEditingCue === index ? "Done" : isAdjusted ? "Adjusted" : "Adjust";
    adjust.addEventListener("click", () => {
      if (playerEditingCue === index) {
        playerEditingCue = -1;
        playerReplayUntil = null;
        renderPlayerCues();
        return;
      }
      playerEditingCue = index;
      renderPlayerCues();
      previewCueSegment(index);
    });
    const ignore = document.createElement("button");
    ignore.className = "cue-ignore";
    ignore.type = "button";
    ignore.textContent = "×";
    ignore.title = "Ignore this segment";
    ignore.addEventListener("click", () => {
      toggleCueIgnore(index);
    });
    actions.append(adjust, ignore);

    seekButton.append(time, text);
    if (jumpMarkers.childElementCount > 0) {
      seekButton.append(jumpMarkers);
    }
    row.append(seekButton, actions);
    item.append(row);

    if (playerEditingCue === index) {
      item.append(renderCueAdjustmentPanel(cue, index));
    }

    playerCueList.append(item);
    playerCueItems.push(item);
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
    playerCueAdjustments = loadCueAdjustments(path);
    playerEditingCue = -1;
    playerReplayUntil = null;
    playerCues = cleanCues(parseSubtitles(content));
    renderPlayerCues();
  } catch (error) {
    playerSubtitleFile = "";
    playerIgnoredKeys = new Set();
    playerCueAdjustments = new Map();
    playerEditingCue = -1;
    playerReplayUntil = null;
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

function setCueTimingAdjustment(index: number, patch: Partial<CueTimingAdjustment>, replay = true) {
  const cue = playerCues[index];
  if (!cue) {
    return;
  }
  const current = cueAdjustment(cue);
  const next = {
    startDelta: Math.min(5, Math.max(-5, patch.startDelta ?? current.startDelta)),
    endDelta: Math.min(5, Math.max(-5, patch.endDelta ?? current.endDelta)),
  };
  const key = cueKey(cue);
  if (next.startDelta === 0 && next.endDelta === 0) {
    playerCueAdjustments.delete(key);
  } else {
    playerCueAdjustments.set(key, next);
  }
  persistCueAdjustments();
  renderPlayerCues();
  if (replay) {
    previewCueSegment(index);
  }
}

function nudgeCueTiming(index: number, field: keyof CueTimingAdjustment, delta: number) {
  const cue = playerCues[index];
  if (!cue) {
    return;
  }
  const current = cueAdjustment(cue);
  setCueTimingAdjustment(index, { [field]: Number((current[field] + delta).toFixed(1)) });
}

function shiftCueTiming(index: number, delta: number) {
  const cue = playerCues[index];
  if (!cue) {
    return;
  }
  const current = cueAdjustment(cue);
  setCueTimingAdjustment(index, {
    startDelta: Number((current.startDelta + delta).toFixed(1)),
    endDelta: Number((current.endDelta + delta).toFixed(1)),
  });
}

function resetCueTiming(index: number) {
  setCueTimingAdjustment(index, { startDelta: 0, endDelta: 0 });
}

function previewCueSegment(index: number) {
  const cue = playerCues[index];
  if (!cue) {
    return;
  }
  playerReplayUntil = cuePlaybackEnd(cue);
  seekToCue(index);
}

function renderCueAdjustmentPanel(cue: SubtitleCue, index: number): HTMLElement {
  const adjustment = cueAdjustment(cue);
  const panel = document.createElement("div");
  panel.className = "cue-adjust-panel";

  const makeGroup = (
    label: string,
    value: string,
    earlier: () => void,
    later: () => void,
  ) => {
    const group = document.createElement("span");
    group.className = "cue-adjust-group";

    const name = document.createElement("span");
    name.className = "cue-adjust-label";
    name.textContent = label;

    const earlierButton = document.createElement("button");
    earlierButton.type = "button";
    earlierButton.textContent = "Earlier";
    earlierButton.addEventListener("click", earlier);

    const laterButton = document.createElement("button");
    laterButton.type = "button";
    laterButton.textContent = "Later";
    laterButton.addEventListener("click", later);

    const current = document.createElement("span");
    current.className = "cue-adjust-value";
    current.textContent = value;

    group.append(name, earlierButton, laterButton, current);
    return group;
  };

  const startGroup = makeGroup(
    "Start",
    formatSignedSeconds(adjustment.startDelta),
    () => nudgeCueTiming(index, "startDelta", -0.1),
    () => nudgeCueTiming(index, "startDelta", 0.1),
  );
  const endGroup = makeGroup(
    "End",
    formatSignedSeconds(adjustment.endDelta),
    () => nudgeCueTiming(index, "endDelta", -0.1),
    () => nudgeCueTiming(index, "endDelta", 0.1),
  );
  const shiftGroup = makeGroup(
    "Whole segment",
    "0.1s",
    () => shiftCueTiming(index, -0.1),
    () => shiftCueTiming(index, 0.1),
  );

  const replay = document.createElement("button");
  replay.className = "cue-adjust-command";
  replay.type = "button";
  replay.textContent = "Replay";
  replay.addEventListener("click", () => previewCueSegment(index));

  const reset = document.createElement("button");
  reset.className = "cue-adjust-command";
  reset.type = "button";
  reset.textContent = "Reset";
  reset.addEventListener("click", () => resetCueTiming(index));

  panel.append(startGroup, endGroup, shiftGroup, replay, reset);
  return panel;
}

function stepPlayerCue(direction: -1 | 1) {
  if (playerCues.length === 0) {
    return;
  }
  if (playerEditingCue >= 0) {
    previewCueSegment(playerEditingCue);
    return;
  }
  const time = playerVideo.currentTime;
  let target: number;
  if (direction === 1) {
    target = playerCues.findIndex((cue) => cuePlaybackStart(cue) > time + 0.05 && !isCueIgnored(cue));
    if (target === -1) {
      return;
    }
  } else {
    // A margin so that pressing back twice moves to the previous cue
    // instead of restarting the current one each time.
    target = playerCues.length - 1;
    while (
      target >= 0 &&
      (cuePlaybackStart(playerCues[target]) >= time - 1 || isCueIgnored(playerCues[target]))
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
playerPrevCue.addEventListener("click", () => stepPlayerCue(-1));
playerNextCue.addEventListener("click", () => stepPlayerCue(1));
playerReplayCue.addEventListener("click", () => {
  const index =
    playerEditingCue >= 0
      ? playerEditingCue
      : playerActiveCue >= 0
        ? playerActiveCue
        : cueIndexAt(playerVideo.currentTime);
  if (index >= 0) {
    previewCueSegment(index);
  }
});
// In dialogue-only mode, gaps between adjusted cue windows are skipped. The
// jump-gap margin keeps tiny gaps playing through and prevents re-jumping inside
// the adjusted cue window we just landed on.
function skipGapIfNeeded(time: number) {
  if (
    playerEditingCue >= 0 ||
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
  const next = playerCues.find((cue) => cuePlaybackStart(cue) > time && !isCueIgnored(cue));
  if (!next) {
    return;
  }
  const target = cuePlaybackStart(next);
  if (target > time + JUMP_GAP_SECONDS) {
    playerVideo.currentTime = target;
  }
}

function keepEditedCueLocked(time: number): boolean {
  if (playerEditingCue < 0) {
    return false;
  }
  const cue = playerCues[playerEditingCue];
  if (!cue) {
    playerEditingCue = -1;
    playerReplayUntil = null;
    return false;
  }
  setActivePlayerCue(playerEditingCue);

  const start = cuePlaybackStart(cue);
  const end = cuePlaybackEnd(cue);
  if (time < start - 0.05 || time > end + 0.05) {
    playerReplayUntil = end;
    playerVideo.currentTime = start;
    return true;
  }
  if (!playerVideo.paused && time >= end - 0.03) {
    playerVideo.pause();
    playerReplayUntil = null;
  }
  return true;
}

playerVideo.addEventListener("timeupdate", () => {
  const time = playerVideo.currentTime;
  if (keepEditedCueLocked(time)) {
    return;
  }
  setActivePlayerCue(cueIndexAt(time));
  if (playerReplayUntil !== null && time >= playerReplayUntil - 0.03) {
    playerVideo.pause();
    playerReplayUntil = null;
    return;
  }
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
void loadWhisperModels();
void loadDownloaderStatus();
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
