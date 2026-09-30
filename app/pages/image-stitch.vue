<script setup lang="ts">
import { computed, ref } from 'vue'
import { createLongshotDemoFiles, createPanoramaDemoFiles } from '~/utils/demoImages'
import type { StitchDetails, StitchMode, StitchResult } from '~/composables/useStitchWorker'

const MAX_IMAGES = 10

interface ImageItem {
  id: number
  file: File
  thumbUrl: string
  width: number
  height: number
}

const fileInput = ref<HTMLInputElement | null>(null)
const items = ref<ImageItem[]>([])
const mode = ref<StitchMode>('auto')
const format = ref<'image/png' | 'image/jpeg'>('image/png')
const notice = ref('')
const errorMessage = ref('')
const errorDetails = ref<StitchDetails | null>(null)
const result = ref<StitchResult | null>(null)
const isDragging = ref(false)
const demoLoading = ref(false)
let uid = 0

const { stitch, progress, busy } = useStitchWorker()

const modeOptions: { value: StitchMode; label: string; hint: string }[] = [
  { value: 'auto', label: '自动识别', hint: '先尝试长图衔接,失败后转为全景拼接' },
  { value: 'panorama', label: '全景拼接', hint: '相机平移拍摄、有视角变化的照片' },
  { value: 'longshot', label: '长图拼接', hint: '滚动截图、聊天记录等纵向延续的图片' },
]

const canStitch = computed(() => items.value.length >= 2 && !busy.value && !demoLoading.value)
const downloadName = computed(() => `拼接结果.${format.value === 'image/png' ? 'png' : 'jpg'}`)

const detailLines = computed(() => {
  const details = result.value?.details
  if (!details) return []
  const lines: string[] = []
  if (details.mode) lines.push(`拼接模式:${details.mode === 'longshot' ? '长图拼接' : '全景拼接'}`)
  if (details.order?.length) lines.push(`图片顺序:${details.order.join(' → ')}`)
  if (details.pairs?.length) {
    for (const p of details.pairs) lines.push(`第 ${p.pair[0]} ↔ ${p.pair[1]} 张:${describeScore(details.mode, p)}`)
  }
  if (details.outputScale !== undefined && details.outputScale < 1) {
    lines.push(`因尺寸较大已整体缩放至 ${(details.outputScale * 100).toFixed(0)}%`)
  }
  return lines
})

const errorLines = computed(() => {
  const details = errorDetails.value
  if (!details) return []
  const lines: string[] = []
  if (details.mode) lines.push(`拼接模式:${details.mode === 'longshot' ? '长图拼接' : '全景拼接'}`)
  if (details.bestScore != null) lines.push(`最佳衔接得分:${details.bestScore}`)
  if (details.failedPair) lines.push(`疑似问题图片:第 ${details.failedPair[0]} 张与第 ${details.failedPair[1]} 张`)
  if (details.topScores?.length) {
    for (const p of details.topScores) lines.push(`第 ${p.pair[0]} ↔ ${p.pair[1]} 张相似度:${p.score}`)
  }
  return lines
})

function describeScore(mode: string | undefined, p: { score: number; model?: string | null; counts?: Record<string, number> }) {
  if (mode === 'longshot') return `重叠区相关度 ${p.score}`
  const counts = p.counts
    ? Object.entries(p.counts).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' / ')
    : ''
  return `匹配内点数 ${p.score}${p.model ? ` · ${p.model}` : ''}${counts ? `(${counts})` : ''}`
}

function chooseFiles() {
  fileInput.value?.click()
}

async function onFileChange(event: Event) {
  await addFiles((event.target as HTMLInputElement).files)
  ;(event.target as HTMLInputElement).value = ''
}

async function onDrop(event: DragEvent) {
  isDragging.value = false
  await addFiles(event.dataTransfer?.files ?? null)
}

async function addFiles(fileList: FileList | File[] | null) {
  notice.value = ''
  const files = Array.from(fileList ?? []).filter((f) => f.type.startsWith('image/'))
  if (!files.length) return
  for (const file of files) {
    if (items.value.length >= MAX_IMAGES) {
      notice.value = `最多支持 ${MAX_IMAGES} 张图片,超出部分已忽略`
      break
    }
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      items.value.push({
        id: ++uid,
        file,
        thumbUrl: await makeThumbUrl(bitmap),
        width: bitmap.width,
        height: bitmap.height,
      })
      bitmap.close()
    } catch {
      notice.value = `图片 ${file.name} 解码失败,已跳过`
    }
  }
}

async function makeThumbUrl(bitmap: ImageBitmap) {
  const scale = Math.min(1, 220 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
  return URL.createObjectURL(blob ?? new Blob())
}

function removeItem(index: number) {
  URL.revokeObjectURL(items.value[index].thumbUrl)
  items.value.splice(index, 1)
}

const dragIndex = ref(-1)

function onDragStart(index: number) {
  dragIndex.value = index
}

function onDropReorder(index: number) {
  const from = dragIndex.value
  if (from < 0 || from === index) return
  const [moved] = items.value.splice(from, 1)
  items.value.splice(index, 0, moved)
  dragIndex.value = -1
}

async function loadDemo(kind: 'longshot' | 'panorama') {
  notice.value = ''
  demoLoading.value = true
  try {
    const files = kind === 'longshot' ? await createLongshotDemoFiles(5) : await createPanoramaDemoFiles(6)
    for (const item of items.value) URL.revokeObjectURL(item.thumbUrl)
    items.value = []
    await addFiles(files)
  } finally {
    demoLoading.value = false
  }
}

async function startStitch() {
  if (!canStitch.value) return
  errorMessage.value = ''
  errorDetails.value = null
  if (result.value) {
    URL.revokeObjectURL(result.value.url)
    result.value = null
  }
  try {
    const bitmaps: ImageBitmap[] = []
    for (const item of items.value) {
      bitmaps.push(await createImageBitmap(item.file, { imageOrientation: 'from-image' }))
    }
    result.value = await stitch(bitmaps, mode.value, format.value)
  } catch (err) {
    const stitchErr = err as Error & { details?: StitchDetails | null }
    errorMessage.value = stitchErr.message || '拼接失败'
    errorDetails.value = stitchErr.details ?? null
  }
}

function clearAll() {
  for (const item of items.value) URL.revokeObjectURL(item.thumbUrl)
  items.value = []
  if (result.value) {
    URL.revokeObjectURL(result.value.url)
    result.value = null
  }
  errorMessage.value = ''
  errorDetails.value = null
  notice.value = ''
}
</script>

<template>
  <main class="stitch-page">
    <section class="shell">
      <p class="eyebrow">IMAGE STITCHING</p>
      <h1>图片拼接</h1>
      <p class="intro">把多张部分重叠的图片拼成一张完整大图,全部处理在浏览器本地完成。</p>

      <div class="panel">
        <div
          class="dropzone"
          :class="{ dragging: isDragging }"
          @click="chooseFiles"
          @dragover.prevent="isDragging = true"
          @dragleave="isDragging = false"
          @drop.prevent="onDrop"
        >
          <input
            ref="fileInput"
            type="file"
            accept="image/*"
            multiple
            hidden
            @change="onFileChange"
          >
          <p class="drop-main">点击选择,或拖拽图片到此处</p>
          <p class="drop-sub">支持 JPG / PNG / WebP,最多 {{ MAX_IMAGES }} 张;建议图片有 15% 以上的重叠区域</p>
        </div>

        <div class="toolbar">
          <div class="mode-group" role="radiogroup" aria-label="拼接模式">
            <button
              v-for="opt in modeOptions"
              :key="opt.value"
              type="button"
              class="mode-btn"
              :class="{ active: mode === opt.value }"
              :title="opt.hint"
              @click="mode = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
          <div class="toolbar-right">
            <select v-model="format" class="format-select" aria-label="输出格式">
              <option value="image/png">PNG 输出</option>
              <option value="image/jpeg">JPG 输出</option>
            </select>
            <button type="button" class="ghost-btn" :disabled="!items.length || busy" @click="clearAll">
              清空
            </button>
            <button type="button" class="primary-btn" :disabled="!canStitch" @click="startStitch">
              {{ busy ? '拼接中…' : `开始拼接${items.length >= 2 ? `(${items.length} 张)` : ''}` }}
            </button>
          </div>
        </div>

        <div class="demo-row">
          <span>没有素材?试试内置示例:</span>
          <button type="button" class="link-btn" :disabled="busy || demoLoading" @click="loadDemo('longshot')">
            长图截图示例(5 张)
          </button>
          <button type="button" class="link-btn" :disabled="busy || demoLoading" @click="loadDemo('panorama')">
            全景照片示例(6 张)
          </button>
        </div>

        <p v-if="notice" class="notice">{{ notice }}</p>

        <div v-if="items.length" class="thumb-grid">
          <div
            v-for="(item, index) in items"
            :key="item.id"
            class="thumb"
            draggable="true"
            :title="item.file.name"
            @dragstart="onDragStart(index)"
            @dragover.prevent
            @drop.prevent="onDropReorder(index)"
          >
            <img :src="item.thumbUrl" :alt="item.file.name">
            <span class="order">{{ index + 1 }}</span>
            <button type="button" class="remove" aria-label="移除" @click.stop="removeItem(index)">×</button>
            <small>{{ item.width }} × {{ item.height }}</small>
          </div>
        </div>
        <p v-else class="hint">上传后可拖拽缩略图调整顺序(长图拼接会自动识别顺序,无需手动排序)。</p>

        <div v-if="busy" class="progress-block">
          <div class="progress-track">
            <div class="progress-bar" :style="{ width: `${progress.percent}%` }" />
          </div>
          <p>{{ progress.message || '处理中…' }} {{ progress.percent }}%</p>
        </div>

        <div v-if="errorMessage" class="error-block">
          <p class="error-title">拼接失败</p>
          <p>{{ errorMessage }}</p>
          <ul v-if="errorLines.length">
            <li v-for="line in errorLines" :key="line">{{ line }}</li>
          </ul>
        </div>

        <div v-if="result" class="result-block">
          <div class="result-head">
            <strong>拼接完成 · {{ result.width }} × {{ result.height }} px</strong>
            <a :href="result.url" :download="downloadName" class="download-btn">下载 {{ downloadName.split('.').pop()?.toUpperCase() }}</a>
          </div>
          <div class="result-view">
            <img :src="result.url" alt="拼接结果">
          </div>
        </div>

        <div v-if="detailLines.length" class="detail-block">
          <p class="detail-title">拼接详情</p>
          <ul>
            <li v-for="line in detailLines" :key="line">{{ line }}</li>
          </ul>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
:global(*) { box-sizing: border-box; }
.stitch-page {
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
.drop-main { margin: 0 0 8px; font-size: 16px; font-weight: 600; color: #2c3a57; }
.drop-sub { margin: 0; font-size: 13px; color: #8a94a8; }

.toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
.mode-group { display: inline-flex; border: 1px solid #dde3f0; border-radius: 10px; overflow: hidden; }
.mode-btn {
  padding: 9px 16px;
  border: none;
  background: #fff;
  color: #4a5670;
  font-size: 14px;
  cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.mode-btn + .mode-btn { border-left: 1px solid #dde3f0; }
.mode-btn.active { background: #4a6cf7; color: #fff; }
.toolbar-right { display: inline-flex; gap: 10px; align-items: center; }
.format-select {
  padding: 9px 10px;
  border: 1px solid #dde3f0;
  border-radius: 10px;
  background: #fff;
  color: #2c3a57;
  font-size: 14px;
}
.ghost-btn, .primary-btn, .link-btn { cursor: pointer; font-size: 14px; }
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
  transition: background .15s ease, transform .15s ease;
}
.primary-btn:hover:not(:disabled) { background: #3d5ce0; }
.primary-btn:disabled { opacity: .5; cursor: not-allowed; }

.demo-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; color: #7a8499; font-size: 13px; }
.link-btn {
  padding: 4px 10px;
  border: 1px solid #dde3f0;
  border-radius: 999px;
  background: #f6f8ff;
  color: #4a6cf7;
}
.link-btn:disabled { opacity: .5; cursor: not-allowed; }

.notice { margin: 0; padding: 10px 14px; border-radius: 10px; background: #fff7e6; color: #9a6b1f; font-size: 13px; }
.hint { margin: 0; color: #8a94a8; font-size: 13px; }

.thumb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; }
.thumb {
  position: relative;
  overflow: hidden;
  border: 1px solid #e0e5ef;
  border-radius: 12px;
  background: #fff;
  cursor: grab;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.thumb:hover { border-color: #aebbf1; box-shadow: 0 6px 18px rgba(31, 45, 75, .1); }
.thumb:active { cursor: grabbing; }
.thumb img { display: block; width: 100%; height: 96px; object-fit: cover; }
.thumb .order {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(74, 108, 247, .92);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}
.thumb .remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: rgba(23, 35, 56, .6);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.thumb .remove:hover { background: #e05a5a; }
.thumb small { display: block; padding: 6px 8px; color: #8a94a8; font-size: 11px; }

.progress-block { display: grid; gap: 8px; }
.progress-track { height: 8px; border-radius: 999px; background: #edf0f8; overflow: hidden; }
.progress-bar { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #6f8bf5, #4a6cf7); transition: width .25s ease; }
.progress-block p { margin: 0; color: #4a5670; font-size: 13px; }

.error-block { padding: 14px 16px; border: 1px solid #f3c4c4; border-radius: 12px; background: #fdf3f3; }
.error-block p { margin: 0 0 6px; font-size: 14px; color: #9c3a3a; }
.error-block .error-title { font-weight: 700; }
.error-block ul { margin: 0; padding-left: 18px; color: #a05252; font-size: 13px; }

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
.result-view {
  max-height: 68vh;
  overflow: auto;
  border: 1px solid #e0e5ef;
  border-radius: 12px;
  background: repeating-conic-gradient(#f1f3f9 0 25%, #fff 0 50%) 0 0 / 20px 20px;
}
.result-view img { display: block; max-width: 100%; height: auto; }

.detail-block { padding: 14px 16px; border: 1px solid #dce6f5; border-radius: 12px; background: #f7faff; }
.detail-title { margin: 0 0 6px; font-size: 13px; font-weight: 700; color: #3c4c6b; }
.detail-block ul { margin: 0; padding-left: 18px; color: #5a6a8a; font-size: 13px; line-height: 1.9; }

@media (max-width: 640px) {
  .stitch-page { padding: 32px 16px 48px; }
  .toolbar { flex-direction: column; align-items: stretch; }
  .toolbar-right { justify-content: space-between; }
}
</style>
