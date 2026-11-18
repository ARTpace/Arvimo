# 3D 封面是怎么来的

卡片上一张 3D 封面，按格式分成三条路。三条路的产物都写进**同一份缩略图缓存**
（`server/thumb-cache.mjs` 的 `saveModelThumb`，key = 路径 + 大小 + mtime + 宽度 + 封面版本），
所以卡片、大图预览、画板拿到的永远是普通 PNG，不需要知道它是怎么产生的。

| 格式 | 由谁渲染 | 首次耗时 | 依赖 |
|---|---|---|---|
| glb / gltf / fbx / obj / stl / ply / 3mf | 前端 `src/library/model-thumb.js`（three.js 离屏一帧） | 0.2–2 s | 无 |
| `.blend`（带内嵌预览） | 服务端 `server/blend-preview.mjs` 直接抠文件里的图 | **几十毫秒** | 无 |
| `.blend`（无内嵌预览）、`.usd/.usda/.usdc/.usdz` | 服务端 `server/blender-thumb.mjs` 调本机 Blender | 1.5–8 s | 装 Blender |

## 为什么 .blend 先读文件而不是直接渲染

Blender 每次「带界面保存」都会把当前视口截图塞进文件：块顺序 `REND → TEST → GLOB`，
`TEST` 的载荷是 `int32 宽 + int32 高 + RGBA8 像素`，**行序自下而上、alpha 已预乘**。
128×128，最后修改时间与文件本身一致，所以不会出现「图是旧的」。
只有 `blender -b`（无界面）存的文件、以及自动保存文件没有这张图，那才需要真的渲。
参考实现：Apache Tika 的 Blender 解析器、Go 的 `blendpreview`，两者独立验证了同一布局。

提取时有三条硬保护，都是别人踩过的坑：

- **不信任文件里的长度字段**：宽度/高度/载荷全部先做上限判断（≤1024 边长、≤2 MiB 像素）；
- **压缩文件只看头部**：gzip / zstd 解压到 4 MiB 就停（`TEST` 是第 1~2 个块，永远在最前面），
  不可能为了读一张 128px 的图把 20 MB 场景整个展开；
- **读不出来就返回 null**：调用方退回 Blender，而不是抛错让整条链路挂掉。

## Blender 那一路的约束

`server/blender-thumb.py` 用 `-b --factory-startup --python-exit-code 1 -P` 运行，其中：

- `--python-exit-code 1` **必须在 `-P` 之前** —— 不加这句，脚本报错 Blender 也返回 0，构建链会以为成功；
- 打开 `.blend` 用 `use_scripts=False`，否则文件里的自动运行脚本会被执行；
- 丢掉工程自带的相机和灯，按所有网格的包围盒重新架一个 3/4 视角（工程相机经常对着空处）；
- 打开后先切 object 模式（edit/sculpt/pose 状态的工程会让一批算子失败）；
- 渲染用 **Cycles CPU**（后台模式的 EEVEE 需要可用的 GPU 离屏上下文，换台机器就可能渲不出来），
  512×512、40 采样、透明底、Standard 色彩变换（AgX 会把白模压灰）；
- 没有材质的网格补一个中性灰，否则 STL / 部分 USD 渲出来是纯黑。

## 找不到 Blender 会怎样

`findBlender()` 的探测顺序：环境变量 `AV_BLENDER` / `BLENDER` / `BLENDER_PATH` →
各固定盘 `Program Files`、`Program Files (x86)`、Steam 库 → `PATH`，多版本取最高的。
找不到时 `POST /api/local/thumb/render` 回 415 并带上原因，卡片显示占位，**不会反复重试**。

## 接口

```
POST /api/local/thumb/render      { root, rel, width? }
  → 200 { ok, source: 'blend-preview'|'blender', width, height, blender? }
  → 415 { error }        生成失败 / 这个格式不走服务端
  → 403 { error }        缺少本地请求标识，或该目录没被索引
```

`GET /api/local/thumb?root=…&rel=…` 命中缓存直接发 PNG；没命中又属于模型格式时回 415，
前端据此走「生成 → 重设 src」的流程（见 `library-view.js` 的 `onCoverError`）。

## 已知边界

- `.blend` 内嵌预览只有 128px，卡片放大到 300px 左右会偏软；要更清晰只能让 Blender 重渲。
- Draco / KTX2 压缩的 glb 走前端渲染会失败，会落到占位（Blender 那条路没接进 glb）。
- 超过 120 MB 的模型前端直接跳过；Blender 那条没有体积限制，但会跑很久。
- 同一时刻只跑一个 Blender（串行队列），几十张卡同时报错时会排队，不会把机器拖垮。

## 无扩展名的图（2026-11-14）

浏览器另存 / 生成器导出的图常常没有扩展名，文件名只有 hash 和提示词
（例：`1694414344978-2876151210-untoon,highly detailed,_lora`）。只按扩展名判格式的话，
它会被记成 `other`：`/api/local/thumb` 回 415，卡片只能显示「缩略图加载失败」。

现在 `server/image-sniff.mjs` 会在**扩展名判不出格式时**读前 32 字节魔数，
补出 png / jpg / gif / webp / bmp / tif / psd / avif / heic，然后走原来的解码链：

- `thumbFor()`：补出来的格式一律交给 sharp（自带格式探测），sharp 不可用再回 ffmpeg；
- `localMime()`：原图直出时给对的 Content-Type，`<img>` 不会再收到 octet-stream；
- `local-browse.listLocalFolder()` / `local-file-import`：`kind` / `assetType` / `ext` 一并按魔数记。

有扩展名且注册表认识的文件完全不走这条分支，扫描开销不变。
