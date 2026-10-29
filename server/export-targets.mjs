// Declarative registry of every "send to" destination plus the logic that actually delivers a
// saved download to one of them.
//
// Delivery modes, decided per target:
//  - 'bridge' (Blender): the on-disk file is pushed to an already-open Blender through the existing
//    bridge (downloads.sendToBlender). Material + model are built inside Blender, so nothing is
//    written to disk here.
//  - 'dcc': dispatch a native FBX/OBJ import and wait for the software's acknowledgement.
//  - 'dir' (engines): copy to a project; Unity also installs its existing Editor importer.
//
// The single source of truth for *which* targets exist is this file on the server and the mirrored
// TARGETS array on the client. Keeping both declarative means adding a new destination is a one-line
// entry here plus one line on the client, not a new code path.
import fsp from 'node:fs/promises';
import path from 'node:path';
import {DCC_TARGETS,dccStatus,sendDcc} from './dcc-import.mjs';
import {detectSoftware} from './software-detection.mjs';

/** Local existence check (downloads.mjs keeps its own private `exists`; mirror a tiny one here). */
const exists=async p=>{try{await fsp.stat(p);return true;}catch{return false;}};

/** id, human label, delivery mode, and what it consumes. `engine` only affects copy layout + UI. */
export const TARGETS=[
  {id:'blender', label:'Blender', kind:'bridge', engine:false, deliver:['material','model','hdri'], icon:'blender'},
  {id:'unity',   label:'Unity',   kind:'dir', engine:true,  deliver:['material','model'], icon:'unity', needsProjectPath:true},
  {id:'unreal',  label:'Unreal Engine', kind:'dir', engine:true,  deliver:['model'], icon:'unreal', needsProjectPath:true},
  {id:'godot',   label:'Godot',   kind:'dir', engine:true,  deliver:['model'], icon:'godot', needsProjectPath:true},
  {id:'maya',    label:'Maya',    kind:'dcc', engine:false, deliver:['model'], icon:'maya'},
  {id:'3dsmax',  label:'3ds Max', kind:'dcc', engine:false, deliver:['model'], icon:'max'},
  {id:'houdini', label:'Houdini', kind:'dcc', engine:false, deliver:['model'], icon:'houdini'},
  {id:'c4d',     label:'Cinema 4D', kind:'dcc', engine:false, deliver:['model'], icon:'c4d'},
];

export const targetById=id=>TARGETS.find(t=>t.id===id)||null;

const configFile=dataDir=>path.join(dataDir,'export-targets.json');

/** Read the per-target path map; missing file or unknown ids degrade to an empty map. */
export async function loadConfig(dataDir){
  try{
    const raw=await fsp.readFile(configFile(dataDir),'utf8');
    const obj=JSON.parse(raw);
    const out={};
    for(const t of TARGETS){
      if(obj[t.id]&&typeof obj[t.id].path==='string'&&obj[t.id].path.trim())out[t.id]={path:obj[t.id].path.trim()};
    }
    return out;
  }catch{return {};}
}

export async function saveConfig(dataDir,map){
  await fsp.mkdir(dataDir,{recursive:true});
  await fsp.writeFile(configFile(dataDir),JSON.stringify(map,null,2),'utf8');
}

/** Targets with their configured path + a boolean the UI uses to grey out unconfigured ones. */
export async function targetsWithStatus(dataDir,options={}){
  const cfg=await loadConfig(dataDir);
  return Promise.all(TARGETS.map(async t=>({...t,path:(cfg[t.id]&&cfg[t.id].path)||'',configured:!!(cfg[t.id]&&cfg[t.id].path),...(DCC_TARGETS.includes(t.id)?await dccStatus(dataDir,t.id,options):t.kind==='dir'?await detectSoftware(t.id,{...options,dataDir}):{})})));
}

function safeName(job){
  const base=(job.name||job.uid||'asset').replace(/[<>:"/\\|?*\x00-\x1f]+/g,'_').replace(/\s+/g,' ').trim().slice(0,80)||'asset';
  return `${base}_${String(job.uid||'').slice(0,8)}`;
}

async function copyDir(src,dest){
  await fsp.mkdir(dest,{recursive:true});
  const entries=await fsp.readdir(src,{withFileTypes:true});
  const copied=[];
  for(const e of entries){
    const s=path.join(src,e.name),d=path.join(dest,e.name);
    if(e.isDirectory()){copied.push(...await copyDir(s,d));}
    else if(e.isFile()){await fsp.copyFile(s,d);copied.push(d);}
  }
  return copied;
}

/** Recursively extract a zip into dest (used only when a job saved as an archive instead of a folder). */
async function extractZip(src,dest){
  // Defer to the system unzip when present; this is a fallback for the rare ZIP-delivery job.
  const {execFile}=await import('node:child_process');
  await fsp.mkdir(dest,{recursive:true});
  await new Promise((resolve,reject)=>{
    execFile('unzip',['-o',src,'-d',dest],err=>err?reject(err):resolve());
  });
  const out=[];
  const walk=async p=>{for(const e of await fsp.readdir(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())await walk(f);else out.push(f);}};
  await walk(dest);
  return out;
}

const UNITY_IMPORTER=`// AssetVault auto-importer — dropped next to AssetVault exports.
//
// Whenever an FBX/glTF/OBJ under Assets/AssetVault/ finishes importing, this builds a Lit material
// from the PBR textures in the same folder and saves a prefab of the model using that material.
// Best-effort: texture -> slot mapping is by filename keyword (albedo/diffuse/basecolor, normal,
// roughness, metallic, ao/arm, height, emissive). Metallic/roughness packing is approximate — a
// combined ARM map is preferred and assigned to the metallic/gloss map; separate roughness maps are
// not auto-packed. Works with URP/HDRP Lit when present, otherwise falls back to the built-in
// Standard shader. Safe to delete if you prefer to wire materials by hand.
#if UNITY_EDITOR
using UnityEngine;
using UnityEditor;
using System.IO;
using System.Linq;

public class AssetVaultImporter : AssetPostprocessor
{
    static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
    {
        foreach (var p in imported)
        {
            if (!p.Contains("/AssetVault/")) continue;
            string ext = Path.GetExtension(p).ToLower();
            if (ext == ".fbx" || ext == ".glb" || ext == ".gltf" || ext == ".obj")
                ProcessModel(p);
        }
    }

    static string SlotOf(string name)
    {
        string n = name.ToLower();
        if (n.Contains("normal")) return "normal";
        if (n.Contains("rough")) return "rough";
        if (n.Contains("metal")) return "metal";
        if (n.Contains("arm")) return "arm";
        if (n.Contains("ao") || n.Contains("occlus")) return "ao";
        if (n.Contains("height") || n.Contains("displace")) return "height";
        if (n.Contains("emiss") || n.Contains("emit")) return "emiss";
        if (n.Contains("albedo") || n.Contains("diffuse") || n.Contains("basecolor") || n.Contains("color") || n.Contains("col")) return "base";
        return "other";
    }

    static void SetTex(Material m, string urpProp, string stdProp, Texture2D t)
    {
        if (m.HasProperty(urpProp)) m.SetTexture(urpProp, t);
        else if (m.HasProperty(stdProp)) m.SetTexture(stdProp, t);
    }

    static void ProcessModel(string modelPath)
    {
        string dir = Path.GetDirectoryName(modelPath);
        var texPaths = AssetDatabase.FindAssets("t:Texture2D", new[]{ dir })
            .Select(AssetDatabase.GUIDToAssetPath)
            .Where(x => x.StartsWith(dir + Path.DirectorySeparatorChar) || x == dir)
            .ToList();
        var texs = texPaths.Select(AssetDatabase.LoadAssetAtPath<Texture2D>).Where(t => t != null).ToList();

        Shader shader = Shader.Find("Universal Render Pipeline/Lit");
        if (shader == null) shader = Shader.Find("HDRP/Lit");
        if (shader == null) shader = Shader.Find("Standard");

        string modelName = Path.GetFileNameWithoutExtension(modelPath);
        string matPath = Path.Combine(dir, modelName + "_Mat.mat");

        Material mat = AssetDatabase.LoadAssetAtPath<Material>(matPath);
        if (mat == null) { mat = new Material(shader); AssetDatabase.CreateAsset(mat, matPath); }
        else { mat.shader = shader; }

        Texture2D baseTex = null, normalTex = null, roughTex = null, metalTex = null, armTex = null, aoTex = null, heightTex = null, emissTex = null;
        foreach (var t in texs)
        {
            switch (SlotOf(t.name))
            {
                case "base": baseTex = t; break;
                case "normal": normalTex = t; break;
                case "rough": roughTex = t; break;
                case "metal": metalTex = t; break;
                case "arm": armTex = t; break;
                case "ao": aoTex = t; break;
                case "height": heightTex = t; break;
                case "emiss": emissTex = t; break;
            }
        }

        if (baseTex) SetTex(mat, "_BaseMap", "_MainTex", baseTex);
        if (normalTex) { SetTex(mat, "_BumpMap", "_BumpMap", normalTex); mat.EnableKeyword("_NORMALMAP"); }
        if (armTex) { SetTex(mat, "_MetallicGlossMap", "_MetallicGlossMap", armTex); mat.SetFloat("_Metallic", 1f); mat.SetFloat("_Smoothness", 0.8f); }
        else
        {
            if (metalTex) { SetTex(mat, "_MetallicGlossMap", "_MetallicGlossMap", metalTex); mat.SetFloat("_Metallic", 1f); }
            else mat.SetFloat("_Metallic", 0f);
            if (aoTex) SetTex(mat, "_OcclusionMap", "_OcclusionMap", aoTex);
            mat.SetFloat("_Smoothness", roughTex ? 0.6f : 0.8f);
        }
        if (heightTex) { SetTex(mat, "_ParallaxMap", "_ParallaxMap", heightTex); mat.EnableKeyword("_PARALLAXMAP"); }
        if (emissTex) SetTex(mat, "_EmissionMap", "_EmissionMap", emissTex);

        EditorUtility.SetDirty(mat);
        AssetDatabase.SaveAssets();

        var model = AssetDatabase.LoadAssetAtPath<GameObject>(modelPath);
        if (model == null) return;
        var instance = (GameObject)PrefabUtility.InstantiatePrefab(model);
        foreach (var r in instance.GetComponentsInChildren<Renderer>(true)) r.sharedMaterial = mat;
        string prefabPath = Path.Combine(dir, modelName + ".prefab");
        PrefabUtility.SaveAsPrefabAsset(instance, prefabPath);
        Object.DestroyImmediate(instance);
        AssetDatabase.Refresh();
    }
}
#endif
`;

/**
 * Deliver a saved job to a target. Returns a summary the UI shows.
 * `downloads` is the DownloadManager (its `jobs` array and `sendToBlender` are used).
 */
export async function deliverToTarget({targetId,jobId,downloads,dataDir}){
  const target=targetById(targetId);
  if(!target)throw Error(`未知的导出目标：${targetId}`);
  const job=downloads.jobs&&downloads.jobs.find(j=>j.id===jobId);
  if(!job)throw Error('找不到这个下载任务，可能已被移除');
  if(job.state!=='saved'||!job.filePath||!(await exists(job.filePath)))throw Error('这个资产还没有保存到本地，请先「导出到本地」再发送');
  if(target.kind==='dcc')return sendDcc({dataDir,target:targetId,job});

  // Bridge targets (only Blender today) reuse the existing push; nothing is written to disk here.
  if(target.kind==='bridge'){
    if(targetId==='blender'){
      const result=await downloads.sendToBlender(job);
      return {ok:true,target:targetId,mode:(job.kind==='ambientcg'&&(!job.assetType||job.assetType==='textures')||['polyhaven','ambientcg'].includes(job.kind)&&job.assetType==='hdris')?'material':'model',detail:result?.name||path.basename(job.filePath),note:'已推送到已打开的 Blender 场景'};
    }
    throw Error(`目标 ${targetId} 尚未实现桥接推送`);
  }

  // Dir targets: copy the saved folder into the configured project / content path.
  const cfg=await loadConfig(dataDir);
  const root=cfg[targetId]&&cfg[targetId].path;
  if(!root)throw Error(`${target.label} 还没有配置目标路径，请先在设置里指定工程 / 内容目录`);
  if(!(await exists(root)))throw Error(`${target.label} 的目标路径不存在：${root}`);

  const name=safeName(job);
  // Engines (Unity) put assets under Assets/; other tools drop them straight into the content folder.
  const destDir=target.engine?path.join(root,'Assets','AssetVault',name):path.join(root,'AssetVault',name);
  let copied;
  const stat=await fsp.stat(job.filePath);
  if(stat.isDirectory())copied=await copyDir(job.filePath,destDir);
  else if(/\.zip$/i.test(job.filePath))copied=await extractZip(job.filePath,destDir);
  else{copied=[destDir+path.sep+path.basename(job.filePath)];await fsp.mkdir(destDir,{recursive:true});await fsp.copyFile(job.filePath,path.join(destDir,path.basename(job.filePath)));}

  let note=`已将 ${copied.length} 个文件复制到 ${destDir}`;
  if(target.id==='unity'){
    const assetsRoot=path.join(root,'Assets');
    if(!(await exists(assetsRoot)))throw Error(`在 ${root} 下没找到 Assets 目录，请确认填的是 Unity 工程根目录（含 Assets/ 的那一层）`);
    const editorDir=path.join(assetsRoot,'Editor');
    await fsp.mkdir(editorDir,{recursive:true});
    const importerPath=path.join(editorDir,'AssetVaultImporter.cs');
    if(!(await exists(importerPath))){await fsp.writeFile(importerPath,UNITY_IMPORTER,'utf8');note+='；已写入自动导入脚本 Assets/Editor/AssetVaultImporter.cs（打开 Unity 即自动建材质 + 预制体）';}
    else note+='；自动导入脚本已存在，未覆盖';
  }
  return {ok:true,target:targetId,mode:'model',destDir,copied:copied.length,note};
}
