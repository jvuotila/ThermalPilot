/* Settings and tooltip behavior using production rendering, no layout/device claims. */
const {readFrontendSource}=require('./frontend_source.cjs');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
let Panel;
class Element{attachShadow(){this.shadowRoot={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};}}
const context={HTMLElement:Element,customElements:{get:()=>undefined,define:(_,value)=>Panel=value},structuredClone,Intl,Date,Number,String,Object,Math,JSON,Infinity,console,setTimeout,clearTimeout,setInterval,clearInterval};
vm.createContext(context);vm.runInContext(readFrontendSource(path.join(__dirname,'../custom_components/thermal_pilot/frontend/panel.js')),context);
const source=fs.readFileSync(path.join(__dirname,'../PREVIEW.html'),'utf8');
const info=JSON.parse(source.match(/const demo=([\s\S]*?);const states=/)[1]);
const panel=new Panel();panel.info=info;panel.settings=structuredClone(info.settings);panel.tab='rooms';panel._hass={states:{}};
const room=panel.settings.rooms.find(room=>!room.is_garage);room.heating_priority='independent';room.assist_below_target=.7;
panel.settings.house_heat_source='electric_resistance';panel.settings.house_distribution='electric_floor';
let markup=panel.roomSettingsFields(room,0);
assert.match(markup,/data-field="room0.heating_priority"/);assert.match(markup,/Heat pump preferred/);
assert.doesNotMatch(markup,/data-field="room0.assist_below_target"/);
room.heating_priority='heat_pump_preferred';markup=panel.roomSettingsFields(room,0);
assert.match(markup,/data-field="room0.assist_below_target"/);assert.match(markup,/value="0.7"/);
assert.match(markup,/The pump continues heating/);assert.match(markup,/not COP/);
for(const setting of [{house_distribution:'water_floor'},{house_heat_source:'air_to_water'},{house_distribution:'electric_floor',house_heat_source:'electric_resistance',is_garage:true}]){
 const original=structuredClone(panel.settings);const garage=room.is_garage;
 Object.assign(panel.settings,setting);if(setting.is_garage)room.is_garage=true;
 assert.doesNotMatch(panel.roomSettingsFields(room,0),/data-field="room0.heating_priority"/);
 assert.doesNotMatch(panel.roomSettingsFields(room,0),/data-field="room0.assist_below_target"/);
 assert.equal(room.assist_below_target,.7,'hidden settings retain the saved shortfall');
 panel.settings=original;room.is_garage=garage;
}
const badge=panel.roomHeatingBadge({actual_activity:1,heating_assistance:{reason:'Floor heating assists',predicted_temperature:19.3}},room.id);
assert.match(badge,/Floor heating assists/);assert.match(badge,/Predicted temperature after floor response lag: 19.3 °C/);
assert.match(badge,/room-heating actual/,'actual activity is separate from the requested assistance');
const handlers={},form={addEventListener:(name,handler)=>handlers[name]=handler};
panel.shadowRoot.querySelector=selector=>selector==='#settings'?form:null;
panel.render();
let captures=0,renders=0;panel.capture=()=>captures++;panel.render=()=>renders++;
panel.updateSourceReadings=()=>{};panel.updateUnsavedNotice=()=>{};
handlers.change({target:{dataset:{field:'room0.heating_priority'}}});
assert.equal(captures,1);assert.equal(renders,1,'priority changes update threshold visibility');
for(const language of fs.readdirSync(path.join(__dirname,'../custom_components/thermal_pilot/frontend/languages'))){
 const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'../custom_components/thermal_pilot/frontend/languages',language),'utf8'));
 for(const key of ['Heating priority','Allow floor assistance below target by (°C)','Heat pump preferred','Floor heating assists','Floor heating backup'])assert.ok(catalog.messages[key],`${language}: ${key}`);
}
console.log('Heating assistance UI: conditional room controls, preserved settings, actual status, live rerender and 25 languages passed.');
