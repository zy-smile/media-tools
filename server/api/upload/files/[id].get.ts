import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readMeta, uploadDir } from '../../../utils/upload-storage'

export default defineEventHandler(async (event) => {
  const uploadId = String(getRouterParam(event, 'id') || '')
  const meta = await readMeta(uploadId)
  if (!meta.completedAt) throw createError({ statusCode: 409, statusMessage: 'Upload is not complete' })
  const filePath = join(uploadDir(uploadId), meta.storedName)
  const info = await stat(filePath).catch(() => null)
  if (!info) throw createError({ statusCode: 404, statusMessage: 'File not found' })
  setHeader(event, 'content-type', meta.mimeType)
  setHeader(event, 'content-length', String(info.size))
  const asciiName = meta.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download'
  setHeader(event, 'content-disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(meta.fileName)}`)
  return sendStream(event, createReadStream(filePath))
})
