export const MASCOT_MOTIONS={idle:'自然呼吸',still:'静止',nod:'轻点头',tilt:'轻歪头',peek:'轻探头',duck:'轻缩头',ears:'抖耳朵',sway:'轻摇摆',stretch:'伸懒腰',bounce:'弹跳欢呼',shake:'左右甩头',dance:'开心摇摆',bow:'鞠躬致意',spring:'弹性伸展',hide:'躲藏探头'};

// Context constrains body motion; face and effects retain their own variation bags.
export const MASCOT_SCENE_MOTIONS={
 category:['nod','tilt','ears','peek'],greeting:['nod','tilt','ears','sway','peek','duck','stretch'],
 'search:busy':['idle','tilt','ears','still'],'search:done':['nod','peek','ears','sway','bounce','dance'],
 'search:error':['tilt','duck','still'],'empty':['tilt','duck','ears'],
 'download:started':['idle','nod','ears','peek'],'download:completed':['nod','peek','ears','sway','bounce','dance'],
 'download:failed':['tilt','duck','still'],
 'update:available':['tilt','peek','ears','nod','spring'],'update:ready':['nod','peek','ears','sway','bounce','dance'],
 'update:downloading':['idle','ears','still'],'update:error':['tilt','duck','still']
};
