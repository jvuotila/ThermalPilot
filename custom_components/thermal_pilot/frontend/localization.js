/* Shared translation catalog loader. Translation data lives in languages/<code>.json. */
const catalogBaseURL=new URL(`./languages/${new URL(import.meta.url).search}`,import.meta.url);
const localization=(()=>{
const languageNames={"en": "English", "fi": "Finnish", "sv": "Svenska", "nb": "Norsk (bokmål)", "da": "Dansk", "de": "Deutsch", "pt": "Português", "es": "Español", "fr": "Français", "et": "Eesti", "lv": "Latviešu", "lt": "Lietuvių", "pl": "Polski", "it": "Italiano", "nl": "Nederlands", "is": "Íslenska", "ro": "Română", "cs": "Čeština", "sk": "Slovenčina", "bg": "Български", "sr": "Српски", "hr": "Hrvatski", "el": "Ελληνικά", "sq": "Shqip", "hu": "Magyar"};
const catalogs=new Map(),requests=new Map(),failed=new Set(),watching=new WeakMap();
const finnishText={},heatingFinnishText={},languageText=Object.fromEntries(Object.keys(languageNames).filter(code=>!['en','fi'].includes(code)).map(code=>[code,{}]));
const languagePatterns={},finnishReplacements=[];
const normalize=code=>Object.hasOwn(languageNames,code)?code:'en';
const ready=code=>{code=normalize(code);return code==='en'||catalogs.has(code)||failed.has(code);};
function install(catalog){
 const code=catalog.language;
 if(!Object.hasOwn(languageNames,code))throw Error('Unsupported translation catalog');
 for(const key of ['messages','legacy','cardMessages'])if(!catalog[key]||Object.values(catalog[key]).some(value=>typeof value!=='string'))throw Error('Invalid translation catalog');
 catalogs.set(code,catalog);failed.delete(code);
 if(code==='fi'){
  Object.assign(finnishText,catalog.legacy);Object.assign(heatingFinnishText,catalog.messages);
  finnishReplacements.splice(0,finnishReplacements.length,...Object.entries(finnishText).filter(([key])=>key.length>=5).sort((a,b)=>b[0].length-a[0].length));
 }else if(code!=='en'){
  languageText[code]=catalog.messages;
  languagePatterns[code]=new RegExp(Object.keys(catalog.messages).filter(key=>key.length>=5&&!key.includes('{')).sort((a,b)=>b.length-a.length).map(key=>key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')||'(?!)','g');
 }
 return catalog;
}
async function load(language){
 const code=normalize(language);
 if(catalogs.has(code))return catalogs.get(code);
 if(requests.has(code))return requests.get(code);
 const request=(async()=>{
  try{
   const url=new URL(code+'.json',catalogBaseURL);url.search=catalogBaseURL.search;
   const response=await fetch(url);
   if(!response.ok)throw Error('HTTP '+response.status);
   const catalog=await response.json();if(catalog.language!==code)throw Error('Translation language mismatch');
   return install(catalog);
  }catch(error){failed.add(code);console.warn('ThermalPilot: unable to load '+code+' translations; using English.',error);return null;}
  finally{requests.delete(code);}
 })();requests.set(code,request);return request;
}
function watch(owner,language){
 const code=normalize(language);if(ready(code)){watching.delete(owner);return;}if(watching.get(owner)===code)return;
 watching.set(owner,code);void load(code).then(()=>{if(watching.get(owner)===code){watching.delete(owner);owner.render();}});
}
function message(key,values={},language='en'){
 const catalog=catalogs.get(normalize(language));
 const template=catalog?.messages[key]??catalog?.legacy[key]??key;
 return template.replace(/\{(\w+)\}/g,(token,name)=>Object.hasOwn(values,name)?String(values[name]):token);
}
function translateText(value,language){
  const text=String(value??'');
  if(!ready(language)||failed.has(normalize(language)))return text;
  if(language==='fi'){
    const device=text.match(/^(Settings were not saved: )?(.+): heat pump heating setpoint (-?[\d.]+) °C is outside device limits \((-?[\d.]+)–(-?[\d.]+) °C\)\.$/);
    if(device)return message('{prefix}{name}: heat pump heating setpoint {target} °C is outside device limits ({minimum}–{maximum} °C).',{prefix:device[1]?message('Settings were not saved: ',{},language):'',name:device[2],target:device[3].replace('.',','),minimum:device[4].replace('.',','),maximum:device[5].replace('.',',')},language);
    const legacy=text.match(/^(Settings were not saved: )?(.+): heat pump heating setpoint is outside device limits\.$/);
    if(legacy)return message('{prefix}{name}: heat pump heating setpoint is outside device limits.',{prefix:legacy[1]?message('Settings were not saved: ',{},language):'',name:legacy[2]},language);
  }

  // Save errors combine a fixed prefix with a complete server message. Translate
  // each part separately so messages from the modern catalog are not skipped.
  const saveErrorPrefix='Settings were not saved: ';
  if(text.startsWith(saveErrorPrefix))return message(saveErrorPrefix,{},language)+translateText(text.slice(saveErrorPrefix.length),language);

  if(language==='fi'&&Object.hasOwn(heatingFinnishText,text.trim()))return text.replace(text.trim(),heatingFinnishText[text.trim()]);
  const catalog=languageText[language];
  if(catalog){
    const format=(key,args)=>Object.entries(args).reduce((out,[name,value])=>out.replaceAll('{'+name+'}',value),catalog[key]||key);
    const estimate=text.trim().match(/^About (less than 1|[\d.]+) more days? to the initial thresholds at recent observation rates\.$/);
    if(estimate)return format('{days} more days to the initial thresholds at recent observation rates.',{days:catalog[estimate[1]]||estimate[1]});
    const comparison=text.trim().match(/^(\d+) comparisons · (\d+) with similar heating$/);
    if(comparison)return format('{count} comparisons · {similar} with similar heating',{count:comparison[1],similar:comparison[2]});
    const remove=text.match(/^Remove room "(.*)"\? Save settings to apply this change\.$/);
    if(remove)return format('Remove room "{name}"? Save settings to apply this change.',{name:remove[1]});
    if(text.startsWith('About '))return catalog['About ']+translateText(text.slice(6),language);
    if(catalog[text.trim()])return text.replace(text.trim(),catalog[text.trim()]);
    // One pass avoids translating a translated word a second time.
    return text.replace(languagePatterns[language],key=>catalog[key]).replace(/\b(hours|hour|days|On|Off)\b/g,key=>catalog[key]||key);
  }
  if(language!=='fi')return text;
  const estimate=text.trim().match(/^About (less than 1|[\d.]+) more days? to the initial thresholds at recent observation rates\.$/);
  if(estimate)return estimate[1]==='less than 1'?message('Initial thresholds should be reached in less than a day at recent observation rates.',{},language):message('Initial thresholds should be reached in about {days} days at recent observation rates.',{days:estimate[1]},language);
  const comparison=text.trim().match(/^(\d+) comparisons · (\d+) with similar heating$/);
  if(comparison)return message('{count} comparisons · {similar} with similar heating',{count:comparison[1],similar:comparison[2]},language);
  if(text.startsWith('About '))return message('About {setting}',{setting:translateText(text.slice(6),language)},language);
  const stripped=text.trim();if(finnishText[stripped])return text.replace(stripped,finnishText[stripped]);
  const remove=text.match(/^Remove room "(.*)"\? Save settings to apply this change\.$/);if(remove)return message('Remove room "{name}"? Save settings to apply this change.',{name:remove[1]},language);
  let translated=text;
  for(const [english,finnish] of finnishReplacements){
    if(translated.includes(english))translated=translated.split(english).join(finnish);
  }
  return translated.replace(/\b(hours|hour|days|On|Off)\b/g,key=>message(key,{},language));
}

function cardText(text,language){
 const code=normalize(language),catalog=catalogs.get(code);
 return catalog?.cardMessages[text]??catalog?.messages[text]??catalog?.legacy[text]??text;
}
const notificationModes={heat:'Heating',cool:'Cooling',off:'Off',fan_only:'Fan-only mode','fan-only':'Fan-only mode'};
const weatherForecastKinds={hourly:'Hourly',twice_daily:'Twice daily',daily:'Daily'};
const controlNoticeReasons=new Set([
 'thermostat unavailable; target will be retried.',
 'required temperature or configured control input unavailable.',
 'zone temperature unavailable.',
 'heat pump unavailable.',
 'live control requires a thermostat using °C.',
 'heat pump must use Celsius.',
 'target is outside thermostat limits.',
 'no supported thermostat target fits the temperature limits.',
 'setting thermostat temperature failed; will retry.',
 'no supported standby mode for heat pump changeover.',
 'selected fan mode is unsupported.',
 'selected swing mode is unsupported.',
 'season setpoint could not be applied; source or thermostat unavailable.',
 'season setpoint is outside thermostat limits.',
 'applying the season setpoint failed; will retry.',
]);
function translateNotification(text,language){
 if(normalize(language)==='en'||!catalogs.has(language))return text;
 const t=(key,values)=>message(key,values,language);
 const controlPrefix='Thermostat control:';
 const pricePrefix='Price forecast:';
 const weatherPrefix='No weather forecast: current outdoor temperature is held constant.';
 if(text.startsWith(pricePrefix+' '))return t(pricePrefix)+' '+t(text.slice(pricePrefix.length+1));
 if(text.startsWith(weatherPrefix+' ')){
  const detail=text.slice(weatherPrefix.length+1);
  const forecastDetail=detail.match(/^(weather\.[\w]+: )([\s\S]*)$/);
  if(!forecastDetail){
   const key=detail==='No usable forecast was returned.'?'No usable weather forecast was returned.':detail;
   return t(weatherPrefix)+' '+t(key);
  }
  // Forecast exceptions include provider-owned text. Translate only the
  // source-reader fragments that ThermalPilot itself added.
  const reason=forecastDetail[2].replace(/(^|; )(hourly|twice_daily|daily): no usable timestamped temperature rows returned(?=; |$)/g,
   (_,separator,kind)=>separator+t(weatherForecastKinds[kind])+': '+t('No usable timestamped temperature readings were returned.'));
  const timeout='Forecast request timed out.';
  const result=reason.endsWith('; '+timeout)?reason.slice(0,-timeout.length)+t(timeout):t(reason);
  return t(weatherPrefix)+' '+forecastDetail[1]+result;
 }
 if(text.startsWith(controlPrefix+' '))return t(controlPrefix)+' '+translateControlNotice(text.slice(controlPrefix.length+1),t);
 const incompletePrices=text.match(/^(today|tomorrow): expected 24 hourly or 96 quarter-hour prices for a complete day\.$/);
 if(incompletePrices)return t('{series}: expected 24 hourly or 96 quarter-hour prices for a complete day.',{series:incompletePrices[1]});
 // Season setpoint notices can also be emitted without a control prefix.
 if(/: (?:season setpoint|applying the season setpoint) /.test(text))return translateControlNotice(text,t);
 return t(text);
}
function translateControlNotice(text,t){
 const fallback=text.match(/^(Summer|Winter) fallback targets are being used because required data or a current heating plan is unavailable: ([\s\S]+)\.$/);
 if(fallback){
  return t('{season} targets are being used because required data or a current heating plan is unavailable: {rooms}.',
   {season:t(fallback[1]+' fallback'),rooms:fallback[2]});
 }
 // Keep the device name opaque, including names with colons or UI words.
 const separator=text.lastIndexOf(': ');
 if(separator!==-1){
  const name=text.slice(0,separator);
  const detail=text.slice(separator+2);
  const standby=detail.match(/^(.+); using (off|fan-only) standby\.$/);
  const reason=standby?standby[1]+'.':detail;
  let translated=controlNoticeReasons.has(reason)?t(reason):reason;
  const unsupported=reason.match(/^heat pump does not support (\w+)\.$/);
  const limits=reason.match(/^temperature setpoint outside device limits \(([^)]+)\)\.$/);
  const clamped=reason.match(/^requested (-?[\d.]+) °C is outside pump limits\. Using (-?[\d.]+) °C\.$/);
  const failed=reason.match(/^(\w+) failed; (waiting to retry|will retry)\.$/);
  const unconfirmed=reason.match(/^heat pump has not confirmed (\w+); retrying this stage\.$/);
  if(unsupported){
   const mode=unsupported[1];
   translated=t('Heat pump does not support mode {mode}.',{mode:Object.hasOwn(notificationModes,mode)?t(notificationModes[mode]):mode});
  }
  if(limits)translated=t('Temperature setpoint is outside device limits ({range}).',{range:limits[1]});
  if(clamped)translated=t('Requested {target} °C is outside pump limits. Using {limited} °C.',{target:clamped[1],limited:clamped[2]});
  if(failed)translated=t('Action {action} failed. It will be retried.',{action:failed[1]});
  if(unconfirmed)translated=t('Heat pump has not confirmed {stage}. ThermalPilot will retry.',{stage:unconfirmed[1]});
  if(standby&&translated!==reason)translated+=' '+t('Standby mode: {mode}.',{mode:t(notificationModes[standby[2]])});
  else if(standby)return t(text);
  if(translated!==detail)return name+': '+translated;
 }
 return t(text);
}
return {languageNames,languageText,finnishText,heatingFinnishText,install,load,ready,watch,message,translateText,translateNotification,cardText};
})();
globalThis.__thermalPilotLocalization=localization;
export {localization};
