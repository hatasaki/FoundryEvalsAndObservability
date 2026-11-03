import { judgeReadiness, judgingPolicy, labels, pairedTheory, qualityDimensions, qualityKeys, rubrics, wordCount } from "./concepts.ts";
import type { Decision, JudgeTrigger, ServiceStatus, SlideRubric } from "./concepts.ts";
import { combineWavs, encodeWav } from "./audio.ts";

type Mode = "idle" | "running" | "paused" | "finishing" | "finished";
const phaseLabels = { theory: "解説", demo: "デモ", framing: "導入・まとめ" };
interface Utterance { text: string; capturedAt: number }
interface SlideState {
  elapsed: number;
  visited: boolean;
  utterances: Utterance[];
  audio: Blob[];
  decisions: Decision[];
  revision: number;
  judgedRevision: number;
  attemptedRevision: number;
  attemptedWords: number;
  assessedTranscript: string;
  checks: number;
  judgedAt?: number;
  latencyMs?: number;
  lastRequest?: unknown;
  lastResponse?: unknown;
  judgeError?: string;
  transcriptionError?: string;
  demoCompleted: boolean;
}
interface AudioChunk { slideId: string; wav: Blob; capturedAt: number; seq: number }

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`リハーサルの要素がありません: ${id}`);
  return node as T;
}

const slideElements = Array.from(document.querySelectorAll<HTMLElement>(".slide"));
const slides = new Map(rubrics.map(rubric => [
  rubric.id, slideElements.find(slide => slide.dataset.rehearsalId === rubric.id),
]));
if (slideElements.filter(slide => slide.dataset.rehearsalId).length !== rubrics.length || [...slides.values()].some(slide =>
  !slide || !Number.isFinite(Number(slide.dataset.minutes)) || Number(slide.dataset.minutes) <= 0)) {
  throw new Error("スライド、持ち時間、リハーサルのルーブリックが一致しません。");
}
function emptyState(): SlideState {
  return {
    elapsed: 0, visited: false, utterances: [], audio: [], decisions: [],
    revision: 0, judgedRevision: -1, attemptedRevision: -1, attemptedWords: 0,
    assessedTranscript: "", checks: 0, demoCompleted: false,
  };
}
const states = new Map<string, SlideState>(rubrics.map(slide => [slide.id, emptyState()]));
let activeId = slideElements.find(slide => slide.classList.contains("active"))?.dataset.rehearsalId ?? rubrics[0].id;
let mode: Mode = "idle";
let service: ServiceStatus | undefined;
let since = 0;
let startedAt: string | undefined;
let actionBusy = false;
let audioContext: AudioContext | undefined;
let stream: MediaStream | undefined;
let worklet: AudioWorkletNode | undefined;
let boundaryNumber = 0;
let speechLevel = 0;
let lastSpeechAt = 0;
let preview: { slideId: string; seq: number; text: string } | undefined;
let previewTask: Promise<void> | undefined;
let lastPeekAt = 0;
let transcribedSeq = -1;
let lastJudgeAt = 0;
let judgedCalls = 0;
let errorText = "";
let reviewId: string | undefined;
let recordingUrl: string | undefined;
const boundaries = new Map<number, () => void>();
const audioQueue: AudioChunk[] = [];
const failedAudio: AudioChunk[] = [];
const judgeQueue = new Map<string, JudgeTrigger>();
let transcriptionTask: Promise<void> | undefined;
let judgeTask: Promise<void> | undefined;
let judging: { slideId: string; words: number; since: number } | undefined;

const sheet = document.createElement("link");
sheet.rel = "stylesheet";
sheet.href = "/rehearsal/style.css";
document.head.appendChild(sheet);
const panel = document.createElement("aside");
panel.id = "rehearsalPanel";
panel.hidden = true;
panel.setAttribute("aria-label", "リハーサルコーチ");
panel.innerHTML = `
  <header class="rh-header">
    <h2>リハーサル</h2>
    <button class="control-button" id="rhClose" aria-label="リハーサルパネルを閉じる">閉じる</button>
  </header>
  <div class="rh-scroll">
    <section id="rhSetup">
      <p class="rh-muted">ローカルの Whisper で文字起こしし、Decision-1 が運用ガイドに沿って概念の説明を確認します。</p>
      <div id="rhChecks" class="rh-checks" aria-live="polite">ローカル設定を確認中...</div>
      <button class="control-button" id="rhCheck">セットアップ確認</button>
      <label class="rh-option"><input type="checkbox" id="rhConsent"> 各スライドの文字起こしを設定済み Foundry 接続先へ送信し、AI のフィードバックを受けることに同意します（有料）。</label>
      <label class="rh-option"><input type="checkbox" id="rhKeepAudio" checked> ローカルでの再生・ダウンロード用に音声をこのタブに保持します。</label>
      <p class="rh-small">音声は Foundry に送りません。タブを閉じるか再読み込みすると、ダウンロードしていないセッションは失われます。デモのためにタブを切り替えても時計は止まりません。</p>
    </section>
    <div class="rh-live" id="rhLive" hidden>
      <div class="rh-clock-row"><div><span class="rh-eyebrow">残り時間</span><div id="rhClock" class="rh-clock">00:00</div></div><span class="rh-badge" id="rhMode">準備完了</span></div>
      <div class="rh-time-track" aria-hidden="true"><div id="rhTimeBar"></div></div>
      <div class="rh-time-stats"><span>全体の残り <strong id="rhTalkLeft">00:00</strong></span><span>時間差 <strong id="rhOverspill">予定どおり</strong></span></div>
      <div class="rh-line" id="rhHeard"><span class="rh-dot" id="rhHeardDot"></span><span id="rhHeardText">発話待ち</span></div>
      <div class="rh-line" id="rhJudgeLine" aria-live="polite"><span class="rh-dot" id="rhJudgeDot"></span><span id="rhJudgeText"></span><span class="rh-next" id="rhJudgeNext" hidden></span></div>
    </div>
    <div class="rh-actions" id="rhSessionControls">
      <button class="control-button rh-primary" id="rhStart" disabled>リハーサル開始</button>
      <button class="control-button" id="rhPause" hidden>一時停止</button>
      <button class="control-button" id="rhStop" hidden>終了</button>
      <span id="rhStatus" role="status" aria-live="polite"></span>
    </div>
    <div id="rhError" class="rh-error" role="alert" hidden></div>
    <section id="rhCurrent">
      <div class="rh-slide-heading"><h3 id="rhTitle"></h3><button class="control-button" id="rhCopy" hidden>LLM 用にコピー</button></div>
      <div id="rhConcepts" class="rh-concepts"></div>
      <details id="rhDetails" class="rh-transcript" hidden>
        <summary>レビューの詳細</summary>
        <p class="rh-small" id="rhPhase"></p>
        <p class="rh-small" id="rhPair"></p>
        <div class="rh-listening"><span id="rhMic">マイク停止中</span><meter id="rhLevel" min="0" max="0.08" value="0" aria-label="マイク入力レベル"></meter></div>
        <p class="rh-small" id="rhPipeline"></p>
        <div class="rh-cue" id="rhCue"></div>
        <label class="rh-option" id="rhDemoOption" hidden><input type="checkbox" id="rhDemo"> 画面上のデモを完了しました（自己申告であり、AI は確認していません）。</label>
        <p class="rh-small" id="rhJudged"></p>
        <p class="rh-small" id="rhGate"></p>
        <div id="rhAssessmentDetails" class="rh-small"></div>
        <div class="rh-actions">
          <button class="control-button" id="rhJudge" disabled>概念を再確認</button>
          <button class="control-button" id="rhRetry" hidden>失敗した音声を再試行</button>
        </div>
        <details class="rh-transcript"><summary>このスライドの文字起こし <span id="rhWords"></span></summary><div id="rhTranscript" class="rh-transcript-text">発話はまだ取得していません。</div></details>
        <details class="rh-transcript"><summary>最後に評価した文字起こし</summary><div id="rhAssessed" class="rh-transcript-text">まだ評価していません。</div></details>
        <div id="rhPlayback" hidden><audio id="rhAudio" controls preload="none" aria-label="録音したスライドの音声"></audio><button class="control-button" id="rhDownloadAudio">スライドの音声をダウンロード</button></div>
      </details>
    </section>
    <section id="rhReview" hidden>
      <div class="rh-slide-heading"><span class="rh-eyebrow">リハーサルのレビュー</span><h3>もう一度確認する点は？</h3></div>
      <p class="rh-small" id="rhReviewSummary"></p>
      <div id="rhReviewRows"></div>
      <div class="rh-actions"><button class="control-button" id="rhExport">セッションをダウンロード</button><button class="control-button" id="rhBack">現在のスライド</button><button class="control-button" id="rhNew">新しいリハーサル</button></div>
    </section>
  </div>
`;
document.body.appendChild(panel);

const resizer = document.createElement("div");
resizer.id = "rhResize";
resizer.tabIndex = 0;
resizer.setAttribute("role", "separator");
resizer.setAttribute("aria-orientation", "vertical");
resizer.setAttribute("aria-label", "リハーサルパネルの幅を変更");
resizer.title = "ドラッグで幅を変更、ダブルクリックで元に戻す";
panel.prepend(resizer);
const defaultWidth = 384;
function setPanelWidth(width: number, save = true) {
  const max = Math.max(320, Math.round(window.innerWidth * 0.7));
  const value = Math.round(Math.min(max, Math.max(320, width)));
  document.documentElement.style.setProperty("--rh-width", `${value}px`);
  resizer.setAttribute("aria-valuemin", "320");
  resizer.setAttribute("aria-valuemax", String(max));
  resizer.setAttribute("aria-valuenow", String(value));
  if (save) localStorage.setItem("rehearsalPanelWidth", String(value));
  window.dispatchEvent(new Event("resize"));
}
setPanelWidth(Number(localStorage.getItem("rehearsalPanelWidth")) || defaultWidth, false);
resizer.addEventListener("pointerdown", event => {
  resizer.setPointerCapture(event.pointerId);
  resizer.classList.add("rh-dragging");
  document.documentElement.classList.add("rh-resizing");
});
resizer.addEventListener("pointermove", event => {
  if (resizer.hasPointerCapture(event.pointerId)) setPanelWidth(window.innerWidth - event.clientX);
});
resizer.addEventListener("lostpointercapture", () => {
  resizer.classList.remove("rh-dragging");
  document.documentElement.classList.remove("rh-resizing");
});
resizer.addEventListener("dblclick", () => setPanelWidth(defaultWidth));
resizer.addEventListener("keydown", event => {
  const step = event.shiftKey ? 64 : 16;
  const current = Number(resizer.getAttribute("aria-valuenow"));
  if (event.key === "ArrowLeft") setPanelWidth(current + step);
  else if (event.key === "ArrowRight") setPanelWidth(current - step);
  else if (event.key === "Home") setPanelWidth(defaultWidth);
  else return;
  event.preventDefault();
  event.stopPropagation();
});
window.addEventListener("resize", event => {
  if (event.isTrusted) setPanelWidth(Number(resizer.getAttribute("aria-valuenow")), false);
});

const startButton = element<HTMLButtonElement>("rhStart");
const pauseButton = element<HTMLButtonElement>("rhPause");
const stopButton = element<HTMLButtonElement>("rhStop");
const consent = element<HTMLInputElement>("rhConsent");
const keepAudio = element<HTMLInputElement>("rhKeepAudio");
const demo = element<HTMLInputElement>("rhDemo");

function state(id = activeId) {
  const result = states.get(id);
  if (!result) throw new Error(`不明なスライドです: ${id}`);
  return result;
}

function rubric(id = activeId) {
  const result = rubrics.find(slide => slide.id === id);
  if (!result) throw new Error(`不明なスライドのルーブリックです: ${id}`);
  return result;
}

function elapsed(id: string, now = performance.now()) {
  return state(id).elapsed + (mode === "running" && id === activeId ? now - since : 0);
}

function budget(id: string) {
  return Number(slides.get(id)!.dataset.minutes) * 60_000;
}

function clock(milliseconds: number) {
  const seconds = Math.floor(Math.abs(milliseconds) / 1000);
  return `${milliseconds < 0 ? "+" : ""}${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function transcript(id: string) {
  return state(id).utterances.map(utterance => utterance.text).join(" ");
}

function explained(decision: Decision) {
  return decision.coverage === "explained" && decision.confidence >= 0.65;
}

function setError(error: unknown) {
  errorText = error instanceof Error ? error.message : String(error);
  render();
}

async function action(operation: () => Promise<void>) {
  if (actionBusy) return;
  actionBusy = true;
  errorText = "";
  render();
  try {
    await operation();
  } catch (error) {
    setError(error);
  } finally {
    actionBusy = false;
    render();
  }
}

async function api<T>(path: string, data?: Blob | object): Promise<T> {
  const response = await fetch(path, data ? {
    method: "POST",
    headers: {
      "Content-Type": data instanceof Blob ? "audio/wav" : "application/json",
      "X-Rehearsal-CSRF": service?.csrf ?? "",
    },
    body: data instanceof Blob ? data : JSON.stringify(data),
    signal: AbortSignal.timeout(path.endsWith("transcribe") ? 75_000 : 40_000),
  } : { signal: AbortSignal.timeout(45_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `ローカルサービスが HTTP ${response.status} を返しました。`);
  return result as T;
}

async function checkSetup() {
  startButton.disabled = true;
  element("rhChecks").textContent = "ローカル設定を確認中...";
  try {
    service = await api<ServiceStatus>("/api/status");
    const container = element("rhChecks");
    container.replaceChildren(...service.checks.map(check => {
      const row = document.createElement("div");
      row.className = check.ok ? "rh-check rh-ok" : "rh-check rh-problem";
      const title = document.createElement("strong");
      title.textContent = `${check.ok ? "準備完了" : "要対応"}: ${check.name}`;
      const detail = document.createElement("span");
      detail.textContent = check.detail;
      row.append(title, detail);
      return row;
    }));
  } catch {
    service = undefined;
    element("rhChecks").textContent = "ローカルサーバーに接続できません。presentation/rehearsal で npm start を実行し、localhost の URL を開いてください。";
  }
  render();
}

function captureBoundary(slideId: string, active: boolean) {
  if (!worklet) return Promise.resolve();
  const id = ++boundaryNumber;
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      boundaries.delete(id);
      reject(new Error("マイクから最後の音声を取得できませんでした。末尾の区間が不完全な可能性があります。"));
    }, 3000);
    boundaries.set(id, () => { clearTimeout(timeout); resolve(); });
    worklet!.port.postMessage({ type: "boundary", id, slideId, active });
  });
}

async function openMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    throw new Error("ローカルのマイク録音には、localhost で最新の Chrome または Edge を使ってください。");
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    audioContext = new AudioContext({ sampleRate: 16_000 });
    await audioContext.resume();
    if (audioContext.sampleRate !== 16_000 || audioContext.state !== "running") {
      throw new Error("このブラウザーでは16 kHzの音声を開始できません。Chrome または Edge を試してください。");
    }
    await audioContext.audioWorklet.addModule("/rehearsal/worklet.js");
    worklet = new AudioWorkletNode(audioContext, "rehearsal-capture");
    transcribedSeq = -1;
    preview = undefined;
    worklet.port.onmessage = event => {
      const message = event.data;
      if (message.type === "boundary") {
        boundaries.get(message.id)?.();
        boundaries.delete(message.id);
      } else if (message.type === "audio") {
        receiveAudio(message);
      } else if (message.type === "partial") {
        receivePartial(message);
      } else if (message.type === "level") {
        speechLevel = message.rms;
      }
    };
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    audioContext.createMediaStreamSource(stream).connect(worklet).connect(mute).connect(audioContext.destination);
    stream.getAudioTracks()[0].addEventListener("ended", () => {
      if (mode === "running") void action(async () => {
        await pause();
        throw new Error("マイクが切断されました。再接続してから再開してください。");
      });
    });
    audioContext.onstatechange = () => {
      if (audioContext?.state === "suspended" && mode === "running") void action(async () => {
        await pause();
        throw new Error("ブラウザーが録音を停止したため、リハーサルを一時停止しました。再開して再接続してください。");
      });
    };
    await captureBoundary(activeId, true);
  } catch (error) {
    await closeMicrophone();
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new Error("マイクの使用が拒否されました。この localhost ページにマイクを許可して再試行してください。");
    }
    throw error;
  }
}

async function closeMicrophone() {
  stream?.getTracks().forEach(track => track.stop());
  stream = undefined;
  worklet?.disconnect();
  worklet = undefined;
  const context = audioContext;
  audioContext = undefined;
  if (context && context.state !== "closed") await context.close();
  speechLevel = 0;
}

// 途中の文字起こしは速報表示専用。確定したクリップで置き換え、その内容を評価する。
function receivePartial(message: { slideId: string; seq: number; samples: Float32Array; sampleRate: number; peak: number }) {
  if (previewTask || message.peak < 0.003 || message.samples.length < message.sampleRate / 2) return;
  const wav = encodeWav(message.samples, message.sampleRate);
  previewTask = api<{ text: string }>("/api/transcribe?preview=1", wav).then(result => {
    if (mode === "running" && message.seq > transcribedSeq && typeof result.text === "string") {
      preview = { slideId: message.slideId, seq: message.seq, text: result.text.trim() };
      renderActivity();
    }
  }).catch(() => undefined).finally(() => { previewTask = undefined; });
}

function peekAudio() {
  if (mode !== "running" || !worklet || transcriptionTask || previewTask || audioQueue.length ||
      Date.now() - lastPeekAt < 1000) return;
  lastPeekAt = Date.now();
  worklet.port.postMessage({ type: "peek" });
}

function receiveAudio(message: { slideId: string; seq: number; samples: Float32Array; sampleRate: number; peak: number; capturedAt: number }) {
  if (!states.has(message.slideId)) return setError("取得した音声のスライド ID が不明です。");
  const wav = encodeWav(message.samples, message.sampleRate);
  const slideState = state(message.slideId);
  if (keepAudio.checked) slideState.audio.push(wav);
  // 100 ms のどの区間にも発話相当の強度がなかったクリップだけを省略する。
  if (message.peak < 0.003) {
    if (preview && preview.seq <= message.seq) preview = undefined;
    transcribedSeq = Math.max(transcribedSeq, message.seq);
    return;
  }
  lastSpeechAt = Date.now();
  audioQueue.push({ slideId: message.slideId, wav, capturedAt: message.capturedAt, seq: message.seq });
  pumpTranscription();
  render();
  if (audioQueue.length > 10 && mode === "running") void action(async () => {
    await pause();
    throw new Error("ローカルの文字起こしが追い付かないため、待機中の音声処理を終えるまで一時停止しました。");
  });
}

function pumpTranscription() {
  if (transcriptionTask) return;
  transcriptionTask = (async () => {
    while (audioQueue.length) {
      const chunk = audioQueue.shift()!;
      const slideState = state(chunk.slideId);
      await previewTask;
      try {
        const result = await api<{ text: string }>("/api/transcribe", chunk.wav);
        if (typeof result.text !== "string") throw new Error("ローカルの Whisper が不正な文字起こしを返しました。");
        if (errorText === slideState.transcriptionError) errorText = "";
        if (!failedAudio.some(failed => failed.slideId === chunk.slideId)) slideState.transcriptionError = undefined;
        transcribedSeq = Math.max(transcribedSeq, chunk.seq);
        if (preview && preview.seq <= chunk.seq) preview = undefined;
        if (result.text.trim()) {
          slideState.utterances.push({ text: result.text.trim(), capturedAt: chunk.capturedAt });
          slideState.utterances.sort((left, right) => left.capturedAt - right.capturedAt);
          slideState.revision++;
          if (mode !== "running" || chunk.slideId !== activeId) queueJudge(chunk.slideId, "boundary");
        }
      } catch (error) {
        failedAudio.push(chunk);
        slideState.transcriptionError = error instanceof Error ? error.message : "文字起こしに失敗しました。";
        setError(slideState.transcriptionError);
        if (mode === "running") void action(pause);
      }
      render();
    }
  })().finally(() => { transcriptionTask = undefined; render(); });
  render();
}

function queueJudge(id: string, trigger: JudgeTrigger = "interval") {
  const slideState = state(id);
  if (!judgeReadiness(transcript(id), slideState.attemptedWords, trigger).eligible ||
      (trigger !== "manual" && slideState.attemptedRevision >= slideState.revision)) return;
  const priority = { interval: 0, boundary: 1, manual: 2 };
  const queued = judgeQueue.get(id);
  if (!queued || priority[trigger] > priority[queued]) judgeQueue.set(id, trigger);
  if (judgeTask) return;
  judgeTask = (async () => {
    while (judgeQueue.size) {
      const [slideId, reason] = judgeQueue.entries().next().value!;
      judgeQueue.delete(slideId);
      const target = state(slideId);
      const submittedTranscript = transcript(slideId);
      const readiness = judgeReadiness(submittedTranscript, target.attemptedWords, reason);
      if (!readiness.eligible || (reason !== "manual" && target.attemptedRevision >= target.revision)) continue;
      const revision = target.revision;
      target.attemptedRevision = revision;
      target.attemptedWords = readiness.words;
      judging = { slideId, words: readiness.words, since: Date.now() };
      render();
      try {
        const slide = rubrics.find(item => item.id === slideId)!;
        const theory = Object.fromEntries(pairedTheory(slide)
          .map(item => [item.id, transcript(item.id)]).filter(([, text]) => text));
        const result = await api<{ decisions: Decision[]; latencyMs: number; request: unknown; response: unknown }>("/api/judge", {
          slideId, transcript: submittedTranscript, theory,
        });
        target.decisions = result.decisions;
        target.judgedRevision = revision;
        target.assessedTranscript = submittedTranscript;
        target.checks++;
        target.judgedAt = Date.now();
        target.latencyMs = result.latencyMs;
        target.lastRequest = result.request;
        target.lastResponse = result.response;
        if (errorText === target.judgeError) errorText = "";
        target.judgeError = undefined;
        judgedCalls++;
      } catch (error) {
        target.judgeError = error instanceof Error ? error.message : "Decision-1 を利用できません。";
        setError(target.judgeError);
      }
      judging = undefined;
      render();
    }
  })().finally(() => { judgeTask = undefined; render(); });
  render();
}

async function start() {
  if (!consent.checked) throw new Error("開始前に文字起こしの評価に同意してください。");
  if (!service?.ready) throw new Error("開始前にセットアップの問題を解決してください。");
  reviewId = undefined;
  await openMicrophone();
  startedAt ??= new Date().toISOString();
  mode = "running";
  state().visited = true;
  since = performance.now();
  lastJudgeAt = Date.now();
  panel.querySelector(".rh-scroll")!.scrollTop = 0;
}

async function pause() {
  if (mode !== "running") return;
  state().elapsed += performance.now() - since;
  mode = "paused";
  try {
    await captureBoundary(activeId, false);
  } finally {
    await closeMicrophone();
    queueJudge(activeId, "boundary");
  }
}

async function finish() {
  if (mode === "running") {
    state().elapsed += performance.now() - since;
  }
  mode = "finishing";
  render();
  try {
    await captureBoundary(activeId, false);
  } finally {
    await closeMicrophone();
    await transcriptionTask;
    for (const [id, slideState] of states) {
      if (slideState.judgedRevision < slideState.revision) queueJudge(id, "boundary");
    }
    await judgeTask;
    mode = "finished";
    renderReview();
    element("rhReview").scrollIntoView({ block: "start" });
  }
}

function renderClock() {
  const now = performance.now();
  const remaining = budget(activeId) - elapsed(activeId, now);
  const clockNode = element("rhClock");
  clockNode.textContent = clock(remaining);
  clockNode.classList.toggle("rh-over", remaining < 0);
  clockNode.classList.toggle("rh-warning", remaining >= 0 && remaining < budget(activeId) * 0.2);
  const bar = element("rhTimeBar");
  bar.style.width = `${Math.min(100, Math.max(0, elapsed(activeId, now) / budget(activeId) * 100))}%`;
  bar.classList.toggle("rh-over", remaining < 0);
  const used = [...states.keys()].reduce((sum, id) => sum + elapsed(id, now), 0);
  const allocated = rubrics.filter(slide => state(slide.id).visited && slide.id !== activeId)
    .reduce((sum, slide) => sum + budget(slide.id), 0);
  const drift = used - Math.min(elapsed(activeId, now), budget(activeId)) - allocated;
  const talkLeft = rubrics.reduce((sum, slide) => sum + budget(slide.id), 0) - used;
  element("rhTalkLeft").textContent = clock(talkLeft);
  element("rhTalkLeft").classList.toggle("rh-over", talkLeft < 0);
  const overspill = element("rhOverspill");
  overspill.textContent = Math.abs(drift) < 1000 ? "予定どおり" : drift > 0 ? `${clock(-drift)} 超過` : `${clock(-drift)} 前倒し`;
  overspill.classList.toggle("rh-over", drift >= 1000);
  element("rhMode").textContent = mode === "running" ? (remaining < 0 ? "時間超過" : "実行中") :
    ({ idle: "準備完了", paused: "一時停止", finishing: "終了処理中...", finished: "終了" })[mode];
  element("rhMic").textContent = mode === "running" ?
    (Date.now() - lastSpeechAt < 6000 ? "ローカルで録音中" : "録音中・発話待ち") : "マイク停止中";
  element<HTMLMeterElement>("rhLevel").value = mode === "running" ? speechLevel : 0;
}

function renderConcepts(slide: SlideRubric, slideState: SlideState) {
  const statusLabels = {
    not_covered: "未説明", mentioned: "言及のみ", explained: "伝達済み",
    contradicted: "要訂正", uncertain: "不明瞭",
  };
  element("rhConcepts").replaceChildren(...slide.concepts.map(concept => {
    const decision = slideState.decisions.find(item => item.conceptId === concept.id);
    const row = document.createElement("div");
    const trusted = decision && decision.confidence >= 0.65;
    row.className = `rh-concept rh-${trusted ? decision.coverage : "pending"}`;
    const heading = document.createElement("div");
    heading.className = "rh-concept-heading";
    const label = document.createElement("strong");
    label.textContent = concept.label;
    label.title = concept.criterion;
    const status = document.createElement("span");
    status.className = "rh-coverage";
    status.textContent = decision ? (trusted ? statusLabels[decision.coverage] : "判定保留") :
      (mode === "running" ? "録音中" : slideState.utterances.length ? "追加の説明が必要" : "未説明");
    heading.append(label, status);
    row.appendChild(heading);
    const hint = document.createElement("p");
    hint.className = "rh-hint";
    hint.textContent = concept.cue;
    row.appendChild(hint);
    if (decision && qualityKeys.some(key => decision.quality[key].rating !== null)) {
      const scores = document.createElement("div");
      scores.className = "rh-quality";
      for (const key of qualityKeys) {
        const quality = decision.quality[key];
        const item = document.createElement("div");
        const name = document.createElement("span");
        name.textContent = qualityDimensions[key].label;
        const score = document.createElement("strong");
        score.textContent = quality.rating === null ? "不明瞭" : `${quality.rating.toFixed(1)}/4`;
        item.append(name, score);
        const tentative = quality.range[1] - quality.range[0] >= 2;
        item.title = quality.rating === null ? "この概念について評価できる明瞭な説明がありません。" :
          `確率で重み付けしたスコア。評価器の評点の中央80%は ${quality.range[0]}〜${quality.range[1]}/4` +
          (tentative ? "（評価器はこの範囲の評点で迷っています）。" : "。");
        scores.appendChild(item);
      }
      row.appendChild(scores);
    }
    return row;
  }));
  const next = slide.concepts.find(concept =>
    !slideState.decisions.some(decision => decision.conceptId === concept.id && explained(decision)));
  const contradiction = slideState.decisions.find(decision => decision.coverage === "contradicted" && decision.confidence >= 0.65);
  const cue = contradiction ? slide.concepts.find(concept => concept.id === contradiction.conceptId)?.cue : next?.cue;
  const improvement = slideState.decisions.flatMap(decision => qualityKeys.map(key => ({
    concept: slide.concepts.find(concept => concept.id === decision.conceptId)!,
    key, ...decision.quality[key],
  }))).filter(item => item.rating !== null && item.rating < 2.5 && item.range[1] - item.range[0] <= 1)
    .sort((left, right) => left.rating! - right.rating!)[0];
  element("rhCue").textContent = contradiction ? `明確にする点: ${cue}` :
    cue ? `次の概念: ${cue}` : improvement ?
      `${improvement.concept.label}: ${qualityDimensions[improvement.key].cue}` :
      "すべての目標を明確に説明できました。次のスライドへの移行に余裕を残してください。";
}

function renderActivity() {
  const id = reviewId ?? activeId;
  const slideState = state(id);
  const finalWords = transcript(id).split(/\s+/).filter(Boolean);
  const previewWords = preview?.slideId === id && mode === "running" ? preview.text.split(/\s+/).filter(Boolean) : [];
  const shown = [...finalWords, ...previewWords].slice(-14);
  const provisional = Math.min(previewWords.length, shown.length);
  const heard = element("rhHeardText");
  if (!shown.length) {
    heard.textContent = mode === "running" ? "発話を待っています..." : "このスライドの発話は未取得です";
  } else {
    const live = document.createElement("span");
    live.className = "rh-provisional";
    live.textContent = (provisional < shown.length ? " " : "") + shown.slice(shown.length - provisional).join(" ");
    heard.replaceChildren((finalWords.length + previewWords.length > 14 ? "… " : "") +
      shown.slice(0, shown.length - provisional).join(" "), live);
  }
  element("rhHeardDot").className = "rh-dot" + (transcriptionTask ? " rh-busy" : mode === "running" ? " rh-on" : "");
  element("rhHeard").title = transcriptionTask ? "ローカルで文字起こし中..." : "このスライドで直近に取得した発話";
  const sending = judging?.slideId === id;
  element("rhJudgeDot").className = "rh-dot" + (sending ? " rh-busy rh-send" : slideState.judgeError ? " rh-fail" : "");
  element("rhJudgeText").textContent = sending ?
    `Decision-1 に ${judging!.words} 語を送信中... ${Math.floor((Date.now() - judging!.since) / 1000)}秒` :
    slideState.judgeError ? "Decision-1 の確認が失敗" :
      slideState.judgedAt ? `Decision-1 が ${wordCount(slideState.assessedTranscript)} 語を採点・${Math.max(0, Math.round((Date.now() - slideState.judgedAt) / 1000))}秒前` :
        judging ? "Decision-1 は別スライドを処理中" : "Decision-1: 未確認";
  const next = element("rhJudgeNext");
  next.hidden = mode !== "running" || id !== activeId || sending;
  if (!next.hidden) {
    const needed = judgingPolicy.newWords - judgeReadiness(transcript(id), slideState.attemptedWords, "interval").newWords;
    const seconds = Math.max(0, Math.ceil((judgingPolicy.intervalMs - (Date.now() - lastJudgeAt)) / 1000));
    next.textContent = needed > 0 ? `次はあと ${needed} 語` : `次は ${seconds}秒後`;
  }
}

function render() {
  renderActivity();
  const id = reviewId ?? activeId;
  const slide = rubric(id);
  const slideState = state(id);
  const started = mode !== "idle";
  element("rehearsalButton").textContent = mode === "running" ? "録音中" : mode === "paused" ? "一時停止中" : "リハーサル";
  element("rehearsalButton").dataset.recording = String(mode === "running");
  element("rehearsalButton").title = mode === "running" ? "ローカルで録音中。リハーサルを開いて一時停止または終了できます。" : "リハーサルコーチを開く";
  element("rhSetup").hidden = started;
  element("rhLive").hidden = !started;
  startButton.hidden = mode !== "idle";
  startButton.disabled = actionBusy || !service?.ready || !consent.checked;
  pauseButton.hidden = !["running", "paused"].includes(mode);
  pauseButton.textContent = mode === "paused" ? "再開" : "一時停止";
  pauseButton.disabled = actionBusy;
  stopButton.hidden = !["running", "paused", "finishing"].includes(mode);
  stopButton.disabled = actionBusy || mode === "finishing";
  element("rhError").hidden = !errorText;
  element("rhError").textContent = errorText;
  element("rhPhase").textContent = `${rubrics.indexOf(slide) + 1} / ${rubrics.length}・${phaseLabels[slide.phase]}${reviewId ? "・レビュー" : ""}`;
  element("rhTitle").textContent = slide.title;
  const partners = slide.pair ? rubrics.filter(item => item.pair === slide.pair && item.id !== slide.id) : [];
  element("rhPair").textContent = partners.length ? "対応: " + partners.map(partner => {
    const partnerState = state(partner.id);
    return `${partner.title} (${partnerState.decisions.filter(explained).length}/${partner.concepts.length} 説明済み)`;
  }).join("; ") : "";
  renderConcepts(slide, slideState);
  element("rhDetails").hidden = !["paused", "finished"].includes(mode);
  element("rhDemoOption").hidden = slide.phase !== "demo" || !started;
  demo.checked = slideState.demoCompleted;
  const currentTranscript = transcript(id);
  const words = wordCount(currentTranscript);
  const submittedWords = wordCount(slideState.assessedTranscript);
  const readiness = judgeReadiness(currentTranscript, slideState.attemptedWords, "interval");
  const upToDate = slideState.revision > 0 && slideState.judgedRevision === slideState.revision;
  element("rhStatus").textContent = !started ? "" : slideState.judgeError || slideState.transcriptionError ?
    "フィードバック取得不可" : judgeTask ? "確認中..." : transcriptionTask && mode !== "running" ?
      "文字起こしを完了中..." : upToDate ? "最新" :
        mode === "running" ? "録音中..." : words < judgingPolicy.finalWords ? "追加の発話が必要" : "フィードバック待ち";
  element("rhJudged").textContent = slideState.judgeError ? `${slideState.judgeError} 以前のフィードバックがあれば古い状態です。` :
    slideState.judgedAt ?
      `確認${slideState.checks}回目: ${submittedWords}/${words} 語を評価・${new Date(slideState.judgedAt).toLocaleTimeString("ja-JP")}・${slideState.latencyMs} ms` +
      (slideState.judgedRevision < slideState.revision ? "・新しい発話はまだ未評価。" : "・取得した全発話を評価済み。") :
      "まだ評価していません。";
  element("rhGate").textContent = words < judgingPolicy.finalWords ?
    `評価には発話が足りません（最終確認に必要な ${judgingPolicy.finalWords} 語に対して ${words} 語）。` :
    `自動確認には新たに ${judgingPolicy.newWords} 語が必要。現在は ${readiness.newWords} 語増えています。スライド終了時は合計 ${judgingPolicy.finalWords} 語以上あれば、少量の追加発話も評価します。`;
  element("rhCopy").hidden = !started || !slideState.utterances.length;
  element("rhTranscript").textContent = currentTranscript || "発話はまだ取得していません。";
  element("rhAssessed").textContent = slideState.assessedTranscript || "まだ評価していません。";
  element("rhWords").textContent = `(${words} 語)`;
  element("rhAssessmentDetails").replaceChildren(...slideState.decisions.map(decision => {
    const section = document.createElement("p");
    const concept = slide.concepts.find(concept => concept.id === decision.conceptId)!;
    section.textContent = `${concept.label}: ${labels[decision.coverage]}。説明状態のラベルの確率 ${Math.round(decision.confidence * 100)}%（発表のスコアではありません）。` +
      qualityKeys.map(key => {
        const quality = decision.quality[key];
        return quality.rating === null ? `${qualityDimensions[key].label}: 評価する説明がありません。` :
          `${qualityDimensions[key].label}: ${quality.rating.toFixed(1)}/4、評点1〜4の確率: ${quality.probabilities.map(probability => `${Math.round(probability * 100)}%`).join(", ")}。`;
      }).join(" ");
    return section;
  }));
  element<HTMLButtonElement>("rhJudge").disabled = !started || words < judgingPolicy.finalWords || Boolean(judgeTask);
  element("rhRetry").hidden = failedAudio.length === 0;
  element<HTMLButtonElement>("rhRetry").disabled = Boolean(transcriptionTask);
  element<HTMLButtonElement>("rhNew").disabled = Boolean(transcriptionTask || judgeTask);
  element("rhPipeline").textContent = `${transcriptionTask ? `ローカルで文字起こし中（${audioQueue.length + 1}件待機）` : "文字起こし待機中"}・` +
    `${judgeTask ? "概念を確認中" : `${judgedCalls}回の確認が完了`}` +
    (failedAudio.length ? `・音声${failedAudio.length}区間の再試行が必要` : "");
  const playable = ["paused", "finished"].includes(mode) && slideState.audio.length > 0;
  element("rhPlayback").hidden = !playable;
  if (playable && element("rhPlayback").dataset.slide !== id) {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    recordingUrl = URL.createObjectURL(combineWavs(slideState.audio));
    element<HTMLAudioElement>("rhAudio").src = recordingUrl;
    element("rhPlayback").dataset.slide = id;
  } else if (!playable) {
    element("rhPlayback").dataset.slide = "";
    element<HTMLAudioElement>("rhAudio").pause();
  }
  renderClock();
  if (mode === "finished") renderReview();
}

function renderReview() {
  element("rhReview").hidden = false;
  const visited = rubrics.filter(slide => state(slide.id).visited);
  const clearly = visited.reduce((sum, slide) => sum + state(slide.id).decisions.filter(explained).length, 0);
  const objectives = visited.reduce((sum, slide) => sum + slide.concepts.length, 0);
  const stale = visited.filter(slide => (wordCount(transcript(slide.id)) >= judgingPolicy.finalWords && state(slide.id).judgedRevision < state(slide.id).revision) ||
    state(slide.id).judgeError || state(slide.id).transcriptionError);
  element("rhReviewSummary").textContent = `${visited.length}/${rubrics.length}枚を表示・${clearly}/${objectives}項目を明確に説明。` +
    `${stale.length}枚のフィードバックが未完了または失敗しています。タブを閉じる前にダウンロードしてください。`;
  element("rhReviewRows").replaceChildren(...rubrics.map(slide => {
    const target = state(slide.id);
    const button = document.createElement("button");
    button.className = "rh-review-row";
    button.setAttribute("aria-pressed", String(reviewId === slide.id));
    const label = document.createElement("strong");
    label.textContent = `${rubrics.indexOf(slide) + 1}. ${slide.title}`;
    const detail = document.createElement("span");
    const over = target.elapsed > budget(slide.id);
    detail.textContent = !target.visited ? "未表示" :
      `${clock(target.elapsed)} / ${clock(budget(slide.id))}${over ? "・超過" : ""}・` +
      `${target.decisions.filter(explained).length}/${slide.concepts.length}項目を説明` +
      (!target.utterances.length ? "・発話未取得" : "") +
      (target.utterances.length && wordCount(transcript(slide.id)) < judgingPolicy.finalWords ? "・発話が短すぎて評価不可" : "") +
      (target.judgeError || target.transcriptionError ? "・フィードバック未完了" : "") +
      (slide.phase === "demo" ? `・デモ${target.demoCompleted ? "自己確認済み" : "未確認"}` : "");
    button.append(label, detail);
    button.addEventListener("click", () => {
      reviewId = slide.id;
      render();
      element("rhCurrent").scrollIntoView({ block: "start" });
      element("rhTitle").tabIndex = -1;
      element("rhTitle").focus({ preventScroll: true });
    });
    return button;
  }));
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function toggle() {
  panel.hidden = !panel.hidden;
  document.documentElement.classList.toggle("rehearsal-open", !panel.hidden);
  element("rehearsalButton").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) {
    for (const id of ["notesPanel", "overview"]) {
      element(id).classList.remove("open");
      element(id).setAttribute("aria-hidden", "true");
    }
    if (!service) void checkSetup();
    element("rhClose").focus();
  } else element("rehearsalButton").focus();
  window.dispatchEvent(new Event("resize"));
}

element("rhClose").addEventListener("click", toggle);
element("rhCheck").addEventListener("click", () => void action(checkSetup));
consent.addEventListener("change", render);
startButton.addEventListener("click", () => void action(start));
pauseButton.addEventListener("click", () => void action(mode === "running" ? pause : start));
stopButton.addEventListener("click", () => void action(finish));
demo.addEventListener("change", () => { state(reviewId ?? activeId).demoCompleted = demo.checked; render(); });
element("rhJudge").addEventListener("click", () => queueJudge(reviewId ?? activeId, "manual"));
element("rhRetry").addEventListener("click", () => {
  audioQueue.push(...failedAudio.splice(0));
  pumpTranscription();
});
element("rhBack").addEventListener("click", () => { reviewId = undefined; render(); });
element("rhNew").addEventListener("click", () => {
  if (mode !== "finished" || transcriptionTask || judgeTask) return;
  if (!window.confirm("このリハーサルを破棄して最初から開始しますか。残すセッションと音声は先にダウンロードしてください。")) return;
  for (const slide of rubrics) states.set(slide.id, emptyState());
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recordingUrl = undefined;
  element<HTMLAudioElement>("rhAudio").removeAttribute("src");
  element("rhPlayback").dataset.slide = "";
  failedAudio.length = 0;
  mode = "idle";
  startedAt = undefined;
  reviewId = undefined;
  errorText = "";
  judgedCalls = 0;
  consent.checked = false;
  element("rhReview").hidden = true;
  render();
  panel.querySelector(".rh-scroll")!.scrollTop = 0;
});
function llmBundle(id: string) {
  const slide = rubric(id);
  const target = state(id);
  const full = transcript(id);
  const json = (value: unknown) => "```json\n" + JSON.stringify(value, null, 2) + "\n```";
  return [
    `# リハーサルのフィードバック: スライド${rubrics.indexOf(slide) + 1}「${slide.title}」（${phaseLabels[slide.phase]}）`,
    "文字起こしを引用し、Decision-1 がこの説明状態と品質スコアを付けた理由を説明して、より良い話し方を提案してください。",
    `## このスライドで取得した文字起こし全文（${wordCount(full)} 語）`,
    full || "（なし）",
    target.assessedTranscript === full ? "最後の評価はこの全文を使用しました。" :
      `最後の評価はこのうち ${wordCount(target.assessedTranscript)} 語を使用しました。その後の発話はまだ未評価です。`,
    "## 実際の Decision-1 リクエスト（最後の確認）",
    target.lastRequest ? json(target.lastRequest) : "（まだ評価していません）",
    "## Decision-1 レスポンス（最後の確認）",
    target.lastResponse ? json(target.lastResponse) : "（まだ評価していません）",
  ].join("\n\n");
}
element("rhCopy").addEventListener("click", async () => {
  const id = reviewId ?? activeId;
  const text = llmBundle(id);
  const button = element<HTMLButtonElement>("rhCopy");
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "コピー済み";
  } catch {
    download(new Blob([text], { type: "text/markdown" }), `rehearsal-${id}.md`);
    button.textContent = "ダウンロード済み";
  }
  setTimeout(() => { button.textContent = "LLM 用にコピー"; }, 1500);
});
element("rhDownloadAudio").addEventListener("click", () => {
  const id = reviewId ?? activeId;
  download(combineWavs(state(id).audio), `rehearsal-${id}.wav`);
});
element("rhExport").addEventListener("click", () => {
  const report = {
    schemaVersion: 3, startedAt, exportedAt: new Date().toISOString(), judgingPolicy,
    qualityMethod: "4段階の基準を持つネイティブな順序付きスコア。0始まりの API スコアを1〜4へ移す。",
    endpoint: service?.endpoint, deployment: service?.deployment,
    scope: "発話による概念の説明のみ。聴衆の理解や画面操作の実行は確認しない。",
    failedAudioSegments: failedAudio.map(chunk => ({ slideId: chunk.slideId, capturedAt: chunk.capturedAt })),
    slides: rubrics.map(slide => {
      const target = state(slide.id);
      return {
        id: slide.id, title: slide.title, phase: slide.phase, pair: slide.pair,
        budgetMs: budget(slide.id), elapsedMs: elapsed(slide.id), visited: target.visited,
        transcript: target.utterances, concepts: slide.concepts, decisions: target.decisions,
        judgedRevision: target.judgedRevision, transcriptRevision: target.revision, judgedAt: target.judgedAt,
        assessedTranscript: target.assessedTranscript, checks: target.checks,
        lastDecisionRequest: target.lastRequest, lastDecisionResponse: target.lastResponse,
        judgeError: target.judgeError, transcriptionError: target.transcriptionError,
        demoCompletedSelfReported: target.demoCompleted,
      };
    }),
  };
  download(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }), "rehearsal-session.json");
});
document.addEventListener("presentation:slide", event => {
  const index = (event as CustomEvent<{ index: number }>).detail.index;
  const nextId = slideElements[index]?.dataset.rehearsalId;
  if (!nextId || nextId === activeId) return;
  const previousId = activeId;
  if (mode === "running") state(previousId).elapsed += performance.now() - since;
  activeId = nextId;
  reviewId = undefined;
  if (mode === "running") {
    since = performance.now();
    state().visited = true;
    void captureBoundary(activeId, true).catch(setError);
    queueJudge(previousId, "boundary");
  }
  render();
});
panel.addEventListener("keydown", event => {
  if (event.key === "Escape") toggle();
});
window.addEventListener("beforeunload", event => {
  if (startedAt) event.preventDefault();
});
setInterval(() => {
  if (mode !== "idle") renderActivity();
  peekAudio();
  if (mode === "running") {
    renderClock();
    if (Date.now() - lastJudgeAt >= judgingPolicy.intervalMs) {
      lastJudgeAt = Date.now();
      queueJudge(activeId);
    }
  }
}, 250);
render();
