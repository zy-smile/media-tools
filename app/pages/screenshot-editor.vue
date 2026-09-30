<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

declare global {
  interface Window {
    EyeDropper?: new () => {
      open: (options?: { signal?: AbortSignal }) => Promise<{ sRGBHex: string }>
    }
  }
}

type Tool = 'crop' | 'rectangle' | 'arrow' | 'text' | 'pen'
type Point = { x: number; y: number }
type PickedColor = { hex: string; rgb: string; hsl: string }
type Annotation = {
  tool: Tool
  start: Point
  end: Point
  points?: Point[]
  text?: string
  color: string
  width: number
}

const canvas = ref<HTMLCanvasElement | null>(null)
const captured = ref(false)
const capturing = ref(false)
const activeTool = ref<Tool>('crop')
const color = ref('#ef4444')
const lineWidth = ref(4)
const annotations = ref<Annotation[]>([])
const redoStack = ref<Annotation[]>([])
const draft = ref<Annotation | null>(null)
const cropSelection = ref<{ start: Point; end: Point } | null>(null)
const isSelectingCrop = ref(false)
const errorMessage = ref('')
const notice = ref('')
const eyeDropperSupported = ref(false)
const pickingColor = ref(false)
const pickedColor = ref<PickedColor | null>(null)
const colorHistory = ref<PickedColor[]>([])
let pickerController: AbortController | null = null
let baseImage: HTMLCanvasElement | null = null

const tools: { value: Tool; label: string; icon: string }[] = [
  { value: 'crop', label: '区域截图', icon: '⌗' },
  { value: 'rectangle', label: '框选', icon: '□' },
  { value: 'arrow', label: '箭头', icon: '↗' },
  { value: 'text', label: '文字', icon: 'T' },
  { value: 'pen', label: '涂鸦', icon: '⌁' },
]

const canUndo = computed(() => annotations.value.length > 0)
const canRedo = computed(() => redoStack.value.length > 0)
const cropRect = computed(() => {
  if (!cropSelection.value) return null
  const { start, end } = cropSelection.value
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
})
const canCrop = computed(() => !!cropRect.value && cropRect.value.width >= 10 && cropRect.value.height >= 10)

function drawArrow(ctx: CanvasRenderingContext2D, start: Point, end: Point, width: number) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const headLength = Math.max(14, width * 4)
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  ctx.lineTo(end.x, end.y)
  ctx.moveTo(end.x, end.y)
  ctx.lineTo(end.x - headLength * Math.cos(angle - Math.PI / 6), end.y - headLength * Math.sin(angle - Math.PI / 6))
  ctx.moveTo(end.x, end.y)
  ctx.lineTo(end.x - headLength * Math.cos(angle + Math.PI / 6), end.y - headLength * Math.sin(angle + Math.PI / 6))
  ctx.stroke()
}

function drawAnnotation(ctx: CanvasRenderingContext2D, item: Annotation) {
  ctx.save()
  ctx.strokeStyle = item.color
  ctx.fillStyle = item.color
  ctx.lineWidth = item.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (item.tool === 'rectangle') {
    ctx.strokeRect(item.start.x, item.start.y, item.end.x - item.start.x, item.end.y - item.start.y)
  } else if (item.tool === 'arrow') {
    drawArrow(ctx, item.start, item.end, item.width)
  } else if (item.tool === 'pen' && item.points?.length) {
    ctx.beginPath()
    ctx.moveTo(item.points[0].x, item.points[0].y)
    item.points.slice(1).forEach(point => ctx.lineTo(point.x, point.y))
    ctx.stroke()
  } else if (item.tool === 'text' && item.text) {
    const fontSize = Math.max(20, item.width * 6)
    ctx.font = `600 ${fontSize}px "Microsoft YaHei", sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillText(item.text, item.start.x, item.start.y)
  }
  ctx.restore()
}

function renderCanvas() {
  const target = canvas.value
  if (!target || !baseImage) return
  const ctx = target.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, target.width, target.height)
  ctx.drawImage(baseImage, 0, 0)
  annotations.value.forEach(item => drawAnnotation(ctx, item))
  if (draft.value) drawAnnotation(ctx, draft.value)
  if (cropRect.value) {
    const area = cropRect.value
    ctx.save()
    ctx.fillStyle = 'rgba(10, 18, 32, .55)'
    ctx.fillRect(0, 0, target.width, area.y)
    ctx.fillRect(0, area.y, area.x, area.height)
    ctx.fillRect(area.x + area.width, area.y, target.width - area.x - area.width, area.height)
    ctx.fillRect(0, area.y + area.height, target.width, target.height - area.y - area.height)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.setLineDash([8, 5])
    ctx.strokeRect(area.x, area.y, area.width, area.height)
    ctx.restore()
  }
}

async function takeScreenshot() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    errorMessage.value = '当前浏览器不支持屏幕截图，请使用最新版桌面浏览器。'
    return
  }
  capturing.value = true
  errorMessage.value = ''
  notice.value = ''
  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('无法读取共享画面'))
    })
    await video.play()
    await new Promise(resolve => requestAnimationFrame(resolve))

    const maxWidth = 1920
    const scale = Math.min(1, maxWidth / video.videoWidth)
    baseImage = document.createElement('canvas')
    baseImage.width = Math.round(video.videoWidth * scale)
    baseImage.height = Math.round(video.videoHeight * scale)
    baseImage.getContext('2d')?.drawImage(video, 0, 0, baseImage.width, baseImage.height)

    captured.value = true
    activeTool.value = 'crop'
    annotations.value = []
    redoStack.value = []
    cropSelection.value = null
    await nextTick()
    if (canvas.value) {
      canvas.value.width = baseImage.width
      canvas.value.height = baseImage.height
    }
    renderCanvas()
  } catch (error: any) {
    if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') {
      errorMessage.value = error?.message || '截图失败，请重新尝试。'
    }
  } finally {
    stream?.getTracks().forEach(track => track.stop())
    capturing.value = false
  }
}

function canvasPoint(event: PointerEvent): Point {
  const target = canvas.value!
  const rect = target.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(target.width, (event.clientX - rect.left) * target.width / rect.width)),
    y: Math.max(0, Math.min(target.height, (event.clientY - rect.top) * target.height / rect.height)),
  }
}

function selectTool(tool: Tool) {
  if (activeTool.value === 'crop' && tool !== 'crop') cancelCrop()
  activeTool.value = tool
}

function onPointerDown(event: PointerEvent) {
  if (!canvas.value) return
  const point = canvasPoint(event)
  if (activeTool.value === 'crop') {
    canvas.value.setPointerCapture(event.pointerId)
    cropSelection.value = { start: point, end: point }
    isSelectingCrop.value = true
    renderCanvas()
    return
  }
  if (activeTool.value === 'text') {
    const text = window.prompt('请输入要添加的文字：')?.trim()
    if (text) {
      annotations.value.push({ tool: 'text', start: point, end: point, text, color: color.value, width: lineWidth.value })
      redoStack.value = []
      renderCanvas()
    }
    return
  }
  canvas.value.setPointerCapture(event.pointerId)
  draft.value = {
    tool: activeTool.value,
    start: point,
    end: point,
    points: activeTool.value === 'pen' ? [point] : undefined,
    color: color.value,
    width: lineWidth.value,
  }
}

function onPointerMove(event: PointerEvent) {
  if (activeTool.value === 'crop' && isSelectingCrop.value && cropSelection.value) {
    cropSelection.value.end = canvasPoint(event)
    renderCanvas()
    return
  }
  if (!draft.value) return
  const point = canvasPoint(event)
  draft.value.end = point
  if (draft.value.tool === 'pen') draft.value.points?.push(point)
  renderCanvas()
}

function onPointerUp(event: PointerEvent) {
  if (activeTool.value === 'crop' && isSelectingCrop.value && cropSelection.value) {
    cropSelection.value.end = canvasPoint(event)
    isSelectingCrop.value = false
    canvas.value?.releasePointerCapture(event.pointerId)
    renderCanvas()
    return
  }
  if (!draft.value) return
  const point = canvasPoint(event)
  draft.value.end = point
  annotations.value.push(draft.value)
  draft.value = null
  redoStack.value = []
  canvas.value?.releasePointerCapture(event.pointerId)
  renderCanvas()
}

function cancelCrop() {
  cropSelection.value = null
  isSelectingCrop.value = false
  renderCanvas()
}

function applyCrop() {
  const area = cropRect.value
  if (!area || !canCrop.value || !baseImage) return
  const x = Math.round(area.x)
  const y = Math.round(area.y)
  const width = Math.round(area.width)
  const height = Math.round(area.height)
  const cropped = document.createElement('canvas')
  cropped.width = width
  cropped.height = height
  const ctx = cropped.getContext('2d')
  if (!ctx) return
  ctx.save()
  ctx.translate(-x, -y)
  ctx.drawImage(baseImage, 0, 0)
  annotations.value.forEach(item => drawAnnotation(ctx, item))
  ctx.restore()
  baseImage = cropped
  annotations.value = []
  redoStack.value = []
  cropSelection.value = null
  activeTool.value = 'rectangle'
  if (canvas.value) {
    canvas.value.width = width
    canvas.value.height = height
  }
  notice.value = `已截取 ${width} × ${height} 像素区域。`
  renderCanvas()
}

function undo() {
  const item = annotations.value.pop()
  if (item) redoStack.value.push(item)
  renderCanvas()
}

function redo() {
  const item = redoStack.value.pop()
  if (item) annotations.value.push(item)
  renderCanvas()
}

function clearAnnotations() {
  if (!annotations.value.length) return
  redoStack.value.push(...annotations.value.reverse())
  annotations.value = []
  renderCanvas()
}

function canvasBlob() {
  return new Promise<Blob>((resolve, reject) => {
    if (!baseImage) {
      reject(new Error('图片生成失败'))
      return
    }
    const output = document.createElement('canvas')
    output.width = baseImage.width
    output.height = baseImage.height
    const ctx = output.getContext('2d')
    if (!ctx) {
      reject(new Error('图片生成失败'))
      return
    }
    ctx.drawImage(baseImage, 0, 0)
    annotations.value.forEach(item => drawAnnotation(ctx, item))
    output.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片生成失败')), 'image/png')
  })
}

async function downloadImage() {
  const blob = await canvasBlob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
  link.click()
  URL.revokeObjectURL(url)
}

async function copyImage() {
  try {
    const blob = await canvasBlob()
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    notice.value = '图片已复制到剪贴板。'
  } catch {
    errorMessage.value = '复制失败，请检查浏览器剪贴板权限，或直接下载图片。'
  }
}

function parseColor(hex: string): PickedColor {
  const normalized = hex.toUpperCase()
  const red = Number.parseInt(normalized.slice(1, 3), 16)
  const green = Number.parseInt(normalized.slice(3, 5), 16)
  const blue = Number.parseInt(normalized.slice(5, 7), 16)
  const r = red / 255
  const g = green / 255
  const b = blue / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 2
  let hue = 0
  let saturation = 0
  if (max !== min) {
    const delta = max - min
    saturation = lightness > .5 ? delta / (2 - max - min) : delta / (max + min)
    if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0)
    else if (max === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
    hue /= 6
  }
  return {
    hex: normalized,
    rgb: `rgb(${red}, ${green}, ${blue})`,
    hsl: `hsl(${Math.round(hue * 360)}, ${Math.round(saturation * 100)}%, ${Math.round(lightness * 100)}%)`,
  }
}

async function pickScreenColor() {
  if (!window.EyeDropper || pickingColor.value) return
  pickingColor.value = true
  errorMessage.value = ''
  pickerController = new AbortController()
  try {
    const result = await new window.EyeDropper().open({ signal: pickerController.signal })
    const nextColor = parseColor(result.sRGBHex)
    pickedColor.value = nextColor
    color.value = nextColor.hex
    colorHistory.value = [nextColor, ...colorHistory.value.filter(item => item.hex !== nextColor.hex)].slice(0, 10)
    notice.value = `已取色 ${nextColor.hex}，并设为标注颜色。`
  } catch (error: any) {
    if (error?.name !== 'AbortError') errorMessage.value = '屏幕取色失败，请重新尝试。'
  } finally {
    pickerController = null
    pickingColor.value = false
  }
}

async function copyColor(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    notice.value = `已复制 ${value}`
  } catch {
    errorMessage.value = '复制色值失败，请检查浏览器剪贴板权限。'
  }
}

async function selectPickedColor(item: PickedColor) {
  pickedColor.value = item
  color.value = item.hex
  await copyColor(item.hex)
}

function handleShortcut(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || !captured.value) return
  if (event.key.toLowerCase() === 'z') {
    event.preventDefault()
    event.shiftKey ? redo() : undo()
  } else if (event.key.toLowerCase() === 'y') {
    event.preventDefault()
    redo()
  }
}

onMounted(() => {
  eyeDropperSupported.value = !!window.EyeDropper && window.isSecureContext
  window.addEventListener('keydown', handleShortcut)
})
onBeforeUnmount(() => {
  pickerController?.abort()
  window.removeEventListener('keydown', handleShortcut)
})
</script>

<template>
  <main class="editor-page">
    <header class="page-header">
      <NuxtLink to="/" class="back-link">← 返回首页</NuxtLink>
      <p class="eyebrow">SCREENSHOT STUDIO</p>
      <h1>截图与标注</h1>
      <p>截取屏幕、窗口或标签页，再添加框选、箭头、文字与涂鸦。</p>
    </header>

    <section v-if="!captured" class="capture-card">
      <div class="capture-icon" aria-hidden="true">⌗</div>
      <h2>开始截取画面</h2>
      <p>点击后，在浏览器弹窗中选择要截取的屏幕、窗口或标签页。</p>
      <button class="primary" :disabled="capturing" @click="takeScreenshot">
        {{ capturing ? '正在获取画面…' : '选择截图区域' }}
      </button>
      <p v-if="errorMessage" class="message error" role="alert">{{ errorMessage }}</p>
    </section>

    <template v-else>
      <section class="toolbar" aria-label="截图编辑工具栏">
        <div class="tool-group">
          <button
            v-for="tool in tools"
            :key="tool.value"
            class="tool-button"
            :class="{ active: activeTool === tool.value }"
            :aria-pressed="activeTool === tool.value"
            @click="selectTool(tool.value)"
          >
            <span aria-hidden="true">{{ tool.icon }}</span>{{ tool.label }}
          </button>
          <button
            class="tool-button eye-dropper-button"
            :class="{ active: pickingColor }"
            :disabled="!eyeDropperSupported || pickingColor"
            :title="eyeDropperSupported ? '拾取屏幕任意位置的颜色' : '当前浏览器不支持屏幕取色'"
            @click="pickScreenColor"
          >
            <span aria-hidden="true">⌖</span>{{ pickingColor ? '取色中…' : '屏幕取色' }}
          </button>
        </div>
        <div v-if="activeTool !== 'crop'" class="style-controls">
          <label title="标注颜色"><input v-model="color" type="color"><span>颜色</span></label>
          <label><span>粗细</span><input v-model.number="lineWidth" type="range" min="2" max="12"></label>
        </div>
        <div class="history-controls">
          <button :disabled="!canUndo" title="撤销 (Ctrl+Z)" @click="undo">↶ 撤销</button>
          <button :disabled="!canRedo" title="重做 (Ctrl+Y)" @click="redo">↷ 重做</button>
          <button :disabled="!canUndo" @click="clearAnnotations">清除标注</button>
        </div>
      </section>

      <section v-if="pickedColor" class="picked-color-bar">
        <button class="picked-swatch" :style="{ backgroundColor: pickedColor.hex }" :title="`复制 ${pickedColor.hex}`" @click="copyColor(pickedColor.hex)" />
        <div class="picked-values">
          <button @click="copyColor(pickedColor.hex)"><small>HEX</small><strong>{{ pickedColor.hex }}</strong></button>
          <button @click="copyColor(pickedColor.rgb)"><small>RGB</small><strong>{{ pickedColor.rgb }}</strong></button>
          <button @click="copyColor(pickedColor.hsl)"><small>HSL</small><strong>{{ pickedColor.hsl }}</strong></button>
        </div>
        <div v-if="colorHistory.length > 1" class="color-history" aria-label="最近取色">
          <button
            v-for="item in colorHistory"
            :key="item.hex"
            :class="{ selected: item.hex === pickedColor.hex }"
            :style="{ backgroundColor: item.hex }"
            :title="`选择并复制 ${item.hex}`"
            @click="selectPickedColor(item)"
          />
        </div>
      </section>

      <section v-if="activeTool === 'crop'" class="crop-bar" role="status">
        <span v-if="cropRect">已选择 {{ Math.round(cropRect.width) }} × {{ Math.round(cropRect.height) }} 像素</span>
        <span v-else>在图片上拖拽，选择需要保留的截图区域</span>
        <div>
          <button :disabled="!cropRect" @click="cancelCrop">取消选择</button>
          <button class="primary" :disabled="!canCrop" @click="applyCrop">确认区域截图</button>
        </div>
      </section>

      <section class="canvas-shell">
        <canvas
          ref="canvas"
          :class="`tool-${activeTool}`"
          aria-label="截图编辑画布"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
      </section>

      <div class="footer-actions">
        <button @click="takeScreenshot">重新截图</button>
        <span class="action-spacer" />
        <span v-if="notice" class="notice" role="status">{{ notice }}</span>
        <button @click="copyImage">复制图片</button>
        <button class="primary" @click="downloadImage">下载 PNG</button>
      </div>
      <p v-if="errorMessage" class="message error" role="alert">{{ errorMessage }}</p>
    </template>
  </main>
</template>

<style scoped>
:global(*) { box-sizing: border-box; }
:global(body) { margin: 0; background: #f4f6fa; }
button, input { font: inherit; }
.editor-page { width: min(1280px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0 48px; color: #172338; font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif; }
.page-header { margin-bottom: 24px; }
.back-link { display: inline-block; margin-bottom: 28px; color: #56647a; font-size: 13px; text-decoration: none; }
.back-link:hover { color: #4058c4; }
.eyebrow { margin: 0; color: #5268c9; font-size: 11px; font-weight: 800; letter-spacing: .18em; }
h1 { margin: 8px 0; font-size: clamp(32px, 5vw, 48px); letter-spacing: -.035em; }
.page-header > p:last-child { margin: 0; color: #68748a; }
.capture-card { min-height: 430px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px; border: 1px dashed #bcc6d8; border-radius: 20px; background: #fff; text-align: center; box-shadow: 0 12px 40px #263b6609; }
.capture-icon { width: 72px; height: 72px; display: grid; place-items: center; border-radius: 20px; color: #5268c9; background: #edf0ff; font-size: 36px; }
.capture-card h2 { margin: 20px 0 8px; }
.capture-card > p { max-width: 460px; margin: 0 0 24px; color: #68748a; line-height: 1.7; }
button { min-height: 40px; padding: 0 14px; border: 1px solid #d6dce8; border-radius: 9px; color: #334057; background: #fff; cursor: pointer; transition: .18s ease; }
button:hover:not(:disabled) { border-color: #aab6d2; background: #f7f8fc; }
button:disabled { opacity: .45; cursor: not-allowed; }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 3px solid #8295ed; outline-offset: 3px; }
button.primary { border-color: #4d63d1; color: #fff; background: #4d63d1; font-weight: 700; }
button.primary:hover:not(:disabled) { border-color: #4055be; background: #4055be; }
.toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px; border: 1px solid #dde2ec; border-radius: 14px; background: #fff; box-shadow: 0 8px 28px #263b6609; }
.tool-group, .history-controls, .style-controls { display: flex; align-items: center; gap: 7px; }
.tool-button { display: inline-flex; align-items: center; gap: 7px; }
.tool-button > span { font-size: 18px; font-weight: 700; }
.tool-button.active { border-color: #8ea0ed; color: #4058c4; background: #edf0ff; }
.eye-dropper-button { border-color: #b9c4ed; }
.style-controls { padding: 0 12px; border-inline: 1px solid #e5e8ef; }
.style-controls label { display: flex; align-items: center; gap: 7px; color: #68748a; font-size: 12px; }
input[type="color"] { width: 32px; height: 32px; padding: 2px; border: 1px solid #d6dce8; border-radius: 7px; background: white; cursor: pointer; }
input[type="range"] { width: 82px; accent-color: #5268c9; }
.history-controls { margin-left: auto; }
.canvas-shell { margin-top: 16px; overflow: auto; padding: 12px; border: 1px solid #dce2ec; border-radius: 16px; background: #dfe3ea; box-shadow: inset 0 1px 4px #29364f18; }
canvas { display: block; width: 100%; height: auto; max-height: 72vh; margin: auto; object-fit: contain; background: #fff; box-shadow: 0 4px 18px #17233822; touch-action: none; }
canvas.tool-rectangle { cursor: crosshair; }
canvas.tool-crop { cursor: crosshair; }
canvas.tool-arrow { cursor: crosshair; }
canvas.tool-text { cursor: text; }
canvas.tool-pen { cursor: crosshair; }
.footer-actions { display: flex; align-items: center; gap: 9px; margin-top: 16px; }
.crop-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 12px; padding: 11px 14px; border: 1px solid #cdd6f6; border-radius: 11px; color: #405175; background: #f0f3ff; font-size: 13px; }
.crop-bar > div { display: flex; gap: 8px; }
.picked-color-bar { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 10px 12px; border: 1px solid #dce2ec; border-radius: 12px; background: #fff; }
.picked-swatch { width: 46px; height: 46px; min-height: 46px; flex: none; padding: 0; border: 3px solid #fff; border-radius: 11px; box-shadow: 0 0 0 1px #ccd3e0; }
.picked-values { display: flex; align-items: center; gap: 6px; }
.picked-values button { min-height: 38px; display: grid; gap: 2px; padding: 4px 10px; text-align: left; }
.picked-values small { color: #8490a3; font-size: 9px; font-weight: 800; letter-spacing: .08em; }
.picked-values strong { font-size: 11px; }
.color-history { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.color-history button { width: 28px; height: 28px; min-height: 28px; padding: 0; border: 2px solid #fff; border-radius: 7px; box-shadow: 0 0 0 1px #ccd3e0; }
.color-history button.selected { box-shadow: 0 0 0 2px #5268c9; }
.action-spacer { flex: 1; }
.notice { color: #34724a; font-size: 13px; }
.message { padding: 11px 14px; border-radius: 9px; font-size: 13px; }
.error { color: #a32338; background: #fff0f2; }

@media (max-width: 820px) {
  .editor-page { width: min(100% - 20px, 1280px); padding-top: 22px; }
  .toolbar { align-items: stretch; }
  .tool-group { display: grid; grid-template-columns: repeat(3, 1fr); width: 100%; }
  .tool-button { justify-content: center; padding: 0 8px; }
  .style-controls { flex: 1; padding-left: 0; border-left: 0; }
  .history-controls { margin-left: 0; }
  .footer-actions { flex-wrap: wrap; }
  .action-spacer { display: none; }
  .notice { width: 100%; order: 3; }
  .crop-bar { align-items: stretch; flex-direction: column; }
  .crop-bar > div { display: grid; grid-template-columns: 1fr 1fr; }
  .picked-color-bar { align-items: flex-start; flex-wrap: wrap; }
  .picked-values { width: calc(100% - 60px); flex-wrap: wrap; }
  .picked-values button { flex: 1; }
  .color-history { width: 100%; margin-left: 0; }
}
</style>
