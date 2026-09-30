import { randomUUID } from 'node:crypto'
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readMeta, uploadDir } from '../../utils/upload-storage'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const uploadId = String(query.uploadId || '')
  const index = Number(query.index)
  const meta = await readMeta(uploadId)
  if (meta.completedAt) return { ok: true, index }
  if (!Number.isInteger(index) || index < 0 || index >= meta.totalChunks) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chunk index' })
  }

  const expectedSize = index === meta.totalChunks - 1 ? meta.fileSize - index * meta.chunkSize : meta.chunkSize
  const declaredLength = Number(getHeader(event, 'content-length'))
  if (declaredLength !== expectedSize) {
    throw createError({ statusCode: 400, statusMessage: `Chunk must be ${expectedSize} bytes` })
  }
  const body = await readRawBody(event, false)
  if (!body || body.length !== expectedSize) throw createError({ statusCode: 400, statusMessage: 'Incomplete chunk body' })

  const chunksDir = join(uploadDir(uploadId), 'chunks')
  await mkdir(chunksDir, { recursive: true })
  const finalPath = join(chunksDir, `${index}.part`)
  const tempPath = join(chunksDir, `${index}.${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, body)
    const saved = await stat(tempPath)
    if (saved.size !== expectedSize) {
      throw createError({ statusCode: 500, statusMessage: 'Failed to persist chunk' })
    }
    await unlink(finalPath).catch(() => {})
    await rename(tempPath, finalPath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
  return { ok: true, index }
})
