/* Verify shared-space editing without a browser or a Home Assistant instance. */
const {readFrontendSource}=require('./frontend_source.cjs');
const vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
let Panel;
class Element{attachShadow(){this.shadowRoot={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};}}
const context={HTMLElement:Element,customElements:{get:()=>undefined,define:(_,value)=>Panel=value},
 structuredClone,Date,Number,String,Object,Math,JSON,Infinity,console,setTimeout,clearTimeout,setInterval,clearInterval};
vm.createContext(context);
vm.runInContext(readFrontendSource(path.join(__dirname,'../custom_components/thermal_pilot/frontend/panel.js')),context);
const panel=new Panel();
panel.settings={house_heat_source:'air_to_water',rooms:['a','b','c','d'].map(id=>({id,name:id.toUpperCase(),heat_control:'house',shared_air_rooms:[]}))};
panel._hass={states:{}};
const peers=id=>Array.from(panel.settings.rooms.find(room=>room.id===id).shared_air_rooms);
panel.updateSharedAirRooms('a',['b']);
assert.deepEqual(peers('a'),['b']);assert.deepEqual(peers('b'),['a']);
panel.updateSharedAirRooms('b',['a','c']);
assert.deepEqual(peers('a'),['b','c']);assert.deepEqual(peers('c'),['a','b']);
panel.updateSharedAirRooms('a',['c']);
assert.deepEqual(peers('a'),['c']);assert.deepEqual(peers('b'),[]);assert.deepEqual(peers('c'),['a']);
panel.updateSharedAirRooms('a',['b','c']);
panel.updateSharedAirRooms('a',[]);
assert.deepEqual(peers('a'),[]);assert.deepEqual(peers('b'),['c']);assert.deepEqual(peers('c'),['b']);
// Joining an existing group requires one selection, not reciprocal setup.
panel.updateSharedAirRooms('a',['b']);
assert.deepEqual(peers('a'),['b','c']);
const field=['shared_air_rooms','Shared air space','room_links'];
let markup=panel.field(field,panel.settings.rooms[0],'room0');
assert.doesNotMatch(markup,/<option[^>]*value="a"/);
assert.match(markup,/<option[^>]*value="c"[^>]*disabled/);
assert.match(markup,/data-shared-air-member/);assert.match(markup,/Add room/);assert.match(markup,/Remove room from shared air space/);
assert.match(markup,/Each circuit keeps its own sensor, target and limits/);
panel.settings.rooms[3].is_garage=true;
assert.doesNotMatch(panel.field(field,panel.settings.rooms[0],'room0'),/<option[^>]*value="d"/);
// Capture reads all selectors before reciprocal changes, so stale sibling DOM
// selections cannot restore a deliberately detached member.
const selections={a:['c'],b:['a','c'],c:['a','b']};
const renderedSelections=Object.fromEntries(panel.settings.rooms.map(room=>[room.id,JSON.stringify(room.shared_air_rooms.filter(Boolean))]));
panel.shadowRoot.querySelectorAll=selector=>selector==='[data-entity-list]'?panel.settings.rooms.slice(0,3).map((room,index)=>({dataset:{entityList:`room${index}.shared_air_rooms`,sharedAirSelection:renderedSelections[room.id]},querySelectorAll:()=>selections[room.id].map(value=>({value}))})):[];
panel.capture();
assert.deepEqual(peers('a'),['c']);assert.deepEqual(peers('b'),[]);assert.deepEqual(peers('c'),['a']);
// Empty Add-room drafts survive rerenders but never enter saved settings.
selections.a=['c',''];selections.b=[];selections.c=['a'];
panel.capture(true);assert.deepEqual(peers('a'),['c','']);
panel.capture();assert.deepEqual(peers('a'),['c']);
// All new UI and validation text is present in every shipped language.
const fs=require('node:fs');
for(const filename of fs.readdirSync(path.join(__dirname,'../custom_components/thermal_pilot/frontend/languages'))){
 const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'../custom_components/thermal_pilot/frontend/languages',filename)));
 for(const key of ['Shared air space','Remove room from shared air space','Shared air space: select each room only once.','Shared air space: select another existing room.','Shared air space: select primary heating circuits, not heat pumps or garages.'])assert.ok(catalog.messages[key],filename+': '+key);
}
console.log('Shared-air-space selector, reciprocal editing, drafts and localization checks passed.');

(async()=>{
 const editor=new Panel();
 editor.settings={house_heat_source:'air_to_water',language:'en',simulation_enabled:true,rooms:['a','b','c'].map(id=>({id,name:id.toUpperCase(),baseline:20,heat_control:'house',shared_air_rooms:[]}))};
 editor.info={settings:structuredClone(editor.settings),source_fields:[],room_fields:[field],zone_fields:[],data:{}};
 editor._hass={states:{}};editor.tab='rooms';
 const handlers={},notice={hidden:true};let lists=[],html='',saved;
 const form={addEventListener:(name,callback)=>handlers[name]=callback,querySelector:()=>null,querySelectorAll:()=>[]};
 const decodeAttribute=value=>value.replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&amp;','&');
 Object.defineProperty(editor.shadowRoot,'innerHTML',{get:()=>html,set:value=>{
  html=value;
  // A rerender replaces the real selects. Until then their values and rendered
  // baseline stay unchanged even if capture adds links in another room's model.
  lists=editor.settings.rooms.map((room,index)=>{
   const markup=editor.field(field,room,`room${index}`);
   const baseline=markup.match(/data-shared-air-selection="([^"]*)"/);
   const selects=room.shared_air_rooms.map(value=>({value,dataset:{},hasAttribute:name=>name==='data-shared-air-member'}));
   return {dataset:{entityList:`room${index}.shared_air_rooms`,...(baseline?{sharedAirSelection:decodeAttribute(baseline[1])}:{})},selects,querySelectorAll:()=>selects};
  });
 }});
 editor.shadowRoot.querySelector=selector=>selector==='#settings'?form:selector==='#settings-unsaved'?notice:null;
 editor.shadowRoot.querySelectorAll=selector=>selector==='[data-entity-list]'?lists:[];
 editor.call=async(action,payload)=>{assert.equal(action,'save');saved=structuredClone(payload);return {saved:true};};
 editor.render();
 const roomPeers=id=>Array.from(editor.settings.rooms.find(room=>room.id===id).shared_air_rooms).filter(Boolean);
 const click=(roomIndex,remove)=>{
  const list=lists[roomIndex];
  const button={dataset:remove===undefined?{}:{removeSensor:String(remove)},hasAttribute:name=>name==='data-add-sensor'&&remove===undefined,closest:()=>list};
  handlers.click({preventDefault(){},target:{closest:()=>button}});
 };
 const select=(roomIndex,index,value)=>{
  const target=lists[roomIndex].selects[index];target.value=value;
  // Native selects dispatch input before change. Both handlers read settings.
  handlers.input({target});handlers.change({target});
 };
 click(0);select(0,0,'b');
 assert.deepEqual(roomPeers('a'),['b'],'native input/change must retain the first selection');
 assert.deepEqual(roomPeers('b'),['a'],'untouched reciprocal dropdown must not remove the new link');
 assert.equal(lists[0].selects[0].value,'b','selection stays visible after rerender');
 click(0);select(0,1,'c');
 assert.deepEqual(roomPeers('a'),['b','c']);assert.deepEqual(roomPeers('b'),['a','c']);assert.deepEqual(roomPeers('c'),['a','b']);
 click(0,1);assert.deepEqual(roomPeers('a'),['b']);assert.deepEqual(roomPeers('c'),[]);
 select(0,0,'');assert.deepEqual(roomPeers('a'),[]);assert.deepEqual(roomPeers('b'),[]);
 click(1);select(1,0,'a');assert.deepEqual(roomPeers('a'),['b']);assert.deepEqual(roomPeers('b'),['a']);
 await handlers.submit({preventDefault(){}});clearTimeout(editor.saveMessageTimer);
 assert.deepEqual(Array.from(saved.settings.rooms[0].shared_air_rooms),['b']);
 assert.deepEqual(Array.from(saved.settings.rooms[1].shared_air_rooms),['a']);
 editor.settings=structuredClone(saved.settings);editor.render();
 assert.equal(lists[0].selects[0].value,'b');assert.equal(lists[1].selects[0].value,'a');
 console.log('Shared-air-space native input/change, multiple selections, removal and save/reload passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
