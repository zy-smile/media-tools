<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useVideoContour, VideoContourError } from '~/composables/useVideoContour'
import type { DetectRange, VideoContourResult } from '~/composables/useVideoContour'

type PageState = 'empty' | 'ready' | 'working' | 'done' | 'error'

const file = ref<File | null>(null)
const videoUrl = ref('')
const videoInfo = ref<{ width: number; height: number; duration: number } | null>(null)
const state = ref<PageState>('empty')
const range = ref<DetectRange>('first10')
const result = ref<VideoContourResult | null>(null)
const errorMessage = ref('')
const isDragging = ref(false)
/* 不能在 setup 期间直接读 window:SSR 与客户端渲染结果不一致会破坏 hydration */
const webcodecsOk = ref(true)
onMounted(() => {
  webcodecsOk.value = typeof window.VideoEncoder !== 'undefined'
})

const { detect, busy, progress } = useVideoContour()

const rangeOptions: { value: DetectRange; label: string }[] = [
  { value: 'first10', label: '前 10 秒' },
  { value: 'first30', label: '前 30 秒' },
  { value: 'all', label: '整个视频' },
]

const durationText = computed(() => {
  if (!videoInfo.value) return ''
  const s = Math.round(videoInfo.value.duration)
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
})

async function onFileChange(event: Event) {
  await selectFile(((event.target as HTMLInputElement).files ?? [])[0])
  ;(event.target as HTMLInputElement).value = ''
}

async function onDrop(event: DragEvent) {
  isDragging.value = false
  await selectFile((event.dataTransfer?.files ?? [])[0])
}

async function selectFile(next: File | undefined) {
  if (!next) return
  if (!next.type.startsWith('video/')) {
    errorMessage.value = '请选择视频文件(MP4 / WebM 等浏览器可播放的格式)。'
    state.value = 'error'
    return
  }
  reset()
  file.value = next
  videoUrl.value = URL.createObjectURL(next)
  state.value = 'ready'
  /* 读取元数据用于展示 */
  const probe = document.createElement('video')
  probe.preload = 'metadata'
  probe.src = videoUrl.value
  await new Promise<void>((resolve) => {
    probe.onloadedmetadata = () => resolve()
    probe.onerror = () => resolve()
    setTimeout(resolve, 5000)
  })
  if (probe.videoWidth) {
    videoInfo.value = { width: probe.videoWidth, height: probe.videoHeight, duration: probe.duration }
  }
}

function reset() {
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
  if (result.value) URL.revokeObjectURL(result.value.url)
  file.value = null
  videoUrl.value = ''
  videoInfo.value = null
  result.value = null
  errorMessage.value = ''
}

const previewCanvas = ref<HTMLCanvasElement | null>(null)

async function startDetect() {
  if (!file.value || busy.value) return
  state.value = 'working'
  errorMessage.value = ''
  if (result.value) {
    URL.revokeObjectURL(result.value.url)
    result.value = null
  }
  try {
    result.value = await detect(file.value, range.value, (canvas) => {
      const target = previewCanvas.value
      if (!target) return
      if (target.width !== canvas.width || target.height !== canvas.height) {
        target.width = canvas.width
        target.height = canvas.height
      }
      target.getContext('2d')?.drawImage(canvas, 0, 0)
    })
    state.value = 'done'
  } catch (err) {
    errorMessage.value = err instanceof VideoContourError ? err.message : `检测失败:${(err as Error)?.message ?? '未知错误'}`
    state.value = 'error'
  }
}

const downloadName = computed(() => {
  const base = (file.value?.name ?? 'video').replace(/\.[^.]+$/, '')
  return `${base}-轮廓标记.mp4`
})

onBeforeUnmount(() => {
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
  if (result.value) URL.revokeObjectURL(result.value.url)
})
</script>

<template>
  <main class="vc-page">
    <section class="shell">
      <p class="eyebrow">VIDEO CONTOUR DETECTION</p>
      <h1>视频人形轮廓检测</h1>
      <p class="intro">上传视频,自动检测画面中的人并用青色虚线沿人形轮廓描边,生成带标记的 MP4。全部处理在浏览器本地完成。</p>

      <div class="panel">
      <label
        class="dropzone"
        :class="{ dragging: isDragging }"
        @dragover.prevent="isDragging = true"
        @dragleave="isDragging = false"
        @drop.prevent="onDrop"
      >
        <input
          class="visually-hidden"
          type="file"
          accept="video/*"
          @change="onFileChange"
        >
        <p class="drop-main">点击选择,或拖拽视频到此处</p>
        <p class="drop-sub">支持浏览器可直接播放的格式(MP4 / WebM);仅取视频画面,输出不含音轨</p>
      </label>

        <p v-if="!webcodecsOk" class="notice">
          当前浏览器不支持 WebCodecs 视频编码,请使用新版 Chrome / Edge。
        </p>

        <template v-if="videoUrl">
          <div class="media-grid">
            <div>
              <p class="block-title">原始视频</p>
              <video class="video-box" :src="videoUrl" controls muted></video>
            </div>
            <div>
              <p class="block-title">检测实时预览</p>
              <canvas ref="previewCanvas" class="video-box placeholder" width="640" height="360"></canvas>
            </div>
          </div>
          <p v-if="videoInfo" class="meta">
            {{ videoInfo.width }} × {{ videoInfo.height }} · {{ durationText }}{{ file ? ` · ${file.name}` : '' }}
          </p>

          <div class="toolbar">
            <div class="range-group" role="radiogroup" aria-label="处理范围">
              <button
                v-for="opt in rangeOptions"
                :key="opt.value"
                type="button"
                class="range-btn"
                :class="{ active: range === opt.value }"
                :disabled="busy"
                @click="range = opt.value"
              >
                {{ opt.label }}
              </button>
            </div>
            <div class="toolbar-right">
              <button type="button" class="ghost-btn" :disabled="busy" @click="reset">重新选择</button>
              <button type="button" class="primary-btn" :disabled="busy || !webcodecsOk" @click="startDetect">
                {{ busy ? '检测中…' : '开始检测' }}
              </button>
            </div>
          </div>
        </template>

        <div v-if="busy" class="progress-block">
          <div class="progress-track">
            <div class="progress-bar" :style="{ width: `${progress.percent}%` }" />
          </div>
          <p>{{ progress.stage || '处理中…' }} {{ progress.percent }}%</p>
        </div>

        <div v-if="errorMessage" class="error-block">
          <p class="error-title">出错了</p>
          <p>{{ errorMessage }}</p>
        </div>

        <div v-if="result" class="result-block">
          <div class="result-head">
            <strong>标记完成 · {{ result.width }} × {{ result.height }} · {{ result.frames }} 帧 @ {{ result.fps }}fps</strong>
            <a :href="result.url" :download="downloadName" class="download-btn">下载 MP4</a>
          </div>
          <video class="video-box result" :src="result.url" controls loop></video>
          <p class="result-note">虚线人形轮廓已烧录进视频;首次播放前建议等待进度条缓冲完成。</p>
        </div>

        <div class="tips">
          <p class="block-title">说明</p>
          <ul>
            <li>检测使用 OpenCV DNN 加载 PP-HumanSeg 人形分割模型(约 6MB,首次使用自动加载并缓存)</li>
            <li>逐帧处理速度约每帧 0.2~0.5 秒,建议先用"前 10 秒"试效果</li>
            <li>输出为 H.264 MP4;画面超过 1280px 会等比缩放以保证处理速度</li>
          </ul>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
:global(*) { box-sizing: border-box; }
.vc-page {
  min-height: 100vh;
  padding: 48px 24px 64px;
  color: #172338;
  background:
    radial-gradient(circle at 12% 10%, #dfe8ff 0, transparent 30%),
    radial-gradient(circle at 88% 88%, #e1f4e8 0, transparent 28%),
    #f7f8fc;
  font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.shell { width: min(960px, 100%); margin: 0 auto; }
.eyebrow { margin: 0 0 10px; color: #5369ca; font-size: 12px; font-weight: 800; letter-spacing: .18em; }
h1 { margin: 0; font-size: clamp(32px, 5vw, 46px); letter-spacing: -.03em; }
.intro { margin: 12px 0 28px; color: #68748a; font-size: 15px; }

.panel {
  display: grid;
  gap: 16px;
  padding: 24px;
  border: 1px solid #e0e5ef;
  border-radius: 18px;
  background: rgba(255, 255, 255, .9);
  box-shadow: 0 12px 36px rgba(31, 45, 75, .07);
}

.dropzone {
  padding: 34px 20px;
  border: 2px dashed #c3cdea;
  border-radius: 14px;
  text-align: center;
  cursor: pointer;
  transition: border-color .2s ease, background .2s ease;
}
.dropzone:hover, .dropzone.dragging { border-color: #7187e6; background: #f3f6ff; }
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.drop-main { margin: 0 0 8px; font-size: 16px; font-weight: 600; color: #2c3a57; }
.drop-sub { margin: 0; font-size: 13px; color: #8a94a8; }

.media-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.block-title { margin: 0 0 8px; font-size: 13px; font-weight: 700; color: #3c4c6b; }
.video-box {
  display: block;
  width: 100%;
  max-height: 320px;
  border: 1px solid #e0e5ef;
  border-radius: 12px;
  background: #10141d;
}
canvas.video-box.placeholder { object-fit: contain; }
.meta { margin: 0; color: #68748a; font-size: 13px; }

.toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
.range-group { display: inline-flex; border: 1px solid #dde3f0; border-radius: 10px; overflow: hidden; }
.range-btn {
  padding: 9px 16px;
  border: none;
  background: #fff;
  color: #4a5670;
  font-size: 14px;
  cursor: pointer;
}
.range-btn + .range-btn { border-left: 1px solid #dde3f0; }
.range-btn.active { background: #4a6cf7; color: #fff; }
.range-btn:disabled { opacity: .6; cursor: not-allowed; }
.toolbar-right { display: inline-flex; gap: 10px; }
.ghost-btn, .primary-btn { cursor: pointer; font-size: 14px; }
.ghost-btn {
  padding: 9px 14px;
  border: 1px solid #dde3f0;
  border-radius: 10px;
  background: #fff;
  color: #4a5670;
}
.ghost-btn:disabled { opacity: .45; cursor: not-allowed; }
.primary-btn {
  padding: 9px 18px;
  border: none;
  border-radius: 10px;
  background: #4a6cf7;
  color: #fff;
  font-weight: 600;
}
.primary-btn:hover:not(:disabled) { background: #3d5ce0; }
.primary-btn:disabled { opacity: .5; cursor: not-allowed; }

.notice { margin: 0; padding: 10px 14px; border-radius: 10px; background: #fff7e6; color: #9a6b1f; font-size: 13px; }

.progress-block { display: grid; gap: 8px; }
.progress-track { height: 8px; border-radius: 999px; background: #edf0f8; overflow: hidden; }
.progress-bar { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #6f8bf5, #4a6cf7); transition: width .25s ease; }
.progress-block p { margin: 0; color: #4a5670; font-size: 13px; }

.error-block { padding: 14px 16px; border: 1px solid #f3c4c4; border-radius: 12px; background: #fdf3f3; }
.error-block p { margin: 0 0 6px; font-size: 14px; color: #9c3a3a; }
.error-block .error-title { font-weight: 700; }

.result-block { display: grid; gap: 10px; }
.result-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
.result-head strong { font-size: 15px; }
.download-btn {
  padding: 8px 16px;
  border-radius: 10px;
  background: #2fa56a;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
}
.download-btn:hover { background: #268f5b; }
.result-note { margin: 0; color: #8a94a8; font-size: 12px; }

.tips { padding: 14px 16px; border: 1px solid #dce6f5; border-radius: 12px; background: #f7faff; }
.tips ul { margin: 0; padding-left: 18px; color: #5a6a8a; font-size: 13px; line-height: 1.9; }

@media (max-width: 640px) {
  .vc-page { padding: 32px 16px 48px; }
  .media-grid { grid-template-columns: 1fr; }
  .toolbar { flex-direction: column; align-items: stretch; }
}
</style>
