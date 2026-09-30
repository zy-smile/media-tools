export interface StitchProgress {
  percent: number
  message: string
}

export interface StitchPairScore {
  pair: [number, number]
  score: number
  model?: string | null
  counts?: Record<string, number>
}

export interface StitchDetails {
  mode?: 'longshot' | 'panorama'
  order?: number[]
  pairs?: StitchPairScore[]
  topScores?: StitchPairScore[]
  placed?: number
  stitched?: number
  bestScore?: number | null
  outputScale?: number
  inliers?: number
  failedPair?: [number, number]
}

export interface StitchResult {
  url: string
  blob: Blob
  width: number
  height: number
  details: StitchDetails | null
}

export type StitchMode = 'auto' | 'panorama' | 'longshot'

export class StitchError extends Error {
  details: StitchDetails | null
  constructor(message: string, details: StitchDetails | null) {
    super(message)
    this.details = details
  }
}

interface PendingRequest {
  id: number
  resolve: (result: StitchResult) => void
  reject: (err: Error) => void
}

export function useStitchWorker() {
  let worker: Worker | null = null
  let seq = 0
  let pending: PendingRequest | null = null

  const busy = ref(false)
  const progress = ref<StitchProgress>({ percent: 0, message: '' })

  function ensureWorker(): Worker {
    if (worker) return worker
    worker = new Worker('/workers/stitch.worker.js')
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data
      const request = pending
      if (!request || msg.id !== request.id) return
      if (msg.ev === 'progress') {
        progress.value = { percent: msg.percent, message: msg.message }
      } else if (msg.ev === 'result') {
        finish()
        request.resolve({
          url: URL.createObjectURL(msg.blob),
          blob: msg.blob,
          width: msg.width,
          height: msg.height,
          details: msg.details ?? null,
        })
      } else if (msg.ev === 'error') {
        finish()
        request.reject(new StitchError(msg.message, msg.details ?? null))
      }
    }
    worker.onerror = (event: ErrorEvent) => {
      const request = pending
      if (!request) return
      finish()
      request.reject(new StitchError(`拼接过程发生异常:${event.message}`, null))
    }
    return worker
  }

  function finish() {
    busy.value = false
    pending = null
  }

  function stitch(
    bitmaps: ImageBitmap[],
    mode: StitchMode,
    format: 'image/png' | 'image/jpeg' = 'image/png',
  ): Promise<StitchResult> {
    if (busy.value) return Promise.reject(new StitchError('已有拼接任务正在进行中', null))
    if (bitmaps.length < 2) return Promise.reject(new StitchError('至少需要两张图片才能拼接', null))
    busy.value = true
    progress.value = { percent: 0, message: '准备中…' }
    const id = ++seq
    return new Promise<StitchResult>((resolve, reject) => {
      pending = { id, resolve, reject }
      ensureWorker().postMessage(
        { id, cmd: 'stitch', bitmaps, mode, format },
        bitmaps,
      )
    })
  }

  function dispose() {
    if (worker) {
      worker.terminate()
      worker = null
    }
    if (pending) {
      pending.reject(new StitchError('拼接已取消', null))
      pending = null
    }
    busy.value = false
  }

  onScopeDispose(dispose)

  return { stitch, progress, busy, dispose }
}
