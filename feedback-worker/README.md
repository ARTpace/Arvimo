# AssetVault 反馈收集（Cloudflare Workers + D1）

客户端不直连这里：前端打同源 `POST /api/feedback`，由本地服务转发，
因为页面 CSP 的 `connect-src` 只放行 `'self'`。所以部署完只要把地址写进
`server/library.mjs` 的 `FEEDBACK_ENDPOINT`（或用环境变量 `AV_FEEDBACK_ENDPOINT` 覆盖）。

## 部署（一次性，约 10 分钟）

```bash
cd feedback-worker
npm i -g wrangler            # 已装可跳过
wrangler login               # 浏览器授权
wrangler d1 create assetvault-feedback
# ↑ 把输出的 database_id 填进 wrangler.toml

wrangler d1 execute assetvault-feedback --remote --file=./schema.sql
wrangler secret put SALT         # 随便一串随机字符，给 IP 哈希加盐
wrangler secret put ADMIN_TOKEN  # 后台查看口令
# 可选：企微/飞书机器人，新反馈会推一条
wrangler secret put WEBHOOK_URL
wrangler deploy
```

部署完会得到一个 `https://assetvault-feedback.<子域>.workers.dev`，把它填到
`server/library.mjs` 顶部的 `FEEDBACK_ENDPOINT`，重启服务即可。**末尾不要带斜杠。**

默认 `*.workers.dev` 在部分网络下不稳，能绑自定义域名最好：
Workers 面板 → Settings → Domains & Routes → Add custom domain。

## 看反馈

```bash
curl "https://assetvault-feedback.<子域>.workers.dev/admin?token=<ADMIN_TOKEN>&limit=50"
```

或直接在 Cloudflare 控制台的 D1 面板里跑：

```sql
SELECT created_at, type, title, body, app_version FROM feedback ORDER BY created_at DESC LIMIT 50;
```

标记状态（new / read / planned / done）：

```sql
UPDATE feedback SET status='done' WHERE id='<id>';
```

## 客户端会发什么

| 字段 | 说明 |
|---|---|
| `type` / `title` / `body` / `contact` | 用户填的内容 |
| `installId` | 首次启动生成的匿名 id，用来串同一个人的多次反馈 |
| `honeypot` | 隐藏字段，非空即判定机器人，直接 201 丢弃 |
| `context` | appVersion、engine、os、webview、platform、page、lastError、recent[] |

`recent[]` 只记 `{status, host, path}`，**不含 query**，避免把素材直链或临时签名带出去。

## 防滥用

- 蜜罐字段（不弹验证码，桌面端弹验证码的流失比垃圾反馈更贵）
- 同 IP 10 分钟最多 3 条；同 installId 每天最多 20 条
- `title` 120 / `body` 5000 字符上限，`context.recent` 截到 20 条
- 不存原始 IP，只存加盐哈希前 16 位
