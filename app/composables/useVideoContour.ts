/* 视频人形轮廓检测:主线程负责视频解码(seek 抽帧)与编码(WebCodecs + mp4-muxer),
   OpenCV 分割与轮廓提取在 video-contour.worker.js 中进行 */

export interface VideoContourProgress {
  stage: string
  percent: number
}

export interface VideoContourResult {
  url: string
  blob: Blob
  width: number
  height: number
  frames: number
  fps: number
  duration: number
}

export type DetectRange = 'first10' | 'first30' | 'all'

const MAX_OUT_SIDE = 1280

export class VideoContourError extends Error {}

export function useVideoContour() {
  let worker: Worker | null = null
  let seq = 0

  const busy = ref(false)
  const progress = ref<VideoContourProgress>({ stage: '', percent: 0 })

  function ensureWorker(): Worker {
    if (worker) return worker
    worker = new Worker('/workers/video-contour.worker.js')
    return worker
  }

  function workerRequest(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++seq
      const w = ensureWorker()
      const timeout = setTimeout(() => {
        w.removeEventListener('message', handler)
        reject(new VideoContourError('检测内核响应超时,请重试或缩短处理范围。'))
      }, 120000)
      const handler = (event: MessageEvent) => {
        const data = event.data
        if (!data || data.id !== id) return
        clearTimeout(timeout)
        w.removeEventListener('message', handler)
        if (data.ev === 'error') reject(new VideoContourError(data.message || '检测失败'))
        else resolve(data)
      }
      w.addEventListener('message', handler)
      w.onerror = (event: ErrorEvent) => {
        clearTimeout(timeout)
        w.removeEventListener('message', handler)
        reject(new VideoContourError(`检测内核异常:${event.message || 'worker 崩溃'}`))
      }
      w.postMessage({ id, ...msg }, transfer)
    })
  }

  async function detect(file: File, range: DetectRange, onFrame?: (canvas: HTMLCanvasElement) => void): Promise<VideoContourResult> {
    if (busy.value) throw new VideoContourError('已有检测任务正在进行中')
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      throw new VideoContourError('当前浏览器不支持 WebCodecs 视频编码,请使用新版 Chrome / Edge。')
    }
    busy.value = true
    progress.value = { stage: '正在读取视频信息…', percent: 0 }
    const objectUrl = URL.createObjectURL(file)
    try {
      /* 1. 元数据 */
      const video = document.createElement('video')
      video.muted = true
      video.preload = 'auto'
      video.src = objectUrl
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve()
        video.onerror = () => reject(new VideoContourError('视频解码失败,请使用 MP4 / WebM 等浏览器可直接播放的格式。'))
      })
      const srcW = video.videoWidth
      const srcH = video.videoHeight
      if (!srcW || !srcH) throw new VideoContourError('无法读取视频画面尺寸。')
      const scale = Math.min(1, MAX_OUT_SIDE / Math.max(srcW, srcH))
      const outW = Math.max(2, Math.floor((srcW * scale) / 2) * 2)
      const outH = Math.max(2, Math.floor((srcH * scale) / 2) * 2)

      /* 2. 探测帧率 */
      progress.value = { stage: '正在探测帧率…', percent: 2 }
      const fps = await probeFps(video)
      const rangeSeconds = range === 'first10' ? 10 : range === 'first30' ? 30 : Infinity
      const duration = Math.min(video.duration || 0, rangeSeconds)
      if (!Number.isFinite(duration) || duration <= 0.1) throw new VideoContourError('无法确定视频时长。')
      const totalFrames = Math.max(1, Math.floor(duration * fps))

      /* 3. worker 预热(加载 opencv 内核与分割模型) */
      progress.value = { stage: '正在加载 OpenCV 内核与人形分割模型…', percent: 4 }
      await workerRequest({ cmd: 'init' })

      /* 4. 编码器与封装器 */
      const { Muxer, ArrayBufferTarget } = await import('mp4-muxer')
      const target = new ArrayBufferTarget()
      const muxer = new Muxer({
        target,
        video: { codec: 'avc', width: outW, height: outH },
        fastStart: 'in-memory',
      })
      const videoConfig: VideoEncoderConfig = {
        codec: 'avc1.42001f',
        width: outW,
        height: outH,
        framerate: fps,
        bitrate: Math.max(2_000_000, Math.round(outW * outH * fps * 0.09)),
        avc: { format: 'avc' },
      }
      const support = await VideoEncoder.isConfigSupported(videoConfig)
      if (!support.supported) throw new VideoContourError('当前浏览器不支持 H.264 WebCodecs 编码。')
      let encoderError: Error | null = null
      const encoder = new VideoEncoder({
        output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
        error: (err) => { encoderError = err },
      })
      encoder.configure(videoConfig)

      /* 5. 逐帧:seek 抽帧 → worker 检测 → 画虚线 → 编码 */
      const workCanvas = document.createElement('canvas')
      workCanvas.width = outW
      workCanvas.height = outH
      const workCtx = workCanvas.getContext('2d', { willReadFrequently: true })!

      const drawCtx = workCtx
      let detectedFrames = 0
      for (let index = 0; index < totalFrames; index++) {
        if (encoderError) throw encoderError
        const t = Math.min(index / fps + 0.5 / fps, duration - 0.001)
        const imageData = await seekFrame(video, t, workCanvas, drawCtx)
        const response = await workerRequest(
          { cmd: 'detect', width: outW, height: outH, buffer: imageData.data.buffer },
          [imageData.data.buffer],
        )
        if (response.ev !== 'detected') throw new VideoContourError('单帧检测失败')

        /* 画布上仍是当前帧,直接叠加人形虚线轮廓 */
        const contours = (response.contours as number[][]) ?? []
        drawCtx.save()
        drawCtx.strokeStyle = '#00e5ff'
        drawCtx.lineWidth = Math.max(2, Math.round(outW / 480))
        drawCtx.setLineDash([10, 7])
        for (const flat of contours) {
          drawCtx.beginPath()
          for (let j = 0; j < flat.length; j += 2) {
            if (j === 0) drawCtx.moveTo(flat[0], flat[1])
            else drawCtx.lineTo(flat[j], flat[j + 1])
          }
          drawCtx.closePath()
          drawCtx.stroke()
        }
        drawCtx.restore()
        onFrame?.(workCanvas)

        const frame = new VideoFrame(workCanvas, {
          timestamp: Math.round(index * 1_000_000 / fps),
          duration: Math.round(1_000_000 / fps),
        })
        encoder.encode(frame, { keyFrame: index % Math.max(1, fps * 2) === 0 })
        frame.close()
        if (encoder.encodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 0))
        detectedFrames = index + 1
        progress.value = {
          stage: `正在逐帧检测与标记… 第 ${detectedFrames}/${totalFrames} 帧`,
          percent: 5 + Math.round(90 * detectedFrames / totalFrames),
        }
      }

      /* 6. 完成封装 */
      progress.value = { stage: '正在生成视频文件…', percent: 96 }
      if (encoderError) throw encoderError
      await encoder.flush()
      if (encoderError) throw encoderError
      encoder.close()
      muxer.finalize()
      const blob = new Blob([target.buffer], { type: 'video/mp4' })
      URL.revokeObjectURL(objectUrl)
      progress.value = { stage: '完成', percent: 100 }
      return {
        url: URL.createObjectURL(blob),
        blob,
        width: outW,
        height: outH,
        frames: detectedFrames,
        fps,
        duration: detectedFrames / fps,
      }
    } catch (err) {
      URL.revokeObjectURL(objectUrl)
      throw err
    } finally {
      busy.value = false
    }
  }

  /* 用 requestVideoFrameCallback 采样 mediaTime 间隔推算帧率 */
  async function probeFps(video: HTMLVideoElement): Promise<number> {
    const anyVideo = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number
    }
    if (!anyVideo.requestVideoFrameCallback) return 30
    return new Promise<number>((resolve) => {
      const times: number[] = []
      let done = false
      const finish = () => {
        if (done) return
        done = true
        try { video.pause() } catch { /* 忽略 */ }
        const deltas = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0.001).sort((a, b) => a - b)
        const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0
        resolve(median > 0.001 ? Math.min(60, Math.max(10, Math.round(1 / median))) : 30)
      }
      const onFrame = (_now: number, meta: { mediaTime: number }) => {
        times.push(meta.mediaTime)
        if (times.length >= 12) finish()
        else anyVideo.requestVideoFrameCallback!(onFrame)
      }
      anyVideo.requestVideoFrameCallback(onFrame)
      const playPromise = video.play()
      if (playPromise) playPromise.catch(() => finish())
      setTimeout(finish, 4000)
    })
  }

  function seekFrame(
    video: HTMLVideoElement,
    t: number,
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
  ): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        video.removeEventListener('seeked', onSeeked)
        reject(new VideoContourError('视频抽帧超时,文件可能已损坏。'))
      }, 8000)
      const onSeeked = () => {
        clearTimeout(timer)
        video.removeEventListener('seeked', onSeeked)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        resolve(ctx.getImageData(0, 0, canvas.width, canvas.height))
      }
      video.addEventListener('seeked', onSeeked)
      video.currentTime = Math.max(0, t)
    })
  }

  function dispose() {
    if (worker) {
      worker.terminate()
      worker = null
    }
  }

  onScopeDispose(dispose)

  return { detect, busy, progress }
}
