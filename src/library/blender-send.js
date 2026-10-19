import {esc} from './html-esc.js';
/**
 * Blender 按钮只属于「已经下载到本地」的资产：点击是把磁盘上那个文件交给已打开的 Blender，
 * 不再走下载队列。所以能不能显示，只取决于有没有一条已保存、文件还在的任务。
 */
const SAVED='saved';
/** 同一个模型可能被导出过多次（不同目录 / 不同格式），取最后一次成功的那条。 */
export function findLocalJob(jobs,uid){
 if(!Array.isArray(jobs)||!uid)return null;
 return jobs.findLast(j=>j.uid===uid&&j.state===SAVED&&j.fileExists!==false&&j.id)||null;
}
/**
 * 一个已保存任务能不能一键进 Blender、走哪条路，全部由这里决定（卡片与预览面板共用）：
 *  - 返回 null  → 没有可导入的内容（纯图片 / ArtStation 无 Marmoset 场景 / FreeStylized Alpha 单图），不显示按钮；
 *  - 'material' → 建 PBR 材质（ambientCG、Poly Haven 贴图、FreeStylized 贴图/智能材质）；
 *  - 'hdri'     → 设世界环境（Poly Haven HDRI、FreeStylized 天空盒）；
 *  - 'model'    → 导入场景（Sketchfab、ArtStation 3D、Poly Haven 模型、Kenney、Poly Pizza、FreeStylized 模型/资源包）。
 */
export function classifyBlenderJob(job){
 if(!job?.id)return null;
 const kind=job.kind,at=job.assetType;
 if(kind==='images')return null;
 if(kind==='artstation'&&job.hasMarmoset===false)return null;
 if(kind==='freestylized'&&at==='alphas')return null;
 if(kind==='ambientcg'||kind==='polyhaven'&&at==='textures'||kind==='freestylized'&&(at==='textures'||at==='smart'))return 'material';
 if(kind==='polyhaven'&&at==='hdris'||kind==='freestylized'&&at==='skybox')return 'hdri';
 return 'model';
}
/** 没有可发送的本地文件、或资产类型根本没有可导入内容，就返回空串：卡片和预览面板共用此判定。 */
export function createBlenderButton({icon}){
 return function blenderButton({job,className='secondary',label,title}){
  const cls=classifyBlenderJob(job);
  if(cls===null)return '';
  // 交付物形态决定按钮说什么：材质没有网格（走「建材质」）、HDRI/天空盒是全景图
  // （走「设世界环境」），普通模型才是「导入场景」。文案错了用户会以为发错东西。
  const material=cls==='material',hdri=cls==='hdri';
  const text=title||(material?'把已下载的材质导入已打开的 Blender':hdri?'把已下载的 HDRI/天空盒设为已打开 Blender 的世界环境':'把已下载的模型发送到已打开的 Blender 场景');
  const name=label||(material?'材质':hdri?'环境':'发送到 Blender');
  return `<button class="${className}" data-action="blender-send" data-id="${esc(job.id)}" title="${esc(text)}" aria-label="${esc(text)}">${icon('blender')}<span>${esc(name)}</span></button>`;
 };
}
