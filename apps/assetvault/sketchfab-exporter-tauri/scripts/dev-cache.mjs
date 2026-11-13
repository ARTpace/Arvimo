import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const ignored=new Set(['node_modules','dist','target','.git','.cache','docs','coverage','_local','src-tauri']);
const source=/\.(?:[cm]?[jt]sx?|html|css|json|toml|lock|rs|svg|png|webp|jpg|ps1)$/i;
// Metadata signatures detect edits, additions and removals without hashing large media.
export function sourceStamp(paths){
 const records=[];let newest=0;
 function visit(file){
  if(!fs.existsSync(file))return;
  const stat=fs.lstatSync(file);
  if(stat.isSymbolicLink())return;
  if(stat.isDirectory()){
   for(const name of fs.readdirSync(file).sort())if(!ignored.has(name))visit(path.join(file,name));
  }else if(source.test(file)){
   records.push(`${file}:${stat.size}:${stat.mtimeMs}`);newest=Math.max(newest,stat.mtimeMs);
  }
 }
 paths.forEach(visit);
 return {key:createHash('sha256').update(records.join('\n')).digest('hex'),newest};
}
export function needsBuild(stamp,previous,outputs){
 if(outputs.some(file=>!fs.existsSync(file)))return true;
 if(previous)return stamp.key!==previous;
 // Adopt existing outputs only when they are newer than every relevant source.
 return stamp.newest>Math.min(...outputs.map(file=>fs.statSync(file).mtimeMs));
}
