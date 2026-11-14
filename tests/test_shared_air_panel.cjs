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
panel.shadowRoot.querySelectorAll=selector=>selector==='[data-entity-list]'?panel.settings.rooms.slice(0,3).map((room,index)=>({dataset:{entityList:`room${index}.shared_air_rooms`},querySelectorAll:()=>selections[room.id].map(value=>({value}))})):[];
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
