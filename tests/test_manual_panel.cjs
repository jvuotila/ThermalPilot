/* Dialog behavior with DOM/service doubles; this does not test browser layout. */
const {readFrontendSource}=require('./frontend_source.cjs');
const vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
let Component;
class Element{attachShadow(){this.shadowRoot={};}}
class Control{
 constructor(value=''){this.value=value;this.disabled=false;this.handlers={};}
 addEventListener(name,handler){this.handlers[name]=handler;}
 reportValidity(){throw new Error('Native browser validation must not be used');}
 setAttribute(name,value){this[name]=value;}
 removeAttribute(name){delete this[name];}
 focus(){this.focused=true;}
}
class Dialog extends Control{
 constructor(){super();this.fields={input:new Control('18'),select:new Control('60'),'.start':new Control(),'.stop':new Control(),form:new Control(),'[role=alert]':{hidden:true,textContent:''}};}
 setAttribute(){}
 querySelector(selector){if(selector==='input'&&!this.innerHTML.includes('name="target"'))return null;return this.fields[selector];}
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
 panel.openManualSession('garage','heat',trigger);dialog=panel.manualDialog;dialog.fields.input.value='31';
 await dialog.fields['.start'].handlers.click();assert.equal(requests.length,3);assert.equal(dialog.open,true);
 dialog.fields.input.value='18';panel._hass.callWS=async()=>{throw new Error('offline');};
 await dialog.fields['.start'].handlers.click();
 assert.equal(dialog.open,true);assert.equal(dialog.fields['[role=alert]'].hidden,false);
 assert.match(dialog.fields['[role=alert]'].textContent,/Unable to change the manual session/);
 assert.equal(dialog.fields['.start'].disabled,false);
 dialog.close();
 panel.settings.language='fi';
 control.limits={heat:{minimum:16,maximum:30,step:1},cool:{minimum:18,maximum:26,step:.5}};
 panel.openManualSession('garage','heat',trigger);dialog=panel.manualDialog;
 assert.match(dialog.innerHTML,/novalidate/);assert.match(dialog.innerHTML,/min="16" max="30" step="1"/);
 dialog.fields.input.value='31';await dialog.fields['.start'].handlers.click();
 assert.match(dialog.fields['[role=alert]'].textContent,/Anna lämpötila väliltä 16–30 °C/);
 dialog.fields.input.value='18.5';await dialog.fields['.start'].handlers.click();
 assert.match(dialog.fields['[role=alert]'].textContent,/Käytä 1 °C:n/);
 dialog.close();
 panel.openManualSession('garage','cool',trigger);dialog=panel.manualDialog;
 assert.match(dialog.innerHTML,/min="18" max="26" step="0.5"/);dialog.close();
 control.target_required=false;
 panel._hass.callWS=async message=>{requests.push(message);return {manual_controls:{garage:control}};};
 panel.openManualSession('garage','heat',trigger);dialog=panel.manualDialog;
 assert.doesNotMatch(dialog.innerHTML,/<input name="target"/);
 assert.equal(dialog.querySelector('input'),null);
 await dialog.fields['.start'].handlers.click();
 assert.equal(requests.at(-1).mode,'heat');assert.equal(requests.at(-1).target,undefined);
 console.log('Manual validation passed: requested-mode limits, localized range/step errors and duration-only water-heating requests.');
 console.log('Manual dialog passed: heating/cooling requests, early stop, validation, failure feedback, refresh and focus restoration.');
})().catch(error=>{console.error(error);process.exitCode=1;});

// The offline preview must also derive a water-heating target when the UI sends
// duration only, rather than displaying an undefined/NaN session temperature.
const previewSource=require('node:fs').readFileSync(path.join(__dirname,'../PREVIEW.html'),'utf8');
const demonstration=previewSource.split('// BEGIN manual session demonstration')[1].split('// END manual session demonstration')[0];
const previewContext={demo:{source_fields:[],settings:{minimum:19,maximum:23,boost:1.5,rooms:[{id:'floor',name:'Floor',baseline:20},{id:'garage',name:'Garage',is_garage:true}],heating_zones:[]}},waterDistribution:()=>true,Date,structuredClone};
vm.runInNewContext(demonstration,previewContext);
const previewFloor=previewContext.previewManualRequest({room_id:'floor',mode:'heat',minutes:120}).manual_controls.floor;
assert.equal(previewFloor.target_required,false);assert.equal(previewFloor.session.target,21.5);
const previewGarage=previewContext.previewManualRequest({room_id:'garage',mode:'heat',minutes:120,target:18}).manual_controls.garage;
assert.equal(previewGarage.target_required,true);assert.equal(previewGarage.session.target,18);
console.log('Offline session preview passed: duration-only water heating and an explicit 18°C garage target.');
