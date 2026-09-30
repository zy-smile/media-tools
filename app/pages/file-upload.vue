<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

const CHUNK_SIZE = 10 * 1024 * 1024
const CONCURRENCY = 3

type UploadState = 'empty' | 'ready' | 'hashing' | 'uploading' | 'paused' | 'merging' | 'done' | 'error'
interface InitResponse { uploadId: string; uploadedChunks: number[]; completed: boolean; downloadUrl?: string }

const fileInput = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const state = ref<UploadState>('empty')
const uploadId = ref('')
const uploaded = ref(new Set<number>())
const inflight = ref(new Map<number, number>())
const errorMessage = ref('')
const downloadUrl = ref('')
const isDragging = ref(false)
const startedAt = ref(0)
const elapsed = ref(0)
let runId = 0
const requests = new Set<XMLHttpRequest>()

const totalChunks = computed(() => file.value ? Math.ceil(file.value.size / CHUNK_SIZE) : 0)
const uploadedBytes = computed(() => {
  if (!file.value) return 0
  let bytes = 0
  for (const index of uploaded.value) bytes += Math.min(CHUNK_SIZE, file.value.size - index * CHUNK_SIZE)
  for (const loaded of inflight.value.values()) bytes += loaded
  return Math.min(bytes, file.value.size)
})
const progress = computed(() => file.value ? Math.round(uploadedBytes.value / file.value.size * 1000) / 10 : 0)
const statusText = computed(() => ({
  empty: '等待选择文件', ready: '准备就绪', hashing: '正在识别文件…', uploading: '正在上传',
  paused: '已暂停，可随时继续', merging: '分片上传完成，正在合并…', done: '上传完成', error: '上传中断',
}[state.value]))
const actionLabel = computed(() => state.value === 'paused' ? '继续上传' : state.value === 'error' ? '重试上传' : '开始上传')

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

function chooseFile() { fileInput.value?.click() }

function selectFile(next?: File) {
  if (!next) return
  stopRequests()
  file.value = next
  state.value = 'ready'
  uploadId.value = ''
  uploaded.value = new Set()
  inflight.value = new Map()
  errorMessage.value = ''
  downloadUrl.value = ''
  elapsed.value = 0
}

function onDrop(event: DragEvent) {
  isDragging.value = false
  selectFile(event.dataTransfer?.files?.[0])
}

async function fingerprint(selected: File) {
  const sampleSize = 1024 * 1024
  const first = await selected.slice(0, sampleSize).arrayBuffer()
  const last = selected.size > sampleSize ? await selected.slice(-sampleSize).arrayBuffer() : new ArrayBuffer(0)
  const metadata = new TextEncoder().encode(`${selected.name}|${selected.size}|${selected.lastModified}|`)
  const joined = new Uint8Array(metadata.length + first.byteLength + last.byteLength)
  joined.set(metadata)
  joined.set(new Uint8Array(first), metadata.length)
  joined.set(new Uint8Array(last), metadata.length + first.byteLength)
  const digest = await crypto.subtle.digest('SHA-256', joined)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function uploadChunk(selected: File, id: string, index: number, token: number) {
  return new Promise<void>((resolve, reject) => {
    const start = index * CHUNK_SIZE
    const body = selected.slice(start, Math.min(start + CHUNK_SIZE, selected.size))
    const request = new XMLHttpRequest()
    requests.add(request)
    request.open('PUT', `/api/upload/chunk?uploadId=${encodeURIComponent(id)}&index=${index}`)
    request.setRequestHeader('Content-Type', 'application/octet-stream')
    request.upload.onprogress = event => {
      if (token !== runId) return
      const next = new Map(inflight.value)
      next.set(index, event.loaded)
      inflight.value = next
    }
    request.onload = () => {
      requests.delete(request)
      const nextInflight = new Map(inflight.value)
      nextInflight.delete(index)
      inflight.value = nextInflight
      if (request.status >= 200 && request.status < 300) {
        const next = new Set(uploaded.value)
        next.add(index)
        uploaded.value = next
        resolve()
      } else reject(new Error(`分片 ${index + 1} 上传失败（HTTP ${request.status}）`))
    }
    request.onerror = () => { requests.delete(request); reject(new Error('网络连接异常，请稍后重试')) }
    request.onabort = () => { requests.delete(request); reject(new DOMException('Aborted', 'AbortError')) }
    request.send(body)
  })
}

async function startUpload() {
  const selected = file.value
  if (!selected || ['uploading', 'hashing', 'merging', 'done'].includes(state.value)) return
  if (requests.size) stopRequests()
  const token = ++runId
  errorMessage.value = ''
  startedAt.value = Date.now()
  try {
    state.value = 'hashing'
    const fileFingerprint = await fingerprint(selected)
    if (token !== runId) return
    const session = await $fetch<InitResponse>('/api/upload/init', {
      method: 'POST',
      body: {
        fingerprint: fileFingerprint,
        fileName: selected.name,
        fileSize: selected.size,
        mimeType: selected.type,
        chunkSize: CHUNK_SIZE,
        totalChunks: totalChunks.value,
      },
    })
    if (token !== runId) return
    uploadId.value = session.uploadId
    uploaded.value = new Set(session.uploadedChunks)
    if (session.completed) {
      downloadUrl.value = session.downloadUrl || ''
      state.value = 'done'
      return
    }

    state.value = 'uploading'
    const queue = Array.from({ length: totalChunks.value }, (_, index) => index).filter(index => !uploaded.value.has(index))
    let cursor = 0
    const worker = async () => {
      while (cursor < queue.length && token === runId) {
        const index = queue[cursor++]
        await uploadChunk(selected, session.uploadId, index, token)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
    if (token !== runId) return
    state.value = 'merging'
    const result = await $fetch<{ downloadUrl: string }>('/api/upload/complete', {
      method: 'POST', body: { uploadId: session.uploadId },
    })
    if (token !== runId) return
    elapsed.value += Date.now() - startedAt.value
    downloadUrl.value = result.downloadUrl
    state.value = 'done'
  } catch (error: any) {
    if (token !== runId || error?.name === 'AbortError') return
    for (const request of requests) request.abort()
    requests.clear()
    inflight.value = new Map()
    elapsed.value += Date.now() - startedAt.value
    state.value = 'error'
    errorMessage.value = error?.data?.statusMessage || error?.message || '上传失败，请重试'
  }
}

function stopRequests() {
  runId++
  for (const request of requests) request.abort()
  requests.clear()
  inflight.value = new Map()
}

function pauseUpload() {
  if (!['hashing', 'uploading'].includes(state.value)) return
  elapsed.value += Date.now() - startedAt.value
  stopRequests()
  state.value = 'paused'
}

function reset() {
  stopRequests()
  file.value = null
  state.value = 'empty'
  uploaded.value = new Set()
  uploadId.value = ''
  downloadUrl.value = ''
  errorMessage.value = ''
  if (fileInput.value) fileInput.value.value = ''
}

onBeforeUnmount(stopRequests)
</script>

<template>
  <main class="upload-page">
    <div class="ambient ambient-one" />
    <div class="ambient ambient-two" />
    <section class="shell">
      <header class="hero">
        <div class="brand"><span class="brand-mark">N</span><span>Nuxt Transfer</span></div>
        <div class="eyebrow"><span class="pulse" /> RESUMABLE UPLOAD</div>
        <h1>大文件，也可以<br><em>轻松抵达。</em></h1>
        <p>文件会被安全地拆分上传。网络中断或刷新页面后，重新选择同一文件即可从上次进度继续。</p>
      </header>

      <div class="upload-card">
        <input ref="fileInput" type="file" hidden @change="selectFile(($event.target as HTMLInputElement).files?.[0])">

        <button
          v-if="!file"
          class="dropzone"
          :class="{ dragging: isDragging }"
          type="button"
          @click="chooseFile"
          @dragover.prevent="isDragging = true"
          @dragleave.prevent="isDragging = false"
          @drop.prevent="onDrop"
        >
          <span class="upload-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></svg>
          </span>
          <strong>拖放文件到这里</strong>
          <span>或者 <u>浏览本地文件</u></span>
          <small>支持任意类型 · 单个文件 · 10 MB 分片</small>
        </button>

        <div v-else class="file-panel">
          <div class="file-heading">
            <div class="file-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l4 4v16H6zM14 2v5h5" /></svg>
            </div>
            <div class="file-copy">
              <strong :title="file.name">{{ file.name }}</strong>
              <span>{{ formatBytes(file.size) }} · {{ totalChunks }} 个分片</span>
            </div>
            <button v-if="state !== 'done'" class="icon-button" type="button" title="移除文件" @click="reset">×</button>
            <span v-else class="done-check">✓</span>
          </div>

          <div class="status-row">
            <span class="status" :class="state"><i />{{ statusText }}</span>
            <strong>{{ progress }}%</strong>
          </div>
          <div class="progress-track"><div class="progress-value" :style="{ width: `${progress}%` }" /></div>
          <div class="progress-meta">
            <span>{{ formatBytes(uploadedBytes) }} / {{ formatBytes(file.size) }}</span>
            <span>{{ uploaded.size }} / {{ totalChunks }} 分片</span>
          </div>

          <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>
          <p v-if="state === 'done'" class="success-message">文件已在服务端校验并合并完成。</p>

          <div class="actions">
            <button v-if="['ready', 'paused', 'error'].includes(state)" class="primary-button" type="button" @click="startUpload">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" /></svg>{{ actionLabel }}
            </button>
            <button v-if="['hashing', 'uploading'].includes(state)" class="secondary-button" type="button" @click="pauseUpload">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>暂停上传
            </button>
            <a v-if="state === 'done'" class="primary-button" :href="downloadUrl">下载文件</a>
            <button v-if="state === 'done'" class="secondary-button" type="button" @click="reset">上传新文件</button>
          </div>
        </div>

        <div class="feature-strip">
          <div><span>01</span><p><strong>分片传输</strong><small>降低大文件失败成本</small></p></div>
          <div><span>02</span><p><strong>断点续传</strong><small>只上传缺失的分片</small></p></div>
          <div><span>03</span><p><strong>并发上传</strong><small>3 路并发提升速度</small></p></div>
        </div>
      </div>

      <footer><span>文件存储于本机 <code>.data/uploads</code></span><span>Nuxt 4 · Nitro API</span></footer>
    </section>
  </main>
</template>

<style scoped>
:global(*) { box-sizing: border-box; }
:global(body) { margin: 0; background: #f1f0e9; color: #18221b; font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif; }
button, a { font: inherit; }
.upload-page { min-height: 100vh; position: relative; overflow: hidden; background: linear-gradient(145deg, #f5f4ee 0%, #e9eee5 100%); }
.upload-page::before { content: ''; position: absolute; inset: 0; opacity: .38; pointer-events: none; background-image: radial-gradient(#29452f 0.6px, transparent 0.6px); background-size: 22px 22px; }
.ambient { position: absolute; border-radius: 999px; filter: blur(2px); opacity: .55; }
.ambient-one { width: 420px; height: 420px; background: #d4e5cc; right: -140px; top: -180px; }
.ambient-two { width: 300px; height: 300px; background: #e8dfbd; left: -130px; bottom: -170px; }
.shell { width: min(1080px, calc(100% - 40px)); margin: 0 auto; padding: 38px 0 28px; position: relative; z-index: 1; }
.brand { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 750; letter-spacing: .04em; }
.brand-mark { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 9px; background: #1d593a; color: white; font-family: Georgia, serif; }
.hero { text-align: center; }
.hero .brand { justify-content: flex-start; margin-bottom: 34px; }
.eyebrow { display: inline-flex; align-items: center; gap: 8px; padding: 7px 11px; border: 1px solid #cbd7c9; border-radius: 999px; color: #52705b; background: rgba(255,255,255,.48); font-size: 10px; font-weight: 800; letter-spacing: .18em; }
.pulse { width: 6px; height: 6px; background: #3d915b; border-radius: 50%; box-shadow: 0 0 0 4px rgba(61,145,91,.13); }
.hero h1 { margin: 18px 0 12px; font-family: Georgia, "Songti SC", serif; font-weight: 500; font-size: clamp(42px, 6.5vw, 74px); line-height: 1.02; letter-spacing: -.045em; }
.hero h1 em { color: #39724e; font-weight: 500; }
.hero > p { width: min(610px, 92%); margin: 0 auto 30px; color: #6a746d; line-height: 1.8; font-size: 14px; }
.upload-card { width: min(760px, 100%); margin: 0 auto; padding: 12px; border: 1px solid rgba(57,79,62,.15); border-radius: 25px; background: rgba(255,255,255,.72); box-shadow: 0 28px 80px rgba(38,58,42,.10), inset 0 1px rgba(255,255,255,.8); backdrop-filter: blur(18px); }
.dropzone { width: 100%; min-height: 300px; border: 1.5px dashed #a8b9a9; border-radius: 17px; background: rgba(246,248,243,.75); color: #67736a; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; transition: .25s ease; }
.dropzone:hover, .dropzone.dragging { border-color: #34704a; background: #f1f7ef; transform: translateY(-1px); }
.upload-icon { width: 62px; height: 62px; display: grid; place-items: center; border-radius: 18px; background: #e0ecdd; color: #2f6c47; margin-bottom: 6px; box-shadow: inset 0 0 0 1px #d2dfd0; }
.upload-icon svg { width: 27px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.dropzone strong { color: #26362b; font-family: Georgia, "Songti SC", serif; font-size: 21px; font-weight: 600; }
.dropzone span:not(.upload-icon) { font-size: 13px; }
.dropzone u { color: #397a50; text-underline-offset: 3px; }
.dropzone small { margin-top: 14px; color: #9aa39d; font-size: 11px; }
.file-panel { min-height: 300px; padding: 27px 29px 25px; border-radius: 17px; background: #f8f9f5; border: 1px solid #e2e7df; }
.file-heading { display: flex; align-items: center; gap: 14px; }
.file-icon { width: 48px; height: 52px; flex: none; display: grid; place-items: center; color: #39724e; background: #e2eee0; border-radius: 13px; }
.file-icon svg { width: 24px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; }
.file-copy { display: grid; gap: 5px; min-width: 0; flex: 1; text-align: left; }
.file-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.file-copy span, .progress-meta { color: #849087; font-size: 11px; }
.icon-button { border: 0; background: transparent; color: #929c95; cursor: pointer; font-size: 25px; line-height: 1; }
.done-check { width: 30px; height: 30px; display: grid; place-items: center; background: #397c50; color: white; border-radius: 50%; }
.status-row { margin-top: 33px; display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
.status-row > strong { font-size: 22px; font-family: Georgia, serif; color: #365b42; }
.status { display: flex; align-items: center; gap: 7px; color: #68736b; }
.status i { width: 7px; height: 7px; border-radius: 50%; background: #99a39c; }
.status.uploading i, .status.hashing i, .status.merging i { background: #3f8657; box-shadow: 0 0 0 4px #dfece1; animation: blink 1.2s infinite; }
.status.done i { background: #3f8657; }.status.error i { background: #b55142; }.status.paused i { background: #ca9144; }
.progress-track { height: 9px; margin-top: 12px; overflow: hidden; border-radius: 99px; background: #dfe5dd; }
.progress-value { height: 100%; border-radius: inherit; background: linear-gradient(90deg, #315f41, #66a36f); transition: width .2s ease; }
.progress-meta { margin-top: 8px; display: flex; justify-content: space-between; }
.error-message, .success-message { margin: 15px 0 0; padding: 9px 11px; border-radius: 8px; font-size: 12px; }
.error-message { background: #fae9e5; color: #9c4135; }.success-message { background: #e4f0e4; color: #326b45; }
.actions { margin-top: 24px; display: flex; gap: 10px; }
.primary-button, .secondary-button { min-height: 43px; padding: 0 20px; border-radius: 11px; border: 0; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; font-size: 13px; font-weight: 700; transition: .2s ease; }
.primary-button { background: #214f34; color: white; box-shadow: 0 8px 18px rgba(33,79,52,.18); }.primary-button:hover { background: #163d27; transform: translateY(-1px); }
.secondary-button { background: #e6ebe4; color: #3c5243; }.secondary-button:hover { background: #dce4da; }
.actions svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; }.primary-button svg { fill: currentColor; stroke: none; }
.feature-strip { margin-top: 12px; padding: 16px 13px 7px; display: grid; grid-template-columns: repeat(3, 1fr); }
.feature-strip > div { padding: 3px 19px 10px; display: flex; align-items: center; gap: 11px; border-right: 1px solid #e0e4dd; }.feature-strip > div:last-child { border: 0; }
.feature-strip > div > span { color: #77917e; font-family: Georgia, serif; font-size: 12px; font-style: italic; }
.feature-strip p { margin: 0; display: grid; gap: 3px; }.feature-strip strong { font-size: 11px; }.feature-strip small { color: #929c95; font-size: 9px; }
footer { width: min(760px, 100%); margin: 17px auto 0; display: flex; justify-content: space-between; color: #8b968e; font-size: 10px; }
footer code { color: #5f7464; }
@keyframes blink { 50% { opacity: .4; } }
@media (max-width: 620px) {
  .shell { width: min(100% - 24px, 1080px); padding-top: 20px; }.hero .brand { margin-bottom: 28px; }.hero h1 { font-size: 43px; }.hero > p { margin-bottom: 22px; }
  .dropzone { min-height: 270px; }.file-panel { padding: 22px 19px; }.feature-strip { grid-template-columns: 1fr; padding: 8px 14px; }.feature-strip > div { border-right: 0; border-bottom: 1px solid #e0e4dd; padding: 11px 4px; }.feature-strip > div:last-child { border-bottom: 0; }
  footer { display: none; }.actions > * { flex: 1; }
}
</style>
