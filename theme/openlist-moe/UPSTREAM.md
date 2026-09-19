# OpenList Moe（同源托管的主题产物）

- 来源仓库：<https://github.com/SajunaOo/OpenList-Moe>（`dist` 分支，commit `684a3d3f2f2ae5b1d9bbdd6a06bd83f3f0343d95`）
- 版本：`OpenList Moe v1.4.0 - 202608230039`
- 作者：朱茱（<https://www.isajuna.com>），许可证 **AGPL-3.0**
- 本目录两个文件是上游构建产物**原样拷贝**，未做任何修改（头注释即 AGPL 与作者声明，必须保留）。
  注入逻辑在 `scripts/fetch-frontend.mjs` 的 `applyTheme()`：构建时把这两个文件复制到 `dist/` 根目录，并把 `<link>` / `<script>` 写进 `dist/index.html`。

校验值（防拷贝被格式化/篡改）：

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `OpenList-Moe.min.css` | 22075 | `f0b05921a8921d4945dc97935ab7890f24055aa0b6c5cf9346d1bc6d88e2f483` |
| `OpenList-Moe.min.js` | 2650 | `4c5063e656fd7ed5956585575e37578df1ca2978f1bf321a744869993b708a84` |

## 相对上游 README 的两处有意偏离

1. **不含备案信息**。上游「自定义内容」示例除 `<script>` 外还附一段 `beian-container` 与把备案号挪进 `.footer` 的 `MutationObserver` 内联脚本，本项目全部不引入。
2. **不自定义字体**。上游示例引用 Google Fonts 的 Noto Serif SC；本项目不引这个外链（CJK 字体体积大，且给页面多加一个第三方运行时依赖没必要），沿用 OpenList 默认字体。

另外注入了一段 `:root{--moe-color-theme:24 144 255}` 兜底，原因见下。

## 已知现象（不是故障）

上游 JS 用 `hexToRgb(window.OPENLIST_CONFIG.main_color)` 推导主题强调色，而 `main_color` 只有 Go 后端在输出 index.html 时会填。Worker 版留空 ⇒ 上游脚本每次加载会抛一次 `TypeError`，`--moe-color-theme` 取不到动态值（CSS 里所有 `rgb(var(--moe-color-theme)/…)` 会失效）。构建注入的 `:root` 默认值已覆盖这一点，控制台那条报错属预期，不必追查；后台「主色调」也不会同步到主题强调色。

## 更新产物

```bash
curl -fL "https://raw.githubusercontent.com/SajunaOo/OpenList-Moe/dist/css/OpenList-Moe.min.css" -o theme/openlist-moe/OpenList-Moe.min.css
curl -fL "https://raw.githubusercontent.com/SajunaOo/OpenList-Moe/dist/js/OpenList-Moe.min.js"  -o theme/openlist-moe/OpenList-Moe.min.js
```

更新后同步上表的字节数与 SHA-256，并重新 `pnpm run build`。

## 自定义背景

主题默认背景图由上游图床 `cdn.jsdmirror.com` 提供（日/夜、桌面/移动各一张）。要换成自己的图，在 `applyTheme()` 注入的 `<style>` 里补 CSS 变量即可：

```css
:root { --moe-bg-image-desktop: url("..."); --moe-bg-image-mobile: url("..."); }
.hope-ui-dark { --moe-bg-image-desktop: url("..."); --moe-bg-image-mobile: url("..."); }
```

深度定制可参考上游 `src/styles/main.scss` 的变量定义。构建时设 `THEME_MOE=off` 可完全关闭主题注入。
