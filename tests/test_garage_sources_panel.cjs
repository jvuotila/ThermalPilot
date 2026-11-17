/* Garage form and source-dependent visibility; no browser layout claims. */
const {readFrontendSource}=require('./frontend_source.cjs');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
let Panel;
class Element{attachShadow(){this.shadowRoot={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};}}
const context={HTMLElement:Element,customElements:{get:()=>undefined,define:(_,value)=>Panel=value},structuredClone,Intl,Date,Number,String,Object,Math,JSON,Infinity,console,setTimeout,clearTimeout,setInterval,clearInterval};
vm.createContext(context);vm.runInContext(readFrontendSource(path.join(__dirname,'../custom_components/thermal_pilot/frontend/panel.js')),context);
const source=fs.readFileSync(path.join(__dirname,'../PREVIEW.html'),'utf8');
const info=JSON.parse(source.match(/const demo=([\s\S]*?);const states=/)[1]);
const panel=new Panel();panel.info=info;panel.settings=structuredClone(info.settings);panel.tab='rooms';
panel._hass={states:{'climate.test':{entity_id:'climate.test',state:'heat',attributes:{friendly_name:'Test thermostat',hvac_modes:['heat','off'],fan_modes:['high'],swing_modes:['both']}}}};
const room={...info.room_defaults,id:'garage',name:'Garage',thermostat:'climate.test',is_garage:true,garage_fan_heat:'high',garage_swing:'both',garage_door_entities:['binary_sensor.door']};
panel.settings.rooms=[room];
const houseSources=info.source_fields.find(field=>field[0]==='house_heat_source')[2].slice(7).split(',');
for(const garage of [false,true,false]){
 room.is_garage=garage;
 const fields=[...panel.roomSettingsFields(room,0).matchAll(/data-field="room0\.([^" ]+)"/g)].map(match=>match[1]);
 assert.deepEqual(fields.slice(0,2),['name','is_garage'],'Garage toggle stays beside the name in both room types');
}
room.is_garage=true;

for(const heatSource of houseSources){
 for(const selection of ['house','air_to_air']){
  panel.settings.house_heat_source=heatSource;
  room.garage_heat_source=selection;
  const pump=selection==='air_to_air'||heatSource==='air_to_air';
  const html=panel.roomSettingsFields(room,0);
  assert.match(html,/data-field="room0.garage_heat_source"/);
  assert.match(html,/Use house heating system/);
  assert.ok(html.includes('value="house"'));assert.ok(html.includes('value="air_to_air"'));
  assert.ok(!html.includes('value="gas_boiler"'));
  for(const key of ['garage_heat_target','garage_fan_heat','garage_fan_idle','garage_fan_presence','garage_swing','garage_swing_idle','garage_door_delay','garage_presence_entities']){
   assert.equal(html.includes(`room0.${key}`),pump,`${selection}/${heatSource}: ${key}`);
  }
  assert.equal(html.includes('data-field="room0.activity_entity"'),!pump);
  assert.ok(html.includes('data-entity-list="room0.garage_door_entities"'));
  assert.equal(html.includes('data-field="room0.garage_door_warning_minutes"'),!pump);
  assert.equal(room.garage_fan_heat,'high');assert.equal(room.garage_swing,'both');
 }
}
panel.settings.house_heat_source='electric_resistance';room.garage_heat_source='house';
for(const sensors of [[],['']]){
 room.garage_door_entities=sensors;
 assert.ok(!panel.roomSettingsFields(room,0).includes('data-field="room0.garage_door_warning_minutes"'));
}
room.garage_door_entities=['binary_sensor.door'];
const withDoor=panel.roomSettingsFields(room,0);
assert.ok(withDoor.indexOf('data-entity-list="room0.garage_door_entities"')<withDoor.indexOf('data-field="room0.garage_door_warning_minutes"'));
delete room.garage_heat_source;
assert.match(panel.roomSettingsFields(room,0),/data-field="room0.garage_heat_target"/,'legacy garage keeps pump controls');
const handlers={},form={addEventListener:(name,handler)=>handlers[name]=handler};
panel.shadowRoot.querySelector=selector=>selector==='#settings'?form:null;
panel.render();
let captures=0,renders=0;panel.capture=()=>captures++;panel.render=()=>renders++;
panel.updateSourceReadings=()=>{};
handlers.change({target:{dataset:{field:'room0.garage_heat_source'}}});
assert.equal(captures,1);assert.equal(renders,1,'source selection immediately updates visibility');
handlers.change({target:{closest:()=>({dataset:{entityList:'room0.garage_door_entities'}})}});
assert.equal(captures,2);assert.equal(renders,2,'door selection immediately updates warning-delay visibility');
panel.settings.language='fi';room.garage_heat_source='house';
const finnish=panel.roomSettingsFields(room,0);
assert.equal(panel.t('Heat source'),'Lämmönlähde');
assert.match(panel.t(vm.runInContext('settingHelp.garage_heat_source',context)),/Talon lämmitysjärjestelmä/);
assert.match(panel.t(vm.runInContext('settingHelp.garage_door_warning_minutes',context)),/Lähetä ilmoitus/);
console.log('Garage form: every heat source, pump-only settings and door protection, relay visibility, legacy selection, Finnish help and live source changes passed.');

// Settings drafts stay put; successful save replaces the saved snapshot.
const ordering=new Panel();ordering._hass={states:{}};ordering.info=structuredClone(info);
const saved=[{...info.room_defaults,id:'room',name:'Zulu'},
 {...info.room_defaults,id:'old-garage',name:'Garage',is_garage:true}];
ordering.info.settings={...structuredClone(info.settings),rooms:structuredClone(saved)};
ordering.settings=structuredClone(ordering.info.settings);
ordering.settings.rooms.push({...info.room_defaults,id:'new-one',name:'Alpha'},
 {...info.room_defaults,id:'new-two',name:'Beta'});
const order=()=>[...ordering.settingsView('rooms').matchAll(/data-settings-disclosure="([^" ]+)"/g)].map(match=>match[1]).filter(id=>ordering.settings.rooms.some(room=>room.id===id));
assert.deepEqual(order(),['room','old-garage','new-one','new-two']);
ordering.settings.rooms[2].is_garage=true;
ordering.settings.rooms[0].name='A renamed room';
assert.deepEqual(order(),['room','old-garage','new-one','new-two']);
assert.equal(ordering.settings.rooms[2].id,'new-one','visual order never changes form-array indices');
ordering.info.settings=structuredClone(ordering.settings);
assert.deepEqual(order(),['room','new-two','new-one','old-garage']);
console.log('New rooms append after garages, retain their position during edits, and sort after successful save.');
