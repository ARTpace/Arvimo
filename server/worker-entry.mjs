// Which module actually owns the forked worker entry point.
//
// A bare `process.argv.includes('--worker')` is NOT safe, and this file exists because it bit us:
// artstation-worker.mjs imports artstation.mjs, which imports export-worker.mjs for `browserPath`.
// Forking the ArtStation worker therefore activated export-worker's own `--worker` block as an
// import side effect. Both modules registered a `process.on('message')` handler, the Sketchfab one
// answered the ArtStation job first, found no `profile`/`output` on it (those are Sketchfab fields)
// and reported `The "path" argument must be of type string ... Received undefined` — so every
// ArtStation download died instantly while the same job ran fine in-process.
//
// Comparing `process.argv[1]` with the module's own URL cannot misfire that way: importing a worker
// module is never the same thing as being launched as the entry point.
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function isWorkerEntry(moduleUrl){
 const entry=process.argv[1];
 if(!entry)return false;
 let self;
 try{self=fileURLToPath(moduleUrl);}catch{return false;}
 // Windows paths are case-insensitive, and the drive-letter casing Node reports varies.
 const normalise=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
 return normalise(entry)===normalise(self);
}
