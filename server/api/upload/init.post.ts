import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { ensureUploadRoot, safeFileName, uploadDir, uploadIdFor, uploadedChunkIndexes, type UploadMeta } from '../../utils/upload-storage'

interface InitBody {
  fingerprint?: string
  fileName?: string
  fileSize?: number
  mimeType?: string
  chunkSize?: number
  totalChunks?: number
}

export default defineEventHandler(async (event) => {
  const body = await readBody<InitBody>(event)
  const fileSize = Number(body.fileSize)
  const chunkSize = Number(body.chunkSize)
  const totalChunks = Number(body.totalChunks)
  if (!body.fingerprint || body.fingerprint.length > 500 || !body.fileName || body.fileName.length > 255 ||
      !Number.isSafeInteger(fileSize) || fileSize <= 0 || !Number.isSafeInteger(chunkSize) || chunkSize < 256 * 1024 || chunkSize > 32 * 1024 * 1024 ||
      !Number.isSafeInteger(totalChunks) || totalChunks !== Math.ceil(fileSize / chunkSize)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid upload metadata' })
  }

  await ensureUploadRoot()
  const uploadId = uploadIdFor(body.fingerprint)
  const dir = uploadDir(uploadId)
  await mkdir(join(dir, 'chunks'), { recursive: true })
  const metaPath = join(dir, 'meta.json')
  let meta: UploadMeta
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'))
    if (meta.fileSize !== fileSize || meta.chunkSize !== chunkSize || meta.totalChunks !== totalChunks) {
      throw createError({ statusCode: 409, statusMessage: 'Upload metadata does not match existing session' })
    }
  } catch (error: any) {
    if (error?.statusCode) throw error
    const fileName = safeFileName(body.fileName)
    meta = {
      uploadId,
      fingerprint: body.fingerprint,
      fileName,
      storedName: `file${extname(fileName).slice(0, 20)}`,
      fileSize,
      mimeType: String(body.mimeType || 'application/octet-stream').slice(0, 120),
      chunkSize,
      totalChunks,
      createdAt: new Date().toISOString(),
    }
    await writeFile(metaPath, JSON.stringify(meta, null, 2), { flag: 'wx' }).catch(async (error: any) => {
      if (error?.code !== 'EEXIST') throw error
      meta = JSON.parse(await readFile(metaPath, 'utf8'))
    })
  }

  const uploadedChunks = meta.completedAt ? Array.from({ length: meta.totalChunks }, (_, index) => index) : await uploadedChunkIndexes(meta)
  return {
    uploadId,
    uploadedChunks,
    completed: Boolean(meta.completedAt),
    downloadUrl: meta.completedAt ? `/api/upload/files/${uploadId}` : undefined,
  }
})
