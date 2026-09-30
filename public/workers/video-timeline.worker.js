self.onmessage = (event) => {
  const { id, duration, trimStart, trimEnd, cuts } = event.data
  const start = Math.max(0, Math.min(Number(trimStart) || 0, duration))
  const end = Math.max(start, Math.min(Number(trimEnd) || duration, duration))
  const normalizedCuts = cuts
    .map((cut) => ({
      start: Math.max(start, Math.min(Number(cut.start) || 0, end)),
      end: Math.max(start, Math.min(Number(cut.end) || 0, end)),
    }))
    .filter((cut) => cut.end - cut.start > 0.01)
    .sort((a, b) => a.start - b.start)

  const mergedCuts = []
  for (const cut of normalizedCuts) {
    const last = mergedCuts[mergedCuts.length - 1]
    if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end)
    else mergedCuts.push({ ...cut })
  }

  const segments = []
  let cursor = start
  for (const cut of mergedCuts) {
    if (cut.start > cursor) segments.push({ start: cursor, end: cut.start })
    cursor = Math.max(cursor, cut.end)
  }
  if (cursor < end) segments.push({ start: cursor, end })

  self.postMessage({
    id,
    segments,
    cuts: mergedCuts,
    outputDuration: segments.reduce((total, segment) => total + segment.end - segment.start, 0),
  })
}
