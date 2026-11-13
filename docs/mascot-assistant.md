# 小猫助手接入

身体动作已拆为第四层 `motion`，枚举与场景动作池见 `mascot-motions.js`。自然呼吸、静止、点头、歪头、探头、缩头、抖耳、摇摆、伸懒腰独立控制整体姿态和耳朵，表情只负责面部。`notify({type:'motion',value:'nod',duration:3000,replay:true})` 可单独播放；业务组合支持 `motion` / `motionDuration`；`reset-channel` 可仅清除 motion。真实场景在既有四组表情特效之外独立挑选合适动作，连续事件避免重复动作，重复后台通知保持选定组合。调试台新增动作卡片、单独重播／重置、循环动作和自由随机组合；随机组合只影响预览。

真实交互的外观组合统一配置在 `mascot-variations.js`：分类、问候、搜索中／完成／异常／无结果、下载开始／完成／失败、更新发现／就绪／下载中／异常共 13 类，每类 4 组。每个助手实例独立随机抽取，一轮用完才补充，跨轮不连续重复组合。重复下载通知及同一更新阶段保持原组合，避免后台轮询触发变脸。文字、按钮和三层优先级保持独立；调试台场景复用相同组合规则，手动表情／特效选择不随机化。

开发者调试台：管理员在桌面端和网站均可长按小猫 5 秒打开，访客禁用，无公开菜单。提前松开、移出或移动超过 8px 会取消，成功长按不会触发普通点击。提供表情与特效组合、重播、待机恢复、深浅背景、减少动态效果、场景模拟和消息队列查看。预览使用隔离的 Shadow DOM 和独立助手实例，场景仍调用正式 `notify`，所有操作回调只提供模拟反馈；实际队列通过 `inspect()` 只读查看，不提供修改或执行入口。关闭时释放预览队列和刷新计时器。此入口不持久化配置，也不新增服务端管理接口。

职责边界：`assistant-messages.js` 只管理消息，`mascot-assistant.js` 负责事件文案与气泡渲染，`search-motion.js` 只做视觉动效并发送交互事件。业务模块不操作气泡 DOM、不另设气泡计时器。

表情、特效、气泡各用一份独立队列，分别计时和处理优先级。业务消息仍可携带 `expression`、`effect` 一次触发三层，`expressionDuration` / `effectDuration` 可覆盖各层时长；`bubble:false` 支持无文字反馈。气泡关闭或到期不清除其他层，特效默认最多 2.6 秒，持续表情可配合短特效。各层到期恢复本层下一个有效状态。所有表情和特效枚举见 `MASCOT_EXPRESSIONS` / `MASCOT_EFFECTS`，调试台自动读取。减少动态效果模式保留表情与标记，关闭动画。

独立入口：`notify({type:'expression',value:'focused',duration:0,priority:20})` 保持表情；`notify({type:'effect',value:'sparkles',duration:2600,replay:true})` 单独重播特效；`notify({type:'bubble',message:{id,text,duration,priority}})` 单独提示；`bubble-visibility` 携带 `visible` 控制气泡显示；`reset-channel` 携带 `channel`（expression/effect/bubble）仅重置指定层。`inspect()` 返回各层只读队列，包含 `channel`。调试台支持保持表情、气泡显示开关、仅重播特效及分别重置。

当前事件入口为 `assistant.notify(event)`，由 app.js 创建并传给需要接入的模块：

- `{type:'hint', text:'分类说明'}`：普通提示，2.2 秒消失。
- `{type:'search', busy:true}` 或 `{type:'search', busy:false, ok:true}`：搜索状态，共享同一个消息 ID。
- `{type:'greeting'}`：普通问候；仅管理员桌面端会附带静默版本检查。
- `{type:'update', detail}`：已有更新模块状态，仅管理员桌面端可见。
- `{type:'message', message:{id, text, priority, duration, actions}}`：后续分类、下载等业务接入口。

消息 ID 表示同一项任务。例如批量下载可使用 `download:batchId`，后续进度和完成状态更新同一 ID，避免逐项刷屏；分类提示可使用 `category`，新选择覆盖旧选择。批量计数必须由业务模块根据真实任务提供，消息层不推测下载状态。

优先级：普通提示 10、搜索 20、更新 50；下载进度建议 20，下载失败建议 40。普通提示不会覆盖高优先级消息。低优先级消息会在自己的有效期内等候，过期即丢弃，队列最多 16 条。

`duration` 单位为毫秒，0 表示保持显示，完成或失败时应使用同 ID 替换成有限时长的结果提示。`actions` 为 `{label, run, disabled}` 数组，业务层保留操作权限和活动任务检查。更新专用消息使用 `audience:'desktop-admin'`；该权限由初始化时的真实桌面环境与访客身份决定。

相同 ID 和显示内容不会重复渲染或续期。需要关闭后不被后续进度重新弹出的长期提醒使用 `rememberDismissal:true`，明确重新打开时传 `force:true`。消息仅在内存中，不写浏览记录或本地存储。

已接入分类选择、搜索无结果与下载状态：`category` 携带 `label`；`empty` 提供清除筛选操作；`download` 携带 `phase`（started/completed/failed）和 `count`，提供查看下载操作。下载观察器复用现有队列轮询，首份快照不播历史，排队到执行不重复提醒，同批完成／失败累计合并，不播逐项进度。分类首次提供详细说明，后续简短确认。
