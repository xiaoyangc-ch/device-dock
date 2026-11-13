# 图标

应用图标由 `script/gen-icons.mjs` 从 [Lucide](https://lucide.dev)（ISC License）生成，
输出到 `src/renderer/icon.css`，采用 CSS mask + currentColor，不再使用自绘 SVG 或图标字体。

- 许可：ISC，见 `LICENSE-lucide.txt`
- 重新生成：`npm run gen:icon`（需要 devDependencies 里的 `lucide-static`）
- 新增图标：在 `script/gen-icons.mjs` 的 `mapping` 里加一行「应用图标名 -> Lucide 图标名」
