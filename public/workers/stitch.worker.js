/* 图片拼接 Worker:长图(matchTemplate 找重叠)与全景(特征匹配 + 单应变换)两条管线 */

const WORK_DIM = 2000        // 处理用图最大边长
const LONG_WIDTH = 1400      // 长图模式目标宽度上限
const LONG_PIXEL_BUDGET = 25e6
const PAN_PIXEL_BUDGET = 10e6
const LONG_MATCH_THRESH = 0.55
const PAN_GOOD_MIN = 10     // 起始图片对的最少 RANSAC 内点数
const PAN_LINK_MIN = 8      // 后续图片接入路径的最少内点数
const PAN_INLIER_MIN = 10   // 单应矩阵 RANSAC 内点数下限
const PAN_MATCH_MIN = 12    // 尝试估计单应矩阵所需的最少匹配数

let cvReadyPromise = null

function ensureCv() {
  if (!cvReadyPromise) {
    cvReadyPromise = (async () => {
      try {
        importScripts('../vendor/opencv.js')
      } catch (err) {
        throw new Error('OpenCV 内核加载失败:' + (err && err.message))
      }
      /* 该构建为 MODULARIZE 风格:全局 cv 是一个 resolve 出模块的 Promise */
      const candidate = self.cv
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('OpenCV 内核初始化超时')), 60000))
      let mod
      try {
        mod = await Promise.race([Promise.resolve(candidate), timeout])
      } catch (err) {
        cvReadyPromise = null
        throw err
      }
      if (!mod || !mod.Mat) throw new Error('OpenCV 内核初始化异常')
      self.cv = mod
    })()
  }
  return cvReadyPromise
}

self.onmessage = (event) => {
  const msg = event.data
  if (msg && msg.cmd === 'stitch') runStitch(msg)
}

function post(id, ev, payload) {
  self.postMessage(Object.assign({ id, ev }, payload))
}

async function runStitch(msg) {
  const { id } = msg
  const pool = new Set()
  const track = (m) => { if (m) pool.add(m); return m }
  const release = () => {
    for (const m of pool) { try { m.delete() } catch (err) { /* 忽略重复释放 */ } }
    pool.clear()
  }
  try {
    post(id, 'progress', { percent: 2, message: '正在加载 OpenCV 内核…' })
    await ensureCv()
    post(id, 'progress', { percent: 8, message: '正在解码图片…' })
    const mats = msg.bitmaps.map((b) => track(bitmapToMat(b, WORK_DIM)))
    if (mats.length < 2) throw new Error('至少需要两张图片才能拼接')

    let effective = msg.mode
    if (effective === 'auto') {
      post(id, 'progress', { percent: 10, message: '正在识别图片类型…' })
      effective = detectMode(mats)
    }
    post(id, 'progress', {
      percent: 12,
      message: effective === 'longshot' ? '已识别为长图截图,开始衔接…' : '已识别为全景照片,开始特征匹配…',
    })

    const report = (percent, message) => post(id, 'progress', { percent, message })
    const result = effective === 'longshot'
      ? stitchLongshot(mats, track, report)
      : stitchPanorama(mats, track, report)

    post(id, 'progress', { percent: 97, message: '正在生成结果图片…' })
    const blob = await matToBlob(result.mat, msg.format || 'image/png')
    post(id, 'result', {
      blob,
      width: result.mat.cols,
      height: result.mat.rows,
      details: result.details,
    })
  } catch (err) {
    post(id, 'error', {
      message: (err && err.message) || '拼接失败',
      details: (err && err.details) || null,
    })
  } finally {
    release()
  }
}

/* ---------- 通用工具 ---------- */

function bitmapToMat(bitmap, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return cv.matFromArray(h, w, cv.CV_8UC4, ctx.getImageData(0, 0, w, h).data)
}

async function matToBlob(mat, type) {
  let rgba = mat
  let converted = null
  if (mat.channels() !== 4) {
    converted = new cv.Mat()
    cv.cvtColor(mat, converted, cv.COLOR_RGB2RGBA)
    rgba = converted
  }
  const canvas = new OffscreenCanvas(rgba.cols, rgba.rows)
  const ctx = canvas.getContext('2d')
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows), 0, 0)
  if (converted) converted.delete()
  return canvas.convertToBlob({
    type,
    quality: type === 'image/jpeg' ? 0.92 : undefined,
  })
}

function scaleMat(src, factor) {
  if (Math.abs(factor - 1) < 0.001) return src
  const w = Math.max(1, Math.round(src.cols * factor))
  const h = Math.max(1, Math.round(src.rows * factor))
  const dst = new cv.Mat()
  cv.resize(src, dst, new cv.Size(w, h), 0, 0, cv.INTER_AREA)
  return dst
}

function toGray(rgba) {
  const gray = new cv.Mat()
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)
  return gray
}

function mul3(A, B) {
  const C = new Array(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]
    }
  }
  return C
}

function inv3(M) {
  const [a, b, c, d, e, f, g, h, i] = M
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (!det || !Number.isFinite(det)) throw new Error('图片变换矩阵不可逆,图片间视角差异过大')
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ]
}

const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

function translate3(x, y) {
  return [1, 0, x, 0, 1, y, 0, 0, 1]
}

function scale3(s) {
  return [s, 0, 0, 0, s, 0, 0, 0, 1]
}

function transformCorners(w, h, M) {
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h])
  const mMat = cv.matFromArray(3, 3, cv.CV_64FC1, M)
  const dst = new cv.Mat()
  try {
    cv.perspectiveTransform(src, dst, mMat)
    const f = dst.data32F
    return [0, 1, 2, 3].map((i) => ({ x: f[i * 2], y: f[i * 2 + 1] }))
  } finally {
    src.delete(); mMat.delete(); dst.delete()
  }
}

/* ---------- 自动模式判定 ---------- */

function median(arr) {
  const s = [...arr].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/* 用相邻两图的特征点位移方向判断:横向位移大 → 全景,纵向位移大 → 长图。
   天空、纯色背景等内容在模板匹配下有歧义,特征位移是最可靠的信号。 */
function detectMode(mats) {
  const widths = mats.map((m) => m.cols)
  const wmin = Math.min(...widths)
  if (Math.max(...widths) > wmin * 1.05) return 'panorama'

  const orb = new cv.ORB(3000)
  const noMask = new cv.Mat()
  try {
    for (let k = 0; k + 1 < Math.min(mats.length, 3); k++) {
      const kps = []
      const descs = []
      try {
        for (let j = k; j <= k + 1; j++) {
          const gray = toGray(mats[j])
          const kp = new cv.KeyPointVector()
          const desc = new cv.Mat()
          try {
            orb.detectAndCompute(gray, noMask, kp, desc)
          } finally {
            gray.delete()
          }
          kps.push(kp); descs.push(desc)
        }
        const pairs = matchPair(descs[0], descs[1])
        if (pairs.length >= 30) {
          const dxs = []
          const dys = []
          for (const [qa, qb] of pairs) {
            const pa = pointAt(kps[0], qa)
            const pb = pointAt(kps[1], qb)
            dxs.push(pb[0] - pa[0])
            dys.push(pb[1] - pa[1])
          }
          const dx = median(dxs)
          const dy = median(dys)
          if (Math.abs(dx) > Math.abs(dy) * 1.5) return 'panorama'
          if (Math.abs(dy) > Math.abs(dx) * 1.5) return 'longshot'
        }
      } finally {
        kps.forEach((v) => v.delete())
        descs.forEach((m) => m.delete())
      }
    }
  } finally {
    noMask.delete(); orb.delete()
  }
  /* 特征不足时退回模板匹配探测 */
  return longshotPair(mats[0], mats[1]).score >= 0.7 ? 'longshot' : 'panorama'
}

/* ---------- 长图拼接 ---------- */

/* 用 candidate 顶部窗口做模板,到 prev 底部搜索,返回对齐关系与相关度。
   模板必须从 candidate 第 0 行开始:它是重叠区的最深位置,保证窗口完整落在
   重叠区内;窗口高度由大到小尝试,得分足够高即提前采用。 */
function longshotPair(prev, cand) {
  const prevGray = toGray(prev)
  const candGray = toGray(cand)
  try {
    const searchTop = Math.max(0, prev.rows - Math.round(prev.rows * 0.7))
    const searchH = prev.rows - searchTop
    if (searchH < 24 || cand.rows < 24) return { score: -1, x: 0, overlap: 0 }

    const search = prevGray.roi(new cv.Rect(0, searchTop, prevGray.cols, searchH))
    let best = null
    try {
      const heights = [96, 64, 40, 24]
        .filter((h) => h <= cand.rows && h <= searchH)
        // 去重保持降序
        .filter((h, i, arr) => arr.indexOf(h) === i)
      for (const h of heights) {
        if (windowVariance(candGray, h) <= 1) continue /* 接近纯色的模板无法匹配 */
        const templ = candGray.roi(new cv.Rect(0, 0, candGray.cols, h))
        const result = new cv.Mat()
        try {
          cv.matchTemplate(search, templ, result, cv.TM_CCOEFF_NORMED)
          const mm = cv.minMaxLoc(result)
          if (!best || mm.maxVal > best.score) {
            best = { score: mm.maxVal, x: mm.maxLoc.x, y: mm.maxLoc.y, h }
          }
        } finally {
          templ.delete(); result.delete()
        }
        if (best && best.score >= 0.9) break
      }
    } finally {
      search.delete()
    }
    if (!best) return { score: -1, x: 0, overlap: 0 }
    /* candidate 第 0 行对应 prev 的第 rAlign 行,重叠高度 = prev.rows - rAlign */
    const rAlign = searchTop + best.y
    return {
      score: best.score,
      x: best.x,
      overlap: Math.max(1, Math.min(searchH, prev.rows - rAlign)),
    }
  } finally {
    prevGray.delete(); candGray.delete()
  }
}

function windowVariance(gray, rows) {
  const d = gray.data
  const w = gray.cols
  const n = rows * w
  let sum = 0
  for (let i = 0; i < n; i++) sum += d[i]
  const mean = sum / n
  let v = 0
  for (let i = 0; i < n; i++) { const dv = d[i] - mean; v += dv * dv }
  return v / n
}

function stitchLongshot(mats, track, report) {
  const n = mats.length
  report(14, '正在统一图片宽度…')

  let targetW = Math.min(Math.min(...mats.map((m) => m.cols)), LONG_WIDTH)
  let imgs = mats.map((m) => track(scaleMat(m, targetW / m.cols)))

  const estPixels = targetW * imgs.reduce((s, m) => s + m.rows, 0) * 0.8
  if (estPixels > LONG_PIXEL_BUDGET) {
    const s = Math.sqrt(LONG_PIXEL_BUDGET / estPixels)
    imgs = imgs.map((m) => track(scaleMat(m, s)))
  }

  /* 布局:从第一张开始,每次在剩余图片里找与上一张底部衔接最好的一张 */
  const order = [0]
  const used = new Set([0])
  const layout = [{ x: 0, y: 0, overlap: 0 }]
  const pairScores = []

  while (order.length < n) {
    const prevIdx = order[order.length - 1]
    const prev = imgs[prevIdx]
    let best = null
    for (let i = 0; i < n; i++) {
      if (used.has(i)) continue
      const r = longshotPair(prev, imgs[i])
      if (!best || r.score > best.score) best = Object.assign({ i }, r)
    }
    if (!best || best.score < LONG_MATCH_THRESH) {
      const candidates = []
      for (let i = 0; i < n; i++) {
        if (!used.has(i)) candidates.push({ i, score: longshotPair(prev, imgs[i]).score })
      }
      candidates.sort((a, b) => b.score - a.score)
      const err = new Error(`第 ${order.length} 张图片之后找不到足够的重叠内容,最高相关度:${best ? best.score.toFixed(2) : '无'}`)
      err.details = {
        mode: 'longshot',
        placed: order.length,
        bestScore: best ? Number(best.score.toFixed(3)) : null,
        order: order.map((i) => i + 1),
        topScores: candidates.slice(0, 6).map((c) => ({ pair: [prevIdx + 1, c.i + 1], score: Number(c.score.toFixed(3)) })),
      }
      throw err
    }
    const overlap = Math.max(0, Math.min(best.overlap, prev.rows, imgs[best.i].rows))
    const prevPos = layout[layout.length - 1]
    layout.push({
      x: prevPos.x - best.x,
      y: prevPos.y + prev.rows - overlap,
      overlap,
    })
    order.push(best.i)
    used.add(best.i)
    pairScores.push({ pair: [prevIdx + 1, best.i + 1], score: Number(best.score.toFixed(3)) })
    report(14 + Math.round(70 * order.length / n), `已衔接 ${order.length}/${n} 张…`)
  }

  /* 画布与合成 */
  const minX = Math.min(0, ...layout.map((p) => p.x))
  if (minX < 0) layout.forEach((p) => { p.x -= minX })
  const W = Math.max(...layout.map((p, i) => p.x + imgs[order[i]].cols))
  const H = Math.max(...layout.map((p, i) => p.y + imgs[order[i]].rows))

  report(88, '正在合成图片与融合接缝…')
  const canvas = track(cv.Mat.zeros(H, W, cv.CV_8UC4))
  canvas.setTo(new cv.Scalar(255, 255, 255, 255))

  for (let k = 0; k < order.length; k++) {
    const img = imgs[order[k]]
    const pos = layout[k]
    const dstRoi = canvas.roi(new cv.Rect(pos.x, pos.y, img.cols, img.rows))
    try {
      const overlap = Math.min(pos.overlap, img.rows)
      if (k === 0 || overlap <= 0) {
        img.copyTo(dstRoi)
      } else {
        /* 重叠带内逐行线性渐变融合,消除压缩与亮度差异带来的接缝 */
        const bandDst = dstRoi.rowRange(0, overlap)
        const bandSrc = img.rowRange(0, overlap)
        for (let r = 0; r < overlap; r++) {
          const a = (r + 1) / (overlap + 1)
          const dRow = bandDst.row(r)
          const sRow = bandSrc.row(r)
          cv.addWeighted(dRow, 1 - a, sRow, a, 0, dRow)
          dRow.delete(); sRow.delete()
        }
        bandDst.delete(); bandSrc.delete()
        if (overlap < img.rows) {
          const restDst = dstRoi.rowRange(overlap, img.rows)
          const restSrc = img.rowRange(overlap, img.rows)
          restSrc.copyTo(restDst)
          restDst.delete(); restSrc.delete()
        }
      }
    } finally {
      dstRoi.delete()
    }
  }

  return {
    mat: canvas,
    details: { mode: 'longshot', order: order.map((i) => i + 1), pairs: pairScores },
  }
}

/* ---------- 全景拼接 ---------- */

function keyOf(a, b) { return a < b ? `${a}-${b}` : `${b}-${a}` }

/* Lowe 比率检验匹配,返回 [queryIdx, trainIdx] 对(比交叉校验保留更多对应点,交由 RANSAC 清洗) */
function matchPair(descA, descB) {
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false)
  const knn = new cv.DMatchVectorVector()
  const pairs = []
  try {
    matcher.knnMatch(descA, descB, knn, 2)
    const cnt = knn.size()
    for (let q = 0; q < cnt; q++) {
      const mvec = knn.get(q)
      if (mvec.size() < 2) continue
      const m1 = mvec.get(0)
      const m2 = mvec.get(1)
      if (m1.distance < 0.75 * m2.distance) pairs.push([m1.queryIdx, m1.trainIdx])
    }
    return pairs
  } finally {
    knn.delete(); matcher.delete()
  }
}

function pointAt(kpVec, idx) {
  const p = kpVec.get(idx).pt
  return [p.x, p.y]
}

/* ---------- 变换估计:模型阶梯 ---------- */

/* 高斯消元解 n 元线性方程组 */
function solveLinear(A, b, n) {
  const m = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r
    }
    if (Math.abs(m[piv][col]) < 1e-9) return null
    const t = m[col]; m[col] = m[piv]; m[piv] = t
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = m[r][col] / m[col][col]
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c]
    }
  }
  return Array.from({ length: n }, (_, i) => m[i][n] / m[i][i])
}

/* RANSAC + 最小二乘重拟合受限模型(比率检验的匹配仍含离群点,
   直接做最小二乘会被带偏,必须先随机采样 consensus)。
   kind='ts':  u = a·x + c        v = a·y + d        (平移+等比缩放)
   kind='sim': u = a·x - b·y + c  v = b·x + a·y + d  (相似变换) */
function fitLinearModel(srcPts, dstPts, kind) {
  const predict = (m, p) => kind === 'ts'
    ? { x: m.a * p.x + m.c, y: m.a * p.y + m.d }
    : { x: m.a * p.x - m.b * p.y + m.c, y: m.b * p.x + m.a * p.y + m.d }
  const fit = (idx) => {
    if (kind === 'ts') {
      let sxx = 0, syy = 0, sx = 0, sy = 0, su = 0, sv = 0, sxu = 0, syv = 0
      for (const k of idx) {
        const p = srcPts[k], q = dstPts[k]
        sxx += p.x * p.x; syy += p.y * p.y
        sx += p.x; sy += p.y
        su += q.x; sv += q.y
        sxu += p.x * q.x; syv += p.y * q.y
      }
      const n = idx.length
      const sol = solveLinear(
        [[sxx + syy, sx, sy], [sx, n, 0], [sy, 0, n]],
        [sxu + syv, su, sv], 3)
      return sol ? { a: sol[0], b: 0, c: sol[1], d: sol[2] } : null
    }
    const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
    const B = [0, 0, 0, 0]
    for (const k of idx) {
      const p = srcPts[k], q = dstPts[k]
      const r1 = [p.x, -p.y, 1, 0]
      const r2 = [p.y, p.x, 0, 1]
      for (let i = 0; i < 4; i++) {
        B[i] += r1[i] * q.x + r2[i] * q.y
        for (let j = 0; j < 4; j++) A[i][j] += r1[i] * r1[j] + r2[i] * r2[j]
      }
    }
    const sol = solveLinear(A, B, 4)
    return sol ? { a: sol[0], b: sol[1], c: sol[2], d: sol[3] } : null
  }
  const countInliers = (m) => {
    const idx = []
    for (let k = 0; k < srcPts.length; k++) {
      const pr = predict(m, srcPts[k])
      const q = dstPts[k]
      if (Math.abs(pr.x - q.x) <= 4 && Math.abs(pr.y - q.y) <= 4) idx.push(k)
    }
    return idx
  }

  if (srcPts.length < 8) return { inlierCount: 0, params: null }

  /* RANSAC:两点即可确定两种模型 */
  let bestIdx = []
  for (let iter = 0; iter < 600; iter++) {
    const i1 = Math.floor(Math.random() * srcPts.length)
    let i2 = Math.floor(Math.random() * srcPts.length)
    if (i2 === i1) i2 = (i2 + 1) % srcPts.length
    const m = fit([i1, i2])
    if (!m) continue
    const idx = countInliers(m)
    if (idx.length > bestIdx.length) bestIdx = idx
    if (bestIdx.length >= srcPts.length * 0.85) break
  }
  if (bestIdx.length < 6) return { inlierCount: 0, params: null }

  /* 内点最小二乘重拟合两轮 */
  let model = null
  let idx = bestIdx
  for (let round = 0; round < 2; round++) {
    const m = fit(idx)
    if (!m) break
    model = m
    idx = countInliers(m)
  }
  if (!model) return { inlierCount: 0, params: null }
  return { inlierCount: countInliers(model).length, params: model }
}

function affineToMat(m) {
  return [m.a, -m.b, m.c, m.b, m.a, m.d, 0, 0, 1]
}

/* 对一对图片估计 B→A 的变换。除单应(8 自由度,RANSAC)外,先尝试平移+缩放
   与相似变换:纯平移场景(滚动截图/远景平移)用受限模型可避免透视分量沿
   链条累积成倾斜与画布白角。内点数达到单应的 90% 即采用更简模型。 */
function estimateTransform(kpsA, kpsB, pairs, sizeB) {
  const srcPts = []
  const dstPts = []
  for (const [pa, pb] of pairs) {
    const pbPt = pointAt(kpsB, pb)
    const paPt = pointAt(kpsA, pa)
    srcPts.push({ x: pbPt[0], y: pbPt[1] })
    dstPts.push({ x: paPt[0], y: paPt[1] })
  }

  const n = pairs.length
  const srcFlat = new Float32Array(n * 2)
  const dstFlat = new Float32Array(n * 2)
  srcPts.forEach((p, k) => { srcFlat[k * 2] = p.x; srcFlat[k * 2 + 1] = p.y })
  dstPts.forEach((p, k) => { dstFlat[k * 2] = p.x; dstFlat[k * 2 + 1] = p.y })
  const srcMat = cv.matFromArray(n, 1, cv.CV_32FC2, srcFlat)
  const dstMat = cv.matFromArray(n, 1, cv.CV_32FC2, dstFlat)
  const mask = new cv.Mat()
  let H = null
  let hInliers = 0
  let hVals = null
  try {
    H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 4.0, mask)
    /* 该构建未绑定 countNonzero,直接遍历掩码统计内点 */
    const maskData = mask.data
    for (let i = 0; i < maskData.length; i++) { if (maskData[i]) hInliers++ }
    const vals = Array.from(H.data64F)
    if (vals.every((v) => Number.isFinite(v)) && Math.abs(vals[8]) > 1e-9) hVals = norm9(vals)
  } finally {
    srcMat.delete(); dstMat.delete(); mask.delete()
    if (H) H.delete()
  }

  const ts = fitLinearModel(srcPts, dstPts, 'ts')
  const sim = fitLinearModel(srcPts, dstPts, 'sim')

  const best = Math.max(hInliers, ts.inlierCount, sim.inlierCount)
  let chosen
  if (ts.params && ts.inlierCount >= 0.9 * best) {
    chosen = { vals: affineToMat(ts.params), inliers: ts.inlierCount, model: '平移+缩放' }
  } else if (sim.params && sim.inlierCount >= 0.9 * best) {
    chosen = { vals: affineToMat(sim.params), inliers: sim.inlierCount, model: '相似变换' }
  } else if (hVals) {
    chosen = { vals: hVals, inliers: hInliers, model: '单应' }
  } else {
    return { ok: false, inliers: 0, matches: n, vals: null, model: null }
  }

  /* 视角合理性:变换后四角范围不应过分夸张 */
  let sane = false
  const vals = chosen.vals
  if (vals.every((v) => Number.isFinite(v))) {
    const corners = transformCorners(sizeB.cols, sizeB.rows, vals)
    const xs = corners.map((p) => p.x)
    const ys = corners.map((p) => p.y)
    const extW = Math.max(...xs) - Math.min(...xs)
    const extH = Math.max(...ys) - Math.min(...ys)
    sane = extW > sizeB.cols * 0.12 && extW < sizeB.cols * 8
      && extH > sizeB.rows * 0.12 && extH < sizeB.rows * 8
  }
  return {
    ok: sane && chosen.inliers >= PAN_INLIER_MIN,
    inliers: chosen.inliers,
    matches: n,
    vals,
    model: chosen.model,
    counts: { '单应': hInliers, '平移+缩放': ts.inlierCount, '相似变换': sim.inlierCount },
  }
}

function norm9(vals) {
  const s = vals[8]
  return vals.map((v) => v / s)
}

function stitchPanorama(mats, track, report) {
  const n = mats.length

  /* 1. 特征提取 */
  const orb = new cv.ORB(5000)
  const kps = []
  const descs = []
  const noMask = new cv.Mat()
  try {
    for (let i = 0; i < n; i++) {
      const gray = toGray(mats[i])
      const kp = new cv.KeyPointVector()
      const desc = new cv.Mat()
      try {
        orb.detectAndCompute(gray, noMask, kp, desc)
      } finally {
        gray.delete()
      }
      track(kp); track(desc)
      kps.push(kp); descs.push(desc)
      report(10 + Math.round(14 * (i + 1) / n), `特征提取 ${i + 1}/${n}…`)
    }
  } finally {
    noMask.delete(); orb.delete()
  }

  /* 2. 全对匹配 + 对每对估计单应矩阵:内点数是比匹配数可靠得多的重叠证据 */
  const pairData = {}
  const totalPairs = (n * (n - 1)) / 2
  let donePairs = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pairs = matchPair(descs[i], descs[j])
      const entry = { matches: pairs.length, inliers: 0, vals: null, model: null }
      if (pairs.length >= PAN_MATCH_MIN) {
        const est = estimateTransform(kps[i], kps[j], pairs, mats[j])
        if (est.ok) {
          entry.inliers = est.inliers
          entry.vals = est.vals
          entry.model = est.model
          entry.counts = est.counts
        }
      }
      pairData[`${i}-${j}`] = entry
      donePairs++
      report(26 + Math.round(30 * donePairs / totalPairs), `特征匹配与配对验证 ${donePairs}/${totalPairs} 组…`)
    }
  }

  /* 3. 由内点数构建图片顺序(最强拼接链) */
  const sc = (a, b) => pairData[keyOf(a, b)].inliers
  let bestA = -1, bestB = -1, bestS = -1
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sc(i, j) > bestS) { bestS = sc(i, j); bestA = i; bestB = j }
    }
  }
  if (bestS < PAN_GOOD_MIN) {
    const err = new Error('图片之间找不到足够的相似内容,无法确定拼接顺序')
    err.details = { mode: 'panorama', topScores: topScores(pairData) }
    throw err
  }
  const order = [bestA, bestB]
  const inOrder = new Set(order)
  while (order.length < n) {
    const head = order[0]
    const tail = order[order.length - 1]
    let pick = -1, pickS = -1, atHead = false
    for (let i = 0; i < n; i++) {
      if (inOrder.has(i)) continue
      if (sc(i, head) > pickS) { pickS = sc(i, head); pick = i; atHead = true }
      if (sc(i, tail) > pickS) { pickS = sc(i, tail); pick = i; atHead = false }
    }
    if (pick < 0 || pickS < PAN_LINK_MIN) {
      const remaining = n - order.length
      const err = new Error(`有 ${remaining} 张图片与已拼合部分重叠不足(最高内点数 ${pickS}),无法继续拼接`)
      err.details = {
        mode: 'panorama',
        stitched: order.length,
        bestScore: pickS,
        order: order.map((i) => i + 1),
        topScores: topScores(pairData),
      }
      throw err
    }
    if (atHead) order.unshift(pick)
    else order.push(pick)
    inOrder.add(pick)
    report(58, `图片顺序:${order.map((i) => i + 1).join(' → ')}`)
  }

  /* 两端扩展不动时,尝试把剩余图片插入路径内部相邻对之间 */
  let inserted = true
  while (inserted && order.length < n) {
    inserted = false
    for (let x = 0; x < n && order.length < n; x++) {
      if (inOrder.has(x)) continue
      let bestK = -1
      let bestS = -1
      for (let k = 0; k + 1 < order.length; k++) {
        const s = Math.min(sc(x, order[k]), sc(x, order[k + 1]))
        if (s > bestS) { bestS = s; bestK = k }
      }
      if (bestK >= 0 && bestS >= PAN_LINK_MIN) {
        order.splice(bestK + 1, 0, x)
        inOrder.add(x)
        inserted = true
        report(58, `图片顺序:${order.map((i) => i + 1).join(' → ')}`)
      }
    }
  }

  if (order.length < n) {
    const pickS = 0
    const remaining = n - order.length
    const err = new Error(`有 ${remaining} 张图片与已拼合部分重叠不足(最高内点数 ${pickS}),无法继续拼接`)
    err.details = {
      mode: 'panorama',
      stitched: order.length,
      bestScore: pickS,
      order: order.map((i) => i + 1),
      topScores: topScores(pairData),
    }
    throw err
  }
  report(58, `图片顺序:${order.map((i) => i + 1).join(' → ')},开始估计变换…`)

  /* 4. 相邻图单应矩阵(order[k+1] → order[k]),直接复用配对阶段的结果 */
  const Hf = []
  const linkScores = []
  for (let k = 0; k + 1 < order.length; k++) {
    const a = order[k]
    const b = order[k + 1]
    const entry = pairData[keyOf(a, b)]
    /* 配对阶段统一按“大索引 → 小索引”估计,路径方向相反时取逆矩阵 */
    Hf.push(a < b ? entry.vals : inv3(entry.vals))
    linkScores.push({ pair: [a + 1, b + 1], score: entry.inliers, model: entry.model, counts: entry.counts })
    report(58 + Math.round(10 * (k + 1) / (order.length - 1)), `估计相邻变换 ${k + 1}/${order.length - 1}…`)
  }

  /* 5. 以路径中部为参考,链式得到每张图到参考坐标系的变换 */
  const ref = (order.length - 1) >> 1
  const T = new Array(n).fill(null)
  T[order[ref]] = IDENTITY3.slice()
  for (let k = ref; k + 1 < order.length; k++) {
    T[order[k + 1]] = mul3(T[order[k]], Hf[k])
  }
  for (let k = ref; k > 0; k--) {
    T[order[k - 1]] = mul3(T[order[k]], inv3(Hf[k - 1]))
  }

  /* 6. 画布范围与像素预算 */
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < n; i++) {
    for (const p of transformCorners(mats[i].cols, mats[i].rows, T[i])) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
    }
  }
  let W = Math.max(1, Math.ceil(maxX - minX))
  let H = Math.max(1, Math.ceil(maxY - minY))
  let outScale = 1
  if (W * H > PAN_PIXEL_BUDGET) outScale = Math.sqrt(PAN_PIXEL_BUDGET / (W * H))

  const finalMats = []
  for (let i = 0; i < n; i++) {
    const M = mul3(scale3(outScale), mul3(translate3(-minX, -minY), T[i]))
    finalMats.push(track(cv.matFromArray(3, 3, cv.CV_64FC1, M)))
  }
  W = Math.max(1, Math.ceil(W * outScale))
  H = Math.max(1, Math.ceil(H * outScale))

  /* 7. 透视变形 + 距离变换羽化融合 */
  report(70, '正在变形与融合…')
  const acc = track(cv.Mat.zeros(H, W, cv.CV_32FC3))
  const wsum = track(cv.Mat.zeros(H, W, cv.CV_32FC1))
  for (let i = 0; i < n; i++) {
    const warped = new cv.Mat()
    const channels = new cv.MatVector()
    let mask = new cv.Mat()
    try {
      cv.warpPerspective(mats[i], warped, finalMats[i], new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0))
      cv.split(warped, channels)
      /* 阈值取 127 并腐蚀 1px:变形边缘与透明黑边界做双线性插值会产生暗色
         fringe 像素,不排除会在拼接结果边缘留下黑线 */
      cv.threshold(channels.get(3), mask, 127, 255, cv.THRESH_BINARY)
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))
      const maskEroded = new cv.Mat()
      cv.erode(mask, maskEroded, kernel)
      kernel.delete()
      mask.delete()
      mask = maskEroded
      const rect = cv.boundingRect(mask)
      if (rect.width <= 0 || rect.height <= 0) continue

      const maskR = mask.roi(rect)
      const wR = new cv.Mat()
      cv.distanceTransform(maskR, wR, cv.DIST_L2, 3)
      maskR.delete()

      const wR3 = new cv.Mat()
      const wR3v = new cv.MatVector()
      wR3v.push_back(wR); wR3v.push_back(wR); wR3v.push_back(wR)
      cv.merge(wR3v, wR3)
      wR3v.delete()

      const colorV = new cv.MatVector()
      colorV.push_back(channels.get(0))
      colorV.push_back(channels.get(1))
      colorV.push_back(channels.get(2))
      const color8 = new cv.Mat()
      cv.merge(colorV, color8)
      colorV.delete()
      const colorR = color8.roi(rect)
      const colorF = new cv.Mat()
      colorR.convertTo(colorF, cv.CV_32FC3)
      colorR.delete()
      cv.multiply(colorF, wR3, colorF)
      color8.delete()

      const accR = acc.roi(rect)
      const wsumR = wsum.roi(rect)
      cv.add(accR, colorF, accR)
      cv.add(wsumR, wR, wsumR)
      accR.delete(); wsumR.delete()

      wR3.delete(); wR.delete(); colorF.delete()
    } finally {
      warped.delete(); channels.delete(); mask.delete()
    }
    report(70 + Math.round(25 * (i + 1) / n), `变形与融合 ${i + 1}/${n}…`)
  }

  /* 8. 归一化、裁剪黑边 */
  report(96, '正在输出结果…')
  const wsum3 = new cv.Mat()
  const wsum3v = new cv.MatVector()
  wsum3v.push_back(wsum); wsum3v.push_back(wsum); wsum3v.push_back(wsum)
  cv.merge(wsum3v, wsum3)
  wsum3v.delete()

  const outF = new cv.Mat()
  cv.divide(acc, wsum3, outF)
  wsum3.delete()
  const out8 = new cv.Mat()
  outF.convertTo(out8, cv.CV_8UC3)
  outF.delete()

  /* 无内容区域填充白色,避免包围盒内出现黑角 */
  const empty32 = new cv.Mat()
  cv.threshold(wsum, empty32, 0.5, 255, cv.THRESH_BINARY_INV)
  const empty8 = new cv.Mat()
  empty32.convertTo(empty8, cv.CV_8UC1)
  empty32.delete()
  out8.setTo(new cv.Scalar(255, 255, 255), empty8)
  empty8.delete()

  const cover32 = new cv.Mat()
  cv.threshold(wsum, cover32, 0.5, 255, cv.THRESH_BINARY)
  const cover8 = new cv.Mat()
  cover32.convertTo(cover8, cv.CV_8UC1)
  cover32.delete()
  const contentRect = cv.boundingRect(cover8)
  cover8.delete()

  const cropped = contentRect.width > 0 && contentRect.height > 0
    ? out8.roi(contentRect).clone()
    : out8
  out8.delete()
  track(cropped)

  const out4 = new cv.Mat()
  cv.cvtColor(cropped, out4, cv.COLOR_RGB2RGBA)
  track(out4)

  return {
    mat: out4,
    details: {
      mode: 'panorama',
      order: order.map((i) => i + 1),
      pairs: linkScores,
      outputScale: Number(outScale.toFixed(3)),
    },
  }
}

function topScores(pairData) {
  return Object.entries(pairData)
    .map(([key, entry]) => {
      const [a, b] = key.split('-').map(Number)
      return { pair: [a + 1, b + 1], score: entry.inliers }
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, 6)
}
