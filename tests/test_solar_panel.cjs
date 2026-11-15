/* Solar settings behavior with production rendering; no browser/layout claims. */
const {readFrontendSource}=require('./frontend_source.cjs');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
let Panel;
class Element{attachShadow(){this.shadowRoot={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};}}
const context={HTMLElement:Element,customElements:{get:()=>undefined,define:(_,value)=>Panel=value},structuredClone,Intl,Date,Number,String,Object,Math,JSON,Infinity,console,setTimeout,clearTimeout,setInterval,clearInterval};
vm.createContext(context);vm.runInContext(readFrontendSource(path.join(__dirname,'../custom_components/thermal_pilot/frontend/panel.js')),context);
const preview=fs.readFileSync(path.join(__dirname,'../PREVIEW.html'),'utf8');
const info=JSON.parse(preview.match(/const demo=([\s\S]*?);const states=/)[1]);
const panel=new Panel();panel.info=info;panel.settings=structuredClone(info.settings);panel.tab='settings';
panel._hass={states:{'sensor.demo_solar_production':{entity_id:'sensor.demo_solar_production',state:'5200',attributes:{friendly_name:'PV power',device_class:'power',unit_of_measurement:'W'}},'sensor.energy':{entity_id:'sensor.energy',state:'5',attributes:{device_class:'energy',unit_of_measurement:'kWh'}}}};
let markup=panel.settingsView();
assert.ok(markup.indexOf('<h3>Solar power heating settings</h3>')>markup.indexOf('<h3>Heating settings</h3>'));
for(const key of ['solar_power_entity','solar_start_kw','solar_stop_kw','solar_minimum_run_minutes'])assert.equal(markup.split(`data-field="source.${key}"`).length-1,1,key);
assert.match(markup,/data-solar-range="source.solar_start_kw"/);assert.match(markup,/data-solar-range="source.solar_stop_kw"/);
const sensorField=info.source_fields.find(field=>field[0]==='solar_power_entity');
const sensorMarkup=panel.field(sensorField,panel.settings,'source');assert.match(sensorMarkup,/PV power/);assert.doesNotMatch(sensorMarkup,/value="sensor.energy"/);assert.match(sensorMarkup,/5200 W/);
assert.match(sensorMarkup,/other household loads/);assert.match(markup,/preserved across restarts/);
// Both control surfaces use one authoritative numeric field for capture/save.
const handlers={},form={addEventListener:(name,callback)=>handlers[name]=callback};
panel.shadowRoot.querySelector=selector=>selector==='#settings'?form:null;
let numeric={value:'4'},slider={value:'4',max:20},changed=0;
const group={querySelector:selector=>selector==='[data-field]'?numeric:slider};
panel.updateUnsavedNotice=()=>changed++;
panel.render();
handlers.input({target:{dataset:{solarRange:'source.solar_start_kw'},value:'6.2',closest:()=>group}});
assert.equal(numeric.value,'6.2');
handlers.input({target:{dataset:{field:'source.solar_start_kw'},value:'25',closest:()=>group}});
assert.equal(slider.value,'25');assert.equal(slider.max,30);assert.equal(changed,2);
// Sensor selection rerenders immediately and retains unsaved thresholds even
// after the numeric controls disappear from the form.
const sensor={dataset:{field:'source.solar_power_entity'},type:'select-one',value:'',hasAttribute:()=>false};
let fields=[sensor,{dataset:{field:'source.solar_start_kw'},type:'number',value:'6.2'},
 {dataset:{field:'source.solar_stop_kw'},type:'number',value:'2'},
 {dataset:{field:'source.solar_minimum_run_minutes'},type:'number',value:'45'}];
panel.shadowRoot.querySelectorAll=selector=>selector==='[data-field]'?fields:[];
panel.render=()=>{
 markup=panel.settingsView();
 fields=panel.settings.solar_power_entity?[sensor,
  ...['solar_start_kw','solar_stop_kw','solar_minimum_run_minutes'].map(key=>({dataset:{field:`source.${key}`},type:'number',value:String(panel.settings[key])}))]:[sensor];
};
handlers.change({target:sensor});
assert.match(markup,/data-field="source.solar_power_entity"/);
for(const key of ['solar_start_kw','solar_stop_kw','solar_minimum_run_minutes'])assert.ok(!markup.includes(`data-field="source.${key}"`),key+' hidden without sensor');
assert.equal(panel.settings.solar_start_kw,6.2);assert.equal(panel.settings.solar_stop_kw,2);assert.equal(panel.settings.solar_minimum_run_minutes,45);
sensor.value='sensor.demo_solar_production';handlers.change({target:sensor});
for(const key of ['solar_start_kw','solar_stop_kw','solar_minimum_run_minutes'])assert.ok(markup.includes(`data-field="source.${key}"`),key+' restored with sensor');
assert.equal(panel.settings.solar_start_kw,6.2);assert.equal(panel.settings.solar_stop_kw,2);assert.equal(panel.settings.solar_minimum_run_minutes,45);
panel.settings.language='fi';
assert.equal(panel.t('Solar power heating settings'),'Aurinkovoimalan lämmitysasetukset');
const room=panel.settings.rooms[0];
assert.match(panel.roomHeatingBadge({actual_activity:0,solar_heating:{minimum_until:Date.now()/1000+1800}},room.id),/Aurinkovoimalan lämmitysjakso/);
for(const filename of fs.readdirSync(path.join(__dirname,'../custom_components/thermal_pilot/frontend/languages'))){
 const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'../custom_components/thermal_pilot/frontend/languages',filename)));
 for(const key of ['Solar power heating settings','Solar production power sensor','Start solar heating above (kW)','Stop solar heating below (kW)','Minimum solar heating session (minutes)','Solar heating session','Minimum solar heating until','Solar heating: the stop threshold must be lower than the start threshold.','Solar production sensor is unavailable, stale or has an unsupported unit; solar heating is paused.'])assert.ok(catalog.messages[key],filename+': '+key);
}
console.log('Solar settings order, power-only selector, synchronized sliders/numbers, session tooltip and 25 language catalogs passed.');
