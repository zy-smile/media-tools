/* 演示用示例图片:在浏览器端绘制可拼接的模拟内容,便于快速体验与测试 */

function seeded(index: number) {
  const x = Math.sin(index * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

async function canvasToFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
  if (!blob) throw new Error('生成示例图片失败')
  return new File([blob], name, { type: 'image/jpeg' })
}

function sliceCanvas(source: HTMLCanvasElement, x: number, y: number, w: number, h: number) {
  const slice = document.createElement('canvas')
  slice.width = w
  slice.height = h
  const ctx = slice.getContext('2d')!
  ctx.drawImage(source, x, y, w, h, 0, 0, w, h)
  return slice
}

/* 模拟一篇长文章的滚动截图,竖向切片并保留重叠区 */
export async function createLongshotDemoFiles(count = 5): Promise<File[]> {
  const W = 640
  const sliceH = 500
  const overlap = 120
  const stride = sliceH - overlap
  const totalH = sliceH + (count - 1) * stride

  const full = document.createElement('canvas')
  full.width = W
  full.height = totalH
  const ctx = full.getContext('2d')!

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, totalH)

  /* 顶栏 */
  ctx.fillStyle = '#4a6cf7'
  ctx.fillRect(0, 0, W, 64)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 22px sans-serif'
  ctx.fillText('示例文章 · 图片拼接演示', 24, 40)

  /* 正文:多种版式交替,避免内容周期性重复干扰匹配 */
  let y = 96
  let section = 1
  while (y < totalH - 40) {
    const kind = Math.floor(seeded(section * 3.3) * 4)
    ctx.fillStyle = '#243252'
    ctx.font = 'bold 20px sans-serif'
    ctx.fillText(`${section}. ${['产品发布说明', '使用统计数据', '用户反馈摘录', '版本兼容表格', '常见问题解答'][section % 5]}`, 24, y)
    y += 30

    if (kind === 0) {
      /* 普通段落 */
      const lines = 2 + Math.floor(seeded(section * 10) * 5)
      ctx.fillStyle = '#dfe4ef'
      for (let i = 0; i < lines; i++) {
        const w = W - 48 - Math.floor(seeded(section * 10 + i) * 200)
        ctx.fillRect(24, y, w, 10)
        y += 22
      }
      y += 18
    } else if (kind === 1) {
      /* 项目符号列表 */
      const items = 3 + Math.floor(seeded(section * 5) * 4)
      ctx.font = '14px sans-serif'
      for (let i = 0; i < items; i++) {
        ctx.fillStyle = '#4a6cf7'
        ctx.beginPath()
        ctx.arc(32, y + 7, 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#c3cbdd'
        ctx.fillRect(48, y, W - 96 - Math.floor(seeded(section * 7 + i) * 160), 9)
        y += 26
      }
      y += 14
    } else if (kind === 2) {
      /* 数据表格 */
      const rows = 3 + Math.floor(seeded(section * 11) * 3)
      const cols = [24, 200, 360, 520]
      ctx.fillStyle = '#eef1fb'
      ctx.fillRect(24, y, W - 48, 30)
      ctx.fillStyle = '#8a97b8'
      ctx.font = 'bold 13px sans-serif'
      cols.forEach((cx, ci) => ctx.fillText(['指标', '本周', '上周', '环比'][ci], cx + 8, y + 20))
      y += 30
      for (let r = 0; r < rows; r++) {
        ctx.fillStyle = r % 2 ? '#f7f9fe' : '#ffffff'
        ctx.fillRect(24, y, W - 48, 26)
        ctx.fillStyle = '#aab4cc'
        ctx.font = '13px sans-serif'
        cols.forEach((cx, ci) => ctx.fillText(`${40 + r * 7 + ci * 3}${ci === 3 ? '%' : ''}`, cx + 8, y + 18))
        y += 26
      }
      ctx.strokeStyle = '#e2e7f4'
      ctx.strokeRect(24, y - rows * 26 - 30, W - 48, rows * 26 + 30)
      y += 20
    } else {
      /* 大块配图,高度与色相都随章节变化 */
      const h = 90 + Math.floor(seeded(section * 13) * 90)
      const hue = Math.floor(seeded(section * 7) * 360)
      ctx.fillStyle = `hsl(${hue}, 50%, 74%)`
      ctx.fillRect(24, y, W - 48, h)
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 16px sans-serif'
      ctx.fillText(`示意配图 #${section}`, 48, y + h / 2)
      ctx.fillStyle = '#dfe4ef'
      ctx.fillRect(24, y + h + 12, W - 120, 10)
      y += h + 44
    }
    section++
  }

  const files: File[] = []
  for (let k = 0; k < count; k++) {
    const slice = sliceCanvas(full, 0, k * stride, W, Math.min(sliceH, totalH - k * stride))
    files.push(await canvasToFile(slice, `示例长图-${k + 1}.jpg`))
  }
  return files
}

/* 模拟相机横向平移拍摄的全景照片,横向切片并保留重叠区 */
export async function createPanoramaDemoFiles(count = 6): Promise<File[]> {
  const H = 600
  const sliceW = 600
  const overlap = 150
  const stride = sliceW - overlap
  const totalW = sliceW + (count - 1) * stride

  const full = document.createElement('canvas')
  full.width = totalW
  full.height = H
  const ctx = full.getContext('2d')!

  /* 天空 */
  const sky = ctx.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#6db6ee')
  sky.addColorStop(0.55, '#cfe8f9')
  sky.addColorStop(1, '#f2f7e9')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, totalW, H)

  /* 太阳 */
  const sunX = totalW * 0.72
  const sunY = 130
  const glow = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, 90)
  glow.addColorStop(0, '#fff7d6')
  glow.addColorStop(1, 'rgba(255, 247, 214, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(sunX - 90, sunY - 90, 180, 180)
  ctx.fillStyle = '#ffe89a'
  ctx.beginPath()
  ctx.arc(sunX, sunY, 36, 0, Math.PI * 2)
  ctx.fill()

  /* 远山:整段连续的正弦轮廓,切片后能正确衔接 */
  const ridge = (base: number, amp: number, freq: number, phase: number, color: string) => {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(0, H)
    for (let x = 0; x <= totalW; x += 6) {
      const y = base
        - Math.sin((x / totalW) * Math.PI * freq + phase) * amp
        - Math.sin((x / totalW) * Math.PI * freq * 2.7 + phase * 1.9) * amp * 0.4
        - Math.sin((x / totalW) * Math.PI * freq * 6.1 + phase * 3.7) * amp * 0.15
      ctx.lineTo(x, y)
    }
    ctx.lineTo(totalW, H)
    ctx.closePath()
    ctx.fill()
  }
  ridge(360, 55, 5, 0.8, '#a9c3e0')
  ridge(420, 70, 3.2, 2.4, '#7fa87f')
  ridge(470, 45, 6.5, 4.2, '#5c8a5c')

  /* 云朵:大小与位置随机 */
  for (let i = 0; i < Math.floor(totalW / 170); i++) {
    const cx = 40 + i * 170 + seeded(i * 2.1) * 120
    const cy = 45 + seeded(i * 3.7) * 90
    const s = 0.55 + seeded(i * 5.3) * 0.9
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    for (const [ox, oy, r] of [[0, 0, 22], [18, 4, 16], [-18, 5, 15], [4, -8, 15]]) {
      ctx.beginPath()
      ctx.arc(cx + ox * s, cy + oy * s, r * s, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /* 独特地标:第 k 个落在第 k 个重叠带正中央,内容各不相同,
     确保相邻切片共享一个强特征,远距离切片之间无可匹配内容 */
  const landmarks = [
    { draw: (lx: number) => {
      /* 风车 */
      ctx.fillStyle = '#e8e4da'
      ctx.beginPath(); ctx.moveTo(lx - 18, 556); ctx.lineTo(lx - 7, 410); ctx.lineTo(lx + 7, 410); ctx.lineTo(lx + 18, 556); ctx.closePath(); ctx.fill()
      ctx.fillStyle = '#c44'
      ctx.beginPath(); ctx.moveTo(lx - 11, 414); ctx.lineTo(lx + 11, 414); ctx.lineTo(lx + 7, 396); ctx.lineTo(lx - 7, 396); ctx.closePath(); ctx.fill()
      ctx.strokeStyle = '#7a5a3a'
      ctx.lineWidth = 5
      for (const a of [0.4, 1.9, 3.4, 4.9]) {
        ctx.beginPath()
        ctx.moveTo(lx, 405)
        ctx.lineTo(lx + Math.cos(a) * 52, 405 + Math.sin(a) * 52)
        ctx.stroke()
      }
      ctx.lineWidth = 1
    } },
    { draw: (lx: number) => {
      /* 红谷仓 */
      ctx.fillStyle = '#b5493e'
      ctx.fillRect(lx - 46, 486, 92, 70)
      ctx.fillStyle = '#7d332c'
      ctx.beginPath(); ctx.moveTo(lx - 58, 486); ctx.lineTo(lx, 444); ctx.lineTo(lx + 58, 486); ctx.closePath(); ctx.fill()
      ctx.fillStyle = '#e8d9b8'
      ctx.fillRect(lx - 13, 512, 26, 44)
      ctx.strokeStyle = '#7d332c'
      ctx.strokeRect(lx - 13, 512, 26, 44)
      ctx.fillStyle = '#f0e6d2'
      ctx.fillRect(lx - 32, 500, 18, 16)
      ctx.fillRect(lx + 14, 500, 18, 16)
    } },
    { draw: (lx: number) => {
      /* 湖面与小船 */
      ctx.fillStyle = '#5e93c4'
      ctx.beginPath(); ctx.ellipse(lx, 552, 95, 18, 0, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#3d6f9e'
      ctx.beginPath(); ctx.ellipse(lx, 552, 95, 18, 0, 0.2, Math.PI - 0.2); ctx.fill()
      ctx.fillStyle = '#7a4a2e'
      ctx.beginPath(); ctx.moveTo(lx - 24, 544); ctx.lineTo(lx + 24, 544); ctx.lineTo(lx + 14, 532); ctx.lineTo(lx - 14, 532); ctx.closePath(); ctx.fill()
      ctx.strokeStyle = '#e8e4da'
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(lx, 532); ctx.lineTo(lx, 498); ctx.stroke()
      ctx.fillStyle = '#f0ede4'
      ctx.beginPath(); ctx.moveTo(lx, 500); ctx.lineTo(lx + 28, 522); ctx.lineTo(lx, 522); ctx.closePath(); ctx.fill()
      ctx.lineWidth = 1
    } },
    { draw: (lx: number) => {
      /* 礁石群 */
      for (const [ox, oy, rw, rh, c] of [[-34, 0, 28, 20, '#8d8d95'], [4, -8, 36, 27, '#77777f'], [38, 2, 22, 15, '#9d9da5'], [-6, -18, 16, 12, '#a8a8b0']]) {
        ctx.fillStyle = c
        ctx.beginPath(); ctx.ellipse(lx + ox, 548 + oy, rw, rh, 0, 0, Math.PI * 2); ctx.fill()
      }
    } },
    { draw: (lx: number) => {
      /* 水塔 */
      ctx.strokeStyle = '#7a6a55'
      ctx.lineWidth = 5
      ctx.beginPath(); ctx.moveTo(lx - 16, 556); ctx.lineTo(lx - 6, 448); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(lx + 16, 556); ctx.lineTo(lx + 6, 448); ctx.stroke()
      ctx.lineWidth = 1
      ctx.fillStyle = '#6a8ab0'
      ctx.beginPath(); ctx.ellipse(lx, 428, 34, 26, 0, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#4a6a90'
      ctx.beginPath(); ctx.ellipse(lx, 418, 34, 18, 0, 0, Math.PI); ctx.fill()
      ctx.fillStyle = '#e8e4da'
      ctx.beginPath(); ctx.ellipse(lx, 402, 12, 8, 0, 0, Math.PI * 2); ctx.fill()
    } },
  ]
  landmarks.forEach((lm, k) => {
    const center = (k + 1) * stride + overlap / 2
    if (center < totalW) lm.draw(center)
  })

  /* 树木与灌木:稀疏成簇,不与地标争夺特征主导权 */
  let tx = 8
  let cluster = 0
  while (tx < totalW - 20) {
    cluster++
    const clusterX = tx
    const trees = 2 + Math.floor(seeded(cluster * 13.7) * 4)
    for (let t = 0; t < trees; t++) {
      const x = clusterX + t * (16 + seeded(cluster * 7 + t) * 20)
      if (x > totalW - 16) break
      const treeH = 26 + seeded(cluster * 3 + t * 5) * 44
      ctx.fillStyle = seeded(cluster * 9 + t) > 0.5 ? '#3e6b3e' : '#4a7a44'
      ctx.beginPath()
      ctx.moveTo(x, 560 - treeH)
      ctx.lineTo(x - 9, 560)
      ctx.lineTo(x + 9, 560)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = '#5d4a36'
      ctx.fillRect(x - 2, 550, 4, 10)
    }
    tx = clusterX + trees * 30 + 70 + seeded(cluster * 17.3) * 140
  }

  /* 地面与草地噪点 */
  ctx.fillStyle = '#4d7a4d'
  ctx.fillRect(0, 556, totalW, H - 556)
  ctx.fillStyle = 'rgba(30, 60, 30, 0.5)'
  for (let i = 0; i < Math.floor(totalW / 7); i++) {
    const gx = seeded(i * 12.9) * totalW
    const gy = 558 + seeded(i * 7.3) * (H - 560)
    ctx.fillRect(gx, gy, 3, 2)
  }

  const files: File[] = []
  for (let k = 0; k < count; k++) {
    const slice = sliceCanvas(full, k * stride, 0, Math.min(sliceW, totalW - k * stride), H)
    files.push(await canvasToFile(slice, `示例全景-${k + 1}.jpg`))
  }
  return files
}
