# Nuxt Minimal Starter

Look at the [Nuxt documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.

## Setup

Make sure to install dependencies:

```bash
# npm
npm install

# pnpm
pnpm install

# yarn
yarn install

# bun
bun install
```

## Development Server

Start the development server on `http://localhost:3000`:

```bash
# npm
npm run dev

# pnpm
pnpm dev

# yarn
yarn dev

# bun
bun run dev
```

## Production

Build the application for production:

```bash
# npm
npm run build

# pnpm
pnpm build

# yarn
yarn build

# bun
bun run build
```

Locally preview production build:

```bash
# npm
npm run preview

# pnpm
pnpm preview

# yarn
yarn preview

# bun
bun run preview
```

## GitHub Pages

站点以静态方式部署在 GitHub Pages 项目路径 `https://zy-smile.github.io/media-tools/` 下：

1. 仓库 Settings → Pages → Source 选择 **GitHub Actions**；
2. 推送到 `main` 分支（或手动触发 Deploy to GitHub Pages workflow），workflow 会以
   `NUXT_APP_BASE_URL=/media-tools/` 执行 `pnpm generate`，并把 `.output/public` 发布到 Pages。

本地开发与预览不需要设置 `NUXT_APP_BASE_URL`（默认根路径 `/`）。本地按子路径构建验证时
（Git Bash 下需加 `MSYS_NO_PATHCONV=1`，否则 `/media-tools/` 会被 MSYS 路径转换破坏）：

```bash
MSYS_NO_PATHCONV=1 NUXT_APP_BASE_URL=/media-tools/ pnpm generate
```

注意：产物内所有资源都按 base 路径引用，本地验证时需要把 `.output/public` 挂载在相同的
`/media-tools/` 子路径下（普通静态服务器默认从根路径服务，直接打开会 404）。

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
