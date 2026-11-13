/**
 * embed-host.ts —— 嵌入式宿主桥。
 *
 * 场景：Artflow 作为「画板」被嵌进另一个应用（本机 AssetVault）的 iframe 里。
 * 宿主需要两件事，而这两件事在本体里本来就有：
 *   1. 把外部资产（图片等）放进画布 —— 走本体现成的 handleAddFiles 导入管线
 *      （格式识别 → 解码 → 降采样 → 缩略图/中档代理 → 一次性入历史）。
 *   2. 读回当前画布状态 —— 走本体现成的画布快照。
 * 所以这里只做「消息 ⇄ 本体回调」的一层薄壳，不重写任何交互逻辑。
 *
 * 协议（postMessage，宿主 → 画布）：
 *   { type: 'assetvault:import', files: File[], dropPoint?: {x,y} }
 *   { type: 'assetvault:import-refs', refs: AssetReference[], dropPoint?: {x,y} } → 回 assetvault:import-result
 *   { type: 'assetvault:snapshot' }            → 回 assetvault:snapshot-result
 *   { type: 'assetvault:command', command: 'fit' | 'arrange' | 'snapshot' | 'export-document' }
 *   { type: 'assetvault:command', command: 'restore-document', document }
 * 画布 → 宿主：
 *   { type: 'assetvault:ready' }
 *   { type: 'assetvault:import-result', ok, count, message? }
 *   { type: 'assetvault:snapshot-result', elements }
 *   { type: 'assetvault:document-result', document }
 *   { type: 'assetvault:restore-result', ok }
 *
 * 之所以走 File[] 而不是传 URL：宿主侧可能拿的是本地文件、远程图、缩略图代理，
 * 统一成 File 后只由本体决定怎么解码，宿主不需要知道 artflow 的元素模型。
 * 引用导入（import-refs）则是反向的轻量通道：宿主已持有稳定 URL（如资产库本地端点），
 * 直接给 src，本体不解码、不内嵌像素，href 即 src，存档只存 URL —— 画布成为资产库的活视图。
 */

export interface EmbedSnapshotElement {
    id: string;
    type: string;
    name?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    href?: string;
}

/** 外部资产引用：画布直接以 src 为图片源渲染，不解码、不内嵌像素。 */
export interface AssetReference {
    /** 资产库稳定身份（uid），用于跨应用溯源，可选。 */
    uid?: string;
    /** 图片真实地址（AssetVault 本地资产端点或远程 CDN）。画布 img.src 直接用它。 */
    src: string;
    name?: string;
    /** 资源种类，目前只支持 image。 */
    kind?: 'image';
    mimeType?: string;
}

export interface EmbedHostCallbacks {
    /** 走本体导入管线放文件。返回实际入画布的数量。 */
    importFiles: (files: File[], dropPoint?: { x: number; y: number }) => Promise<number>;
    /** 通过外部引用（URL）放置图片：href 直接等于 src，不解码、不内嵌，存档只存 URL。
     *  dropPoint 与 importFiles 同义：宿主给落点就以它为原点，不给则落在画布原点。 */
    importReferences?: (refs: AssetReference[], dropPoint?: { x: number; y: number }) => Promise<number>;
    /** 当前画布元素快照（只读）。 */
    snapshot: () => EmbedSnapshotElement[];
    /** 缩放到刚好装下全部内容（复用本体导航器的适应算法）。 */
    fit?: () => void;
    /** 把画布上的图片/视频/形状按本体自带的瀑布流排列重排。 */
    arrange?: () => void;
    /** 导出整份工程文档（图片默认 data URL 内嵌；引用图除外，只存 URL）。宿主用它存档，刷新后原样恢复。 */
    exportDocument?: () => unknown;
    /** 用工程文档恢复画板。返回是否恢复成功。 */
    restoreDocument?: (document: unknown) => boolean;
}

export const EMBED_SOURCE = 'artflow-embed';
export const EMBED_TARGET = 'assetvault';

let callbacks: EmbedHostCallbacks | null = null;
let listening = false;

const isTrustedOrigin = (event: MessageEvent): boolean => {
    // 同源嵌入（本地服务 / Tauri 静态托管）时 origin 就是自己。
    // 不做白名单：只有能拿到本窗口引用的父页面才可能发消息，
    // 而本页不向任何第三方泄露数据，这里只挡掉明显的外部来源。
    const origin = String(event.origin || '');
    return origin === '' || origin === window.location.origin || origin === 'null';
};

const post = (message: unknown): void => {
    try {
        window.parent?.postMessage(message, '*');
    } catch {
        /* 跨域或父窗口已销毁：静默失败，不影响本体。 */
    }
};

/**
 * 注册宿主回调并开始监听消息。由本体入口（App 挂载后）调用一次。
 * 重复调用只更新回调，不重复挂监听。
 */
export const installEmbedHost = (next: EmbedHostCallbacks): void => {
    callbacks = next;
    if (!listening) {
        listening = true;
        window.addEventListener('message', event => {
        const data = event.data as { type?: string; files?: File[]; refs?: AssetReference[]; dropPoint?: { x: number; y: number }; command?: string } | null;
        if (!data || typeof data.type !== 'string') return;
        if (!data.type.startsWith(`${EMBED_TARGET}:`)) return;
        if (!isTrustedOrigin(event)) return;
        const api = callbacks;
        if (!api) return;

        if (data.type === `${EMBED_TARGET}:import`) {
            const files = Array.isArray(data.files) ? data.files : [];
            if (files.length === 0) {
                post({ type: 'assetvault:import-result', ok: false, count: 0, message: '没有可导入的文件' });
                return;
            }
            api.importFiles(files, data.dropPoint)
                .then(count => post({ type: 'assetvault:import-result', ok: true, count }))
                .catch(error => post({
                    type: 'assetvault:import-result',
                    ok: false,
                    count: 0,
                    message: error instanceof Error ? error.message : String(error),
                }));
            return;
        }

        if (data.type === `${EMBED_TARGET}:import-refs`) {
            const refs = Array.isArray(data.refs) ? data.refs : [];
            if (refs.length === 0) {
                post({ type: 'assetvault:import-result', ok: false, count: 0, message: '没有可导入的引用' });
                return;
            }
            if (!api.importReferences) {
                post({ type: 'assetvault:import-result', ok: false, count: 0, message: '宿主不支持引用导入' });
                return;
            }
            api.importReferences(refs, data.dropPoint)
                .then(count => post({ type: 'assetvault:import-result', ok: true, count }))
                .catch(error => post({
                    type: 'assetvault:import-result',
                    ok: false,
                    count: 0,
                    message: error instanceof Error ? error.message : String(error),
                }));
            return;
        }

        if (data.type === `${EMBED_TARGET}:snapshot`) {
            post({ type: 'assetvault:snapshot-result', elements: api.snapshot() });
            return;
        }

        // 命令：宿主只发意图，具体怎么做全部走本体现成的能力（适应 / 排列 / 存档）。
        if (data.type === `${EMBED_TARGET}:command`) {
            const command = (data as { command?: string }).command;
            if (command === 'fit') api.fit?.();
            else if (command === 'arrange') api.arrange?.();
            else if (command === 'snapshot') post({ type: 'assetvault:snapshot-result', elements: api.snapshot() });
            else if (command === 'export-document') post({ type: 'assetvault:document-result', document: api.exportDocument?.() ?? null });
            else if (command === 'restore-document') {
                const ok = api.restoreDocument?.((data as { document?: unknown }).document) === true;
                post({ type: 'assetvault:restore-result', ok });
            }
            return;
        }
    });
        post({ type: 'assetvault:ready' });
    }
    // 注册时也推一份快照：宿主要靠快照统计画布元素数，
    // 而宿主不会主动问（它只关心「现在有几个」），所以由本体在内容变化时主动推。
    post({ type: 'assetvault:snapshot-result', elements: next.snapshot() });
};

/** 主动把画布状态推给宿主（宿主也可主动要一份）。 */
export const pushEmbedSnapshot = (elements: EmbedSnapshotElement[]): void => {
    post({ type: 'assetvault:snapshot-result', elements });
};
