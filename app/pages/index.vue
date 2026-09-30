<script setup lang="ts">
const pages = [
  { title: '文件上传', description: '体验大文件分片与断点续传', to: '/file-upload', icon: '01' },
  { title: '屏幕录制', description: '录制屏幕、声音并下载视频', to: '/video-screen', icon: '02' },
  { title: '截图编辑', description: '截图并添加框选、箭头、文字与涂鸦', to: '/screenshot-editor', icon: '03' },
  { title: '音视频剪辑', description: '剪切、标注、混音并导出 MP4', to: '/video-editor', icon: '04' },
  { title: 'SVG 转 PNG', description: '将 SVG 矢量图转换为高分辨率 PNG 图片', to: '/svg-to-png', icon: '05' },
  { title: '图片拼接', description: '多张部分重叠的图片拼成一张完整大图', to: '/image-stitch', icon: '06' },
  { title: '视频人形轮廓检测', description: '检测视频中的人并用虚线描边生成新视频', to: '/video-contour', icon: '07' },
]
</script>

<template>
  <main class="home-page">
    <section class="home-shell">
      <p class="eyebrow">NUXT DEMO</p>
      <h1>功能导航</h1>
      <p class="intro">选择一个页面，开始体验对应功能。</p>

      <nav class="page-grid" aria-label="页面导航">
        <NuxtLink v-for="page in pages" :key="page.to" :to="page.to" class="page-card">
          <span class="page-number">{{ page.icon }}</span>
          <span class="page-copy">
            <strong>{{ page.title }}</strong>
            <small>{{ page.description }}</small>
          </span>
          <span class="arrow" aria-hidden="true">→</span>
        </NuxtLink>
      </nav>
    </section>
  </main>
</template>

<style scoped>
:global(*) { box-sizing: border-box; }
:global(body) { margin: 0; }

.home-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px 24px;
  color: #172338;
  background:
    radial-gradient(circle at 15% 15%, #dfe8ff 0, transparent 32%),
    radial-gradient(circle at 85% 85%, #e1f4e8 0, transparent 30%),
    #f7f8fc;
  font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.home-shell { width: min(880px, 100%); }
.eyebrow { margin: 0 0 8px; color: #5369ca; font-size: 12px; font-weight: 800; letter-spacing: .18em; }
h1 { margin: 0; font-size: clamp(30px, 5vw, 44px); letter-spacing: -.04em; }
.intro { margin: 8px 0 22px; color: #68748a; font-size: 15px; }
.page-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.page-card {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 14px 16px;
  border: 1px solid #e0e5ef;
  border-radius: 14px;
  color: inherit;
  background: rgba(255, 255, 255, .86);
  box-shadow: 0 8px 24px rgba(31, 45, 75, .06);
  text-decoration: none;
  transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
}
.page-card:hover { transform: translateY(-2px); border-color: #aebbf1; box-shadow: 0 12px 30px rgba(31, 45, 75, .1); }
.page-card:focus-visible { outline: 3px solid #7187e6; outline-offset: 3px; }
.page-number {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: 11px;
  color: #5268c9;
  background: #eef1ff;
  font-size: 12px;
  font-weight: 800;
}
.page-copy { display: grid; gap: 3px; min-width: 0; }
.page-copy strong { font-size: 15px; letter-spacing: -.01em; }
.page-copy small { color: #6c778a; font-size: 12px; line-height: 1.5; }
.arrow { margin-left: auto; color: #5268c9; font-size: 18px; flex-shrink: 0; }

@media (max-width: 640px) {
  .home-page { align-items: start; padding: 40px 16px; }
  .page-grid { grid-template-columns: 1fr; }
}
</style>
