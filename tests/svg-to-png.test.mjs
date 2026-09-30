import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'

// 轻量 DOM mock: 只实现 applyIconColor 用到的属性与遍历 API
class El {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName
    this.attrs = { ...attrs }
    this.children = []
    this.textContent = ''
  }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  append(...els) { this.children.push(...els); return this }
  querySelectorAll(selector) {
    const out = []
    const walk = el => {
      for (const child of el.children) {
        if (selector === '*' || child.tagName === selector) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
}

function loadPage() {
  const source = readFileSync(new URL('../app/pages/svg-to-png.vue', import.meta.url), 'utf8')
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/import .* from 'vue'/, '')
  const code = stripTypeScriptTypes(script)
  return new Function('computed', 'onBeforeUnmount', 'ref', 'watch', `${code}; return { applyIconColor, iconColor, iconColorValue, normalizeSvg }`)(
    vue.computed, () => {}, vue.ref, vue.watch,
  )
}

function buildSvg() {
  const root = new El('svg', { viewBox: '0 0 24 24' })
  root.append(
    new El('path', { d: 'M0 0h24v24H0z', fill: '#333333' }),
    new El('path', { d: 'M1 1', fill: 'none', stroke: '#abcdef' }),
    new El('rect', { fill: 'url(#grad)' }),
    new El('path', { d: 'M2 2', fill: 'currentColor' }),
    new El('path', { d: 'M3 3', style: 'fill: red; stroke: blue; stroke-width: 2' }),
    new El('style'),
  )
  root.children.at(-1).textContent = '.cls { fill: green; stroke: none; stroke-width: 3; }\n.other { fill: url(#x); }'
  return root
}

test('applyIconColor replaces plain fill/stroke everywhere but keeps none, gradients and currentColor', () => {
  const { applyIconColor } = loadPage()
  const root = buildSvg()
  applyIconColor(root, '#00ff00')

  const [solid, outline, gradient, current, styled, styleEl] = root.children
  assert.equal(solid.getAttribute('fill'), '#00ff00')
  // none 不动,但其描边是纯色 → 替换
  assert.equal(outline.getAttribute('fill'), 'none')
  assert.equal(outline.getAttribute('stroke'), '#00ff00')
  // 渐变引用保留
  assert.equal(gradient.getAttribute('fill'), 'url(#grad)')
  // currentColor 保留,由根节点 color 解析
  assert.equal(current.getAttribute('fill'), 'currentColor')
  assert.equal(root.getAttribute('color'), '#00ff00')
  // 内联 style 的 fill/stroke 替换,无关属性不动
  assert.equal(styled.getAttribute('style'), 'fill: #00ff00; stroke: #00ff00; stroke-width: 2')
  // 根节点无 fill 属性 → 补上,覆盖默认黑色图形
  assert.equal(root.getAttribute('fill'), '#00ff00')
  // <style> 规则替换,stroke-width / url() / none 保留
  assert.equal(styleEl.textContent, '.cls { fill: #00ff00; stroke: none; stroke-width: 3; }\n.other { fill: url(#x); }')
})

test('applyIconColor keeps an explicit root fill=none so hidden shapes stay hidden', () => {
  const { applyIconColor } = loadPage()
  const root = new El('svg', { fill: 'none', stroke: '#000' })
  root.append(new El('path', { d: 'M0 0' }))
  applyIconColor(root, '#123456')
  assert.equal(root.getAttribute('fill'), 'none')
  assert.equal(root.getAttribute('stroke'), '#123456')
  assert.equal(root.children[0].getAttribute('fill'), null)
})

test('empty color (原色) leaves the SVG untouched', () => {
  const { applyIconColor } = loadPage()
  const root = buildSvg()
  const before = JSON.stringify([root.attrs, root.children.map(el => [el.attrs, el.textContent])])
  applyIconColor(root, '')
  assert.equal(JSON.stringify([root.attrs, root.children.map(el => [el.attrs, el.textContent])]), before)
})
