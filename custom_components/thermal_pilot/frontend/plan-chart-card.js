// Share the Plan chart renderer, localization and hover details with the panel.
// Use the same versioned module URL as the sidebar; custom elements register only once.
await import(new URL(`./panel.js${new URL(import.meta.url).search}`, import.meta.url));
(() => {
const Panel=customElements.get('thermal-pilot-panel');
const tpI18n=globalThis.__thermalPilotLocalization;
const cardLanguages=tpI18n.languageNames;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const toggleFields=['show_weather','show_prices','show_manual_controls','show_cop'];
function validate(value){
 for(const key of toggleFields)if(value[key]!==undefined&&typeof value[key]!=='boolean')throw Error(key+' must be a boolean.');
 if(value.language!==undefined&&value.language!=='auto'&&!Object.hasOwn(cardLanguages,value.language))throw Error('Invalid card language.');if(value.title!==undefined&&typeof value.title!=='string')throw Error('title must be text.');if(value.entry_id!==undefined&&typeof value.entry_id!=='string')throw Error('entry_id must be text.');return {...value};}
const css=`:host{display:block;color:var(--primary-text-color,#213547);font:14px system-ui}*{box-sizing:border-box}ha-card{display:block;overflow:hidden;border-radius:var(--ha-card-border-radius,12px);background:var(--ha-card-background,var(--card-background-color,#edf4fa));border:1px solid var(--ha-card-border-color,var(--divider-color,#bccbd0));box-shadow:var(--ha-card-box-shadow,0 2px 5px #0000000a)}.title{margin:0;padding:20px 20px 4px;font-size:var(--ha-card-header-font-size,20px);line-height:1.4;font-weight:500;overflow-wrap:anywhere}.price-card{padding:8px 12px 12px;margin:0!important;background:transparent!important;border:0}.price-chart-viewport svg text{font-family:system-ui}.chart-tooltip{position:fixed;z-index:10000;pointer-events:none;max-width:min(360px,calc(100vw - 24px));padding:10px 12px;border-radius:8px;background:#213547;color:white;white-space:pre-line;line-height:1.5;box-shadow:0 4px 16px #0004}.chart-tooltip[hidden]{display:none}.message{padding:20px;color:var(--secondary-text-color,#526b75)}`;
class PlanChartCard extends Panel{
 constructor(){super();this._config={};this._request=0;this._connected=false;this.loaded=true;this.settings={language:'en',rooms:[],heating_zones:[]};}
 static getStubConfig(){return {};}
 static getConfigElement(){return document.createElement('thermal-pilot-plan-chart-card-editor');}
 setConfig(value){
  const previous=this._config;
  this._config=validate(value);
  const entryChanged=previous.entry_id!==this._config.entry_id;
  const manualChanged=previous.show_manual_controls!==this._config.show_manual_controls;
  if(entryChanged||manualChanged)this.manualDialog?.close();
  if(entryChanged){this._request++;this.info=null;}
  this.render();
  if(!this.info||manualChanged){
   if(this._loading&&manualChanged&&!entryChanged)this._request++;
   this.refresh();
  }
 }
 set hass(value){
  const connectionChanged=this._hass?.connection!==value?.connection;
  const adminChanged=this._hass?.user?.is_admin!==value?.user?.is_admin;
  this._hass=value;
  if(connectionChanged||adminChanged){
   this.manualDialog?.close();
   if(this._loading)this._request++;
   if(connectionChanged)this.info=null;
   this.render();
  }
  if(connectionChanged||adminChanged||!this.info)this.refresh();
 }
 connectedCallback(){this._connected=true;this.refresh();clearInterval(this._timer);this._timer=setInterval(()=>this.refresh(),60000);}
 disconnectedCallback(){this.manualDialog?.close();this._connected=false;this._request++;this._loading=false;clearInterval(this._timer);this.priceResizeObserver?.disconnect();}
 getCardSize(){return Math.max(4,Math.ceil((this._chartHeight||400)/50));}
 getGridOptions(){return {columns:12,min_columns:6};}
 // Also used by the shared resize handler: always render the compact Plan variant.
 chartVisibility(){
  return {
   weather:this._config.show_weather!==false,
   prices:this._config.show_prices!==false,
   manual:this._config.show_manual_controls===true&&this._hass?.user?.is_admin===true,
   cop:this._config.show_cop!==false&&this.info?.cop_available===true
  };
 }
 get entry(){return this.info?.entry_id;}
 async load(){
  // Refresh through the card endpoint after the shared manual session dialog saves.
  if(this._loading)this._request++;
  this.render();
  await this.refresh();
 }
 priceChart(){return super.priceChart(false,true);}
 async refresh(){
  if(!this._connected||!this._hass?.callWS||this._loading)return;
  const request=++this._request;this._loading=true;
  try{const result=await this._hass.callWS({type:'thermal_pilot/plan_chart',...(this._config.entry_id?{entry_id:this._config.entry_id}:{}),...(this.chartVisibility().manual?{include_manual_controls:true}:{})});if(request!==this._request)return;
   this.info=result;this._integrationLanguage=result.settings?.language;this.settings={...(result.settings||{language:this._hass.language||'en',rooms:[],heating_zones:[]})};this.statusHistory=result.history||[];this._error=false;
  }catch(error){if(request!==this._request)return;this._error=true;}
  finally{if(request===this._request){this._loading=false;this.render();}else if(this._connected){this._loading=false;this.refresh();}}
 }
 render(){
  this.priceResizeObserver?.disconnect();
  this.settings.language=this._config.language&&this._config.language!=='auto'?this._config.language:this._integrationLanguage||this.settings.language||'en';
  const language=this.settings?.language||this._hass?.language||'en',t=text=>tpI18n.cardText(text,language);tpI18n.watch(this,language);
  let message=this._error?(t("Unable to load ThermalPilot data.")):!this.info?(t("Loading…")):this.info.requires_selection?(t("Choose a ThermalPilot integration in the card settings.")):!this.info.entries?.length?(t("ThermalPilot is not loaded.")):null;
  this.shadowRoot.innerHTML=`<style>${css}</style><ha-card>${this._config.title?.trim()?`<h2 class="title" data-user-text>${esc(this._config.title)}</h2>`:''}${message?`<div class="message" role="status">${esc(message)}</div>`:this.priceChart()}</ha-card>`;
  if(!message){this.translateRoot(this.shadowRoot);this.mountPriceChartSizing();const svg=this.shadowRoot.querySelector('svg');this._chartHeight=Number(svg?.getAttribute('height'))||svg?.getBoundingClientRect?.().height||400;}
 }
}
class PlanChartEditor extends HTMLElement{
 constructor(){super();this.attachShadow({mode:'open'});this._entries=[];}
 setConfig(value){const next=validate(value),previous=this._config;this._config=next;if(previous&&previous.title===next.title&&previous.entry_id===next.entry_id&&(previous.language||'auto')===(next.language||'auto')&&toggleFields.every(key=>previous[key]===next[key]))return;this.render();}
 set hass(value){
  const connectionChanged=this._hass?.connection!==value?.connection;
  const adminChanged=this._hass?.user?.is_admin!==value?.user?.is_admin;
  this._hass=value;
  const form=this.shadowRoot.querySelector('ha-form');
  if(form)form.hass=value;
  if(adminChanged)this.render();
  if((connectionChanged||!this._metadataRequest)&&value?.callWS){
   const request=value.callWS({type:'thermal_pilot/plan_chart',metadata_only:true});
   this._metadataRequest=request;
   request.then(result=>{
    if(this._metadataRequest!==request)return;
    this._entries=result.entries||[];
    this.render();
   }).catch(()=>{if(this._metadataRequest===request)this._metadataRequest=null;});
  }
 }
 update(patch){this._config={...this._config,...patch};this.dispatchEvent(new CustomEvent('config-changed',{detail:{config:this._config},bubbles:true,composed:true}));}
 render(){
  if(!this._config)return;
  const selectedEntry=this._config.entry_id
   ?this._entries.find(entry=>entry.entry_id===this._config.entry_id)
   :this._entries.length===1?this._entries[0]:null;
  const language=this._config.language&&this._config.language!=='auto'?this._config.language:selectedEntry?.language||this._hass?.language||'en';
  const t=text=>tpI18n.cardText(text,language);
  tpI18n.watch(this,language);
  const schema=[
   {name:'title',selector:{text:{}}},
   ...(this._entries.length>1?[{name:'entry_id',selector:{select:{mode:'dropdown',options:[
    {value:'',label:t('Automatic (single integration)')},
    ...this._entries.map(entry=>({value:entry.entry_id,label:entry.title}))
   ]}}}]:[]),
   {name:'language',selector:{select:{mode:'dropdown',options:[
    {value:'auto',label:t('Use integration language')},
    ...Object.entries(cardLanguages).sort((a,b)=>a[1].localeCompare(b[1],'en')).map(([value,label])=>({value,label}))
   ]}}},
   {name:'show_weather',selector:{boolean:{}}},
   {name:'show_prices',selector:{boolean:{}}},
   ...(this._hass?.user?.is_admin?[{name:'show_manual_controls',selector:{boolean:{}}}]:[]),
   ...(selectedEntry?.cop_available?[{name:'show_cop',selector:{boolean:{}}}]:[])
  ];
  const fieldLabels={title:'Title (optional)',entry_id:'Integration',language:'Language',show_weather:'Show weather forecast',show_prices:'Show electricity prices',show_manual_controls:'Show manual heating and cooling controls',show_cop:'Show heat pump COP chart'};
  const data={title:this._config.title||'',entry_id:this._config.entry_id||'',language:this._config.language||'auto',show_weather:this._config.show_weather!==false,show_prices:this._config.show_prices!==false,show_manual_controls:this._config.show_manual_controls===true,show_cop:this._config.show_cop!==false};
  // Keep the HA form mounted: rebuilding it during config echoes or a late
  // integration-list response would interrupt typing and close open menus.
  let form=this.shadowRoot.querySelector('ha-form');
  if(!form){
   this.shadowRoot.innerHTML='<style>:host{display:block;color:var(--primary-text-color)}ha-form{display:block}</style><ha-form></ha-form>';
   form=this.shadowRoot.querySelector('ha-form');
   form.addEventListener('value-changed',event=>{
    event.stopPropagation();
    const schemaChanged=event.detail.value.language!==this._config.language||event.detail.value.entry_id!==this._config.entry_id;
    form.data=event.detail.value;
    this.update(event.detail.value);
    if(schemaChanged)this.render();
   });
  }
  form.hass=this._hass;
  form.schema=schema;
  form.data=data;
  form.computeLabel=field=>t(fieldLabels[field.name]||field.name);
 }
}
if(!customElements.get('thermal-pilot-plan-chart-card'))customElements.define('thermal-pilot-plan-chart-card',PlanChartCard);
if(!customElements.get('thermal-pilot-plan-chart-card-editor'))customElements.define('thermal-pilot-plan-chart-card-editor',PlanChartEditor);
globalThis.customCards=globalThis.customCards||[];
if(!globalThis.customCards.some(card=>card.type==='thermal-pilot-plan-chart-card'))globalThis.customCards.push({type:'thermal-pilot-plan-chart-card',name:'ThermalPilot heating plan',description:'Electricity prices and heating timelines for rooms, garages and zones.',preview:true});
})();
