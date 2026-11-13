// 桌面版：把卡片直接拖到别的软件里。
//
// 浏览器做不到「拖出真实文件」，所以这条链路只在 Tauri 桌面版里生效 —— 由 Rust 的
// DoDragDrop 举着 CF_HDROP（磁盘上那个文件本身）。因此 Photoshop / PureRef / Krita /
// Affinity / ComfyUI / 资源管理器… 不需要逐个适配，跟从资源管理器拖过去一模一样。
//
// 为什么不用 HTML5 dragstart：dragstart 之后要先取消网页拖拽、再把卡片描述换成绝对路径
// （资产卡还要过一次服务端），等这一圈走完鼠标多半已经松开了。Rust 那边的 QueryContinueDrag
// 一看左键不在就立刻返回 DROP，拖拽当场消失 —— 表现就是「拖了完全没反应」。
// 所以这里改由指针自己判断：按下就开始预热路径，指针移过阈值的那一刻直接起系统拖放，
// 此时手还在按着，拖拽能完整走完。
//
// 卡片解析交给 drag-payload.js（注册表驱动），这里只做四件事：识别「按下并拖动」、
// 把描述换成绝对路径、起系统拖放、松手后看落点是不是我们连上的 3D 软件。
//
// 还没导出到本地的 3D 资产也让它拖：这时只有一段文字格式，但落点窗口照样认得出来，
// 松手后自动开始下载，下完再导入到刚才那个软件里。
import {createDragPayload} from './drag-payload.js';

/** exe 名（小写，含 .exe）→ 导出目标 id。查不到就是拖到了不归我们管的软件。 */
const EXE_TARGETS = [
  [/^blender/, 'blender'],
  [/^maya/, 'maya'],
  [/^3dsmax|^3ds max/, '3dsmax'],
  [/^houdini/, 'houdini'],
  [/^cinema ?4d|c4d/, 'c4d'],
  [/^unity/, 'unity'],
  [/^unrealeditor|^ue4editor|^ue5editor|^unreal/, 'unreal'],
  [/^godot/, 'godot'],
];

/** 所有可拖出的卡片：资产卡 / 本地素材包卡 / 图站图片卡，外加预览大图。 */
const DRAGGABLE = '.model-card[data-uid],.model-card[data-package],.model-card[data-pid],.local-gallery-photo';
/** 卡片上的按钮、链接、输入框都是「点」不是「拖」，按在这些地方要留给它们自己。
 *  唯一的例外是封面上的 `.preview-hit` —— 它铺满整张图，若也排除，资产卡就再也按不到图上了；
 *  点它仍然是点（我们从不取消 pointerdown），只有移过阈值才算拖。 */
const NO_DRAG = 'button:not(.preview-hit),a,input,select,textarea,label,[data-no-drag]';
/** 位移超过这个距离才算拖；低于它一律当点击，别让点卡片变成拖拽。 */
const DRAG_THRESHOLD = 5;
/** 已经判定为拖拽后，最多等这么久把路径解析出来（手一直按着，系统拖放还能接上）。 */
const RESOLVE_LIMIT = 4000;

function targetForExe(exe) {
  const name = String(exe || '').toLowerCase();
  if (!name) return '';
  for (const [pattern, id] of EXE_TARGETS) if (pattern.test(name)) return id;
  return '';
}

/** 这张卡最近一次「已保存到本地」的任务（有路径、文件还在）。 */
function savedJobFor(jobs, uid) {
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const job = jobs[i];
    if (job.uid !== uid) continue;
    if (job.state !== 'saved' || !job.filePath) continue;
    if (job.fileExists === false) continue;
    return job;
  }
  return null;
}

function failedJobFor(jobs, uid) {
  return jobs.some(job => job.uid === uid && ['failed', 'error', 'canceled'].includes(job.state));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 超时就别再等了：手离开鼠标垫那一刻系统拖放就不再成立。 */
function withLimit(promise, ms, message) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * 装配拖出能力。只在桌面版有效，浏览器里直接什么都不做。
 *
 * @param {object} options
 * @param {(message: string) => void} options.toast
 * @param {() => Array} options.jobs                    当前下载任务快照
 * @param {(uid: string) => Promise<void>} options.download
 * @param {(targetId: string, jobId: string) => Promise<void>} options.send
 * @param {(id: string) => ({id: string, label: string, kind: string}|null)} options.targetById
 * @param {() => Array} [options.packages]             本地素材包快照
 * @param {() => boolean} [options.internalDropActive] 页面内落点激活时让位给站内 DnD（演进缝）
 * @param {(event: PointerEvent) => boolean} [options.internalDropOf] 按这次按下判断是否让给站内拖放
 * @param {(items:Array) => Promise<{files:string[]}>} [options.post] 注入，便于测试
 */
export function setupDragOut({toast, jobs, download, send, targetById,
  packages = () => [], internalDropActive = () => false, internalDropOf = () => false, deferNativeDrag = () => false, post} = {}) {
  const invoke = globalThis.window?.__TAURI__?.core?.invoke;
  if (!invoke) return () => {};
  const payload = createDragPayload({packages, ...(post ? {post} : {})});
  // 标记「这一份界面由原生拖放接管」：CSS 据此禁掉图片的网页拖拽，网页版仍可拖出下载链接。
  document.documentElement.classList.add('native-drag');

  // 桌面版自己接管拖拽，所以要把 HTML5 的 draggable 摘掉：否则 WebView 会先起一个
  // 网页拖拽（拖出的是屏幕上那张缩略图），跟我们后面的系统拖放抢同一次鼠标动作。
  const release = root => {
    if (!root || root.nodeType !== 1) return;
    if (root.matches?.(DRAGGABLE)) root.draggable = false;
    root.querySelectorAll?.(DRAGGABLE).forEach(node => { node.draggable = false; });
  };
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) release(node);
  });
  const grid = document.getElementById('grid');
  if (grid) {
    release(grid);
    observer.observe(grid, {childList: true, subtree: true});
  }

  let press = null;
  let sequence = 0;
  let suppressClickUntil = 0;
  let busy = false;

  function resetPress() {
    releaseCapture();
    press = null;
    // 松手了就别再为一个不会发生的拖拽去拉原图。
    payload.cancelWarm();
    document.documentElement.classList.remove('drag-out-active');
  }

  function releaseCapture() {
    if (!press?.captureTarget) return;
    try { press.captureTarget.releasePointerCapture(press.pointerId); } catch { /* 已由系统释放 */ }
    press.captureTarget = null;
  }

  function endDrag() {
    resetPress();
    // 拖过一次就别再让这次鼠标动作顺带触发卡片的点击（会弹出预览，像拖失败了）。
    suppressClickUntil = Date.now() + 400;
  }

  /** 等这张卡的下载任务落盘；超时或失败返回 null。 */
  async function ensureSaved(uid, timeout = 9 * 60 * 1000) {
    const existing = savedJobFor(jobs(), uid);
    if (existing) return existing;
    await download(uid);
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const saved = savedJobFor(jobs(), uid);
      if (saved) return saved;
      if (failedJobFor(jobs(), uid)) return null;
      await sleep(1200);
    }
    return null;
  }

  /** 松手之后的落地动作：能导入的就导入，只不过是个普通文件拖放的就到此为止。 */
  async function deliver(uid, name, files, resolveError = '') {
    let outcome;
    try {
      // 有原件时只发布文件格式，避免目标软件优先把卡片名称当文本/普通文件。
      outcome = await invoke('start_file_drag', {files, text: files.length ? '' : name});
    } catch (error) {
      toast(`拖出失败：${error?.message || error}`);
      return;
    }
    const exe = String(outcome?.exe || '');
    // 拖回自己窗口 = 放弃，不用提示。
    if (!exe || /^assetvault/.test(exe)) return;
    const targetId = targetForExe(exe);
    const target = targetId ? targetById(targetId) : null;
    // 认不出是哪个受支持的软件：文件已经交出去了（拖到 Photoshop、PureRef 也照样是文件），
    // 静默收场，别为一次正常操作弹提示。但一份文件都没交出去时得说清原因，否则看起来就是「拖了没反应」。
    if (!target) {
      if (!files.length && resolveError) {
        toast(resolveError);
        // 还没落盘的资产：拖一次就顺手开始下载。否则用户只会看到一句「先点下载」，
        // 还得自己回下载面板找一遍，体验上仍然是「拖不动」。
        if (uid) {
          try {
            await download(uid);
            toast('已开始下载，完成后把这张卡再拖一次就能导入');
          } catch { /* 已经在队列里 / 没有权限：提示过一次就够了 */ }
        }
      }
      return;
    }
    // 图站卡 / 本地素材包卡没有下载任务：拖到 PS、PureRef 本来就是终点，别再触发下载。
    if (!uid) return;

    const job = files.length ? savedJobFor(jobs(), uid) : null;
    if (job) {
      // 引擎（Unity/Unreal/Godot）的文件拖放本身就是要的结果：拖进工程面板即导入，
      // 再走一遍复制反而会重复。只有桥接 / DCC 需要我们替它把资产建到当前场景里。
      if (target.kind === 'dir') {
        toast(`已拖给 ${target.label}${outcome.dropped ? '' : '（对方没有接收，可拖到工程面板里再试）'}`);
        return;
      }
      await send(target.id, job.id);
      return;
    }

    // 还没导出到本地：先下再导，落点软件记着，下完直接送过去。
    toast(`${name} 还没导出到本地，正在下载，完成后自动导入 ${target.label}`);
    const saved = await ensureSaved(uid);
    if (!saved) {
      toast('下载没有完成，暂时无法导入；可在下载面板里看具体原因');
      return;
    }
    await send(target.id, saved.id);
  }

  /** 真正起系统拖放：路径拿齐后立刻交给 Rust，此时鼠标还按着，OLE 才能接住。 */
  async function startDrag(token, source) {
    let files = [];
    let resolveError = '';
    if (source.items.length) {
      try {
        files = await withLimit(payload.resolve(source.items), RESOLVE_LIMIT, '准备文件超时');
      } catch (error) {
        // 资产卡还没落盘时退回「先下载、下完再交给落点软件」的老流程：拖到 Blender 仍然会
        // 自动下载并导入。图站卡 / 素材包卡没有下载任务，出错就是真的出错，直接提示。
        // 只有明确的「尚未下载」才允许模型的目标识别兜底。
        // 程序错误、路径失效或权限错误不能伪装成文件名文字交给接收软件。
        if (!source.uid || !/这个资产还没导出到本地/.test(error?.message || String(error))) {
          endDrag();
          toast(`拖出失败：${error?.message || error}`);
          return;
        }
        resolveError = error?.message || String(error);
        files = [];
      }
    }
    // 解析期间用户已经松手：这时候再去起拖放，DoDragDrop 会当场发现左键不在、
    // 立刻取消，反而像「拖一下又弹回来」。不如老实说还没准备好，让他再拖一次。
    if (!press || press.token !== token) {
      endDrag();
      if (resolveError) toast(`没来得及准备文件：${resolveError}，请再拖一次`);
      else if (files.length) toast('文件准备得慢了半拍，请再拖一次');
      return;
    }
    // OLE 接管前归还 WebView 的鼠标捕获，否则外部窗口可能收不到原生拖放。
    releaseCapture();
    await deliver(source.uid, source.label, files, resolveError);
    endDrag();
  }

  function onPointerDown(event) {
    if (event.button !== 0 || busy) return;
    if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) return;
    const target = event.target;
    // 卡片上的按钮（下载 / 导出 / 预览热区）按下去就是按钮，别抢。
    if (target?.closest?.(NO_DRAG)) return;
    const source = payload.sourceOf(target);
    if (!source) return;
    // 页面内落点（画板 / 以图搜图）成立时让位给站内拖放；按住 Alt 强制拖出到外部软件。
    // internalDropOf 给的是「这一次按下」的判断（如 Shift + 拖到画板卡），
    // 因为系统拖放一旦开始就收不到 pointermove，落点只能在这之前决定。
    if ((internalDropActive() || internalDropOf(event)) && !event.altKey) return;
    // 晚一步再摘 draggable 就来不及了：WebView 会在指针移动后立刻起网页拖拽。
    const card = target.closest?.('.model-card');
    if (card) card.draggable = false;
    const image = target.closest?.('img');
    if (image) image.draggable = false;
    if (target.matches?.('.local-gallery-photo')) target.draggable = false;
    press = {token: ++sequence, source, x: event.clientX, y: event.clientY, started: false,
      pointerId:event.pointerId, captureTarget:null};
    // 必须在按下时捕获：离开 WebView 后仍收到 move/up，才能可靠交给系统拖放。
    if (event.pointerId !== undefined && target?.setPointerCapture) {
      try { target.setPointerCapture(event.pointerId);press.captureTarget=target; } catch { /* 目标已卸载 */ }
    }
    // 按下即预热。资产卡只是本地路径换算，几十毫秒就绪；图站原图要落盘，等指针真移动了再算。
    payload.warm(target, {delay: source.items?.[0]?.type === 'asset' ? 0 : 120});
  }

  function onPointerMove(event) {
    if (!press || press.started) return;
    if ((event.buttons & 1) === 0) { resetPress(); return; }
    const dx = Math.abs(event.clientX - press.x);
    const dy = Math.abs(event.clientY - press.y);
    if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
    if (deferNativeDrag(event, press.source)) return;
    press.started = true;
    // 挡住网页自己的文本选择 / 原生拖拽，接下来这次鼠标动作归系统拖放。
    event.preventDefault();
    document.documentElement.classList.add('drag-out-active');
    busy = true;
    const {token, source} = press;
    void startDrag(token, source)
      .catch(error => toast(`拖出失败：${error?.message || error}`))
      .finally(() => { busy = false; });
  }

  function onPointerUp() {
    if (!press) return;
    // 这里还能收到 pointerup，说明系统拖放还没接管（DoDragDrop 一旦开始就由它占住鼠标）。
    // 清掉这次按下：正在解析的那次会发现「手已经松了」而放弃，不会补一个当场取消的拖拽。
    resetPress();
  }

  // 拖出之后浏览器可能还会补一个 click（点在卡片上、松在别处）：拦掉，别弹预览。
  function onClick(event) {
    if (Date.now() > suppressClickUntil) return;
    suppressClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  }

  // 悬停即预热：鼠标在资产卡上停一下就先把路径算好，真按下拖动时不必再等一次请求。
  // 只对资产卡生效（本地路径换算），图站卡要落盘原图，等真按下才值得。
  const hoverTimers = new WeakMap();
  function onPointerOver(event) {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    const card = event.target?.closest?.('.model-card[data-uid]');
    if (!card || hoverTimers.has(card)) return;
    const primed = Number(card.dataset.dragReady || 0);
    if (primed && Date.now() - primed < 20000) return;
    const timer = setTimeout(() => {
      hoverTimers.delete(card);
      card.dataset.dragReady = String(Date.now());
      payload.prefetch(card);
    }, 140);
    hoverTimers.set(card, timer);
  }

  // 鼠标只是路过：别为一个不会发生的拖拽去查一遍文件。
  function onPointerOut(event) {
    // 快速跨出窗口可能跳过边缘的 move，仍需接上原生拖放。
    if (!event.relatedTarget && press && !press.started && (event.buttons & 1)) {
      onPointerMove({buttons:event.buttons, clientX:event.clientX, clientY:event.clientY,
        altKey:true, preventDefault:()=>event.preventDefault()});
    }
    const card = event.target?.closest?.('.model-card[data-uid]');
    const timer = card && hoverTimers.get(card);
    if (!timer) return;
    clearTimeout(timer);
    hoverTimers.delete(card);
  }

  // 兜底：桌面版不接受任何网页拖拽，把缩略图当文件交出去的动作一律掐断。
  function onDragStart(event) { event.preventDefault(); }

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerUp, true);
  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('dragstart', onDragStart, true);
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('pointercancel', onPointerUp, true);
    document.removeEventListener('pointerover', onPointerOver, true);
    document.removeEventListener('pointerout', onPointerOut, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('dragstart', onDragStart, true);
    document.documentElement.classList.remove('native-drag', 'drag-out-active');
    observer.disconnect();
  };
}
