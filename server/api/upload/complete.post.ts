import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { mergeChunks, readMeta, uploadDir, uploadedChunkIndexes } from '../../utils/upload-storage'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ uploadId?: string }>(event)
  const uploadId = String(body?.uploadId || '')
  const meta = await readMeta(uploadId)
  if (!meta.completedAt) {
    const uploaded = await uploadedChunkIndexes(meta)
    if (uploaded.length !== meta.totalChunks) {
      throw createError({ statusCode: 409, statusMessage: `Missing ${meta.totalChunks - uploaded.length} chunks` })
    }
    await mergeChunks(meta)
  } else {
    await stat(join(uploadDir(uploadId), meta.storedName))
  }
  return { ok: true, downloadUrl: `/api/upload/files/${uploadId}` }
})
