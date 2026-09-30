<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

type Clip = { id: number; start: number; end: number }
type Segment = { start: number; end: number }
type TextOverlay = { id: number; type: 'text'; text: string; x: number; y: number; start: number; end: number; color: string; size: number }
type ArrowOverlay = { id: number; type: 'arrow'; x: number; y: number; x2: number; y2: number; start: number; end: number; color: string; width: number }
type Overlay = TextOverlay | ArrowOverlay
type Selection = { kind: 'clip' | 'overlay'; id: number } | null
type DragState =
  | { type: 'clip-move' | 'clip-left' | 'clip-right'; id: number; startX: number; orig: { start: number; end: number } }
  | { type: 'overlay-move' | 'overlay-left' | 'overlay-right'; id: number; startX: number; orig: { start: number; end: number } }
  | { type: 'overlay-canvas'; id: number; startX: number; startY: number; orig: Overlay }

const fileInput = ref<HTMLInputElement | null>(null)
const musicInput = ref<HTMLInputElement | null>(null)
const video = ref<HTMLVideoElement | null>(null)
const overlayCanvas = ref<HTMLCanvasElement | null>(null)
const stage = ref<HTMLDivElement | null>(null)
const timelineScroll = ref<HTMLElement | null>(null)
const sourceFile = ref<File | null>(null)
const sourceUrl = ref('')
const musicFile = ref<File | null>(null)
const musicUrl = ref('')
const musicPlayer = ref<HTMLAudioElement | null>(null)
const duration = ref(0)
const clips = ref<Clip[]>([])
const overlays = ref<Overlay[]>([])
const selection = ref<Selection>(null)
const originalVolume = ref(100)
const musicVolume = ref(35)
const fps = ref(30)
const exporting = ref(false)
const exportProgress = ref(0)
const exportStage = ref('')
const errorMessage = ref('')
const supported = ref(true)
const playhead = ref(0)
const isPlaying = ref(false)
const loop = ref(false)
const timelineZoom = ref(60)
const snapEnabled = ref(true)
const draggingPlayhead = ref(false)
const drag = ref<DragState | null>(null)
const canvasDrag = ref<DragState | null>(null)
let nextId = 1
const history = ref<string[]>([])
const historyIndex = ref(-1)
let restoring = false
let activeClipId: number | null = null
let playbackFrame = 0

// Array order is sequence order; source in/out points may overlap or repeat.
const sortedClips = computed(() => clips.value)
const estimatedDuration = computed(() => sortedClips.value.reduce((sum, clip) => sum + clip.end - clip.start, 0))
const timelineWidth = computed(() => Math.max(timelineScroll.value?.clientWidth || 900, estimatedDuration.value * timelineZoom.value))
const pxPerSecond = computed(() => timelineWidth.value / Math.max(.001, estimatedDuration.value))
const selectedClip = computed(() => selection.value?.kind === 'clip' ? clips.value.find(item => item.id === selection.value!.id) || null : null)
const selectedOverlay = computed(() => selection.value?.kind === 'overlay' ? overlays.value.find(item => item.id === selection.value!.id) || null : null)
const rulerTicks = computed(() => {
  const step = timelineZoom.value >= 90 ? 1 : timelineZoom.value >= 45 ? 2 : 5
  const ticks: number[] = []
  for (let time = 0; time <= estimatedDuration.value + .001; time += step) ticks.push(time)
  return ticks
})
const clipViews = computed(() => {
  let outputStart = 0
  return sortedClips.value.map((clip, index) => {
    const view = { ...clip, outputStart, outputEnd: outputStart + clip.end - clip.start, index }
    outputStart = view.outputEnd
    return view
  })
})
const frameStep = computed(() => 1 / fps.value)

function formatTime(value: number) {
  if (!Number.isFinite(value)) return '00:00.0'
  const minutes = Math.floor(value / 60)
  const seconds = value - minutes * 60
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`
}

function formatFrame(value: number) {
  const frame = Math.round((value % 1) / frameStep.value)
  return `${String(frame).padStart(2, '0')}f`
}

function snapshot() {
  return JSON.stringify({ clips: clips.value, overlays: overlays.value })
}

function pushHistory() {
  if (restoring || snapshot() === history.value[historyIndex.value]) return
  history.value = history.value.slice(0, historyIndex.value + 1)
  history.value.push(snapshot())
  if (history.value.length > 80) history.value.shift()
  historyIndex.value = history.value.length - 1
}

function restore(state: string) {
  restoring = true
  const data = JSON.parse(state)
  clips.value = data.clips
  overlays.value = data.overlays
  void nextTick(() => { restoring = false; seekTimeline(Math.min(playhead.value, estimatedDuration.value)) })
  selection.value = null
  renderPreviewOverlay()
}

function undo() {
  if (historyIndex.value <= 0) return
  historyIndex.value--
  restore(history.value[historyIndex.value])
}

function redo() {
  if (historyIndex.value >= history.value.length - 1) return
  historyIndex.value++
  restore(history.value[historyIndex.value])
}

function selectVideo(file?: File) {
  if (!file || !file.type.startsWith('video/')) return
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value)
  sourceFile.value = file
  sourceUrl.value = URL.createObjectURL(file)
  clips.value = []
  overlays.value = []
  selection.value = null
  history.value = []
  historyIndex.value = -1
  errorMessage.value = ''
  exportProgress.value = 0
}

function onMetadata() {
  const player = video.value
  if (!player || !Number.isFinite(player.duration) || player.duration <= 0) return
  duration.value = player.duration
  clips.value = [{ id: nextId++, start: 0, end: player.duration }]
  playhead.value = 0
  resizeOverlay()
}

function resizeOverlay() {
  const target = overlayCanvas.value
  const player = video.value
  if (!target || !player?.videoWidth) return
  target.width = player.videoWidth
  target.height = player.videoHeight
  renderPreviewOverlay()
}

function drawArrow(ctx: CanvasRenderingContext2D, item: ArrowOverlay, width: number, height: number) {
  const x1 = width * item.x / 100
  const y1 = height * item.y / 100
  const x2 = width * item.x2 / 100
  const y2 = height * item.y2 / 100
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const head = Math.max(16, item.width * 3.5)
  ctx.strokeStyle = item.color
  ctx.lineWidth = item.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6))
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6))
  ctx.stroke()
}

function drawOverlays(ctx: CanvasRenderingContext2D | null, time: number, width?: number, height?: number) {
  if (!ctx) return
  const targetWidth = width || ctx.canvas.width
  const targetHeight = height || ctx.canvas.height
  if (!width) ctx.clearRect(0, 0, targetWidth, targetHeight)
  for (const item of overlays.value) {
    if (time < item.start || time > item.end) continue
    ctx.save()
    if (item.type === 'text') {
      ctx.font = `700 ${item.size}px "Microsoft YaHei", sans-serif`
      ctx.textBaseline = 'top'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(3, item.size / 10)
      ctx.strokeStyle = 'rgba(0, 0, 0, .55)'
      ctx.fillStyle = item.color
      const x = targetWidth * item.x / 100
      const y = targetHeight * item.y / 100
      ctx.strokeText(item.text, x, y)
      ctx.fillText(item.text, x, y)
    } else drawArrow(ctx, item, targetWidth, targetHeight)
    ctx.restore()
    if (selection.value?.kind === 'overlay' && selection.value.id === item.id && !width) drawSelectionBox(ctx, item, targetWidth, targetHeight)
  }
}

function drawSelectionBox(ctx: CanvasRenderingContext2D, item: Overlay, width: number, height: number) {
  ctx.save()
  ctx.strokeStyle = '#38bdf8'
  ctx.setLineDash([8, 5])
  ctx.lineWidth = Math.max(2, width / 640)
  if (item.type === 'text') {
    ctx.font = `700 ${item.size}px "Microsoft YaHei", sans-serif`
    ctx.textBaseline = 'top'
    const metrics = ctx.measureText(item.text)
    ctx.strokeRect(width * item.x / 100 - 6, height * item.y / 100 - 6, metrics.width + 12, item.size * 1.25 + 12)
  } else {
    const x1 = width * item.x / 100
    const y1 = height * item.y / 100
    const x2 = width * item.x2 / 100
    const y2 = height * item.y2 / 100
    const pad = item.width + 14
    ctx.strokeRect(Math.min(x1, x2) - pad, Math.min(y1, y2) - pad, Math.abs(x2 - x1) + pad * 2, Math.abs(y2 - y1) + pad * 2)
  }
  ctx.restore()
}

function renderPreviewOverlay() {
  drawOverlays(overlayCanvas.value?.getContext('2d') || null, playhead.value)
}

function outputToSourceTime(time: number) {
  let cursor = 0
  for (const clip of sortedClips.value) {
    const length = clip.end - clip.start
    if (time < cursor + length) return clip.start + Math.max(0, time - cursor)
    cursor += length
  }
  return sortedClips.value.at(-1)?.end || 0
}

function sourceToOutputTime(time: number) {
  let cursor = 0
  for (const clip of sortedClips.value) {
    if (time >= clip.start && time <= clip.end) return cursor + time - clip.start
    if (time < clip.start) return cursor
    cursor += clip.end - clip.start
  }
  return estimatedDuration.value
}

function handlePreviewTime() {
  const player = video.value
  if (!player || exporting.value || !isPlaying.value || player.seeking) return
  const index = clipViews.value.findIndex(clip => clip.id === activeClipId)
  const clip = clipViews.value[index]
  if (!clip) return
  if (player.currentTime >= clip.end - .005 || player.ended) {
    const next = clipViews.value[index + 1]
    if (next) { seekTimeline(next.outputStart); void player.play().catch(() => {}) }
    else if (loop.value) { seekTimeline(0); void player.play().catch(() => {}) }
    else { player.pause(); seekTimeline(estimatedDuration.value) }
  } else {
    playhead.value = clip.outputStart + Math.max(0, player.currentTime - clip.start)
    renderPreviewOverlay()
  }
}
function playbackTick() { handlePreviewTime(); playbackFrame = requestAnimationFrame(playbackTick) }
function jumpEdit(direction: number) {
  const points = [0, ...clipViews.value.map(clip => clip.outputEnd)]
  seekTimeline(direction < 0 ? points.filter(t => t < playhead.value - .001).at(-1) ?? 0 : points.find(t => t > playhead.value + .001) ?? estimatedDuration.value)
}
function moveSelected(direction: number) {
  const index = clips.value.findIndex(clip => clip.id === selectedClip.value?.id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= clips.value.length) return
  const [clip] = clips.value.splice(index, 1)
  clips.value.splice(target, 0, clip!)
}

/* ---------- 时间轴交互 ---------- */

function clipStyle(start: number, end: number) {
  const total = Math.max(.001, estimatedDuration.value)
  const safeStart = Math.max(0, Math.min(start, total))
  const safeEnd = Math.max(safeStart, Math.min(end, total))
  return { left: `${safeStart / total * 100}%`, width: `${Math.max(.15, (safeEnd - safeStart) / total * 100)}%` }
}

function snapTime(time: number, excludeIds: number[] = []) {
  if (!snapEnabled.value) return time
  const threshold = 8 / pxPerSecond.value
  const edges = new Set<number>([0, estimatedDuration.value, playhead.value])
  for (const clip of clipViews.value) if (!excludeIds.includes(clip.id)) { edges.add(clip.outputStart); edges.add(clip.outputEnd) }
  for (const item of overlays.value) if (!excludeIds.includes(item.id)) { edges.add(item.start); edges.add(item.end) }
  let best = time
  let bestDelta = threshold
  for (const edge of edges) {
    const delta = Math.abs(edge - time)
    if (delta < bestDelta) { best = edge; bestDelta = delta }
  }
  return best
}

function seekTimeline(time: number) {
  const next = Math.max(0, Math.min(time, estimatedDuration.value))
  playhead.value = next
  activeClipId = (clipViews.value.find(clip => next < clip.outputEnd) || clipViews.value.at(-1))?.id ?? null
  if (video.value && clips.value.length) video.value.currentTime = outputToSourceTime(next)
  syncMusic()
  renderPreviewOverlay()
}

function updatePlayheadFromPointer(event: PointerEvent) {
  const target = timelineScroll.value
  if (!target) return
  const rect = target.getBoundingClientRect()
  const raw = (event.clientX - rect.left + target.scrollLeft) / timelineWidth.value * estimatedDuration.value
  seekTimeline(snapTime(raw))
}

function startPlayheadDrag(event: PointerEvent) {
  if (event.button !== 0 || drag.value) return
  draggingPlayhead.value = true
  timelineScroll.value?.setPointerCapture(event.pointerId)
  updatePlayheadFromPointer(event)
}

function movePlayhead(event: PointerEvent) {
  if (draggingPlayhead.value) updatePlayheadFromPointer(event)
}

function stopPlayheadDrag(event: PointerEvent) {
  if (!draggingPlayhead.value) return
  draggingPlayhead.value = false
  timelineScroll.value?.releasePointerCapture(event.pointerId)
}

function neighborsOf(id: number) {
  const list = sortedClips.value
  const index = list.findIndex(clip => clip.id === id)
  return { prev: list[index - 1] || null, next: list[index + 1] || null }
}

function startClipDrag(event: PointerEvent, id: number, mode: 'clip-move' | 'clip-left' | 'clip-right') {
  if (event.button !== 0) return
  event.stopPropagation()
  const clip = clips.value.find(item => item.id === id)
  if (!clip) return
  selection.value = { kind: 'clip', id }
  drag.value = { type: mode, id, startX: event.clientX, orig: { start: clip.start, end: clip.end } }
  window.addEventListener('pointermove', moveTimelineDrag)
  window.addEventListener('pointerup', stopTimelineDrag, { once: true })
}

function startOverlayBarDrag(event: PointerEvent, id: number, mode: 'overlay-move' | 'overlay-left' | 'overlay-right') {
  if (event.button !== 0) return
  event.stopPropagation()
  const item = overlays.value.find(value => value.id === id)
  if (!item) return
  selection.value = { kind: 'overlay', id }
  drag.value = { type: mode, id, startX: event.clientX, orig: { start: item.start, end: item.end } }
  window.addEventListener('pointermove', moveTimelineDrag)
  window.addEventListener('pointerup', stopTimelineDrag, { once: true })
}

function moveTimelineDrag(event: PointerEvent) {
  const state = drag.value
  if (!state) return
  const delta = (event.clientX - state.startX) / pxPerSecond.value
  if (state.type === 'clip-move' || state.type === 'clip-left' || state.type === 'clip-right') {
    const clip = clips.value.find(item => item.id === state.id)
    if (!clip) return
    const frameDelta = Math.round(delta * fps.value) / fps.value
    if (state.type === 'clip-left') clip.start = Math.max(0, Math.min(state.orig.start + frameDelta, clip.end - frameStep.value))
    else if (state.type === 'clip-right') clip.end = Math.min(duration.value, Math.max(state.orig.end + frameDelta, clip.start + frameStep.value))
    else {
      const rect = timelineScroll.value?.getBoundingClientRect()
      if (!rect) return
      const time = (event.clientX - rect.left + timelineScroll.value!.scrollLeft) / pxPerSecond.value
      const target = clipViews.value.findIndex(item => time < (item.outputStart + item.outputEnd) / 2)
      const index = clips.value.findIndex(item => item.id === state.id)
      const insertion = target < 0 ? clips.value.length : target
      const destination = insertion > index ? insertion - 1 : insertion
      if (destination !== index) { clips.value.splice(index, 1); clips.value.splice(destination, 0, clip) }
    }
  } else {
    const item = overlays.value.find(value => value.id === state.id)
    if (!item) return
    const length = state.orig.end - state.orig.start
    if (state.type === 'overlay-left') item.start = Math.max(0, Math.min(snapTime(state.orig.start + delta, [state.id]), item.end - .1))
    else if (state.type === 'overlay-right') item.end = Math.min(estimatedDuration.value, Math.max(item.start + .1, snapTime(state.orig.end + delta, [state.id])))
    else {
      const shift = Math.max(-state.orig.start, Math.min(estimatedDuration.value - state.orig.end, delta))
      item.start = Math.max(0, state.orig.start + shift)
      item.end = item.start + length
    }
  }
  renderPreviewOverlay()
}

function stopTimelineDrag() {
  drag.value = null
  pushHistory()
  window.removeEventListener('pointermove', moveTimelineDrag)
}

/* ---------- 片段编辑操作 ---------- */

function splitAtPlayhead() {
  if (!clips.value.length) return
  const sourceTime = outputToSourceTime(playhead.value)
  const view = clipViews.value.find(item => playhead.value > item.outputStart + frameStep.value / 2 && playhead.value < item.outputEnd - frameStep.value / 2)
  const clip = clips.value.find(item => item.id === view?.id)
  if (!clip) return
  const copy = { id: nextId++, start: sourceTime, end: clip.end }
  clips.value.splice(clips.value.indexOf(clip) + 1, 0, copy)
  clip.end = sourceTime
  selection.value = { kind: 'clip', id: copy.id }
}

function deleteSelected() {
  if (!selection.value) return
  if (selection.value.kind === 'clip') {
    if (clips.value.length <= 1) { errorMessage.value = '至少保留一个片段，可拖动片段边缘调整范围。'; return }
    clips.value = clips.value.filter(item => item.id !== selection.value!.id)
  } else overlays.value = overlays.value.filter(item => item.id !== selection.value!.id)
  selection.value = null
  renderPreviewOverlay()
}

function duplicateSelected() {
  if (selection.value?.kind !== 'clip') return
  const clip = clips.value.find(item => item.id === selection.value!.id)
  if (!clip) return
  const copy = { ...clip, id: nextId++ }
  clips.value.splice(clips.value.indexOf(clip) + 1, 0, copy)
  selection.value = { kind: 'clip', id: copy.id }
}

/* ---------- 标注 ---------- */

function addText() {
  const end = Math.max(.1, estimatedDuration.value)
  const item: TextOverlay = { id: nextId++, type: 'text', text: '输入文字', x: 10, y: 12, start: 0, end, color: '#ffffff', size: 42 }
  overlays.value.push(item)
  selection.value = { kind: 'overlay', id: item.id }
  void nextTick(renderPreviewOverlay)
}

function addArrow() {
  const end = Math.max(.1, estimatedDuration.value)
  const item: ArrowOverlay = { id: nextId++, type: 'arrow', x: 20, y: 50, x2: 55, y2: 25, start: 0, end, color: '#ef4444', width: 8 }
  overlays.value.push(item)
  selection.value = { kind: 'overlay', id: item.id }
  void nextTick(renderPreviewOverlay)
}

function hitTestOverlay(px: number, py: number) {
  const ctx = overlayCanvas.value?.getContext('2d')
  if (!ctx) return null
  const width = ctx.canvas.width
  const height = ctx.canvas.height
  for (let index = overlays.value.length - 1; index >= 0; index--) {
    const item = overlays.value[index]
    if (playhead.value < item.start || playhead.value > item.end) continue
    if (item.type === 'text') {
      ctx.font = `700 ${item.size}px "Microsoft YaHei", sans-serif`
      const x = width * item.x / 100
      const y = height * item.y / 100
      if (px >= x - 10 && px <= x + ctx.measureText(item.text).width + 10 && py >= y - 10 && py <= y + item.size * 1.3 + 10) return item
    } else {
      const x1 = width * item.x / 100
      const y1 = height * item.y / 100
      const x2 = width * item.x2 / 100
      const y2 = height * item.y2 / 100
      const length = Math.max(1, Math.hypot(x2 - x1, y2 - y1))
      const distance = Math.abs((py - y1) * (x2 - x1) - (px - x1) * (y2 - y1)) / length
      if (distance < item.width + 14 && px >= Math.min(x1, x2) - 20 && px <= Math.max(x1, x2) + 20 && py >= Math.min(y1, y2) - 20 && py <= Math.max(y1, y2) + 20) return item
    }
  }
  return null
}

function startCanvasDrag(event: PointerEvent) {
  const target = stage.value
  const canvas = overlayCanvas.value
  if (!target || !canvas || event.button !== 0) return
  const rect = canvas.getBoundingClientRect()
  const px = (event.clientX - rect.left) / rect.width * canvas.width
  const py = (event.clientY - rect.top) / rect.height * canvas.height
  const hit = hitTestOverlay(px, py)
  if (!hit) { selection.value = null; renderPreviewOverlay(); return }
  selection.value = { kind: 'overlay', id: hit.id }
  target.setPointerCapture(event.pointerId)
  canvasDrag.value = { type: 'overlay-canvas', id: hit.id, startX: event.clientX, startY: event.clientY, orig: JSON.parse(JSON.stringify(hit)) }
  renderPreviewOverlay()
}

function moveCanvasDrag(event: PointerEvent) {
  const state = canvasDrag.value
  const canvas = overlayCanvas.value
  if (!state || !canvas) return
  const rect = canvas.getBoundingClientRect()
  const dx = (event.clientX - state.startX) / rect.width * 100
  const dy = (event.clientY - state.startY) / rect.height * 100
  const item = overlays.value.find(value => value.id === state.id)
  const orig = state.orig as Overlay
  if (!item) return
  if (item.type === 'text' && orig.type === 'text') {
    item.x = Math.max(0, Math.min(100, orig.x + dx))
    item.y = Math.max(0, Math.min(100, orig.y + dy))
  } else if (item.type === 'arrow' && orig.type === 'arrow') {
    item.x = Math.max(0, Math.min(100, orig.x + dx))
    item.y = Math.max(0, Math.min(100, orig.y + dy))
    item.x2 = Math.max(0, Math.min(100, orig.x2 + dx))
    item.y2 = Math.max(0, Math.min(100, orig.y2 + dy))
  }
  renderPreviewOverlay()
}

function stopCanvasDrag() {
  canvasDrag.value = null
  pushHistory()
  window.removeEventListener('pointermove', moveCanvasDrag)
}

/* ---------- 播放控制 ---------- */

async function togglePlayback() {
  const player = video.value
  if (!player || !clips.value.length) return
  if (!player.paused) player.pause()
  else {
    if (playhead.value >= estimatedDuration.value - .05) seekTimeline(0)
    await player.play().catch(() => {})
  }
}

function stepFrames(count: number) {
  seekTimeline(playhead.value + count * frameStep.value)
}

function goToEnd() {
  seekTimeline(estimatedDuration.value)
}

function fitTimeline() {
  const visible = (timelineScroll.value?.clientWidth || 900) - 4
  timelineZoom.value = Math.max(20, Math.min(140, visible / Math.max(.001, estimatedDuration.value)))
}

function selectMusic(file?: File) {
  if (!file || !file.type.startsWith('audio/')) return
  if (musicUrl.value) URL.revokeObjectURL(musicUrl.value)
  musicUrl.value = URL.createObjectURL(file)
  musicFile.value = file
}

function removeMusic() {
  if (musicUrl.value) URL.revokeObjectURL(musicUrl.value)
  musicUrl.value = ''
  musicFile.value = null
}

function syncMusic() {
  const audio = musicPlayer.value
  if (!audio) return
  audio.volume = Math.min(1, musicVolume.value / 100)
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    const time = playhead.value % audio.duration
    if (Math.abs(audio.currentTime - time) > .15) audio.currentTime = time
  }
  if (isPlaying.value && !exporting.value) void audio.play().catch(() => {})
  else audio.pause()
}

/* ---------- 导出 ---------- */

function seekVideo(time: number) {
  const player = video.value!
  if (Math.abs(player.currentTime - time) < .001) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('读取视频帧超时')), 10000)
    player.addEventListener('seeked', () => { clearTimeout(timeout); resolve() }, { once: true })
    player.currentTime = time
  })
}

async function decodeAudio(file: File, context: AudioContext) {
  try { return await context.decodeAudioData(await file.arrayBuffer()) }
  catch { return null }
}

async function mixAudio(segments: Segment[], outputDuration: number) {
  if (!sourceFile.value) return null
  const context = new AudioContext()
  const sourceAudio = await decodeAudio(sourceFile.value, context)
  const musicAudio = musicFile.value ? await decodeAudio(musicFile.value, context) : null
  await context.close()
  if (!sourceAudio && !musicAudio) return null

  const sampleRate = 48000
  const offline = new OfflineAudioContext(2, Math.ceil(outputDuration * sampleRate), sampleRate)
  if (sourceAudio && originalVolume.value > 0) {
    let cursor = 0
    for (const segment of segments) {
      const length = segment.end - segment.start
      const node = offline.createBufferSource()
      const gain = offline.createGain()
      node.buffer = sourceAudio
      gain.gain.value = originalVolume.value / 100
      node.connect(gain).connect(offline.destination)
      node.start(cursor, segment.start, length)
      cursor += length
    }
  }
  if (musicAudio && musicAudio.duration > .01 && musicVolume.value > 0) {
    // 单个循环节点替代逐段创建,避免超长视频 + 短音乐时节点数爆炸。
    const node = offline.createBufferSource()
    const gain = offline.createGain()
    node.buffer = musicAudio
    node.loop = true
    gain.gain.value = musicVolume.value / 100
    node.connect(gain).connect(offline.destination)
    node.start(0)
    node.stop(outputDuration)
  }
  return offline.startRendering()
}

async function exportVideo() {
  if (!sourceFile.value || !video.value || exporting.value) return
  errorMessage.value = ''
  exporting.value = true
  exportProgress.value = 0
  try {
    const segments = sortedClips.value.map(clip => ({ start: clip.start, end: clip.end }))
    const outputDuration = estimatedDuration.value
    if (!segments.length || outputDuration < .1) throw new Error('没有可导出的有效视频片段。')
    const player = video.value
    player.pause()
    musicPlayer.value?.pause()
    const maxWidth = 1920
    const scale = Math.min(1, maxWidth / player.videoWidth)
    const width = Math.max(2, Math.floor(player.videoWidth * scale / 2) * 2)
    const height = Math.max(2, Math.floor(player.videoHeight * scale / 2) * 2)
    const audioBuffer = await mixAudio(segments, outputDuration)
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer')
    const target = new ArrayBufferTarget()
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width, height },
      ...(audioBuffer ? { audio: { codec: 'aac', sampleRate: audioBuffer.sampleRate, numberOfChannels: audioBuffer.numberOfChannels } } : {}),
      fastStart: 'in-memory',
    })

    exportStage.value = '正在编码视频画面'
    const exportCanvas = document.createElement('canvas')
    exportCanvas.width = width
    exportCanvas.height = height
    const ctx = exportCanvas.getContext('2d', { alpha: false })!
    const videoConfig: VideoEncoderConfig = {
      codec: 'avc1.42001f', width, height, framerate: fps.value,
      bitrate: Math.max(2_000_000, Math.round(width * height * fps.value * .09)),
      avc: { format: 'avc' },
    }
    const support = await VideoEncoder.isConfigSupported(videoConfig)
    if (!support.supported) throw new Error('当前浏览器不支持 H.264 WebCodecs 编码。')
    let encoderError: Error | null = null
    const videoEncoder = new VideoEncoder({
      output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
      error: error => { encoderError = error },
    })
    videoEncoder.configure(videoConfig)
    const frameCount = Math.ceil(outputDuration * fps.value)
    for (let index = 0; index < frameCount; index++) {
      if (encoderError) throw encoderError
      const outputTime = index / fps.value
      await seekVideo(outputToSourceTime(outputTime))
      ctx.drawImage(player, 0, 0, width, height)
      drawOverlays(ctx, outputTime, width, height)
      const frame = new VideoFrame(exportCanvas, { timestamp: Math.round(outputTime * 1_000_000), duration: Math.round(1_000_000 / fps.value) })
      videoEncoder.encode(frame, { keyFrame: index % (fps.value * 2) === 0 })
      frame.close()
      if (videoEncoder.encodeQueueSize > 8) await new Promise(resolve => setTimeout(resolve, 0))
      exportProgress.value = Math.round((index + 1) / frameCount * (audioBuffer ? 85 : 95))
    }
    if (encoderError) throw encoderError
    await videoEncoder.flush()
    if (encoderError) throw encoderError
    videoEncoder.close()

    if (audioBuffer) {
      exportStage.value = '正在混合并编码音频'
      if (typeof AudioEncoder === 'undefined') throw new Error('当前浏览器不支持 WebCodecs 音频编码。')
      const audioConfig: AudioEncoderConfig = {
        codec: 'mp4a.40.2', sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioBuffer.numberOfChannels, bitrate: 128000,
      }
      const audioSupport = await AudioEncoder.isConfigSupported(audioConfig)
      if (!audioSupport.supported) throw new Error('当前浏览器不支持 AAC WebCodecs 编码。')
      let audioError: Error | null = null
      const audioEncoder = new AudioEncoder({
        output: (chunk, metadata) => muxer.addAudioChunk(chunk, metadata),
        error: error => { audioError = error },
      })
      audioEncoder.configure(audioConfig)
      const blockSize = 1024
      const channels = audioBuffer.numberOfChannels
      for (let offset = 0; offset < audioBuffer.length; offset += blockSize) {
        if (audioError) throw audioError
        const frames = Math.min(blockSize, audioBuffer.length - offset)
        // AAC 要求每个 AudioData 正好 1024 采样帧,末尾不足时补零,否则编码器会报错。
        const planar = new Float32Array(blockSize * channels)
        for (let channel = 0; channel < channels; channel++) {
          planar.set(audioBuffer.getChannelData(channel).subarray(offset, offset + frames), channel * blockSize)
        }
        const data = new AudioData({
          format: 'f32-planar', sampleRate: audioBuffer.sampleRate,
          numberOfFrames: blockSize, numberOfChannels: channels,
          timestamp: Math.round(offset / audioBuffer.sampleRate * 1_000_000), data: planar,
        })
        audioEncoder.encode(data)
        data.close()
        if (audioEncoder.encodeQueueSize > 12) await new Promise(resolve => setTimeout(resolve, 0))
        exportProgress.value = 85 + Math.round((offset + frames) / audioBuffer.length * 10)
      }
      if (audioError) throw audioError
      await audioEncoder.flush()
      if (audioError) throw audioError
      audioEncoder.close()
    }

    exportStage.value = '正在封装 MP4'
    muxer.finalize()
    const blob = new Blob([target.buffer], { type: 'video/mp4' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `edited-${sourceFile.value.name.replace(/\.[^.]+$/, '')}.mp4`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    exportProgress.value = 100
    exportStage.value = '导出完成'
  } catch (error: any) {
    errorMessage.value = error?.message || '导出失败，请重试。'
    exportStage.value = '导出失败'
  } finally {
    exporting.value = false
  }
}

/* ---------- 键盘快捷键 ---------- */

function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null
  return !!element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable)
}

function handleKeydown(event: KeyboardEvent) {
  if (isTypingTarget(event.target) || exporting.value) return
  const key = event.key.toLowerCase()
  if (event.code === 'Space') { event.preventDefault(); void togglePlayback() }
  else if (key === 'arrowleft') { event.preventDefault(); stepFrames(event.shiftKey ? -Math.round(1 / frameStep.value) : -1) }
  else if (key === 'arrowright') { event.preventDefault(); stepFrames(event.shiftKey ? Math.round(1 / frameStep.value) : 1) }
  else if (key === 'arrowup') { event.preventDefault(); jumpEdit(-1) }
  else if (key === 'arrowdown') { event.preventDefault(); jumpEdit(1) }
  else if (key === 'n') snapEnabled.value = !snapEnabled.value
  else if (key === 'home') { event.preventDefault(); seekTimeline(0) }
  else if (key === 'end') { event.preventDefault(); goToEnd() }
  else if (key === 's') splitAtPlayhead()
  else if (key === 'delete' || key === 'backspace') deleteSelected()
  else if (key === 'd' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); duplicateSelected() }
  else if (key === 'z' && (event.ctrlKey || event.metaKey) && !event.shiftKey) { event.preventDefault(); undo() }
  else if ((key === 'z' && (event.ctrlKey || event.metaKey) && event.shiftKey) || (key === 'y' && (event.ctrlKey || event.metaKey))) { event.preventDefault(); redo() }
}

onMounted(() => {
  supported.value = !!window.VideoEncoder && !!window.VideoFrame && !!window.OfflineAudioContext
  playbackFrame = requestAnimationFrame(playbackTick)
  window.addEventListener('resize', resizeOverlay)
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  if (musicUrl.value) URL.revokeObjectURL(musicUrl.value)
  cancelAnimationFrame(playbackFrame)
  window.removeEventListener('pointermove', moveTimelineDrag)
  window.removeEventListener('pointerup', stopTimelineDrag)
  window.removeEventListener('resize', resizeOverlay)
  window.removeEventListener('keydown', handleKeydown)
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value)
})
watch([playhead, musicVolume, isPlaying], syncMusic)
watch(originalVolume, () => { if (video.value) video.value.volume = Math.min(1, originalVolume.value / 100) })
watch([clips, overlays], () => {
  if (!drag.value && !canvasDrag.value) pushHistory()
  renderPreviewOverlay()
}, { deep: true })
watch(clips, () => {
  if (!exporting.value) { video.value?.pause(); seekTimeline(Math.min(playhead.value, estimatedDuration.value)) }
}, { deep: true })
</script>

<template>
  <main class="editor-shell" :inert="exporting" :aria-busy="exporting">
    <header class="top-bar">
      <div class="top-left">
        <NuxtLink to="/" class="back-link" title="返回首页">←</NuxtLink>
        <span class="app-badge">PRO</span>
        <div class="project-meta">
          <strong>{{ sourceFile ? sourceFile.name : '未导入项目' }}</strong>
          <small>{{ sourceFile ? `${formatTime(duration)} · ${video?.videoWidth || 0} × ${video?.videoHeight || 0}` : '导入后开始剪辑' }}</small>
        </div>
      </div>
      <div class="top-right">
        <button title="撤销 (Ctrl+Z)" :disabled="historyIndex <= 0" @click="undo">↶ 撤销</button>
        <button title="重做 (Ctrl+Shift+Z)" :disabled="historyIndex >= history.length - 1" @click="redo">↷ 重做</button>
        <button class="primary" :disabled="exporting || !supported || estimatedDuration < .1" @click="exportVideo">{{ exporting ? `${exportProgress}%` : '导出 MP4' }}</button>
      </div>
    </header>

    <section v-if="!sourceFile" class="import-card">
      <input ref="fileInput" type="file" accept="video/*" hidden @change="selectVideo(($event.target as HTMLInputElement).files?.[0])">
      <div class="import-icon">▶</div>
      <h2>导入需要剪辑的视频</h2>
      <p>推荐使用浏览器可播放的 MP4 或 WebM 文件，全程本地处理。</p>
      <button class="primary" @click="fileInput?.click()">选择视频文件</button>
      <p v-if="!supported" class="message error">当前浏览器缺少 WebCodecs，请使用最新版 Chrome 或 Edge。</p>
    </section>

    <template v-else>
      <audio v-if="musicFile" ref="musicPlayer" :src="musicUrl" loop @loadedmetadata="syncMusic" />
      <div class="editor-body">
        <section class="preview-panel">
          <div ref="stage" class="video-stage" :style="video?.videoWidth ? { aspectRatio: `${video.videoWidth} / ${video.videoHeight}` } : {}" @pointerdown="startCanvasDrag" @pointermove="moveCanvasDrag" @pointerup="stopCanvasDrag" @pointercancel="stopCanvasDrag">
            <video ref="video" :src="sourceUrl" playsinline @loadedmetadata="onMetadata" @timeupdate="handlePreviewTime" @seeked="handlePreviewTime" @play="isPlaying = true" @pause="isPlaying = false" @ended="isPlaying = true; handlePreviewTime(); isPlaying = !video?.paused" />
            <canvas ref="overlayCanvas" />
            <p class="stage-hint">文字 / 箭头可直接在画面中拖动</p>
          </div>
        </section>

        <aside class="inspector">
          <div v-if="selectedClip" class="inspector-card">
            <h3>视频片段</h3>
            <div class="field-grid">
              <label>入点 (源)<input :value="selectedClip.start.toFixed(2)" type="number" min="0" :max="duration" step="0.1" @change="pushHistory(); selectedClip.start = Math.max(0, Math.min(+(<HTMLInputElement>$event.target).value, selectedClip.end - .1))"></label>
              <label>出点 (源)<input :value="selectedClip.end.toFixed(2)" type="number" min="0" :max="duration" step="0.1" @change="pushHistory(); selectedClip.end = Math.min(duration, Math.max(+(<HTMLInputElement>$event.target).value, selectedClip.start + .1))"></label>
            </div>
            <p class="field-note">时长 {{ formatTime(selectedClip.end - selectedClip.start) }} · 拖动时间轴片段边缘可微调</p>
            <div class="row-buttons">
              <button @click="splitAtPlayhead">在播放头拆分 (S)</button>
              <button @click="duplicateSelected">复制片段 (Ctrl+D)</button>
              <button :disabled="clips[0]?.id === selectedClip.id" @click="moveSelected(-1)">向前移动</button>
              <button :disabled="clips.at(-1)?.id === selectedClip.id" @click="moveSelected(1)">向后移动</button>
              <button class="danger" @click="deleteSelected">删除 (Del)</button>
            </div>
          </div>

          <div v-else-if="selectedOverlay" class="inspector-card">
            <h3>{{ selectedOverlay.type === 'text' ? '文字标注' : '箭头标注' }}</h3>
            <label v-if="selectedOverlay.type === 'text'" class="field">内容<input v-model="selectedOverlay.text" type="text" @change="pushHistory()" @input="renderPreviewOverlay"></label>
            <div class="field-grid">
              <label>开始<input v-model.number="selectedOverlay.start" type="number" min="0" :max="estimatedDuration" step="0.1" @change="pushHistory()" @input="renderPreviewOverlay"></label>
              <label>结束<input v-model.number="selectedOverlay.end" type="number" min="0" :max="estimatedDuration" step="0.1" @change="pushHistory()" @input="renderPreviewOverlay"></label>
            </div>
            <div v-if="selectedOverlay.type === 'arrow'" class="field-grid">
              <label>起点 X %<input v-model.number="selectedOverlay.x" type="number" min="0" max="100" @input="renderPreviewOverlay"></label>
              <label>起点 Y %<input v-model.number="selectedOverlay.y" type="number" min="0" max="100" @input="renderPreviewOverlay"></label>
              <label>终点 X %<input v-model.number="selectedOverlay.x2" type="number" min="0" max="100" @input="renderPreviewOverlay"></label>
              <label>终点 Y %<input v-model.number="selectedOverlay.y2" type="number" min="0" max="100" @input="renderPreviewOverlay"></label>
            </div>
            <div class="field-grid">
              <label>颜色<input v-model="selectedOverlay.color" type="color" @input="renderPreviewOverlay"></label>
              <label>{{ selectedOverlay.type === 'text' ? '字号' : '粗细' }}<input v-if="selectedOverlay.type === 'text'" v-model.number="selectedOverlay.size" type="number" min="12" max="160" @change="pushHistory()" @input="renderPreviewOverlay"><input v-else v-model.number="selectedOverlay.width" type="number" min="2" max="30" @input="renderPreviewOverlay"></label>
            </div>
            <div class="row-buttons"><button class="danger" @click="deleteSelected">删除 (Del)</button></div>
          </div>

          <div v-else class="inspector-card">
            <h3>工具箱</h3>
            <div class="tool-grid">
              <button @click="splitAtPlayhead">✂ 拆分片段</button>
              <button @click="addText">T 添加文字</button>
              <button @click="addArrow">↗ 添加箭头</button>
              <button @click="fitTimeline">⤢ 时间轴适配</button>
            </div>
            <p class="field-note">选中时间轴片段或标注后，此处显示对应属性。</p>
          </div>

          <div class="inspector-card">
            <h3>音频混合</h3>
            <label class="field">视频原声 {{ originalVolume }}%<input v-model.number="originalVolume" type="range" min="0" max="100"></label>
            <input ref="musicInput" type="file" accept="audio/*" hidden @change="selectMusic(($event.target as HTMLInputElement).files?.[0])">
            <div class="row-buttons">
              <button @click="musicInput?.click()">{{ musicFile ? '更换背景音乐' : '添加背景音乐' }}</button>
              <button v-if="musicFile" class="danger" @click="removeMusic">移除</button>
            </div>
            <label class="field">背景音乐 {{ musicVolume }}%<input v-model.number="musicVolume" type="range" min="0" max="100" :disabled="!musicFile"></label>
            <p v-if="musicFile" class="field-note">{{ musicFile.name }} · 不足时自动循环</p>
          </div>

          <div class="inspector-card">
            <h3>导出设置</h3>
            <div class="field-grid">
              <label>帧率<select v-model.number="fps"><option :value="24">24 FPS</option><option :value="30">30 FPS</option><option :value="60">60 FPS</option></select></label>
              <label>成片时长<span class="readonly-value">{{ formatTime(estimatedDuration) }}</span></label>
            </div>
            <div v-if="exporting || exportProgress" class="progress"><span><i :style="{ width: `${exportProgress}%` }" /></span><small>{{ exportStage }} · {{ exportProgress }}%</small></div>
          </div>
        </aside>
      </div>

      <section class="timeline-panel">
        <header class="timeline-toolbar">
          <div class="transport">
            <button title="回到开头 (Home)" @click="seekTimeline(0)">⏮</button>
            <button title="上一帧 (←)" @click="stepFrames(-1)">◂|</button>
            <button class="play-button" :title="isPlaying ? '暂停 (Space)' : '播放 (Space)'" @click="togglePlayback">{{ isPlaying ? '❚❚' : '▶' }}</button>
            <button title="下一帧 (→)" @click="stepFrames(1)">|▸</button>
            <button title="跳到结尾 (End)" @click="goToEnd()">⏭</button>
            <button :class="{ active: loop }" title="循环播放" @click="loop = !loop">↻</button>
          </div>
          <code class="timecode">{{ formatTime(playhead) }} <em>· {{ formatFrame(playhead) }}</em> / {{ formatTime(estimatedDuration) }}</code>
          <div class="edit-actions">
            <button title="上一个剪辑点 (↑)" @click="jumpEdit(-1)">|←</button>
            <button title="下一个剪辑点 (↓)" @click="jumpEdit(1)">→|</button>
            <button @click="addText">T 文字</button>
            <button @click="addArrow">↗ 箭头</button>
            <button @click="fitTimeline">适配</button>
            <button title="在播放头拆分片段 (S)" @click="splitAtPlayhead">✂ 拆分</button>
            <button title="删除选中 (Del)" :disabled="!selection" @click="deleteSelected">🗑 删除</button>
            <button :class="{ active: snapEnabled }" title="吸附到边缘与播放头" @click="snapEnabled = !snapEnabled">🧲 吸附</button>
          </div>
          <label class="zoom-control">−<input v-model.number="timelineZoom" type="range" min="20" max="140">＋</label>
        </header>

        <div class="timeline-layout">
          <div class="track-labels">
            <div class="ruler-label">轨道</div>
            <div><strong>V1</strong><span>视频</span></div>
            <div><strong>G1</strong><span>文字 / 箭头</span></div>
            <div><strong>A1</strong><span>视频原声</span></div>
            <div><strong>A2</strong><span>背景音乐</span></div>
          </div>
          <div ref="timelineScroll" class="timeline-scroll">
            <div
              class="timeline-content"
              :style="{ width: `${timelineWidth}px` }"
              @pointerdown="startPlayheadDrag"
              @pointermove="movePlayhead"
              @pointerup="stopPlayheadDrag"
              @pointercancel="stopPlayheadDrag"
            >
              <div class="time-ruler">
                <span v-for="tick in rulerTicks" :key="tick" :style="{ left: `${tick / Math.max(.001, estimatedDuration) * 100}%` }"><i />{{ formatTime(tick) }}</span>
              </div>
              <div class="track video-track">
                <div
                  v-for="clip in clipViews"
                  :key="clip.id"
                  class="clip video-clip"
                  :class="{ selected: selection?.kind === 'clip' && selection.id === clip.id }"
                  :style="clipStyle(clip.outputStart, clip.outputEnd)"
                  @pointerdown="startClipDrag($event, clip.id, 'clip-move')"
                >
                  <span class="handle left" @pointerdown="startClipDrag($event, clip.id, 'clip-left')" />
                  <span class="handle right" @pointerdown="startClipDrag($event, clip.id, 'clip-right')" />
                  <span class="film-pattern" />
                  <strong>{{ formatTime(clip.start) }}–{{ formatTime(clip.end) }}</strong>
                </div>
              </div>
              <div class="track overlay-track">
                <div
                  v-for="item in overlays"
                  :key="item.id"
                  class="clip overlay-clip"
                  :class="[item.type, { selected: selection?.kind === 'overlay' && selection.id === item.id }]"
                  :style="clipStyle(item.start, item.end)"
                  @pointerdown="startOverlayBarDrag($event, item.id, 'overlay-move')"
                >
                  <span class="handle left" @pointerdown="startOverlayBarDrag($event, item.id, 'overlay-left')" />
                  <span class="handle right" @pointerdown="startOverlayBarDrag($event, item.id, 'overlay-right')" />
                  {{ item.type === 'text' ? `T · ${item.text}` : '↗ 箭头' }}
                </div>
              </div>
              <div class="track audio-track">
                <div v-for="clip in clipViews" :key="clip.id" class="clip audio-clip" :style="clipStyle(clip.outputStart, clip.outputEnd)"><span class="waveform" />原声 {{ originalVolume }}%</div>
              </div>
              <div class="track music-track">
                <div v-if="musicFile" class="clip music-clip" :style="clipStyle(0, estimatedDuration)"><span class="waveform" />{{ musicFile.name }} · {{ musicVolume }}%</div>
              </div>
              <div class="playhead" :style="{ left: `${playhead / Math.max(.001, estimatedDuration) * 100}%` }"><i /><span /></div>
            </div>
          </div>
        </div>
      </section>

      <p class="shortcut-hint">拖动片段重排 · 边缘逐帧修剪 · 删除后自动合拢 · ↑ ↓ 跳转剪辑点 · N 吸附 · Space 播放 / 暂停 · ← → 逐帧（+Shift 1 秒）· S 拆分 · Del 删除 · Ctrl+D 复制 · Ctrl+Z / Ctrl+Shift+Z 撤销重做</p>
      <p v-if="errorMessage" class="message error" role="alert">{{ errorMessage }}</p>
    </template>
  </main>
</template>

<style scoped>
:global(*) { box-sizing: border-box; }
:global(body) { margin: 0; background: #0b0e14; }
button, input, select { font: inherit; }
.editor-shell { min-height: 100vh; display: flex; flex-direction: column; color: #dbe2ef; font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif; }
button { min-height: 34px; padding: 0 12px; border: 1px solid #3a4354; border-radius: 7px; color: #d9e1ef; background: #262d3b; cursor: pointer; font-size: 12px; }
button:hover:not(:disabled) { border-color: #68799a; background: #30394a; }
button:disabled { opacity: .45; cursor: not-allowed; }
button.primary { border-color: #5268c9; color: #fff; background: #5268c9; font-weight: 700; }
button.danger { border-color: #703b49; color: #ffbdc7; background: #4b2832; }
button.active { border-color: #5268c9; color: #aebcff; background: #2c3752; }

.top-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 18px; border-bottom: 1px solid #202634; background: #10141d; }
.top-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.back-link { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 7px; color: #8e9aae; text-decoration: none; background: #1c222e; }
.back-link:hover { color: #fff; }
.app-badge { padding: 3px 8px; border-radius: 5px; color: #aebcff; background: #2c3752; font-size: 10px; font-weight: 800; letter-spacing: .1em; }
.project-meta { display: grid; min-width: 0; }
.project-meta strong { overflow: hidden; color: #eef2fa; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.project-meta small { color: #77839a; font-size: 11px; }
.top-right { display: flex; align-items: center; gap: 8px; }

.import-card { flex: 1; min-height: 60vh; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1px dashed #2c3446; border-radius: 18px; margin: 40px auto; width: min(560px, 90%); background: #10141d; text-align: center; }
.import-icon { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 18px; color: #8fa2ef; background: #1c2438; font-size: 26px; }
.import-card h2 { margin: 16px 0 6px; }
.import-card > p { margin: 0 0 20px; color: #77839a; font-size: 13px; }

.editor-body { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 14px; padding: 14px 18px 6px; align-items: start; }
.preview-panel { position: sticky; top: 14px; }
.video-stage { position: relative; overflow: hidden; max-height: 62vh; margin: auto; width: fit-content; max-width: 100%; border-radius: 12px; background: #05070c; box-shadow: 0 16px 42px #00000066; cursor: default; }
.video-stage video { display: block; max-height: 62vh; max-width: 100%; }
.video-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.stage-hint { position: absolute; right: 10px; bottom: 8px; margin: 0; padding: 4px 9px; border-radius: 6px; color: #93a0b6; background: #0d1117cc; font-size: 10px; pointer-events: none; opacity: .85; }

.inspector { display: grid; gap: 12px; align-content: start; }
.inspector-card { padding: 14px; border: 1px solid #232a39; border-radius: 11px; background: #131824; }
.inspector-card h3 { margin: 0 0 11px; color: #eef2fa; font-size: 13px; }
.field, .inspector-card > label { display: grid; gap: 5px; margin: 8px 0 0; color: #8e9aae; font-size: 11px; }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.field-grid label { display: grid; gap: 4px; color: #8e9aae; font-size: 10px; }
.readonly-value { display: grid; place-items: center; min-height: 34px; border: 1px solid #232a39; border-radius: 6px; color: #c6d0e2; background: #0f141f; font-size: 12px; }
input[type="number"], input[type="text"], select { width: 100%; min-height: 34px; padding: 0 9px; border: 1px solid #2c3446; border-radius: 6px; color: #e6ecf7; background: #0f141f; }
input[type="range"] { width: 100%; accent-color: #5268c9; }
input[type="color"] { width: 100%; min-height: 34px; padding: 2px; border: 1px solid #2c3446; border-radius: 6px; background: #0f141f; }
.field-note { margin: 9px 0 0; color: #66718a; font-size: 10px; }
.row-buttons { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 11px; }
.tool-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.progress { display: grid; gap: 5px; margin-top: 11px; }
.progress > span { height: 7px; overflow: hidden; border-radius: 99px; background: #1f2634; }
.progress i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #4058c4, #6e84e4); transition: width .2s; }
.progress small { color: #8e9aae; }

.timeline-panel { overflow: hidden; margin: 10px 18px 8px; border: 1px solid #262d3b; border-radius: 13px; background: #12161f; }
.timeline-toolbar { min-height: 52px; display: flex; align-items: center; gap: 13px; padding: 8px 12px; border-bottom: 1px solid #262d3b; background: #171c26; }
.transport, .edit-actions, .zoom-control { display: flex; align-items: center; gap: 5px; }
.timeline-toolbar .play-button { width: 38px; padding: 0; color: #fff; background: #5268c9; }
.timecode { min-width: 150px; color: #aeb8ca; font: 11px ui-monospace, monospace; }
.timecode em { font-style: normal; color: #66718a; }
.edit-actions { flex: 1; justify-content: center; flex-wrap: wrap; }
.zoom-control { color: #8e9aae; font-size: 12px; }.zoom-control input { width: 90px; }
.timeline-layout { display: grid; grid-template-columns: 128px minmax(0, 1fr); }
.track-labels { border-right: 1px solid #262d3b; background: #171c26; }
.track-labels > div { height: 58px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid #222836; }
.track-labels .ruler-label { height: 30px; color: #778399; font-size: 10px; text-transform: uppercase; }
.track-labels strong { width: 24px; color: #8fa2ef; font-size: 10px; }.track-labels span { color: #aeb8ca; font-size: 11px; }
.timeline-scroll { overflow-x: auto; overflow-y: hidden; }
.timeline-content { min-width: 100%; position: relative; user-select: none; touch-action: none; }
.time-ruler { height: 30px; position: relative; border-bottom: 1px solid #2a3140; background: #151a24; }
.time-ruler > span { position: absolute; top: 0; height: 100%; padding: 6px 0 0 5px; border-left: 1px solid #4b5568; color: #7f8a9c; font: 9px ui-monospace, monospace; }
.track { height: 58px; position: relative; border-bottom: 1px solid #202634; background-image: linear-gradient(90deg, #ffffff04 1px, transparent 1px); background-size: 60px 100%; }
.clip { height: 46px; position: absolute; top: 6px; overflow: hidden; border: 1px solid; border-radius: 5px; white-space: nowrap; cursor: grab; }
.clip.selected { outline: 2px solid #38bdf8; outline-offset: 1px; }
.clip .handle { position: absolute; top: 0; bottom: 0; width: 9px; cursor: ew-resize; z-index: 2; }
.clip .handle.left { left: 0; border-radius: 4px 0 0 4px; }
.clip .handle.right { right: 0; border-radius: 0 4px 4px 0; }
.clip .handle::after { content: ''; position: absolute; top: 50%; left: 3px; width: 2px; height: 16px; transform: translateY(-50%); border-radius: 2px; background: #ffffff70; }
.clip .handle.right::after { left: auto; right: 3px; }
.video-clip { display: flex; align-items: flex-end; padding: 0 12px 5px; border-color: #687dd8; color: #fff; background: #4358ad; font-size: 9px; }
.film-pattern { position: absolute; inset: 0; opacity: .5; background: repeating-linear-gradient(90deg, #8da1f055 0 18px, transparent 18px 22px); }
.video-clip strong { position: relative; z-index: 1; text-shadow: 0 1px 2px #18204d; }
.overlay-clip { display: flex; align-items: center; padding: 0 12px; border-color: #9b70ce; color: #f0ddff; background: #674493; font-size: 10px; }
.overlay-clip.arrow { border-color: #d27a62; background: #914b3b; }
.audio-clip, .music-clip { display: flex; align-items: center; padding: 0 8px; border-color: #348d79; color: #d5fff4; background: #226b5c; font-size: 9px; cursor: default; }
.music-clip { border-color: #bd8b45; color: #fff1d3; background: #795c2f; }
.waveform { position: absolute; inset: 6px 0; opacity: .35; background: repeating-linear-gradient(90deg, transparent 0 3px, currentColor 3px 4px, transparent 4px 7px); mask-image: linear-gradient(0deg, transparent, #000 45%, transparent); }
.playhead { width: 1px; position: absolute; z-index: 4; top: 0; bottom: 0; background: #ff5a68; pointer-events: none; }
.playhead i { width: 11px; height: 11px; position: absolute; top: 0; left: -5px; border-radius: 2px 2px 6px 6px; background: #ff5a68; }
.playhead span { position: absolute; inset: 0 -5px; }
.shortcut-hint { margin: 0 18px 16px; color: #5c6680; font-size: 10px; }
.message { margin: 0 18px 16px; padding: 11px 13px; border-radius: 9px; font-size: 12px; }
.error { color: #ffb3c0; background: #3a1e27; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid #8295ed; outline-offset: 3px; }
@media (max-width: 1080px) { .editor-body { grid-template-columns: 1fr; }.preview-panel { position: static; } }
@media (max-width: 720px) { .timeline-toolbar { flex-wrap: wrap; align-items: flex-start; }.edit-actions { order: 3; width: 100%; justify-content: flex-start; }.timeline-layout { grid-template-columns: 92px minmax(0, 1fr); }.top-bar { flex-wrap: wrap; } }
</style>
