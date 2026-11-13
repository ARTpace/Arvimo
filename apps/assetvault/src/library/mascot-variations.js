import {MASCOT_SCENE_MOTIONS} from './mascot-motions.js';
// One shuffle bag per interaction: exhaust all combinations before starting a new round.
export const MASCOT_VARIATIONS={
 category:[['focused','none'],['curious','idea'],['proud','success'],['excited','none']],
 greeting:[['wink','hearts'],['happy','music'],['shy','flower'],['cool','sparkles'],['happy','none'],['wink','sparkles'],['proud','none'],['curious','bubbles'],['love','hearts'],['shy','none'],['excited','flower'],['happy','bubbles']],
 'search:busy':[['focused','none'],['focused','orbit'],['curious','none'],['excited','idea']],
 'search:done':[['happy','sparkles'],['proud','success'],['excited','confetti'],['wink','flower']],
 'search:error':[['worried','none'],['worried','sweat'],['curious','question'],['dizzy','sweat']],
 empty:[['curious','question'],['worried','idea'],['surprised','question'],['curious','bubbles']],
 'download:started':[['focused','download'],['excited','download'],['curious','download'],['focused','orbit']],
 'download:completed':[['happy','sparkles'],['proud','success'],['excited','confetti'],['love','hearts']],
 'download:failed':[['worried','none'],['worried','sweat'],['curious','question'],['dizzy','rain']],
 'update:available':[['happy','idea'],['excited','sparkles'],['surprised','idea'],['curious','question']],
 'update:ready':[['happy','sparkles'],['proud','success'],['excited','confetti'],['wink','flower']],
 'update:downloading':[['focused','download'],['focused','orbit'],['excited','download'],['curious','download']],
 'update:error':[['worried','sweat'],['curious','question'],['worried','none'],['dizzy','rain']]
};

export function createMascotVariations(random=Math.random){
 const states=new Map();
 return (scene,key)=>{
  const options=MASCOT_VARIATIONS[scene];if(!options)return {};
  let state=states.get(scene);
  if(!state){state={remaining:[],last:-1,key:undefined};states.set(scene,state);}
  if(key!==undefined&&state.key===key&&state.last>=0){const [expression,effect]=options[state.last];return {expression,effect,motion:state.motion};}
  if(!state.remaining.length)state.remaining=options.map((_,i)=>i);
  const candidates=state.remaining.filter(i=>i!==state.last);
  const index=candidates[Math.floor(random()*candidates.length)];
  state.remaining.splice(state.remaining.indexOf(index),1);state.last=index;state.key=key;
  const motions=(MASCOT_SCENE_MOTIONS[scene]||['idle']).filter(value=>value!==state.motion);
  state.motion=motions[Math.floor(random()*motions.length)]||'idle';
  const [expression,effect]=options[index];return {expression,effect,motion:state.motion};
 };
}
