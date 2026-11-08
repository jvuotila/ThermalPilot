/* Dialog behavior with DOM/service doubles; this does not test browser layout. */
const {readFrontendSource}=require('./frontend_source.cjs');
const vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
let Component;
class Element{attachShadow(){this.shadowRoot={};}}
class Control{
 constructor(value=''){this.value=value;this.disabled=false;this.handlers={};}
 addEventListener(name,handler){this.handlers[name]=handler;}
 reportValidity(){return this.valid!==false;}
}
class Dialog extends Control{
 constructor(){super();this.fields={input:new Control('18'),select:new Control('60'),'.start':new Control(),'.stop':new Control(),form:new Control(),'[role=alert]':{hidden:true,textContent:''}};}
 setAttribute(){}
 querySelector(selector){return this.fields[selector];}
 querySelectorAll(){return [this.fields['.start'],this.fields['.stop']];}
 showModal(){this.open=true;}
 close(){this.open=false;this.handlers.close?.();}
 remove(){this.removed=true;}
}
const context={HTMLElement:Element,customElements:{get:()=>undefined,define:(name,value)=>{Component=value;}},structuredClone,Date,Number,String,Object,Math,JSON,console,setTimeout,clearTimeout,setInterval,clearInterval,document:{createElement:()=>new Dialog(),body:{append:()=>{}}}};
vm.createContext(context);
vm.runInContext(readFrontendSource(path.join(__dirname,'../custom_components/thermal_pilot/frontend/panel.js')),context);
(async()=>{
 const panel=new Component();panel.settings={language:'en'};panel._panel={config:{entry_id:'one'}};
 const control={name:'Garage',modes:['heat','cool'],minimum:16,maximum:30,step:.5,heat_target:18,cool_target:22,enabled:true};
 panel.info={manual_controls:{garage:control}};
 const requests=[];let refreshes=0,focused=0;
 panel._hass={callWS:async message=>{requests.push(message);return {manual_controls:{garage:control}};}};
 panel.load=async()=>{refreshes++;};
 const trigger={focus:()=>focused++};
 panel.openManualSession('garage','heat',trigger);
 let dialog=panel.manualDialog;
 assert.equal(dialog.open,true);assert.match(dialog.innerHTML,/Manual heating/);assert.match(dialog.innerHTML,/Automatic control resumes/);
 await dialog.fields['.start'].handlers.click();
 assert.equal(requests[0].type,'thermal_pilot/manual');assert.equal(requests[0].entry_id,'one');
 assert.equal(requests[0].room_id,'garage');assert.equal(requests[0].mode,'heat');assert.equal(requests[0].minutes,60);assert.equal(requests[0].target,18);
 assert.equal(dialog.removed,true);assert.equal(focused,1);assert.equal(refreshes,1);
 control.session={mode:'heat',target:18,ends:Date.now()/1000+3600};
 panel.openManualSession('garage','heat',trigger);dialog=panel.manualDialog;
 assert.match(dialog.innerHTML,/Stop session/);assert.match(dialog.innerHTML,/Update session/);
 await dialog.fields['.stop'].handlers.click();
 assert.equal(requests[1].mode,'stop');assert.equal(requests[1].target,undefined);
 control.session=null;
 panel.openManualSession('garage','cool',trigger);dialog=panel.manualDialog;
 assert.match(dialog.innerHTML,/Manual cooling/);assert.match(dialog.innerHTML,/Start cooling/);
 await dialog.fields['.start'].handlers.click();assert.equal(requests[2].mode,'cool');
 panel.openManualSession('garage','heat',trigger);dialog=panel.manualDialog;dialog.fields.input.valid=false;
 await dialog.fields['.start'].handlers.click();assert.equal(requests.length,3);assert.equal(dialog.open,true);
 dialog.fields.input.valid=true;panel._hass.callWS=async()=>{throw new Error('offline');};
 await dialog.fields['.start'].handlers.click();
 assert.equal(dialog.open,true);assert.equal(dialog.fields['[role=alert]'].hidden,false);
 assert.match(dialog.fields['[role=alert]'].textContent,/Unable to change the manual session/);
 assert.equal(dialog.fields['.start'].disabled,false);
 dialog.close();
 console.log('Manual dialog passed: heating/cooling requests, early stop, validation, failure feedback, refresh and focus restoration.');
})().catch(error=>{console.error(error);process.exitCode=1;});
