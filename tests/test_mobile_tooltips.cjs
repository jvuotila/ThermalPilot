/* Touch/keyboard behavior with DOM doubles; viewport geometry has separate tests. */
const {readFrontendSource}=require('./frontend_source.cjs');
const vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict'),fs=require('node:fs');
class Node{
 constructor(classes=''){this.classes=new Set(classes.split(' ').filter(Boolean));this.children=[];this.attributes={};this.listeners=new Map();this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name),contains:name=>this.classes.has(name)};}
 set className(value){this.classes=new Set(value.split(' '));}
 setAttribute(name,value){this.attributes[name]=String(value);}
 getAttribute(name){return this.attributes[name];}
 removeAttribute(name){delete this.attributes[name];}
 append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
 replaceWith(node){const i=this.parent.children.indexOf(this);this.parent.children[i]=node;node.parent=this.parent;this.parent=null;}
 contains(node){return node===this||this.children.some(child=>child.contains(node));}
 all(){return this.children.flatMap(child=>[child,...child.all()]);}
 querySelector(selector){return this.all().find(node=>selector==='.setting-tooltip'?node.classes.has('setting-tooltip'):node.classes.has('setting-info')||Object.hasOwn(node.attributes,'data-tooltip-trigger'));}
 querySelectorAll(selector){return this.all().filter(node=>selector==='.setting-help'?node.classes.has('setting-help'):Object.hasOwn(node.attributes,'title'));}
 addEventListener(type,listener){const list=this.listeners.get(type)||[];list.push(listener);this.listeners.set(type,list);}
 removeEventListener(type,listener){this.listeners.set(type,(this.listeners.get(type)||[]).filter(item=>item!==listener));}
 emit(type,event){for(const listener of this.listeners.get(type)||[])listener(event);}
}
let Component;
class Element{attachShadow(){this.shadowRoot=new Node();}}
const document=new Node();document.createElement=()=>new Node();
const window=new Node();
const context={HTMLElement:Element,customElements:{get:()=>undefined,define:(name,value)=>{Component=value;}},document,window,structuredClone,Date,Number,String,Object,Math,JSON,console,setTimeout,clearTimeout,setInterval,clearInterval};
vm.createContext(context);
const source=readFrontendSource(path.join(__dirname,'../custom_components/thermal_pilot/frontend/panel.js'));
vm.runInContext(source,context);
const panel=new Component();let positioned=0;panel.positionSettingTooltip=()=>positioned++;
const help=new Node('setting-help'),anchor=new Node('setting-info'),box=new Node('setting-tooltip');help.append(anchor,box);
const badge=new Node('room-forecast-badge');badge.setAttribute('title','Forecast explanation');badge.setAttribute('tabindex','0');
panel.shadowRoot.append(help,badge);panel.bindSettingTooltips();
const nativeHelp=badge.parent;
assert.equal(nativeHelp.classes.has('setting-help'),true);
assert.equal(nativeHelp.querySelector('.setting-tooltip').textContent,'Forecast explanation');
assert.equal(badge.getAttribute('title'),undefined);assert.equal(badge.getAttribute('role'),'button');
let prevented=0,stopped=0;
const event=target=>({target,preventDefault(){prevented++;},stopPropagation(){stopped++;},composedPath(){return [target,target.parent];}});
help.emit('pointerenter',{pointerType:'touch'});assert.equal(help.classes.has('tooltip-open'),false);
help.emit('focusin',event(anchor));help.emit('click',event(anchor));
assert.equal(help.classes.has('tooltip-open'),true);assert.equal(anchor.getAttribute('aria-expanded'),'true');
assert.equal(prevented,1);assert.equal(stopped,1); // The accordion must not toggle.
help.emit('pointerleave',event(anchor));assert.equal(help.classes.has('tooltip-open'),true);
help.emit('click',event(box));assert.equal(help.classes.has('tooltip-open'),true);
help.emit('click',event(anchor));assert.equal(help.classes.has('tooltip-open'),false);
help.emit('click',event(anchor));document.emit('pointerdown',{composedPath:()=>[new Node()]});
assert.equal(help.classes.has('tooltip-open'),false);
help.emit('keydown',{...event(anchor),key:' '});assert.equal(help.classes.has('tooltip-open'),true);
document.emit('keydown',{key:'Escape',stopPropagation(){}});assert.equal(help.classes.has('tooltip-open'),false);
nativeHelp.emit('click',event(badge));assert.equal(nativeHelp.classes.has('tooltip-open'),true);
help.emit('click',event(anchor));assert.equal(nativeHelp.classes.has('tooltip-open'),false);
assert.equal(help.classes.has('tooltip-open'),true);
document.emit('focusin',{composedPath:()=>[new Node()]});assert.equal(help.classes.has('tooltip-open'),false);
assert(positioned>0);panel.settingTooltipCleanup();
for(const node of [document,window,help,nativeHelp])assert([...node.listeners.values()].every(list=>list.length===0));
const cssSource=fs.readFileSync(path.join(__dirname,'../custom_components/thermal_pilot/frontend/panel.js'),'utf8');
assert.match(cssSource,/@media\(max-width:600px\)\{\s*\.retention-card \.retention-numeric\{display:none\}/);
assert.match(cssSource,/\.retention-card \.retention-rating\{box-sizing:border-box;max-width:100%;white-space:normal;overflow-wrap:normal;word-break:normal\}/);
assert.match(cssSource,/\.season-archives \.archive-numeric\{display:none\}/);
assert.doesNotMatch(cssSource,/\.setting-help:hover \.setting-tooltip/);
console.log('Mobile help passed: touch pinning, accordion prevention, outside/Escape dismissal, keyboard support, native badge help, listener cleanup and numeric-column hiding.');
