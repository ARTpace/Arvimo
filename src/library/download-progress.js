export const STEPS=['准备','接收资源','转换 / 打包','写入文件','校验','完成'];
/** One vocabulary for every task state, shared by the task list and the artwork panel. */
export const STATE_LABELS={queued:'等待下载',held:'暂停排队',retry_wait:'等待自动重试',running:'后台转换中',transferring:'写入暂存文件',validating:'校验文件',saving:'提交保存',cancelling:'正在取消',saved:'下载完成',failed:'下载失败',cancelled:'已取消',interrupted:'服务中断'};
/** Which states a user must watch, which ones merely wait for a slot, and which are over. */
export const ACTIVE=new Set(['running','transferring','validating','saving','cancelling']);
export const WAITING=new Set(['queued','held','retry_wait']);
export const TERMINAL=new Set(['saved','failed','cancelled','interrupted']);
/** A picture-only job: either the `images` kind, or an ArtStation artwork whose embedded Marmoset
 *  scene is absent (so the runner fetches the author's uploads instead of converting a mesh). */
export const isImageJob=t=>t.kind==='images'||(t.kind==='artstation'&&t.hasMarmoset===false);
export function progressView(t,now=Date.now()){
 const n=t.network,receiving=t.state==='running'&&n?.active>0;
 // Folder delivery has no ZIP to write or verify, so the wording follows the chosen output; a
 // scene-less ArtStation artwork has no conversion at all, only images to fetch and pack.
 const folder=t.options?.output==='folder';
 const images=isImageJob(t);
 const step=t.state==='saved'?5:t.state==='validating'||t.state==='saving'?4:t.state==='transferring'?3:receiving?1:t.state==='running'&&t.stage!=='starting'?2:0;
 let label=STEPS[step],percent=null;
 if(t.state==='saved'){label='下载完成';percent=100;}
 else if(receiving){label='接收资源中';if(n.activeTotal>0)percent=Math.min(100,Math.floor(n.activeReceived/n.activeTotal*100));}
 else if(t.state==='transferring'){label=folder?'写入导出文件夹':'写入本机文件';if(t.totalBytes>0)percent=Math.min(100,Math.floor(t.bytesWritten/t.totalBytes*100));}
 else if(t.state==='running')label=t.stage==='starting'?(images?'正在读取作品图片信息':t.kind==='artstation'?'正在识别作品中的 Marmoset 场景':'正在启动后台转换器'):(images?'下载并打包图片':'转换 / 打包中');
 else if(t.state==='validating')label=images?'正在校验作品图片与内容指纹':folder?'正在校验 GLB 与内容指纹':'正在校验 ZIP / GLB';
 else if(t.state==='saving')label=folder?'正在提交导出文件夹':'正在提交文件';
 else label=STATE_LABELS[t.state]||t.state;
 return {step,label,percent,receiving,active:['running','transferring','validating','saving','cancelling'].includes(t.state),rate:receiving&&now-(n?.updatedAt||0)<2500?n.rate:0};
}
