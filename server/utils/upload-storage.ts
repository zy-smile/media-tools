import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

export const uploadRoot = join(process.cwd(), '.data', 'uploads')

export interface UploadMeta {
  uploadId: string
  fingerprint: string
  fileName: string
  storedName: string
  fileSize: number
  mimeType: string
  chunkSize: number
  totalChunks: number
  createdAt: string
  completedAt?: string
}

export function uploadIdFor(fingerprint: string) {
  return createHash('sha256').update(fingerprint).digest('hex')
}

export function safeFileName(name: string) {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim()
  return (cleaned || 'download').slice(0, 180)
}

export function uploadDir(uploadId: string) {
  if (!/^[a-f0-9]{64}$/.test(uploadId)) throw createError({ statusCode: 400, statusMessage: 'Invalid upload id' })
  return join(uploadRoot, uploadId)
}

export async function readMeta(uploadId: string): Promise<UploadMeta> {
  try {
    return JSON.parse(await readFile(join(uploadDir(uploadId), 'meta.json'), 'utf8'))
  } catch (error: any) {
    if (error?.statusCode) throw error
    throw createError({ statusCode: 404, statusMessage: 'Upload session not found' })
  }
}

export async function uploadedChunkIndexes(meta: UploadMeta) {
  let files: string[] = []
  try { files = await readdir(join(uploadDir(meta.uploadId), 'chunks')) } catch { return [] }
  const valid: number[] = []
  for (const file of files) {
    const match = /^(\d+)\.part$/.exec(file)
    if (!match) continue
    const index = Number(match[1])
    if (index < 0 || index >= meta.totalChunks) continue
    const expected = index === meta.totalChunks - 1 ? meta.fileSize - index * meta.chunkSize : meta.chunkSize
    const info = await stat(join(uploadDir(meta.uploadId), 'chunks', file))
    if (info.size === expected) valid.push(index)
  }
  return valid.sort((a, b) => a - b)
}

export async function mergeChunks(meta: UploadMeta) {
  const dir = uploadDir(meta.uploadId)
  const tempPath = join(dir, `${meta.storedName}.merging`)
  const finalPath = join(dir, meta.storedName)
  await unlink(tempPath).catch(() => {})
  try {
    for (let index = 0; index < meta.totalChunks; index++) {
      await pipeline(
        createReadStream(join(dir, 'chunks', `${index}.part`)),
        createWriteStream(tempPath, { flags: index === 0 ? 'w' : 'a' }),
      )
    }
    const info = await stat(tempPath)
    if (info.size !== meta.fileSize) {
      throw createError({ statusCode: 409, statusMessage: 'Merged file size mismatch' })
    }
    await rename(tempPath, finalPath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
  meta.completedAt = new Date().toISOString()
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  return finalPath
}

export async function ensureUploadRoot() {
  await mkdir(uploadRoot, { recursive: true })
}
