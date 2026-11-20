import {normalizeRows,rowsFromState,queryAssets} from './library-query.mjs';

// ponytail: use the library's active/trash, type and query semantics; never crawl disk or import again.
export async function searchCollectedLibrary(storage,{queries,filters,limit}){
 let rows;
 try{if(await storage?.ensureIndex?.())rows=await storage.withDb(conn=>conn&&normalizeRows(conn.all('SELECT * FROM assets',[]),conn.all('SELECT uid, kind, tag FROM tags',[])));}catch{/* Same memory fallback as the library query API. */}
 if(!rows){if(!storage?.readRawState)throw Error('资产库查询不可用');rows=rowsFromState(await storage.readRawState());}
 const byUid=new Map(rows.map(row=>[row.uid,row])),items=new Map();
 for(const q of queries){
  const result=queryAssets({rows,q,filters,limit,sort:'recent',uidScope:'page'});
  for(const uid of result.uids){const row=byUid.get(uid);if(row)items.set(uid,{...row.model,uid,key:`library:${uid}`,assetType:row.kind,_libraryExisting:true});}
 }
 return [...items.values()].slice(0,limit);
}
