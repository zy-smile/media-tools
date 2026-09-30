// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  // GitHub Pages 项目站点部署在 /<repo>/ 子路径下，由 CI 注入该环境变量；
  // 本地开发与预览默认走根路径
  app: {
    baseURL: process.env.NUXT_APP_BASE_URL || '/',
  },
  css: ['~/assets/styles/common.css'],
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  nitro: {
    prerender: {
      /* 并发预渲染时 Windows 会因缓存临时文件重命名竞争报 EPERM */
      concurrency: 1,
    },
  },
})
