// Download-folder validation and the native Windows folder picker.
//
// Everything here exists because the "where do files land" answer has to be checked *before* a job
// starts: a queue whose target directory vanished will otherwise run a full download only to fail at
// the saving step. Keeping it out of DownloadManager leaves that class responsible for jobs, not for
// the filesystem dialogue that chooses where jobs write.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';

const isDir=p=>{try{return fs.statSync(p).isDirectory();}catch{return false;}};

/** Escape one value for single-quoted PowerShell. A quote can still appear inside a filename. */
function psQuote(value){return "'"+String(value??'').replace(/'/g,"''").replace(/[\r\n]/g,' ')+"'";}
/** Walk up to the closest directory that still exists, so the picker can open somewhere sensible
 *  even when the configured folder was deleted or sits on an unplugged drive. */
function nearestExistingDir(value){
  let current='';try{current=path.resolve(String(value||''));}catch{return '';}
  while(current&&!isDir(current)){const parent=path.dirname(current);if(parent===current)return '';current=parent;}
  return current;
}

/** Read-only directory navigation for the in-app picker; saving still uses resolveFolder. */
export async function browseFolders({folder='',initial=false}={}){
  if(typeof folder!=='string'||folder.includes('\0')||/^(\\\\|\/\/)/.test(folder))throw Error('请选择本机文件夹路径');
  if(!folder){
    const candidates=process.platform==='win32'?Array.from({length:26},(_,i)=>String.fromCharCode(65+i)+':\\'):['/'];
    const roots=await Promise.all(candidates.map(async value=>{try{await fs.promises.access(value);return {name:value,path:value};}catch{return null;}}));
    return {folder:'',parent:null,selectable:false,directories:roots.filter(Boolean)};
  }
  if(!path.isAbsolute(folder))throw Error('请输入完整的文件夹路径');
  const target=initial?nearestExistingDir(folder):folder;
  if(!target)throw Error('文件夹不存在或磁盘未连接');
  const current=await fs.promises.realpath(target);
  if(/^(\\\\|\/\/)/.test(current))throw Error('请选择本机文件夹路径');
  const directories=[];
  const handle=await fs.promises.opendir(current);
  let truncated=false;
  for await(const entry of handle){
    if(!entry.isDirectory()&&!entry.isSymbolicLink())continue;
    if(entry.isSymbolicLink()){
      try{if(!(await fs.promises.stat(path.join(current,entry.name))).isDirectory())continue;}catch{continue;}
    }
    if(directories.length>=2000){truncated=true;break;}
    directories.push({name:entry.name,path:path.join(current,entry.name)});
  }
  directories.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  const parent=path.dirname(current);
  return {folder:current,parent:parent===current?'':parent,selectable:parent!==current,directories,truncated};
}

/**
 * The only machine-level check that decides whether the default download folder is usable: it must
 * be an absolute local path, already exist, and be writable. The `code` is what the UI maps to a
 * human sentence, so adding a failure mode means adding a code, not a second prose string in the UI.
 */
export function inspectFolder(folder){
  const value=typeof folder==='string'?folder.trim():'';
  if(!value)return {ok:false,code:'empty',message:'未设置默认保存目录，请指定下载路径。'};
  if(!path.isAbsolute(value)||/^(\\|\/\/)/.test(value)||value.includes('\0'))return {ok:false,code:'invalid',folder:value,message:'默认保存目录不是有效的本机绝对路径，请重新设置。'};
  const resolved=path.resolve(value);
  try{
    const stat=fs.statSync(resolved);
    if(!stat.isDirectory())return {ok:false,code:'not-directory',folder:resolved,message:'默认保存路径不是文件夹，请重新设置。'};
    fs.accessSync(resolved,fs.constants.W_OK);
    return {ok:true,code:'ok',folder:resolved,message:''};
  }catch(e){
    const missing=e&&['ENOENT','ENOTDIR'].includes(e.code);
    return {ok:false,code:missing?'missing':'inaccessible',folder:resolved,message:missing?'默认保存目录不存在或磁盘未连接，请重新设置下载路径。':'默认保存目录无法访问：'+(e.message||String(e))};
  }
}

/**
 * Resolves to the picked absolute path, or null when the user cancelled.
 * `windowsHide` is mandatory: the background service has no console, and without it PowerShell
 * allocates one of its own and every folder pick flashes a black window. That flag hides the child
 * console only — the folder dialogue is its own window and is unaffected.
 */
export function nativeFolderPicker(initial){
  if(process.platform!=='win32')throw Error('当前系统暂只支持 Windows 文件夹选择器，请手动输入完整路径。');
  const selected=nearestExistingDir(initial);
  const script=`Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择艺团下载目录'
$dialog.ShowNewFolderButton = $true
$initial = ${psQuote(selected)}
if ($initial -and [System.IO.Directory]::Exists($initial)) { $dialog.SelectedPath = $initial }
$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.TopMost = $true
try {
  # Consume the hidden process startup state before opening the visible modal dialog.
  $owner.Show()
  $owner.Activate()
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) } else { exit 2 }
} finally { $dialog.Dispose(); $owner.Dispose() }`;
  return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-Command',script],{windowsHide:true,encoding:'utf8',timeout:120000},(error,stdout,stderr)=>{
    if(error){if(error.code===2)return resolve(null);return reject(Error((stderr||'').trim()||error.message));}
    resolve(String(stdout||'').trim()||null);
  }));
}
