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
  for(const selector of ['.months','.date-prompt','[role=alert]','form','.close','.save','.cancel-edit','.bookings','.no-bookings','.status','.repeat','.repeat-limit','.repeat-count-label','.repeat-summary','.reminder-lead','#cancel-help'])this.nodes[selector]=new Node();
  for(const selector of ['.booking-pages','.booking-page-controls','.booking-page-number','.booking-total','[data-booking-page="-1"]','[data-booking-page="1"]'])this.nodes[selector]=new Node();
  for(const name of ['repeat','repeat-count','reminder','reminder-amount','reminder-unit'])this.nodes[`[name="${name}"]`]=new Node();
  this.nodes['[name="booking-page-size"]']=new Node('5');
  for(const key of ['start','end']){
   this.nodes[`[name="${key}-hour"]`]=new Node();
   const minute=this.nodes[`[name="${key}-minute"]`]=new Node();
   minute.querySelector=()=>minute.savedMinute;
   minute.insertAdjacentHTML=(_,html)=>{
    minute.savedMinute={value:html.match(/value="([^"]+)"/)[1],remove:()=>{minute.savedMinute=null;}};
   };
  }
  this.groups['[data-date-card]']=['start','end'].map(key=>{
   const node=new Node(), button=new Node();
   node.dataset.dateCard=key;
   node.querySelector=()=>button;
   return node;
  });
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
const context={CSS:{escape:value=>value},HTMLElement:Element,customElements:{get:()=>undefined,define:(_,value)=>Panel=value},structuredClone,Intl,Date,Number,String,Object,Math,JSON,Infinity,console,setTimeout,clearTimeout,setInterval,clearInterval};
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
assert.match(panelSource,/<div class="header-actions">\$\{this.notificationButton\(\)\}\$\{this.awayCalendarButton\(\)\}/);
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
panel.settings.language='fi';
panel.info.data.fallback_season={season:'summer'};
panel.openAwayCalendar();
assert.match(currentDialog.html,/Jäähdytys 27 °C/);assert.match(currentDialog.html,/Lämmitys 18 °C/);
panel.info.data.fallback_season.season='winter';
panel.openAwayCalendar();
assert.match(currentDialog.html,/Lämmitys 18 °C/);assert.match(currentDialog.html,/Jäähdytys 27 °C/);
assert.doesNotMatch(currentDialog.html,/Lämmitys 19 °C|Jäähdytys 29 °C/);
assert.equal(currentDialog.open,true);
assert.match(currentDialog.html,/Poissaolokalenteri/);
assert.match(currentDialog.html,/Tunnistus pois/);
assert.match(currentDialog.html,/Normaalit lämpötila-asetukset palaavat, kun peruutat jakson\. Poissaololämpötilat pysyvät käytössä, jos toinen kalenterijakso tai automaattinen poissaolo on edelleen aktiivinen\./);
assert.match(currentDialog.html,/<button type="button" class="setting-info" data-help="cancel-help"[^>]*><svg class="status-info"/);
assert.match(currentDialog.html,/Europe\/Helsinki/);assert.match(currentDialog.html,/max-width:600px/);
assert.match(currentDialog.nodes['.bookings'].innerHTML,/Peruuta ajanjakso/);
const requests=[];
let renders=0;panel.render=()=>renders++;
const draft=panel.settings;draft.away_temperature=17;
const dispatch=(selector,data)=>currentDialog.listeners.click({target:{closest:query=>query===selector?{dataset:data}:null}});
const values=name=>currentDialog.nodes[`[name="${name}"]`];
const settle=()=>new Promise(setImmediate);
const initialStart=1796745780;
let occurrences=[
 {id:'weekly',start:initialStart,end:initialStart+93600,repeat:'weekly',repeat_count:2,reminder_hours:24,active:false},
 {id:'once',start:initialStart+86400,end:initialStart+90000,repeat:'once',active:false},
 {id:'weekly',start:initialStart+7*86400,end:initialStart+7*86400+7200,repeat:'weekly',active:false},
];
panel.call=async(type,payload)=>{
 requests.push({type,...payload});
 if(payload.action==='skip')occurrences=occurrences.filter(item=>item.id!==payload.booking_id||item.start!==payload.occurrence);
 if(payload.action==='cancel')occurrences=occurrences.filter(item=>item.id!==payload.booking_id);
 const schedules=occurrences.filter((item,index)=>occurrences.findIndex(entry=>entry.id===item.id)===index);
 const away={active:false,schedules,occurrences,occurrence_count:occurrences.length,time_zone:'Europe/Helsinki'};
 return {away,data:{...panel.info.data,away}};
};

(async()=>{
 const tip=currentDialog.nodes['#cancel-help'];
 tip.style={};
 tip.getBoundingClientRect=()=>({width:Number.parseFloat(tip.style.width),height:90});
 const helpButton=new Node();
 helpButton.dataset.help='cancel-help';
 helpButton.getBoundingClientRect=()=>({left:288,top:482,bottom:518});
 Object.assign(currentDialog,{clientWidth:298,clientHeight:498,clientTop:1,clientLeft:1,
  getBoundingClientRect:()=>({left:24,top:50})});
 currentDialog.listeners.click({target:{closest:selector=>selector==='[data-help]'?helpButton:null}});
 assert.equal(tip.hidden,false);
 assert.equal(tip.style.width,'282px');
 assert.equal(tip.style.left,'33px');
 assert.equal(tip.style.top,'384px');
 currentDialog.listeners.scroll();
 assert.equal(tip.hidden,true);
 assert.match(currentDialog.html,/class="calendar-checkbox"><input name="repeat"/);
 assert.match(currentDialog.html,/class="calendar-checkbox"><input name="reminder"/);
 assert.match(currentDialog.html,/class="calendar-select"><select name="reminder-unit"/);
 assert.match(currentDialog.html,/class="calendar-options repeat-limit"[^\n]+<\/label><p class="repeat-summary"/);
 assert.doesNotMatch(currentDialog.html,/\.thermal-pilot-away-dialog footer\{[^}]*border-top/);
 dispatch('[data-remove-booking]',{removeBooking:'legacy',occurrence:1794844800});
 await settle();
 assert.equal(requests[0].action,'cancel');assert.equal(requests[0].type,'away');assert.equal(requests[0].booking_id,'legacy');
 assert.equal(panel.settings,draft,'calendar actions preserve unsaved Settings drafts');assert.equal(panel.settings.away_temperature,17);
 assert.equal(currentDialog.open,true);assert.equal(renders,1);
 assert.match(panel.awayCalendarButton(),/class="header-count" aria-hidden="true">3<\/span>/);
 assert.equal(currentDialog.nodes['.booking-total'].textContent,'Poissaoloja yhteensä · 3');
 assert.equal(currentDialog.nodes['.booking-pages'].hidden,false);
 assert.equal(currentDialog.nodes['.booking-page-controls'].hidden,true);
 panel.info.data.away.has_ongoing_series=true;
 assert.match(panel.awayCalendarButton(),/class="header-count" aria-hidden="true">3\+<\/span>/);
 panel.info.data.away.has_ongoing_series=false;
 assert.equal(currentDialog.nodes['.cancel-edit'].hidden,true);
 assert.doesNotMatch(currentDialog.html,/class="dismiss"|class="new"/);
 assert.match(currentDialog.nodes['.bookings'].innerHTML,/Viikoittain/);
 const reminderRows=currentDialog.nodes['.bookings'].innerHTML.split('</li>');
 assert.match(reminderRows[0],new RegExp(`reminder-weekly-${initialStart}`));
 assert.match(reminderRows[0],/Muistutuksen ennakkoaika · 1 päivä/);
 assert.doesNotMatch(reminderRows[1],/reminder-indicator/);
 for(const key of ['start','end']){
  for(const field of ['date','hour','minute'])assert.equal(values(key+'-'+field).value,'',`${key} ${field} starts empty`);
  const menu=currentDialog.html.match(new RegExp(`<select name="${key}-minute"[^>]*>(.*?)</select>`))[1];
  assert.deepEqual([...menu.matchAll(/value="(\d+)"/g)].map(option=>option[1]),['00','15','30','45']);
 }
 assert.equal(currentDialog.groups['[data-date-card]'][0].active,true);
 assert.equal(currentDialog.groups['[data-date-card]'][1].active,false);
 assert.equal(currentDialog.nodes['.date-prompt'].textContent,'Valitse alkupäivä');
 assert.equal((currentDialog.nodes['.months'].innerHTML.match(/data-calendar-date=/g)||[]).length,42);
 const emptyMonth=context.awayCalendarMonth(new Date(2026,10,1,12),{start:'',end:''},'2026-11-16','fi');
 assert.doesNotMatch(emptyMonth,/day selected|day range/);assert.match(emptyMonth,/aria-current="date"/);
 const endOnly=context.awayCalendarMonth(new Date(2026,10,1,12),{start:'',end:'2026-11-22'},'2026-11-16','fi');
 assert.doesNotMatch(endOnly,/day range/);
 dispatch('[data-calendar-date]',{calendarDate:'2026-12-01'});
 assert.equal(values('start-date').value,'2026-12-01');
 assert.equal(values('start-hour').value,'08');
 assert.equal(values('start-minute').value,'00');
 assert.equal(values('end-date').value,'');
 assert.equal(values('end-hour').value,'');
 assert.equal(currentDialog.nodes['.repeat'].hidden,true);
 assert.equal(currentDialog.nodes['.date-prompt'].textContent,'Valitse loppupäivä');
 dispatch('[data-month]',{month:'1'});
 assert.match(currentDialog.nodes['.months'].innerHTML,/tammikuu 2027/);
 assert.equal(currentDialog.nodes['.date-prompt'].textContent,'Valitse loppupäivä');
 dispatch('[data-month]',{month:'-1'});
 dispatch('[data-calendar-date]',{calendarDate:'2026-12-03'});
 assert.equal(values('end-hour').value,'16');
 assert.equal(values('end-minute').value,'00');
 assert.equal(currentDialog.nodes['.repeat'].hidden,false);
 assert.equal(currentDialog.nodes['.repeat-limit'].hidden,true);
 values('repeat').checked=true;
 values('repeat').listeners.change();
 assert.equal(currentDialog.nodes['.repeat-limit'].hidden,false);
 currentDialog.nodes.form.listeners.submit({preventDefault(){}});
 assert.equal(currentDialog.nodes['[role=alert]'].hidden,false);
 assert.equal(requests.length,1);
 values('repeat-count').value='1';
 values('repeat-count').listeners.input();
 assert.match(currentDialog.nodes['.repeat-summary'].textContent,/1.–3\.12\.2026/);
 values('repeat-count').value='3';
 values('repeat-count').listeners.input();
 assert.match(currentDialog.nodes['.repeat-summary'].textContent,/15.–17\.12\.2026/);
 for(const [end,hidden] of [['2026-12-01',true],['2026-12-02',false],['2026-12-06',false],['2026-12-07',true],['2026-12-03',false]]){
  values('end-date').value=end;
  values('end-date').listeners.change({target:values('end-date')});
  assert.equal(currentDialog.nodes['.repeat'].hidden,hidden,end);
  assert.equal(currentDialog.nodes['.repeat-summary'].hidden,hidden,end);
 }
 values('reminder').checked=true;
 values('reminder').listeners.change();
 assert.equal(currentDialog.nodes['.reminder-lead'].hidden,false);
 values('reminder-amount').value='2';
 values('reminder-unit').value='days';
 currentDialog.nodes.form.listeners.submit({preventDefault(){}});
 await settle();
 assert.deepEqual(requests[1],{type:'away',action:'set',start:'2026-12-01T08:00',end:'2026-12-03T16:00',repeat:'weekly',repeat_count:3,reminder_hours:48});
 dispatch('[data-edit-booking]',{editBooking:'weekly'});
 assert.equal(values('repeat').checked,true);
 assert.equal(values('start-minute').value,'03');
 assert.equal(values('start-minute').savedMinute.value,'03');
 values('start-hour').listeners.change();
 assert.equal(values('start-minute').value,'00');
 assert.notEqual(values('start-date').value,'');
 assert.equal(currentDialog.nodes['.cancel-edit'].hidden,false);
 currentDialog.nodes['.cancel-edit'].listeners.click();
 assert.equal(currentDialog.open,true);
 assert.equal(currentDialog.nodes['.cancel-edit'].hidden,true);
 assert.equal(values('start-date').value,'');
 assert.equal(values('repeat').checked,false);
 assert.equal(requests.length,2);
 dispatch('[data-edit-booking]',{editBooking:'weekly'});
 currentDialog.nodes.form.listeners.submit({preventDefault(){}});
 await settle();
 assert.equal(requests[2].booking_id,'weekly');
 assert.match(requests[2].start,/:03$/);
 const laterDate=initialStart+7*86400;
 dispatch('[data-remove-booking]',{removeBooking:'weekly',occurrence:laterDate});
 assert.equal(requests.length,3,'Ask before cancelling a recurring booking');
 const rows=currentDialog.nodes['.bookings'].innerHTML.split('</li>');
 assert.doesNotMatch(rows[0],/remove-choice/);
 assert.doesNotMatch(rows[1],/remove-choice/);
 assert.match(rows[2],/Vain tämä kerta.*Koko sarja/);
 dispatch('[data-removal]',{removal:'skip'});
 await settle();
 assert.deepEqual(requests[3],{type:'away',action:'skip',booking_id:'weekly',occurrence:laterDate});
 assert.equal(occurrences[0].start,initialStart);
 assert.equal(occurrences.length,2);
 dispatch('[data-remove-booking]',{removeBooking:'weekly',occurrence:initialStart});
 dispatch('[data-removal]',{removal:'cancel'});
 await settle();
 assert.equal(requests[4].action,'cancel');assert.equal(requests[4].booking_id,'weekly');
 assert.equal(occurrences.length,1);
 dispatch('[data-remove-booking]',{removeBooking:'once',occurrence:initialStart+86400});
 await settle();
 assert.equal(requests[5].action,'cancel');assert.equal(requests[5].booking_id,'once');
 assert.doesNotMatch(panel.awayCalendarButton(),/class="header-count"/);
 assert.equal(currentDialog.nodes['.no-bookings'].hidden,false);
 assert.equal(currentDialog.nodes['.booking-pages'].hidden,true);
 occurrences=Array.from({length:11},(_,index)=>{
  const start=initialStart+index*7*86400;
  return {id:'paged',start,end:start+93600,repeat:'weekly',repeat_count:11,active:false};
 });
 panel.info.data.away={schedules:[occurrences[0]],occurrences,occurrence_count:11,time_zone:'Europe/Helsinki'};
 panel.openAwayCalendar();
 assert.equal(currentDialog.nodes['.booking-pages'].hidden,false);
 assert.equal(currentDialog.nodes['.booking-page-controls'].hidden,false);
 assert.equal(currentDialog.nodes['.booking-total'].textContent,'Poissaoloja yhteensä · 11');
 assert.equal(currentDialog.nodes['.booking-page-number'].textContent,'1 / 3');
 assert.equal((currentDialog.nodes['.bookings'].innerHTML.match(/<li>/g)||[]).length,5);
 const pageSizeMenu=currentDialog.html.match(/<select name="booking-page-size">(.*?)<\/select>/)[1];
 assert.deepEqual([...pageSizeMenu.matchAll(/value="(\d+)"/g)].map(option=>option[1]),['5','10','20']);
 dispatch('[data-booking-page]',{bookingPage:'1'});
 assert.equal(currentDialog.nodes['.booking-page-number'].textContent,'2 / 3');
 const pageSize=values('booking-page-size');
 pageSize.value='20';
 pageSize.listeners.change({target:pageSize});
 assert.equal(currentDialog.nodes['.booking-page-controls'].hidden,true);
 assert.equal((currentDialog.nodes['.bookings'].innerHTML.match(/<li>/g)||[]).length,11);
 pageSize.value='10';
 pageSize.listeners.change({target:pageSize});
 assert.equal(currentDialog.nodes['.booking-page-number'].textContent,'1 / 2');
 assert.equal((currentDialog.nodes['.bookings'].innerHTML.match(/<li>/g)||[]).length,10);
 dispatch('[data-booking-page]',{bookingPage:'1'});
 assert.equal(currentDialog.nodes['.booking-page-number'].textContent,'2 / 2');
 assert.equal((currentDialog.nodes['.bookings'].innerHTML.match(/<li>/g)||[]).length,1);
 assert.match(currentDialog.nodes['.bookings'].innerHTML,/Muokkaa sarjaa/);
 const pageTwoStart=occurrences[10].start;
 dispatch('[data-edit-booking]',{editBooking:'paged'});
 assert.equal(values('repeat-count').value,11);
 currentDialog.nodes['.cancel-edit'].listeners.click();
 dispatch('[data-remove-booking]',{removeBooking:'paged',occurrence:pageTwoStart});
 dispatch('[data-removal]',{removal:'skip'});
 await settle();
 assert.deepEqual(requests.at(-1),{type:'away',action:'skip',booking_id:'paged',occurrence:pageTwoStart});
 assert.equal(currentDialog.nodes['.booking-page-controls'].hidden,true);
 assert.equal(currentDialog.nodes['.booking-total'].textContent,'Poissaoloja yhteensä · 10');
 assert.equal((currentDialog.nodes['.bookings'].innerHTML.match(/<li>/g)||[]).length,10);
 console.log('Away calendar defaults, badge, editing, independent cancellation, recurrence choices and settings drafts passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
