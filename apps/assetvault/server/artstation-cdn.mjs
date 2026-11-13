// ArtStation CDN path rules — the one place that knows how cover images are laid out.
//
// The site's thumbnail pipeline nests the square rendition inside a timestamp folder:
//   …/p/assets/images/images/013/225/918/20181004021932/smaller_square/name.jpg
// while every other rendition is a *sibling* of that folder:
//   …/p/assets/images/images/013/225/918/medium/name.jpg
// Swapping only the rendition name therefore keeps the timestamp and asks the bucket for an object
// that was never written — it answers 403 `application/xml`, which left ~39% of the ArtStation grid
// covers blank (search only advertises `smaller_square_cover_url`).
//
// So the rule is structural, never a list of rendition names: the tail of a CDN asset path is
// `<rendition>/<file>`, a timestamp folder may sit in front of it and has to be dropped, and the
// rendition itself is whatever the caller asks for. Renaming or adding renditions upstream cannot
// silently break the rewrite.
import {isArtstationHost} from './public-http.mjs';

/** Rendition the model grid asks for (the square one the search API advertises is too small). */
export const ARTSTATION_COVER_RENDITION='medium';
/** Largest rendition a visitor may actually fetch. ArtStation stores an `original` sibling, but the
 *  CDN answers 403 `application/xml` for it to anyone but the author, so `large` *is* the original
 *  pixels as far as a download is concerned. Never ask for `original`; it fails on every asset. */
export const ARTSTATION_DOWNLOAD_RENDITION='large';
/** Fallbacks the image proxy walks (best first) when the wanted rendition was never generated. */
export const ARTSTATION_COVER_LADDER=Object.freeze(['medium','large','small']);
/** Every rendition a cover request may name. The list is the whole vocabulary: names like `micro`,
 *  `card` or `thumbnail` are not bucket objects at all, and an unknown rendition answers 403 with an
 *  XML body, so an unvalidated rendition would turn a bad request into a broken thumbnail. */
export const ARTSTATION_COVER_RENDITIONS=Object.freeze(['small','medium','large']);
/** `YYYYMMDDHHMMSS`-style folder ArtStation inserts only around the square renditions. */
const TIMESTAMP_FOLDER=/^\d{10,16}$/;

/** HTTPS ArtStation CDN URL, or null — the only URLs these rules may ever touch. */
export function artstationCdnUrl(raw){
  try{
    const u=new URL(String(raw||''));
    return u.protocol==='https:'&&isArtstationHost(u.hostname)?u:null;
  }catch{return null;}
}

/** Repoint a CDN asset at `rendition`, dropping the timestamp folder the square renditions carry. */
export function artstationRenditionUrl(raw,rendition){
  const u=artstationCdnUrl(raw);
  if(!u)return null;
  const segments=u.pathname.split('/');
  // `<rendition>/<file>` must be the tail; a directory-ish URL has nothing to repoint.
  if(segments.length<3||!segments.at(-1))return u;
  if(TIMESTAMP_FOLDER.test(segments.at(-3)))segments.splice(segments.length-3,1);
  segments[segments.length-2]=rendition;
  u.pathname=segments.join('/');
  return u;
}

/** Grid cover URL for a search row. Returns null when the URL is not an ArtStation CDN asset. */
export function coverUrl(raw,{rendition=ARTSTATION_COVER_RENDITION}={}){
  return artstationRenditionUrl(raw,rendition)?.href??null;
}

/** Download URL for one uploaded image: the same asset repointed at the largest fetchable
 *  rendition. Returns null for anything that is not an ArtStation CDN asset, so a caller can
 *  never be tricked into downloading an arbitrary host through this path. */
export function downloadUrl(raw,{rendition=ARTSTATION_DOWNLOAD_RENDITION}={}){
  return artstationRenditionUrl(raw,rendition)?.href??null;
}

/** Candidates for one image, the requested URL first: the proxy walks them when a CDN answers 4xx.
 *  Anything that is not an ArtStation CDN URL has exactly one candidate — itself. */
export function coverLadder(raw){
  const requested=String(raw||'');
  const out=requested?[requested]:[];
  for(const rendition of ARTSTATION_COVER_LADDER){
    const next=artstationRenditionUrl(requested,rendition)?.href;
    if(next&&!out.includes(next))out.push(next);
  }
  return out;
}
