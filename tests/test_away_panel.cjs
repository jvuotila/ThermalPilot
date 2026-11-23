/* Production settings/calendar interaction with DOM doubles, no visual-browser claims. */
const {readFrontendSource}=require('./frontend_source.cjs');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
let Panel,currentDialog;
class Node{
 constructor(value=''){this.value=value;this.hidden=true;this.dataset={};this.listeners={};this.classList={toggle:(key,value)=>{if(key==='active')this.active=value;}};}
 addEventListener(name,fn){this.listeners[name]=fn;}
 setAttribute(){} focus(){this.focused=true;}
}
class Dialog extends Node{
 constructor(){super();this.nodes={};this.groups={};}
 set innerHTML(value){this.html=value;
  for(const match of value.matchAll(/name="([^"]+)"[^>]*value="([^"]*)"/g))this.nodes[`[name="${match[1]}"]`]=new Node(match[2]);
  for(const selector of ['.months','[role=alert]','form','.close','.dismiss','.save'])this.nodes[selector]=new Node();
  if(value.includes('class="stop"'))this.nodes['.stop']=new Node();
  this.groups['[data-date-card]']=['start','end'].map(key=>{const node=new Node();node.dataset.dateCard=key;return node;});
  this.groups['.close,.dismiss']=[this.nodes['.close'],this.nodes['.dismiss']];
  this.groups['button']=Object.values(this.nodes);
  this.groups['[data-help]']=[];
 }
 querySelector(selector){return this.nodes[selector]||null;}
 querySelectorAll(selector){return this.groups[selector]||[];}
 showModal(){this.open=true;}
 close(){this.open=false;this.listeners.close?.();}
 remove(){this.removed=true;}
}
class Element{attachShadow(){this.shadowRoot={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]};}}
const context={HTMLElement:Element,customElements:{get:()=>undefined,define:(_,value)=>Panel=value},structuredClone,Intl,Date,Number,String,Object,Math,JSON,Infinity,console,setTimeout,clearTimeout,setInterval,clearInterval};
vm.createContext(context);vm.runInContext(readFrontendSource(path.join(__dirname,'../custom_components/thermal_pilot/frontend/panel.js')),context);
const info=JSON.parse(fs.readFileSync(path.join(__dirname,'../PREVIEW.html'),'utf8').match(/const demo=([\s\S]*?);const states=/)[1]);
const panel=new Panel();panel.info=structuredClone(info);panel.settings=structuredClone(info.settings);panel.tab='settings';
panel._hass={states:{'zone.home':{entity_id:'zone.home',state:'0',attributes:{friendly_name:'Home'}},'sensor.other':{entity_id:'sensor.other',state:'0',attributes:{}}},config:{time_zone:'Europe/Helsinki'}};
panel.settings.away_automatic=false;
let markup=panel.settingsView();
assert.ok(markup.indexOf('<h3>Away heating and cooling</h3>')>markup.indexOf('<h3>Solar power heating settings</h3>'));
for(const key of ['away_temperature','away_cooling_temperature','away_automatic'])assert.match(markup,new RegExp(`data-field="source.${key}"`));
for(const key of ['away_zone','away_delay_hours'])assert.doesNotMatch(markup,new RegExp(`data-field="source.${key}"`));
panel.settings.away_automatic=true;markup=panel.settingsView();assert.match(markup,/data-field="source.away_delay_hours"/);assert.match(markup,/value="zone.home"/);
const awayRows=markup.match(/<div class="away-settings-fields">([\s\S]*?)<\/div><\/div>/)[1].split('<div class="grid">').slice(1);
assert.equal(awayRows.length,2);
for(const key of ['away_automatic','away_zone','away_delay_hours'])assert.ok(awayRows[0].includes(`source.${key}`));
for(const key of ['away_temperature','away_cooling_temperature'])assert.ok(awayRows[1].includes(`source.${key}`));
const zoneField=panel.field(info.source_fields.find(field=>field[0]==='away_zone'),panel.settings,'source');assert.doesNotMatch(zoneField,/value="sensor.other"/);
assert.match(markup,/restarts preserve it/);assert.match(markup,/only the end|active bookings/);
const room=panel.settings.rooms.find(room=>!room.is_garage);markup=panel.roomSettingsFields(room,0);
assert.match(markup,/data-field="room0.away_exempt"/);assert.match(markup,/aquariums/);assert.match(markup,/Shared heat-pump zones/);
assert.match(panel.awayCalendarButton(),/id="away-calendar"/);
const panelSource=fs.readFileSync(path.join(__dirname,'../custom_components/thermal_pilot/frontend/panel.js'),'utf8');
assert.match(panelSource,/header-tools>\.header-actions\{position:absolute;top:16px;right:24px/);
assert.match(panelSource,/<div class="header-actions">\$\{this.awayCalendarButton\(\)\}\$\{this.notificationButton\(\)\}/);
assert.match(panelSource,/header-icon-button:hover:not\(:disabled\)/);
panel.info.data.away={active:true,source:'calendar',schedule:{start:1794844800,end:1795377600},temperature:16,cooling_temperature:26,time_zone:'Europe/Helsinki'};
assert.match(panel.awayCalendarButton(),/class="header-icon-button away-calendar-button active"/);
const month=context.awayCalendarMonth(new Date(2026,10,1,12),{start:'2026-11-16',end:'2026-11-22'},'2026-11-16','fi');
assert.equal((month.match(/data-calendar-date=/g)||[]).length,42);
assert.match(month,/marraskuu/);assert.match(month,/aria-current="date"/);assert.match(month,/day range/);
context.document={createElement:()=>currentDialog=new Dialog(),body:{append:()=>{}}};
// Saving updates info.settings before the coordinator publishes its next snapshot.
// The calendar must prefer that acknowledged configuration over stale away data.
panel.info.settings.away_temperature=18;panel.info.settings.away_cooling_temperature=27;
panel.settings.away_temperature=19;panel.settings.away_cooling_temperature=29;
panel.settings.language='fi';panel.openAwayCalendar();
assert.match(currentDialog.html,/Lämmitys 18 °C/);assert.match(currentDialog.html,/Jäähdytys 27 °C/);
assert.doesNotMatch(currentDialog.html,/Lämmitys 19 °C|Jäähdytys 29 °C/);
assert.equal(currentDialog.open,true);
assert.equal(currentDialog.nodes['[name="start-date"]'].value,'2026-11-16');assert.equal(currentDialog.nodes['[name="start-time"]'].value,'18:00');
assert.equal(currentDialog.nodes['[name="end-date"]'].value,'2026-11-22');assert.equal(currentDialog.nodes['[name="end-time"]'].value,'22:00');assert.match(currentDialog.html,/Poissaolokalenteri/);assert.match(currentDialog.html,/Peruuta ajanjakso/);
assert.match(currentDialog.html,/Tunnistus pois/);assert.match(currentDialog.html,/Automaattiset poissaololämpötilat voivat jäädä/);
assert.match(currentDialog.html,/Europe\/Helsinki/);assert.match(currentDialog.html,/max-width:600px/);
let requests=[];panel.call=async(type,payload)=>{requests.push({type,...payload});return {data:{...panel.info.data,away:{active:false,schedule:null}}};};
let renders=0;panel.render=()=>renders++;
const draft=panel.settings;draft.away_temperature=17;
(async()=>{
 await currentDialog.nodes['.stop'].listeners.click();
 assert.equal(requests[0].action,'cancel');assert.equal(requests[0].type,'away');
 assert.equal(panel.settings,draft,'calendar actions preserve unsaved Settings drafts');assert.equal(panel.settings.away_temperature,17);
 assert.equal(currentDialog.removed,true);assert.equal(renders,1);
 panel.info.data.away={active:false,schedule:null,time_zone:'Europe/Helsinki'};
 panel.openAwayCalendar();assert.equal(currentDialog.nodes['.stop'],undefined);
 for(const key of ['start-date','start-time','end-date','end-time'])assert.equal(currentDialog.nodes[`[name="${key}"]`].value,'',key+' starts empty');
 assert.equal(currentDialog.groups['[data-date-card]'][0].dataset.dateCard,'start');
 assert.equal(currentDialog.groups['[data-date-card]'][0].active,true);assert.equal(currentDialog.groups['[data-date-card]'][1].active,false);
 const emptyMonth=context.awayCalendarMonth(new Date(2026,10,1,12),{start:'',end:''},'2026-11-16','fi');
 assert.doesNotMatch(emptyMonth,/day selected|day range/);assert.match(emptyMonth,/aria-current="date"/);
 const endOnly=context.awayCalendarMonth(new Date(2026,10,1,12),{start:'',end:'2026-11-22'},'2026-11-16','fi');
 assert.doesNotMatch(endOnly,/day range/);
 // Selecting just the start date does not invent an end date or either time.
 currentDialog.listeners.click({target:{closest:selector=>selector==='[data-calendar-date]'?{dataset:{calendarDate:'2026-11-16'}}:null}});
 assert.equal(currentDialog.nodes['[name="start-date"]'].value,'2026-11-16');
 for(const key of ['start-time','end-date','end-time'])assert.equal(currentDialog.nodes[`[name="${key}"]`].value,'');
 currentDialog.nodes['[name="start-date"]'].value='2026-11-16';currentDialog.nodes['[name="start-time"]'].value='18:00';
 currentDialog.nodes['[name="end-date"]'].value='2026-11-22';currentDialog.nodes['[name="end-time"]'].value='22:00';
 currentDialog.nodes.form.listeners.submit({preventDefault:()=>{}});
 await new Promise(setImmediate);
 assert.equal(requests[1].start,'2026-11-16T18:00','wall-clock date is sent intact; backend owns the time zone');
 assert.equal(requests[1].end,'2026-11-22T22:00');assert.equal(requests[1].action,'set');
 console.log('Away UI: settings visibility, zone filtering, exemptions/help, Finnish date grid, save/cancel and preserved drafts passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
