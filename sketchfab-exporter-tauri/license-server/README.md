# AssetVault 授权服务

一个零依赖的 Node 服务，只做两件事：**登记「密钥 → 机器」**，并签发绑定该机器的**授权文件**。
客户端拿到授权文件后完全离线运行，不再访问本服务。

```
license-server/
  server.mjs          服务本体（node server.mjs 即可跑）
  admin.mjs           管理命令行（发码 / 查激活 / 吊销 / 解绑）
  data/keys.json      密钥白名单 + 每码设备上限（★ 要备份）
  data/activations.json  激活登记：哪个码绑了哪些机器（★ 要备份）
../licensing/
  private.pem         签发私钥（★ 绝不外泄、绝不进安装包）
  pubkey.b64          公钥，已内嵌进客户端
../tools/
  keygen.mjs          离线密钥生成器
```

## 一、首次准备（只做一次）

```bash
cd sketchfab-exporter-tauri
node tools/keygen.mjs init          # 生成 Ed25519 密钥对
```

把打印出来的公钥填进 `src-tauri/src/licensing.rs` 的 `LICENSE_PUBKEY_B64`，然后重新编译客户端。
**这一步不做的话，客户端验不过任何授权。**

## 二、部署

需要一台能被用户访问到的服务器（云主机 / 轻量服务器 / 云函数都行）。要求：

1. **必须是 HTTPS**。客户端界面的 CSP 只放行 `https:`（以及本机 `127.0.0.1` 用于联调），
   裸 HTTP 公网地址会被浏览器直接拦掉，表现为「连不上授权服务」。
2. 把 `licensing/` 和 `license-server/` 一起放上去，然后：

```bash
AV_ADMIN_TOKEN=换成一个足够长的随机串 PORT=8787 node license-server/server.mjs
```

3. 把 `src-tauri/src/licensing.rs` 里的 `DEFAULT_SERVER` 改成你的地址，例如
   `https://license.你的域名/api/activate`，然后重新编译客户端。

调试时可以用环境变量临时覆盖，不必重新编译：`AV_LICENSE_SERVER=http://127.0.0.1:8787/api/activate`

## 三、发码

离线发（推荐，密钥只在你自己机器上生成）：

```bash
node tools/keygen.mjs new -n 20 --note "淘宝首批"     # 生成 20 个，每码 2 台
node tools/keygen.mjs list
```

生成后把 `license-server/data/keys.json` 同步到服务器（或直接在服务器上跑 keygen）。
也可以在线发码：

```bash
AV_ADMIN_TOKEN=xxx node license-server/admin.mjs new -n 10 --note 双十一
```

## 四、日常管理

```bash
export AV_ADMIN_TOKEN=你的令牌
export AV_SERVER=https://license.你的域名      # 管理本机服务时可省略

node license-server/admin.mjs list                       # 谁激活了、绑了哪些机器
node license-server/admin.mjs revoke AV-XXXXX-...        # 吊销（退款/盗版）
node license-server/admin.mjs restore AV-XXXXX-...       # 恢复
node license-server/admin.mjs unbind AV-XXXXX-... --index 0   # 用户换电脑：解绑第 0 台
```

`list` 里每台设备会显示机器码，让用户报机器码即可定位到要解绑哪一台。

## 五、规则说明

- **每个密钥默认 2 台设备**，永久有效（`--devices` 可改）。
- **换电脑**：用户在第二台机器上直接激活即可；第三台会被拒，需要你先 `unbind` 旧设备。
- **重装系统不影响**：机器判定用 3 个硬件因子（系统 GUID / 主板+BIOS / CPU），
  命中 2 项即视为同一台机器。重装只会丢掉系统 GUID 一项，仍能通过。
- **换硬件**同理：换主板或 CPU 各丢一项，也不会立刻失效；同时换两样才需要解绑。

## 六、备份

`data/keys.json` 丢了 = 已卖出的密钥全部无法再激活；`licensing/private.pem` 丢了 = 以后签发的授权
客户端都验不过（只能换密钥对并重新发版）。这两个务必离线备份。`data/activations.json` 丢了影响较小，
但用户机器的绑定关系会清空（老用户仍能用，因为授权文件已在本地）。
