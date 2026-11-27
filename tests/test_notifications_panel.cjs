const {readFrontendSource}=require('./frontend_source.cjs');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');

const attributes=new Map(),count={hidden:true},dialogs=[];
const timers=new Map(),animations=[];
let nextTimer=0,reduceMotion=false;
function makeNoticeRow(){
 const attributes=new Map();
 return {
  dataset:{},
  setAttribute:(name,value)=>attributes.set(name,value),
  removeAttribute:name=>attributes.delete(name),
  getAttribute:name=>attributes.get(name),
  get nextElementSibling(){
   return this.parent.children[this.parent.children.indexOf(this)+1]||null;
  },
  remove(){
   const children=this.parent.children;
   children.splice(children.indexOf(this),1);
  },
  getBoundingClientRect:()=>({height:50}),
  animate(frames,options){
   const animation={row:this,frames,options,cancel(){this.cancelled=true;}};
   animations.push(animation);
   return animation;
  },
 };
}
function finishNoticeAnimations(){
 const pending=animations.filter(animation=>!animation.cancelled&&!animation.finished);
 for(const animation of pending.sort((a,b)=>a.options.delay-b.options.delay)){
  animation.finished=true;
  animation.onfinish();
 }
}
function fireCloseTimer(){
 assert.equal(timers.size,1);
 const [id,timer]=timers.entries().next().value;
 timers.delete(id);
 timer.callback();
}
const bell={
 dataset:{},
 querySelector:()=>count,
 setAttribute:(key,value)=>attributes.set(key,value),
 focus(){this.focused=true;},
};
function makeDialog(){
 const handlers={},closeHandlers={},heading={},empty={},closeButton={
  addEventListener(type,callback){closeHandlers[type]=callback;},
  setAttribute(name,value){this[name]=value;},
 };
 const list={
  children:[],
  get firstElementChild(){return this.children[0]||null;},
  insertBefore(row,next){
   if(row.parent)row.remove();
   const index=next?this.children.indexOf(next):this.children.length;
   row.parent=this;
   this.children.splice(index,0,row);
  },
 };
 return {
  open:false,
  style:{setProperty(){}},
  setAttribute(){},
  addEventListener(type,callback){handlers[type]=callback;},
  getBoundingClientRect(){return {left:400,right:1000,top:0,bottom:600};},
  clickAt(startX,endX){
   handlers.pointerdown({target:this,clientX:startX,clientY:100});
   handlers.click({target:this,clientX:endX,clientY:100});
  },
  remove(){this.removed=true;},
  querySelector(selector){return {'h2':heading,'button':closeButton,'.notification-content ul':list,'.notification-content p':empty}[selector];},
  showModal(){this.open=true;},
  close(){this.open=false;handlers.close();},
  clickClose(){closeHandlers.click();},
 };
}
let Panel;
class Element {
 attachShadow(){this.shadowRoot={querySelector:selector=>selector==='#notification-center'?bell:null};}
}
const context={
 HTMLElement:Element,
 customElements:{get(){},define(name,type){Panel=type;}},
 getComputedStyle:()=>({colorScheme:'light',getPropertyValue:()=>''}),
 matchMedia:()=>({matches:reduceMotion}),
 setTimeout(callback,delay){timers.set(++nextTimer,{callback,delay});return nextTimer;},
 clearTimeout:id=>timers.delete(id),
 document:{createElement:tag=>tag==='dialog'?makeDialog():makeNoticeRow(),body:{append:dialog=>dialogs.push(dialog)}},
};
vm.runInNewContext(readFrontendSource(path.join(__dirname,'../custom_components/thermal_pilot/frontend/panel.js')),context);

(async()=>{
 const panel=new Panel();
 panel._panel={config:{entry_id:'home'}};
 panel.settings={language:'en',price_entity:'draft'};
 panel.tab='settings';
 let refresh,unsubscribed=false;
 panel._hass={connection:{async subscribeMessage(callback,request){
  assert.equal(request.type,'thermal_pilot/subscribe_notifications');
  assert.equal(request.entry_id,'home');
  refresh=callback;
  return async()=>{unsubscribed=true;};
 }}};
 panel.render=()=>assert.fail('Notification changes must preserve the form DOM');
 await panel.subscribeNotifications();
 const update=(...warnings)=>refresh({warnings});
 const info='Heating water temperature is not available; details.';
 const warning='Optional wind sensor unavailable.';
 const error='Thermostat control: Kitchen: unavailable <device>';
 const newError='Thermostat control: Bedroom: unavailable';
 const heatDistributionNotice='The saved heat source and heat distribution do not match. Open Climate setup → House heating settings, choose the heat source and distribution you use, and save.';
 update(heatDistributionNotice);
 assert.equal(bell.dataset.severity,'info');
 assert.equal(dialogs.length,0);
 const finnishNotice=context.__thermalPilotLocalization.translateNotification(heatDistributionNotice,'fi');
 assert.match(finnishNotice,/Lämmitys ja jäähdytys → Talon lämmitysasetukset/);
 update(info);
 assert.equal(bell.dataset.severity,'info');
 assert.equal(dialogs.length,0);
 update(info,warning);
 assert.equal(bell.dataset.severity,'warning');
 assert.equal(count.textContent,2);
 assert.equal(dialogs.length,0);
 update(warning,error,info,error);
 assert.equal(bell.dataset.severity,'error');
 assert.equal(count.textContent,3);
 assert.equal(dialogs.length,1);
 const drawer=dialogs[0];
 assert.match(drawer.innerHTML,/<h2 id="tp-notification-title" tabindex="-1" autofocus><\/h2><button type="button">/);
 assert.equal(attributes.get('aria-expanded'),'true');
 const list=dialog=>dialog.querySelector('.notification-content ul').children;
 assert.deepEqual(list(drawer).map(row=>row.dataset.severity),['error','warning','info']);
 assert.match(list(drawer)[0].innerHTML,/unavailable &lt;device&gt;/);
 drawer.clickClose();
 assert.equal(drawer.removed,true);
 assert.equal(bell.focused,true);
 update(error,info);
 panel.updateNotifications();
 update(error,warning);
 assert.equal(dialogs.length,1,'Existing errors must stay dismissed');
 assert.equal(bell.dataset.severity,'error');
 update(error,newError,warning);
 assert.equal(dialogs.length,2,'A new error opens the drawer');
 update(warning);
 assert.equal(bell.dataset.severity,'warning','Recovery drops red severity to the remaining warning');
 assert.equal(dialogs[1].open,true,'The drawer stays open while any notification remains');
 assert.deepEqual(animations.map(animation=>animation.row.notificationText),[newError,error]);
 assert.ok(animations[0].options.delay<animations[1].options.delay,'The bottom row starts exiting first');
 assert.equal(animations[1].frames[1].transform,'translateY(-12px)');
 assert.equal(list(dialogs[1])[0].getAttribute('aria-hidden'),'true');
 finishNoticeAnimations();
 assert.deepEqual(list(dialogs[1]).map(row=>row.dataset.severity),['warning']);
 update();
 assert.equal(bell.dataset.severity,undefined);
 assert.equal(count.hidden,true);
 assert.equal(dialogs[1].open,true,'The drawer waits before closing');
 const firstClose=timers.entries().next().value;
 assert.equal(firstClose[1].delay,2000);
 panel.updateNotifications();
 assert.deepEqual([...timers.keys()],[firstClose[0]],'Repeated empty updates do not reset the delay');
 update(warning);
 assert.equal(timers.size,0,'A new notice cancels the pending close');
 assert.equal(animations.at(-1).cancelled,true,'A returning notice cancels its exit animation');
 assert.equal(list(dialogs[1])[0].getAttribute('aria-hidden'),undefined);
 update();
 finishNoticeAnimations();
 fireCloseTimer();
 assert.equal(dialogs[1].open,false,'An automatically opened drawer closes when the list clears');
 assert.equal(attributes.get('aria-expanded'),'false');
 update(error);
 assert.equal(dialogs.length,3,'An error that returns after clearing is newly active');
 dialogs[2].clickClose();
 panel.openNotifications();
 const manuallyOpened=dialogs[3];
 assert.match(manuallyOpened.innerHTML,/<h2 id="tp-notification-title"><\/h2><button type="button" autofocus>/);
 update(error,newError);
 reduceMotion=true;
 update();
 assert.equal(manuallyOpened.open,true,'A manually opened drawer stays open when the list clears');
 assert.equal(list(manuallyOpened).length,0,'Reduced motion clears rows without animating');
 assert.equal(manuallyOpened.querySelector('.notification-content p').hidden,false);
 assert.match(manuallyOpened.querySelector('.notification-content p').textContent,/No active notifications/);
 assert.equal(timers.size,0);
 manuallyOpened.clickAt(500,500);
 assert.equal(manuallyOpened.open,true,'Clicking the drawer surface keeps it open');
 manuallyOpened.clickAt(500,200);
 assert.equal(manuallyOpened.open,true,'Dragging from the drawer to the backdrop keeps it open');
 update(error);
 manuallyOpened.clickAt(200,200);
 assert.equal(manuallyOpened.open,false,'Clicking the backdrop closes the drawer');
 update(error);
 assert.equal(dialogs.length,4,'Backdrop dismissal also acknowledges active errors');
 panel.settings.language='fi';
 panel.openNotifications();
 update('Thermostat control: History: Garage: zone temperature unavailable; using fan-only standby.');
 assert.match(list(dialogs.at(-1))[0].innerHTML,
  /Termostaatin ohjaus: History: Garage: Vyöhykkeen lämpötila ei ole saatavilla\. Valmiustila: Vain puhallus\./);
 assert.equal(panel.settings.price_entity,'draft');
 panel.stopNotificationSubscription();
 assert.equal(unsubscribed,true);
 update(info);
 assert.equal(bell.dataset.severity,'error','Late events from a cancelled subscription are ignored');
 console.log('Notification severity, automatic opening and closing, manual dismissal, recovery and cleanup passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
