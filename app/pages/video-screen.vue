<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const state = ref('idle');
const systemAudio = ref(true);
const microphone = ref(false);
const duration = ref(0);
const videoUrl = ref('');
const fileSize = ref(0);
const errorMessage = ref('');
const notice = ref('');
const supportError = ref('');
const ready = ref(false);
const sourceName = ref('');
const audioSummary = ref('');
const busy = computed(() => state.value !== 'idle');
const statusText = computed(() => ({
  idle: videoUrl.value ? '录制完成' : '准备就绪',
  starting: '等待共享授权', recording: '正在录制',
  paused: '已暂停', stopping: '正在生成视频',
})[state.value]);
const formattedTime = computed(() => {
  const seconds = Math.floor(duration.value / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
});

let recorder = null;
let screenStream = null;
let micStream = null;
let mixedStream = null;
let audioContext = null;
let audioSources = [];
let timer = null;
let elapsed = 0;
let segmentStart = null;
let disposed = false;
let session = 0;

const getMimeType = () => [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
].find(type => MediaRecorder.isTypeSupported(type));

onMounted(() => {
  if (!window.isSecureContext) {
    supportError.value = '录屏需要安全连接，请使用 HTTPS 或 localhost 打开页面。';
  } else if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
    supportError.value = '当前浏览器不支持屏幕录制，请使用支持录屏的桌面浏览器。';
  } else if (!getMimeType()) {
    supportError.value = '当前浏览器不支持 WebM 录制，请更换浏览器后重试。';
  }
  ready.value = true;
});

const updateTime = () => {
  duration.value = elapsed + (segmentStart === null ? 0 : performance.now() - segmentStart);
};
const freezeTime = () => {
  updateTime();
  elapsed = duration.value;
  segmentStart = null;
  clearInterval(timer);
  timer = null;
};
const startTime = () => {
  segmentStart = performance.now();
  timer = setInterval(updateTime, 250);
};
const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());
const cleanupStreams = () => {
  stopTracks(screenStream);
  stopTracks(micStream);
  stopTracks(mixedStream);
  screenStream = micStream = mixedStream = null;
  audioSources.forEach(source => source.disconnect());
  audioSources = [];
  if (audioContext) {
    void audioContext.close().catch(() => {});
    audioContext = null;
  }
};

const stopRecord = () => {
  if (!['recording', 'paused'].includes(state.value)) return;
  freezeTime();
  state.value = 'stopping';
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  cleanupStreams();
};

const startRecord = async () => {
  if (!ready.value || busy.value || supportError.value) return;
  state.value = 'starting';
  errorMessage.value = '';
  notice.value = '';
  const attempt = ++session;
  const cancelled = () => disposed || attempt !== session;
  let stage = 'screen';

  try {
    // 必须直接由用户点击触发，录制范围由浏览器的共享弹窗选择。
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: systemAudio.value,
      systemAudio: systemAudio.value ? 'include' : 'exclude',
      monitorTypeSurfaces: 'include',
      surfaceSwitching: 'exclude',
    });
    if (cancelled()) { stopTracks(display); return; }
    screenStream = display;
    const screenTrack = display.getVideoTracks()[0];
    if (!screenTrack || screenTrack.readyState === 'ended') {
      throw new Error('屏幕共享已结束，请重新选择录制来源。');
    }
    screenTrack.addEventListener('ended', () => {
      if (cancelled()) return;
      if (state.value === 'starting') {
        ++session;
        cleanupStreams();
        state.value = 'idle';
        errorMessage.value = '录制开始前屏幕共享已结束，请重试。';
      } else {
        stopRecord();
      }
    }, { once: true });

    if (microphone.value) {
      stage = 'microphone';
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }, video: false,
      });
      if (cancelled()) { stopTracks(mic); return; }
      micStream = mic;
    }

    stage = 'recording';
    const sharedAudio = systemAudio.value ? display.getAudioTracks() : [];
    const micAudio = micStream?.getAudioTracks() || [];
    let audioTracks = [...sharedAudio, ...micAudio];
    if (audioTracks.length > 1) {
      audioContext = new window.AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      mixedStream = destination.stream;
      audioSources = audioTracks.map(track => {
        const source = audioContext.createMediaStreamSource(new MediaStream([track]));
        source.connect(destination);
        return source;
      });
      await audioContext.resume();
      if (cancelled()) return;
      audioTracks = destination.stream.getAudioTracks();
    }
    if (screenTrack.readyState === 'ended') throw new Error('屏幕共享已结束，请重试。');
    mixedStream = new MediaStream([...display.getVideoTracks(), ...audioTracks]);
    const mimeType = getMimeType();
    if (!mimeType) throw new Error('当前浏览器不支持 WebM 录制。');
    const currentRecorder = new MediaRecorder(mixedStream, { mimeType });
    const chunks = [];
    recorder = currentRecorder;
    currentRecorder.ondataavailable = event => {
      if (!cancelled() && event.data.size > 0) chunks.push(event.data);
    };
    currentRecorder.onstop = () => {
      if (cancelled()) return;
      freezeTime();
      cleanupStreams();
      recorder = null;
      state.value = 'idle';
      const blob = new Blob(chunks, { type: currentRecorder.mimeType || mimeType });
      if (!blob.size) {
        errorMessage.value = '未生成有效视频，请重新录制。';
        return;
      }
      if (videoUrl.value) URL.revokeObjectURL(videoUrl.value);
      videoUrl.value = URL.createObjectURL(blob);
      fileSize.value = blob.size;
    };
    currentRecorder.onerror = () => {
      if (cancelled()) return;
      errorMessage.value = '录制意外中断，已尝试保留录制内容，请检查预览。';
      freezeTime();
      state.value = 'stopping';
      if (currentRecorder.state !== 'inactive') currentRecorder.stop();
      cleanupStreams();
    };
    currentRecorder.start(1000);
    // 成功开始后才释放上一次预览，取消授权不会丢失已有视频。
    if (videoUrl.value) URL.revokeObjectURL(videoUrl.value);
    videoUrl.value = '';
    fileSize.value = 0;
    elapsed = duration.value = 0;
    sourceName.value = ({ monitor: '整个屏幕', window: '窗口', browser: '浏览器标签页' })[
      screenTrack.getSettings().displaySurface
    ] || '所选共享画面';
    audioSummary.value = [sharedAudio.length ? '系统 / 共享音频' : '', micAudio.length ? '麦克风' : '']
      .filter(Boolean).join(' + ') || '无音频';
    if (systemAudio.value && !sharedAudio.length) {
      notice.value = '未获取到系统 / 共享音频，本次仅录制画面' + (micAudio.length ? '和麦克风。' : '。')
        + '如需共享声音，请停止后重新选择来源，并在共享弹窗中勾选音频。';
    }
    state.value = 'recording';
    startTime();
  } catch (error) {
    if (cancelled()) return;
    cleanupStreams();
    recorder = null;
    state.value = 'idle';
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
      errorMessage.value = stage === 'microphone'
        ? '麦克风授权未完成。请允许麦克风访问，或关闭“录制麦克风”后重试。'
        : '未获得屏幕共享授权或已取消选择，请点击开始录制重试。';
    } else if (error.name === 'NotFoundError') {
      errorMessage.value = stage === 'microphone' ? '未找到麦克风，请连接设备或关闭麦克风选项。' : '未找到可录制的屏幕或窗口。';
    } else if (error.name === 'NotReadableError') {
      errorMessage.value = '无法访问录制来源，请检查系统权限或设备是否被占用。';
    } else {
      errorMessage.value = error.message || '录制失败，请重试。';
    }
  }
};

const pauseRecord = () => {
  if (state.value !== 'recording' || recorder?.state !== 'recording') return;
  recorder.pause();
  freezeTime();
  state.value = 'paused';
};
const resumeRecord = () => {
  if (state.value !== 'paused' || recorder?.state !== 'paused') return;
  recorder.resume();
  startTime();
  state.value = 'recording';
};
const downloadVideo = () => {
  if (!videoUrl.value) return;
  const link = document.createElement('a');
  link.href = videoUrl.value;
  link.download = 'screen-recording-' + new Date().toISOString().replace(/[:.]/g, '-') + '.webm';
  document.body.appendChild(link);
  link.click();
  link.remove();
};

onBeforeUnmount(() => {
  disposed = true;
  ++session;
  clearInterval(timer);
  if (recorder) {
    recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
    if (recorder.state !== 'inactive') recorder.stop();
  }
  cleanupStreams();
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value);
});
</script>

<template>
  <main class="screen-recorder">
    <header class="page-header">
      <p class="eyebrow">SCREEN RECORDER</p>
      <h1>屏幕录制</h1>
      <p class="intro">捕捉屏幕与声音，轻松保存每一次演示。</p>
    </header>

    <section class="recorder-card" aria-label="录制控制">
      <div class="card-heading">
        <div>
          <h2>录制设置</h2>
          <p>点击开始后，在浏览器弹窗中选择整个屏幕、窗口或标签页。</p>
        </div>
        <span class="format-badge">WebM</span>
      </div>
      <fieldset :disabled="busy" class="audio-options">
        <legend>声音选项</legend>
        <label class="audio-option">
          <input v-model="systemAudio" type="checkbox" aria-describedby="audio-help">
          <span><strong>录制系统声音</strong><small>包含共享来源提供的音频</small></span>
        </label>
        <label class="audio-option">
          <input v-model="microphone" type="checkbox">
          <span><strong>录制麦克风</strong><small>同时录下你的解说，默认关闭</small></span>
        </label>
      </fieldset>
      <p id="audio-help" class="help-text">需要声音时，请在共享弹窗中勾选“共享音频”。可用的系统、窗口或标签页音频取决于浏览器与操作系统；若没有音频选项，可尝试共享浏览器标签页。</p>
      <p v-if="supportError" class="message error" role="alert">{{ supportError }}</p>
      <p v-if="errorMessage" class="message error" role="alert">{{ errorMessage }}</p>
      <p v-if="notice" class="message warning" role="status">{{ notice }}</p>

      <div class="recording-panel">
        <div class="status" role="status">
          <span class="status-dot" :class="state" aria-hidden="true" />
          {{ statusText }}
        </div>
        <div class="timer" role="timer" aria-label="有效录制时长">{{ formattedTime }}</div>
        <p class="timer-caption">{{ state === 'paused' ? '暂停期间不计入录制时长' : '录制时长' }}</p>
        <p v-if="sourceName" class="capture-details">{{ sourceName }} · {{ audioSummary }}</p>
        <div class="actions">
          <button v-if="state === 'idle'" class="primary" :disabled="!ready || !!supportError" @click="startRecord">
            {{ videoUrl ? '重新录制' : '开始录制' }}
          </button>
          <button v-if="state === 'starting' || state === 'stopping'" disabled>{{ statusText }}…</button>
          <button v-if="state === 'recording'" @click="pauseRecord">暂停</button>
          <button v-if="state === 'paused'" class="primary" @click="resumeRecord">继续录制</button>
          <button v-if="state === 'recording' || state === 'paused'" class="stop" @click="stopRecord">停止录制</button>
        </div>
      </div>
      <p class="local-note">视频仅在当前浏览器中处理，不会上传。关闭页面前请下载保存。</p>
    </section>

    <section class="preview-card" aria-labelledby="preview-title">
      <div class="card-heading">
        <div>
          <h2 id="preview-title">录制预览</h2>
          <p v-if="videoUrl">WebM · {{ (fileSize / 1024 / 1024).toFixed(2) }} MB · {{ formattedTime }}</p>
          <p v-else>结束录制后，在这里回看并下载视频。</p>
        </div>
        <button v-if="videoUrl" class="primary" @click="downloadVideo">下载 .webm</button>
      </div>
      <video v-if="videoUrl" :src="videoUrl" class="preview" controls playsinline preload="metadata" aria-label="录制视频预览" />
      <div v-else class="empty-preview">
        <span class="preview-icon" aria-hidden="true">▷</span>
        <p>{{ busy ? '录制完成后即可预览' : '你的录制视频将在这里显示' }}</p>
      </div>
    </section>
  </main>
</template>

<style scoped>
.screen-recorder { max-width: 960px; margin: 0 auto; padding: 48px 24px; color: #172338; font-family: system-ui, sans-serif; }
.page-header { margin-bottom: 28px; }
.eyebrow { color: #5268c9; font-size: 12px; font-weight: 700; letter-spacing: 2px; }
h1 { margin: 8px 0; font-size: 32px; }
h2 { margin: 0; font-size: 18px; }
.intro, .card-heading p, .help-text, .local-note, .timer-caption, .capture-details { color: #606c80; line-height: 1.7; }
.intro { margin: 0; }
.recorder-card, .preview-card { padding: 28px; border: 1px solid #e0e5ef; border-radius: 18px; background: #fff; box-shadow: 0 6px 24px #192e5c06; }
.preview-card { margin-top: 24px; }
.card-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.card-heading p { font-size: 13px; margin: 8px 0 0; }
.format-badge { padding: 5px 10px; border-radius: 6px; color: #495fb8; background: #eef1ff; font-size: 12px; font-weight: 600; }
.audio-options { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 0; margin: 24px 0 0; border: 0; }
.audio-options legend { margin-bottom: 10px; font-size: 13px; color: #606c80; }
.audio-option { display: flex; align-items: center; gap: 12px; border: 1px solid #dde3ee; border-radius: 10px; padding: 16px; cursor: pointer; }
.audio-option:has(input:checked) { background: #f5f7ff; border-color: #a9b5ef; }
.audio-options:disabled .audio-option { cursor: default; opacity: .65; }
input { width: 18px; height: 18px; margin: 0; accent-color: #4c63d2; flex-shrink: 0; }
.audio-option strong { display: block; font-size: 14px; font-weight: 600; }
.audio-option small { display: block; margin-top: 5px; color: #606c80; font-size: 12px; }
.help-text, .local-note { font-size: 12px; }
.help-text { margin: 12px 0 22px; }
.recording-panel { text-align: center; padding: 28px 16px; border: 1px solid #e9edf5; border-radius: 12px; background: #f8faff; }
.status { display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 13px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #8994a6; }
.status-dot.recording { background: #de3c4b; box-shadow: 0 0 0 4px #de3c4b16; }
.status-dot.paused { background: #be7b0a; }
.timer { margin-top: 14px; font-size: clamp(36px, 7vw, 52px); font-variant-numeric: tabular-nums; letter-spacing: 3px; font-weight: 600; }
.timer-caption { font-size: 12px; margin: 4px 0 0; }
.capture-details { font-size: 12px; margin: 10px 0 0; }
.actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 12px; margin-top: 22px; }
button { border: 1px solid #d7deec; border-radius: 8px; padding: 10px 20px; background: #fff; color: #26364e; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
button.primary { background: #4c63d2; border-color: #4c63d2; color: white; }
button.stop { color: #b32b3c; border-color: #edc3cb; background: #fff5f6; }
button:hover:not(:disabled) { filter: brightness(.95); }
button:disabled { opacity: .55; cursor: not-allowed; }
button:focus-visible, input:focus-visible { outline: 3px solid #839af3; outline-offset: 4px; }
.local-note { text-align: center; margin: 16px 0 0; }
.message { font-size: 13px; line-height: 1.7; padding: 12px 14px; border-radius: 8px; overflow-wrap: anywhere; }
.error { color: #a32338; background: #fff0f2; }
.warning { color: #855611; background: #fff6df; }
.preview { display: block; width: 100%; max-height: 540px; margin-top: 20px; border-radius: 10px; background: #101724; }
.empty-preview { display: flex; min-height: 200px; flex-direction: column; align-items: center; justify-content: center; margin-top: 20px; border: 1px dashed #d7deeb; border-radius: 10px; background: #fafbfe; color: #6a768b; font-size: 13px; }
.preview-icon { font-size: 32px; color: #7889b3; }
@media (max-width: 600px) {
  .screen-recorder { padding: 28px 16px; }
  .recorder-card, .preview-card { padding: 20px 16px; }
  .audio-options { grid-template-columns: 1fr; }
  .card-heading { flex-wrap: wrap; }
  .empty-preview { min-height: 160px; }
}
</style>
