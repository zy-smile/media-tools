<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

type InputMode = 'file' | 'code'
type BackgroundOption = 'transparent' | 'white' | 'black' | 'custom'
type IconColorOption = 'original' | 'white' | 'black' | 'custom'
interface OriginalSize { width: number; height: number }
interface ConvertResult { url: string; blob: Blob; width: number; height: number }

const MAX_SIDE = 8192

const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const mode = ref<InputMode>('file')
const svgText = ref('')
const fileName = ref('')
const originalSize = ref<OriginalSize | null>(null)
const userSetDims = ref(false)

const outputWidth = ref(0)
const outputHeight = ref(0)
const lockRatio = ref(true)
const scale = ref(1)
const background = ref<BackgroundOption>('transparent')
const customColor = ref('#5268c9')
const iconColor = ref<IconColorOption>('original')
const customIconColor = ref('#ef4444')

const converting = ref(false)
const result = ref<ConvertResult | null>(null)
const errorMessage = ref('')
const notice = ref('')
const copied = ref(false)

let runId = 0
let syncing = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let recolorTimer: ReturnType<typeof setTimeout> | null = null

const scaleOptions = [1, 2, 3]
const backgroundOptions: { value: BackgroundOption; label: string }[] = [
  { value: 'transparent', label: '透明' },
  { value: 'white', label: '白色' },
  { value: 'black', label: '黑色' },
  { value: 'custom', label: '自定义' },
]
const iconColorOptions: { value: IconColorOption; label: string }[] = [
  { value: 'original', label: '原色' },
  { value: 'white', label: '白色' },
  { value: 'black', label: '黑色' },
  { value: 'custom', label: '自定义' },
]

const backgroundColor = computed(() => {
  if (background.value === 'transparent') return ''
  if (background.value === 'white') return '#ffffff'
  if (background.value === 'black') return '#000000'
  return customColor.value
})

// 空字符串表示保留 SVG 原色
const iconColorValue = computed(() => {
  if (iconColor.value === 'original') return ''
  if (iconColor.value === 'white') return '#ffffff'
  if (iconColor.value === 'black') return '#000000'
  return customIconColor.value
})

const hasInput = computed(() => svgText.value.trim().length > 0)
const dimsValid = computed(() => outputWidth.value > 0 && outputHeight.value > 0)
const canConvert = computed(() => hasInput.value && dimsValid.value && !converting.value)

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5268c9"/>
      <stop offset="1" stop-color="#7fe0a0"/>
    </linearGradient>
  </defs>
  <rect width="400" height="300" rx="24" fill="url(#grad)"/>
  <circle cx="200" cy="120" r="60" fill="#ffffff" opacity=".92"/>
  <path d="M200 78l15 31 34 5-25 24 6 33-30-16-30 16 6-33-25-24 34-5z" fill="#f7c948"/>
</svg>`

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

function parseSvg(text: string): Element {
  const parser = new DOMParser()
  const doc = parser.parseFromString(text, 'image/svg+xml')
  const root = doc.documentElement
  if (root?.tagName.toLowerCase() !== 'svg' || root.getElementsByTagName('parsererror').length) {
    throw new Error('SVG 代码无法解析,请检查格式是否正确。')
  }
  return root
}

function extractSize(root: Element): OriginalSize {
  const number = (value: string | null) => {
    if (!value) return 0
    const trimmed = value.trim()
    // 相对单位(如 %、em 等)不能直接当作像素,交给 viewBox 兜底
    if (!/^[\d.]+(px)?$/.test(trimmed)) return 0
    return Number.parseFloat(trimmed)
  }
  const width = number(root.getAttribute('width'))
  const height = number(root.getAttribute('height'))
  const viewBox = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
  if (width && height) return { width, height }
  if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) return { width: viewBox[2], height: viewBox[3] }
  throw new Error('未找到 SVG 尺寸,请在根元素上补充 width/height 或 viewBox 属性。')
}

function detectExternalRefs(root: Element): boolean {
  const isExternalHref = (el: Element) => {
    const href = el.getAttribute('href') || el.getAttribute('xlink:href') || ''
    if (!href || href.startsWith('#') || href.startsWith('data:')) return false
    return true
  }
  if (Array.from(root.querySelectorAll('image, use')).some(isExternalHref)) return true
  const externalUrl = (raw: string) => {
    const value = raw.trim()
    return !!(value && !value.startsWith('#') && !value.startsWith('data:'))
  }
  const styleExternal = Array.from(root.querySelectorAll('style')).some(el => {
    const css = el.textContent || ''
    if (/@import(\s+|url)/.test(css)) return true
    const urls: string[] = []
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g
    let match: RegExpExecArray | null
    while ((match = re.exec(css)) !== null) urls.push(match[2])
    return urls.some(externalUrl)
  })
  return styleExternal
}

function applySize(original: OriginalSize, nextScale: number) {
  syncing = true
  outputWidth.value = Math.round(original.width * nextScale)
  outputHeight.value = Math.round(original.height * nextScale)
  syncing = false
}

function loadSvg(text: string, sourceName = '') {
  errorMessage.value = ''
  notice.value = ''
  copied.value = false
  try {
    const root = parseSvg(text)
    const size = extractSize(root)
    originalSize.value = size
    if (detectExternalRefs(root)) {
      notice.value = '检测到外部资源引用,可能因浏览器安全策略无法完整渲染,建议先内联图片资源。'
    }
    if (!userSetDims.value) applySize(size, scale.value)
    svgText.value = text
    fileName.value = sourceName
  } catch (error: any) {
    originalSize.value = null
    svgText.value = text
    fileName.value = sourceName
    errorMessage.value = error?.message || '读取 SVG 失败。'
  }
}

async function selectFile(file?: File) {
  if (!file) return
  if (file.type && !file.type.includes('svg') && !file.name.toLowerCase().endsWith('.svg')) {
    errorMessage.value = '请选择 .svg 格式的矢量文件。'
    return
  }
  try {
    const text = await file.text()
    userSetDims.value = false
    loadSvg(text, file.name)
  } catch {
    errorMessage.value = '读取文件内容失败,请重试。'
  }
}

function onDrop(event: DragEvent) {
  dragging.value = false
  selectFile(event.dataTransfer?.files?.[0])
}

function chooseFile() {
  if (mode.value !== 'file') mode.value = 'file'
  fileInput.value?.click()
}

function fillSample() {
  userSetDims.value = false
  loadSvg(SAMPLE_SVG, '示例')
}

watch(mode, () => {
  if (mode.value === 'file') return
  errorMessage.value = ''
})

watch(svgText, (text) => {
  if (mode.value !== 'code' || !text.trim()) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    const previousUserSet = userSetDims.value
    userSetDims.value = false
    loadSvg(text)
    userSetDims.value = previousUserSet
  }, 350)
})

watch(outputWidth, (value) => {
  if (syncing || !lockRatio.value || !originalSize.value || !value || value <= 0) return
  const ratio = originalSize.value.height / originalSize.value.width
  userSetDims.value = true
  syncing = true
  outputHeight.value = Math.max(1, Math.round(value * ratio))
  syncing = false
})
watch(outputHeight, (value) => {
  if (syncing || !lockRatio.value || !originalSize.value || !value || value <= 0) return
  const ratio = originalSize.value.width / originalSize.value.height
  userSetDims.value = true
  syncing = true
  outputWidth.value = Math.max(1, Math.round(value * ratio))
  syncing = false
})

function applyScale(next: number) {
  if (!originalSize.value) return
  scale.value = next
  userSetDims.value = false
  applySize(originalSize.value, next)
}

// 修改图标 / 背景颜色后,若已有结果则自动重新转换(防抖)
watch([iconColor, customIconColor, background, customColor], () => {
  if (!result.value || !canConvert.value) return
  if (recolorTimer) clearTimeout(recolorTimer)
  recolorTimer = setTimeout(() => {
    recolorTimer = null
    void convert()
  }, 250)
})

function applyIconColor(root: Element, color: string) {
  if (!color) return
  // 保留: 透明/继承/渐变引用/none —— 只替换不透明的纯色填充与描边
  const keep = (value: string | null) =>
    !value || /^(none|inherit|currentcolor|transparent|url\()/i.test(value.trim())
  const targets = [root, ...Array.from(root.querySelectorAll('*'))]
  for (const el of targets) {
    const fill = el.getAttribute('fill')
    if (fill !== null && !keep(fill)) el.setAttribute('fill', color)
    const stroke = el.getAttribute('stroke')
    if (stroke !== null && !keep(stroke)) el.setAttribute('stroke', color)
    const style = el.getAttribute('style')
    if (style && /(^|;|\s)(fill|stroke)\s*:/i.test(style)) {
      el.setAttribute('style', style.replace(
        /(^|;|\s)(fill|stroke)(\s*:\s*)([^;]+)/gi,
        (match, sep, prop, colon, value) => (keep(value) ? match : `${sep}${prop}${colon}${color}`),
      ))
    }
  }
  // 未显式声明 fill 的图形继承根节点颜色(覆盖默认黑色图标)
  if (root.getAttribute('fill') === null) root.setAttribute('fill', color)
  // 令 fill="currentColor" 的引用取到目标颜色
  root.setAttribute('color', color)
  // <style> 中的类选择器规则
  for (const styleEl of Array.from(root.querySelectorAll('style'))) {
    const css = styleEl.textContent || ''
    styleEl.textContent = css.replace(
      /(^|[{;\s])((?:fill|stroke)\s*:\s*)([^;}]+)/gi,
      (match, sep, prop, value) => (keep(value) ? match : `${sep}${prop}${color}`),
    )
  }
}

function normalizeSvg(text: string, width: number, height: number): string {
  const root = parseSvg(text)
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  applyIconColor(root, iconColorValue.value)
  return new XMLSerializer().serializeToString(root)
}

function loadSvgImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('SVG 渲染失败,请检查代码内容。'))
    image.src = url
  })
}

function releaseResult() {
  if (result.value) {
    URL.revokeObjectURL(result.value.url)
    result.value = null
  }
}

async function convert() {
  if (!canConvert.value) return
  const token = ++runId
  errorMessage.value = ''
  notice.value = ''
  copied.value = false
  converting.value = true

  const width = Math.round(outputWidth.value)
  const height = Math.round(outputHeight.value)
  if (width > MAX_SIDE || height > MAX_SIDE) {
    errorMessage.value = `输出尺寸不能超过 ${MAX_SIDE} × ${MAX_SIDE} 像素,请调小宽度或高度。`
    converting.value = false
    return
  }

  try {
    const normalized = normalizeSvg(svgText.value, width, height)
    const blob = new Blob([normalized], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)

    const image = await loadSvgImage(url).catch(error => { URL.revokeObjectURL(url); throw error })
    if (token !== runId) { URL.revokeObjectURL(url); return }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前浏览器无法创建画布,请更换浏览器后再试。')

    if (backgroundColor.value) {
      ctx.fillStyle = backgroundColor.value
      ctx.fillRect(0, 0, width, height)
    }
    ctx.drawImage(image, 0, 0, width, height)
    URL.revokeObjectURL(url)

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG 生成失败,请重试。')), 'image/png')
    })
    if (token !== runId) return

    releaseResult()
    result.value = {
      url: URL.createObjectURL(pngBlob),
      blob: pngBlob,
      width,
      height,
    }
  } catch (error: any) {
    if (token === runId) errorMessage.value = error?.message || '转换失败,请检查 SVG 内容。'
  } finally {
    if (token === runId) converting.value = false
  }
}

function downloadPng() {
  if (!result.value) return
  const link = document.createElement('a')
  link.href = result.value.url
  link.download = `svg-to-png-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
  link.click()
}

async function copyPng() {
  if (!result.value) return
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': result.value.blob })])
    copied.value = true
    notice.value = 'PNG 已复制到剪贴板。'
  } catch {
    errorMessage.value = '复制失败,请检查浏览器剪贴板权限,或直接下载图片。'
  }
}

function reset() {
  runId++
  if (debounceTimer) clearTimeout(debounceTimer)
  if (recolorTimer) clearTimeout(recolorTimer)
  releaseResult()
  svgText.value = ''
  fileName.value = ''
  originalSize.value = null
  userSetDims.value = false
  outputWidth.value = 0
  outputHeight.value = 0
  errorMessage.value = ''
  notice.value = ''
  copied.value = false
  if (fileInput.value) fileInput.value.value = ''
}

onBeforeUnmount(() => {
  runId++
  if (debounceTimer) clearTimeout(debounceTimer)
  if (recolorTimer) clearTimeout(recolorTimer)
  releaseResult()
})
</script>

<template>
  <main class="editor-page">
    <header class="page-header">
      <NuxtLink to="/" class="back-link">← 返回首页</NuxtLink>
      <p class="eyebrow">SVG TO PNG</p>
      <h1>SVG 转 PNG</h1>
      <p>上传或粘贴 SVG 矢量图,调整输出尺寸、图标颜色与背景色,导出为高清 PNG 图片。</p>
    </header>

    <div class="workspace">
      <section class="card input-card">
        <div class="card-heading">
          <span class="step-number">01</span>
          <div>
            <strong>输入 SVG</strong>
            <small>支持文件或直接粘贴代码</small>
          </div>
        </div>

        <div class="segmented" role="tablist" aria-label="输入方式">
          <button :class="{ active: mode === 'file' }" role="tab" :aria-selected="mode === 'file'" @click="mode = 'file'">上传文件</button>
          <button :class="{ active: mode === 'code' }" role="tab" :aria-selected="mode === 'code'" @click="mode = 'code'">粘贴代码</button>
        </div>

        <template v-if="mode === 'file'">
          <input ref="fileInput" type="file" accept=".svg,image/svg+xml" hidden @change="selectFile(($event.target as HTMLInputElement).files?.[0])">
          <div
            v-if="!fileName"
            class="dropzone"
            :class="{ dragging }"
            role="button"
            tabindex="0"
            @click="chooseFile"
            @keydown.enter="chooseFile"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="onDrop"
          >
            <span class="file-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></svg>
            </span>
            <strong>拖放 SVG 文件到这里</strong>
            <span>或者 <u>浏览本地文件</u></span>
          </div>
          <div v-else class="file-chip">
            <span class="file-icon small">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l4 4v16H6zM14 2v5h5" /></svg>
            </span>
            <span class="file-name" :title="fileName">{{ fileName }}</span>
            <button type="button" title="移除文件" @click="reset">×</button>
          </div>
        </template>

        <template v-else>
          <textarea
            v-model="svgText"
            class="code-area"
            spellcheck="false"
            rows="9"
            placeholder="在此粘贴 SVG 代码,如 <svg xmlns=… width=… height=… viewBox=…>…</svg>"
            aria-label="SVG 代码输入框"
          />
          <div class="code-actions">
            <button v-if="!svgText.trim()" type="button" @click="fillSample">填入示例</button>
            <span v-if="originalSize" class="size-hint">识别尺寸 {{ Math.round(originalSize.width) }} × {{ Math.round(originalSize.height) }}</span>
          </div>
        </template>
      </section>

      <section class="card settings-card">
        <div class="card-heading">
          <span class="step-number">02</span>
          <div>
            <strong>输出设置</strong>
            <small>像素尺寸、图标与背景颜色</small>
          </div>
        </div>

        <div class="field">
          <label class="field-label">输出尺寸</label>
          <div class="dim-row">
            <label class="dim-input">
              <span>宽</span>
              <input v-model.number="outputWidth" type="number" min="1" :max="MAX_SIDE" :disabled="!originalSize">
            </label>
            <span class="dim-times">×</span>
            <label class="dim-input">
              <span>高</span>
              <input v-model.number="outputHeight" type="number" min="1" :max="MAX_SIDE" :disabled="!originalSize">
            </label>
            <label class="check-label" :class="{ disabled: !originalSize }">
              <input v-model="lockRatio" type="checkbox" :disabled="!originalSize">
              <span>锁定宽高比</span>
            </label>
          </div>
        </div>

        <div class="field">
          <label class="field-label">快捷倍率</label>
          <div class="scale-row">
            <button
              v-for="option in scaleOptions"
              :key="option"
              type="button"
              class="scale-button"
              :class="{ active: scale === option && !userSetDims }"
              :disabled="!originalSize"
              @click="applyScale(option)"
            >
              {{ option }}×
            </button>
            <span v-if="!originalSize" class="size-hint">载入 SVG 后可快速放大</span>
          </div>
        </div>

        <div class="field">
          <label class="field-label">图标颜色</label>
          <div class="bg-row">
            <button
              v-for="option in iconColorOptions"
              :key="option.value"
              type="button"
              class="bg-button"
              :class="{ active: iconColor === option.value }"
              @click="iconColor = option.value"
            >
              <span v-if="option.value === 'original'" class="bg-swatch original" aria-hidden="true" />
              <span v-else class="bg-swatch" :style="{ backgroundColor: option.value === 'custom' ? customIconColor : option.value }" />
              {{ option.label }}
            </button>
            <label v-if="iconColor === 'custom'" class="custom-color" title="选择自定义图标颜色">
              <input v-model="customIconColor" type="color">
            </label>
            <code v-if="iconColor === 'custom'" class="color-hint">{{ customIconColor }}</code>
          </div>
          <p class="field-note">原色保留 SVG 自带颜色;设置后统一替换图标中不透明的纯色填充与描边(渐变、none 不受影响)。</p>
        </div>

        <div class="field">
          <label class="field-label">背景色</label>
          <div class="bg-row">
            <button
              v-for="option in backgroundOptions"
              :key="option.value"
              type="button"
              class="bg-button"
              :class="{ active: background === option.value }"
              @click="background = option.value"
            >
              <span v-if="option.value !== 'transparent'" class="bg-swatch" :style="{ backgroundColor: option.value === 'custom' ? customColor : option.value }" />
              <span v-else class="bg-swatch transparent" aria-hidden="true" />
              {{ option.label }}
            </button>
            <label v-if="background === 'custom'" class="custom-color" title="选择自定义背景颜色">
              <input v-model="customColor" type="color">
            </label>
            <code v-if="background === 'custom'" class="color-hint">{{ customColor }}</code>
          </div>
        </div>

        <button class="convert-button" type="button" :disabled="!canConvert" @click="convert">
          <svg v-if="!converting" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" /></svg>
          <svg v-else class="spinner" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 1-9 9" /></svg>
          {{ converting ? '正在转换…' : '转换为 PNG' }}
        </button>

        <p v-if="errorMessage" class="message error" role="alert">{{ errorMessage }}</p>
        <p v-if="notice" class="message notice" role="status">{{ notice }}</p>
      </section>

      <section class="card preview-card">
        <div class="card-heading">
          <span class="step-number">03</span>
          <div>
            <strong>预览与导出</strong>
            <small>转换结果</small>
          </div>
        </div>

        <div v-if="!result" class="preview-empty">
          <span class="preview-icon" aria-hidden="true">⇄</span>
          <p>转换后,PNG 结果会显示在这里。</p>
        </div>

        <template v-else>
          <div class="preview-canvas">
            <img :src="result.url" :alt="`转换后的 PNG,尺寸 ${result.width} × ${result.height}`">
          </div>
          <div class="result-meta">
            <span>尺寸 {{ result.width }} × {{ result.height }} px</span>
            <span>大小 {{ formatBytes(result.blob.size) }}</span>
          </div>
          <div class="result-actions">
            <button class="primary" type="button" @click="downloadPng">下载 PNG</button>
            <button v-if="result" type="button" @click="copyPng">{{ copied ? '已复制 ✓' : '复制图片' }}</button>
            <button type="button" @click="reset">重新开始</button>
          </div>
        </template>
      </section>
    </div>
  </main>
</template>

<style scoped>
:global(*) { box-sizing: border-box; }
:global(body) { margin: 0; background: #f4f6fa; }
button, input, textarea { font: inherit; }
.editor-page { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0 48px; color: #172338; font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif; }
.page-header { margin-bottom: 24px; }
.back-link { display: inline-block; margin-bottom: 28px; color: #56647a; font-size: 13px; text-decoration: none; }
.back-link:hover { color: #4058c4; }
.eyebrow { margin: 0; color: #5268c9; font-size: 11px; font-weight: 800; letter-spacing: .18em; }
h1 { margin: 8px 0; font-size: clamp(32px, 5vw, 48px); letter-spacing: -.035em; }
.page-header > p:last-child { margin: 0; color: #68748a; }

.workspace { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 16px; align-items: start; }
.card { padding: 20px; border: 1px solid #dde2ec; border-radius: 16px; background: #fff; box-shadow: 0 8px 28px #263b6609; }
.card-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.card-heading > div { display: grid; gap: 3px; text-align: left; }
.card-heading strong { font-size: 15px; }
.card-heading small { color: #8490a3; font-size: 11px; }
.step-number { width: 34px; height: 34px; flex: none; display: grid; place-items: center; border-radius: 10px; color: #5268c9; background: #edf0ff; font-size: 12px; font-weight: 800; }

button { min-height: 38px; padding: 0 14px; border: 1px solid #d6dce8; border-radius: 9px; color: #334057; background: #fff; cursor: pointer; transition: .18s ease; }
button:hover:not(:disabled) { border-color: #aab6d2; background: #f7f8fc; }
button:disabled { opacity: .45; cursor: not-allowed; }
button:focus-visible, input:focus-visible, textarea:focus-visible, a:focus-visible { outline: 3px solid #8295ed; outline-offset: 3px; }

.segmented { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; border: 1px solid #dde2ec; border-radius: 11px; background: #f4f6fa; }
.segmented button { border: 0; border-radius: 8px; background: transparent; font-weight: 700; font-size: 13px; }
.segmented button.active { color: #4058c4; background: #fff; box-shadow: 0 1px 4px #263b6614; }

.dropzone { min-height: 200px; margin-top: 14px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; border: 1.5px dashed #b7c2d8; border-radius: 13px; background: #f8f9fc; color: #68748a; cursor: pointer; transition: .2s ease; }
.dropzone:hover, .dropzone.dragging { border-color: #6f84e0; background: #f1f3ff; }
.dropzone strong { color: #334057; font-size: 14px; }
.dropzone span { font-size: 12px; }
.dropzone u { color: #4058c4; text-underline-offset: 3px; }
.file-icon { width: 52px; height: 52px; display: grid; place-items: center; border-radius: 15px; color: #5268c9; background: #edf0ff; }
.file-icon svg { width: 24px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.file-icon.small { width: 38px; height: 38px; border-radius: 10px; }
.file-chip { display: flex; align-items: center; gap: 10px; margin-top: 14px; padding: 10px 12px; border: 1px solid #d6dce8; border-radius: 12px; background: #f8f9fc; }
.file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; text-align: left; }
.file-chip > button { min-height: 30px; width: 30px; padding: 0; border: 0; background: transparent; color: #8490a3; font-size: 20px; line-height: 1; }

.code-area { width: 100%; margin-top: 14px; padding: 12px; border: 1px solid #d6dce8; border-radius: 11px; background: #f8f9fc; color: #2b3850; font-family: "Cascadia Code", Consolas, monospace; font-size: 12px; line-height: 1.6; resize: vertical; }
.code-area::placeholder { color: #a4adbd; }
.code-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
.code-actions button { min-height: 32px; padding: 0 12px; font-size: 12px; }
.size-hint { color: #8490a3; font-size: 11px; }

.settings-card .field + .field { margin-top: 16px; }
.field-label { display: block; margin-bottom: 7px; color: #68748a; font-size: 12px; font-weight: 700; }
.dim-row { display: flex; align-items: flex-end; gap: 8px; }
.dim-input { display: flex; align-items: center; gap: 7px; padding: 0 10px; border: 1px solid #d6dce8; border-radius: 9px; background: #f8f9fc; }
.dim-input:focus-within { border-color: #8295ed; }
.dim-input span { color: #8490a3; font-size: 11px; }
.dim-input input { width: 74px; border: 0; outline: none; background: transparent; color: #172338; font-size: 14px; font-weight: 700; }
.dim-input input:disabled { opacity: .45; }
.dim-times { color: #a4adbd; padding-bottom: 8px; }
.check-label { display: flex; align-items: center; gap: 6px; color: #56647a; font-size: 12px; cursor: pointer; padding-bottom: 9px; }
.check-label.disabled { opacity: .45; cursor: not-allowed; }
.check-label input { accent-color: #5268c9; }

.scale-row { display: flex; align-items: center; gap: 8px; }
.scale-button { min-width: 46px; font-weight: 700; }
.scale-button.active { border-color: #8ea0ed; color: #4058c4; background: #edf0ff; }

.bg-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.bg-button { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; }
.bg-button.active { border-color: #8ea0ed; color: #4058c4; background: #edf0ff; }
.bg-swatch { width: 17px; height: 17px; flex: none; border: 1px solid #c6cddb; border-radius: 5px; background: #fff; }
.bg-swatch.transparent { background-image: linear-gradient(45deg, #d7dbe4 25%, transparent 25%, transparent 75%, #d7dbe4 75%), linear-gradient(45deg, #d7dbe4 25%, #fff 25%, #fff 75%, #d7dbe4 75%); background-size: 8px 8px; background-position: 0 0, 4px 4px; }
.bg-swatch.original { background: conic-gradient(#ef4444, #f59e0b, #22c55e, #3b82f6, #a855f7, #ef4444); }
.custom-color input { width: 34px; height: 34px; padding: 2px; border: 1px solid #d6dce8; border-radius: 8px; background: #fff; cursor: pointer; }
.color-hint { align-self: center; padding: 4px 7px; border-radius: 6px; color: #4a5a7a; background: #eef1f8; font-size: 11px; font-family: "Cascadia Code", Consolas, monospace; }
.field-note { margin: 8px 0 0; color: #8490a3; font-size: 11px; line-height: 1.6; }

.convert-button { width: 100%; margin-top: 22px; display: inline-flex; align-items: center; justify-content: center; gap: 9px; border-color: #4d63d1; color: #fff; background: #4d63d1; font-weight: 700; }
.convert-button:hover:not(:disabled) { border-color: #4055be; background: #4055be; }
.convert-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.convert-button .spinner { animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.message { margin: 12px 0 0; padding: 10px 12px; border-radius: 9px; font-size: 12px; line-height: 1.6; }
.message.error { color: #a32338; background: #fff0f2; }
.message.notice { color: #405175; background: #f0f3ff; }

.preview-empty { min-height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #8490a3; text-align: center; }
.preview-empty p { margin: 0; font-size: 13px; }
.preview-icon { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 18px; color: #5268c9; background: #edf0ff; font-size: 26px; }
.preview-canvas { display: grid; place-items: center; padding: 14px; border: 1px solid #dce2ec; border-radius: 13px; background-image: linear-gradient(45deg, #e8ebf0 25%, transparent 25%, transparent 75%, #e8ebf0 75%), linear-gradient(45deg, #e8ebf0 25%, #fff 25%, #fff 75%, #e8ebf0 75%); background-size: 20px 20px; background-position: 0 0, 10px 10px; }
.preview-canvas img { display: block; max-width: 100%; max-height: 44vh; object-fit: contain; }
.result-meta { display: flex; justify-content: space-between; gap: 10px; margin-top: 10px; color: #68748a; font-size: 12px; }
.result-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 14px; }
.result-actions button { font-size: 13px; font-weight: 600; }
.result-actions button.primary { border-color: #4d63d1; color: #fff; background: #4d63d1; }
.result-actions button.primary:hover:not(:disabled) { border-color: #4055be; background: #4055be; }

@media (max-width: 900px) {
  .editor-page { width: min(100% - 20px, 1080px); padding-top: 22px; }
  .workspace { grid-template-columns: 1fr; }
  .dim-row { flex-wrap: wrap; }
  .result-actions { grid-template-columns: 1fr 1fr; }
}
</style>