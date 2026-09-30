/* 视频人形轮廓检测 Worker
   OpenCV 5.0 内核 dnn + PP-HumanSeg 人形分割模型(ONNX):
   每帧 RGBA → 分割掩码 → findContours → 轮廓点集(帧坐标)。
   注:该构建 dnn 的 buffer 加载重载不可用,模型必须先写入 wasm 虚拟文件系统
   再按路径加载;PP-HumanSeg(tf2onnx)输出为 NHWC 交错两通道,奇数位为“人”。 */

/* 相对 worker 脚本自身位置解析，兼容 GitHub Pages 子路径部署 */
const MODEL_URL = '../vendor/models/pp_humanseg.onnx'
const INPUT_SIZE = 192
const MAX_CONTOURS = 12
const MIN_AREA_RATIO = 0.0006 /* 相对帧面积的最小轮廓阈值 */

let cvReady = null
let net = null

function ensureCv() {
  if (!cvReady) {
    cvReady = (async () => {
      try {
        importScripts('../vendor/opencv.js')
      } catch (err) {
        throw new Error('OpenCV 内核加载失败:' + (err && err.message))
      }
      const candidate = self.cv
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('OpenCV 内核初始化超时')), 60000))
      let mod
      try {
        mod = await Promise.race([Promise.resolve(candidate), timeout])
      } catch (err) {
        cvReady = null
        throw err
      }
      if (!mod || !mod.Mat) throw new Error('OpenCV 内核初始化异常')
      self.cv = mod
    })()
  }
  return cvReady
}

async function ensureNet() {
  if (net) return net
  const response = await fetch(MODEL_URL)
  if (!response.ok) throw new Error('人形分割模型下载失败:' + response.status)
  const bytes = new Uint8Array(await response.arrayBuffer())
  /* buffer 加载在该构建不可用:写入虚拟 FS 后按路径加载 */
  cv.FS.writeFile('/pp_humanseg.onnx', bytes)
  net = cv.readNetFromONNX('/pp_humanseg.onnx')
  if (!net) throw new Error('人形分割模型加载失败')
  return net
}

self.onmessage = async (event) => {
  const msg = event.data
  if (!msg) return
  if (msg.cmd === 'init') {
    try {
      await ensureCv()
      await ensureNet()
      self.postMessage({ id: msg.id, ev: 'ready' })
    } catch (err) {
      self.postMessage({ id: msg.id, ev: 'error', message: String((err && (err.msg ?? err.message)) ?? err) })
    }
  } else if (msg.cmd === 'detect') {
    try {
      await ensureCv()
      await ensureNet()
      const result = detectFrame(new Uint8ClampedArray(msg.buffer), msg.width, msg.height)
      self.postMessage({ id: msg.id, ev: 'detected', id: msg.id, contours: result.contours, coverage: result.coverage })
    } catch (err) {
      self.postMessage({ id: msg.id, ev: 'error', message: String((err && (err.msg ?? err.message)) ?? err) })
    }
  }
}

function detectFrame(pixels, width, height) {
  const src = cv.matFromArray(height, width, cv.CV_8UC4, pixels)
  /* blob 必须每帧重建:它复制调用时的像素快照 */
  const blob = cv.blobFromImage(
    src, 1 / 127.5, new cv.Size(INPUT_SIZE, INPUT_SIZE),
    new cv.Scalar(127.5, 127.5, 127.5), true, false)
  net.setInput(blob)
  let out
  try {
    out = net.forward()
  } catch (err) {
    out = new cv.Mat()
    net.forward(out)
  }

  const contoursOut = []
  let coverage = 0
  try {
    const f = out.data32F
    const total = f.length
    const dim = INPUT_SIZE
    /* 该模型输出 NHWC 交错两通道(背景/人),人通道在奇数位 */
    const stride = total >= dim * dim * 2 ? 2 : 1
    const offset = stride === 2 ? 1 : 0
    if (total >= dim * dim) {
      const maskArr = new Float32Array(dim * dim)
      for (let j = 0; j < dim * dim; j++) maskArr[j] = f[j * stride + offset]
      const maskSmall = cv.matFromArray(dim, dim, cv.CV_32F, Array.from(maskArr))
      const maskBig = new cv.Mat()
      const maskBin = new cv.Mat()
      const mask8 = new cv.Mat()
      const contours = new cv.MatVector()
      const hierarchy = new cv.Mat()
      try {
        cv.resize(maskSmall, maskBig, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR)
        cv.threshold(maskBig, maskBin, 0.5, 255, cv.THRESH_BINARY)
        maskBin.convertTo(mask8, cv.CV_8UC1)

        const maskData = mask8.data
        for (let i = 0; i < maskData.length; i++) { if (maskData[i]) coverage++ }

        cv.findContours(mask8, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
        const minArea = width * height * MIN_AREA_RATIO
        const candidates = []
        for (let i = 0; i < contours.size(); i++) {
          const c = contours.get(i)
          const area = cv.contourArea(c)
          if (area >= minArea) {
            const approx = new cv.Mat()
            cv.approxPolyDP(c, approx, 2.0, true)
            const flat = new Array(approx.rows * 2)
            for (let j = 0; j < approx.rows; j++) {
              flat[j * 2] = approx.data32S[j * 2]
              flat[j * 2 + 1] = approx.data32S[j * 2 + 1]
            }
            approx.delete()
            candidates.push({ area, flat })
          }
        }
        candidates.sort((a, b) => b.area - a.area)
        for (const c of candidates.slice(0, MAX_CONTOURS)) contoursOut.push(c.flat)
      } finally {
        maskSmall.delete(); maskBig.delete(); maskBin.delete(); mask8.delete()
        contours.delete(); hierarchy.delete()
      }
    }
  } finally {
    out.delete(); blob.delete(); src.delete()
  }

  return { contours: contoursOut, coverage: coverage / (width * height) }
}
