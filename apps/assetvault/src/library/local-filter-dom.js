/** Keep existing rows when only selection, counts or folding changed. */
export function syncLocalFilterMarkup(panel,markup){
 const template=panel.ownerDocument.createElement('template');template.innerHTML=markup;
 const before=[...panel.querySelectorAll('*')],after=[...template.content.querySelectorAll('*')];
 const identity=node=>node.tagName+'|'+[...node.attributes].filter(attr=>attr.name.startsWith('data-')).map(attr=>attr.name+'='+attr.value).join('|');
 if(!before.length||before.length!==after.length||before.some((node,i)=>identity(node)!==identity(after[i]))){panel.innerHTML=markup;return;}
 for(let i=0;i<before.length;i++){
  const node=before[i],next=after[i];
  for(const attr of [...node.attributes])if(!next.hasAttribute(attr.name))node.removeAttribute(attr.name);
  for(const attr of next.attributes)if(node.getAttribute(attr.name)!==attr.value)node.setAttribute(attr.name,attr.value);
  if(!node.children.length&&node.textContent!==next.textContent)node.textContent=next.textContent;
 }
}

/** Native grid transitions can reverse mid-flight without rebuilding the tree. */
export function toggleLocalFilterBranch(section,open){
 section.classList.toggle('open',open);
 const heading=section.querySelector(':scope > .ftree-group-heading,:scope > .filter-category-row');
 const button=heading?.querySelector('[data-type-group],[data-local-kind]');
 button?.setAttribute('aria-expanded',String(open));
 if(button?.hasAttribute('data-type-group')){
  const label=button.getAttribute('aria-label')||'';
  button.setAttribute('aria-label',label.replace(/^(展开|收起)/,open?'收起':'展开'));
 }
 const body=section.querySelector(':scope > .ftree-body');
 if(body)body.inert=!open;
}
