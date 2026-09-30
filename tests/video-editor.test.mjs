import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'

function editor() {
  const source = readFileSync(new URL('../app/pages/video-editor.vue', import.meta.url), 'utf8')
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/import .* from 'vue'/, '')
  const code = stripTypeScriptTypes(script)
  return new Function('computed', 'nextTick', 'onBeforeUnmount', 'onMounted', 'ref', 'watch', `${code}; return { clips, duration, selection, playhead, clipViews, outputToSourceTime, duplicateSelected, splitAtPlayhead, moveSelected, deleteSelected, undo, redo, seekTimeline, jumpEdit }`)(vue.computed, vue.nextTick, () => {}, () => {}, vue.ref, vue.watch)
}

test('duplicate, reorder and split preserve source ranges and sequence order', async () => {
  const e = editor()
  e.duration.value = 20
  e.clips.value = [{ id: 100, start: 8, end: 12 }, { id: 101, start: 0, end: 4 }]
  await vue.nextTick()
  e.selection.value = { kind: 'clip', id: 100 }
  e.duplicateSelected()
  await vue.nextTick()
  assert.deepEqual(e.clips.value.map(c => [c.start, c.end]), [[8, 12], [8, 12], [0, 4]])
  assert.equal(e.outputToSourceTime(4), 8)
  e.seekTimeline(6)
  e.splitAtPlayhead()
  await vue.nextTick()
  assert.deepEqual(e.clips.value.map(c => [c.start, c.end]), [[8, 12], [8, 10], [10, 12], [0, 4]])
  e.moveSelected(1)
  await vue.nextTick()
  assert.deepEqual(e.clips.value.map(c => [c.start, c.end]), [[8, 12], [8, 10], [0, 4], [10, 12]])
  e.undo()
  await vue.nextTick()
  assert.deepEqual(e.clips.value.map(c => [c.start, c.end]), [[8, 12], [8, 10], [10, 12], [0, 4]])
  e.redo()
  await vue.nextTick()
  assert.equal(e.clips.value.at(-1).start, 10)
  e.seekTimeline(5)
  e.jumpEdit(1)
  assert.equal(e.playhead.value, 6)
  e.jumpEdit(-1)
  assert.equal(e.playhead.value, 4)
})
