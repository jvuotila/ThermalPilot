const {readFrontendSource}=require('./frontend_source.cjs');
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const definitions=new Map(),timers=new Map();let nextTimer=0;
class Element{
 attachShadow(){this.form={addEventListener(type,handler){this[type]=handler;}};const root={innerHTML:'',handlers:[],querySelector:selector=>selector==='ha-form'&&this.shadowRoot.innerHTML.includes('<ha-form>')?this.form:null,querySelectorAll(selector){if(selector!=='[data-sort]')return [];this.handlers=Array.from(this.innerHTML.matchAll(/data-sort="([^"]+)"/g),match=>({dataset:{sort:match[1]},addEventListener(type,handler){this.click=handler;}}));return this.handlers;}};this.shadowRoot=root;}
 dispatchEvent(event){this.event=event;}
}
const context={HTMLElement:Element,customElements:{get:key=>definitions.get(key),define:(key,value)=>definitions.set(key,value)},setInterval:fn=>{timers.set(++nextTimer,fn);return nextTimer;},clearInterval:id=>timers.delete(id),CustomEvent:class{constructor(type,options){this.type=type;Object.assign(this,options);}},console};
vm.createContext(context);const src=readFrontendSource(path.join(__dirname,'../custom_components/thermal_pilot/frontend/heat-retention-card.js'));vm.runInContext(src,context);
const Card=definitions.get('thermal-pilot-heat-retention-card'),Editor=definitions.get('thermal-pilot-heat-retention-card-editor');
const room=(id,hours,updated=true,is_garage=false)=>({id,name:id,is_garage,heat_retention:{drop_6h:6/hours,hours_per_degree:hours,updated}});
const sample={language:'fi',entries:[{entry_id:'one',title:'Home'}],rooms:[room('Garage',12,true,true),room('Fast',.5),room('Slow',9),room('Learning',4,false)]};
(async()=>{
 const card=new Card(),calls=[];card.setConfig({});card.hass={language:'en',connection:{},callWS:async request=>{calls.push(request);return structuredClone(sample);}};
 assert.equal(calls.length,0);card.connectedCallback();await new Promise(setImmediate);
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{type:'thermal_pilot/retention'}]);
 assert.match(card.shadowRoot.innerHTML,/Huone/);assert.match(card.shadowRoot.innerHTML,/Opettelee/);assert.doesNotMatch(card.shadowRoot.innerHTML,/Mukautuva|Alkuarvio/);assert.doesNotMatch(card.shadowRoot.innerHTML,/<h2|<p>|<summary/);
 assert.deepEqual(Array.from(card.sortedRooms(),r=>r.id),['Fast','Learning','Slow','Garage']);
 const headers=card.shadowRoot.handlers;headers.find(button=>button.dataset.sort==='drop_1c').click();
 assert.deepEqual(Array.from(card.sortedRooms(),r=>r.id),['Fast','Slow','Learning','Garage']);
 card.shadowRoot.handlers.find(button=>button.dataset.sort==='drop_1c').click();assert.equal(card.sortedRooms()[0].id,'Slow');
 card.shadowRoot.handlers.find(button=>button.dataset.sort==='cooling_speed').click();assert.deepEqual(Array.from(card.sortedRooms(),r=>r.id),['Fast','Slow','Learning','Garage']);
 card.setConfig({columns:[]});await new Promise(setImmediate);assert.equal((card.shadowRoot.innerHTML.match(/<th scope=/g)||[]).length,1);assert.match(card.shadowRoot.innerHTML,/Huone/);
 card.setConfig({columns:['cooling_speed','room','cooling_speed']});await new Promise(setImmediate);assert.equal((card.shadowRoot.innerHTML.match(/<th scope=/g)||[]).length,2);
 assert.throws(()=>card.setConfig({columns:['wrong']}),/Invalid columns/);
 sample.language='de';await card.refresh();assert.match(card.shadowRoot.innerHTML,/Raum/); // Integration language overrides HA English.
 card.setConfig({entry_id:'two'});await new Promise(setImmediate);assert.equal(calls.at(-1).entry_id,'two');
 sample.rooms[0].name='<img src=x onerror=alert(1)>';await card.refresh();assert.doesNotMatch(card.shadowRoot.innerHTML,/<img/);assert.match(card.shadowRoot.innerHTML,/&lt;img/);
 card._hass.callWS=async()=>{throw Error('private server detail');};await card.refresh();assert.doesNotMatch(card.shadowRoot.innerHTML,/private server detail|<td>Slow/);assert.match(card.shadowRoot.innerHTML,/colspan=/);
 assert.ok(timers.size);card.disconnectedCallback();assert.equal(timers.size,0);
 const titled=new Card();titled.setConfig({title:'My <garage> & rooms'});assert.match(titled.shadowRoot.innerHTML,/<h2 class="title">My &lt;garage&gt; &amp; rooms<\/h2>/);
 titled.setConfig({title:'   '});assert.doesNotMatch(titled.shadowRoot.innerHTML,/<h2/);
 assert.throws(()=>titled.setConfig({title:123}),/title must be text/);
 // An old integration response must not overwrite a newly selected integration.
 let finishOld;const raced=new Card();raced.connectedCallback();let count=0;raced.hass={connection:{},callWS:()=>++count===1?new Promise(resolve=>finishOld=resolve):Promise.resolve({...sample,entry_id:'new'})};
 raced.setConfig({entry_id:'new'});finishOld({...sample,entry_id:'old'});await new Promise(setImmediate);assert.equal(raced._data.entry_id,'new');raced.disconnectedCallback();
 const editor=new Editor();editor.setConfig({columns:[]});editor.update({columns:['room','cooling_speed']});assert.equal(editor.event.type,'config-changed');assert.deepEqual(Array.from(editor.event.detail.config.columns),['cooling_speed']);assert.equal(editor.form.computeHelper({name:'columns'}),'Room (required)');
 // Simulate HA echoing every typed title back through setConfig.
 const typing=new Editor();let renders=0;const renderEditor=typing.render.bind(typing);typing.render=()=>{renders++;renderEditor();};typing.setConfig({});
 typing.dispatchEvent=event=>{typing.event=event;typing.setConfig(event.detail.config);};
 for(const text of ['M','My','My room','My room title'])typing.update({title:text});
 assert.equal(renders,1);assert.equal(typing._config.title,'My room title');
 typing.setConfig({...typing.event.detail.config,title:'Externally changed'});assert.equal(renders,2);
 // A late integration-list refresh reuses the native form and its focused controls.
 const mountedForm=typing.form;typing._entries=[{entry_id:'home',title:'Home'},{entry_id:'second',title:'Second'}];typing.render();
 assert.equal(typing.form,mountedForm);assert.equal(typing.form.data.title,'Externally changed');
 assert.equal(typing.form.schema.find(field=>field.name==='entry_id').selector.select.options[1].value,'home');
 typing.form['value-changed']({stopPropagation(){},detail:{value:{title:'Typed title',entry_id:'home',language:'fi',columns:['cooling_speed']}}});
 assert.equal(typing.event.detail.config.title,'Typed title');assert.deepEqual(Array.from(typing.event.detail.config.columns),['cooling_speed']);
 const languagesCard=new Card();languagesCard._data=structuredClone(sample);languagesCard._data.language='fi';
 assert.equal(languagesCard.t('Room'),'Huone');languagesCard._config={...languagesCard._config,language:'en'};assert.equal(languagesCard.t('Room'),'Room');
 languagesCard._config.language='de';assert.equal(languagesCard.t('Room'),'Raum');languagesCard._config.language='auto';assert.equal(languagesCard.t('Room'),'Huone');
 assert.throws(()=>languagesCard.setConfig({language:'invalid'}),/Invalid card language/);
 // Hide the integration choice until there is a real choice; retain saved selection.
 const integrationEditor=new Editor();integrationEditor.setConfig({entry_id:'home'});
 for(const entries of [[],[{entry_id:'home',title:'Home'}]]){
  integrationEditor._entries=entries;integrationEditor.render();
  assert.ok(!integrationEditor.form.schema.some(field=>field.name==='entry_id'));
  assert.equal(integrationEditor.form.data.entry_id,'home');
 }
 integrationEditor._entries=[{entry_id:'home',title:'Home'},{entry_id:'second',title:'Second'}];integrationEditor.render();
 assert.ok(integrationEditor.form.schema.some(field=>field.name==='entry_id'));
 const languageEditor=new Editor();languageEditor.setConfig({language:'fi'});
 assert.equal(languageEditor.form.data.language,'fi');assert.equal(languageEditor.form.computeLabel({name:'language'}),'Kieli');
 const options=languageEditor.form.schema.find(field=>field.name==='language').selector.select.options;
 assert.ok(options.some(option=>option.value==='auto'));assert.ok(options.some(option=>option.value==='hu'));
 const columnField=languageEditor.form.schema.find(field=>field.name==='columns');
 assert.equal(columnField.selector.select.mode,'list');assert.equal(columnField.selector.select.multiple,true);

 // Card badges use exactly the panel's bands, including typed construction references.
 const panelContext={HTMLElement:class{},customElements:{get:()=>true},location:{pathname:''}};vm.createContext(panelContext);vm.runInContext(readFrontendSource(path.join(__dirname,'../custom_components/thermal_pilot/frontend/panel.js')),panelContext);
 for(const reference of [null,2.12])for(const hours of [.5,1,2,4,8,12])for(const updated of [true,false]){
  const value={hours_per_degree:hours,reference_hours:reference,updated};const expected=vm.runInContext('retentionRating('+JSON.stringify(value)+').level',panelContext);
  const html=card.cell('cooling_speed',{heat_retention:value},1);assert.match(html,/<svg class="status-info"/);assert.match(html,/tabindex="0"/);assert.match(html,new RegExp('rating '+expected+'"'));
 }
 // The compact card must retain the panel's explanation, even when numeric columns are hidden.
 const tooltipCard=new Card();tooltipCard.setConfig({columns:['cooling_speed']});
 const panelView=vm.runInContext('ThermalPilotPanel.prototype.heatRetentionView',panelContext);
 const title=html=>html.match(/class="(?:rating |retention-rating retention-rating-)[^" ]*"[^>]*title="([^"]*)"/)[1];
 for(const language of ['en','fi','de'])for(const type of ['wooden_detached','masonry_detached','concrete_apartment','heavy_masonry_apartment',null,'<unknown>'])for(const updated of [true,false]){
  tooltipCard._config.language=language;
  const value={drop_6h:1.3,hours_per_degree:4.6,updated,reference_type:type,reference_hours:type?2.12:null};
  const data={name:'Room',heat_retention:value};
  const panelHtml=panelView.call({settings:{language,rooms:[]},info:{data:{rooms:{example:data}}},t:text=>tooltipCard.t(text)});
  const cardHtml=tooltipCard.cell('cooling_speed',data,2);
  assert.equal(title(cardHtml),title(panelHtml),`${language}: ${type}, learned=${updated}`);
  if(updated&&type){assert.match(title(cardHtml),/2.1 h · 2.17×/);}
  if(type==='<unknown>')assert.doesNotMatch(cardHtml,/<unknown>/);
 }
 // Renaming the middle relative band must not change any cut-offs or garage labels.
 tooltipCard._config.language='fi';
 for(const [ratio,expected] of [[.799,'Nopea jäähtyminen'],[.8,'Lähellä vertailuarvoa'],[1,'Lähellä vertailuarvoa'],[1.249,'Lähellä vertailuarvoa'],[1.25,'Hidas jäähtyminen']]){
  const value={updated:true,hours_per_degree:ratio*2,reference_hours:2,reference_type:'wooden_detached'};
  const html=tooltipCard.cell('cooling_speed',{heat_retention:value},2);
  assert.match(html,new RegExp('>'+expected+'<'));
  const panelRating=vm.runInContext('retentionRating('+JSON.stringify(value)+')',panelContext);
  assert.match(html,new RegExp('>'+tooltipCard.t(panelRating.label)+'<'));
 }
 const garageValue={updated:true,hours_per_degree:3,reference_hours:null};
 assert.match(tooltipCard.cell('cooling_speed',{is_garage:true,heat_retention:garageValue},2),/>Kohtalainen jäähtyminen</);
 assert.doesNotMatch(tooltipCard.cell('cooling_speed',{heat_retention:{...garageValue,updated:false,reference_hours:2}},2),/>Lähellä vertailuarvoa</);
 const linked=room('Kitchen',4);linked.history_entities={drop_6h:'sensor.loss',hours_per_degree:'sensor.hours'};
 assert.match(card.cell('loss_6h',linked,2),/data-retention-history="sensor.loss"[^>]*style="cursor:pointer;color:inherit"/);
 assert.match(card.cell('drop_1c',linked,2),/data-retention-history="sensor.hours"/);
 const handlers={};card.shadowRoot.querySelectorAll=selector=>selector==='[data-retention-history]'?[{dataset:{retentionHistory:'sensor.hours'},addEventListener:(name,fn)=>handlers[name]=fn}]:[];
 card.render();handlers.keydown({key:'Enter',preventDefault(){},stopPropagation(){}});
 assert.equal(card.event.type,'hass-more-info');assert.equal(card.event.detail.entityId,'sensor.hours');assert(card.event.bubbles&&card.event.composed);
 assert.equal(context.customCards.length,1);vm.runInContext(src,context);assert.equal(context.customCards.length,1);
 console.log('Dashboard card passed: columns, sorting, garage grouping, integration language, escaping, read-only polling, cleanup, response races, editor and badge parity.');
})().catch(error=>{console.error(error);process.exitCode=1;});

const alphabeticalCard=new Card();alphabeticalCard.setConfig({});
alphabeticalCard._data={language:'fi',rooms:['Öljyhuone','Äidin huone','Zebra','Åke','Aula'].map(name=>room(name,4))};
assert.deepEqual(Array.from(alphabeticalCard.sortedRooms(),r=>r.name),['Aula','Zebra','Åke','Äidin huone','Öljyhuone']);
alphabeticalCard._sort.direction=-1;
assert.deepEqual(Array.from(alphabeticalCard.sortedRooms(),r=>r.name),['Öljyhuone','Äidin huone','Åke','Zebra','Aula']);
alphabeticalCard.setConfig({sort_by:'loss_6h',sort_direction:'desc'});
assert.equal(alphabeticalCard._sort.key,'loss_6h');assert.equal(alphabeticalCard._sort.direction,-1);
console.log('Custom card defaults to language-aware A–Ö sorting and preserves explicit sort configuration.');

const noModelCard=new Card();noModelCard.setConfig({columns:['loss_6h','model','drop_1c','cooling_speed']});
assert.deepEqual(Array.from(noModelCard._config.columns),['room','loss_6h','drop_1c','cooling_speed']);
const initialRoom=room('Initial',4,false);
assert.equal(noModelCard.cell('loss_6h',initialRoom,2),'');
assert.equal(noModelCard.cell('drop_1c',initialRoom,2),'');
assert.match(noModelCard.cell('cooling_speed',initialRoom,2),/Learning/);
const noModelEditor=new Editor();noModelEditor.setConfig({columns:['model','loss_6h']});
const availableColumns=noModelEditor.form.schema.find(field=>field.name==='columns').selector.select.options;
assert.ok(!availableColumns.some(option=>option.value==='model'));
console.log('Removed Model option, retained legacy card compatibility and blanked initial numeric cells.');
