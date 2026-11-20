# 支持的平台

AssetVault 接入的平台分三类：**3D 资产平台**（能搜索、下载并转成 GLB / FBX 收进模型库）、**图站**（贴链接或输关键词抓图，进本地图片库）与 **UI 元素平台**（搜界面动效代码，下载得到 HTML + CSS）。此外「全部平台」是一个聚合模式，不是独立站点 —— 它按统一题材并行检索下列能对上的站，对不上的站不搜。

数据源：`src/library/platforms.js`（3D 平台读 `PLATFORMS` + `PLATFORM_HOME` + `PLATFORM_KINDS`，图站读 `PICTURE_SITES`，分组读 `PICTURE_GROUP_ORDER`，UI 元素读 `UI_SITES`）。图站的官网地址由注册表里 `hosts` 的首项派生，简介取自各站 `hint`，改平台请改那里，本文档随之更新。

## 一、3D 资产平台（9 个）

| 名称 | 简介 | 官网 | 分类 | 提供内容 |
| --- | --- | --- | --- | --- |
| **Sketchfab** | 创作者分享的 3D 模型库，适合寻找角色、道具、建筑与动画资源。 | https://sketchfab.com | 3D 模型库 | 模型 |
| **ArtStation** | 艺术家作品与设计参考，支持浏览作品图片及 Marmoset 3D 场景。 | https://www.artstation.com | 3D 场景 + 作品图 | 模型、图片 |
| **Poly Haven** | CC0 模型、PBR 材质与 HDRI 环境光，适合写实场景制作。 | https://polyhaven.com | CC0 材质 / HDRI | 模型、图片 |
| **ambientCG** | 以 CC0 材质为主的资源库，涵盖环境、模型、地形及 Substance 资源。 | https://ambientcg.com | CC0 材质库 | 模型、图片 |
| **Poly Pizza** | 轻量低多边形 3D 模型，适合游戏原型与场景搭建，可按许可筛选。 | https://poly.pizza | 低多边形模型 | 模型 |
| **Kenney** | CC0 游戏资源包，按主题与系列收集模型，适合快速搭建游戏原型。 | https://kenney.nl | 3D + 2D 素材 | 模型、图片 |
| **FreeStylized** | 风格化模型、材质、天空盒与资源包，适合卡通场景及游戏制作。 | https://freestylized.com | 风格化资源 | 模型 |
| **Polyfork** | 程序化低模库：每个资产由参数生成，可调配色与比例；低模全站免费，商用免署名。 | https://polyfork.dev | 程序化低模 | 模型 |
| **Civitai 模型** | AI 绘图社区的模型库：Checkpoint / LoRA / Embedding 按版本下载原文件，保留触发词与来源信息。 | https://civitai.com | AI 模型 | 模型（需 API key） |

九个平台都支持关键词搜索。链接解析方面，Sketchfab、ArtStation 与 Civitai 模型页有专门的解析器，其余平台粘贴链接会落到通用网页解析，不保证能对得上 —— 想拿资源优先用关键词。Civitai 的原文件下载需要在「设置 → 平台模块」填写 API key；关键词检索走公开接口，不需要 key。

ArtStation / Poly Haven / ambientCG / Kenney 这四家在「图片」模式下会以镜像卡再出现一次（视角换成参考图 / 材质 / 精灵图），同一个平台开关两边同步。

## 二、图站（13 个）

| 名称 | 简介 | 官网 | 分类 | 使用方式 |
| --- | --- | --- | --- | --- |
| **Pixiv** | 二次元插画。作品页或画师主页（`users/xxx`），整站作品全抓。 | https://pixiv.net | 插画 · 动漫 | 粘贴链接 |
| **Safebooru** | 动漫图库。输入标签搜索（空格分隔多个标签），或粘标签列表页；单次最多 1000 张。 | https://safebooru.org | 插画 · 动漫 | 关键词搜索 / 粘贴链接 |
| **Yande.re** | 动漫壁纸。输入标签搜索，或粘标签页；本机网关封禁 `yande.re` 时自动回退到 Konachan 的同标签结果（标题会标明来源，下载 Referer 同步切换）。 | https://yande.re | 插画 · 动漫 | 关键词搜索 / 粘贴链接 |
| **Konachan** | 动漫壁纸。输入标签搜索；请走 `konachan.net`（`.com` 有 Cloudflare 挑战）。 | https://konachan.net | 插画 · 动漫 | 关键词搜索 / 粘贴链接 |
| **Wallhaven** | 高清壁纸。输入关键词搜索（支持 `city night` 多词），或粘搜索页 / 标签页。 | https://wallhaven.cc | 壁纸 | 关键词搜索 / 粘贴链接 |
| **Civitai** | AI 绘图。公开图库接口，最多 1000 张。 | https://civitai.com | AI 图库 | 粘贴链接 |
| **站酷 ZCOOL** | 国内设计。粘作品页（`/work/…`）、创作者主页（`/u/…`）或频道页（`/discover/…`），会自动带出作者。 | https://zcool.com.cn | 设计灵感 | 粘贴链接 |
| **Designspiration** | 设计灵感。缩略图自动升级到 736px。 | https://designspiration.com | 设计灵感 | 粘贴链接 |
| **花瓣 Huaban** | 灵感采集。直接输入关键词搜索，或粘作者主页（`/user/用户名`）看全部画板、画板页（`/boards/数字`）。 | https://huaban.com | 设计灵感 | 关键词搜索 / 粘贴链接 |
| **Pinterest** | 灵感画板。粘画板 / 作者 / 搜索页 / 直链，或直接输入关键词搜索。 | https://pinterest.com | 设计灵感 | 关键词搜索 / 粘贴链接 |
| **Pexels** | 免费摄影。直接输入关键词搜索，或粘摄影师主页（`/@名字-数字`）、单张作品页。 | https://pexels.com | 摄影图库 | 关键词搜索 / 粘贴链接 |
| **Flickr** | 摄影社区。直接输入关键词搜索，或粘摄影师主页 / 相册页 / 单张作品页。 | https://flickr.com | 摄影图库 | 关键词搜索 / 粘贴链接 |
| **500px** | 高端摄影。粘摄影师主页（`500px.com/用户名`）或作品页（`/photo/编号`）；关键词搜索站点没开放。 | https://500px.com | 摄影图库 | 粘贴链接 |

### 图站分类的分组说明

| 分组 | 说明 | 站点 |
| --- | --- | --- |
| 插画 · 动漫 | 二次元插画、角色图集与同人作品 | Pixiv、Safebooru、Yande.re、Konachan |
| 壁纸 | 高清 / 4K 壁纸与摄影背景 | Wallhaven |
| 摄影图库 | 专业摄影社区与免版权高清图库 | Pexels、Flickr、500px |
| AI 图库 | AI 生图作品与模型出图，可直接当参考 | Civitai |
| 设计灵感 | 平面、UI 与作品集类灵感采集 | 站酷、Designspiration、花瓣、Pinterest |

## 三、UI 元素平台（1 个）

产出的是**界面动效代码**，不是 3D 模型，也不是图片 —— 所以它既不进模型库也不进图片库，而是独立一条管线。

| 名称 | 简介 | 官网 | 免登录 | 使用方式 |
| --- | --- | --- | --- | --- |
| **Uiverse** | 社区 UI 组件库：按钮、加载动画、开关等动效代码。 | https://uiverse.io | 是 | 关键词搜索 / 粘贴链接 |

它跟别的平台有三处不一样：

- **卡片上是真东西，不是图**：直接渲染元素自己的 html + css，动效当场跑。官方封面图床在很多网络下连不上，本来也不该用截图 —— UI 元素的卖点就是「会动」。
- **下载得到代码文件**：`index.html` + `style.css`（样式用相对路径引，与 style.css 同目录即可工作），另附一份 `README.md` 记出处、作者、许可、标签与浏览量。
- **类型筛选换路径**：站点的 `?type=` 参数是死的（照样返回全部条目），要按类型筛只能换路径段（`/loaders`、`/buttons`…），这件事在服务端做。

链接可以粘四种：元素页（`uiverse.io/用户名/元素名`）、创作者主页（`uiverse.io/profile/用户名`）、分类页（`uiverse.io/loaders`）、总列表页（`uiverse.io/elements`）。

## 四、需要登录态的站点

下面这些站支持在应用内弹登录窗口（登录或过完人机验证后 cookie 自动入库，之后解析走纯 HTTP，不再每次开浏览器）：

站酷、花瓣、Pinterest、Pixiv、Civitai、Flickr、500px、Pexels、Designspiration、ArtStation（作品图通道）。

其余站点直接用公开接口或页面解析，无需登录 —— **Uiverse 也是免登录的**。

## 五、链接解析的边界

任何链接都被接受：能匹配到具体站点的（Sketchfab 模型页 / 作者页 / 合集、ArtStation 作品页、上面 13 个图站、Uiverse 的四种页面）走各自的解析器；匹配不上的落到通用网页解析，扫描页面里的模型链接，不会直接拒绝。

`Sketchfab 作者` 与 `Sketchfab 页面` 在结果区是两种叫法，方便判断拿到的是「这个作者的全部模型」还是「单页里扫到的模型」。
