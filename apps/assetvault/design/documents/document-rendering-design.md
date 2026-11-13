# 文档格式扩展设计预案 · AssetVault

> 状态：**已实现（v3.16.3，2026-11-09）** · 目标读者：主人（ARTpace）
> 决策记录（独立功能，与 RSS 无关）：本预案是 **AssetVault 工具自身的「本地资产库预览」能力增强**——让用户能在本地文件查看器里打开 docx/epub/md 等文档，像现在看 PDF 一样。格式覆盖 **Office（docx/pptx/xlsx）+ 电子书（epub）+ Markdown 渲染 + 富文本（rtf）**；要求 **完整渲染排版**。**本功能与 RSS 订阅阅读器是两条独立线，不互相依赖、不复用基建。**
> 调研依据（真实代码）：`src/library/format-registry.js`（格式单一事实源）、`src/library/local-files.js:684-751`（现有 audio/video/document 预览分支，`.md` 当前走 `showTextPreview` 纯文本，`pdf` 走浏览器 iframe，`html` 走 sandbox iframe）、`server/video-transcode.mjs`（ffmpeg 外部二进制 shell-out 范式）。

---

## 1. 现状（缺口在哪）

`format-registry.js` 现有 `document` 类：

| 格式 | 预览策略 | 实际表现 |
|------|----------|----------|
| `pdf` | `pdf` | 浏览器原生 iframe 渲染（完整） |
| `ai` | `thumb` | ffmpeg 取 PNG 缩略图 |
| `html/htm` | `html` | sandbox iframe（脚本禁用） |
| `md/markdown` + 40+ 文本后缀 | `text` | **纯文本查看器，不渲染格式** |

**缺口**：Office 三件套、epub、Markdown 排版、rtf 全部缺失或只有纯文本。本预案补齐（纯属本地资产库预览增强，与 RSS 无关），并复用现有 `pdf` iframe 通道。

---

## 2. 架构总览：双轨渲染

AssetVault 已是 Node + 浏览器 bundle 双端共用 `format-registry.js`（纯数据/纯函数）。文档渲染分两轨，按"有无高质量纯 JS 渲染器"分流：

### 轨 A · 浏览器端纯 JS（无服务端转换，零重依赖）
| 格式 | 库 | 许可证 | 渲染方式 |
|------|----|--------|----------|
| `docx` | **`docx-preview`** | **Apache-2.0** ✅ | 浏览器内高保真分页渲染（页眉/页脚/表格/图），`renderAsync(blob, container)` |
| `md`/`markdown` | **`marked`** + **`DOMPurify`** | **MIT** + **MPL-2.0 OR Apache-2.0** ✅ | markdown→HTML→DOMPurify 净化→注入（`marked` 不净化，必须配 DOMPurify 防 XSS） |
| `epub` | **`epubjs`**（或维护版 `@likecoin/epub-ts`） | **BSD-2-Clause** ✅ | 浏览器内电子书阅读器（分页/书签/CFI） |

### 轨 B · 服务端 LibreOffice headless 转换（复用现有 ffmpeg shell-out 范式）
| 格式 | 转换命令 | 落地 |
|------|----------|------|
| `pptx` | `soffice --headless --convert-to pdf` | → 复用现有 `pdf` iframe |
| `xlsx` | 同上 | → 同上 |
| `rtf` | 同上 | → 同上 |

> **为何 docx 不走 LibreOffice**：`docx-preview` 给出更贴近 Web 的高保真且**免重依赖**（LibreOffice 约 300MB+）。只有 pptx/xlsx/rtf 没有靠谱的纯 JS 渲染器，才走轨 B。这样 LibreOffice 依赖被压到最小。
> **替代方案（备选）**：若你更想要"全 Office 统一管线"，可让 docx 也走轨 B（统一 but 重依赖）。默认推荐双轨。

---

## 3. 技术选型与许可证（主人铁律：先查许可）

| 库 | 用途 | 许可证 | 处置 |
|----|------|--------|------|
| `docx-preview` | docx 浏览器渲染 | **Apache-2.0**（v0.4.x 起，非早年的 MIT）✅ | 直接 `npm i`；装的是 0.4.1 |
| `marked` | markdown→HTML | MIT ✅ | 直接 `npm i`，零依赖；装的是 18.1.3 |
| `DOMPurify` | 净化 HTML（防 XSS） | **MPL-2.0 OR Apache-2.0**（取 Apache-2.0）✅ | 直接 `npm i`；非 AGPL/copyleft 传染；装的是 3.4.17 |
| `epubjs` | epub 阅读器 | **BSD-2-Clause** ✅ | 直接 `npm i`；装的是 0.3.93 |
| **LibreOffice** | pptx/xlsx/rtf→PDF | **MPL-2.0**（代码）⚠️ | **仅 shell-out 调用二进制**，不嵌入源码 → 与项目已用的 ffmpeg（LGPL）同源 precedent，无许可问题 |

> 实际版本与许可证已按 `node_modules/<pkg>/package.json` 逐一核对，并记入 `docs/THIRD_PARTY.md`。
> 传递依赖：`jszip`（GPLv3 OR MIT，取 MIT）、`localforage`、`@xmldom/xmldom`、`path-webpack`。

> 红线：导入到本地库的文档是**不可信输入**（来源未知），`marked` 输出**必须**经 DOMPurify 净化（官方明确 warning）；epubjs 内部 iframe 也要控 sandbox。

---

## 4. 实际落地清单（v3.16.3）

> 与最初预案的三处偏差，都是读了真实代码后按既有范式修正的：
> ① `doc-pdf` 端点从 `POST /api/doc/convert` 改成 **`GET /api/doc/pdf` + root 白名单**——iframe 直连带不了 `x-sfx-local` 头，与 `/api/local/thumb`、`/api/local/play` 同鉴权口径；
> ② 纯函数/配置层落在**前端** `src/library/doc-render-state.js`（服务端无需它），并承担分派表与中文提示；
> ③ 渲染库不做模块内动态 import，而是**整个 `doc-render.js` 打成独立 bundle 懒加载**（复用 `lazy-preview.js` 范式），主包零膨胀。

### 4.1 新增
| 文件 | 角色 | 复用/对齐 |
|------|------|-----------|
| `server/doc-convert.mjs` | LibreOffice 转换：`DOC_PDF_EXTS`（注册表派生白名单）、`createSofficeProbe()`（仿 `findFfmpeg` 探测+缓存，可注入）、`sofficeArgs()`（独立 UserInstallation 防并行锁）、`convertToPdf()`（校验产物而非退出码、mtime/size 缓存、临时目录自清理） | 镜像 `video-transcode.mjs` + `externalProcessOptions()` |
| `src/library/doc-render-state.js` | 纯函数/配置层：`DOC_RENDER_MODES` 分派表、marked / DOMPurify / docx / epub 选项、`markdownToHtml()`、`hardenLinks()`、中文提示与超时常量 | 仿 `uiverse-state.mjs` 纯层 |
| `src/library/doc-render.js` | **独立 bundle 入口**：`renderMarkdown` / `renderDocx` / `renderEpub` / `renderDocument`，dispose 挂 host 供 `clearStage()` 通用清理 | 复用 `lazy-preview.js` 懒加载范式 |
| `test/library-doc-convert.test.js` | 探测/参数/缓存/产物校验，全注入无需真 LO | 11 例 |
| `test/library-doc-render.test.js` | 注册表接线、净化必调用、外链加固、提示文案 | 8 例 |
| `test/library-doc-endpoints.test.js` | 真 HTTP：守卫、root 白名单、能力位、静态 bundle 放行 | 3 例 |

### 4.2 修改
| 文件 | 改动 |
|------|------|
| `src/library/format-registry.js` | 加 11 个 `document` 组格式（docx/epub 浏览器渲染 + doc/pptx/ppt/xlsx/xls/rtf/odt/odp/ods 转 PDF）；`TEXT_PREVIEW_OVERRIDES` 让 md/markdown 从 `text` 升级为 `markdown` 渲染；`LOCAL_FORMAT_EXTS` 15→26 |
| `src/library/local-files.js` | `openFile()` document 分支按 `docRenderModeOf()` 数据驱动分派；`showDocument` 取字节、`showDocPdf` 先探测再 iframe；`clearStage()` 加通用 `__avDispose` 钩子；双层超时防转圈 |
| `server/library.mjs` | 加 `GET /api/doc/status`（`x-sfx-local` 守卫）、`GET /api/doc/pdf`（root 白名单）；`assets` 白名单放行 `/doc-render.js` |
| `server/capabilities.mjs` | `3.16.2 → 3.16.3`，加 `docRenderBundle` / `docConvertPdf` |
| `scripts/build-library.mjs` | 独立构建 `doc-render.js`，app 的 `external` 加它，桌面版同步清单加它 |
| `package.json` | devDependencies 加 `marked` / `dompurify` / `docx-preview` / `epubjs` |
| `src/library/app.css` | `.doc-render-host` / `.markdown-body` / `.docx-viewer` / `.epub-reader` 深色主题排版 |
| `docs/CHANGELOG.md` / `docs/CODEMAP.md` / `docs/THIRD_PARTY.md` | 补文档渲染条目（**不改动** `docs/platforms.md`，因文档预览并非平台/feed，仅本地库能力） |

---

## 5. 风险

- **LibreOffice 体积（最大风险）**：约 300MB+。缓解：探测 + 友好引导安装；或经 `vendor/` 打包（类比 ffmpeg 现有打包机制）。仅影响 pptx/xlsx/rtf。
- **字体替代**：缺字体时行断裂位 → 建议装 Liberation 字体（与 Arial/Times 度量兼容）。
- **epubjs sandbox**：其内部用 iframe，需在 AV 上下文验证；必要时限制 sandbox 属性。
- **XSS**：任何 untrusted markdown/HTML **必过 DOMPurify**（marked 不净化）。
- **docx-preview 大文档性能**：首屏略慢，可 Web Worker/分片（后续优化，非 MVP 阻塞）。
- **soffice 退出码不可信**：必须校验输出文件存在，否则误报成功。

---

## 6. 实施阶段 — 已全部完成

1. ✅ **Markdown + DOMPurify**：`.md` 从纯文本升级为排版渲染；真浏览器实测 `<script>` 被净化、外链带 `noopener`。
2. ✅ **EPUB**（`epubjs`）：独立 bundle 懒加载。
3. ✅ **DOCX**（`docx-preview`）：浏览器端，免重依赖。
4. ✅ **LibreOffice 转换服务 + doc-pdf**：探测/缓存/端点齐全（本机未装 LO，走「检测+友好引导」路径）。
5. ✅ **收尾**：注册表 + 预览接线 + 能力位 + 构建 + 测试 + 文档同步。

**实测抓到并修掉的两个坑**（都靠真浏览器 CDP 冒烟，Node 单测抓不到）：
- `hardenLinks()` 原传 `window.document` 却调 `new document.DOMParser()`——`DOMParser` 挂在 `window` 上，导致浏览器里整条 markdown 渲染链断掉。改为直接注入 `DOMParser` 构造器，并补上 Node 单测。
- **损坏 / 受 DRM 的 EPUB 会让 `rendition.display()` 永久 pending**，用户只看到「正在渲染…」无限转圈。加了渲染器内 15s + 前端兜底 30s 双层超时，损坏夹具实测能在 15 秒给出明确中文错误。
- 另：`DOMPurify` 经 esbuild 走 `browser` 字段选中的是 UMD **工厂函数**（`sanitize` 为 undefined），必须 `DOMPurify(window)` 才拿到实例；已加「拿不到净化器就显式抛错」的安全红线，绝不注入未净化 HTML。

---

## 7. 划界（本期不做）

- **mobi**：无纯 JS 渲染器，需 calibre 转换 → 后续扩展。
- docx-preview 的 TOC/PAGE 域局限、像素级完美还原（属已知上限）。
- 在线 Office（Office Online iframe）——依赖外网+不可控，不采用。

---

## 8. 实现时采用的默认决策（主人说「可以先实现格式的支持」，未逐项拍板，按推荐默认落地）

1. **LibreOffice 策略** → 采用「检测 + 友好引导安装」，不打包进安装包（不增体积）。`SFX_SOFFICE` 环境变量可指定路径；探测结果缓存，转换按 mtime/size 落磁盘缓存。
2. **docx 路线** → 采用浏览器 `docx-preview`（免 LO，推荐）；只有 pptx/xlsx/rtf 等才走 LO。
3. **mobi** → 本期不做（按划界）。
4. **存量 .md** → 自动升级：`TEXT_PREVIEW_OVERRIDES` 是注册表级策略，所有已索引的 .md 下次打开即排版渲染，无需迁移。

> 以上四项都是**配置缝 / 策略缝**，改起来是配置动作而非重构：格式清单在 `ROWS` 一行、`preview` 覆盖在 `TEXT_PREVIEW_OVERRIDES`、超时在 `doc-render-state.js` 常量、渲染分派在 `DOC_RENDER_MODES`。
