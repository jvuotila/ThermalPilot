/* Read-only source checks and provider-specific settings using production methods. */
const {readFrontendSource}=require('./frontend_source.cjs');
const vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
let Panel;
class Element{attachShadow(){this.shadowRoot={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};}}
const context={HTMLElement:Element,customElements:{get:()=>undefined,define:(_,value)=>Panel=value},
 structuredClone,Intl,Date,Number,String,Object,Math,JSON,Infinity,console,setTimeout,clearTimeout,setInterval,clearInterval};
vm.createContext(context);
vm.runInContext(readFrontendSource(path.join(__dirname,'../custom_components/thermal_pilot/frontend/panel.js')),context);
(async()=>{
 const panel=new Panel();
 panel.settings={language:'en',price_entity:'sensor.community',rooms:[]};
 panel.info={price_provider_options:{nordpool_entries:[{id:'entry',name:'Nord Pool Finland',areas:['FI','SE3']}]}};
 panel._hass={states:{'sensor.community':{entity_id:'sensor.community',state:'10',attributes:{today:[10],friendly_name:'Existing sensor'}}}};
 let markup=panel.field(['price_entity','Price sensor','sensor',{kind:'price'}],panel.settings,'source');
 assert.match(markup,/value="static"/);assert.match(markup,/value="nordpool"/);assert.match(markup,/value="tibber"/);
 assert.match(markup,/value="sensor.community" selected/,'existing community sensor remains selected');
 panel.settings.nordpool_entry='entry';
 markup=panel.field(['nordpool_area','Price area','text'],panel.settings,'source');
 assert.match(markup,/value="FI"/);assert.match(markup,/value="SE3"/);assert.match(markup,/Automatic/);
 const fields=[['price_entity','Price sensor','sensor',{kind:'price'}],['price_unit','Source price unit','select:c/kWh,€/kWh,€/MWh'],['nordpool_entry','Nord Pool integration','text'],['nordpool_area','Price area','text'],['nordpool_vat','VAT (%)','number',0,100,.1],['nordpool_margin','Retailer margin including VAT (c/kWh)','number',-1000,10000,.01],['tibber_price_entity','Tibber price sensor','sensor',{kind:'tibber_price'}]];
 panel.info.source_fields=fields;
 for(const source of ['nordpool','tibber','sensor.community']){
  panel.settings.price_entity=source;
  const view=panel.settingsGroups([['Electricity price settings',fields.map(field=>field[0])]]);
  assert.equal(view.includes('data-field="source.nordpool_vat"'),source==='nordpool');
  assert.equal(view.includes('data-field="source.tibber_price_entity"'),source==='tibber');
  assert.equal(view.includes('data-field="source.price_unit"'),source==='sensor.community');
 }
 panel.capture=()=>{};panel.render=()=>{};
 const calls=[];let resolve;
 panel.call=(action,payload)=>{calls.push({action,payload});return new Promise(done=>resolve=done);};
 const request=panel.testSources();
 assert.equal(panel.testingSources,true);
 assert.equal(calls[0].action,'test_sources');
 assert.deepEqual(calls[0].payload.settings,panel.settings);
 const report={prices:{ok:true,unit:'c/kWh',interval_minutes:[15],start:'2026-01-02T00:00:00Z',end:'2026-01-03T00:00:00Z'},weather:{ok:false,error:'No usable weather forecast was returned.'}};
 resolve(report);await request;
 markup=panel.sourceCheckView();
 assert.match(markup,/class="source-checks"><h4>Source checks<\/h4>/);
 assert.doesNotMatch(markup,/<details|<summary/,'source checks stay visible');
 assert.match(markup,/c\/kWh/);assert.match(markup,/15 min/);assert.match(markup,/No usable weather/);
 assert.equal(panel.testingSources,false);assert.equal(calls.length,1,'no save or control action');
 const changed=panel.testSources();panel.settings.price_entity='static';resolve(report);await changed;
 assert.equal(panel.sourceCheck,null,'an obsolete draft must not receive a successful report');
 panel.call=async()=>{panel.settings.static_price=9;throw Error('old draft');};
 await panel.testSources();assert.equal(panel.sourceCheckError,'','an obsolete failure must also be discarded');
 console.log('Source UI passed: provider choices, existing sensor selection, read-only draft checks and stale-response protection.');
})().catch(error=>{console.error(error);process.exitCode=1;});

const fs=require('node:fs');
for(const filename of fs.readdirSync(path.join(__dirname,'../custom_components/thermal_pilot/frontend/languages'))){
 const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'../custom_components/thermal_pilot/frontend/languages',filename)));
 for(const key of ['Maintenance','Source checks','Test sources','Testing sources…','Nord Pool integration','Price area','VAT (%)','Retailer margin including VAT (c/kWh)','Tibber price sensor','Unsupported temperature unit.','Select an available Tibber price sensor using EUR/kWh.','The selected provider action is unavailable.','Choose a Nord Pool integration and price area.','Source request failed; check the provider integration.','No usable weather forecast was returned.'])assert.ok(catalog.messages[key],filename+': '+key);
}
