await import(new URL(`./localization.js${new URL(import.meta.url).search}`, import.meta.url));
/* Native custom panel. All data is escaped; settings are validated server-side. */
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Calendar dates are wall-clock days. Only the backend converts them to HA's time zone.
function calendarDateKey(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
function awayCalendarMonth(month,selected,today,locale){
 const year=month.getFullYear(),number=month.getMonth();
 const title=new Intl.DateTimeFormat(locale,{month:'long',year:'numeric'}).format(month);
 const first=new Date(year,number,1,12);const offset=(first.getDay()+6)%7;
 const weekdays=Array.from({length:7},(_,index)=>`<span class="weekday" aria-hidden="true">${escapeHTML(new Intl.DateTimeFormat(locale,{weekday:'short'}).format(new Date(2026,5,1+index,12)))}</span>`).join('');
 const days=Array.from({length:42},(_,index)=>{
  const date=new Date(year,number,1-offset+index,12),key=calendarDateKey(date);
  const chosen=key===selected.start||key===selected.end;
  const range=selected.start&&selected.end&&key>selected.start&&key<selected.end;
  const label=new Intl.DateTimeFormat(locale,{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(date);
  return `<button type="button" data-calendar-date="${key}" class="day${date.getMonth()!==number?' other':''}${chosen?' selected':range?' range':''}${key===today?' today':''}" aria-label="${escapeHTML(label)}" aria-pressed="${chosen}" ${key===today?'aria-current="date"':''}>${date.getDate()}</button>`;
 }).join('');
 return `<section class="month" aria-label="${escapeHTML(title)}"><h3>${escapeHTML(title)}</h3><div class="days">${weekdays}${days}</div></section>`;
}
const pumpTemperatureFields=['air_minimum','air_maximum','air_boost','air_setback'];
const tooltipInfoIcon='<svg class="status-info" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="8"/><path d="M10 9v5"/><circle class="status-info-dot" cx="10" cy="6" r="1"/></svg>';
const roomFloorPlanAsset=typeof location!=='undefined'&&/\/PREVIEW\.html$/.test(location.pathname)?'./custom_components/thermal_pilot/frontend/rooms-floor-plan.png':'/thermal_pilot/rooms-floor-plan.png';
const dateLabel = value => new Date(value).toLocaleDateString('fi-FI',{day:'2-digit',month:'2-digit',year:'numeric'});
const timeLabel = value => `${dateLabel(value)} ${new Date(value).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false})}`;
const entityLabel = state => state?.attributes?.friendly_name || (state?.entity_id?.split('.').slice(1).join('.').replace(/_/g,' ')) || 'Unavailable entity';
const pumpStageLabels={power:'Power on',hvac_mode:'Operating mode',temperature:'Heating setpoint',fan_mode:'Fan speed',swing_mode:'Swing mode',confirmed:'Confirmed',checking:'Checking'};
const pumpOptionKeys={fireplace_fan:'fan_modes',fireplace_swing:'swing_modes',air_fan_cool:'fan_modes',air_swing_cool:'swing_modes',air_fan_heat:'fan_modes',air_fan_idle:'fan_modes',air_swing:'swing_modes',air_swing_idle:'swing_modes',garage_fan_heat:'fan_modes',garage_fan_idle:'fan_modes',garage_fan_presence:'fan_modes',garage_swing:'swing_modes',garage_swing_idle:'swing_modes'};
const garageSource=(room,settings)=>room.garage_heat_source==='house'?(settings?.house_heat_source||'air_to_water'):(room.garage_heat_source||'air_to_air');
const airRoom=(room,settings)=>room.is_garage?garageSource(room,settings)==='air_to_air':room.heat_control==='air_to_air';
// Provisional descriptive bands for the fixed 20°C / -10°C reference test.
// Keep cut-offs together so later calibration changes only this scale.
const retentionBands=[
 {below:1,label:'Very fast cooling',level:'very-fast'},
 {below:2,label:'Fast cooling',level:'fast'},
 {below:4,label:'Moderate cooling',level:'moderate'},
 {below:8,label:'Slow cooling',level:'slow'},
 {below:Infinity,label:'Very slow cooling',level:'very-slow'},
];
const relativeRetentionBands=[{below:.5,level:'very-fast',label:'Very fast cooling'},{below:.8,level:'fast',label:'Fast cooling'},{below:1.25,level:'moderate',label:'Close to reference'},{below:2,level:'slow',label:'Slow cooling'},{below:Infinity,level:'very-slow',label:'Very slow cooling'}];
function retentionRating(value){
 if(!value?.updated||!Number.isFinite(value.hours_per_degree)||value.hours_per_degree<=0)return {label:'Learning',level:'learning'};
 if(Number.isFinite(value.reference_hours)&&value.reference_hours>0){const ratio=value.hours_per_degree/value.reference_hours;return {...relativeRetentionBands.find(band=>ratio<band.below),relative:true,ratio};}
 return retentionBands.find(band=>value.hours_per_degree<band.below);
}
const controlOptionLabels={independent:'Independent',heat_pump_preferred:'Heat pump preferred',house:'House heating system',air_to_air:'Air-to-air heat pump',temperature:'Temperature limits only',tariff:'Electricity tariff optimization',heat:'Heating only',cool:'Cooling only',both:'Heating in winter / cooling in summer',main:'Main room sensor',average:'Average of room sensors',coldest:'Coldest room sensor',fireplace:'Fireplace'};
const settingHelp = {
  nordpool_entry:'Read EUR prices through Home Assistant. For community Nord Pool, select its sensor instead.',
  nordpool_area:'Automatic requires one integration and one price area.',
  nordpool_vat:'Add VAT to spot prices. The retailer margin includes VAT. Add transfer charges separately.',
  tibber_price_entity:'Select the EUR/kWh sensor for your Tibber home. Energy taxes are already included.',
  solar_power_entity:'Select current solar production in W or kW. Leave empty to disable. Production is not surplus: other household loads may still require grid electricity.',
  solar_start_kw:'Start after five minutes above this limit. Rooms must have room for useful heat within their existing boost and temperature limits.',
  solar_stop_kw:'After five minutes below this lower limit, end solar heating once its minimum session is complete. Between the limits, existing sessions continue.',
  away_temperature:'Fixed away heating target. Planned and solar boosts yield to it; manual heating can override it.',
  away_cooling_temperature:'Warmer away cooling target. Applies only to systems already configured for automatic cooling.',
  away_automatic:'Everyone must be away for the delay. A return restores normal targets and cancels active bookings.',
  away_zone:'Uses the zone’s tracked-person count. Zero means empty; unknown pauses automatic absence detection.',
  away_delay_hours:'Continuous absence required before changing targets. A return resets this timer; restarts preserve it.',
  away_exempt:'Keep normal heating and cooling, for example for aquariums. Shared heat-pump zones preserve all members’ normal targets if one is exempt.',
  solar_minimum_run_minutes:'Minimum duration of the requested solar boost, preserved across restarts. It may use grid electricity. Manual control, missing inputs, cooling and temperature or door protections take priority.',
  shared_air_rooms:'Select primary heating circuits that directly share air and exchange warmth. Links work both ways; A–B and B–C do not add A–C. Removing a selection removes only that pair. Each circuit keeps its own sensor, target and limits. Assistance starts only after learning heat transfer from at least 12 heating hours and 12 idle hours with the linked sensors available.',
  heating_enabled: 'Enables planning, data collection and learning. Turning it off pauses these functions and keeps learned data. Simulation is separate: on calculates suggestions without applying scheduled targets; off allows live control after confirmation.',
  climate_mode:'Heating only operates in winter. Cooling only operates in summer. Both heats in winter and cools in summer. Automatic season changes must persist for 24 hours. Reversing between heating and cooling requires confirmed fan-only standby for ten minutes; automatic Heat/Cool mode is never used.',
  cooling_target:'The cooling target for this zone. Cooling starts 0.5 °C above this value and stops when any linked room reaches it. This keeps the pump from repeatedly starting and protects colder rooms.',
  zone_heating_enabled:'Allows ThermalPilot to control the selected zone heat pump for the selected use when global live control is enabled. Off observes the pump without controlling it. If ThermalPilot was already controlling it, it first returns the pump to fan-only standby.',
  air_swing_idle:'The swing mode used in fan-only standby. Options must be supported by every selected ordinary air-to-air heat pump. Leave unchanged sends no standby swing command.',
  garage_swing_idle:'The swing mode used while the garage pump is in fan-only standby. Choose from the selected pump’s supported swing modes. Leave unchanged sends no standby swing command.',
  zone_rooms:'Add the configured rooms affected by this heat source. Select each room once. Rooms already assigned to another zone must first be removed from that zone. Main room choices are limited to the rooms added here. Zone membership does not replace a room’s primary thermostat or heating system. Garage rooms use their own controller and are not linked to shared zones.',
  garage_fan_presence:'The quieter fan speed used when any selected presence sensor detects someone in the garage. When no selected sensor detects presence, the normal heating or standby fan speed returns. This changes only fan speed; temperature limits still control heating. Leave unchanged applies no separate occupied fan setting.',
  is_garage:'Use this room’s own garage temperature limits and heat source. Pump, fan and door-open protection settings apply only to air-to-air heat pumps. Other heating systems keep heating when a door opens.',
  garage_minimum:'Automatic heating starts below this limit. Warm outdoor weather stops automatic heating. Air-to-air pumps use fan-only standby in cold weather; other thermostats turn heating off between cycles.',
  garage_maximum:'Temperature-only control heats up to this limit, then stops heating. Air-to-air pumps use fan-only standby. Tariff optimization can heat earlier within the limits.',
  garage_heat_target:'The heat pump’s internal setpoint while heating, separate from the garage sensor’s lower and upper limits. For example, a pump requiring at least 16°C can heat a garage cycling between 5°C and 9°C.',
  garage_door_warning_minutes:'Warn the selected Companion app device after a configured garage door has stayed open this long. Other heating systems continue heating. One warning is sent per opening, including across restarts; closing all doors arms the next warning. Select the device under Notifications.',
  garage_heat_source:'Use house heating system inherits the house heat source and distribution. Select Air-to-air heat pump only for a separate garage pump; its additional settings then appear. Non-electric house systems keep observation-only operation. Existing garages retain their heat-pump selection.',
  garage_strategy:'Temperature limits only preserves the lower-to-upper cycle and works without electricity prices. Tariff optimization uses the learned room response and prices to consider earlier heating; the lower limit still takes priority. Missing prices fall back to temperature cycling.',
  garage_swing:'Options come from the selected heat pump’s swing_modes. Leave unchanged sends no swing command.',
  air_swing:'Options are those supported by every selected ordinary air-to-air heat pump. Leave unchanged sends no swing command.',
  air_use_fan_only:'On switches the pump between Heat and Fan only. Off keeps Heat selected during heating season and adjusts the pump setpoint using the room target, boost and reduction. If Home Assistant stops while Heat is selected, the pump can maintain its last setpoint with its own thermostat. Cooling and changeover can still leave Heat. Between cooling sessions, the pump can use Fan only with the switch on or off.',
  garage_use_fan_only:'On allows garage targets below the pump’s minimum by switching between Heat and Fan only. Off keeps Heat selected and uses the garage’s lower limit as the maintenance target. The pump cannot go below its own minimum, for example 16 °C. Door protection can still switch to Fan only.',
  air_heat_target:'Device setpoint used in Heat mode. External room sensors and the heating plan decide when to switch between Heat and Fan only. This is separate from each room’s comfort target.',
  heat_control:'Use the house heating system, or choose a separate air-to-air heat pump. Rooms linked to a zone share that zone’s pump; only the zone’s main room issues commands.',
  heating_priority:'Link the heat pump under Zones and keep the floor thermostat here. Heat pump preferred uses room response, not COP. An unlinked or disabled zone restores independent floor control.',
  assist_below_target:'Floor assistance starts at this shortfall, or earlier when the observed trend predicts it within the floor response lag. The pump continues heating. Existing minimum run and temperature limits apply.',
  heating_zone_id:'Link rooms served by one air-to-air heat pump. The zone has one controller and a choice of main-room, average or coldest-room temperature. Any linked room at the shared upper limit pauses zone heating.',
  temperature_policy:'Choose the main room sensor, the average of all linked sensors, or the coldest room. All linked sensors must be available. Heating pauses if any linked room reaches the shared upper limit.',
  garage_door_entities:'Door contact sensors pause garage heating when any selected door stays open longer than Pause heating after door opens. The pump switches to fan-only. One shared timer starts when the first selected door opens and keeps running while any selected door remains open. It resets when all selected doors are closed.',
  garage_door_delay:'One shared delay starts when the first selected door opens. Heating switches to fan-only after this many seconds while any selected door remains open. The timer resets when all selected doors are closed.',
  garage_presence_entities:'Presence sensors lower the fan speed to the selected occupied fan mode for more comfortable use of the garage. Any selected sensor detecting someone activates this mode. Normal heating or standby fan speed resumes when no selected sensor detects presence.',

  fireplace_active_state: 'A door/window contact sensor can monitor the fireplace damper position. Select the sensor state that means the fireplace is in use. For a damper contact sensor, Open normally means active and Closed means inactive. Door/window labels are converted to Home Assistant’s underlying on/off values. Other sensors show their declared options, current valid state and any saved value. A contact state indicates the damper position; it does not prove that a fire is burning.',
  language: 'Choose the interface language. Room and entity names remain unchanged. Save settings to keep the choice. Embedded history cards follow this choice where supported by Home Assistant.',
  start_offset_minutes: 'Water-based systems only: raise the thermostat target this many minutes before the planned heat-delivery session, allowing slow valves to open. Electric and air distribution ignore this setting and use no advance offset.',
  stop_offset_minutes: 'Water-based systems only: lower the thermostat target this many minutes before the planned heat-delivery session ends, allowing valves to close. Electric and air distribution ignore this setting and use no closing offset.',
  house_heat_source: 'What produces heat for your house. Select air-to-water for your water floor system supplied by an air-source heat pump. Gas, oil, wood and district heating need their own fuel-cost logic; choosing a house detail does not yet enable a different controller or reset learned room data.',
  house_distribution: 'How heat reaches rooms: circulating water in floors or radiators, electric floor/ceiling/panels, or warm air. Mixed means different rooms use different systems. Water distribution can optionally use a heating-water sensor and uses valve timing. Electric and warm-air distribution ignore those inputs and learn response from observed thermostat demand. Mixed and Other retain water requirements until room overrides are supported.',
  heat_pump_cop_entity: 'Choose a live heating COP sensor that reports zero or unavailable while idle. ThermalPilot learns from measured COP and outdoor temperatures. ThermalPilot uses the forecast to estimate heating costs.',
  house_heated_floor: 'The construction around floor heating, which affects how slowly heat is stored and released. Concrete slab describes your heated floor. Choose Not applicable if there is no floor heating. This does not change your configured response lag or erase learned parameters.',
  garage_construction:'Construction of this garage only. It does not inherit the house type or reset learning. Garage-specific construction benchmarks are not yet available, so all garage types keep the general cooling-speed bands and the four-hour starting estimate until observations teach the actual response.',
  house_construction:'Approximate comparison for room cooling-speed badges and a starting prior for new room models. Learned values are never overwritten and this selection does not reset learning. References are older whole-building examples, not insulation grades. Unknown keeps the general cooling-speed bands. Garages use their own starting estimate and the general bands.',
  house_foundation: 'The structure below your home: slab on ground, crawl space or basement. A heated concrete floor can be above a basement, so this is separate from Heated floor. Choose Unknown if unsure. This descriptive setting does not reset observation history or learned models.',

  solar_direction: 'Sunlight through large windows, especially south-facing windows, can warm a room. No additional physical solar heating system is needed. Select the main direction of those windows to enable solar estimates, or Solar heating off to turn them off. Home Assistant’s location determines seasonal sun elevation and azimuth; cloud conditions come from your weather source. The effect starts at zero and learns gradually. Missing sunlight data assumes no solar warmth; room temperature limits still apply.',
  solar_exposure: 'Clear means the windows receive direct sunlight without major obstructions. Choose Partly shaded for some trees, buildings or overhangs, or Mostly shaded when sunlight is usually blocked. Forecasts use a more cautious solar allowance: partly shaded uses 65% and mostly shaded 30% of the clear allowance. Actual room warming is still learned from observations; no solar heat is assumed before learning. Seasonal leaf cover and changing shading can still affect accuracy.',
  wind_entity: 'Optional local wind sensor, for example sensor.netatmo_tuuli_ms using m/s. Valid readings are averaged over the last 30 minutes. ThermalPilot learns a separate wind effect only after enough varied observations; no fixed wind penalty is assumed. Missing, invalid or unchanged-for-two-hours readings are ignored, and normal temperature-based planning and heating continue. Fresh wind correction gradually returns to typical conditions in forecasts further ahead. A stable calm reading may also be ignored conservatively. Units are detected automatically.',
  minimum: 'Emergency lower temperature limit shared by all rooms. Each room’s own target is the normal comfort goal. ThermalPilot prioritizes avoiding this limit even when electricity is expensive; this value is not the idle thermostat target.',
  maximum: 'Upper temperature limit shared by all rooms. Extra heating and heat storage must stay within this limit.',
  price_forecast_entity: 'Optional sensor with forecast timestamp/value entries, such as Nordpool Predict FI. Only relative expensive/cheap patterns after confirmed prices are used, so no forecast price unit or additional costs are required. The Source price unit setting applies only to the confirmed total-price sensor. An expensive upcoming period can increase the heat reserve at the end of the known-price plan. Forecast prices are not compared directly with your total prices, used as confirmed prices or used to execute future heating commands. Missing forecasts keep normal planning. Confirmed prices always determine the executable schedule.',
  manual_notification_target: 'Choose the Companion app device for garage door alerts: blocked manual heat-pump sessions and doors left open with other heat sources. No device is selected automatically.',
  fireplace_circulation: 'Switch this pump to fan-only while any selected fireplace is active. Manual sessions, cooling demand and minimum room temperatures take priority. If Home Assistant stops during circulation, the pump may remain in fan-only mode.',
  fireplace_ids: 'Choose the fireplaces that should trigger fan-only mode for this pump. Each fireplace is configured under Fireplaces.',
  fireplace_room_ids: 'Choose the rooms warmed by this fireplace. Room compensation applies once even if more than one linked fireplace is active.',
  sensor_warning_hours: 'Notify in Home Assistant when a room temperature sensor stays unchanged or unavailable for this many hours. A stable room can also have an unchanged reading, so the warning asks you to check the sensor. ThermalPilot sends at most one sensor notification per calendar day. Monitoring runs while ThermalPilot is active; long monitoring gaps restart the timer.',
  summer_minimum_temperature: 'Summer fallback follows the daily minimum temperature. With incomplete forecasts, Home Assistant location provides a warm-weather estimate: June–August north or December–February south, outside the tropics. Colder readings override the estimate; insufficient evidence selects winter. Summer uses the shared summer setpoint; winter uses normal room targets.',
  fireplace_reduction: 'Negative values reduce estimated heat loss while the fireplace is active; −20% means a 20% reduction.',
  static_price: 'Enter the total fixed electricity price, including variable charges, in c/kWh.',
  transfer_tariff: 'Add transfer charges only if they are not already included in the selected price.',
  price_entity: 'Prefer a sensor that includes electricity prices and additional costs, such as VAT, transfer tariffs, electricity tax and retailer margin. A variable electricity-price sensor without these costs also works. If transfer tariffs differ between day and night, including them helps ThermalPilot choose the cheapest heating hours; omitting them can shift heating to hours that are less economical overall. Select a source containing today/tomorrow or timestamped raw_today/raw_tomorrow price lists, and choose the matching source price unit.',
  pricing_mode: 'Hourly average uses fixed hourly averages of the source prices. 15 minutes plans using quarter-hour intervals. Flexible builds heating sessions in 15-minute steps, allowing runs such as 60 or 75 minutes while respecting the minimum flexible heating run.',
  minimum_run_minutes: 'The shortest planned heating session in flexible scheduling mode. Longer sessions can be chosen in 15-minute steps. This setting applies to flexible runs; valve opening and closing offsets are applied separately.',
  lag_hours: 'Initial estimate of how slowly heat input affects room temperature and how long its effect persists. Concrete slabs often need a longer delay, but lightweight floors, radiators, electric heaters and air systems also have a response time. Use a shorter value for faster systems. This remains relevant to every distribution; it is separate from valve opening or closing time.',
  curve_warm_temp: 'The warm outdoor endpoint of the initial heating-hours curve. At this temperature or warmer, the starting model assumes the lower daily heating need. This curve seeds the model before enough real heating and cooling observations are available.',
  curve_cold_temp: 'The cold outdoor endpoint of the initial heating-hours curve. At this temperature or colder, the starting model assumes the higher daily heating need. Set it below the warm endpoint. Actual room response is learned from observations.',
  apply_season_setpoints: 'Allows real thermostat setpoint changes when ThermalPilot changes between Active and Passive. Active applies each room’s target temperature; Passive applies the seasonal fallback: the shared summer setpoint or each room’s normal target in winter. These commands can occur even with simulation enabled. This does not enable live heating schedule control.',
  summer_setpoint: 'The thermostat target used for all configured rooms while ThermalPilot is Passive, if real Active/Passive season setpoint control is enabled. A low summer target normally prevents heating without switching off the thermostats.',
  boost: 'Degrees added to each room’s target temperature during a suggested heating window. For example, a 20 °C target with a 1.5 °C boost suggests a 21.5 °C thermostat setpoint to store heat. Scheduled targets remain simulated in this version.',
  setback: 'Negative values temporarily lower the thermostat target during expensive electricity hours. After a planned heating session, ThermalPilot first restores the room’s normal target. It then chooses reduction only when predicted stored warmth can avoid thermostat heating while supporting room comfort. For example, −1°C allows a 20°C target to be reduced to 19°C during selected costly hours. The reduced target never goes below Minimum allowed temperature. Normal target is restored when reduction is no longer useful; a new planned heating session uses the boosted target. Duration is chosen by the plan, not a fixed number of hours.',
  water_entity: 'Select the measured supply-water temperature. A temperature sensor uses its state; a climate entity uses its current_temperature attribute. This is the measured water temperature, not the thermostat’s target. Optional for water-based systems. A valid reading adjusts the estimated heating output. Without it, planning and learning continue from observed thermostat demand, without a water-temperature adjustment. Missing readings do not force fallback targets.',
  simulation_enabled: 'Simulation calculates heating suggestions without applying scheduled targets. Disable simulation and confirm to enable real thermostat control. If another automation controls these thermostats, disable it first. Observation and learning continue in both modes.',
};
const sourceSettingColumns = [
  [
    ['Integration settings',['heating_enabled','simulation_enabled','language']],
    ['Electricity price settings',['price_entity','static_price','nordpool_entry','nordpool_area','nordpool_vat','nordpool_margin','tibber_price_entity','price_forecast_entity','price_unit','transfer_tariff','transfer_fixed_price','transfer_day_start','transfer_day_price','transfer_night_start','transfer_night_price','pricing_mode','minimum_run_minutes']],
    ['Solar power heating settings',['solar_power_entity','solar_start_kw','solar_stop_kw','solar_minimum_run_minutes']],
  ],
  [
    ['Away heating and cooling',['away_automatic','away_zone','away_delay_hours','away_temperature','away_cooling_temperature']],
    ['Weather and forecast settings',['weather_entity','outdoor_entity','wind_entity','summer_minimum_temperature']],
    ['Notifications',['manual_notification_target','sensor_warning_hours']],
  ],
];
const sharedSettingGroups = [
  ['Thermostat settings',['summer_setpoint','minimum','maximum','boost','setback','apply_season_setpoints']],
 ['Air-to-air heat pump settings',['air_use_fan_only','air_minimum','air_maximum','air_boost','air_setback','air_heat_target','air_fan_heat','air_swing','air_fan_idle','air_swing_idle','air_fan_cool','air_swing_cool']],
];
const houseOptionLabels={timber_frame:'Timber frame',masonry:'Masonry',lightweight_metal:'Lightweight metal',wooden_detached:'Wooden detached house',masonry_detached:'Masonry detached house',concrete_apartment:'Concrete-element apartment building',heavy_masonry_apartment:'Heavy masonry apartment building',air_to_water:'Air-to-water heat pump',ground_source:'Ground-source heat pump',air_to_air:'Air-to-air heat pump',electric_resistance:'Electric resistance',oil_boiler:'Oil boiler',gas_boiler:'Gas boiler',wood_boiler:'Wood boiler',pellet_boiler:'Pellet boiler',district_heating:'District heating',water_floor:'Water floor heating',water_radiators:'Water radiators',electric_floor:'Electric floor heating',electric_ceiling:'Electric ceiling heating',electric_panels:'Electric panels',warm_air:'Warm air',mixed:'Mixed',concrete_slab:'Concrete slab',thin_screed:'Thin screed',lightweight:'Lightweight floor',not_applicable:'Not applicable',slab_on_ground:'Slab on ground',crawl_space:'Crawl space',basement:'Basement',other:'Other',unknown:'Unknown'};
const schedulingLabels = {hourly:'hourly average',quarterly:'15 minutes',flexible:'flexible'};

function fireplaceStateOptions(sensor,saved){
  const usable=value=>typeof value==='string'&&value!==''&&!['unknown','unavailable'].includes(value);
  const binary=sensor?.entity_id?.startsWith('binary_sensor.');
  const contact=['door','window','opening','garage_door'].includes(sensor?.attributes?.device_class);
  const values=binary?['on','off']:Array.isArray(sensor?.attributes?.options)?sensor.attributes.options.filter(usable):[];
  if(!binary&&usable(sensor?.state)&&!values.includes(sensor.state))values.push(sensor.state);
  if(usable(saved)&&!values.includes(saved))values.push(saved);
  return [...new Set(values)].map(value=>({value,label:binary?(value==='on'?(contact?'Open':'On'):value==='off'?(contact?'Closed':'Off'):value):value}));
}
const sourceReadingKeys=['price_entity','weather_entity','outdoor_entity','wind_entity','water_entity','solar_power_entity','away_zone'];
function sourceReading(key,entity,sensor){
  if(key==='price_entity'&&entity==='static')return 'Static price';
  if(key==='price_entity'&&entity==='nordpool')return 'Nord Pool (Home Assistant)';
  if(key==='price_entity'&&entity==='tibber')return 'Tibber (Home Assistant)';
  if(!entity)return 'Not selected';
  if(!sensor||sensor.state==='unavailable')return 'Unavailable';
  if(sensor.state==='unknown')return 'Unknown';
  const attrs=sensor.attributes||{};
  if(key==='water_entity'&&entity.startsWith('climate.')){
    const temperature=attrs.current_temperature;
    return temperature!=null&&Number.isFinite(Number(temperature))?`${temperature} ${attrs.temperature_unit||'°C'}`:'No temperature reading';
  }
  if(key==='weather_entity'){
    const condition={sunny:'Sunny',cloudy:'Cloudy',partlycloudy:'Partly cloudy','clear-night':'Clear night',rainy:'Rainy',pouring:'Heavy rain',snowy:'Snowy','snowy-rainy':'Sleet',fog:'Fog',windy:'Windy','windy-variant':'Windy and cloudy',lightning:'Thunderstorms','lightning-rainy':'Thunderstorms and rain',exceptional:'Exceptional weather'}[sensor.state]||sensor.state;
    const temperature=attrs.temperature;
    return condition+(temperature!=null&&Number.isFinite(Number(temperature))?` · ${temperature} ${attrs.temperature_unit||'°C'}`:'');
  }
  return `${sensor.state}${attrs.unit_of_measurement?' '+attrs.unit_of_measurement:''}`;
}
function fireplaceCurrentState(sensor){
  if(!sensor||sensor.state==='unavailable')return 'Unavailable';
  if(sensor.state==='unknown')return 'Unknown';
  return fireplaceStateOptions(sensor,sensor.state).find(option=>option.value===sensor.state)?.label||sensor.state;
}
function forecastRating(stat){
  if(!stat||!Number.isFinite(stat.mae)||stat.mae<0||!(stat.count>0))return {level:null,reason:'pending'};
  if(stat.count<20)return {level:null,reason:'limited'};
  let level=stat.mae<=.2?4:stat.mae<=.4?3:stat.mae<=.6?2:stat.mae<=1?1:0;
  const benchmark=Number.isFinite(stat.persistence_mae)&&stat.persistence_mae>=0;
  const improved=benchmark&&stat.mae<stat.persistence_mae;
  if(!improved)level=Math.min(level,2);
  return {level,reason:!benchmark?'missing_benchmark':!improved?'benchmark':'measured'};
}
function languageFlag(language){
  const rect=(x,y,width,height,fill)=>`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}"/>`;
  const stripes=(colors,vertical=false)=>colors.map((color,index)=>rect(vertical?index*8:0,vertical?0:index*16/3,vertical?8:24,vertical?16:16/3,color)).join('');
  const cross=(background,outer,inner)=>rect(0,0,24,16,background)+rect(7,0,inner?4:3,16,outer)+rect(0,6,24,inner?4:3,outer)+(inner?rect(8,0,2,16,inner)+rect(0,7,24,2,inner):'');
  const shield='<path d="M8 5h5v5q-2.5 3-5 0z" fill="#fff" stroke="#c8102e" stroke-width=".8"/><path d="M9 7h1v1H9zm2 0h1v1h-1zm-1 2h1v1h-1z" fill="#003580"/>';
  const flags={
    sv:cross('#006aa7','#fecc00'),nb:cross('#ba0c2f','#fff','#00205b'),da:cross('#c8102e','#fff'),
    de:stripes(['#000','#dd0000','#ffce00']),fr:stripes(['#002395','#fff','#ed2939'],true),it:stripes(['#009246','#fff','#ce2b37'],true),
    et:stripes(['#4891d9','#000','#fff']),lt:stripes(['#fdb913','#006a44','#c1272d']),
    lv:rect(0,0,24,16,'#9e1b34')+rect(0,6.4,24,3.2,'#fff'),pl:rect(0,0,24,16,'#fff')+rect(0,8,24,8,'#dc143c'),
    es:rect(0,0,24,16,'#aa151b')+rect(0,4,24,8,'#f1bf00')+'<g transform="translate(-2 0)">'+shield+'<path d="M7 6v4m7-4v4" stroke="#fff" stroke-width=".7"/></g>',
    pt:rect(0,0,24,16,'#f00')+rect(0,0,9.6,16,'#006600')+'<g transform="translate(-.9 0)"><circle cx="10.5" cy="8" r="4" fill="none" stroke="#ff0" stroke-width=".7"/><ellipse cx="10.5" cy="8" rx="4" ry="1.5" fill="none" stroke="#ff0" stroke-width=".5"/>'+shield+'</g>'
  };
  const easternShield='<path d="M7 4h6v6q-3 4-6 0z" fill="#d7141a" stroke="#fff" stroke-width=".7"/><path d="M9.6 5h.8v5h-.8zM8.5 6h3v.7h-3zM8 8h4v.7H8z" fill="#fff"/><path d="M7 11q1-3 3-1 2-2 3 1v1q-3 3-6 0z" fill="#0b4ea2"/>';
  const eagle='<path d="M10 5 8 3 6 4 8 5 9 7 5 5 3 3 4 7 7 9 3 8 4 10 8 11 7 13 10 12 12 14 14 12 17 13 16 11 20 10 21 8 17 9 20 7 21 3 19 5 15 7 16 5 18 4 16 3 14 5 13 7 12 6 11 7z" fill="#000"/>';
  const croatianChecks=Array.from({length:25},(_,i)=>rect(9+i%5,5+Math.floor(i/5),1,1,(i+Math.floor(i/5))%2?'#fff':'#ff0000')).join('');
  Object.assign(flags,{
    nl:stripes(['#ae1c28','#fff','#21468b']),is:cross('#02529c','#fff','#dc1e35'),
    ro:stripes(['#002b7f','#fcd116','#ce1126'],true),bg:stripes(['#fff','#00966e','#d62612']),hu:stripes(['#ce2939','#fff','#477050']),
    cs:rect(0,0,24,16,'#fff')+rect(0,8,24,8,'#d7141a')+'<path d="M0 0 12 8 0 16z" fill="#11457e"/>',
    sk:stripes(['#fff','#0b4ea2','#ee1c25'])+easternShield,
    hr:stripes(['#ff0000','#fff','#171796'])+croatianChecks+'<path d="M9 10q2.5 3 5 0" fill="none" stroke="#ff0000" stroke-width=".8"/><path d="M9 4l1-1 1 1 1-1 1 1 1-1v2H9z" fill="#0093dd"/>',
    sr:stripes(['#c6363c','#0c4076','#fff'])+'<g transform="translate(-3 0)"><path d="M9 4h6v7q-3 3-6 0z" fill="#fff"/>'+eagle.replace('fill="#000"','fill="#fff"')+'<path d="M10 6h4v4q-2 2-4 0z" fill="#c6363c"/><path d="M11.5 6h1v4h-1zM10 7.5h4v1h-4z" fill="#fff"/><path d="M9 4l1-2 1 1 1-2 1 2 1-1 1 2z" fill="#edb92e"/></g>',
    el:Array.from({length:9},(_,i)=>rect(0,i*16/9,24,16/9,i%2?'#fff':'#0d5eaf')).join('')+rect(0,0,9,16*5/9,'#0d5eaf')+rect(3.6,0,1.8,16*5/9,'#fff')+rect(0,16*2/9,9,16/9,'#fff'),
    sq:rect(0,0,24,16,'#e41e20')+eagle
  });
  if(flags[language])return `<svg class="language-flag" viewBox="0 0 24 16" aria-hidden="true" focusable="false">${flags[language]}</svg>`;
  const finnish=language==='fi';
  const design=finnish?'<rect width="18" height="11" fill="#fff"/><path d="M5 0h3v11H5zM0 4h18v3H0z" fill="#003580"/>':'<rect width="60" height="30" fill="#012169"/><path d="M0 0 60 30M60 0 0 30" stroke="#fff" stroke-width="6"/><path d="M0 0l20 10h-4L0 2zm60 0L40 10h-4L56 0zM0 30l20-10h4L4 30zm60 0L40 20h4l16 8z" fill="#c8102e"/><path d="M25 0h10v30H25zM0 10h60v10H0z" fill="#fff"/><path d="M27 0h6v30h-6zM0 12h60v6H0z" fill="#c8102e"/>';
  return `<svg class="language-flag" viewBox="${finnish?'0 0 18 11':'0 0 60 30'}" aria-hidden="true" focusable="false">${design}</svg>`;
}
function electricHeating(settings){return ['air_to_water','ground_source','air_to_air','electric_resistance'].includes(settings?.house_heat_source||'air_to_water')||Boolean(settings?.heating_zones?.some(z=>(z.source_type||'air_to_air')==='air_to_air'))||Boolean(settings?.rooms?.some(r=>r.is_garage?['air_to_water','ground_source','air_to_air','electric_resistance'].includes(garageSource(r,settings)):r.heat_control==='air_to_air'));}

function waterDistribution(settings){return !['electric_floor','electric_ceiling','electric_panels','warm_air'].includes(settings?.house_distribution);}

function roomId(){
  const crypto=globalThis.crypto;
  if(typeof crypto?.randomUUID==='function')return crypto.randomUUID();
  const bytes=new Uint8Array(16);
  if(typeof crypto?.getRandomValues==='function')crypto.getRandomValues(bytes);
  // Room identifiers are not credentials; support browsers without Web Crypto too.
  else for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256);
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function entityMatches(state,rule={},settings={}){
  const attrs=state.attributes||{},domain=state.entity_id.split('.')[0];
  const deviceClass=attrs.device_class,unit=String(attrs.unit_of_measurement||'').trim().toLowerCase();
  const temperature=deviceClass==='temperature'||(!deviceClass&&['°c','°f','c','f','k','°k'].includes(unit));
  if(rule.kind==='relay')return domain==='switch';
  if(rule.kind==='water')return domain==='climate'?Object.hasOwn(attrs,'current_temperature'):domain==='sensor'&&temperature;
  if(rule.kind==='temperature')return temperature;
  if(rule.kind==='wind')return domain==='sensor'&&['m/s','km/h','mph','kn','knots'].includes(unit);
  if(rule.kind==='power')return deviceClass==='power'||(!deviceClass&&['w','kw'].includes(unit));
  if(rule.kind==='price_forecast')return domain==='sensor'&&Array.isArray(attrs.forecast);
  if(rule.kind==='tibber_price')return typeof attrs.app_nickname==='string'&&['eur/kwh','€/kwh'].includes(unit);
  if(rule.kind==='price')return ['today','tomorrow','raw_today','raw_tomorrow'].some(key=>Array.isArray(attrs[key]));
  if(rule.kind==='target')return temperature||(['number','input_number'].includes(domain)&&!deviceClass&&!unit);
  if(rule.kind==='activity'){
    if(['binary_sensor','switch'].includes(domain))return true;
    if(domain!=='sensor')return false;
    if(settings.activity_attribute&&Object.hasOwn(attrs,settings.activity_attribute))return true;
    if((deviceClass&&deviceClass!=='enum')||unit)return false;
    const value=String(state.state??'').trim().toLowerCase();
    return deviceClass==='enum'||['0','1'].includes(value)||(!['','unknown','unavailable'].includes(value)&&!Number.isFinite(Number(value)))||Object.hasOwn(attrs,'hvac_action');
  }
  return true;
}
function quarterHourObservations(rows){
  const buckets=new Map();
  for(const row of rows){
    const time=Number(row.time);if(!Number.isFinite(time))continue;
    const bucket=Math.floor(time/900)*900;
    if(!buckets.has(bucket)||time>=Number(buckets.get(bucket).time))buckets.set(bucket,{...row,interval_start:bucket});
  }
  return [...buckets.values()].sort((a,b)=>a.interval_start-b.interval_start);
}
const heatingLabel=value=>value==null?'Unknown':value?'On':'Off';
function compareRoomNames(a,b,language){
  const first=String(a.name||'').trim(),second=String(b.name||'').trim();
  if(!first||!second)return first?-1:second?1:0;
  return first.localeCompare(second,language,{sensitivity:'base',numeric:true});
}
const priceThresholds=[[0,'#88ad91'],[15,'#a8b782'],[20,'#c3b577'],[25,'#c7a46e'],[35,'#cc936c'],[50,'#c9796b'],[60,'#ac605c']];
 const priceColor=price=>priceThresholds.findLast(([value])=>price>=value)?.[1]||priceThresholds[0][1];

const outdoorThresholds=[[-30,'#154360'],[-25,'#1B4F72'],[-20,'#2874A6'],[-10,'#3498DB'],[-5,'#85C1E9'],[0,'#82E0AA'],[5,'#2ECC71'],[10,'#239B56'],[20,'#186A3B'],[25,'#B7950B'],[30,'#CB4335'],[35,'#E74C3C']];
const outdoorColor=(value,thresholds=outdoorThresholds)=>{
  if(value<=thresholds[0][0])return thresholds[0][1];
  for(let i=1;i<thresholds.length;i++){
    const [upper,b]=thresholds[i],[lower,a]=thresholds[i-1];
    if(value<=upper){
      const fraction=(value-lower)/(upper-lower);
      const channel=offset=>Math.round(parseInt(a.slice(offset,offset+2),16)*(1-fraction)+parseInt(b.slice(offset,offset+2),16)*fraction).toString(16).padStart(2,'0');
      return '#'+channel(1)+channel(3)+channel(5);
    }
  }
  return thresholds.at(-1)[1];
};
// Keep freezing readings blue, then use a price-chart-inspired muted transition
// from green through orange into red for warmer temperatures.
const outdoorBarPalettes={
 cold:[[-30,'#315572'],[-20,'#527fa0'],[-10,'#8eb3ca'],[0,'#c4dce9']],
 mild:[[0,'#d7ead2'],[5,'#bddbb8'],[10,'#94be91'],[15,'#6d9f73'],[20,'#578a66'],[23,'#4c7e5e'],[24,'#a58e70'],[25,'#c69570'],[26.5,'#cf8c66'],[28,'#cc8568'],[30,'#c9796b'],[35,'#ac605c']],
};
const outdoorBarColor=value=>outdoorColor(value,value<0?outdoorBarPalettes.cold:outdoorBarPalettes.mild);
function durationLabel(milliseconds){
  const minutes=Math.max(0,Math.round(milliseconds/60000));
  if(!minutes&&milliseconds>0)return 'Less than 1 min';
  const hours=Math.floor(minutes/60),remaining=minutes%60;
  return hours?`${hours} h${remaining?` ${remaining} min`:''}`:`${remaining} min`;
}
function statusMessageLevel(text){
  if(text.startsWith('Observation only:')||text.startsWith('ThermalPilot is passive.')||text.startsWith('Heating water temperature is not available;'))return 'info';
  if(text.startsWith('Thermostat control:'))return text.includes('fallback targets are being used')?'warning':'error';
  if(/season setpoint.*(failed|could not|outside)/i.test(text))return 'error';
  return 'warning';
}
function statusIcon(level){
  const shape=level==='warning'?'<path d="M12 3 22 21H2Z"/><path d="M12 9v5m0 3h.01"/>':level==='error'?'<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>':'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>';
  return `<svg class="notice-icon" viewBox="0 0 24 24" aria-hidden="true">${shape}</svg><span class="notice-level">${level[0].toUpperCase()+level.slice(1)}: </span>`;
}
function statusNotice(text,level='info',extra=''){
  const safeLevel=['error','warning','info'].includes(level)?level:'info';
  return `<p class="notice notice-${safeLevel} ${extra}" role="${safeLevel==='error'?'alert':'status'}">${statusIcon(safeLevel)}<span class="notice-text">${escapeHTML(text)}</span></p>`;
}
const notificationLevels=['error','warning','info'];
function activeNotifications(data){
  const messages=new Map((data?.warnings||[]).map(text=>[text,statusMessageLevel(text)]));
  const outlook=data?.price_outlook;
  if(outlook?.enabled&&!outlook.available){
    const reason=outlook.reason||'Waiting for confirmed prices.';
    messages.set(`Price forecast: ${reason}`,'warning');
  }
  return notificationLevels.flatMap(level=>[...messages].filter(([,severity])=>severity===level).map(([text])=>({text,level})));
}
const notificationDrawerStyles=`
 .tp-notification-drawer{position:fixed;inset:0 0 0 auto;margin:0;box-sizing:border-box;width:min(64vw,1024px);max-width:100%;height:100%;max-height:100%;padding:0;border:0;border-left:1px solid var(--divider-color,#c6d2d8);background:var(--card-background-color,#fff);color:var(--primary-text-color,#213547);font:15px system-ui;box-shadow:-12px 0 36px #0003;overflow:hidden}
 .tp-notification-drawer[open]{display:flex;flex-direction:column;animation:tp-drawer-in .24s ease-out}
 .tp-notification-drawer::backdrop{background:#13232d55}
 @keyframes tp-drawer-in{from{transform:translateX(100%)}to{transform:translateX(0)}}
 .tp-notification-drawer header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 24px;border-bottom:1px solid var(--divider-color,#c6d2d8)}
 .tp-notification-drawer h2{font-size:21px;margin:0}
 .tp-notification-drawer h2[tabindex="-1"]:focus{outline:none}
 .tp-notification-drawer button{flex:none;width:44px;height:44px;border:1px solid transparent;border-radius:9px;background:transparent;color:inherit;font:26px system-ui;cursor:pointer}
 .tp-notification-drawer button:hover{background:var(--secondary-background-color,#ecf1f3)}
 .tp-notification-drawer button:focus-visible{outline:2px solid var(--primary-color,#00838f);outline-offset:2px}
 .tp-notification-drawer .notification-content{overflow:auto;overscroll-behavior:contain;padding:20px 24px}
 .tp-notification-drawer ul{list-style:none;padding:0;margin:0;display:grid;gap:12px}
 .tp-notification-drawer li{--accent:#3498db;box-sizing:border-box;overflow:hidden;display:flex;align-items:flex-start;gap:10px;padding:12px 16px;border-radius:8px;border-left:3px solid var(--accent);background:color-mix(in srgb,var(--accent) 10%,var(--card-background-color,#fff));line-height:1.5;overflow-wrap:anywhere}
 .tp-notification-drawer li[aria-hidden="true"]{pointer-events:none}
 .tp-notification-drawer li[data-severity="error"]{--accent:#d64545}
 .tp-notification-drawer li[data-severity="warning"]{--accent:#d9a400}
 .tp-notification-drawer .notice-icon{flex:0 0 20px;width:20px;height:20px;fill:none;stroke:var(--accent);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
 .tp-notification-drawer .notice-level{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
 .tp-notification-drawer p{margin:0;color:var(--secondary-text-color,#526b75)}
 @media(max-width:600px){.tp-notification-drawer{width:100%;border-left:0}.tp-notification-drawer header,.tp-notification-drawer .notification-content{padding:12px 16px}}
 @media(prefers-reduced-motion:reduce){.tp-notification-drawer[open]{animation:none}}
`;
const HEATING_FLAME='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2c1 5-3 6-3 10-2-1-3-3-3-5-3 3-5 6-5 9a10 10 0 0 0 20 0c0-6-5-9-9-14Z"/></svg>';
const COOLING_SNOWFLAKE='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20M3.34 7l17.32 10M3.34 17 20.66 7M9 4l3 3 3-3M9 20l3-3 3 3M3.5 10l4-1-1-4M20.5 14l-4 1 1 4M3.5 14l4 1-1 4M20.5 10l-4-1 1-4"/></svg>';
const tpI18n=globalThis.__thermalPilotLocalization;
const {languageNames,languageText,finnishText,heatingFinnishText,translateText}=tpI18n;
function weatherIcon(condition){
  const cloud='<path d="M5 20h21a6 6 0 0 0 0-12 8 8 0 0 0-15-1A6.5 6.5 0 0 0 5 20" fill="#aebfc9" stroke="#94aab7" stroke-width=".8"/>';
  const sun='<circle cx="11" cy="9" r="6" fill="#f4c15a"/><path d="M11 0v2M11 16v2M2 9H0M20 9h2M4 2l2 2M16 14l2 2M4 16l2-2M16 4l2-2" stroke="#e3b04b" stroke-width="1.8" stroke-linecap="round"/>';
  const rain='<path d="m10 24-2 4m10-4-2 4m10-4-2 4" stroke="#6e9db9" stroke-width="2" stroke-linecap="round"/>';
  const snow='<path d="M10 24v7m-3-5 6 3m0-3-6 3m15-5v7m-3-5 6 3m0-3-6 3" stroke="#84aabb" stroke-width="1.4"/>';
  const wind='<path d="M2 12h23q7 0 4-5M0 18h25q7 0 4 5M4 24h11" fill="none" stroke="#92aab6" stroke-width="2.2" stroke-linecap="round"/>';
  if(condition==='sunny')return sun;
  if(condition==='clear-night')return '<path d="M23 2A13 13 0 1 0 29 24 12 12 0 0 1 23 2" fill="#94a9c7"/>';
  if(condition==='partlycloudy')return sun+cloud;
  if(condition==='windy')return wind;
  if(condition==='windy-variant')return cloud+wind;
  if(condition==='fog')return cloud+'<path d="M0 24h29M5 29h23" stroke="#a3b6bf" stroke-width="2"/>';
  if(condition==='snowy')return cloud+snow;
  if(condition==='snowy-rainy')return cloud+snow+rain;
  if(condition==='hail')return cloud+'<g fill="#87a7bd"><circle cx="9" cy="26" r="2"/><circle cx="19" cy="29" r="2"/><circle cx="27" cy="25" r="2"/></g>';
  if(condition==='lightning'||condition==='lightning-rainy')return cloud+'<path d="m17 17-6 10h6l-3 8 12-13h-7l4-5" fill="#edba4e"/>'+(condition==='lightning-rainy'?rain:'');
  if(condition==='rainy'||condition==='pouring')return cloud+rain;
  if(condition==='cloudy')return cloud;
  return '<circle cx="16" cy="15" r="11" fill="none" stroke="#a3b6bf" stroke-width="2"/><path d="M12 11q0-5 5-3t-1 7v3m0 4v1" fill="none" stroke="#a3b6bf" stroke-width="2" stroke-linecap="round"/>';
}
class ThermalPilotPanel extends HTMLElement {
  constructor(){super();this.attachShadow({mode:'open'});this.tab='overview';this.historyHours=48;this.roomDisclosureState=new Map();}
  updateSourceReadings(){
    this.shadowRoot?.querySelectorAll('[data-source-reading]').forEach(hint=>{
      const key=hint.dataset.sourceReading;if(!sourceReadingKeys.includes(key))return;
      const entity=this.shadowRoot.querySelector(`[data-field="source.${key}"]`)?.value??this.settings?.[key];
      hint.textContent=`${this.t('Current state:')} ${this.t(sourceReading(key,entity,this._hass?.states?.[entity]))}`;
    });
  }
  updateFireplaceReading(){
    const hints=this.shadowRoot?.querySelectorAll('[data-current-fireplace]')||[];
    for(const hint of hints){
      const prefix=hint.dataset.currentFireplace;
      const sensor=this.shadowRoot.querySelector(`[data-field="${prefix}.fireplace_entity"]`)?.value;
      hint.textContent=`${this.t('Current state:')} ${this.t(fireplaceCurrentState(this._hass?.states?.[sensor]))}`;
    }
  }
  mountAccordionScrolling(){
    this.shadowRoot.querySelectorAll('details').forEach(details=>{
      const summary=details.querySelector(':scope > summary');if(!summary)return;
      summary.addEventListener('click',event=>{
        if(event.defaultPrevented)return;
        // Wait for the native details action and layout; restored open states do not scroll.
        const afterLayout=()=>{
          if(!details.open||!details.isConnected)return;
          const height=globalThis.innerHeight||globalThis.document?.documentElement?.clientHeight;
          if(!height)return;
          const bounds=details.getBoundingClientRect();
          if(bounds.bottom<=height-16)return;
          const reduced=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
          details.scrollIntoView({behavior:reduced?'instant':'smooth',block:bounds.height>height-32?'start':'nearest',inline:'nearest'});
        };
        if(typeof requestAnimationFrame==='function')requestAnimationFrame(afterLayout);
        else setTimeout(afterLayout,0);
      });
    });
  }
  mountLanguagePicker(){
    const picker=this.shadowRoot.querySelector('.language-picker');if(!picker)return;
    const trigger=picker.querySelector('.language-trigger'),list=picker.querySelector('.language-options'),field=picker.querySelector('[data-field]');
    const options=[...list.querySelectorAll('[data-language]')];
    const close=()=>{list.hidden=true;trigger.setAttribute('aria-expanded','false');};
    const open=()=>{list.hidden=false;trigger.setAttribute('aria-expanded','true');(options.find(option=>option.dataset.language===field.value)||options[0])?.focus();};
    trigger.addEventListener('click',event=>{event.preventDefault();list.hidden?open():close();});
    trigger.addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();open();}});
    options.forEach((option,index)=>{
      option.addEventListener('click',event=>{event.preventDefault();field.value=option.dataset.language;close();field.dispatchEvent(new Event('change',{bubbles:true}));this.shadowRoot.querySelector('.language-trigger')?.focus();});
      option.addEventListener('keydown',event=>{
        if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;options[next].focus();}
        else if(event.key==='Escape'){event.preventDefault();close();trigger.focus();}
        else if(event.key==='Tab')close();
      });
    });
    picker.addEventListener('focusout',event=>{if(!picker.contains(event.relatedTarget))close();});
    this.shadowRoot.onpointerdown=event=>{if(!event.target.closest?.('.language-picker'))close();};
  }
  t(value){return translateText(value,this.settings?.language||'en');}
  tDetails(value){const lines=String(value).split('\n');const first=lines[0].indexOf(' · ');if(first>=0){const name=lines[0].slice(0,first+3);lines[0]=name+this.t(lines[0].slice(first+3));return [lines[0],...lines.slice(1).map(line=>this.t(line))].join('\n');}return this.t(value);}
  translateRoot(root){
    if(!['fi',...Object.keys(languageText)].includes(this.settings?.language)||typeof document==='undefined'||!document.createTreeWalker)return;
    const walker=document.createTreeWalker(root,4);let node;
    while((node=walker.nextNode())){
      if(node.parentElement?.closest('style,script,[data-user-text],input,textarea'))continue;
      node.nodeValue=this.t(node.nodeValue);
    }
    root.querySelectorAll('[title],[aria-label],[data-chart-detail]').forEach(element=>{
      if(element.closest('[data-user-text]'))return;
      for(const attr of ['title','aria-label'])if(element.hasAttribute(attr))element.setAttribute(attr,element.hasAttribute('data-chart-detail')?this.tDetails(element.getAttribute(attr)):this.t(element.getAttribute(attr)));
    });
  }
  openSidebar(){this.dispatchEvent(new CustomEvent('hass-toggle-menu',{bubbles:true,composed:true}));}
  set hass(value){
    // HA's selected theme can differ from the operating system's color scheme.
    const dark=value?.themes?.darkMode===true;
    this.style?.setProperty('color-scheme',dark?'dark':'light');
    this.style?.setProperty('--tp-floorplan-opacity',dark?'.04':'.2');
    this._hass=value;this.updateFireplaceReading();this.updateSourceReadings();if(this.isConnected && !this.loaded && !this.loading)this.load();
    if(this.isConnected)this.subscribeNotifications();}
  set panel(value){this._panel=value;if(this.isConnected && this._hass && !this.loaded)this.load();if(this.isConnected)this.subscribeNotifications();}
  connectedCallback(){
    if(this._hass)this.load();
    this.subscribeNotifications();
    this.timer=setInterval(()=>{
      this.subscribeNotifications();
      if(!['settings','rooms'].includes(this.tab))this.load();
    },60000);
  }
  disconnectedCallback(){this.stopNotificationSubscription();this.notificationDrawer?.close();this.awayDialog?.close();this.manualDialog?.close();this.settingTooltipCleanup?.();this.priceResizeObserver?.disconnect();this.temperatureResizeObserver?.disconnect();clearTimeout(this.manualSessionTimer);clearInterval(this.timer);clearTimeout(this.saveMessageTimer);}
  get entry(){return this._panel?.config?.entry_id;}
  manualControlStatus(id){
    const control=this.info?.manual_controls?.[id];
    const zone=id.startsWith('zone:');
    const room=this.info?.data?.[zone?'zones':'rooms']?.[zone?id.slice(5):id];
    const configured=this.settings?.rooms?.find(item=>item.id===id);
    const entity=configured?.activity_entity||control?.entity||configured?.thermostat;
    const state=this._hass?.states?.[entity];
    const air=zone||room?.air_control||airRoom(configured||{},this.settings)||(!configured?.is_garage&&this.settings?.house_heat_source==='air_to_air');
    let mode=null,known=false,operatingMode=false;
    if(state){
      // Live unavailable/idle states take priority over an older coordinator result.
      if(!['unknown','unavailable'].includes(state.state)){
        if(configured?.activity_entity){
          known=['on','off'].includes(state.state);
          if(state.state==='on')mode='heat';
        }else{
          const action=state.attributes?.hvac_action;
          if(action==='heating')mode='heat';
          else if(action==='cooling')mode='cool';
          known=mode!==null||['idle','off','fan'].includes(action)||['off','fan_only'].includes(state.state);
          // Some pumps expose only operating mode. Label that proxy explicitly;
          // a selected Heat mode does not prove the compressor is producing heat.
          if(action==null&&air&&['heat','cool'].includes(state.state)){
            mode=state.state;known=true;operatingMode=true;
          }
        }
      }
    }else if(room?.actual_activity===1){mode='heat';known=true;}
    else if(room?.actual_activity===0){known=true;}
    const label=this.t(mode==='heat'?'Heating':mode==='cool'?'Cooling':known?'Inactive':'Unavailable');
    const activity=operatingMode?`${this.t('Operating mode')}: ${label}`:label;
    const session=control?.session?.ends*1000>Date.now()?control.session:null;
    const source=this.t(session?(session.mode==='heat'?'Manual heating':'Manual cooling'):'Automatic control');
    const reason=session&&room?.pump_suggestion?.reason?this.t(room.pump_suggestion.reason):'';
    return {mode,session,text:[activity,source,reason].filter(Boolean).join(' · ')};
  }
  manualChartName(name,id,history,color){
    const controls=this.info?.manual_controls;
    const circulation=!history&&id.startsWith('zone:')?this.info?.data?.zones?.[id.slice(5)]?.pump_suggestion?.fireplaces:null;
    const nameTooltip=circulation?.length
      ? [name,this.t('Fireplace air circulation'),circulation.join(', ')].join(' · ')
      : name;
    if(history||this.chartVisibility().manual===false||!controls||!Object.keys(controls).length)return `<div xmlns="http://www.w3.org/1999/xhtml" data-user-text title="${escapeHTML(nameTooltip)}" style="font:600 13px system-ui;color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:22px">${escapeHTML(name)}</div>`;
    const control=controls[id],status=this.manualControlStatus(id),session=status.session;
    const buttons=['heat','cool'].map(mode=>{
      if(!control?.modes?.includes(mode))return '<span class="manual-slot" aria-hidden="true"></span>';
      const manual=session?.mode===mode;
      const active=status.mode===mode;
      const label=this.t(mode==='heat'?'Manual heating':'Manual cooling');
      const end=manual?new Intl.DateTimeFormat(this.settings.language||'en',{hour:'2-digit',minute:'2-digit'}).format(session.ends*1000):'';
      const sessionDetail=manual?`${new Intl.NumberFormat(this.settings.language||'en',{maximumFractionDigits:2}).format(session.target)} °C · ${this.t('Ends at')} ${end}`:label;
      const title=`${status.text} · ${sessionDetail}`;
      return `<span class="manual-slot"><button type="button" class="manual-icon${active?' active':''}${manual?' manual-session':''}" data-manual-id="${escapeHTML(id)}" data-manual-mode="${mode}" aria-pressed="${manual}" aria-label="${escapeHTML(title+': '+name)}" title="${escapeHTML(title)}" ${!control.enabled&&!session?'disabled':''}>${mode==='heat'?HEATING_FLAME:COOLING_SNOWFLAKE}</button></span>`;
    }).join('');
    return `<div xmlns="http://www.w3.org/1999/xhtml" class="manual-name" style="color:${color}">${buttons}<span data-user-text class="manual-label" title="${escapeHTML(nameTooltip)}">${escapeHTML(name)}</span></div>`;
  }
  awayCalendarButton(){
    const away=this.info?.data?.away;
    const active=away?.active;
    const count=away?.occurrence_count??away?.occurrences?.length??away?.schedules?.length??Number(Boolean(away?.schedule));
    const badgeCount=away?.has_ongoing_series?`${count}+`:count;
    const title=this.t(active?'Away temperatures active':count?'Scheduled absence':'Away calendar');
    const label=count?`${title} (${badgeCount})`:title;
    return `<button type="button" id="away-calendar" data-away-calendar class="header-icon-button away-calendar-button${active?' active':count?' scheduled':''}" aria-label="${escapeHTML(label)}" title="${escapeHTML(label)}" ${this.info?'':'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 10h18M8 14h2M14 14h2M8 17h2"/></svg>${count?`<span class="header-count" aria-hidden="true">${badgeCount}</span>`:''}</button>`;
  }
  async subscribeNotifications(){
    const connection=this._hass?.connection,entryId=this.entry;
    const current=this.notificationSubscription;
    if(current?.connection===connection&&current?.entryId===entryId)return;
    this.stopNotificationSubscription();
    if(!entryId||!connection?.subscribeMessage)return;
    const subscription={connection,entryId};
    this.notificationSubscription=subscription;
    try{
      const unsubscribe=await connection.subscribeMessage(data=>{
        if(this.notificationSubscription!==subscription)return;
        this.notificationData=data;
        this.updateNotifications();
      },{type:'thermal_pilot/subscribe_notifications',entry_id:entryId});
      if(this.notificationSubscription===subscription)subscription.unsubscribe=unsubscribe;
      else await unsubscribe();
    }catch{
      // Keep the last panel snapshot available and retry on the next refresh.
      if(this.notificationSubscription===subscription)this.stopNotificationSubscription();
    }
  }
  stopNotificationSubscription(){
    const subscription=this.notificationSubscription;
    if(!subscription)return;
    this.notificationSubscription=null;
    this.notificationData=null;
    subscription.unsubscribe?.().catch(()=>{});
  }
  notificationButton(){
    return `<button type="button" id="notification-center" class="header-icon-button notification-button" aria-label="Notifications" title="Notifications" aria-haspopup="dialog" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12a2 2 0 0 0 4 0"/></svg><span class="header-count notification-count" aria-hidden="true" hidden></span></button>`;
  }
  updateNotifications(){
    const button=this.shadowRoot.querySelector('#notification-center');
    if(!button)return;
    const notices=activeNotifications(this.notificationData??this.info?.data);
    const errors=new Set(notices.filter(notice=>notice.level==='error').map(notice=>notice.text));
    // Closing the drawer acknowledges the current errors for this visit.
    // A newly active error can draw attention again after a recovery.
    const hasNewError=[...errors].some(text=>!this.notificationErrors?.has(text));
    this.notificationErrors=errors;
    const severity=notices[0]?.level;
    if(severity)button.dataset.severity=severity;
    else delete button.dataset.severity;
    const count=button.querySelector('.notification-count');
    count.hidden=!notices.length;
    count.textContent=notices.length;
    let label=this.t('Notifications');
    if(severity)label+=` (${notices.length}) · ${this.t(severity[0].toUpperCase()+severity.slice(1)+':').replace(/:$/, '')}`;
    button.setAttribute('aria-label',label);
    button.title=label;
    button.setAttribute('aria-expanded',String(Boolean(this.notificationDrawer?.open)));
    const drawer=this.notificationDrawer;
    if(drawer?.open){
      this.renderNotificationList(notices);
      if(drawer.openedAutomatically&&!notices.length){
        drawer.autoCloseTimer??=setTimeout(()=>{
          if(this.notificationDrawer===drawer&&drawer.open)drawer.close();
        },2000);
      }else{
        clearTimeout(drawer.autoCloseTimer);
        drawer.autoCloseTimer=null;
      }
      return;
    }
    if(hasNewError)this.openNotifications({automatic:true});
  }
  openNotifications({automatic=false}={}){
    if(this.notificationDrawer?.open)return;
    const dialog=document.createElement('dialog');
    dialog.openedAutomatically=automatic;
    dialog.notificationRows=new Map();
    this.notificationDrawer=dialog;
    dialog.className='tp-notification-drawer';
    const theme=getComputedStyle(this);
    dialog.style.colorScheme=theme.colorScheme;
    for(const property of ['--card-background-color','--primary-text-color','--secondary-text-color','--secondary-background-color','--divider-color','--primary-color']){
      const value=theme.getPropertyValue(property);
      if(value)dialog.style.setProperty(property,value);
    }
    dialog.setAttribute('aria-labelledby','tp-notification-title');
    dialog.innerHTML=`<style>${notificationDrawerStyles}</style><header><h2 id="tp-notification-title"${automatic?' tabindex="-1" autofocus':''}></h2><button type="button"${automatic?'':' autofocus'}>×</button></header><div class="notification-content" aria-live="polite"><ul></ul><p hidden></p></div>`;
    dialog.querySelector('button').addEventListener('click',()=>dialog.close());
    // Native dialogs receive backdrop events themselves. Check the bounds so
    // clicking empty space inside the drawer or dragging out of it keeps it open.
    const onBackdrop=event=>{
      if(event.target!==dialog)return false;
      const {left,right,top,bottom}=dialog.getBoundingClientRect();
      return event.clientX<left||event.clientX>=right||event.clientY<top||event.clientY>=bottom;
    };
    let backdropPress=false;
    dialog.addEventListener('pointerdown',event=>{backdropPress=onBackdrop(event);});
    dialog.addEventListener('click',event=>{if(backdropPress&&onBackdrop(event))dialog.close();});
    dialog.addEventListener('close',()=>{
      clearTimeout(dialog.autoCloseTimer);
      for(const row of dialog.notificationRows.values())row.exitAnimation?.cancel();
      dialog.remove();
      if(this.notificationDrawer!==dialog)return;
      this.notificationDrawer=null;
      const trigger=this.shadowRoot.querySelector('#notification-center');
      trigger?.setAttribute('aria-expanded','false');
      trigger?.focus({preventScroll:true});
    },{once:true});
    this.renderNotificationList(activeNotifications(this.notificationData??this.info?.data));
    document.body.append(dialog);
    dialog.showModal();
    this.shadowRoot.querySelector('#notification-center')?.setAttribute('aria-expanded','true');
  }
  renderNotificationList(notices){
    const dialog=this.notificationDrawer;
    const language=this.settings?.language||'en',signature=JSON.stringify([language,notices]);
    if(dialog.notificationSignature===signature)return;
    dialog.notificationSignature=signature;
    dialog.lang=language;
    dialog.querySelector('h2').textContent=this.t('Notifications');
    dialog.querySelector('button').setAttribute('aria-label',this.t('Close'));
    const list=dialog.querySelector('.notification-content ul');
    const empty=dialog.querySelector('.notification-content p');
    empty.textContent=this.t('No active notifications.');
    const active=new Set(notices.map(notice=>notice.text));
    const removed=[...list.children].filter(row=>!active.has(row.notificationText)&&!row.exitAnimation).reverse();
    const reduceMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const stagger=Math.min(80,960/Math.max(1,removed.length-1));
    for(const [index,row] of removed.entries()){
      const removeRow=()=>{
        dialog.notificationRows.delete(row.notificationText);
        row.remove();
        empty.hidden=list.children.length>0;
      };
      if(reduceMotion||!row.animate){
        removeRow();
        continue;
      }
      row.setAttribute('aria-hidden','true');
      const animation=row.animate([
        {opacity:1,transform:'translateY(0)',height:`${row.getBoundingClientRect().height}px`,paddingBlock:'12px'},
        {opacity:0,transform:'translateY(-12px)',height:'0px',paddingBlock:'0px'},
      ],{duration:280,delay:index*stagger,easing:'ease-in-out',fill:'forwards'});
      row.exitAnimation=animation;
      animation.onfinish=()=>{
        if(row.exitAnimation===animation)removeRow();
      };
    }
    // Keep outgoing notices in place until their animation finishes.
    let next=list.firstElementChild;
    for(const {text,level} of notices){
      let row=dialog.notificationRows.get(text);
      if(!row){
        row=document.createElement('li');
        row.notificationText=text;
        dialog.notificationRows.set(text,row);
      }
      row.exitAnimation?.cancel();
      row.exitAnimation=null;
      row.removeAttribute('aria-hidden');
      row.dataset.severity=level;
      const noticeText=tpI18n.translateNotification(text,language);
      row.innerHTML=`${statusIcon(level)}<span data-user-text>${escapeHTML(noticeText)}</span>`;
      this.translateRoot(row);
      while(next&&!active.has(next.notificationText))next=next.nextElementSibling;
      if(row!==next)list.insertBefore(row,next);
      next=row.nextElementSibling;
    }
    empty.hidden=list.children.length>0;
  }
  openAwayCalendar(){
    this.awayDialog?.close();
    const dialog=document.createElement('dialog');this.awayDialog=dialog;
    dialog.className='thermal-pilot-away-dialog';dialog.setAttribute('aria-labelledby','away-title');
    const locale=this.settings.language||'en';dialog.setAttribute('lang',locale);
    let away=this.info?.data?.away||{};
    const heatingTarget=this.info?.settings?.away_temperature??away.temperature??16;
    const coolingTarget=this.info?.settings?.away_cooling_temperature??away.cooling_temperature??26;
    const timeZone=away.time_zone||this._hass?.config?.time_zone||Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parts=timestamp=>{
      const values=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(timestamp).map(part=>[part.type,part.value]));
      return {date:`${values.year}-${values.month}-${values.day}`,time:`${values.hour}:${values.minute}`};
    };
    const today=parts(Date.now());
    const selected={start:'',end:''};
    const defaultHour={start:'08',end:'16'};
    const hours=Array.from({length:24},(_,hour)=>String(hour).padStart(2,'0'));
    const minutes=['00','15','30','45'];
    const repeatLabels={once:'Does not repeat',daily:'Daily',weekly:'Weekly'};
    const localDateTime=new Intl.DateTimeFormat(locale,{timeZone,dateStyle:'medium',timeStyle:'short'});
    const calendarDate=new Intl.DateTimeFormat(locale,{timeZone:'UTC',dateStyle:'medium'});
    const dateStamp=date=>Date.parse(date+'T00:00:00Z');
    const dayMs=86400000;
    const canRepeat=(start,end)=>{
      const days=(dateStamp(end)-dateStamp(start))/dayMs+1;
      return days>=2&&days<=6;
    };
    let month=new Date(today.date+'T12:00:00');
    month.setDate(1);
    let picking='start',editing=null,pendingRemoval=null,saving=false;
    let bookingPage=0,bookingPageCount=1;
    const pageSizes=[5,10,20];
    let pageSize=pageSizes[0];
    const bookings=()=>away.schedules??(away.schedule?[{...away.schedule,id:'legacy',repeat:'once',active:away.source==='calendar'&&away.active}]:[]);
    const title=this.t('Away calendar');
    const megaphone='<svg viewBox="0 0 20 20" aria-hidden="true"><path stroke-linejoin="round" d="M3 8h4l8-4v12l-8-4H3zM5 12l1.5 4h2L7 12m10-5 1-1m-1 4h2m-2 3 1 1"/></svg>';
    const tooltip=(id,text,reminder=false)=>{
      const key=escapeHTML(id);
      const label=this.t(reminder?'Reminder lead time':'How this works');
      return `<span class="help${reminder?' reminder-indicator':''}"><button type="button"${reminder?'':' class="setting-info"'} data-help="${key}" aria-label="${escapeHTML(label)}" aria-expanded="false" aria-describedby="${key}">${reminder?megaphone:tooltipInfoIcon}</button><span id="${key}" class="tip" role="tooltip" hidden>${escapeHTML(this.t(text))}</span></span>`;
    };
    const help='Detection off: bookings end by time or cancellation. Detection on: returning home also cancels active bookings. No advance warm-up. Garages and exempt rooms keep normal targets.';
    const cancelHelp='Normal temperature settings resume when you cancel the period. Away temperatures stay active if another calendar period or automatic absence is still active.';
    const timeSelect=(key,unit,values)=>`<span class="calendar-select"><select name="${key}-${unit}" aria-label="${escapeHTML(this.t(unit==='hour'?'hours':'minutes'))}"><option value="">–</option>${values.map(value=>`<option value="${value}">${value}</option>`).join('')}</select></span>`;
    dialog.innerHTML=`<style>
      .thermal-pilot-away-dialog{color:var(--primary-text-color,#213547);background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#d8e0e4);border-radius:20px;padding:24px;width:min(720px,calc(100vw - 24px));max-height:calc(100dvh - 32px);overflow:auto;box-sizing:border-box;box-shadow:0 20px 80px #142e4540;font:14px system-ui}.thermal-pilot-away-dialog::backdrop{background:#182b3c65}.thermal-pilot-away-dialog *{box-sizing:border-box}.thermal-pilot-away-dialog button,.thermal-pilot-away-dialog input{font:inherit;color:inherit}.thermal-pilot-away-dialog header,.thermal-pilot-away-dialog .month-nav{display:flex;align-items:center;justify-content:space-between;gap:12px}.thermal-pilot-away-dialog h2{font-size:22px;margin:0}.thermal-pilot-away-dialog .heading{display:flex;align-items:center;gap:10px}.thermal-pilot-away-dialog button{cursor:pointer}.thermal-pilot-away-dialog button:focus-visible,.thermal-pilot-away-dialog input:focus-visible{outline:2px solid var(--primary-color,#00838f);outline-offset:2px}.thermal-pilot-away-dialog .close{border:0;background:transparent;font-size:26px;min-width:40px;min-height:40px}.thermal-pilot-away-dialog .status{color:var(--secondary-text-color,#526b75);margin:8px 0 18px}.thermal-pilot-away-dialog .targets{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}.thermal-pilot-away-dialog .targets span{padding:6px 10px;border-radius:8px;background:#829aa313;font-size:13px}.thermal-pilot-away-dialog .dates{display:grid;grid-template-columns:1fr 1fr;gap:12px}.thermal-pilot-away-dialog .date-card{padding:12px;border:1px solid var(--divider-color,#d8e0e4);border-radius:12px;background:var(--secondary-background-color,#f5f8fa)}.thermal-pilot-away-dialog .date-card.active{border-color:var(--primary-color,#00838f);box-shadow:0 0 0 1px var(--primary-color,#00838f)}.thermal-pilot-away-dialog .pick{font-weight:600;border:0;background:transparent;padding:0 0 8px;color:var(--primary-color,#00838f)}.thermal-pilot-away-dialog .date-inputs{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:8px}.thermal-pilot-away-dialog input{min-width:0;width:100%;border:1px solid #b6c8d0;border-radius:6px;background:var(--card-background-color,#fff);padding:8px;min-height:40px}.thermal-pilot-away-dialog .month-nav{margin:16px 0 8px}.thermal-pilot-away-dialog .month-nav button{border:0;border-radius:8px;background:#829aa310;font-size:24px;width:40px;height:40px}.thermal-pilot-away-dialog .month-nav span{font-size:13px;color:var(--secondary-text-color,#526b75)}.thermal-pilot-away-dialog .calendar-picker{width:min(100%,420px);margin-inline:auto}.thermal-pilot-away-dialog .date-prompt{font-weight:600;color:var(--primary-text-color,#213547)}.thermal-pilot-away-dialog .month h3{font-size:15px;text-align:center;margin:8px 0 12px}.thermal-pilot-away-dialog .days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px}.thermal-pilot-away-dialog .weekday{font-size:11px;color:var(--secondary-text-color,#526b75);text-align:center;padding:6px 0}.thermal-pilot-away-dialog .day{height:36px;min-width:0;border:0;border-radius:7px;background:transparent;padding:0}.thermal-pilot-away-dialog .day.other{opacity:.35}.thermal-pilot-away-dialog .day.range{background:#00838f12;border-radius:3px}.thermal-pilot-away-dialog .day.today{box-shadow:inset 0 0 0 1px #829aa370}.thermal-pilot-away-dialog .day.selected{background:var(--primary-color,#00838f);color:var(--text-primary-color,#fff);font-weight:700;border-radius:8px}.thermal-pilot-away-dialog .day:hover{box-shadow:inset 0 0 0 2px var(--primary-color,#00838f)}.thermal-pilot-away-dialog .zone{color:var(--secondary-text-color,#526b75);font-size:12px;line-height:1.6;margin:0;margin-inline-end:auto}.thermal-pilot-away-dialog footer{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;margin-top:16px}.thermal-pilot-away-dialog footer button{min-height:40px;border:0;border-radius:20px;padding:8px 14px;background:transparent;color:var(--primary-color,#00838f)}.thermal-pilot-away-dialog footer .save{background:var(--primary-color,#00838f);color:var(--text-primary-color,#fff);margin-left:auto}.thermal-pilot-away-dialog footer .stop{color:var(--error-color,#ba4d43);border:1px solid #d2837b55}.thermal-pilot-away-dialog .help{position:relative;display:inline-flex;align-items:center}.thermal-pilot-away-dialog .help>button{display:flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--primary-color,#00838f);width:32px;min-height:32px;padding:6px}.thermal-pilot-away-dialog .help svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.5}.thermal-pilot-away-dialog .tip{position:fixed;z-index:10;padding:12px 14px;border-radius:10px;background:#18282f;color:#fff;font-size:13px;font-weight:400;line-height:1.6;overflow:auto;overflow-wrap:anywhere;box-shadow:0 6px 24px #0003}.thermal-pilot-away-dialog [hidden]{display:none!important}.thermal-pilot-away-dialog [role=alert]{color:var(--error-color,#b23b34);line-height:1.5}.thermal-pilot-away-dialog button:disabled{opacity:.5;cursor:default}@media(max-width:600px){.thermal-pilot-away-dialog{padding:18px}.thermal-pilot-away-dialog .dates{gap:8px}.thermal-pilot-away-dialog .date-inputs{grid-template-columns:1fr}.thermal-pilot-away-dialog .day{height:40px}}
      .thermal-pilot-away-dialog .calendar-options{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;margin:12px 0}
      .thermal-pilot-away-dialog .calendar-options input[type=number]{width:112px}
      .thermal-pilot-away-dialog .calendar-options input[type=checkbox]{width:auto;min-height:0;accent-color:var(--primary-color,#00838f)}
      .thermal-pilot-away-dialog .calendar-checkbox{display:inline-flex;align-items:center;gap:8px}
      .thermal-pilot-away-dialog .calendar-checkbox input{margin:0}
      .thermal-pilot-away-dialog .repeat-limit>label{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
      .thermal-pilot-away-dialog .repeat-summary{color:var(--secondary-text-color,#526b75);margin:0}
      .thermal-pilot-away-dialog .reminder-lead{margin:0}
      .thermal-pilot-away-dialog .time-inputs{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:4px}
      .thermal-pilot-away-dialog .calendar-select{position:relative;display:inline-flex}
      .thermal-pilot-away-dialog .calendar-select select{appearance:none;padding-inline-end:30px}
      .thermal-pilot-away-dialog .calendar-select::after{content:'';position:absolute;inset-inline-end:12px;top:50%;width:6px;height:6px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:translateY(-70%) rotate(45deg);pointer-events:none}
      .thermal-pilot-away-dialog .time-inputs select{width:100%;min-width:0;padding:6px;padding-inline-end:24px}
      .thermal-pilot-away-dialog select{font:inherit;color:inherit;min-height:40px;padding:6px 12px;border:1px solid #b6c8d0;border-radius:6px;background:var(--card-background-color,#fff)}
      .thermal-pilot-away-dialog .upcoming{margin-top:20px;border-top:1px solid var(--divider-color,#d8e0e4);padding-top:16px}
      .thermal-pilot-away-dialog .upcoming h3{font-size:16px;margin:0 0 8px}
      .thermal-pilot-away-dialog .bookings{padding:0;margin:0;list-style:none}
      .thermal-pilot-away-dialog .booking-pages,.thermal-pilot-away-dialog .booking-page-settings,.thermal-pilot-away-dialog .booking-page-controls,.thermal-pilot-away-dialog .booking-page-size{display:flex;align-items:center;gap:8px}
      .thermal-pilot-away-dialog .booking-pages{justify-content:space-between;flex-wrap:wrap;margin:8px 0}
      .thermal-pilot-away-dialog .booking-total{color:var(--secondary-text-color,#526b75)}
      .thermal-pilot-away-dialog .booking-page-settings{margin-inline-start:auto;flex-wrap:wrap;justify-content:flex-end}
      .thermal-pilot-away-dialog .booking-pages button{min-width:36px}
      .thermal-pilot-away-dialog .bookings li{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 16px;padding:10px 0;border-bottom:1px solid var(--divider-color,#d8e0e4)}
      .thermal-pilot-away-dialog .booking-meta{display:block;color:var(--secondary-text-color,#526b75);font-size:12px;margin-top:4px}
      .thermal-pilot-away-dialog .booking-actions,.thermal-pilot-away-dialog .remove-actions{display:flex;gap:8px;flex-wrap:wrap}
      .thermal-pilot-away-dialog .upcoming button:not([data-help]){min-height:36px;padding:6px 10px;color:var(--primary-color,#00838f);background:transparent;border:1px solid var(--divider-color,#d8e0e4);border-radius:8px}
      .thermal-pilot-away-dialog .help>.setting-info{width:22px;min-height:22px;margin-inline-start:3px;padding:1px;border-radius:50%;color:var(--primary-color,#087c85);cursor:help}
      .thermal-pilot-away-dialog .setting-info svg{width:20px;height:20px;stroke-width:1.7;stroke-linecap:round}
      .thermal-pilot-away-dialog .setting-info .status-info-dot{fill:currentColor;stroke:none}
      @media(max-width:600px){.thermal-pilot-away-dialog .help>.setting-info{width:32px;min-height:32px}}
      .thermal-pilot-away-dialog .reminder-indicator{vertical-align:middle;margin-inline-start:4px}
      .thermal-pilot-away-dialog .reminder-indicator>button{padding:5px;border:0;min-height:28px;width:28px}
      .thermal-pilot-away-dialog .upcoming [data-remove-booking],.thermal-pilot-away-dialog .upcoming [data-removal="cancel"]{color:var(--error-color,#ba4d43)}
      .thermal-pilot-away-dialog .remove-choice{flex:0 0 100%;margin-top:4px;padding:10px 12px;background:var(--secondary-background-color,#f5f8fa);border-radius:8px}
      .thermal-pilot-away-dialog .remove-choice p{margin:0 0 8px}
    </style><form novalidate>
      <header><div class="heading"><h2 id="away-title">${escapeHTML(title)}</h2>${tooltip('calendar-help',help)}</div><button type="button" class="close" aria-label="${escapeHTML(this.t('Close'))}">×</button></header>
      <p class="status"></p>
      <div class="targets"><span>${escapeHTML(this.t('Heating'))} ${escapeHTML(heatingTarget)} °C</span><span>${escapeHTML(this.t('Cooling'))} ${escapeHTML(coolingTarget)} °C</span></div>
      <div class="dates">${['start','end'].map(key=>`<div class="date-card" data-date-card="${key}"><button type="button" class="pick" data-pick="${key}">${escapeHTML(this.t(key==='start'?'Start':'End'))}</button><div class="date-inputs"><input type="date" name="${key}-date" aria-label="${escapeHTML(this.t(key==='start'?'Start date':'End date'))}" value=""><div class="time-inputs" role="group" aria-label="${escapeHTML(this.t(key==='start'?'Start time':'End time'))}">${timeSelect(key,'hour',hours)}<span aria-hidden="true">:</span>${timeSelect(key,'minute',minutes)}</div></div></div>`).join('')}</div>
      <div class="calendar-picker"><div class="month-nav"><button type="button" data-month="-1" aria-label="${escapeHTML(this.t('Previous month'))}">‹</button><span class="date-prompt" aria-live="polite"></span><button type="button" data-month="1" aria-label="${escapeHTML(this.t('Next month'))}">›</button></div><div class="months"></div></div>
      <div class="calendar-options repeat" hidden><label class="calendar-checkbox"><input name="repeat" type="checkbox"> ${escapeHTML(this.t('Repeat weekly'))}</label></div>
      <div class="calendar-options repeat-limit" hidden><label class="repeat-count-label">${escapeHTML(this.t('Repeat for'))} <input name="repeat-count" type="number" min="1" max="365" step="1"> ${escapeHTML(this.t('weeks'))}</label><p class="repeat-summary" aria-live="polite" hidden></p></div>
      <div class="calendar-options"><label class="calendar-checkbox"><input name="reminder" type="checkbox"> ${escapeHTML(this.t('Remind me before the absence'))}</label><div class="calendar-options reminder-lead" hidden><input name="reminder-amount" type="number" value="24" min="1" max="720" step="1" aria-label="${escapeHTML(this.t('Reminder lead time'))}"><span class="calendar-select"><select name="reminder-unit" aria-label="${escapeHTML(this.t('Reminder time unit'))}"><option value="hours">${escapeHTML(this.t('hours'))}</option><option value="days">${escapeHTML(this.t('days'))}</option></select></span></div></div>
      <p role="alert" hidden></p>
      <footer><p class="zone">${escapeHTML(this.t('Home Assistant time zone'))}: <span data-user-text>${escapeHTML(timeZone)}</span></p><button type="button" class="cancel-edit" hidden>${escapeHTML(this.t('Cancel'))}</button><button type="submit" class="save"></button></footer>
      <section class="upcoming"><h3>${escapeHTML(this.t('Upcoming absences'))} ${tooltip('cancel-help',cancelHelp)}</h3><p class="no-bookings">${escapeHTML(this.t('No calendar absence'))}</p>
        <div class="booking-pages" hidden><span class="booking-total" aria-live="polite"></span>
          <div class="booking-page-settings">
            <label class="booking-page-size">${escapeHTML(this.t('Per page'))} <span class="calendar-select"><select name="booking-page-size">${pageSizes.map(size=>`<option value="${size}">${size}</option>`).join('')}</select></span></label>
            <div class="booking-page-controls" role="group" aria-label="${escapeHTML(this.t('Upcoming absences'))}" hidden><button type="button" data-booking-page="-1" aria-label="${escapeHTML(this.t('Previous page'))}">‹</button><span class="booking-page-number" aria-live="polite"></span><button type="button" data-booking-page="1" aria-label="${escapeHTML(this.t('Next page'))}">›</button></div>
          </div>
        </div><ul class="bookings"></ul>
      </section>
    </form>`;
    const field=name=>dialog.querySelector(`[name="${name}"]`);
    const fillDefaultTime=key=>{
      const hour=field(key+'-hour'),minute=field(key+'-minute');
      if(!hour.value)hour.value=defaultHour[key];
      if(!minute.value)minute.value='00';
    };
    for(const key of ['start','end']){
      const minute=field(key+'-minute');
      field(key+'-hour').addEventListener('change',()=>{
        const savedMinute=minute.querySelector('[data-saved-minute]');
        if(!savedMinute)return;
        if(minute.value===savedMinute.value)minute.value='00';
        savedMinute.remove();
      });
      minute.addEventListener('change',()=>minute.querySelector('[data-saved-minute]')?.remove());
    }
    const repeatEnabled=()=>canRepeat(field('start-date').value,field('end-date').value)&&field('repeat').checked;
    const showOptions=()=>{
      const start=field('start-date').value;
      const end=field('end-date').value;
      const eligible=canRepeat(start,end);
      dialog.querySelector('.repeat').hidden=!eligible;
      const repeating=repeatEnabled();
      dialog.querySelector('.repeat-count-label').hidden=!repeating;
      field('repeat-count').required=repeating;
      const count=Number(field('repeat-count').value);
      const summary=dialog.querySelector('.repeat-summary');
      summary.textContent='';
      if(repeating&&Number.isInteger(count)&&count>=1&&count<=365){
        // Shift civil calendar dates by weeks, independent of DST offsets.
        const offset=(count-1)*7*dayMs;
        const lastRange=calendarDate.formatRange(dateStamp(start)+offset,dateStamp(end)+offset);
        summary.textContent=`${this.t('Last period')} · ${lastRange}`;
      }else if(!eligible&&editing&&field('repeat').checked){
        summary.textContent=this.t('Does not repeat');
      }
      summary.hidden=!summary.textContent;
      dialog.querySelector('.repeat-limit').hidden=!repeating&&summary.hidden;
      dialog.querySelector('.reminder-lead').hidden=!field('reminder').checked;
      field('reminder-amount').max=field('reminder-unit').value==='days'?30:720;
    };
    for(const name of ['repeat','reminder','reminder-unit'])field(name).addEventListener('change',showOptions);
    field('repeat-count').addEventListener('input',showOptions);
    const draftButtons=()=>{
      dialog.querySelector('.cancel-edit').hidden=editing===null;
      dialog.querySelector('.save').textContent=this.t(editing?'Update period':'Schedule absence');
    };
    const updatePageButtons=()=>{
      field('booking-page-size').disabled=saving;
      dialog.querySelector('[data-booking-page="-1"]').disabled=saving||bookingPage===0;
      dialog.querySelector('[data-booking-page="1"]').disabled=saving||bookingPage===bookingPageCount-1;
    };
    const drawBookings=()=>{
      const entries=bookings();
      const occurrences=away.occurrences??entries;
      bookingPageCount=Math.max(1,Math.ceil(occurrences.length/pageSize));
      bookingPage=Math.max(0,Math.min(bookingPage,bookingPageCount-1));
      dialog.querySelector('.booking-pages').hidden=occurrences.length===0;
      dialog.querySelector('.booking-page-controls').hidden=bookingPageCount===1;
      const count=(away.occurrence_count??occurrences.length).toLocaleString(locale);
      dialog.querySelector('.booking-total').textContent=`${this.t('Total absences')} · ${count}${away.has_ongoing_series?'+':''}`;
      dialog.querySelector('.booking-page-number').textContent=`${bookingPage+1} / ${bookingPageCount}`;
      updatePageButtons();
      const status=away.active?this.t(away.source==='calendar'?'Calendar absence active':'Automatic absence active'):entries.length?this.t('Scheduled absence'):this.t('No calendar absence');
      dialog.querySelector('.status').textContent=status;
      dialog.querySelector('.no-bookings').hidden=entries.length>0;
      const visible=occurrences.slice(bookingPage*pageSize,(bookingPage+1)*pageSize);
      dialog.querySelector('.bookings').innerHTML=visible.map(entry=>{
        const id=escapeHTML(entry.id);
        const range=`${localDateTime.format(entry.start*1000)} – ${localDateTime.format(entry.end*1000)}`;
        let reminder='';
        if(entry.reminder_hours>0){
          const inDays=entry.reminder_hours%24===0;
          const duration=new Intl.NumberFormat(locale,{style:'unit',unit:inDays?'day':'hour',unitDisplay:'long'})
            .format(inDays?entry.reminder_hours/24:entry.reminder_hours);
          reminder=tooltip(`reminder-${entry.id}-${entry.start}`,`${this.t('Reminder lead time')} · ${duration}`,true);
        }
        const meta=[entry.active?this.t('Calendar absence active'):'',entry.repeat!=='once'?this.t(repeatLabels[entry.repeat]):''].filter(Boolean).join(' · ');
        const canEdit=entry.repeat==='once'||(entry.repeat==='weekly'&&canRepeat(parts(entry.start*1000).date,parts(entry.end*1000).date));
        const edit=canEdit?`<button type="button" data-edit-booking="${id}">${escapeHTML(this.t(entry.repeat==='once'?'Edit':'Edit series'))}</button>`:'';
        const isChoosing=pendingRemoval?.id===entry.id&&pendingRemoval.start===entry.start;
        const choice=isChoosing?`<div class="remove-choice"><p>${escapeHTML(this.t('Cancel this occurrence or the whole series?'))}</p><div class="remove-actions"><button type="button" data-removal="skip">${escapeHTML(this.t('This occurrence'))}</button><button type="button" data-removal="cancel">${escapeHTML(this.t('Whole series'))}</button><button type="button" data-removal="keep">${escapeHTML(this.t('Keep schedule'))}</button></div></div>`:'';
        return `<li><div>${escapeHTML(range)}${reminder}${meta?`<span class="booking-meta">${escapeHTML(meta)}</span>`:''}</div><div class="booking-actions">${edit}<button type="button" data-remove-booking="${id}" data-occurrence="${entry.start}"${entry.repeat==='once'?'':` aria-expanded="${isChoosing}"`}>${escapeHTML(this.t('Cancel period'))}</button></div>${choice}</li>`;
      }).join('');
    };
    const draw=()=>{
      showOptions();
      dialog.querySelector('.months').innerHTML=awayCalendarMonth(month,selected,today.date,locale);
      dialog.querySelector('.date-prompt').textContent=this.t(picking==='start'?'Choose a start date':'Choose an end date');
      dialog.querySelectorAll('[data-date-card]').forEach(card=>{
        const active=card.dataset.dateCard===picking;
        card.classList.toggle('active',active);
        card.querySelector('.pick').setAttribute('aria-pressed',String(active));
      });
    };
    const loadDraft=booking=>{
      editing=booking?.id??null;
      dialog.querySelector('[role=alert]').hidden=true;
      for(const key of ['start','end']){
        const values=booking?parts(booking[key]*1000):{date:'',time:''};
        selected[key]=field(key+'-date').value=values.date;
        const [hour,minute='']=values.time.split(':');
        const minuteField=field(key+'-minute');
        minuteField.querySelector('[data-saved-minute]')?.remove();
        // Keep existing bookings exact when editing other fields.
        if(minute&&!minutes.includes(minute)){
          minuteField.insertAdjacentHTML('beforeend',`<option data-saved-minute disabled value="${escapeHTML(minute)}">${escapeHTML(minute)}</option>`);
        }
        field(key+'-hour').value=hour;
        minuteField.value=minute;
      }
      field('repeat').checked=booking?.repeat==='weekly';
      field('repeat-count').value=booking?.repeat_count||'';
      const reminderHours=booking?.reminder_hours||0;
      const useDays=reminderHours>0&&reminderHours%24===0;
      field('reminder').checked=reminderHours>0;
      field('reminder-unit').value=useDays?'days':'hours';
      field('reminder-amount').value=useDays?reminderHours/24:reminderHours||24;
      month=new Date((selected.start||today.date)+'T12:00:00');
      month.setDate(1);
      picking='start';
      draftButtons();
      draw();
    };
    const select=date=>{
      selected[picking]=date;
      fillDefaultTime(picking);
      if(picking==='start'&&selected.end&&selected.end<date)selected.end=date;
      if(picking==='end'&&selected.start&&selected.start>date)selected.start=date;
      for(const key of ['start','end'])field(key+'-date').value=selected[key];
      month=new Date(date+'T12:00:00');month.setDate(1);
      picking=picking==='start'?'end':'start';draw();
      dialog.querySelector(`[data-calendar-date="${date}"]`)?.focus({preventScroll:true});
    };
    let openHelp=null;
    const closeHelp=()=>{
      if(!openHelp)return;
      const tip=dialog.querySelector('#'+CSS.escape(openHelp.dataset.help));
      if(tip)tip.hidden=true;
      openHelp.setAttribute('aria-expanded','false');
      openHelp=null;
    };
    field('booking-page-size').addEventListener('change',event=>{
      pageSize=Number(event.target.value);
      bookingPage=0;
      pendingRemoval=null;
      closeHelp();
      drawBookings();
    });
    const showHelp=button=>{
      closeHelp();
      const tip=dialog.querySelector('#'+CSS.escape(button.dataset.help));
      const bounds=dialog.getBoundingClientRect();
      const anchor=button.getBoundingClientRect();
      const margin=8;
      const left=bounds.left+dialog.clientLeft+margin;
      const top=bounds.top+dialog.clientTop+margin;
      const right=left+dialog.clientWidth-2*margin;
      const bottom=top+dialog.clientHeight-2*margin;
      tip.style.width=Math.min(340,right-left)+'px';
      tip.style.maxHeight=(bottom-top)+'px';
      tip.hidden=false;
      const {width,height}=tip.getBoundingClientRect();
      const below=anchor.bottom+margin;
      const preferredTop=below+height<=bottom?below:anchor.top-margin-height;
      tip.style.left=Math.max(left,Math.min(anchor.left,right-width))+'px';
      tip.style.top=Math.max(top,Math.min(preferredTop,bottom-height))+'px';
      button.setAttribute('aria-expanded','true');
      openHelp=button;
    };
    dialog.addEventListener('scroll',closeHelp);
    const helpResize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(closeHelp);
    dialog.addEventListener('click',event=>{
      const day=event.target.closest('[data-calendar-date]');if(day)select(day.dataset.calendarDate);
      const picker=event.target.closest('[data-pick]');
      if(picker){
        picking=picker.dataset.pick;
        if(selected[picking]){
          month=new Date(selected[picking]+'T12:00:00');month.setDate(1);
        }
        draw();
      }
      const navigation=event.target.closest('[data-month]');if(navigation){month=new Date(month.getFullYear(),month.getMonth()+Number(navigation.dataset.month),1,12);draw();}
      const pagination=event.target.closest('[data-booking-page]');
      if(pagination&&!saving){
        bookingPage+=Number(pagination.dataset.bookingPage);
        pendingRemoval=null;
        drawBookings();
        if(pagination.disabled){
          dialog.querySelector('.booking-pages button:not(:disabled)')?.focus();
        }
      }
      const edit=event.target.closest('[data-edit-booking]');
      if(edit&&!saving){
        pendingRemoval=null;
        drawBookings();
        loadDraft(bookings().find(entry=>entry.id===edit.dataset.editBooking));
        field('start-date').focus();
      }
      const removal=event.target.closest('[data-remove-booking]');
      if(removal&&!saving){
        const entry=(away.occurrences??bookings()).find(item=>item.id===removal.dataset.removeBooking&&item.start===Number(removal.dataset.occurrence));
        if(entry?.repeat==='once')void submit({action:'cancel',booking_id:entry.id});
        else if(entry){
          pendingRemoval=entry;
          drawBookings();
          dialog.querySelector('[data-removal="skip"]')?.focus();
        }
      }
      const decision=event.target.closest('[data-removal]')?.dataset.removal;
      if(decision&&pendingRemoval&&!saving){
        if(decision==='keep'){
          const {id,start}=pendingRemoval;
          pendingRemoval=null;
          drawBookings();
          dialog.querySelector(`[data-remove-booking="${CSS.escape(id)}"][data-occurrence="${start}"]`)?.focus();
        }else void submit({action:decision,booking_id:pendingRemoval.id,occurrence:pendingRemoval.start});
      }
      const help=event.target.closest('[data-help]');
      if(help&&help!==openHelp)showHelp(help);
      else if(!event.target.closest('.tip'))closeHelp();
    });
    dialog.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&openHelp){event.preventDefault();event.stopPropagation();closeHelp();return;}
      const button=event.target.closest('[data-calendar-date]');
      const shift={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
      if(!button||!Object.hasOwn(shift,event.key))return;
      event.preventDefault();const date=new Date(button.dataset.calendarDate+'T12:00:00');date.setDate(date.getDate()+shift[event.key]);
      const key=calendarDateKey(date);
      if(![...dialog.querySelectorAll(`[data-calendar-date="${key}"]`)].some(day=>day.getClientRects().length)){month=new Date(date.getFullYear(),date.getMonth(),1,12);draw();}
      dialog.querySelector(`[data-calendar-date="${key}"]`)?.focus();
    });
    for(const key of ['start','end'])field(key+'-date').addEventListener('change',event=>{
      selected[key]=event.target.value;picking=key;
      if(event.target.value){
        month=new Date(event.target.value+'T12:00:00');month.setDate(1);
        fillDefaultTime(key);
      }
      draw();
    });
    const submit=async request=>{
      if(saving)return;
      const alert=dialog.querySelector('[role=alert]');alert.hidden=true;
      if(request.action==='set'){
        const dateTime=key=>`${field(key+'-date').value}T${field(key+'-hour').value}:${field(key+'-minute').value}`;
        const start=dateTime('start');
        const end=dateTime('end');
        let validationError='';
        if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(start)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(end)){
          validationError='Choose valid start and end dates and times.';
        }else if(end<=start){
          validationError='The end must be after the start and in the future.';
        }
        const repeat=repeatEnabled()?'weekly':'once';
        const repeatCount=repeat==='once'?0:Number(field('repeat-count').value);
        const reminderAmount=Number(field('reminder-amount').value);
        const reminderHours=field('reminder').checked?reminderAmount*(field('reminder-unit').value==='days'?24:1):0;
        if(!validationError&&repeat!=='once'&&(!Number.isInteger(repeatCount)||repeatCount<1||repeatCount>365)){
          validationError='Enter a whole number from 1 to 365.';
        }
        if(!validationError&&field('reminder').checked&&(!Number.isInteger(reminderAmount)||reminderHours<1||reminderHours>720)){
          validationError='Choose a reminder from 1 hour to 30 days.';
        }
        if(validationError){alert.textContent=this.t(validationError);alert.hidden=false;return;}
        Object.assign(request,{start,end,repeat,repeat_count:repeatCount,reminder_hours:reminderHours});
        if(editing)request.booking_id=editing;
      }
      saving=true;
      dialog.querySelectorAll('button').forEach(button=>button.disabled=true);
      updatePageButtons();
      try{
        const result=await this.call('away',request);
        this.info.data=result.data;
        away=result.away??result.data.away;
        this.render();
        if(dialog.open){
          pendingRemoval=null;
          if(request.action==='set'||request.booking_id===editing)loadDraft(null);
          drawBookings();
          field('start-date').focus();
        }
      }catch(error){
        alert.textContent=this.t(error.message||'Unable to save the absence period.');alert.hidden=false;
      }finally{
        saving=false;
        dialog.querySelectorAll('button').forEach(button=>button.disabled=false);
        if(dialog.open)updatePageButtons();
      }
    };
    dialog.querySelector('form').addEventListener('submit',event=>{event.preventDefault();void submit({action:'set'});});
    dialog.querySelector('.cancel-edit').addEventListener('click',()=>{loadDraft(null);field('start-date').focus();});
    dialog.querySelector('.close').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>{helpResize?.disconnect();dialog.remove();if(this.awayDialog===dialog)this.awayDialog=null;[...this.shadowRoot.querySelectorAll('[data-away-calendar]')].find(button=>button.getClientRects().length)?.focus();},{once:true});
    document.body.append(dialog);loadDraft(null);drawBookings();dialog.showModal();
    helpResize?.observe(dialog);
  }
  openManualSession(id,mode,trigger){
    const control=this.info?.manual_controls?.[id];if(!control)return;
    this.manualDialog?.close();
    const dialog=document.createElement('dialog');this.manualDialog=dialog;
    dialog.className='thermal-pilot-manual-dialog';dialog.setAttribute('aria-labelledby','manual-title');dialog.setAttribute('lang',this.settings.language||'en');
    const session=control.session&&control.session.ends*1000>Date.now()?control.session:null;
    const currentStatus=this.manualControlStatus(id);
    const same=session?.mode===mode;
    const limits=control.limits?.[mode]||control;
    const needsTarget=control.target_required!==false;
    const target=same?session.target:control[mode+'_target'];
    const label=this.t(mode==='heat'?'Manual heating':'Manual cooling');
    const end=session?new Intl.DateTimeFormat(this.settings.language||'en',{dateStyle:'short',timeStyle:'short'}).format(session.ends*1000):'';
    const status=session?`${this.t(session.mode==='heat'?'Manual heating':'Manual cooling')} · ${new Intl.NumberFormat(this.settings.language||'en',{maximumFractionDigits:2}).format(session.target)} °C · ${this.t('Ends at')} ${end}`:'';
    dialog.innerHTML=`<style>
      .thermal-pilot-manual-dialog{color:var(--primary-text-color,#213547);background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#d5dce0);border-radius:16px;padding:24px;width:min(440px,calc(100vw - 32px));box-sizing:border-box;box-shadow:0 16px 64px #162a3b40;font:14px system-ui}.thermal-pilot-manual-dialog::backdrop{background:#182b3c65}.thermal-pilot-manual-dialog header{display:flex;align-items:center;justify-content:space-between;gap:10px}.thermal-pilot-manual-dialog h2{font-size:21px;margin:0}.thermal-pilot-manual-dialog button,.thermal-pilot-manual-dialog input,.thermal-pilot-manual-dialog select{font:inherit}.thermal-pilot-manual-dialog .close{background:none;border:0;font-size:26px;color:inherit;cursor:pointer}.thermal-pilot-manual-dialog .room{margin:8px 0 24px;color:var(--secondary-text-color,#526b75)}.thermal-pilot-manual-dialog .fields{display:grid;grid-template-columns:1fr 1fr;gap:16px}.thermal-pilot-manual-dialog label{display:flex;flex-direction:column;gap:8px;line-height:1.5}.thermal-pilot-manual-dialog select,.thermal-pilot-manual-dialog input{width:100%;box-sizing:border-box;min-height:42px;border:1px solid #a9beca;border-radius:6px;padding:8px;color:inherit;background:var(--card-background-color,#fff)}.thermal-pilot-manual-dialog .note{color:var(--secondary-text-color,#526b75);line-height:1.6;margin:20px 0}.thermal-pilot-manual-dialog .status{padding:12px;border-radius:8px;line-height:1.5;background:#1689cc18}.thermal-pilot-manual-dialog footer{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.thermal-pilot-manual-dialog footer button{min-height:40px;padding:8px 12px;border:0;border-radius:20px;background:transparent;color:var(--primary-color,#007f8b);cursor:pointer}.thermal-pilot-manual-dialog .start{background:var(--primary-color,#007f8b);color:var(--text-primary-color,#fff)}.thermal-pilot-manual-dialog .stop{color:#b23b34;margin-right:auto;border:1px solid #e6b7b3}.thermal-pilot-manual-dialog [hidden]{display:none!important}.thermal-pilot-manual-dialog button:disabled{opacity:.45;cursor:default}.thermal-pilot-manual-dialog [role=alert]{color:var(--error-color,#b23b34)}@media(max-width:450px){.thermal-pilot-manual-dialog .fields{grid-template-columns:1fr}}
    </style><form method="dialog" novalidate><header><h2 id="manual-title">${escapeHTML(label)}</h2><button class="close" value="cancel" formnovalidate aria-label="${escapeHTML(this.t('Close'))}">×</button></header><p class="room" data-user-text>${escapeHTML(control.name)}</p><p class="status" data-current-activity>${escapeHTML(currentStatus.text)}</p>${session?`<p class="status" data-user-text>${escapeHTML(status)}</p>`:''}<div class="fields" style="${needsTarget?'':'grid-template-columns:1fr'}"><label>${escapeHTML(this.t('Duration'))}<select name="minutes">${[30,60,120,240,480,1440].map(minutes=>`<option value="${minutes}" ${minutes===120?'selected':''}>${escapeHTML(new Intl.NumberFormat(this.settings.language||'en',{style:'unit',unit:minutes<60?'minute':'hour',unitDisplay:'long'}).format(minutes<60?minutes:minutes/60))}</option>`).join('')}</select></label>${needsTarget?`<label>${escapeHTML(this.t('Target temperature (°C)'))}<input name="target" type="number" min="${limits.minimum}" max="${limits.maximum}" step="${limits.step}" value="${target}" required></label>`:''}</div><p class="note">${escapeHTML(this.t('Automatic control resumes when the session ends.'))}</p>${!control.enabled?`<p class="note">${escapeHTML(this.t('Enable confirmed live control before starting a session.'))}</p>`:''}<p role="alert" hidden></p><footer>${session?`<button type="button" class="stop">${escapeHTML(this.t('Stop session'))}</button>`:''}<button value="cancel" formnovalidate>${escapeHTML(this.t('Cancel'))}</button><button type="button" class="start" ${!control.enabled?'disabled':''}>${escapeHTML(this.t(same?'Update session':mode==='heat'?'Start heating':'Start cooling'))}</button></footer></form>`;
    const submit=async(stop=false)=>{
      const input=dialog.querySelector('input');
      const alert=dialog.querySelector('[role=alert]');
      if(!stop&&needsTarget){
        const temperature=Number(input.value);
        const format=new Intl.NumberFormat(this.settings.language||'en',{maximumFractionDigits:2});
        let validation='';
        if(input.value.trim()===''||!Number.isFinite(temperature)||temperature<limits.minimum||temperature>limits.maximum){
          validation=this.t('Enter a temperature between {minimum} and {maximum} °C.')
            .replaceAll('{minimum}',format.format(limits.minimum)).replaceAll('{maximum}',format.format(limits.maximum));
        }else{
          const steps=(temperature-limits.minimum)/limits.step;
          if(Math.abs(steps-Math.round(steps))>1e-6){
            validation=this.t('Use temperature steps of {step} °C.').replaceAll('{step}',format.format(limits.step));
          }
        }
        if(validation){
          alert.hidden=false;alert.textContent=validation;input.setAttribute('aria-invalid','true');input.focus();return;
        }
        input.removeAttribute('aria-invalid');alert.hidden=true;
      }
      dialog.querySelectorAll('button').forEach(button=>{button.disabled=true;});
      try{
        const result=await this.call('manual',{room_id:id,mode:stop?'stop':mode,...(stop?{}:{minutes:Number(dialog.querySelector('select').value),...(needsTarget?{target:Number(input.value)}:{})})});
        this.info.manual_controls=result.manual_controls;
        dialog.close();await this.load();
      }catch(error){
        const alert=dialog.querySelector('[role=alert]');alert.hidden=false;alert.textContent=this.t('Unable to change the manual session. Check the connection and current control settings.');
        dialog.querySelectorAll('button').forEach(button=>{button.disabled=false;});
        if(!control.enabled)dialog.querySelector('.start').disabled=true;
      }
    };
    dialog.querySelector('.start').addEventListener('click',()=>submit());
    dialog.querySelector('.stop')?.addEventListener('click',()=>submit(true));
    dialog.querySelector('form').addEventListener('submit',event=>{if(event.submitter?.classList.contains('close')||event.submitter?.value==='cancel')return;event.preventDefault();submit();});
    dialog.addEventListener('close',()=>{dialog.remove();if(this.manualDialog===dialog)this.manualDialog=null;trigger?.focus();},{once:true});
    document.body.append(dialog);dialog.showModal();
  }
  async call(type,extra={}){return this._hass.callWS({type:`thermal_pilot/${type}`,entry_id:this.entry,...extra});}
  async load(){
    if(!this.entry || this.loading)return;
    this.restoreHistoryPeriod();
    this.loading=true;
    try{
      const response=await this.call('get');
      this.info=response;this.settings=structuredClone(response.settings);this.zoneRoomDrafts={};
      clearTimeout(this.manualSessionTimer);
      const manualEnds=Object.values(response.manual_controls||{}).map(control=>control.session?.ends*1000).filter(end=>end>Date.now());
      if(manualEnds.length)this.manualSessionTimer=setTimeout(()=>this.load(),Math.max(1,Math.min(...manualEnds)-Date.now()+1000));
      await tpI18n.load(this.settings.language||'en');
      if(this.tab==='history')this.history=await this.call('history',{hours:this.historyHours});
      else if(this.tab==='overview'){try{this.statusHistory=await this.call('history',{hours:48});}catch(error){this.statusHistory=[];}}
      this.loaded=true;this.message='';this.render();
    }catch(e){this.message=e.message||String(e);this.messageLevel='error';this.saveConfirmation=false;this.render();}
    finally{this.loading=false;if(this.historyPeriodReload){this.historyPeriodReload=false;if(this.tab==='history')this.setHistoryPeriod(this.historyHours,this.historyPeriodFocus);}}
  }
  field(field,obj,prefix){
    const [key,label,type,min,max,step='any']=field;const value=pumpTemperatureFields.includes(key)?obj[key]??obj[key.slice(4)]:['air_use_fan_only','garage_use_fan_only'].includes(key)?obj[key]??true:obj[key];const name=`${prefix}.${key}`;
    let input;
    if(type==='bool')input=`<input type="checkbox" class="setting-toggle" role="switch" data-field="${name}" ${value?'checked':''}>`;
    else if(type==='notification'){
      const targets=this.info.notification_targets||[];
      const options=[...targets];if(value&&!options.includes(value))options.push(value);
      input=`<select data-field="${name}"><option value="">${escapeHTML(this.t('— Select / not used —'))}</option>${options.map(target=>`<option data-user-text value="${escapeHTML(target)}" ${target===value?'selected':''}>${escapeHTML(target.replace(/^notify\.mobile_app_/, '').replace(/^notify\./, '').replaceAll('_',' '))}${targets.includes(target)?'':` (${escapeHTML(this.t('Unavailable'))})`}</option>`).join('')}</select>`;
    }
    else if(key==='nordpool_entry'||key==='nordpool_area'){
      const entries=this.info.price_provider_options?.nordpool_entries||[];
      const entry=entries.find(item=>item.id===obj.nordpool_entry)||(entries.length===1?entries[0]:null);
      const options=key==='nordpool_entry'?entries.map(item=>({id:item.id,name:item.name})):(entry?.areas||[]).map(area=>({id:area,name:area}));
      input=`<select data-field="${name}"><option value="">${escapeHTML(this.t('Automatic'))}</option>${value&&!options.some(item=>item.id===value)?`<option selected value="${escapeHTML(value)}">${escapeHTML(value)}</option>`:''}${options.map(item=>`<option data-user-text value="${escapeHTML(item.id)}" ${item.id===value?'selected':''}>${escapeHTML(item.name)}</option>`).join('')}</select>`;
    }
    else if(key==='fireplace_active_state'){
      const sensor=this._hass?.states?.[obj.fireplace_entity];
      const options=fireplaceStateOptions(sensor,value);
      input=`<select data-field="${name}">${options.map(option=>`<option value="${escapeHTML(option.value)}" ${option.value===value?'selected':''}>${escapeHTML(option.label)}</option>`).join('')}</select><small class="fireplace-current-state" data-current-fireplace role="status">${escapeHTML(this.t('Current state:'))} ${escapeHTML(this.t(fireplaceCurrentState(sensor)))}</small>`;
    }
    else if(type==='fireplace_rooms'||type==='fireplace_links'){
      const isRoomList=type==='fireplace_rooms';
      const selected=value||[];
      const candidates=isRoomList
        ? this.settings.rooms.filter(room=>!room.is_garage&&room.name&&room.temperature_entity)
        : (this.settings.fireplaces||[]).filter(fireplace=>fireplace.name&&fireplace.fireplace_entity);
      const choices=candidates.slice().sort(compareRoomNames);
      const itemLabel=isRoomList?'Room':'Fireplace';
      input=`<span class="sensor-list" data-entity-list="${name}">${selected.map((id,index)=>{
        const options=choices.filter(candidate=>candidate.id===id||!selected.includes(candidate.id));
        return `<span class="sensor-list-row"><select data-entity-item data-fireplace-link aria-label="${escapeHTML(this.t(itemLabel))} ${index+1}">
          <option value="">— Select / not used —</option>
          ${options.map(option=>`<option data-user-text value="${escapeHTML(option.id)}" ${option.id===id?'selected':''}>${escapeHTML(option.name)}</option>`).join('')}
          </select><button type="button" data-remove-sensor="${index}" aria-label="${escapeHTML(this.t('Remove'))}">×</button></span>`;
      }).join('')}<button class="add-sensor" type="button" data-add-sensor ${selected.includes('')||choices.every(option=>selected.includes(option.id))?'disabled':''}>${isRoomList?'Add room':'Link fireplace'}</button></span>`;
    }
    else if(type==='room_links'){
      const selected=Array.isArray(value)?value:[];
      const rooms=this.settings.rooms.filter(room=>room.id!==obj.id&&this.sharedAirEligible(room)).slice().sort(compareRoomNames);
      const renderedSelection=escapeHTML(JSON.stringify(selected.filter(Boolean)));
      input=`<span class="sensor-list" data-entity-list="${name}" data-shared-air-selection="${renderedSelection}">${selected.map((id,index)=>`<span class="sensor-list-row"><select data-entity-item data-shared-air-member aria-label="${escapeHTML(this.t('Shared air space'))} ${index+1}" aria-describedby="help-${prefix}-${key}"><option value="">— Select / not used —</option>${rooms.map(room=>`<option data-user-text value="${escapeHTML(room.id)}" ${room.id===id?'selected':''} ${selected.some((other,i)=>i!==index&&other===room.id)?'disabled':''}>${escapeHTML(room.name)}</option>`).join('')}</select><button type="button" data-remove-sensor="${index}" aria-label="${escapeHTML(this.t('Remove room from shared air space'))}">×</button></span>`).join('')}<button type="button" class="add-sensor" data-add-sensor>Add room</button></span>`;
    }
    else if(type==='rooms'){
      this.zoneRoomDrafts??={};
      const selected=this.zoneRoomDrafts[obj.id]??this.settings.rooms.filter(room=>room.heating_zone_id===obj.id).map(room=>room.id);
      const rooms=this.settings.rooms.filter(room=>!room.is_garage&&room.name&&room.temperature_entity).slice().sort(compareRoomNames);
      input=`<span class="sensor-list" data-entity-list="${name}">${selected.map((id,index)=>`<span class="sensor-list-row"><select data-entity-item data-zone-member aria-label="${escapeHTML(this.t('Room'))} ${index+1}" aria-describedby="help-${prefix}-${key}"><option value="">— Select / not used —</option>${id&&!rooms.some(room=>room.id===id)?`<option selected value="${escapeHTML(id)}">Room unavailable</option>`:''}${rooms.map(room=>`<option data-user-text value="${escapeHTML(room.id)}" ${room.id===id?'selected':''} ${(selected.some((other,i)=>i!==index&&other===room.id)||(room.heating_zone_id&&room.heating_zone_id!==obj.id))?'disabled':''}>${escapeHTML(room.name)}</option>`).join('')}</select><button type="button" data-remove-sensor="${index}" aria-label="Remove room from zone">×</button></span>`).join('')}<button type="button" class="add-sensor" data-add-sensor>Add room</button></span>`;
    }
    else if(type.startsWith('entities:')){
      const domains=type.slice(9).split(',');
      const entities=Object.values(this._hass.states).filter(sensor=>domains.includes(sensor.entity_id.split('.')[0])).sort((a,b)=>entityLabel(a).localeCompare(entityLabel(b)));
      const selected=Array.isArray(value)?value:[];
      input=`<span class="sensor-list" data-entity-list="${name}">${selected.map((entity,index)=>`<span class="sensor-list-row"><select data-entity-item aria-label="${escapeHTML(label)} ${index+1}" aria-describedby="help-${prefix}-${key}"><option value="">— Select / not used —</option>${entity&&!entities.some(sensor=>sensor.entity_id===entity)?`<option data-user-text selected value="${escapeHTML(entity)}">${escapeHTML(entity)} (unavailable)</option>`:''}${entities.map(sensor=>`<option data-user-text value="${escapeHTML(sensor.entity_id)}" ${entity===sensor.entity_id?'selected':''} ${selected.some((other,i)=>i!==index&&other===sensor.entity_id)?'disabled':''}>${escapeHTML(entityLabel(sensor))}</option>`).join('')}</select><button type="button" data-remove-sensor="${index}" aria-label="Remove sensor">×</button></span>`).join('')}<button type="button" class="add-sensor" data-add-sensor>Add sensor</button></span>`;
    }
    else if(key==='language'){
      const language=Object.hasOwn(languageNames,value)?value:'en';
      input=`<span class="language-picker"><input type="hidden" data-field="${name}" value="${language}"><button type="button" class="language-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="language-options"><span>${languageFlag(language)}<span data-user-text>${languageNames[language]}</span></span><span aria-hidden="true">▾</span></button><span class="language-options" id="language-options" role="listbox" aria-label="Language" hidden>${Object.keys(languageNames).sort((a,b)=>languageNames[a].localeCompare(languageNames[b],'en',{sensitivity:'base'})).map(code=>`<button type="button" role="option" aria-selected="${code===language}" data-language="${code}" tabindex="-1">${languageFlag(code)}<span data-user-text>${languageNames[code]}</span></button>`).join('')}</span></span>`;
    }
    else if(pumpOptionKeys[key]){
      const devices=prefix==='source'?[...this.settings.rooms.filter(r=>!r.is_garage&&(r.heat_control==='air_to_air'||(r.heat_control==='house'&&this.settings.house_heat_source==='air_to_air'))).map(r=>r.thermostat),...(this.settings.heating_zones||[]).filter(z=>z.source_type!=='fireplace').map(z=>z.thermostat)]:[obj.thermostat];
      const lists=devices.filter(Boolean).map(id=>this._hass.states[id]?.attributes?.[pumpOptionKeys[key]]||[]);
      const options=lists.length?[...new Set(lists[0])].filter(v=>lists.every(list=>list.includes(v))):[];
      const emptyReason=!devices.some(Boolean)?'Select a heat pump in a room or zone first.':lists.some(list=>!list.length)?'The selected heat pump does not report options for this setting.':'The selected heat pumps have no common options for this setting.';
      input=`<select data-field="${name}" ${!options.length&&!value?'disabled':''}><option value="">Leave unchanged</option>${value&&!options.includes(value)?`<option selected value="${escapeHTML(value)}">${escapeHTML(value)} (unavailable)</option>`:''}${options.map(v=>`<option data-user-text value="${escapeHTML(v)}" ${v===value?'selected':''}>${escapeHTML(v)}</option>`).join('')}</select>${!options.length?`<small>${escapeHTML(this.t(emptyReason))}</small>`:''}`;
    }
    else if(key==='heating_zone_id'||key==='main_room_id'){
      const options=key==='heating_zone_id'?(this.settings.heating_zones||[]):this.settings.rooms.filter(r=>r.heating_zone_id===obj.id);
      input=`<select data-field="${name}"><option value="">— Select / not used —</option>${options.map(v=>`<option data-user-text value="${escapeHTML(v.id)}" ${v.id===value?'selected':''}>${escapeHTML(v.name||this.t('New room'))}</option>`).join('')}</select>`;
    }
    else if(type.startsWith('select:'))input=`<select data-field="${name}">${type.slice(7).split(',').map(v=>`<option ${v===value?'selected':''} value="${escapeHTML(v)}">${escapeHTML(key==='garage_heat_source'&&v==='house'?'Use house heating system':key==='language'?({'en':'🇬🇧 English','fi':'🇫🇮 Finnish'}[v]||v):['garage_heat_source','heating_priority','heat_control','garage_strategy','temperature_policy','air_zone_temperature','source_type','climate_mode','heating_strategy'].includes(key)?controlOptionLabels[v]||v:key==='transfer_tariff'?({included:'Already included / no addition',fixed:'Fixed transfer price',day_night:'Day/night transfer prices'}[v]):key==='pricing_mode'?schedulingLabels[v]||v:(key.startsWith('house_')||['garage_construction','garage_heat_source'].includes(key))?houseOptionLabels[v]||v:key==='solar_direction'&&v==='disabled'?'Solar heating off':['solar_direction','solar_exposure'].includes(key)?v.replaceAll('_',' ').replace(/^./,c=>c.toUpperCase()):v)}</option>`).join('')}</select>`;
    else if(type==='time')input=`<input type="time" step="60" data-field="${name}" value="${escapeHTML(value)}">`;
    else if(['solar_start_kw','solar_stop_kw'].includes(key)){
      const sliderMax=Math.max(20,Math.ceil(Number(value||0)/10)*10);
      input=`<span class="solar-threshold"><input type="range" min="${min}" max="${sliderMax}" step="${step}" value="${escapeHTML(value)}" data-solar-range="${name}" aria-label="${escapeHTML(this.t(label))}"><input type="number" min="${min}" max="${max}" step="${step}" data-field="${name}" value="${escapeHTML(value)}" aria-label="${escapeHTML(this.t(label))}"></span>`;
    }
    else if(type==='number')input=`<input type="number" step="${step}" min="${min}" max="${max}" data-field="${name}" value="${escapeHTML(value)}">`;
    else if(type==='text')input=`<input data-field="${name}" value="${escapeHTML(value)}">`;
    else{
      const domains=type.split(','),rule=field[3]||{};const entities=Object.values(this._hass.states).filter(s=>domains.includes(s.entity_id.split('.')[0])&&entityMatches(s,rule,obj)).sort((a,b)=>entityLabel(a).localeCompare(entityLabel(b)));
      const retained=value&&!(key==='price_entity'&&['static','nordpool','tibber'].includes(value))&&!entities.some(s=>s.entity_id===value)?`<option selected value="${escapeHTML(value)}">${escapeHTML(entityLabel(this._hass.states[value]))} (${this._hass.states[value]?'does not match filter':'unavailable'})</option>`:'';
      input=`<select data-field="${name}"><option value="" ${!value?'selected':''}>${key==='price_entity'?escapeHTML(this.t('Not configured')):'— Select / not used —'}</option>${key==='price_entity'?`<option value="static" ${value==='static'?'selected':''}>${escapeHTML(this.t('Static price'))}</option><option value="nordpool" ${value==='nordpool'?'selected':''}>Nord Pool (Home Assistant)</option><option value="tibber" ${value==='tibber'?'selected':''}>Tibber (Home Assistant)</option>`:''}${retained}${entities.map(s=>`<option data-user-text value="${escapeHTML(s.entity_id)}" ${s.entity_id===value?'selected':''}>${escapeHTML(entityLabel(s))}</option>`).join('')}</select>`;
    }
    if(sourceReadingKeys.includes(key))input+=`<small class="source-current-state" data-source-reading="${key}" role="status">${escapeHTML(this.t('Current state:'))} ${escapeHTML(this.t(sourceReading(key,value,this._hass?.states?.[value])))}</small>`;
    if(key==='fireplace_reduction')input=`<span class="number-unit">${input}<span>%</span></span>`;
    let helpText=settingHelp[type==='fireplace_rooms'?'fireplace_room_ids':prefix.startsWith('zone')&&key==='heating_enabled'?'zone_heating_enabled':key];
    if(key==='static_price'&&obj.transfer_tariff&&obj.transfer_tariff!=='included')helpText='Enter the price before transfer charges.';
    if(key==='transfer_day_start'||key==='transfer_night_start')helpText='Repeats daily in Home Assistant’s time zone.';
    if(prefix.startsWith('room')&&['thermostat','heat_control'].includes(key)){
      const zone=(this.settings.heating_zones||[]).find(zone=>zone.id===obj.heating_zone_id&&zone.source_type!=='fireplace'&&zone.thermostat===obj.thermostat);
      if(zone)helpText='This room uses its zone’s heat pump. The zone is the only pump controller; this room supplies a temperature reading. Configure pump operation under Zones.';
    }
    const helpId=`help-${prefix}-${key}`;
    const help=helpText?` <span class="setting-help"><button type="button" class="setting-info" aria-label="About ${escapeHTML(label)}" aria-describedby="${helpId}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle class="info-dot" cx="12" cy="7" r="1"/></svg></button><span id="${helpId}" class="setting-tooltip" role="tooltip">${escapeHTML(helpText)}</span></span>`:'';
    const tag=(type.startsWith('entities:')||type==='rooms'||type==='room_links'||type==='fireplace_rooms'||type==='fireplace_links')?'div':'label';
    return `<${tag} ${tag==='div'?'class="sensor-list-field"':''} ${key==='fireplace_active_state'?`data-fireplace-state ${obj.fireplace_entity?'':'hidden'}`:['simulation_enabled','apply_season_setpoints'].includes(key)?`data-electric-control ${electricHeating(this.settings)?'':'hidden'}`:key==='solar_exposure'?`data-solar-exposure ${(!obj.solar_direction||obj.solar_direction==='disabled')?'hidden':''}`:''}><span>${escapeHTML(label)}${help}</span>${input}</${tag}>`;
  }
  settingsGroups(groups){
    const fields=new Map(this.info.source_fields.map(field=>[field[0],field]));
    return groups.map(([title,keys])=>{
      const staticPrice=this.settings.price_entity==='static';
      const nativePrice=['nordpool','tibber'].includes(this.settings.price_entity);
      const available=keys.filter(key=>{
        if(pumpTemperatureFields.includes(key))return this.settings.air_use_fan_only===false;
        if(key==='heat_pump_cop_entity')return this.settings.house_heat_source==='air_to_water';
        if(this.settings.air_use_fan_only===false){
          if(key==='air_heat_target')return false;
          if(['air_fan_idle','air_swing_idle'].includes(key)){
            return (this.settings.heating_zones||[]).some(zone=>zone.source_type!=='fireplace'&&zone.heating_enabled&&['cool','both'].includes(zone.climate_mode));
          }
        }
        if(['away_zone','away_delay_hours'].includes(key)&&!this.settings.away_automatic)return false;
        if(['solar_start_kw','solar_stop_kw','solar_minimum_run_minutes'].includes(key)&&!this.settings.solar_power_entity)return false;
        if(key==='static_price')return staticPrice;
        if(key.startsWith('nordpool_'))return this.settings.price_entity==='nordpool';
        if(key==='tibber_price_entity')return this.settings.price_entity==='tibber';
        if(nativePrice&&key==='price_unit')return false;
        if(staticPrice&&['price_forecast_entity','price_unit'].includes(key))return false;
        if(key==='transfer_fixed_price')return this.settings.transfer_tariff==='fixed';
        if(['transfer_day_start','transfer_day_price','transfer_night_start','transfer_night_price'].includes(key))return this.settings.transfer_tariff==='day_night';
        return true;
      }).map(key=>fields.get(key)).filter(Boolean);
      let fieldMarkup=`<div class="grid">${available.map(field=>this.field(field,this.settings,'source')).join('')}</div>`;
      if(title==='Away heating and cooling'){
        const rows=[['away_automatic','away_zone','away_delay_hours'],['away_temperature','away_cooling_temperature']];
        fieldMarkup='<div class="away-settings-fields">'+rows.map(keys=>{
          const selected=keys.map(key=>available.find(field=>field[0]===key)).filter(Boolean);
          return `<div class="grid">${selected.map(field=>this.field(field,this.settings,'source')).join('')}</div>`;
        }).join('')+'</div>';
      }
      if(title==='Electricity price settings'){
        const row=keys=>{
          const selected=keys.map(key=>available.find(field=>field[0]===key)).filter(Boolean);
          return selected.length?`<div class="grid price-fields">${selected.map(field=>this.field(field,this.settings,'source')).join('')}</div>`:'';
        };
        // Explicit rows keep each transfer start time next to its rate.
        fieldMarkup=`<div class="price-settings-fields">
          ${row(['price_entity','static_price','price_unit'])}
          ${row(['nordpool_entry','nordpool_area'])}
          ${row(['nordpool_vat','nordpool_margin','tibber_price_entity'])}
          ${row(['price_forecast_entity'])}
          <div class="price-transfer-fields">
            ${row(['transfer_tariff','pricing_mode'])}
            ${row(['minimum_run_minutes'])}
            ${row(['transfer_fixed_price'])}
            ${row(['transfer_day_start','transfer_day_price'])}
            ${row(['transfer_night_start','transfer_night_price'])}
          </div>
        </div>`;
      }
      return available.length?`<div class="settings-group" data-setting-group="${keys[0]}" ${title==='Integration settings'?'data-integration-group':''} ${title==='Electricity price settings'?`data-electric-group ${electricHeating(this.settings)?'':'hidden'}`:title==='Air-to-air heat pump settings'?`data-air-group ${this.settings.rooms.some(r=>!r.is_garage&&r.heat_control==='air_to_air')||(this.settings.heating_zones||[]).some(z=>z.source_type!=='fireplace')||this.settings.house_heat_source==='air_to_air'?'':'hidden'}`:title==='Water heating'?`data-water-group ${waterDistribution(this.settings)?'':'hidden'}`:''}><h3>${escapeHTML(title)}</h3>${fieldMarkup}</div>`:'';
    }).join('');
  }
  sourceCheckView(){
    const report=this.sourceCheck;
    const date=value=>new Intl.DateTimeFormat(this.settings.language||'en',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
    const summary=(title,value)=>{
      if(!value)return '';
      const details=value.ok?`${value.unit}${value.kind?' · '+this.t({hourly:'Hourly',twice_daily:'Twice daily',daily:'Daily'}[value.kind]):' · '+value.interval_minutes.map(minutes=>new Intl.NumberFormat(this.settings.language||'en',{style:'unit',unit:'minute',unitDisplay:'short'}).format(minutes)).join(', ')}`:this.t(value.error);
      return `<div><h5>${escapeHTML(this.t(title))}</h5><p>${escapeHTML(value.ok?this.t('Available')+' · '+details:details)}</p>${value.ok?`<p>${escapeHTML(date(value.start))} – ${escapeHTML(date(value.end))}</p>`:''}</div>`;
    };
    return `<div class="source-checks"><h4>${escapeHTML(this.t('Source checks'))}</h4><button type="button" data-test-sources ${this.testingSources?'disabled':''}>${escapeHTML(this.t(this.testingSources?'Testing sources…':'Test sources'))}</button><div data-source-check-results role="status">${report?summary('Price sensor',report.prices)+summary('Weather forecast source',report.weather):''}${this.sourceCheckError?`<p>${escapeHTML(this.t(this.sourceCheckError))}</p>`:''}</div></div>`;
  }
  async testSources(){
    if(this.testingSources)return;
    this.capture();const draft=structuredClone(this.settings);
    this.testingSources=true;this.sourceCheck=null;this.sourceCheckError='';this.render();
    try{
      const report=await this.call('test_sources',{settings:draft});
      if(JSON.stringify(this.settings)===JSON.stringify(draft))this.sourceCheck=report;
    }catch(error){if(JSON.stringify(this.settings)===JSON.stringify(draft))this.sourceCheckError=error.message||String(error);}
    finally{this.testingSources=false;this.render();}
  }
  backupControls(){
    const help=(id,label,text)=>`<span class="setting-help"><button type="button" class="setting-info" aria-label="${escapeHTML(this.t(label))}" aria-describedby="${id}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle class="info-dot" cx="12" cy="7" r="1"/></svg></button><span id="${id}" class="setting-tooltip" role="tooltip">${escapeHTML(this.t(text))}</span></span>`;
    return `<div class="backup-controls"><h4>${escapeHTML(this.t('Backup and restore'))}</h4><div style="display:flex;flex-wrap:wrap;gap:16px"><span style="display:inline-flex;align-items:center"><button type="button" id="backup-export" ${this.backupBusy?'disabled':''}>${escapeHTML(this.t('Backup'))}</button>${help('backup-export-help','Backup','Export saved settings, learned models, all retained history, forecasts and season archives in one ZIP file. Unsaved edits are not included.')}</span><span style="display:inline-flex;align-items:center"><button type="button" id="backup-import" ${this.backupBusy?'disabled':''}>${escapeHTML(this.t('Restore'))}</button>${help('backup-import-help','Restore','Import replaces this integration’s settings and data and starts in simulation mode. Check entity references before enabling control. The file is not encrypted; keep it private.')}</span><input id="backup-file" type="file" accept=".zip,application/zip" hidden></div>${this.backupMessage?`<p role="status">${escapeHTML(this.t(this.backupMessage))}</p>`:'<span role="status"></span>'}</div>`;
  }
  async transferBackup(file=null){
    if(this.backupBusy)return;
    if(file&&!confirm(this.t('Replace all ThermalPilot settings, learning and history with this backup? Unsaved edits will be discarded. Control will remain in simulation mode.')))return;
    this.capture();this.backupBusy=true;this.backupMessage=file?'Importing backup…':'Preparing backup…';this.render();
    try{
      if(!this._hass?.fetchWithAuth)throw new Error(this.t('Backup is available in Home Assistant.'));
      const options=file?{method:'POST',headers:{'Content-Type':'application/zip','X-ThermalPilot-Confirm':'replace'},body:file}:{method:'GET'};
      const response=await this._hass.fetchWithAuth(`/api/thermal_pilot/backup/${encodeURIComponent(this.entry)}`,options);
      if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(result.error||response.statusText);}
      if(file){
        await response.json();await this.load();this.backupMessage='Backup imported. Simulation is enabled. Review settings and entity references before enabling control.';
      }else{
        const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
        link.href=url;link.download=`ThermalPilot-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
        this.backupMessage='Backup exported.';
      }
    }catch(error){this.backupMessage=this.t('Backup failed:')+' '+this.t(error.message||String(error));}
    finally{this.backupBusy=false;this.render();}
  }
  sharedAirEligible(room){
    return !room.is_garage&&room.heat_control!=='air_to_air'&&this.settings.house_heat_source!=='air_to_air';
  }
  updateSharedAirRooms(roomId,selected){
    const room=this.settings.rooms.find(candidate=>candidate.id===roomId);
    const eligible=new Set(this.settings.rooms.filter(member=>this.sharedAirEligible(member)).map(member=>member.id));
    const peers=new Set(selected.filter(id=>id!==roomId&&eligible.has(id)));
    if(!eligible.has(roomId))peers.clear();
    room.shared_air_rooms=[...peers].sort();
    // Change only pairs involving this room. A→B and B→C do not imply A→C;
    // removing A→C must preserve B→C and every unrelated connection.
    for(const member of this.settings.rooms){
      if(member.id===roomId)continue;
      const connections=new Set((member.shared_air_rooms||[]).filter(id=>id!==member.id&&eligible.has(id)));
      if(peers.has(member.id))connections.add(roomId);
      else connections.delete(roomId);
      member.shared_air_rooms=eligible.has(member.id)?[...connections].sort():[];
    }
  }
  roomSettingsFields(r,index){
    const electricFloor=!r.is_garage&&(r.heat_control||'house')==='house'&&this.settings.house_heat_source==='electric_resistance'&&this.settings.house_distribution==='electric_floor';
    const visible=this.info.room_fields.filter(field=>{
      const key=field[0];
      if(key==='heating_priority')return electricFloor;
      if(key==='assist_below_target')return electricFloor&&r.heating_priority==='heat_pump_preferred';
      if(key==='shared_air_rooms')return this.sharedAirEligible(r);
      if(key==='garage_strategy')return r.is_garage&&['air_to_water','ground_source','air_to_air','electric_resistance'].includes(garageSource(r,this.settings));
      if(key==='garage_door_warning_minutes')return r.is_garage&&!airRoom(r,this.settings)&&(r.garage_door_entities||[]).some(Boolean);
      if(key==='garage_use_fan_only')return r.is_garage&&airRoom(r,this.settings);
      if(r.garage_use_fan_only===false){
        if(key==='garage_heat_target')return false;
        if(['garage_fan_idle','garage_swing_idle'].includes(key)&&!(r.garage_door_entities||[]).some(Boolean))return false;
      }
      if(key==='garage_heat_target'||key in pumpOptionKeys||['garage_presence_entities','garage_door_delay'].includes(key))return r.is_garage&&airRoom(r,this.settings);
      if(key.startsWith('garage_'))return r.is_garage;
      if(['baseline','fireplace_reduction','away_exempt'].includes(key))return !r.is_garage;
      if(['heat_control','thermostat','activity_entity'].includes(key))return !r.is_garage||key==='thermostat'||(key==='activity_entity'&&!airRoom(r,this.settings));
      return key!=='heating_zone_id';
    });
    const render=fields=>fields.map(field=>this.field(field,r,`room${index}`)).join('');
    // These fields stay first even when garage-specific fields appear or disappear.
    const identity=visible.filter(field=>['name','is_garage'].includes(field[0]));
    const general=visible.filter(field=>!field[0].startsWith('garage_')&&!['name','is_garage'].includes(field[0]));
    const garage=visible.filter(field=>field[0].startsWith('garage_')).sort((a,b)=>Number(b[0]==='garage_heat_source')-Number(a[0]==='garage_heat_source'));
    return render(identity)+render(general)+(r.is_garage?`<div class="garage-settings-divider" role="separator" aria-label="${escapeHTML(this.t('Garage'))}"></div><h3 class="garage-settings-heading">Garage heating settings</h3>`+render(garage):'');
  }
  fireplaceSettings(){
    const fields=this.info.fireplace_fields||[];
    return `<section class="settings-fireplaces"><h2>Fireplaces</h2>
      ${(this.settings.fireplaces||[]).map((fireplace,index)=>{
        const prefix=`fireplace${index}`;
        return `<article class="room-card"><details data-settings-disclosure="${escapeHTML(fireplace.id)}">
          <summary><span data-user-text>${escapeHTML(fireplace.name||this.t('New fireplace'))}</span></summary>
          <div class="grid room-fields">${fields.map(field=>this.field(field,fireplace,prefix)).join('')}
          ${this.field(['room_ids','Rooms warmed by this fireplace','fireplace_rooms'],fireplace,prefix)}</div>
        </details><div class="room-actions"><button class="icon-button delete-room" type="button" data-remove-fireplace="${index}" title="Remove fireplace" aria-label="Remove fireplace"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button></div></article>`;
      }).join('')}
      <button id="add-fireplace" type="button">Add fireplace</button></section>`;
  }
  zoneFireplaceSettings(zone,index){
    if((zone.source_type||'air_to_air')!=='air_to_air'||!zone.thermostat||!(this.settings.fireplaces||[]).length)return '';
    const prefix=`zone${index}`;
    const links=this.field(['fireplace_ids','Linked fireplaces','fireplace_links'],zone,prefix);
    if(!zone.fireplace_ids?.some(Boolean)||!zone.heating_enabled)return links;
    const circulation=this.field(['fireplace_circulation','Circulate air while a fireplace is active','bool'],zone,prefix);
    if(!zone.fireplace_circulation)return links+circulation;
    return links+circulation
      +this.field(['fireplace_fan','Fireplace fan speed','text'],zone,prefix)
      +this.field(['fireplace_swing','Fireplace swing mode','text'],zone,prefix);
  }
  settingsView(page='all'){
    const i=this.info;
    // Sort the saved snapshot, not the draft. Editing a name or room type must
    // not move the card under the user's pointer. New cards follow in add order.
    const savedRooms=[...(i.settings?.rooms||this.settings.rooms)].sort((a,b)=>Number(Boolean(a.is_garage))-Number(Boolean(b.is_garage))||compareRoomNames(a,b));
    const savedOrder=new Map(savedRooms.map((room,index)=>[room.id,index]));
    const rooms=this.settings.rooms.map((room,index)=>({room,index})).sort((a,b)=>{
      const first=savedOrder.get(a.room.id)??savedOrder.size+a.index;
      const second=savedOrder.get(b.room.id)??savedOrder.size+b.index;
      return first-second;
    });
    const unsaved=this.hasUnsavedSettings();
    const [sourceGroups,operationGroups]=sourceSettingColumns;
    const html=`<form id="settings" data-settings-page="${page}"><section class="settings-sources"><h2>ThermalPilot settings</h2>
    <div class="settings-source-columns">
      <div class="settings-source-column">${this.settingsGroups(sourceGroups)}</div>
      <div class="settings-source-column">
        ${this.settingsGroups(operationGroups)}
        <div class="settings-group maintenance-settings" data-setting-group="maintenance">
          <h3>${escapeHTML(this.t('Maintenance'))}</h3>
          ${this.sourceCheckView()}
          ${this.backupControls()}
        </div>
      </div>
    </div>
    <div class="settings-pipework" aria-hidden="true">
      <svg viewBox="0 0 900 600" fill="none" focusable="false">
        <defs>
          <linearGradient id="tp-matrix-wall-fade" x2="0%" y2="100%">
            <stop stop-color="white" stop-opacity="0"/>
            <stop offset=".18" stop-color="white"/>
            <stop offset=".76" stop-color="white" stop-opacity=".65"/>
            <stop offset="1" stop-color="white" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="tp-matrix-floor-fade" x2="0%" y2="100%">
            <stop stop-color="white" stop-opacity=".1"/>
            <stop offset=".36" stop-color="white"/>
            <stop offset="1" stop-color="white" stop-opacity="0"/>
          </linearGradient>
          <mask id="tp-matrix-wall" maskUnits="userSpaceOnUse" x="0" y="0" width="900" height="455">
            <rect width="900" height="455" fill="url(#tp-matrix-wall-fade)"/>
          </mask>
          <mask id="tp-matrix-floor" maskUnits="userSpaceOnUse" x="0" y="430" width="900" height="170">
            <rect y="430" width="900" height="170" fill="url(#tp-matrix-floor-fade)"/>
          </mask>
          <g id="tp-matrix-stream" data-user-text="">
            <text>01001011</text>
            <text y="110" opacity=".5">10011010</text>
            <text y="224">01101001</text>
            <text y="345" opacity=".55">10100110</text>
          </g>
          <g id="tp-iso-tank">
            <path class="pipework-surface" d="M-52 0v143c0 16 23 29 52 29s52-13 52-29V0Z"/>
            <ellipse class="pipework-surface" rx="52" ry="29"/>
            <path d="M-45 33v104m29 30v8m32-8v8" opacity=".6"/>
            <ellipse cx="0" cy="-5" rx="12" ry="7"/>
            <path d="M-12-5v6c0 9 24 9 24 0v-6"/>
          </g>
          <g id="tp-iso-module">
            <!-- The top, front and end faces share the same two diagonal axes. -->
            <path class="pipework-surface" d="M-9 68 76 21l145 80-86 47Z"/>
            <path class="pipework-surface" d="M-9 68v6l144 80 86-47v-6m-86 47v6"/>
            <path class="pipework-surface" d="M0 0 76-42l134 74-76 42Z"/>
            <path class="pipework-surface" d="M0 0v67l134 74V74Z"/>
            <path class="pipework-surface" d="M134 74v67l76-42V32Z"/>
            <path d="M13 20 114 76q8 4 8 12v26q0 8-7 4L14 62q-7-4-7-12V25q0-8 6-5Z"/>
            <path d="M146 80v46m12-53v46m12-53v46m12-53v46m12-53v46m-52-30 62-34m-62 48 62-34"/>
            <path d="M30 4 81-24l115 63-51 28Z"/>
            <path d="m43-3 115 63M55-10l115 63M68-17l115 63M53 17l51-28m-28 40 51-28m-28 41 51-28m-28 41 51-28"/>
            <path class="pipework-accent" d="m43-3 115 63m-82-31 51-28m15 102 62-34"/>
            <ellipse class="pipework-surface" cx="34" cy="-22" rx="10" ry="5"/>
            <path class="pipework-surface" d="M28-45v21c0 5 12 5 12 0v-21Z"/>
          </g>
          <g id="tp-iso-coupling">
            <ellipse class="pipework-surface" rx="6" ry="14" transform="rotate(28)"/>
            <path d="M-7-2c-6 9-6 15-2 17m13-29c3 2 3 9-1 16" opacity=".62"/>
          </g>
          <path id="tp-iso-supply" d="M110 353l144 79q27 15 54 0l370-204"/>
          <path id="tp-iso-return" d="M123 389l100 55q16 9 32 5l478-263"/>
          <path id="tp-iso-upper-pipe" d="M161 140v-33q0-15 15-7l77 42q11 6 11 20v27"/>
        </defs>

        <!-- Static code rain and its perspective floor. -->
        <g class="pipework-code" mask="url(#tp-matrix-wall)">
          <use href="#tp-matrix-stream" x="76" y="38" opacity=".38"/>
          <use href="#tp-matrix-stream" x="98" y="20" opacity=".60"/>
          <use href="#tp-matrix-stream" x="121" y="72" opacity=".25"/>
          <use href="#tp-matrix-stream" x="145" y="17" opacity=".62"/>
          <use href="#tp-matrix-stream" x="177" y="56" opacity=".38"/>
          <use href="#tp-matrix-stream" x="204" y="26" opacity=".51"/>
          <use href="#tp-matrix-stream" x="238" y="62" opacity=".31"/>
          <use href="#tp-matrix-stream" x="258" y="37" opacity=".57"/>
          <use href="#tp-matrix-stream" x="295" y="69" opacity=".33"/>
          <use href="#tp-matrix-stream" x="320" y="15" opacity=".59"/>
          <use href="#tp-matrix-stream" x="353" y="47" opacity=".41"/>
          <use href="#tp-matrix-stream" x="386" y="11" opacity=".55"/>
          <use href="#tp-matrix-stream" x="421" y="63" opacity=".32"/>
          <use href="#tp-matrix-stream" x="451" y="25" opacity=".58"/>
          <use href="#tp-matrix-stream" x="483" y="48" opacity=".29"/>
          <use href="#tp-matrix-stream" x="509" y="19" opacity=".46"/>
          <use href="#tp-matrix-stream" x="539" y="55" opacity=".62"/>
          <use href="#tp-matrix-stream" x="576" y="22" opacity=".55"/>
          <use href="#tp-matrix-stream" x="605" y="59" opacity=".38"/>
          <use href="#tp-matrix-stream" x="636" y="45" opacity=".48"/>
          <use href="#tp-matrix-stream" x="668" y="14" opacity=".61"/>
          <use href="#tp-matrix-stream" x="692" y="53" opacity=".27"/>
          <use href="#tp-matrix-stream" x="729" y="18" opacity=".55"/>
          <use href="#tp-matrix-stream" x="755" y="57" opacity=".28"/>
          <use href="#tp-matrix-stream" x="778" y="29" opacity=".61"/>
          <use href="#tp-matrix-stream" x="807" y="51" opacity=".41"/>
          <use href="#tp-matrix-stream" x="832" y="29" opacity=".28"/>
        </g>
        <g class="pipework-code" mask="url(#tp-matrix-floor)" opacity=".50">
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 -.23 .36 116 443)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 -.19 .36 154 440)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 -.15 .36 193 434)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 -.11 .36 230 448)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 -.07 .36 269 438)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 -.03 .36 307 443)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 .02 .36 350 439)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 .06 .36 394 443)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 .10 .36 440 436)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 .14 .36 488 444)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 .18 .36 537 437)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 .22 .36 586 444)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 .26 .36 636 440)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 .30 .36 681 435)"/>
          <use href="#tp-matrix-stream" transform="matrix(1.3 0 .34 .36 732 444)"/>
        </g>

        <g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <!-- A few platform edges suggest the room without enclosing the image. -->
          <path class="pipework-faint" d="M43 373 344 207l488 269-179 99M89 432l208 115m313 9 23 13M625 108l65-36 112 62"/>
          <path class="pipework-faint" d="M109 280q-35 27 4 49l109 60q34 19 68 0l58-32q32-18 9-37"/>
          <path class="pipework-accent" d="M105 288q-30 21 8 43l109 60q34 19 68 0l58-32q24-13 22-25"/>

          <!-- Buffer vessels and their raised interconnection. -->
          <use href="#tp-iso-tank" transform="translate(161 151)"/>
          <use href="#tp-iso-tank" transform="translate(264 206)"/>
          <use class="pipework-tube" href="#tp-iso-upper-pipe" stroke-width="11"/>
          <use class="pipework-interior" href="#tp-iso-upper-pipe" stroke-width="8"/>
          <path d="M196 106q-6 4-6 10m8-8q-6 4-6 10m55 20q-6 4-6 10m8-8q-6 4-6 10"/>

          <!-- High-mounted heat exchanger and pump controls. -->
          <path class="pipework-surface" d="M355 78q20-26 40-15l104 57q16 9 1 34-15 24-32 15l-104-57q-22-12-9-34Z"/>
          <ellipse class="pipework-surface" cx="484" cy="145" rx="18" ry="28" transform="rotate(30 484 145)"/>
          <ellipse class="pipework-accent" cx="488" cy="147" rx="11" ry="19" transform="rotate(30 488 147)"/>
          <path d="M395 130q-14-8 1-33 9-14 19-16m10 66q-14-8 1-33 9-14 19-16m9 65q-14-8 1-33 9-14 19-16"/>
          <path d="M368 117v11q0 10 11 16l119 66q13 7 28-1l52-29"/>
          <path class="pipework-accent" d="M370 129q0 6 9 11l119 66q13 7 28-1l52-29M505 152l29 16 42-23"/>
          <path class="pipework-surface" d="M553 100l44-24 48 26-44 24Zm0 0v95l48 26v-95m0 95 44-24v-95"/>
          <path d="m610 136 27-15v28l-27 15Zm0 43 27-15v12l-27 15Z"/>
          <path class="pipework-accent" d="m616 139 15-8m-15 13 15-8m-15 13 15-8m-15 39 5-3m4-2 5-3"/>

          <!-- Electrical cabinet and its cable conduit. -->
          <path class="pipework-surface" d="m664 200 56-31 107 59-56 31Z"/>
          <path class="pipework-surface" d="M664 200v83l107 59v-83Z"/>
          <path class="pipework-surface" d="M771 259v83l56-31v-83Z"/>
          <path d="m676 221 29 16v17l-29-16Zm0 27 29 16v17l-29-16Zm107 19 33-18v23l-33 18Zm0 30 33-18v21l-33 18Z"/>
          <path class="pipework-accent" d="m682 229 17 9m-17 18 17 9m91 6 18-10m-18 40 18-10m-91-24 32 18"/>
          <path d="m645 191 8-4q5-3 11 0l16 9m-35 1 8-4q5-3 11 0l11 6"/>

          <!-- Three circulation modules and the supply and return pipes. -->
          <use href="#tp-iso-module" transform="translate(455 300)"/>
          <use href="#tp-iso-module" transform="translate(351 357)"/>
          <use href="#tp-iso-module" transform="translate(247 414)"/>
          <path class="pipework-surface" d="M57 316v103c0 7 12 14 27 14s27-7 27-14V316Z"/>
          <ellipse class="pipework-surface" cx="84" cy="316" rx="27" ry="15"/>
          <path d="M57 349c0 7 12 14 27 14s27-7 27-14m-54 34c0 7 12 14 27 14s27-7 27-14m-31-74v-13h8v13"/>
          <use class="pipework-tube" href="#tp-iso-return" stroke-width="8"/>
          <use class="pipework-interior" href="#tp-iso-return" stroke-width="5"/>
          <use class="pipework-accent" href="#tp-iso-return" stroke-width="2"/>
          <use class="pipework-tube" href="#tp-iso-supply" stroke-width="14"/>
          <use class="pipework-interior" href="#tp-iso-supply" stroke-width="11"/>
          <use class="pipework-accent" href="#tp-iso-supply" stroke-width="2"/>
          <use href="#tp-iso-coupling" transform="translate(173 388) rotate(-57)"/>
          <use href="#tp-iso-coupling" transform="translate(320 426)"/>
          <use href="#tp-iso-coupling" transform="translate(425 369)"/>
          <use href="#tp-iso-coupling" transform="translate(530 310)"/>
          <use href="#tp-iso-coupling" transform="translate(628 256)"/>
          <path class="pipework-accent" d="m346 410-3-21q-1-9-10-13l-12-6m128-18-3-21q-1-9-10-13l-12-6m130-18-3-21q-1-9-10-13l-12-6"/>
          <path d="M281 392v32m104-89v31m104-88v31"/>
        </g>
      </svg>
    </div></section>
    <section class="settings-house"><h2>House heating settings</h2><p>Choose your heating system and house details. Heat distribution determines which sensor inputs are needed.</p>${this.settingsGroups([['House and heating',['house_construction','house_heat_source','heat_pump_cop_entity','house_distribution','house_heated_floor','house_foundation']],['Water heating',['water_entity','start_offset_minutes','stop_offset_minutes']],['Heating response',['lag_hours','curve_warm_temp','curve_cold_temp']]])}${statusNotice('Electric heating benefits mainly from changing electricity tariffs. Other heat sources use observation only: no schedules, no thermostat control and no required price sensor.','info')}</section>
    <section class="settings-shared"><h2>Shared room and zone settings</h2><p>Shared settings apply to ordinary rooms and zones. Garages use their own room settings.</p>${this.settingsGroups(sharedSettingGroups)}</section>
    <div class="settings-zone-column">
    <section class="settings-zones"><h2>Zones</h2><p>${escapeHTML(this.t("Zones share one heating or cooling source across rooms. Separate room heaters stay independent; rooms using the zone’s pump are controlled by the zone."))}</p>${(this.settings.heating_zones||[]).map((z,index)=>`<article class="room-card"><details data-settings-disclosure="${escapeHTML(z.id)}"><summary><span data-user-text>${escapeHTML(z.name||this.t('New zone'))}</span></summary><div class="grid room-fields">${(i.zone_fields||[]).filter(f=>!['source_type','fireplace_entity','fireplace_active_state','main_room_id','heating_enabled','climate_mode','heating_strategy','cooling_target'].includes(f[0])&&(!['thermostat','temperature_policy'].includes(f[0])||z.source_type!=='fireplace')).map(f=>this.field(f,z,`zone${index}`)).join('')}${this.field(['zone_rooms','Rooms','rooms'],z,`zone${index}`)}${z.source_type!=='fireplace'?(i.zone_fields||[]).filter(f=>f[0]==='main_room_id').map(f=>this.field(f,z,`zone${index}`)).join(''):''}${z.source_type!=='fireplace'?(i.zone_fields||[]).filter(f=>['heating_enabled','climate_mode','heating_strategy','cooling_target'].includes(f[0])&&(f[0]!=='heating_strategy'||z.climate_mode!=='cool')&&(f[0]!=='cooling_target'||['cool','both'].includes(z.climate_mode))).map(f=>this.field(f,z,`zone${index}`)).join(''):''}${this.zoneFireplaceSettings(z,index)}${this.settings.rooms.some(room=>room.heating_zone_id===z.id)?'':'<p class="zone-empty-note">No rooms linked. Zone control is inactive.</p>'}</div></details><div class="room-actions">${z.source_type!=='fireplace'?`<button type="button" class="icon-button" data-reset="zone:${escapeHTML(z.id)}" title="${escapeHTML(this.t('Reset learning'))}" aria-label="${escapeHTML(this.t('Reset learning')+': '+z.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/></svg></button>`:''}<button type="button" class="icon-button delete-room" data-remove-zone="${index}" title="Remove zone" aria-label="Remove zone"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button></div></article>`).join('')}<button type="button" id="add-zone">Add zone</button></section>
    ${this.fireplaceSettings()}
    </div>
    <section class="settings-rooms"><h2>Rooms</h2><p>Room response is learned from observed heating and cooling, starting with internal estimates.</p>
    <div class="room-cards">${rooms.map(({room:r,index})=>`<article class="room-card${r.is_garage?' garage-room-card':''}"><div class="room-actions"><button type="button" class="icon-button" data-reset="${escapeHTML(r.id)}" title="Reset learning for this room" aria-label="Reset learning for this room"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/></svg></button><button type="button" class="icon-button delete-room" data-remove="${index}" title="Remove room" aria-label="Remove room"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button></div><details data-settings-disclosure="${escapeHTML(r.id)}"><summary><span data-user-text>${escapeHTML(r.name||this.t('New room'))}</span> <span class="room-target">${escapeHTML(r.is_garage?`${r.garage_minimum}–${r.garage_maximum}`:r.baseline??'—')} °C</span></summary><div class="grid room-fields">${this.roomSettingsFields(r,index)}</div></details></article>`).join('')}</div>
    <button type="button" id="add">Add room</button></section><div class="sticky"><span id="settings-unsaved" class="unsaved-notice" role="status" ${unsaved?'':'hidden'}>Unsaved changes</span><span>${this.settings.simulation_enabled===false?'Live control · check for conflicting thermostat automations':this.settings.apply_season_setpoints?'Season transitions change real thermostat setpoints':'Simulation only · scheduled targets are not applied'}</span>
    <div class="settings-save-actions"><button id="settings-cancel" type="button" ${unsaved?'':'hidden'}>Cancel</button><button class="primary" type="submit">Save settings</button></div>
    </div></form>`;
    if(page==='settings')return html.replace(/<section class="settings-(?:house|shared|zones|rooms|fireplaces)">[\s\S]*?<\/section>/g,'')
      .replace(/<div class="settings-zone-column">\s*<\/div>/,'');
    if(page==='rooms')return html.replace(/<section class="settings-sources">[\s\S]*?<\/section>/g,'');
    return html;
  }
  chart(rows,key,alternate,alternateLabel='Saved forecast',options={}){
    const timestamp=r=>Number(r.time??Date.parse(r.end)/1000);
    const data=rows.filter(r=>Number.isFinite(timestamp(r))).slice().sort((a,b)=>timestamp(a)-timestamp(b));
    const numeric=value=>value!=null&&Number.isFinite(Number(value));
    const keys=alternate?[key,alternate]:[key];
    const future=(options.future||[]).filter(point=>Number.isFinite(point.time)&&numeric(point.temperature));
    const values=[...data.flatMap(r=>keys.filter(k=>numeric(r[k])).map(k=>Number(r[k]))),...future.map(point=>Number(point.temperature))];
    if((!data.length&&!future.length)||!values.length)return '<p>No observation history yet.</p>';
    const low=Math.floor((Math.min(...values)-.1)*10)/10,high=Math.ceil((Math.max(...values)+.1)*10)/10;
    const times=[...data.map(timestamp),...future.map(point=>point.time)];
    const first=options.rangeStart??Math.floor(Math.min(...times)/900)*900,last=Math.max(first+900,options.rangeEnd??Math.ceil(Math.max(...times)/900)*900),span=last-first;
    const evenHours=[];
    if(options.twoHourTicks){
      const tick=new Date(first*1000);tick.setHours(Math.floor(tick.getHours()/2)*2,0,0,0);
      if(tick.getTime()/1000<first)tick.setHours(tick.getHours()+2);
      while(tick.getTime()/1000<=last){evenHours.push(tick.getTime()/1000);tick.setHours(tick.getHours()+2);}
    }
    // Quarter-hour ticks for short periods; longer views use aligned multiples to keep labels readable.
    const baseWidth=(this.clientWidth||0)>0&&this.clientWidth<700?Math.max(240,this.clientWidth-128):800;
    const chartWidth=baseWidth;
    const left=chartWidth<600?56:70,right=chartWidth-20;
    const tickCount=chartWidth<600?Math.max(2,Math.floor((right-left)/70)):12;
    const tickSeconds=Math.max(900,Math.ceil(span/(tickCount*900))*900);
    const x=time=>left+(right-left)*(time-first)/span,y=value=>155-125*(value-low)/Math.max(.1,high-low);
    const points=k=>data.filter(r=>numeric(r[k])).map(r=>`${x(timestamp(r))},${y(Number(r[k]))}`).join(' ');
    const grid=[low,(low+high)/2,high].map(value=>`<line x1="${left}" y1="${y(value)}" x2="${right}" y2="${y(value)}" stroke="currentColor" opacity=".15"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end">${value.toFixed(1)} °C</text>`).join('');
    const ticks=[];
    const tickTimes=options.twoHourTicks?evenHours:Array.from({length:Math.floor(span/tickSeconds)+1},(_,index)=>first+index*tickSeconds);
    const labelStride=options.twoHourTicks?Math.max(1,Math.ceil(evenHours.length/Math.max(2,Math.floor((right-left)/52)))):1;
    for(const [index,time] of tickTimes.entries()){const label=new Date(time*1000).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});ticks.push(`<line data-temperature-time-tick="${time}" x1="${x(time)}" y1="30" x2="${x(time)}" y2="160" stroke="currentColor" opacity=".1"/>${index%labelStride===0?`<text x="${x(time)}" y="180" text-anchor="middle">${escapeHTML(label)}</text>`:''}`);}
    const now=Date.now()/1000;
    const futureLine=future.length?`<polyline data-current-plan-forecast points="${future.map(point=>`${x(point.time)},${y(Number(point.temperature))}`).join(' ')}" fill="none" stroke="#e49025" stroke-width="2.5"/>`:'';
    const nowLine=future.length&&now>=first&&now<=last?`<line data-temperature-now x1="${x(now)}" x2="${x(now)}" y1="30" y2="160" stroke="#526b75" stroke-dasharray="4 4"/><text x="${x(now)}" y="20" text-anchor="middle">${escapeHTML(this.t('Now'))}</text>`:'';
    const label=alternate?'Measured temperature':'Predicted temperature under the suggested plan';
    return `<div class="chart-legend"><span><i style="background:#1976d2"></i>${label}</span>${alternate?`<span><i style="background:repeating-linear-gradient(to right,#e49025 0 6px,transparent 6px 10px)"></i>${escapeHTML(alternateLabel)}</span>`:''}${future.length?`<span><i style="background:#e49025"></i>${escapeHTML(this.t('Current plan forecast'))}</span>`:''}</div><div class="temperature-chart"><svg viewBox="0 0 ${chartWidth} 195"${options.fillWidth?' data-responsive-temperature style="width:100%;min-width:0;height:195px"':''} role="img" aria-label="${label}${alternate?' and '+escapeHTML(alternateLabel):''}">${grid}${ticks.join('')}${nowLine}<polyline points="${points(key)}" fill="none" stroke="#1976d2" stroke-width="3"/>${alternate?`<polyline points="${points(alternate)}" fill="none" stroke="#e49025" stroke-width="2" stroke-dasharray="6 4"/>`:''}${futureLine}</svg></div><small>${escapeHTML(timeLabel(first*1000))} – ${escapeHTML(timeLabel(last*1000))}</small>`;
  }
  bindResponsiveTemperatureCharts() {
    this.temperatureResizeObserver?.disconnect();
    const charts = new Map();
    this.shadowRoot.querySelectorAll('svg[data-responsive-temperature]').forEach(svg => {
      const originalWidth = Number(svg.getAttribute('viewBox').split(' ')[2]);
      const left = originalWidth < 600 ? 56 : 70;
      const originalRight = originalWidth - 20;
      // Always resize from original coordinates to avoid drift after repeated resizes.
      const coordinates = Array.from(svg.querySelectorAll('[x],[x1],[x2],polyline')).map(node => {
        const attributes = ['x', 'x1', 'x2']
          .filter(name => node.hasAttribute(name))
          .map(name => [name, Number(node.getAttribute(name))]);
        let points = null;
        if (node.hasAttribute('points')) {
          points = node.getAttribute('points').trim().split(/\s+/)
            .filter(Boolean).map(point => point.split(',').map(Number));
        }
        return {node, attributes, points};
      });
      const resize = () => {
        const width = svg.getBoundingClientRect().width;
        if (!width || svg.isConnected === false) return;
        const right = Math.max(left + 1, width - 20);
        const mapX = x => left + (x - left) * (right - left) / (originalRight - left);
        svg.setAttribute('viewBox', `0 0 ${width} 195`);
        for (const {node, attributes, points} of coordinates) {
          for (const [name, value] of attributes) {
            node.setAttribute(name, String(mapX(value)));
          }
          if (points) {
            node.setAttribute('points', points.map(([x, y]) => `${mapX(x)},${y}`).join(' '));
          }
        }
      };
      charts.set(svg, resize);
      resize();
      svg.closest?.('[data-room-accordion]')?.addEventListener('toggle', resize);
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.temperatureResizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) charts.get(entry.target)?.();
      });
      for (const svg of charts.keys()) this.temperatureResizeObserver.observe(svg);
    }
  }

  currentPlanForecast(roomId, hours) {
    if (![1, 3, 6].includes(Number(hours))) return [];
    const room = this.info?.data?.rooms?.[roomId];
    const slots = room?.plan?.slots || [];
    const validTemperature = value => value !== null && value !== undefined
      && value !== '' && Number.isFinite(Number(value));
    if (!validTemperature(room?.temperature) || !slots.length) return [];

    const rows = slots.map(slot => ({
      start: Date.parse(slot.start) / 1000,
      end: Date.parse(slot.end) / 1000,
      temperature: slot.temperature,
    })).filter(slot => Number.isFinite(slot.start) && Number.isFinite(slot.end)
      && slot.end > slot.start).sort((a, b) => a.start - b.start);
    if (!rows.length) return [];

    const now = Date.now() / 1000;
    const points = [{time: rows[0].start, temperature: Number(room.temperature)}];
    // A missing temperature or gap ends the usable forecast; do not bridge unknown data.
    for (const slot of rows) {
      if (!validTemperature(slot.temperature) || Math.abs(slot.start - points.at(-1).time) > 1) break;
      points.push({time: slot.end, temperature: Number(slot.temperature)});
    }
    const end = Math.min(now + hours * 3600, points.at(-1).time);
    if (points[0].time > now || end <= now) return [];

    const interpolate = time => {
      const rightIndex = points.findIndex(point => point.time >= time);
      if (rightIndex === 0) return points[0].temperature;
      const before = points[rightIndex - 1];
      const after = points[rightIndex];
      const fraction = (time - before.time) / (after.time - before.time);
      return before.temperature + (after.temperature - before.temperature) * fraction;
    };
    return [
      {time: now, temperature: interpolate(now)},
      ...points.filter(point => point.time > now && point.time < end),
      {time: end, temperature: interpolate(end)},
    ];
  }
  forecastHistoryView(rows,roomId=rows[0]?.room_id){
    const hours=this.forecastHours||3,now=Date.now()/1000,start=now-24*3600;
    rows=rows.filter(row=>Number(row.time)>=start&&Number(row.time)<=now);
    const future=this.currentPlanForecast(roomId,hours);
    const cards=[1,3,6].map(h=>{
      const details=rows.map(r=>r[`forecast_${h}h_details`]).filter(Boolean);
      const count=details.length,mean=key=>count?(details.reduce((sum,d)=>sum+d[key],0)/count).toFixed(2)+' °C':'—';
      return `<div class="forecast-metric" title="${escapeHTML(this.t(h+'-hour forecast'))}"><span class="forecast-metric-label">${h} h</span><b class="forecast-metric-value">${mean('error')}</b></div>`;
    }).join('');
    const count=rows.filter(r=>r[`forecast_${hours}h_details`]).length;
    return `<h3 class="forecast-heading">${escapeHTML(this.t('Forecast accuracy'))}<span class="setting-help"><button type="button" class="setting-info" aria-label="${escapeHTML(this.t('Forecast accuracy'))}" aria-describedby="forecast-help-${escapeHTML(roomId||'room')}">${tooltipInfoIcon}</button><span id="forecast-help-${escapeHTML(roomId||'room')}" class="setting-tooltip" role="tooltip">${escapeHTML(this.t('These forecasts were saved 1, 3 or 6 hours before the measurements. Later readings do not change them. Lower error is better.'))}</span></span></h3><div class="forecast-toolbar"><div class="forecast-metrics"><span class="forecast-metrics-title">Mean error:</span>${cards}</div><label class="forecast-selection">Chart forecast<select data-forecast-hours>${[1,3,6].map(h=>`<option value="${h}" ${hours===h?'selected':''}>${h} ${h===1?'hour':'hours'} ahead</option>`).join('')}</select></label></div>${!count?`<p class="notice notice-info" role="status">${statusIcon('info')}<span class="notice-text">No completed ${hours}-hour forecasts in this period yet. New forecasts start being recorded after updating; previous short-term predictions cannot be converted into these comparisons.</span></p>`:''}${this.chart(rows,'temperature',`forecast_${hours}h`,`Saved ${hours}-hour forecast`,{twoHourTicks:true,fillWidth:true,future,rangeStart:start,rangeEnd:future.at(-1)?.time??now})}`;
  }
  roomDisclosureOpen(id){return this.roomDisclosureState.get(`${this.tab}:${id}`)===true;}
  learningPercent(room){
    const model=room?.model||{},progress=room?.learning_progress||{};
    return Math.max(0,Math.min(100,progress.percent??100*(Math.min(12,model.heated_hours??0)+Math.min(12,model.idle_hours??0))/24));
  }
  roomHeatingBadge(room,id){
    const configured=this.settings?.rooms?.find(r=>r.id===id);
    const state=this._hass?.states?.[configured?.activity_entity||configured?.thermostat];
    let actual=room?.actual_activity;
    if(state){
      if(['unknown','unavailable'].includes(state.state))actual=null;
      else if(configured.activity_entity)actual=state.state==='on'?1:state.state==='off'?0:null;
      else if(state.attributes?.hvac_action!=null)actual=state.attributes.hvac_action==='heating'?1:['idle','off'].includes(state.attributes.hvac_action)?0:null;
    }
    const status=actual===1?'actual':actual===0?'idle':'unknown';
    const label=actual===1?'Actual heating: On':actual===0?'Actual heating: Off':'Actual heating: Unknown';
    // Read the thermostat independently of the relay, and never substitute the
    // proposed plan's setpoint for the actual device setting (especially in simulation).
    const thermostat=this._hass?.states?.[configured?.thermostat];
    const unavailable=thermostat&&['unknown','unavailable'].includes(thermostat.state);
    const target=thermostat?thermostat.attributes?.temperature:this.info?.data?.chart_temperatures?.targets?.rooms?.[id];
    const validTarget=!unavailable&&target!==null&&target!==undefined&&target!==''&&Number.isFinite(Number(target));
    const unit=thermostat?.attributes?.temperature_unit||this._hass?.config?.unit_system?.temperature||'°C';
    const targetValue=validTarget?`${new Intl.NumberFormat(this.settings?.language||'en',{maximumFractionDigits:2}).format(Number(target))} ${unit}`:this.t('Unavailable');
    const targetDetail=`${this.t('Current thermostat target')}: ${targetValue}`;
    const solar=room?.solar_heating;
    const solarDetail=solar?`\n${this.t('Solar heating session')} · ${this.t('Minimum solar heating until')}: ${new Intl.DateTimeFormat(this.settings?.language||'en',{hour:'2-digit',minute:'2-digit'}).format(solar.minimum_until*1000)}`:'';
    const assistance=room?.heating_assistance;
    let assistanceDetail='';
    if(assistance){
      assistanceDetail=`\n${this.t(assistance.reason)}`;
      if(assistance.predicted_temperature!=null)assistanceDetail+=`\n${this.t('Predicted temperature after floor response lag')}: ${new Intl.NumberFormat(this.settings?.language||'en',{maximumFractionDigits:1}).format(assistance.predicted_temperature)} °C`;
    }
    const detail=`${this.t(`${label}. Current relay or thermostat demand; On does not guarantee water flow.`)}\n${targetDetail}${solarDetail}${assistanceDetail}`;
    const icon=status==='unknown'?'<span aria-hidden="true">?</span>':HEATING_FLAME;
    return `<span class="room-heating ${status}" role="img" aria-label="${escapeHTML(this.t(label)+'. '+targetDetail)}" title="${escapeHTML(detail)}" tabindex="0">${icon}</span>`;
  }
  learningBadge(room){
    const percent=this.learningPercent(room);
    if(percent>=100){
      if(!electricHeating(this.settings))return '';
      const stat=room?.forecast_accuracy?.['3'],fi=this.settings?.language==='fi';
      const value=number=>Number.isFinite(number)?number.toLocaleString(fi?'fi-FI':'en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})+' °C':'—';
      const valid=stat?.count>0&&Number.isFinite(stat.mae);
      const rating=forecastRating(stat);
      const names=['Bad','Poor','Okay','Good','Very good'];
      const assessment=rating.level!=null?this.t(names[rating.level]):this.t('Forecast learning');
      const label=valid?this.helpText('Forecast: {assessment} · {error}',{assessment,error:value(stat.mae)}):this.t('Forecast data pending');
      const detail=valid?this.helpText("Average absolute difference of saved 3-hour forecasts from measurements over the last 7 days: {error}; {count} comparisons. No-change benchmark: {benchmark}. Similar heating: {similar} ({similarCount} comparisons). Actual heating can differ from the plan. This is not a live-control readiness guarantee.",{error:value(stat.mae),count:stat.count,benchmark:value(stat.persistence_mae),similar:value(stat.similar_heating_mae),similarCount:stat.similar_heating_count||0}):this.t("Initial collection is complete. Waiting for saved 3-hour forecasts that can be compared with actual measurements. Learning continues.");
      const explanation=this.t("The number is average forecast deviation from measured temperature, not an integration fault. Ratings are practical guidance. Color requires at least 20 comparisons. Green also requires beating the no-change benchmark.");
      const caveat=rating.reason==='benchmark'?this.t("Assuming no temperature change performed equally well or better, so the rating is not green."):rating.reason==='missing_benchmark'?this.t("The benchmark is unavailable, so the rating is not green."):'';
      return `<span class="status-pill ${rating.level!=null?'quality-'+rating.level:valid?'mode':'neutral'} room-forecast-badge" tabindex="0" title="${escapeHTML(this.t(detail)+' '+this.t(explanation)+(caveat?' '+caveat:''))}">${escapeHTML(this.t(label))}${tooltipInfoIcon}</span>`;
    }
    return `<span class="room-learning" tabindex="0" title="Initial observation progress: 12 heating hours and 12 idle hours. This is not a reliability rating." aria-label="Initial data collection ${percent.toFixed(0)} percent">${percent.toFixed(0)}% initial data${tooltipInfoIcon}</span>`;
  }
  learningView(room){
    const model=room.model||{},progress=room.learning_progress||{};
    const heating=progress.heating_hours??model.heated_hours??0,idle=progress.idle_hours??model.idle_hours??0;
    const percent=Math.max(0,Math.min(100,progress.percent??100*(Math.min(12,heating)+Math.min(12,idle))/24));
    const complete=progress.initial_complete??(heating>=12&&idle>=12);
    if(complete)return '';
    const days=progress.estimated_days_to_initial;
    const completion=progress.estimated_initial_completion||(days!=null&&!complete?new Date(Date.now()+days*86400000).toISOString():null);
    const completionDate=completion?new Date(completion):null;
    const dateText=completionDate&&!Number.isNaN(completionDate.getTime())?dateLabel(completionDate):null;
    const estimate=complete?'Initial observation thresholds reached.':days!=null?`About ${days<1?'less than 1':Math.ceil(days)} more ${days<=1?'day':'days'} to the initial thresholds at recent observation rates.`:(progress.rate_history_hours??0)<24?'Time estimate available after at least 24 hours of rate tracking.':'Waiting for enough heating and idle observations to estimate the remaining time.';
    return `<div class="learning-card"><div class="learning-heading"><strong>Initial data collection</strong><span>${percent.toFixed(0)}%</span></div><progress max="100" value="${percent}" aria-label="Initial learning observation progress">${percent.toFixed(0)}%</progress><div class="learning-counts"><span>Heating <strong>${Number(heating).toFixed(1)} / 12 h</strong></span><span>Idle <strong>${Number(idle).toFixed(1)} / 12 h</strong></span></div><p>${escapeHTML(estimate)}</p>${dateText?`<p class="learning-date">Estimated initial-data completion: <strong>${escapeHTML(dateText)}</strong></p>`:''}<small>${escapeHTML(room.learning_note||'')} · ${model.samples||0} accepted observations. This measures initial data collection, not model trustworthiness. Continue validating forecasts and heating suggestions before enabling live control. Learning continues after initial data collection.</small></div>`;
  }
  weatherTimeline({rows,start,end,left,width,now,detailAttributes}){
    if(!rows.length)return {height:0,svg:''};
    const x=time=>left+(time-start)/(end-start)*width;
    const minimumSpacing=56,compact=left<100,rowOffset=compact?20:0;
    let lastX=-Infinity,items='';
    const labels={'clear-night':'Clear night',cloudy:'Cloudy',exceptional:'Exceptional weather',fog:'Fog',hail:'Hail',lightning:'Lightning','lightning-rainy':'Lightning and rain',partlycloudy:'Partly cloudy',pouring:'Heavy rain',rainy:'Rainy',snowy:'Snowy','snowy-rainy':'Snow and rain',sunny:'Sunny',windy:'Windy','windy-variant':'Windy and cloudy'};
    for(const row of rows){
      const position=x(row.time);
      if(position-lastX<minimumSpacing)continue;
      lastX=position;
      const label=this.t(labels[row.condition]||'Weather condition unavailable');
      const temperature=row.temperature.toLocaleString(this.settings?.language==='fi'?'fi-FI':this.settings?.language||'en',{minimumFractionDigits:1,maximumFractionDigits:1});
      const time=new Date(row.time).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});
      const detail=`${row.saved?this.t('Saved forecast')+' · ':''}${timeLabel(row.time)} · ${label} · ${temperature} °C`;
      items+=`<g data-weather-hour="${row.time}"${row.saved?' data-saved-weather="true" opacity=".6"':''} ${detailAttributes(detail)}><rect x="${position-23}" y="${4+rowOffset}" width="46" height="76" rx="8" fill="transparent"/><text x="${position}" y="${20+rowOffset}" text-anchor="middle" fill="var(--secondary-text-color,#526b75)" style="font-size:11px">${time}</text><g transform="translate(${position-16} ${29+rowOffset}) scale(.9)">${weatherIcon(row.condition)}</g><text x="${position}" y="${75+rowOffset}" text-anchor="middle" fill="var(--primary-text-color,#253f49)" style="font-size:12px">${temperature}°</text></g>`;
    }
    const labelX=compact?8:20;
    const label=this.t('Weather forecast');
    const caption=compact?'°C':this.t('Hourly')+' · °C';
    return {height:102+rowOffset,svg:`<g data-weather-timeline="true"><text x="${labelX}" y="${compact?12:22}" fill="var(--primary-text-color,#253f49)" style="font-size:${compact?11:13}px;font-weight:600">${escapeHTML(label)}</text><text x="${labelX}" y="${compact?26:43}" fill="var(--secondary-text-color,#526b75)" style="font-size:11px">${escapeHTML(caption)}</text>${items}<line x1="${left}" x2="${left+width}" y1="${87+rowOffset}" y2="${87+rowOffset}" stroke="#829aa330"/>${now>start&&now<end?`<line x1="${x(now)}" x2="${x(now)}" y1="4" y2="${87+rowOffset}" stroke="var(--secondary-text-color,#526b75)" stroke-dasharray="4 4"/>`:''}</g>`};
  }
  outdoorHistoryTimeline({rows,forecast=[],start,end,left,width,now,detailAttributes}){
    // Outdoor readings are repeated in room observations. Keep the latest real
    // sample per quarter-hour so long histories remain readable and lightweight.
    const samples=new Map();
    for(const row of rows){
      const time=row.time*1000;
      if(time<start||time>end||time>now||!Number.isFinite(time)||row.outdoor==null||row.outdoor===''||!Number.isFinite(Number(row.outdoor)))continue;
      const bucket=Math.floor(time/900000),previous=samples.get(bucket);
      if(!previous||time>=previous.time)samples.set(bucket,{time,value:Number(row.outdoor)});
    }
    const points=[...samples.values()].sort((a,b)=>a.time-b.time);
    const forecastByTime=new Map();
    for(const row of forecast){
      const time=new Date(row.datetime).getTime();
      if(!Number.isFinite(time)||row.temperature==null||row.temperature===''||!Number.isFinite(Number(row.temperature)))continue;
      forecastByTime.set(time,{time,value:Number(row.temperature)});
    }
    const forecastSamples=[...forecastByTime.values()].sort((a,b)=>a.time-b.time);
    const future=forecastSamples.filter(point=>point.time>=Math.max(now,start)&&point.time<=end);
    // Interpolate only across a nearby forecast interval at Now. Do not connect
    // observations to forecasts as though they were one measured temperature series.
    const before=forecastSamples.findLast(point=>point.time<now);
    const after=forecastSamples.find(point=>point.time>now);
    if(now>=start&&now<=end&&before&&after&&after.time-before.time<=7200000&&!future.some(point=>point.time===now)){
      const fraction=(now-before.time)/(after.time-before.time);
      future.unshift({time:now,value:before.value+fraction*(after.value-before.value)});
    }
    if(!points.length&&!future.length)return {height:0,svg:''};
    const compact=left<100,top=compact?34:12,plotHeight=96;
    const temperatures=[...points,...future].map(point=>point.value);
    const low=Math.min(0,Math.floor(Math.min(...temperatures))-1);
    const high=Math.max(0,Math.ceil(Math.max(...temperatures))+1);
    const x=time=>left+(time-start)/(end-start)*width;
    const y=value=>top+plotHeight-(value-low)/(high-low)*plotHeight;
    const format=new Intl.NumberFormat(this.settings?.language||'en',{maximumFractionDigits:1});
    const label=this.t('Outdoor temperature');
    const ticks=[...new Set([low,0,high])].map(value=>`<line x1="${left}" x2="${left+width}" y1="${y(value)}" y2="${y(value)}" stroke="#829aa32c"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end" fill="var(--secondary-text-color,#526b75)" font-size="11">${escapeHTML(format.format(value))} °C</text>`).join('');
    const bars=points.map((point,index)=>{
      // Each bar covers at most one observation interval. Outages and future
      // periods stay empty instead of carrying the last temperature forward.
      const until=Math.min(point.time+900000,points[index+1]?.time??Infinity,now,end);
      if(until<=point.time)return '';
      const detail=`${label}: ${format.format(point.value)} °C\n${timeLabel(point.time)}`;
      return `<rect data-outdoor-time="${point.time}" data-outdoor-value="${point.value}" ${detailAttributes(detail)} x="${x(point.time)}" y="${Math.min(y(point.value),y(0))}" width="${Math.max(.3,x(until)-x(point.time)-.5)}" height="${Math.max(1,Math.abs(y(point.value)-y(0)))}" rx=".5" fill="${outdoorBarColor(point.value)}"/>`;
    }).join('');
    let forecastPath='',previousForecast;
    const forecastLabel=this.t('Weather forecast');
    const forecastDetails=future.map(point=>{
      const command=!previousForecast||point.time-previousForecast.time>7200000?'M':'L';
      forecastPath+=`${command}${x(point.time)} ${y(point.value)} `;
      previousForecast=point;
      const detail=`${forecastLabel} · ${label}: ${format.format(point.value)} °C\n${timeLabel(point.time)}`;
      return `<circle data-outdoor-forecast-time="${point.time}" ${detailAttributes(detail)} cx="${x(point.time)}" cy="${y(point.value)}" r="5" fill="transparent" stroke="transparent"/>`;
    }).join('');
    const forecastLine=future.length?`<g data-outdoor-forecast><path d="${forecastPath.trim()}" fill="none" stroke="#88939b" stroke-width="2" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>${future.length===1?`<circle cx="${x(future[0].time)}" cy="${y(future[0].value)}" r="2" fill="#88939b"/>`:''}${forecastDetails}</g>`:'';

    const background=`<defs><linearGradient id="outdoor-history-background" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#829aa3" stop-opacity=".01"/><stop offset="100%" stop-color="#829aa3" stop-opacity=".11"/></linearGradient></defs><rect data-outdoor-background x="8" y="0" width="${left+width-8}" height="${top+plotHeight+12}" rx="8" fill="url(#outdoor-history-background)" pointer-events="none"/>`;
    const height=top+plotHeight+48;
    return {height,svg:`<g data-outdoor-history="true">${background}<text x="${compact?8:20}" y="${compact?16:26}" fill="var(--primary-text-color,#253f49)" style="font-size:13px;font-weight:600">${escapeHTML(label)} (°C)</text>${ticks}${bars}${forecastLine}<line data-outdoor-zero x1="${left}" x2="${left+width}" y1="${y(0)}" y2="${y(0)}" stroke="var(--secondary-text-color,#526b75)" stroke-width="1" pointer-events="none"/>${now>start&&now<end?`<line x1="${x(now)}" x2="${x(now)}" y1="${top}" y2="${top+plotHeight}" stroke="var(--secondary-text-color,#526b75)" stroke-dasharray="4 4"/>`:''}</g>`};
  }
  copTimeline({data,start,end,left,width,now,detailAttributes}){
    if(!data)return {height:0,svg:''};
    const measuredLabel=this.t('Measured');
    const forecastLabel=this.t('COP forecast');
    const outdoorLabel=this.t('Outdoor temperature');
    const measuredColor='color-mix(in srgb,#167b86 72%,var(--primary-text-color,#213547))';
    const forecastColor='var(--secondary-text-color,#526b75)';
    const points=(rows,forecast)=>rows
      .filter(row=>Number.isFinite(row.time)&&Number.isFinite(row.cop)&&row.cop>0)
      .map(row=>{
        const time=row.time*1000;
        // The forecast for the current interval stays valid between refreshes.
        const coversNow=forecast&&time<now&&row.end*1000>now;
        return {...row,time:coversNow?now:time};
      })
      .filter(row=>row.time>=start&&row.time<=end&&(forecast?row.time>=now:row.time<=now))
      .sort((first,second)=>first.time-second.time);
    const measured=points(data.observed||[],false);
    const forecast=points(data.forecast||[],true);
    const compact=left<100;
    const caption=`<text x="8" y="18" font-size="13" font-weight="600">COP</text>`;
    if(!measured.length&&!forecast.length){
      const status=escapeHTML(this.t('No observations yet'));
      return {height:48,svg:`<g data-cop-timeline>${caption}<text x="8" y="36" font-size="11">${status}</text></g>`};
    }
    const legendX=compact?52:8;
    const legendY=compact?14:38;
    const legendItem=(label,color,y,dashed)=>{
      const symbol=dashed
        ?`<line x1="${legendX}" x2="${legendX+15}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="2" stroke-dasharray="4 3"/>`
        :`<circle cx="${legendX+7.5}" cy="${y}" r="2.5" fill="${color}"/>`;
      return `${symbol}<text x="${legendX+20}" y="${y+4}" font-size="11">${escapeHTML(label)}</text>`;
    };
    const legend=legendItem(measuredLabel,measuredColor,legendY,false)
      +(forecast.length?legendItem(forecastLabel,forecastColor,legendY+17,true):'');
    const top=compact?48:13;
    const plotHeight=74;
    const low=Math.min(...measured.map(row=>row.cop),...forecast.map(row=>row.cop));
    const high=Math.max(...measured.map(row=>row.cop),...forecast.map(row=>row.cop));
    const axisMin=Math.max(0,Math.floor(low-.01));
    const axisMax=Math.max(axisMin+1,Math.ceil(high+.01));
    const x=time=>left+(time-start)/(end-start)*width;
    const y=value=>top+(1-(value-axisMin)/(axisMax-axisMin))*plotHeight;
    const format=new Intl.NumberFormat(this.settings.language||'en',{maximumFractionDigits:2});
    const ticks=[axisMin,(axisMin+axisMax)/2,axisMax].map(value=>`<line x1="${left}" x2="${left+width}" y1="${y(value)}" y2="${y(value)}" stroke="#829aa32c"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end" font-size="11">${escapeHTML(format.format(value))}</text>`).join('');
    const series=(rows,label,color,dashed)=>{
      let path='';
      const forecastInterval=3600000;
      const markers=rows.map((row,index)=>{
        const cx=x(row.time),cy=y(row.cop);
        if(dashed){
          const previous=rows[index-1];
          const disconnected=!previous||row.time-previous.time>forecastInterval;
          path+=`${disconnected?'M':'L'}${cx} ${cy} `;
          const next=rows[index+1];
          if(disconnected&&(!next||next.time-row.time>forecastInterval)){
            // A single forecast point has no line segment, so show one short dash.
            const dashEnd=cx+4<=left+width?cx+4:cx-4;
            path+=`L${dashEnd} ${cy} `;
          }
        }
        const labelWithBasis=row.basis==='initial'?`${label} · ${this.t('Initial estimate')}`:label;
        const detail=`${labelWithBasis} · COP: ${format.format(row.cop)}\n${outdoorLabel}: ${format.format(row.outdoor)} °C\n${timeLabel(row.time)}`;
        const measuredDot=dashed?'':`<circle cx="${cx}" cy="${cy}" r="2" fill="${color}" pointer-events="none"/>`;
        return `${measuredDot}<circle ${detailAttributes(detail)} cx="${cx}" cy="${cy}" r="6" fill="transparent"/>`;
      }).join('');
      const forecastPath=dashed?`<path d="${path.trim()}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="5 4"/>`:'';
      return `<g data-cop-series="${dashed?'forecast':'observed'}">${forecastPath}${markers}</g>`;
    };
    const nowLine=now>start&&now<end?`<line x1="${x(now)}" x2="${x(now)}" y1="${top}" y2="${top+plotHeight}" stroke="${forecastColor}" stroke-dasharray="4 4" pointer-events="none"/>`:'';
    const observedDots=measured.length?series(measured,measuredLabel,measuredColor,false):'';
    const forecastLine=forecast.length?series(forecast,forecastLabel,forecastColor,true):'';
    return {height:top+plotHeight+16,svg:`<g data-cop-timeline>${caption}${legend}${ticks}${nowLine}${observedDots}${forecastLine}</g>`};
  }
  chartVisibility(){return {weather:true,prices:true};}
  priceChart(history=false,dashboard=false){
  const visibility=this.chartVisibility();
  const copData=!history&&visibility.cop!==false?this.info.data?.heat_pump_cop:null;
  const isGarage=room=>room.is_garage||this.info.data?.rooms?.[room.id]?.is_garage;
  const ordinaryRooms=[...(this.settings?.rooms||[])].filter(room=>!isGarage(room)).sort(compareRoomNames);
  const garageRooms=[...(this.settings?.rooms||[])].filter(isGarage).sort(compareRoomNames);
  const rooms=[...ordinaryRooms,...garageRooms];
  const fireplaces=(this.settings?.fireplaces||[]).map(fireplace=>({...fireplace,source_type:'fireplace'}));
  const zones=[...(this.settings?.heating_zones||[]),...fireplaces].sort(compareRoomNames);
  const manualNames=!history&&visibility.manual!==false&&Object.keys(this.info?.manual_controls||{}).length>0;
  const chartReading=(item,zone=false)=>{
   const readings=this.info.data?.chart_temperatures?.[zone?'zones':'rooms'];
   return readings&&Object.hasOwn(readings,item.id)?readings[item.id]:this.info.data?.[zone?'zones':'rooms']?.[item.id]?.temperature;
  };
  const validTemperature=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
  const currentTemperature=(item,zone=false)=>{
   if(history)return '';
   const value=chartReading(item,zone);if(!validTemperature(value))return '';
   const temperature=new Intl.NumberFormat(this.settings.language||'en',{minimumFractionDigits:1,maximumFractionDigits:1}).format(Number(value));
   return `${temperature} °C`;
  };
  const published=(this.info.data?.price_chart||[]).filter(s=>s.price!==null&&s.price!==undefined&&s.price!=='').map(s=>({time:new Date(s.start).getTime(),end:new Date(s.end).getTime(),price:Number(s.price)})).filter(s=>s.price!=null&&Number.isFinite(s.time)&&Number.isFinite(s.end)&&Number.isFinite(s.price)&&s.end>s.time).sort((a,b)=>a.time-b.time);
  const now=Date.now();
  const midnight=new Date(now);midnight.setHours(0,0,0,0);
  const historyStart=Math.floor(Math.min(now-this.historyHours*3600000,published.length?midnight.getTime():now)/900000)*900000;
  const historyEnd=Math.ceil(Math.max(now,...published.map(slot=>slot.end))/900000)*900000;
  let values=published;
  if(history){
   const unique=new Map();
   const rangeStart=historyStart,rangeEnd=historyEnd;
   for(const slot of published){
    for(let time=Math.max(slot.time,rangeStart);time<Math.min(slot.end,rangeEnd);time+=900000)unique.set(time/1000,{time,end:Math.min(time+900000,slot.end,rangeEnd),price:slot.price});
   }
   for(const row of this.history||[]){
    const time=Math.floor(row.time/900)*900000;
    if(time>=rangeStart&&time<rangeEnd&&row.time*1000<=now&&row.price!=null&&Number.isFinite(Number(row.price)))unique.set(time/1000,{time,end:Math.min(time+900000,rangeEnd),price:Number(row.price)});
   }
   values=[...unique.values()].sort((a,b)=>a.time-b.time);
  }
  const open=this.priceAccordionState?.[history?'history':'overview']!==false;
  const heading=dashboard?'':`<details class="observation-accordion" id="price-accordion" ${open?'open':''}><summary><h2 style="margin:0">${escapeHTML(this.t('Total electricity price and heating'))}</h2></summary><div style="padding-top:16px">`;
  if(!history&&visibility.prices&&!values.length&&!zones.length&&!garageRooms.length&&!(this.info.data?.weather_forecast||[]).length&&!(this.info.data?.weather_forecast_history||[]).length&&!copData)return `<section class="price-card">${heading}<p>${history?'No past electricity prices are available yet. History uses recorded prices and known past intervals from the published price list.':'No usable electricity price list is available.'}</p>${dashboard?'':'</div></details>'}</section>`;
  const start=history?historyStart:Math.floor((published[0]?.time??values[0]?.time??(now-86400000))/900000)*900000;
  const end=history?historyEnd:Math.ceil((published.at(-1)?.end??Math.max(values.at(-1)?.end??(now+86400000),now))/900000)*900000;
  const span=end-start;
  const weatherByTime=new Map();
  if(!history&&visibility.weather){
    const forecasts=(this.info.data?.weather_forecast||[]).map(row=>({...row,saved:false}));
    const saved=(this.info.data?.weather_forecast_history||[]).map(row=>({...row,saved:true}));
    for(const row of [...forecasts,...saved]){
      const time=new Date(row.datetime).getTime();
      if(!Number.isFinite(time)||time<start||time>=end||!validTemperature(row.temperature))continue;
      if(row.saved?time>=now:time+3600000<=now)continue;
      weatherByTime.set(time,{...row,time,temperature:Number(row.temperature)});
    }
  }
  const weatherRows=[...weatherByTime.values()].sort((a,b)=>a.time-b.time);
  let viewWidth=Math.max(240,this.priceChartWidth||((this.clientWidth||0)>0?this.clientWidth-104:900));
  const compact=viewWidth<600;
  let nameContext;
  try{nameContext=typeof document!=='undefined'?document.createElement('canvas').getContext?.('2d'):null;if(nameContext)nameContext.font='600 13px system-ui';}catch(error){nameContext=null;}
  const longestName=Math.max(0,...[...rooms,...zones].map(item=>String(item.name||'')).map(label=>nameContext?nameContext.measureText(label).width:Array.from(label).length*8));
  const roomNameWidth=compact?viewWidth-(history?40:125):Math.max(history?190:180,Math.min(viewWidth*.4,Math.ceil(longestName)+(manualNames?68:12)));
  const priceHeaderHeight=visibility.prices&&compact?64:0;
  const left=compact?88:roomNameWidth+(history?120:100),width=viewWidth-left-20,top=15+priceHeaderHeight,height=120,max=Math.max(25,Math.ceil(Math.max(0,...values.map(v=>v.price))/5)*5),min=Math.min(0,Math.floor(Math.min(0,...values.map(v=>v.price))/5)*5);
  const ticks=Array.from({length:6},(_,i)=>min+(max-min)*i/5).map(v=>{const y=top+height-(v-min)/(max-min)*height;return `<line x1="${left}" x2="${left+width}" y1="${y}" y2="${y}" stroke="#829aa32c"/><text x="${left-10}" y="${y+4}" text-anchor="end" fill="var(--secondary-text-color,#526b75)" font-size="12">${v.toFixed(0)} c/kWh</text>`;}).join('');
  const x=time=>left+(time-start)/span*width;
  const y=price=>top+height-(price-min)/(max-min)*height;
  const temperatureLabel=(item,y,zone=false)=>{
   const value=currentTemperature(item,zone);
   const target=this.info.data?.chart_temperatures?.targets?.[zone?'zones':'rooms']?.[item.id];
   const measured=chartReading(item,zone);
   const entity=this.info.data?.temperature_history_entities?.[zone?'zones':'rooms']?.[item.id];
   const historyAction=entity?` data-temperature-history-entity="${escapeHTML(entity)}" role="button" tabindex="0" aria-label="${escapeHTML(this.t('History')+': '+item.name+' '+value)}"`:'';
   let targetArrow = '';
   const roomData=this.info.data?.rooms?.[item.id];
   let plan=roomData?.plan;
   const assistanceTarget=roomData?.heating_assistance?.floor_target;
   if(assistanceTarget!=null){
    plan={setpoint:assistanceTarget,mode:'normal'};
    if(assistanceTarget>item.baseline)plan.mode='boost';
    else if(assistanceTarget<item.baseline)plan.mode='reduced';
   }
   // This is the current planned thermostat adjustment, not a measured temperature trend.
   // Heat-pump device targets and garage limits have different meanings.
   if (!history && !zone && !isAirRoom(item) && plan) {
    const boosted = plan.mode === 'boost' || plan.heat === true;
    const reduced = plan.mode === 'reduced' || plan.mode === 'away';
    if (boosted || reduced) {
     const label = this.t(boosted ? 'Boosted thermostat target' : 'Reduced thermostat target temperature');
     let detail = label;
     if (validTemperature(plan.setpoint) && validTemperature(item.baseline)) {
      // Use the resulting setpoint so configured minimum/maximum limits are reflected.
      const adjustment = Number(plan.setpoint) - Number(item.baseline);
      const format = new Intl.NumberFormat(this.settings.language || 'en', {maximumFractionDigits: 2});
      const sign = adjustment > 0 ? '+' : adjustment < 0 ? '−' : '';
      detail += `: ${sign}${format.format(Math.abs(adjustment))} °C (${format.format(Number(item.baseline))} → ${format.format(Number(plan.setpoint))} °C)`;
     }
     const arrowColor = boosted ? '#d94a43' : '#2586cf';
     targetArrow = `<tspan data-target-adjustment="${boosted ? 'boost' : 'reduced'}" data-chart-detail="${escapeHTML(detail)}" tabindex="0" role="img" aria-label="${escapeHTML(detail)}" fill="${arrowColor}" style="fill:${arrowColor};font-weight:700;cursor:help"><title>${escapeHTML(detail)}</title>${boosted ? '↑' : '↓'} </tspan>`;
    }
   }
   const color=validTemperature(target)&&validTemperature(measured)?Number(measured)<Number(target)?'#3498DB':Number(measured)>Number(target)?priceColor(0):'var(--primary-text-color,#213547)':'var(--primary-text-color,#213547)';
   return value?`<text data-current-temperature="${escapeHTML(item.id)}"${historyAction} data-user-text x="${compact?viewWidth-20:left-12}" y="${y+(compact?14:11)}" text-anchor="end" fill="${color}" style="fill:${color};font-size:13px;font-variant-numeric:tabular-nums;${entity?'cursor:pointer':''}">${targetArrow}${escapeHTML(value)}</text>`:'';
  };
  const detailAttributes=text=>`data-chart-detail="${escapeHTML(text)}" tabindex="0" role="img" aria-label="${escapeHTML(text)}"`;
  const heatingSummary=(periods,upcoming)=>{
   const lower=upcoming?Math.max(start,now):start;
   const upper=upcoming?end:Math.min(end,now);
   const clipped=periods.map(period=>({start:Math.max(lower,period.start),end:Math.min(upper,period.end)})).filter(period=>period.end>period.start).sort((a,b)=>a.start-b.start);
   // Union intervals so repeated or overlapping observations never count twice.
   let total=0,until=lower;
   for(const period of clipped){
    total+=Math.max(0,period.end-Math.max(until,period.start));
    until=Math.max(until,period.end);
   }
   const label=this.t(upcoming?'Upcoming plan in displayed period:':'Actual heating in displayed period:');
   return `\n\n${label} ${durationLabel(total)}\n${timeLabel(start)} – ${timeLabel(end)}`;
  };
  const bars=values.map(v=>`<rect ${detailAttributes(`Electricity price: ${v.price.toFixed(2)} c/kWh\nStart: ${timeLabel(v.time)}\nEnd: ${timeLabel(v.end)}`)} x="${x(v.time)}" y="${Math.min(y(v.price),y(0))}" width="${Math.max(1,(v.end-v.time)/span*width-.5)}" height="${Math.max(1,Math.abs(y(0)-y(v.price)))}" rx="1" fill="${priceColor(v.price)}"></rect>`).join('');
  const maximumLabels=Math.max(2,Math.floor(width/120));
  const tickSteps=[15,30,60,120,180,360,720,1440,2880,5760,11520];
  const tickStep=(tickSteps.find(minutes=>span/(minutes*60000)<=maximumLabels)||11520)*60000;
  const axisTimes=[];
  for(let time=Math.ceil(start/tickStep)*tickStep;time<=end;time+=tickStep)axisTimes.push(time);
  const axisLabel=time=>{
   const date=new Date(time);
   const day=String(date.getDate()).padStart(2,'0');
   const month=String(date.getMonth()+1).padStart(2,'0');
   return `${day}.${month}. ${date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false})}`;
  };
  const labelRow=y=>axisTimes.map(time=>`<text x="${x(time)}" y="${y}" text-anchor="${time===start?'start':time===end?'end':'middle'}" fill="var(--secondary-text-color,#526b75)" font-size="11">${escapeHTML(axisLabel(time))}</text>`).join('');
  const timelineLegendHeight=compact?76:34;
  const roomGap=10,roomTop=(visibility.prices?210+priceHeaderHeight:68)+timelineLegendHeight;
  const isAirRoom=room=>Boolean(airRoom(room,this.settings)||this.info.data?.rooms?.[room.id]?.air_control||(!isGarage(room)&&room.heat_control!=='zone_member'&&this.settings.house_heat_source==='air_to_air'));
  const roomHeights=rooms.map(room=>isAirRoom(room)?(compact?60:36):(compact?(history?80:60):history?54:36));
  const roomsHeight=roomHeights.reduce((sum,height)=>sum+height,0);
  const ordinaryHeight=roomHeights.slice(0,ordinaryRooms.length).reduce((sum,height)=>sum+height,0);
  const zoneStart=roomTop+ordinaryHeight+30;
  const zonesEnd=zoneStart+(zones.length?14+zones.length*((compact?50:26)+roomGap):0);
  const garageStart=zones.length?zonesEnd+48:roomTop+ordinaryHeight+(ordinaryRooms.length?48:0);
  const garageGap=garageStart-roomTop-ordinaryHeight;
  const garageHeading=garageRooms.length?`<text x="${manualNames?76:20}" y="${garageStart-20}" fill="var(--primary-text-color,#6d5848)" style="font-size:18px;font-weight:600">${escapeHTML(this.t('Garages'))}</text>`:'';
  let chartHeight=roomTop+roomsHeight+garageGap+26;
  const lanes=rooms.map((room,roomIndex)=>{
   const rowHeight=roomHeights[roomIndex];
   const rows=((history?this.history:this.statusHistory)||[]).filter(r=>r.room_id===room.id).sort((a,b)=>a.time-b.time),y=roomTop+roomHeights.slice(0,roomIndex).reduce((sum,height)=>sum+height,0)+(isGarage(room)?garageGap:0);
   const plan=this.info.data?.rooms?.[room.id]?.plan;
   const commands=[...(plan?.commands||[])].sort((a,b)=>new Date(a.time)-new Date(b.time));
   const recorded=rows.map((r,i)=>({start:r.time*1000,end:Math.min((rows[i+1]?.time??(r.time+300))*1000,r.time*1000+1800000,now),suggested_heat:r.suggested_heat,activity:r.activity,recorded:true,next:rows[i+1],previous:rows[i-1]}));
   const planned=commands.map((c,i)=>({start:Math.max(now,new Date(c.time).getTime()),originalStart:new Date(c.time).getTime(),end:commands[i+1]?new Date(commands[i+1].time).getTime():end,suggested_heat:c.action==='raise',activity:null}));
   const pastRelays=recorded.map(v=>({...v,suggested_heat:v.activity,next:v.next?{...v.next,suggested_heat:v.next.activity}:undefined,previous:v.previous?{...v.previous,suggested_heat:v.previous.activity}:undefined}));
   const intervals=history?[...recorded,...planned]:[...pastRelays,...planned];
   const air=isAirRoom(room);
   const laneTop=compact?24:0;
   if(air){
    const periods=[];
    rows.forEach((row,index)=>{
     const mode=Object.hasOwn(row,'pump_mode')?row.pump_mode:row.activity===1?'heat':null;
     if(!['heat','cool'].includes(mode)||row.time*1000>=now)return;
     const next=rows[index+1],until=next&&next.time-row.time<=600?next.time:row.time+300;
     const period={start:row.time*1000,end:Math.min(until*1000,now),mode,basis:row.pump_basis||'activity',entity:row.pump_entity};
     const previous=periods.at(-1);
     if(previous&&previous.end===period.start&&previous.mode===mode&&previous.basis===period.basis&&previous.entity===period.entity)previous.end=period.end;
     else periods.push(period);
    });
    const tariff=isGarage(room)?room.garage_strategy==='tariff':!room.heating_zone_id||(this.settings.heating_zones||[]).find(zone=>zone.id===room.heating_zone_id)?.heating_strategy==='tariff';
    if(!history&&tariff)periods.push(...planned.filter(period=>period.suggested_heat).map(period=>({...period,mode:'heat',basis:'plan'})));
    const actualSummary=heatingSummary(periods.filter(period=>period.mode==='heat'&&period.basis!=='plan'),false);
    const planSummary=heatingSummary(periods.filter(period=>period.basis==='plan'),true);
    const activity=periods.map(period=>{
     const a=Math.max(start,period.start),b=Math.min(end,period.end);if(b<=a)return '';
     const kind=period.basis==='plan'?'Suggested heating':period.basis==='operating_mode'?(period.mode==='cool'?'Observed cool mode':'Observed heat mode'):period.mode==='cool'?'Recorded cooling':'Recorded heating';
     const detail=`${room.name} · ${this.t(kind)}\n${this.t('Start:')} ${timeLabel(period.start)}\n${this.t('End:')} ${timeLabel(period.end)}\n${this.t('Duration')}: ${durationLabel(period.end-period.start)}${period.basis==='plan'?planSummary:period.mode==='heat'?actualSummary:''}`;
     return `<rect ${detailAttributes(detail)} data-pump-period="${period.basis==='plan'?'plan':period.mode}" x="${x(a)}" y="${y+laneTop}" width="${(b-a)/span*width}" height="13" rx="2" fill="${period.basis==='plan'?'url(#suggested-heating-stripes)':period.mode==='cool'?'#3498DB':'#EC7063'}"/>`;
    }).join('');
    return `<g class="chart-timeline-row" data-pump-timeline="${escapeHTML(room.id)}"><rect class="chart-row-background" x="8" y="${y-5}" width="${viewWidth-20}" height="${rowHeight-roomGap}" rx="6" fill="${isGarage(room)?((roomIndex-ordinaryRooms.length)%2?'var(--tp-garage-alt,#e9e1d8)':'var(--tp-garage,#eee8e1)'):(roomIndex%2?'var(--tp-row-alt,#f1f4f7)':'var(--tp-row,#f0f5f3)')}"/><foreignObject x="20" y="${compact?y-2:y-5+(rowHeight-roomGap-22)/2}" width="${roomNameWidth}" height="22">${this.manualChartName(room.name,room.id,history,'var(--primary-text-color,#6d5848)')}</foreignObject>${temperatureLabel(room,y)}<rect x="${left}" y="${y+laneTop}" width="${width}" height="13" rx="3" fill="var(--tp-track,#e5ebee)"/>${activity}</g>`;
   }
   const actualSummary=heatingSummary(recorded.filter(period=>period.activity===1),false);
   const planSummary=heatingSummary(planned.filter(period=>period.suggested_heat),true);
   const lane=(key,offset,color)=>{
    // Adjacent On observations form one period; never join gaps or unknown states.
    const periods=[];
    for(const v of intervals){
     if(!v[key]||v.end<=v.start)continue;
     const previous=periods.at(-1);
     const stopped=v.recorded&&v.next&&v.next[key]===0&&(v.next.time*1000-v.start)<=1800000;
     const started=v.recorded&&v.previous&&v.previous[key]===0&&(v.start-v.previous.time*1000)<=1800000;
     if(previous&&previous.end===v.start&&previous.recorded===v.recorded){previous.end=v.end;previous.stopped=stopped;}
     else periods.push({...v,started,stopped});
    }
    return `<rect x="${left}" y="${y+laneTop+offset}" width="${width}" height="14" rx="3" fill="var(--tp-track,#e5ebee)"/>`+periods.map(v=>{
     const a=Math.max(start,v.start),b=Math.min(end,v.end);
     const label=key==='activity'||(!history&&v.recorded)?'Actual relay':'Suggested heating';
     const tooltipStart=v.originalStart??v.start;
     const detail=`${room.name} · ${label} On\n${v.recorded&&!v.started?'First observed On':'Start'}: ${timeLabel(tooltipStart)}\n${v.recorded&&!v.stopped?'Observed until':'Stop'}: ${timeLabel(v.end)}\n${v.recorded?'Observed duration':'Duration'}: ${durationLabel(v.end-tooltipStart)}${v.recorded?'\nTimes are based on recorded observations; gaps are not filled.':''}${v.recorded?(key==='activity'||!history?actualSummary:''):planSummary}`;
     return b>a?`<rect ${detailAttributes(detail)} x="${x(a)}" y="${y+laneTop+offset}" width="${(b-a)/span*width}" height="14" fill="${!history&&v.recorded?'#EC7063':key==='suggested_heat'?'url(#suggested-heating-stripes)':color}"></rect>`:'';
    }).join('');
   };
   return `<g class="chart-timeline-row"><rect class="chart-row-background" x="8" y="${y-5}" width="${viewWidth-20}" height="${rowHeight-roomGap}" rx="6" fill="${isGarage(room)?((roomIndex-ordinaryRooms.length)%2?'var(--tp-garage-alt,#e9e1d8)':'var(--tp-garage,#eee8e1)'):(roomIndex%2?'var(--tp-row-alt,#f1f4f7)':'var(--tp-row,#f0f5f3)')}"/><foreignObject x="20" y="${y+(compact?-1:history?7:-1)}" width="${roomNameWidth}" height="22">${this.manualChartName(room.name,room.id,history,'var(--primary-text-color,#253f49)')}</foreignObject>${temperatureLabel(room,y)}${lane('suggested_heat',0,'#EC7063')}${history?lane('activity',18,'#EC7063'):''}</g>`;
  });
  let zoneY=zoneStart;
  const zoneHeading=zones.length?`<text x="${manualNames?76:20}" y="${zoneY-9}" fill="var(--primary-text-color,#76532b)" style="font-size:18px;font-weight:600">${escapeHTML(this.t('Zones'))}</text>`:'';
  if(zones.length)zoneY+=14;
  const zoneLanes=zones.map(zone=>{
   const y=zoneY,tariff=zone.source_type!=='fireplace'&&(zone.heating_strategy||'tariff')==='tariff'&&zone.climate_mode!=='cool';
   const showPlan=!history&&tariff;
   const laneTop=compact?26:0,zoneHeight=compact?50:26;
   zoneY+=zoneHeight+roomGap;
   const rows=((history?this.history:this.statusHistory)||[]).filter(row=>row.zone_id===zone.id).sort((a,b)=>a.time-b.time);
   const observed=mode=>{
    const periods=[];
    rows.forEach((row,index)=>{
     if(row.zone_mode!==mode||row.time*1000>=now)return;
     const next=rows[index+1],until=next&&next.time-row.time<=600?next.time:row.time+300;
     const period={mode,start:row.time*1000,end:Math.min(until*1000,now),basis:row.zone_basis,entity:row.zone_entity};
     const previous=periods.at(-1);
     if(previous&&previous.end===period.start&&previous.basis===period.basis&&previous.entity===period.entity)previous.end=period.end;
     else periods.push(period);
    });return periods;
   };
   const planned=[];
   if(showPlan){
    const plan=this.info.data?.zones?.[zone.id]?.plan;
    const commands=[...(plan?.commands||[])].sort((a,b)=>new Date(a.time)-new Date(b.time));
    commands.forEach((command,index)=>{
     if(command.action!=='raise')return;
     planned.push({start:Math.max(now,new Date(command.time).getTime()),end:Math.min(end,commands[index+1]?new Date(commands[index+1].time).getTime():new Date(plan?.slots?.at(-1)?.end||end).getTime()),basis:'plan'});
    });
   }
   const actualSummary=heatingSummary(observed('heat'),false);
   const planSummary=heatingSummary(planned,true);
   const track=(label,offset,color,periods)=>`<text x="${left-12}" y="${y+laneTop+offset+11}" text-anchor="end" fill="var(--primary-text-color,#76532b)" font-size="10">${label==='Activity'||compact&&label==='Recorded'?'':escapeHTML(this.t(label))}</text><rect x="${left}" y="${y+laneTop+offset}" width="${width}" height="13" rx="3" fill="var(--tp-track,#e8e3dc)"/>`+periods.map(period=>{
    const a=Math.max(start,period.start),b=Math.min(end,period.end);
    if(b<=a)return '';
    const kind=period.basis==='plan'?'Suggested heating':period.basis==='operating_mode'?(period.mode==='cool'?'Observed cool mode':'Observed heat mode'):period.mode==='cool'?'Recorded cooling':'Recorded heating';
    const detail=`${zone.name} · ${this.t(kind)}\n${this.t('Start:')} ${timeLabel(period.start)}\n${this.t('End:')} ${timeLabel(period.end)}\n${this.t('Duration')}: ${durationLabel(period.end-period.start)}${period.basis==='plan'?planSummary:period.mode==='heat'?actualSummary:''}`;
    return `<rect ${detailAttributes(detail)} data-zone-period="${period.basis==='plan'?'plan':period.mode==='cool'?'cool':'heat'}" x="${x(a)}" y="${y+laneTop+offset}" width="${(b-a)/span*width}" height="13" rx="2" fill="${period.basis==='plan'?'url(#suggested-heating-stripes)':period.mode==='cool'?'#3498DB':color}"/>`;
   }).join('');
   return `<g class="chart-timeline-row" data-zone-timeline="${escapeHTML(zone.id)}"><rect class="chart-row-background" x="8" y="${y-5}" width="${viewWidth-20}" height="${zoneHeight}" rx="6" fill="var(--tp-zone,#f5f0e8)"/><foreignObject x="20" y="${compact?y-2:y-5+(zoneHeight-22)/2}" width="${roomNameWidth}" height="22">${this.manualChartName(zone.name,'zone:'+zone.id,history,'var(--primary-text-color,#76532b)')}</foreignObject>${temperatureLabel(zone,y,true)}${track('Activity',0,'#EC7063',[...observed('heat'),...observed('cool'),...planned].sort((a,b)=>a.start-b.start))}</g>`;
  }).join('');
  const timelineLegend=`<foreignObject data-timeline-legend x="8" y="${roomTop-timelineLegendHeight-36}" width="${viewWidth-28}" height="${timelineLegendHeight}"><div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:center;flex-wrap:wrap;gap:8px 18px;font:13px system-ui;line-height:20px;color:var(--primary-text-color,#213547)"><span data-heating-legend><b style="color:#EC7063">■</b> ${escapeHTML(this.t('Heating'))}</span>${zones.length||rooms.some(room=>airRoom(room,this.settings)||this.info.data?.rooms?.[room.id]?.air_control||(!isGarage(room)&&this.settings.house_heat_source==='air_to_air'))?`<span data-cooling-legend><b style="color:#3498DB">■</b> ${escapeHTML(this.t("Cooling"))}</span>`:''}<span data-suggested-heating-legend><b style="display:inline-block;width:24px;height:10px;border-radius:2px;background:repeating-linear-gradient(135deg,#F39C12 0 4px,#f6bf65 4px 6px)"></b> Suggested heating window</span></div></foreignObject>`;
  const activePrice=published.find(slot=>slot.time<=now&&now<slot.end);
  const totalPriceValue=activePrice?new Intl.NumberFormat(this.settings?.language||'en',{minimumFractionDigits:2,maximumFractionDigits:2}).format(activePrice.price):'—';
  const priceCaption=`<g data-current-total-price="${activePrice?.price??''}" role="img" aria-label="${escapeHTML(this.t('Total price')+' '+this.t('Now').toLocaleLowerCase(this.settings?.language||'en')+': '+totalPriceValue+' c/kWh')}"><text x="20" y="${compact?18:30}" style="font-size:13px;font-weight:600">${escapeHTML(this.t('Total price')+' '+this.t('Now').toLocaleLowerCase(this.settings?.language||'en'))}</text><text data-user-text x="20" y="${compact?47:62}" style="font-size:22px;font-weight:600;font-variant-numeric:tabular-nums">${escapeHTML(totalPriceValue)}<tspan style="font-size:13px;font-weight:400"> c/kWh</tspan></text></g>`;
  const weather=history
    ?this.outdoorHistoryTimeline({rows:this.history||[],forecast:this.info.data?.weather_forecast||[],start,end,left,width,now,detailAttributes})
    :this.weatherTimeline({rows:weatherRows,start,end,left,width,now,detailAttributes});
  const cop=this.copTimeline({data:copData,start,end,left,width,now,detailAttributes});
  const chartOffset=cop.height+weather.height;
  chartHeight=garageRooms.length?garageStart+roomHeights.slice(ordinaryRooms.length).reduce((sum,height)=>sum+height,0)+26:zones.length?zoneY+18:roomTop+ordinaryHeight+26;
  const dayBoundaries=[];
  const nextDay=new Date(start);nextDay.setHours(0,0,0,0);nextDay.setDate(nextDay.getDate()+1);
  // Calendar-day stepping preserves local midnight across 23/25-hour DST days.
  while(nextDay.getTime()<end){dayBoundaries.push(nextDay.getTime());nextDay.setDate(nextDay.getDate()+1);}
  const dayLines=dayBoundaries.map(time=>`<line data-day-boundary="${time}" x1="${x(time)}" x2="${x(time)}" y1="${chartOffset?8:top}" y2="${chartOffset+chartHeight-26}" stroke="#829aa3" stroke-opacity="0.55" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none"/>`).join('');
  return `<style>
.price-card{--tp-chart-card:color-mix(in srgb,#2196f3 7%,var(--card-background-color,#fff));--tp-chart-surface:color-mix(in srgb,var(--card-background-color,#fff) 85%,var(--tp-chart-card));--tp-track:color-mix(in srgb,var(--primary-text-color,#213547) 9%,var(--card-background-color,#fff));--tp-row:color-mix(in srgb,#008577 6%,var(--card-background-color,#fff));--tp-row-alt:color-mix(in srgb,#2196f3 6%,var(--card-background-color,#fff));--tp-garage:color-mix(in srgb,#91785e 22%,var(--card-background-color,#fff));--tp-garage-alt:color-mix(in srgb,#91785e 28%,var(--card-background-color,#fff));--tp-zone:color-mix(in srgb,#b58950 12%,var(--card-background-color,#fff));color:var(--primary-text-color,#213547)}
.price-chart-viewport svg text{fill:var(--primary-text-color,#213547)}
.manual-name{display:flex;align-items:center;gap:4px;font:600 13px system-ui;line-height:22px}.manual-label{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.manual-slot{display:flex;align-items:center;justify-content:center;width:24px;min-width:24px;height:22px}.manual-icon{display:flex;align-items:center;justify-content:center;width:24px;height:22px;box-sizing:border-box;padding:3px;border:0;background:transparent;border-radius:50%;color:#8b9ba2;cursor:pointer}.manual-icon svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}.manual-icon[data-manual-mode="heat"]:hover,.manual-icon[data-manual-mode="heat"].active{color:#d85345;background:#ffe1dc}.manual-icon[data-manual-mode="cool"]:hover,.manual-icon[data-manual-mode="cool"].active{color:#1689cc;background:#dceffc}.manual-icon[data-manual-mode="heat"].active svg{fill:currentColor}.manual-icon.manual-session{box-shadow:0 0 0 1.5px currentColor}.manual-icon:focus-visible{outline:2px solid var(--primary-color,#007f8b);outline-offset:1px}.manual-icon:disabled{opacity:.65;cursor:default}
.chart-row-background{transition:filter 120ms ease}.chart-timeline-row:hover>.chart-row-background,.chart-timeline-row:focus-within>.chart-row-background{filter:drop-shadow(0 2px 6px color-mix(in srgb,var(--primary-text-color,#213547) 40%,transparent))}@media(prefers-reduced-motion:reduce){.chart-row-background{transition:none}}</style><section class="price-card" style="background:var(--tp-chart-card,#edf4fa);margin-bottom:24px">${heading}${history?`<div class="chart-toolbar" style="display:flex;justify-content:flex-end;margin:12px 0">${this.historyPeriodSelector()}</div>`:''}${history&&!values.length?'<p>No electricity prices are available for this period. Recorded thermostat activity is shown below.</p>':''}<div class="price-chart-viewport" style="overflow-x:auto;background:var(--tp-chart-surface,#ffffffb3);border-radius:10px;padding:12px"><svg data-range-start="${start}" data-range-end="${end}" viewBox="0 0 ${viewWidth} ${chartHeight+chartOffset}" role="${manualNames?'group':'img'}" aria-label="Electricity prices with heating timelines for rooms and zones" style="width:100%;min-width:0;height:${chartHeight+chartOffset}px;max-height:none;display:block"><defs><pattern id="suggested-heating-stripes" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><rect width="8" height="8" fill="#F39C12"/><rect width="2" height="8" fill="#f6bf65"/></pattern></defs>${cop.svg}<g transform="translate(0 ${cop.height})">${weather.svg}</g><g transform="translate(0 ${chartOffset})">${visibility.prices?`${priceCaption}${ticks}${bars}${labelRow(157+priceHeaderHeight)}`:labelRow(25)}${timelineLegend}${ordinaryRooms.length?`<text x="${manualNames?76:20}" y="${roomTop-20}" fill="var(--primary-text-color,#253f49)" style="font-size:18px;font-weight:600">${escapeHTML(this.t('Rooms'))}</text>`:''}${lanes.slice(0,ordinaryRooms.length).join('')}${zoneHeading}${zoneLanes}${garageHeading}${lanes.slice(ordinaryRooms.length).join('')}${now>start&&now<end?`<line x1="${x(now)}" x2="${x(now)}" y1="${top}" y2="${chartHeight-26}" stroke="var(--secondary-text-color,#526b75)" stroke-dasharray="4 4" stroke-width="1"/><text x="${x(now)}" y="${12+priceHeaderHeight}" text-anchor="middle" fill="var(--secondary-text-color,#526b75)" font-size="11">Now</text>`:''}${labelRow(chartHeight-8)}</g>${dayLines}</svg><div class="chart-tooltip" role="tooltip" hidden></div></div>${dashboard?'':`<details class="retention-help chart-help"><summary>${escapeHTML(this.t('About this chart'))}</summary><small data-chart-notes style="display:block;margin-top:10px;color:var(--secondary-text-color,#526b75)">${["All room timelines share the price chart’s time axis.",...(zones.length?["Zone rows show recorded heating and cooling only; off and standby periods stay empty. Plan adds suggested heating only for tariff-optimized zones."]:[]),...(history?["The selected period controls past history. Today and tomorrow are included when prices are published. Recorded activity is shown before now; future suggestions follow the current plan. Price gaps stay empty."]:[]),"Times align to 15-minute boundaries; wider views show fewer labels. Hover, focus or tap a price bar or heating period for details."].map(note=>escapeHTML(this.t(note))).join(' ')}</small></details>`}${dashboard?'':'</div></details>'}</section>`;
  }
  mountPriceChartSizing(){
    this.priceResizeObserver?.disconnect();
    const viewport=this.shadowRoot.querySelector('.price-chart-viewport');
    if(!viewport)return;
    this.bindChartDetails(viewport);
    const history=this.tab==='history';
    const resize=width=>{
      if(width<=0)return;
      const measured=Math.max(240,Math.round(width));
      if(this.priceChartWidth===measured)return;
      this.priceChartWidth=measured;
      const template=document.createElement('template');
      template.innerHTML=this.priceChart(history);
      const svg=template.content.querySelector('svg[data-range-start]');
      const current=viewport.querySelector('svg[data-range-start]');
      if(svg&&current){current.replaceWith(svg);this.translateRoot(viewport);}
    };
    // Read the rendered content box, not the custom element's pre-layout width.
    resize(viewport.clientWidth-24);
    if(typeof ResizeObserver!=='undefined'){
      this.priceResizeObserver=new ResizeObserver(entries=>resize(entries[0].contentRect.width));
      this.priceResizeObserver.observe(viewport);
    }
  }
  bindChartDetails(viewport){
    if(viewport.chartDetailsBound||!viewport.addEventListener)return;
    viewport.chartDetailsBound=true;
    const tooltip=()=>viewport.querySelector('.chart-tooltip');
    const hide=()=>{const box=tooltip();if(box)box.hidden=true;};
    const show=event=>{
      const mark=event.target.closest?.('[data-chart-detail]');
      if(!mark){hide();return;}
      const box=tooltip();if(!box)return;
      box.textContent=this.tDetails(mark.dataset.chartDetail);box.hidden=false;
      const rect=mark.getBoundingClientRect();
      const x=event.clientX??rect.left+rect.width/2,y=event.clientY??rect.top;
      const area=this.tooltipBounds();
      box.style.maxWidth=Math.max(0,area.width-16)+'px';
      box.style.maxHeight=Math.max(0,area.height-16)+'px';
      box.style.overflow='auto';
      const bounds=box.getBoundingClientRect();
      box.style.left=Math.max(area.left+8,Math.min(x+12,area.right-bounds.width-8))+'px';
      box.style.top=Math.max(area.top+8,Math.min(y+16,area.bottom-bounds.height-8))+'px';
    };
    const openTemperature=event=>{if(event.target.closest?.('[data-target-adjustment]'))return false;const opened=this.openTemperatureHistory(event);if(opened)hide();return opened;};
    viewport.addEventListener('pointermove',event=>{if(event.pointerType!=='touch')show(event);});
    viewport.addEventListener('pointerleave',hide);
    viewport.addEventListener('focusin',show);
    viewport.addEventListener('focusout',hide);
    viewport.addEventListener('click',event=>{const manual=event.target.closest?.('[data-manual-id]');if(manual?.dataset?.manualId){event.preventDefault();event.stopPropagation();if(!manual.disabled)this.openManualSession(manual.dataset.manualId,manual.dataset.manualMode,manual);return;}if(openTemperature(event))return;const box=tooltip(),mark=event.target.closest?.('[data-chart-detail]');if(box&&!box.hidden&&mark&&box.textContent===mark.dataset.chartDetail)hide();else show(event);});
    viewport.addEventListener('scroll',hide);
    viewport.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){openTemperature(event);}else if(event.key==='Escape')hide();});
  }
  tooltipBounds(){
    // The browser viewport includes HA's sidebar. Our host bounds identify the
    // content area actually available to this panel, including docked layouts.
    const panel=this.getBoundingClientRect(),viewport=window.visualViewport;
    const viewportLeft=viewport?.offsetLeft||0,viewportTop=viewport?.offsetTop||0;
    const left=Math.max(panel.left,viewportLeft),top=Math.max(panel.top,viewportTop);
    const right=Math.min(panel.right,viewportLeft+(viewport?.width||window.innerWidth));
    const bottom=Math.min(panel.bottom,viewportTop+(viewport?.height||window.innerHeight));
    return {left,top,right,bottom,width:Math.max(0,right-left),height:Math.max(0,bottom-top)};
  }
  positionSettingTooltip(help){
    const box=help.querySelector('.setting-tooltip'),anchor=help.querySelector('.setting-info,[data-tooltip-trigger]');
    if(!box||!anchor)return;
    const {left,top,width,height}=this.tooltipBounds();
    const margin=12,gap=8;
    const preferredWidth=width>600?440:304;
    Object.assign(box.style,{width:Math.min(preferredWidth,Math.max(0,width-2*margin))+'px',maxWidth:Math.max(0,width-2*margin)+'px',maxHeight:Math.max(0,height-2*margin)+'px',right:'auto',bottom:'auto'});
    const bounds=box.getBoundingClientRect();
    if(!bounds.width||!bounds.height)return;
    const trigger=anchor.getBoundingClientRect();
    const x=Math.max(left+margin,Math.min(trigger.left+trigger.width/2-bounds.width/2,left+width-margin-bounds.width));
    const above=trigger.top-gap-bounds.height;
    const y=Math.max(top+margin,Math.min(above>=top+margin?above:trigger.bottom+gap,top+height-margin-bounds.height));
    box.style.left=x+'px';box.style.top=y+'px';
  }
  bindSettingTooltips(){
    this.settingTooltipCleanup?.();
    // Native title tooltips are inaccessible to touch users. Give badges the
    // same explicit popup as info buttons, preserving their full text safely.
    const badges=this.shadowRoot.querySelectorAll('.room-heating[title],.room-forecast-badge[title],.room-learning[title],.retention-rating[title]');
    for(const anchor of badges){
      const help=document.createElement('span'),box=document.createElement('span');
      help.className='setting-help native-tooltip-help';box.className='setting-tooltip';
      box.textContent=anchor.getAttribute('title');box.setAttribute('role','tooltip');
      this.tooltipCounter=(this.tooltipCounter||0)+1;
      box.id=`thermal-pilot-tooltip-${this.tooltipCounter}`;
      anchor.removeAttribute('title');anchor.setAttribute('data-tooltip-trigger','');
      anchor.setAttribute('role','button');anchor.setAttribute('aria-describedby',box.id);
      anchor.replaceWith(help);help.append(anchor,box);
    }
    const helps=[...this.shadowRoot.querySelectorAll('.setting-help')];
    if(!helps.length)return;
    let active=null,pinned=null;
    const removers=[];
    const listen=(target,type,handler,options)=>{
      target.addEventListener(type,handler,options);
      removers.push(()=>target.removeEventListener(type,handler,options));
    };
    const anchorFor=help=>help.querySelector('.setting-info,[data-tooltip-trigger]');
    const hide=()=>{
      if(active){active.classList.remove('tooltip-open');anchorFor(active).setAttribute('aria-expanded','false');}
      active=null;pinned=null;
    };
    const show=help=>{
      if(active!==help){hide();active=help;}
      help.classList.add('tooltip-open');anchorFor(help).setAttribute('aria-expanded','true');
      this.positionSettingTooltip(help);
    };
    const toggle=help=>{
      const wasPinned=pinned===help;hide();
      if(!wasPinned){show(help);pinned=help;}
    };
    for(const help of helps){
      const anchor=anchorFor(help);anchor.setAttribute('aria-expanded','false');
      listen(help,'pointerenter',event=>{if(event.pointerType!=='touch'&&!pinned)show(help);});
      listen(help,'pointerleave',()=>{if(active===help&&pinned!==help&&!help.contains(this.shadowRoot.activeElement))hide();});
      listen(help,'focusin',()=>show(help));
      listen(help,'focusout',event=>{if(active===help&&pinned!==help&&!help.contains(event.relatedTarget))hide();});
      listen(help,'click',event=>{
        // Prevent the summary's native details action on iOS as well as our
        // accordion scrolling. Clicking the popup itself keeps it readable.
        event.preventDefault();event.stopPropagation();
        if(anchor.contains(event.target))toggle(help);
      });
      listen(help,'keydown',event=>{
        if((event.key==='Enter'||event.key===' ')&&event.target===anchor){
          event.preventDefault();event.stopPropagation();toggle(help);
        }
      });
    }
    const outside=event=>{
      if(active&&!event.composedPath().includes(active))hide();
    };
    const escape=event=>{if(event.key==='Escape'&&active){hide();event.stopPropagation();}};
    const reposition=()=>{if(active)this.positionSettingTooltip(active);};
    listen(document,'pointerdown',outside,true);listen(document,'focusin',outside,true);
    listen(document,'keydown',escape);
    listen(window,'resize',reposition);listen(window,'scroll',reposition,true);
    if(window.visualViewport){
      listen(window.visualViewport,'resize',reposition);listen(window.visualViewport,'scroll',reposition);
    }
    if(typeof ResizeObserver!=='undefined'){
      const observer=new ResizeObserver(reposition);
      observer.observe(this);
      removers.push(()=>observer.disconnect());
    }
    this.settingTooltipCleanup=()=>{
      hide();removers.forEach(remove=>remove());this.settingTooltipCleanup=null;
    };
  }
  openTemperatureHistory(event){
    const entity=event.target.closest?.('[data-temperature-history-entity]')?.dataset?.temperatureHistoryEntity;
    if(!entity)return false;
    event.preventDefault();event.stopPropagation();
    this.dispatchEvent(new CustomEvent('hass-more-info',{detail:{entityId:entity},bubbles:true,composed:true}));
    return true;
  }
  statusTemperatureAction(value,entity,label){
    if(!entity||value==null||!Number.isFinite(Number(value)))return '';
    return ` data-temperature-history-entity="${escapeHTML(entity)}" role="button" tabindex="0" aria-label="${escapeHTML(this.t('History')+': '+this.t(label))}" style="cursor:pointer"`;
  }
  bindStatusTemperatures(){
    this.shadowRoot.querySelectorAll('.compact-status [data-temperature-history-entity],.status-grid [data-temperature-history-entity],.retention-card [data-temperature-history-entity]').forEach(value=>{
      value.addEventListener('click',event=>this.openTemperatureHistory(event));
      value.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')this.openTemperatureHistory(event);});
    });
  }
  statusSparkline(key,color){
    const values=new Map();
    for(const row of this.statusHistory||[]){
      if(row[key]!=null&&Number.isFinite(Number(row[key])))values.set(row.time,Number(row[key]));
    }
    const prices=this.info?.data?.price_chart||[];
    const end=prices.length?new Date(prices.at(-1).end).getTime()/1000:Date.now()/1000;
    const start=prices.length?new Date(prices[0].start).getTime()/1000:end-86400;
    const points=[...values].filter(([time])=>time>=start&&time<=end).sort((a,b)=>a[0]-b[0]);
    if(points.length<2||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return '';
    const trendStart=points[0][0],span=Math.max(1,points.at(-1)[0]-trendStart);
    const low=Math.min(...points.map(p=>p[1])),high=Math.max(...points.map(p=>p[1]));
    const y=value=>high===low?25:42-(value-low)/(high-low)*34;
    let definitions='';
    if(key==='outdoor'){
      if(high===low)color=outdoorColor(low);
      else{
        const stops=[[low,outdoorColor(low)],...outdoorThresholds.filter(([value])=>value>low&&value<high),[high,outdoorColor(high)]];
        definitions=`<defs><linearGradient id="outdoor-trend-color" gradientUnits="userSpaceOnUse" x1="0" y1="42" x2="0" y2="8">${stops.map(([value,color])=>`<stop offset="${(value-low)/(high-low)}" stop-color="${color}"/>`).join('')}</linearGradient></defs>`;
        color='url(#outdoor-trend-color)';
      }
    }
    const segments=[];
    for(const p of points){
      if(!segments.length||p[0]-segments.at(-1).at(-1)[0]>1800)segments.push([]);
      segments.at(-1).push(p);
    }
    const paths=segments.filter(segment=>segment.length>1).map(segment=>{
      const coordinates=segment.map(([time,value])=>[(time-trendStart)/span*300,y(value)]);
      const line=coordinates.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      return `<path d="${line} L${coordinates.at(-1)[0]},50 L${coordinates[0][0]},50 Z" fill="${color}" fill-opacity=".12"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>`;
    }).join('');
    return `<svg class="status-sparkline" viewBox="0 0 300 50" preserveAspectRatio="none" aria-hidden="true">${definitions}${paths}</svg>`;
  }
  helpText(template,values={}){
    const locale=this.settings?.language==='fi'?'fi-FI':'en-GB';
    return this.t(template).replace(/\{(\w+)\}/g,(token,key)=>Object.hasOwn(values,key)?(typeof values[key]==='number'?values[key].toLocaleString(locale,{maximumFractionDigits:2}):String(values[key])):token);
  }
  collectionQuality(){
    const data=this.info?.data||{};
    const models=(this.settings?.rooms||[]).map(room=>data.rooms?.[room.id]?.model||{});
    const evidence=data.collection_evidence||{rooms:models.length,
      heating_hours:models.length?Math.min(...models.map(m=>m.heated_hours||0)):0,
      idle_hours:models.length?Math.min(...models.map(m=>m.idle_hours||0)):0};
    const heating=Math.max(0,Number(evidence.heating_hours)||0),idle=Math.max(0,Number(evidence.idle_hours)||0);
    const start=data.history_info?.started_at;
    const now=data.updated?new Date(data.updated).getTime()/1000:Date.now()/1000;
    const days=start!=null?Math.max(0,(now-start)/86400):0;
    const levels=[['Low',0,0],['Limited',3,1],['Developing',12,3],['Good',48,14],['High',120,42]];
    let level=0;
    if(evidence.rooms)levels.forEach(([,hours,age],i)=>{if(heating>=hours&&idle>=hours&&days>=age)level=i;});
    return {label:levels[level][0],level,
      detail:this.helpText('Collected-data coverage, not model reliability. Least-observed room: {heating} heating hours and {idle} idle hours. Collection began {days} days ago. Limited: 3 hours each / 1 day; Developing: 12 hours each / 3 days; Good: 48 hours each / 14 days; High: 120 hours each / 42 days. All criteria must be met. Learning continues at every level.',{heating:heating.toFixed(1).replace('.',this.settings?.language==='fi'?',':'.'),idle:idle.toFixed(1).replace('.',this.settings?.language==='fi'?',':'.'),days:Math.floor(days)})};
  }
  headerStatus(){
    const settings=this.settings||{};
    let label='Simulation',style='header-simulation',description='Simulation is active. ThermalPilot does not control heating.';
    if(!electricHeating(settings)){label='Comfort planning';style='header-observation';description='Observation and learning only; no thermostat control.';}
    else if(!settings.simulation_enabled&&settings.live_control_confirmed){
      const active=settings.heating_enabled!==false;
      label=active?'Live control':'Live control paused';style=active?'header-live':'header-paused';
      description=active?'ThermalPilot controls thermostat targets.':'Seasonal fallback temperatures are used.';
    }else if(settings.apply_season_setpoints){description='Scheduled targets remain simulated; season transitions can change thermostat targets.';}
    else if(settings.simulation_enabled===false){label='Confirmation required';style='header-paused';description='Live thermostat control is not enabled.';}
    return `<div class="header-status"><span class="status-pill ${style}" role="status">${escapeHTML(this.t(label))}</span><span class="header-status-description">${escapeHTML(this.t(description))}</span></div>`;
  }
  compactStatusView(){
    if(!this.info?.data)return '';
    const data=this.info.data,quality=this.collectionQuality(),language=this.settings?.language||'en';
    const temp=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value))?Number(value).toLocaleString(language,{maximumFractionDigits:1}):'—';
    const water=waterDistribution(this.settings)&&this.settings.water_entity;
    const metric=(label,value,entity)=>`<div class="compact-metric"><span>${escapeHTML(this.t(label))}</span><strong${this.statusTemperatureAction(value,entity,label)}>${temp(value)}<small> °C</small></strong></div>`;
    const started=data.history_info?.started_at;
    return `<aside class="compact-status${water?'':' compact-no-water'}" aria-label="${escapeHTML(this.t('ThermalPilot status'))}"><div class="compact-badges"><span class="compact-label">${escapeHTML(this.t('Operation'))}</span>${this.controlBadges('header-status-help')}</div>${metric('Outdoor temperature',data.outdoor,this.settings?.outdoor_entity)}${water?metric('Heating water temperature',data.water,this.settings?.water_entity):''}<div class="compact-secondary"><span class="compact-label">${escapeHTML(this.t('Data collection'))}</span><span class="status-pill quality quality-${quality.level}" tabindex="0" title="${escapeHTML(quality.detail)}">${escapeHTML(this.t('Data coverage: '+quality.label))}${tooltipInfoIcon}</span><details class="compact-extra" id="status-details" ${this.statusDetailsOpen?'open':''}><summary>${escapeHTML(this.t('Details'))} <span>· ${escapeHTML(data.updated?new Date(data.updated).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}):'—')}</span></summary><div class="compact-extra-body"><h3>${escapeHTML(this.t('ThermalPilot status'))}</h3><dl><dt>${escapeHTML(this.t('Stored history'))}</dt><dd>${Number(data.history_info?.rows||0).toLocaleString(language)} ${escapeHTML(this.t('samples'))} · ${((data.history_info?.bytes||0)/1048576).toFixed(1)} MiB</dd><dt>${escapeHTML(this.t('Last update'))}</dt><dd>${escapeHTML(data.updated?timeLabel(data.updated):'—')}</dd><dt>${escapeHTML(this.t('Collection started:'))}</dt><dd>${escapeHTML(started!=null?dateLabel(started*1000):this.t('No observations yet'))}</dd></dl><p>${escapeHTML(this.t(data.heating_active===false?'Observation and learning are stopped.':'Observation and learning are enabled.'))}</p></div></details></div></aside>`;
  }
  controlBadges(prefix='status-help'){
    const data=this.info?.data||{},settings=this.settings||{};
    const live=settings.simulation_enabled===false&&settings.live_control_confirmed;
    const mode=!electricHeating(settings)?'Comfort planning':live?(settings.heating_enabled===false?'Live control paused':'Live control'):settings.simulation_enabled===false?'Confirmation required':settings.apply_season_setpoints?'Season setpoint control':'Simulation';
    const operationLabel=`${this.t(data.heating_active===false?'Passive':'Active')}: ${this.t(mode)}`;
    const modeHelp=live?'ThermalPilot applies scheduled thermostat targets while active. Essential data loss returns affected rooms to their seasonal fallback temperature.':settings.simulation_enabled===false?'Live control has not been confirmed. Save and confirm to enable real thermostat control.':settings.apply_season_setpoints?'Active/Passive season setpoints can change real thermostats. Heating schedules remain simulated.':'Simulation is active. ThermalPilot does not control heating.';
    const status=data.source_status;
    const missing=status?Object.entries({prices:'Electricity prices from now',outdoor:'Outdoor temperature',water:'Heating water temperature'}).filter(([key])=>(key!=='water'||status.water_required!==false)&&(key!=='prices'||status.prices_required!==false)&&!status[key]).map(([,name])=>name):[];
    const sourceLabel=!status?'Sources not checked':missing.length?'Sources missing':'Sources ready';
    const sourceHelp=!electricHeating(settings)?'Comfort planning uses room temperature, outdoor temperature and observed heating demand. Electricity prices are not required; no heating schedules or thermostat commands are generated.':!status?'Source checks are available while ThermalPilot is active.':missing.length?`${this.t('Missing or unusable:')} ${missing.map(name=>this.t(name)).join(', ')}.`:`Electricity prices from now and outdoor temperature${status.water_required===false?'':' and heating water temperature'} are available. Weather forecast details are reported separately below.`;
    const season=data.fallback_season?.season;
    const seasonHelp=this.t('Summer temperature (°C)')+': '+Number(settings.summer_minimum_temperature??6).toLocaleString(settings.language||'en')+' °C. '+this.t(settingHelp.summer_minimum_temperature);
    const badge=(style,label,help,id)=>`<details class="status-help"><summary class="status-pill ${style}" aria-describedby="${prefix}-${id}"><span data-user-text>${escapeHTML(this.t(label))}</span>${tooltipInfoIcon}</summary><span class="status-tooltip" id="${prefix}-${id}" data-user-text>${escapeHTML(this.t(help))}</span></details>`;
    return `<div class="status-badges">${badge(data.heating_active===false?'paused':'active',operationLabel,modeHelp,'mode')}${badge(!status?'neutral':missing.length?'missing':'active',sourceLabel,sourceHelp,'sources')}${season?badge(season==='summer'?'summer':'winter',season==='summer'?'Summer fallback':'Winter fallback',seasonHelp,'season'):''}</div>`;
  }
  sortRetention(key){
    if(!['room','drop','hours','speed'].includes(key))return;
    const current=this.retentionSort||{key:'room',direction:1};
    this.retentionSort={key,direction:current.key===key?-current.direction:1};
    this.render();
    this.shadowRoot.querySelector(`[data-retention-sort="${key}"]`)?.focus({preventScroll:true});
  }
  heatRetentionView(){
    const rooms=Object.entries(this.info?.data?.rooms||{}).filter(([,room])=>room.heat_retention);
    if(!rooms.length)return '';
    const isGarage=([id,room])=>Boolean(room.is_garage||this.settings?.rooms?.find(item=>item.id===id)?.is_garage);
    const sort=this.retentionSort||{key:'room',direction:1};
    const sortValue=room=>{const value=room.heat_retention;if(!value.updated&&sort.key!=='speed')return NaN;if(sort.key==='drop')return value.drop_6h;if(sort.key==='hours')return value.hours_per_degree;const rating=retentionRating(value);return ['very-fast','fast','moderate','slow','very-slow'].indexOf(rating.level);};
    rooms.sort((a,b)=>{
      // Garages remain a separate group for every sorting column and direction.
      const group=Number(isGarage(a))-Number(isGarage(b));
      if(group)return group;
      const nameOrder=compareRoomNames(a[1],b[1],this.settings?.language||this._hass?.language);
      if(sort.key==='room')return sort.direction*nameOrder;
      if(!this.retentionSort&&isGarage(a))return nameOrder;
      const av=sortValue(a[1]),bv=sortValue(b[1]);
      const valid=value=>Number.isFinite(value)&&!(sort.key==='speed'&&value<0);
      return Number(!valid(av))-Number(!valid(bv))||(valid(av)&&valid(bv)?sort.direction*(av-bv):0)||nameOrder;
    });
    const sortHeader=(key,label)=>`<th class="${key==='drop'||key==='hours'?'retention-numeric':''}" aria-sort="${sort.key===key?(sort.direction===1?'ascending':'descending'):'none'}"><button type="button" class="retention-sort" data-retention-sort="${key}"><span>${escapeHTML(this.t(label))}</span> <span aria-hidden="true">${sort.key===key?(sort.direction===1?'↑':'↓'):'↕\uFE0E'}</span></button></th>`;
    const retentionHistory=(id,metric,value,label)=>{
      const entity=this.info?.data?.retention_history_entities?.[id]?.[metric];
      return entity?`<span${this.statusTemperatureAction(value,entity,label)}>${value}</span>`:`${value}`;
    };
    const max=Math.max(...rooms.filter(([,r])=>r.heat_retention.updated).map(([,r])=>r.heat_retention.drop_6h),.01);
    const reference=rooms.map(([,room])=>room.heat_retention).find(value=>value.reference_hours>0);
    const comparison=reference?`<p class="retention-reference">${escapeHTML(this.t('Construction reference:'))} <strong>${escapeHTML(this.t(houseOptionLabels[reference.reference_type]||reference.reference_type))}</strong> · ${reference.reference_hours.toFixed(1)} ${escapeHTML(this.t('hours per 1°C drop'))}. ${escapeHTML(this.t('House badges compare cooling speed with this approximate reference. Garage badges use the general bands.'))}</p>`:'';
    // Show both scales: house rooms can use a construction reference, while
    // garages and rooms without one use absolute cooling times.
    const relativeRanges=['< 0.5×','0.5–< 0.8×','0.8–< 1.25×','1.25–< 2×','≥ 2×'];
    const timeRanges=['< 1 h','1–< 2 h','2–< 4 h','4–< 8 h','≥ 8 h'];
    const scaleRows=retentionBands.map((band,index)=>`<tr><th scope="row"><span class="retention-rating retention-rating-${band.level}">${escapeHTML(this.t(relativeRetentionBands[index].label))}${relativeRetentionBands[index].label!==band.label?' / '+escapeHTML(this.t(band.label)):''}</span></th><td>${escapeHTML(relativeRanges[index])}</td><td>${escapeHTML(timeRanges[index])}</td></tr>`).join('');
    const scaleTable=`<table class="retention-scale" aria-label="${escapeHTML(this.t('Cooling speed'))}"><thead><tr><th scope="col">${escapeHTML(this.t('Cooling speed'))}</th><th scope="col">${escapeHTML(this.t('Relative to construction reference:'))}</th><th scope="col">${escapeHTML(this.t('1°C drop'))}</th></tr></thead><tbody>${scaleRows}<tr><th scope="row"><span class="retention-rating retention-rating-learning">${escapeHTML(this.t('Learning'))}</span></th><td colspan="2">${escapeHTML(this.t('Waiting for learned heat-loss parameters.'))}</td></tr></tbody></table>`;
    return `<section class="retention-card"><details class="observation-accordion" id="retention-accordion" ${this.retentionOpen!==false?'open':''}><summary><h2>Room heat retention</h2></summary><div class="observation-content"><p class="retention-summary">${escapeHTML(this.t('Modelled cooling: 20°C indoors · −10°C outdoors · heating off'))}</p><div class="scroll"><table><thead><tr>${sortHeader('room','Room')}${sortHeader('drop','6-hour loss')}${sortHeader('hours','1°C drop')}${sortHeader('speed','Cooling speed')}</tr></thead><tbody>${rooms.map(([id,r])=>{const v=r.heat_retention,rating=retentionRating(v);return `<tr data-retention-drop="${v.drop_6h}" data-retention-hours="${v.hours_per_degree}" data-retention-speed="${['very-fast','fast','moderate','slow','very-slow'].indexOf(rating.level)}" class="${isGarage([id,r])?'garage-retention-row':''}"><td><span data-user-text>${escapeHTML(r.name)}</span></td><td class="retention-numeric">${rating.level!=='learning'?`<span class="retention-bar" aria-hidden="true"><i style="width:${100*v.drop_6h/max}%"></i></span><span class="retention-value">${retentionHistory(id,'drop_6h',v.drop_6h.toFixed(2),'6-hour loss')} °C</span>`:''}</td><td class="retention-numeric">${rating.level!=='learning'?`${retentionHistory(id,'hours_per_degree',v.hours_per_degree.toFixed(1),'1°C drop')} hours`:''}</td><td><span class="retention-rating retention-rating-${rating.level}" data-retention-rating="${rating.level}" tabindex="0" title="${escapeHTML(rating.level==='learning'?this.t('Waiting for learned heat-loss parameters.'):rating.relative?this.t('Relative to construction reference:')+' '+this.t(houseOptionLabels[v.reference_type]||v.reference_type)+' · '+v.reference_hours.toFixed(1)+' h · '+rating.ratio.toFixed(2)+'× '+this.t('reference cooling time')+'. '+this.t('Not an energy-efficiency or insulation class.'):this.t('Provisional cooling-speed band for the reference test; not an energy-efficiency or insulation class.'))}">${escapeHTML(this.t(rating.label))}${tooltipInfoIcon}</span></td></tr>`;}).join('')}</tbody></table></div><details class="retention-help" id="retention-help" ${this.retentionHelpOpen?'open':''}><summary>${escapeHTML(this.t('About these estimates'))}</summary><p>Compare rooms under the same conditions: <b>20°C indoors, −10°C outdoors</b>, without heating, remaining slab warmth or appliance heat. Lower temperature loss means slower modeled cooling. This is a model estimate, not measured energy efficiency or an insulation rating.</p>${comparison}${scaleTable}<p>Cooling-speed bands are provisional: under 1 h, 1–2 h, 2–4 h, 4–8 h, and 8 h or longer per 1°C drop. For a selected house type, badges instead compare with that type: under 0.5×, 0.5–0.8×, 0.8–1.25×, 1.25–2×, and at least 2× its reference cooling time. Initial rooms share starting estimates and remain unrated. Comparisons become more useful as their heat-loss parameters adapt to observations. Wind, ventilation, sensor placement and unmeasured heat sources can affect the estimates. The listed time describes this reference test, not how long heating can safely remain off in your home.</p></details></div></details></section>`;
  }
  isGarageRoom(id,room){return Boolean(room?.is_garage||this.settings?.rooms?.find(item=>item.id===id)?.is_garage||this.info?.data?.rooms?.[id]?.is_garage);}
  overview(){
    const quality=this.collectionQuality();const data=this.info.data||{};const rooms=Object.entries(data.rooms||{}).sort((a,b)=>Number(this.isGarageRoom(a[0],a[1]))-Number(this.isGarageRoom(b[0],b[1]))||compareRoomNames(a[1],b[1]));
    return `<section class="status-card"><div class="status-heading"><h2>ThermalPilot status</h2></div>
    <dl class="status-grid">
      <div class="status-block"><dt>Operation</dt><dd>${this.controlBadges()}</dd><small>${data.heating_active===false?'Observation and learning are stopped.':'Observation and learning are enabled.'}</small></div>
      <div class="status-block status-temperature" tabindex="0" title="${escapeHTML(this.t('Recorded temperatures within the electricity price chart period, fitted across the card width'))}"><dt>Outdoor temperature ${tooltipInfoIcon}</dt><dd${this.statusTemperatureAction(data.outdoor,this.settings?.outdoor_entity,'Outdoor temperature')}>${escapeHTML(data.outdoor??'—')}<span class="status-unit"> °C</span></dd>${this.statusSparkline('outdoor','#2196f3')}</div>
${waterDistribution(this.settings)&&this.settings?.water_entity?`      <div class="status-block status-temperature" tabindex="0" title="${escapeHTML(this.t('Recorded temperatures within the electricity price chart period, fitted across the card width'))}"><dt>Heating water temperature ${tooltipInfoIcon}</dt><dd${this.statusTemperatureAction(data.water,this.settings?.water_entity,'Heating water temperature')}>${escapeHTML(data.water??'—')}<span class="status-unit"> °C</span></dd>${this.statusSparkline('water','#16b957')}</div>`:''}
      <div class="status-block"><dt>Data collection</dt><dd><span class="status-pill ${data.collection?.collecting?'active':'paused'}">${data.collection?.collecting?'Active':'Paused'}</span><span class="status-pill quality quality-${quality.level}" tabindex="0" title="${escapeHTML(quality.detail)}">${escapeHTML(this.t('Data coverage: '+quality.label))}${tooltipInfoIcon}</span></dd></div>
      <div class="status-block"><dt>Stored history</dt><dd>${escapeHTML(Number(data.history_info?.rows??0).toLocaleString())}<span class="status-unit"> samples</span></dd><small class="collection-date">Collection started: ${data.history_info?.started_at!=null?escapeHTML(dateLabel(data.history_info.started_at*1000)):'No observations yet'}</small><small>Local database: ${((data.history_info?.bytes??0)/1048576).toFixed(1)} MiB</small></div>
      <div class="status-block"><dt>Last update</dt><dd class="status-time">${escapeHTML(data.updated?timeLabel(data.updated):'—')}</dd><small>Latest calculation and observation.</small></div>
    </dl></section>${!rooms.length?'<section>Add rooms on the Settings page.</section>':''}
    <div class="plan-comparison-grid">${(electricHeating(this.settings)||this.settings.heating_zones?.length||this.settings.fireplaces?.length)?this.priceChart(false):''}${this.heatRetentionView()}</div>${rooms.length?`<section class="room-cards-group"><details class="observation-accordion" id="room-cards-accordion" ${this.historySectionOpen('overview:room-cards-accordion',false)?'open':''}><summary><h2>${escapeHTML(this.t('Rooms'))}</h2></summary><div class="observation-content"><div class="observation-cards">${rooms.map(([roomId,room])=>this.roomPlanView(roomId,room)).join('')}</div></div></details></section>`:''}`;
  }
  roomPlanView(roomId, room) {
    const plan = room.plan;
    let status = 'No suggestion';
    if (room.pump_suggestion) {
      const pumpMode = room.pump_suggestion.mode;
      if (room.is_garage&&room.garage_heat_source&&room.garage_heat_source!=='air_to_air') status=pumpMode==='heat'?'Thermostat: Heating':'Thermostat: Off';
      else if (pumpMode === 'heat') status = room.pump_suggestion.clamp_target ? 'Heat pump: Thermostat control' : 'Heat pump: Heating';
      else if (pumpMode === 'cool') status = 'Heat pump: Cooling';
      else if (pumpMode === 'off') status = 'Heat pump: Off';
      else status = 'Heat pump: Fan only';
    } else if (room.zone_monitor) {
      status = 'Shared zone';
    } else if (plan) {
      if (plan.heat) status = 'Boosted thermostat target';
      else if (plan.mode === 'normal') status = 'Normal thermostat target temperature';
      else status = 'Reduced thermostat target temperature';
    }

    if(room.heating_assistance?.floor_target!=null)status=this.t(room.heating_assistance.reason);

    if(room.away&&!room.pump_suggestion)status=this.t('Away temperatures active');

    const routineReasons = [
      'Away temperature schedule',
      'Heat pump preferred; floor heating assists when needed.',
      'Heat storage or a bridging run ahead of predicted cooling.',
      'Heating is planned later; no boost is suggested now.',
      'Garage temperature cycle: heat below the lower limit; fan-only after the upper limit. Warm weather turns the pump off.',
      'Garage temperature cycle: heat below the lower limit; stop at the upper limit.',
    ];
    let explanation = '';
    if (room.error) {
      explanation = statusNotice(room.error, 'error');
    } else if (plan?.reason?.startsWith('Temperature limit risk:')) {
      explanation = statusNotice(plan.reason, 'warning');
    } else if (!routineReasons.includes(plan?.reason)) {
      explanation = `<p>${escapeHTML(plan?.reason || 'Waiting for data.')}</p>`;
    }

    let pumpHelp = '';
    if (room.pump_suggestion) {
      const details = [this.t(room.pump_suggestion.reason || '')];
      if(room.pump_suggestion.fireplaces?.length)details.push(room.pump_suggestion.fireplaces.join(', '));
      if (room.is_garage) {
        const configuredRoom = this.settings.rooms.find(item => item.id === roomId);
        details.push(this.t('Garage limits') + ': '
          + (configuredRoom?.garage_minimum ?? '—') + '–'
          + (configuredRoom?.garage_maximum ?? '—') + ' °C');
        if (routineReasons.includes(plan?.reason)) details.push(this.t(plan.reason));
      }
      const helpId = `pump-help-${escapeHTML(roomId)}`;
      pumpHelp = `<span class="setting-help"><button type="button" class="setting-info" aria-label="${escapeHTML(this.t(status))}" aria-describedby="${helpId}">${tooltipInfoIcon}</button><span id="${helpId}" class="setting-tooltip" role="tooltip">${escapeHTML(details.join(' · '))}</span></span>`;
    }

    const targetLabel = room.air_control
      ? 'Heat pump heating setpoint' : 'Suggested thermostat target';
    const confirmedTarget = room.pump_suggestion?.clamp_target && room.pump_control?.confirmed
      ? room.pump_control.target : null;
    const target = room.air_control
      ? confirmedTarget ?? room.pump_suggestion?.target : room.pump_suggestion?.target ?? room.away?.heating_target ?? room.heating_assistance?.floor_target ?? plan?.setpoint;
    const garageClass = this.isGarageRoom(roomId, room) ? ' garage-observation-card' : '';
    return `<section class="observation-card${garageClass}">
      <details class="observation-accordion" data-room-accordion="${escapeHTML(roomId)}" ${this.roomDisclosureOpen(roomId) ? 'open' : ''}>
        <summary><h2><span data-user-text>${escapeHTML(room.name)}</span> ${this.roomHeatingBadge(room, roomId)} ${this.learningBadge(room)} <small>${escapeHTML(status)}${pumpHelp}</small></h2></summary>
        <div class="observation-content">
          <div class="metrics"><div>Measured<strong>${escapeHTML(room.temperature ?? '—')} °C</strong></div><div>${targetLabel}<strong>${escapeHTML(target ?? '—')} °C</strong></div></div>
          ${explanation}
          ${room.pump_control && !room.pump_control.confirmed ? `<p class="notice notice-info">${room.air_control?'Waiting for pump confirmation:':'Waiting for thermostat confirmation:'} <span>${escapeHTML(this.t(pumpStageLabels[room.pump_control.stage] || room.pump_control.stage))}</span></p>` : ''}
          ${room.zone_monitor ? '<p>This room is monitored as part of a shared zone. The zone issues one set of commands to its pump.</p>' : ''}
          ${this.learningView(room)}
          ${plan ? this.roomTimingView(roomId, room) : ''}
        </div>
      </details>
    </section>`;
  }

  roomTimingView(roomId, room) {
    const plan = room.plan;
    const heading = room.air_control ? 'Heat pump timing' : 'Thermostat timing';
    const helpId = `timing-help-${escapeHTML(roomId)}`;
    const helpText = room.pump_uses_setpoints
      ? 'These heating targets use the pump’s own thermostat. The pump’s supported temperature limits apply.'
      : room.air_control
      ? 'Heat means heating mode; pauses use fan-only. Room sensors govern temperature limits. The device setpoint is separate from those limits.'
      : 'Target changes include the shared start/stop offsets. The temperature forecast models the planned heating period; actual valve and heat-pump delays must be checked against observations.';
    const help = `<span class="setting-help"><button type="button" class="setting-info" aria-label="${escapeHTML(this.t(heading))}" aria-describedby="${helpId}">${tooltipInfoIcon}</button><span id="${helpId}" class="setting-tooltip" role="tooltip">${escapeHTML(this.t(helpText))}</span></span>`;
    const rows = (plan.commands || []).slice(-3).map(command => {
      let action;
      let target;
      if (plan.air_control) {
        action = command.mode === 'boost' ? 'Heat' : 'Fan only';
        target = command.mode === 'boost' ? plan.device_target : '—';
      } else {
        if (command.action === 'raise') action = 'Boost';
        else if (command.action === 'restore') action = 'Restore normal';
        else action = 'Reduce';
        target = command.setpoint;
      }
      return `<tr><td>${escapeHTML(timeLabel(command.time))}</td><td>${action}</td><td>${target}</td></tr>`;
    }).join('');

    return `<h3 class="timing-heading">${heading}${help}</h3>
      <div class="scroll timing-table"><table>
        <thead><tr><th>Change target at</th><th>Planned target change</th><th>Target (°C)</th></tr></thead>
        <tbody>${rows || '<tr><td class="empty-table" colspan="3">No thermostat target changes planned.</td></tr>'}</tbody>
      </table></div>
      ${this.chart(plan.slots, 'temperature', null, 'Saved forecast', {fillWidth: true})}`;
  }

  historySectionOpen(section,defaultOpen=true){
    const key=`thermal_pilot:${this.entry||'preview'}:history-sections`;
    if(this.historySectionStorageKey!==key){
      this.historySectionStorageKey=key;this.historySectionState={};
      try{const saved=JSON.parse(globalThis.localStorage?.getItem(key)||'{}');this.historySectionState=Object.fromEntries(Object.entries(saved||{}).filter(([,value])=>typeof value==='boolean'));}catch(error){}
    }
    return this.historySectionState[section]??defaultOpen;
  }
  bindHistorySections(){
    this.historySectionOpen('about');
    const tab=this.tab;
    this.shadowRoot.querySelectorAll('details.observation-accordion,details.retention-help,details[data-settings-disclosure]').forEach(details=>{
      const name=details.dataset.historySection||(details.dataset.roomAccordion?`${tab}:room:${details.dataset.roomAccordion}`:details.dataset.settingsDisclosure?`${tab}:settings:${details.dataset.settingsDisclosure}`:details.id?`${tab}:${details.id}`:details.classList.contains('chart-help')?`${tab}:chart-help`:null);
      if(!name)return;
      if(typeof this.historySectionState[name]==='boolean')details.open=this.historySectionState[name];
      details.addEventListener('toggle',()=>{
        // Ignore delayed toggle events from elements replaced by a refresh.
        if(details.getRootNode()!==this.shadowRoot)return;
        this.historySectionState[name]=details.open;
        try{globalThis.localStorage?.setItem(this.historySectionStorageKey,JSON.stringify(this.historySectionState));}catch(error){}
      });
    });
  }
  sortArchives(key){
    if(!['room','observations','drop_6h','hours_per_degree','speed'].includes(key))return;
    const current=this.archiveSort||{key:'room',direction:1};
    this.archiveSort={key,direction:current.key===key?-current.direction:1};
    this.render();
    this.shadowRoot.querySelector(`[data-archive-sort="${key}"]`)?.focus({preventScroll:true});
  }
  seasonArchivesView(){
    const rooms=this.settings?.rooms||[],language=this.settings?.language||'en';
    const room=row=>rooms.find(item=>item.id===row.room_id);
    const summaries=this.info?.data?.season_summaries||[];
    const latestSeason=summaries.map(row=>String(row.season)).sort().at(-1);
    // Same reference test and rounding as model.heat_retention, using the saved season model.
    const retention=new Map(summaries.map(row=>{
      const loss=Number(row.model?.loss),valid=row.model?.loss!=null&&Number.isFinite(loss)&&loss>0;
      const model=row.model||{},updated=Boolean(model.retention_learned)||model.parameter_updates>0||(!Object.hasOwn(model,'parameter_updates')&&Math.abs(loss-.007)>1e-9&&model.heated_hours>=12&&model.idle_hours>=12);
      return [row,valid?{updated,drop_6h:Number((30*(-Math.expm1(-loss*6))).toFixed(3)),hours_per_degree:Number((-Math.log(29/30)/loss).toFixed(2))}:{}];
    }));
    const max=Math.max(.01,...summaries.filter(row=>String(row.season)===latestSeason).map(row=>retention.get(row).drop_6h||0));
    const sort=this.archiveSort||{key:'room',direction:1};
    const name=row=>({name:room(row)?.name||row.room_id});
    const rating=row=>retentionRating(retention.get(row));
    const badge=row=>{const value=rating(row);return `<span class="retention-rating retention-rating-${value.level}" tabindex="0" title="${escapeHTML(this.t(value.level==='learning'?'Waiting for learned heat-loss parameters.':'Provisional cooling-speed band for the reference test; not an energy-efficiency or insulation class.'))}">${escapeHTML(this.t(value.label))}${tooltipInfoIcon}</span>`;};
    const value=row=>sort.key==='observations'?row.statistics?.samples:sort.key==='speed'?(rating(row).level==='learning'?null:['very-fast','fast','moderate','slow','very-slow'].indexOf(rating(row).level)):retention.get(row)[sort.key];
    const valid=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value));
    const rows=summaries.filter(row=>String(row.season)===latestSeason).sort((a,b)=>{
      const group=Number(Boolean(room(a)?.is_garage))-Number(Boolean(room(b)?.is_garage));if(group)return group;
      if(sort.key==='room')return sort.direction*compareRoomNames(name(a),name(b));
      const av=value(a),bv=value(b);
      return Number(!valid(av))-Number(!valid(bv))||(valid(av)&&valid(bv)?sort.direction*(Number(av)-Number(bv)):0)||compareRoomNames(name(a),name(b));
    });
    const observations=value=>escapeHTML(new Intl.NumberFormat('en',{maximumFractionDigits:0}).format(Number(value)||0).replaceAll(',', '\u00a0'));
    const title=this.t('Last heating season');
    const number=(value,digits)=>value!==null&&value!==undefined&&Number.isFinite(Number(value))?escapeHTML(new Intl.NumberFormat(language,{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(Number(value))):'—';
    return `<section class="season-archives"><details class="observation-accordion" data-history-section="season" ${this.historySectionOpen('season')?'open':''}><summary><h2>${escapeHTML(title)}</h2></summary><div class="observation-content"><p>${escapeHTML(this.t('Modelled cooling: 20°C indoors · −10°C outdoors · heating off'))}</p>${rows.length?`<div class="scroll"><table><thead><tr>${[['room','Room',''],['observations','Observations',''],['drop_6h','6-hour loss',''],['hours_per_degree','1°C drop',''],['speed','Cooling speed','']].map(([key,label,unit],index)=>`<th scope="col"${index>0&&index<4?' class="archive-numeric"':''} aria-sort="${sort.key===key?(sort.direction===1?'ascending':'descending'):'none'}"><button type="button" class="retention-sort" data-archive-sort="${key}"><span>${escapeHTML(this.t(label))}${unit}</span> <span aria-hidden="true">${sort.key===key?(sort.direction===1?'↑':'↓'):'↕\uFE0E'}</span></button></th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr${room(row)?.is_garage?' class="garage-archive-row"':''}><td data-user-text>${escapeHTML(room(row)?.name||row.room_id)}</td><td class="archive-numeric">${observations(row.statistics?.samples)}</td><td class="archive-numeric">${retention.get(row).drop_6h!=null?`<span class="retention-bar" aria-hidden="true"><i style="width:${100*retention.get(row).drop_6h/max}%"></i></span>`:''}${number(retention.get(row).drop_6h,2)}${retention.get(row).drop_6h!=null?' °C':''}</td><td class="archive-numeric">${number(retention.get(row).hours_per_degree,1)}${retention.get(row).hours_per_degree!=null?' '+escapeHTML(this.t('hours')):''}</td><td>${badge(row)}</td></tr>`).join('')}</tbody></table></div>`:`<p>${escapeHTML(this.t('No completed heating season yet.'))}</p>`}</div></details></section>`;
  }
  restoreHistoryPeriod(){
    const key=`thermal_pilot:${this.entry||'preview'}:history-period`;
    if(this.historyPeriodStorageKey===key)return;
    this.historyPeriodStorageKey=key;this.historyHours=48;
    try{const hours=Number(globalThis.localStorage?.getItem(key));if([24,48,96,144].includes(hours))this.historyHours=hours;}catch(error){}
  }
  async setHistoryPeriod(hours,controlId){
    hours=Number(hours);if(![24,48,96,144].includes(hours))return;
    this.restoreHistoryPeriod();
    this.historyHours=hours;
    try{globalThis.localStorage?.setItem(this.historyPeriodStorageKey,String(hours));}catch(error){}
    this.shadowRoot.querySelectorAll('[data-history-period]').forEach(select=>select.value=String(hours));
    this.historyPeriodFocus=controlId;
    if(this.loading){this.historyPeriodReload=true;return;}
    await this.load();
    this.shadowRoot.getElementById?.(this.historyPeriodFocus)?.focus({preventScroll:true});
  }
  historyPeriodSelector(roomId=null){
    return `<label class="history-period">${escapeHTML(this.t('Period'))}<select id="${roomId===null?'history-hours':'room-history-hours-'+escapeHTML(roomId)}" data-history-period>${[[24,'2 days'],[48,'3 days'],[96,'5 days'],[144,'7 days']].map(([hours,label])=>`<option value="${hours}" ${hours===this.historyHours?'selected':''}>${escapeHTML(this.t(label))}</option>`).join('')}</select></label>`;
  }
  historyView(){
    return `${(electricHeating(this.settings)||this.settings.heating_zones?.length||this.settings.fireplaces?.length)?this.priceChart(true):this.historyPeriodSelector()}<div class="history-summary"><section><details class="observation-accordion" data-history-section="about" ${this.historySectionOpen('about')?'open':''}><summary><h2>${escapeHTML(this.t('About this history'))}</h2></summary><div class="observation-content"><dl class="history-explanation"><div><dt>${escapeHTML(this.t("Recorded data"))}</dt><dd>${escapeHTML(this.t("Room sensors provide the temperatures that were actually measured. The charts also show recorded heating activity and earlier heating suggestions."))}</dd></div><div><dt>${escapeHTML(this.t("Forecast accuracy"))}</dt><dd>${escapeHTML(this.t("Each room card compares an earlier forecast with the temperature measured later. It also checks whether simply predicting that the temperature would stay unchanged would have worked better."))}</dd></div><div><dt>${escapeHTML(this.t("During simulation"))}</dt><dd>${escapeHTML(this.t("Forecasts assume that ThermalPilot\u2019s suggested heating plan is followed. In simulation, your existing controls may heat differently. A forecast error can therefore come from a different heating schedule as well as from the model."))}</dd></div></dl></div></details></section>
    ${this.seasonArchivesView()}</div><section class="room-cards-group"><details class="observation-accordion" id="room-cards-accordion" ${this.historySectionOpen('history:room-cards-accordion',false)?'open':''}><summary><h2>${escapeHTML(this.t('Rooms'))}</h2></summary><div class="observation-content"><div class="observation-cards">${[...this.settings.rooms].sort((a,b)=>Number(this.isGarageRoom(a.id,a))-Number(this.isGarageRoom(b.id,b))||compareRoomNames(a,b)).map(room=>{const rows=(this.history||[]).filter(r=>r.room_id===room.id);return `<section class="observation-card${this.isGarageRoom(room.id,room)?' garage-observation-card':''}"><details class="observation-accordion" data-room-accordion="${escapeHTML(room.id)}" ${this.roomDisclosureOpen(room.id)?'open':''}><summary><h2><span data-user-text>${escapeHTML(room.name)}</span> ${this.roomHeatingBadge(this.info.data?.rooms?.[room.id],room.id)} ${this.learningBadge(this.info.data?.rooms?.[room.id])}</h2></summary><div class="observation-content">${this.forecastHistoryView(rows,room.id)}</div></details></section>`;}).join('')}</div></div></details></section>`;
  }
  hasUnsavedSettings(){
    if(!this.info?.settings||!this.settings)return false;
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
    return JSON.stringify(canonical(this.settings))!==JSON.stringify(canonical(this.info.settings));
  }
  updateUnsavedNotice(){
    this.capture();
    const unsaved=this.hasUnsavedSettings();
    const notice=this.shadowRoot.querySelector('#settings-unsaved');
    const cancel=this.shadowRoot.querySelector('#settings-cancel');
    if(notice)notice.hidden=!unsaved;
    if(cancel)cancel.hidden=!unsaved;
  }
  discardSettingsChanges(){
    if(this.saving||this.backupBusy||!this.hasUnsavedSettings())return;
    if(!confirm(this.t('Discard unsaved changes on both settings tabs?')))return;
    this.settings=structuredClone(this.info.settings);
    this.zoneRoomDrafts={};
    this.sourceCheck=null;
    this.sourceCheckError='';
    clearTimeout(this.saveMessageTimer);
    this.saveConfirmation=false;
    this.message='';
    this.render();
    this.shadowRoot.querySelector('#settings button[type=submit]')?.focus?.({preventScroll:true});
  }
  switchTab(tab){
    if(tab===this.tab)return;
    if(['settings','rooms'].includes(this.tab)){
      this.capture();
      if(['settings','rooms'].includes(tab)){this.tab=tab;this.render();return;}
      if(this.hasUnsavedSettings()&&!confirm(this.t('You have unsaved settings. Discard these changes and switch tabs?')))return;
    }
    this.tab=tab;this.loaded=false;this.load();
  }
  settingsFieldTarget(name){
    const [prefix,key]=name.split('.');
    if(prefix==='source')return [this.settings,key];
    if(prefix.startsWith('fireplace'))return [this.settings.fireplaces[Number(prefix.slice(9))],key];
    const items=prefix.startsWith('zone')?this.settings.heating_zones:this.settings.rooms;
    return [items[Number(prefix.slice(4))],key];
  }
  capture(preserveEmptyLists=false){
    const target=name=>this.settingsFieldTarget(name);
    this.shadowRoot.querySelectorAll('[data-field]').forEach(input=>{const [obj,key]=target(input.dataset.field);obj[key]=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value;});
    const assignments=new Map(),editedZones=new Set(),sharedEdits=[],emptySharedLists=new Map();
    this.shadowRoot.querySelectorAll('[data-entity-list]').forEach(list=>{
      const [obj,key]=target(list.dataset.entityList);const selected=[...list.querySelectorAll('[data-entity-item]')].map(select=>select.value);
      if(key==='shared_air_rooms'){
        const ids=selected.filter(Boolean);
        // Native input and change events can capture twice before rerendering.
        // Compare with the rendered selection: reciprocal model updates must
        // never make an untouched peer dropdown look like a user's removal.
        const previous=JSON.parse(list.dataset.sharedAirSelection);
        if(JSON.stringify(ids.slice().sort())!==JSON.stringify(previous.slice().sort()))sharedEdits.push([obj.id,ids]);
        if(preserveEmptyLists)emptySharedLists.set(obj.id,selected.length-ids.length);
      }else if(key==='zone_rooms'){
        this.zoneRoomDrafts??={};this.zoneRoomDrafts[obj.id]=preserveEmptyLists?selected:selected.filter(Boolean);editedZones.add(obj.id);
        for(const id of selected.filter(Boolean))assignments.set(id,obj.id);
      }else obj[key]=preserveEmptyLists?selected:selected.filter(Boolean);
    });
    const ordinaryRoomIds=new Set(this.settings.rooms.filter(room=>!room.is_garage).map(room=>room.id));
    for(const fireplace of this.settings.fireplaces||[]){
      fireplace.room_ids=(fireplace.room_ids||[]).filter(id=>ordinaryRoomIds.has(id)||(preserveEmptyLists&&!id));
    }
    for(const [id,selected] of sharedEdits)this.updateSharedAirRooms(id,selected);
    for(const room of this.settings.rooms){
      if(!this.sharedAirEligible(room)&&room.shared_air_rooms?.length)this.updateSharedAirRooms(room.id,[]);
      const blanks=emptySharedLists.get(room.id)||0;
      room.shared_air_rooms=[...(room.shared_air_rooms||[]).filter(Boolean),...Array(blanks).fill('')];
    }
    this.settings.rooms.forEach(room=>{if(editedZones.has(room.heating_zone_id))room.heating_zone_id='';if(assignments.has(room.id))room.heating_zone_id=assignments.get(room.id);});
    for(const zone of this.settings.heating_zones||[]){
      if(!editedZones.has(zone.id))continue;
      const members=this.settings.rooms.filter(room=>room.heating_zone_id===zone.id);
      if(!members.some(room=>room.id===zone.main_room_id))zone.main_room_id=members[0]?.id||'';
    }

  }

  render(){
    tpI18n.watch(this,this.settings?.language||'en');
    const settingsOpen=new Set([...this.shadowRoot.querySelectorAll('[data-settings-disclosure]')].filter(d=>d.open).map(d=>d.dataset.settingsDisclosure));
    this.shadowRoot.innerHTML=`<style>.header-status{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0 0}.header-status .status-pill{font-size:21px;font-weight:600;padding:8px 15px;border-radius:10px}.header-status-description{font-size:14px;color:var(--secondary-text-color,#60737b)}.status-pill.header-simulation{background:#e74c3c20;border-left:3px solid #c0392b}.status-pill.header-live{background:#2ecc7126;border-left:3px solid #229954}.status-pill.header-paused{background:#f1c40f26;border-left:3px solid #b7950b}.status-pill.header-observation{background:#3498db20;border-left:3px solid #3498db}
.settings-rooms .room-card.garage-room-card{background:linear-gradient(#91785e38,#91785e38),var(--card-background-color,white);border-color:#a18a75}
.sensor-list-field{display:flex;flex-direction:column;gap:7px;min-width:0}.sensor-list{display:flex;flex-direction:column;gap:8px;min-width:0}.sensor-list-row{display:flex;align-items:center;gap:6px;min-width:0}.sensor-list-row select{flex:1;min-width:0}.sensor-list-row button{flex:none;margin:0;padding:6px 10px;font-size:20px}.sensor-list .add-sensor{align-self:flex-start;margin:0;padding:6px 10px}
.fireplace-current-state,.source-current-state{font-size:13px;color:var(--secondary-text-color,#60737b);line-height:1.4}.language-picker{position:relative;display:block;min-width:0}.language-trigger{width:100%;margin:0;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;border-radius:6px;font:inherit;background:var(--card-background-color,white);text-align:left}.language-trigger>span:first-child{display:flex;align-items:center;gap:8px}.language-flag{display:inline-block;width:24px;height:15px;max-height:none;flex:0 0 24px;overflow:hidden;border:1px solid #819aa34d;border-radius:2px}.language-options{max-height:320px;overflow-y:auto;overscroll-behavior:contain;position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:50;padding:4px;background:var(--card-background-color,white);border:1px solid var(--divider-color,#aabdc5);border-radius:6px;box-shadow:0 4px 12px #0002}.language-options[hidden]{display:none}.language-options button{display:flex;align-items:center;gap:8px;width:100%;margin:0;padding:9px 8px;border:0;text-align:left;background:transparent;font:inherit}.language-options button:hover,.language-options button:focus-visible,.language-options button[aria-selected=true]{background:var(--secondary-background-color,#edf4fa)}.language-trigger:focus-visible,.language-options button:focus-visible{outline:2px solid var(--primary-color,#087c85);outline-offset:2px}
:host{display:block;color:var(--primary-text-color,#213547);background:var(--primary-background-color,#f5f7fa);min-height:100vh;font:15px system-ui}*{box-sizing:border-box}header,main{max-width:1250px;margin:auto;padding:24px}h1{margin:0 0 8px}h2{font-size:21px}small{font-size:14px;font-weight:normal}nav{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}button{border:1px solid #aac0c8;border-radius:8px;padding:10px 16px;background:var(--card-background-color,white);color:inherit;cursor:pointer;margin:4px}button.active,.primary{background:#087c85;color:white}section{background:var(--card-background-color,white);border:1px solid var(--divider-color,#dce4e8);border-radius:14px;padding:24px;margin:0 0 20px}.settings-group{margin-top:24px}.settings-group+.settings-group{border-top:1px solid var(--divider-color,#dce4e8);padding-top:8px}.settings-group h3{font-size:17px;margin:16px 0}.settings-sources{background:linear-gradient(#2196f312,#2196f312),var(--card-background-color,white)}#settings .settings-house>p.notice.notice-info{margin-top:36px;--notice-tint:#3498db30;box-shadow:inset 0 0 0 1px #3498db45}.settings-house{background:linear-gradient(#2196f312,#2196f312),var(--card-background-color,white)}.settings-shared{background:linear-gradient(#00857712,#00857712),var(--card-background-color,white)}.settings-zones{background:linear-gradient(#e4902512,#e4902512),var(--card-background-color,white)}.settings-rooms{position:relative;isolation:isolate;background:var(--card-background-color,white);overflow:hidden}.settings-rooms::before{content:"";position:absolute;inset:0;z-index:-1;background:url("${roomFloorPlanAsset}") center/cover no-repeat;opacity:var(--tp-floorplan-opacity,.2);pointer-events:none}.settings-rooms .room-card{background:#ffffffbf}@supports(background:color-mix(in srgb,white,transparent)){.settings-rooms .room-card{background:color-mix(in srgb,var(--card-background-color,white) 75%,transparent)}}.badge{color:var(--primary-color,#087c85);font-weight:600}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:18px}label[hidden],[data-fireplace-state][hidden],[data-water-group][hidden],[data-air-group][hidden],[data-electric-group][hidden],label[data-electric-control][hidden]{display:none}label{display:flex;flex-direction:column;gap:7px}.number-unit{display:flex;align-items:center;gap:8px}.number-unit input{min-width:0;flex:1}.number-unit span{flex:none}input,select{width:100%;padding:10px;border:1px solid #aabdc5;border-radius:6px;color:inherit;background:var(--card-background-color,white)}input[type=checkbox].setting-toggle{appearance:none;-webkit-appearance:none;width:44px;height:26px;padding:2px;border:0;border-radius:13px;background:var(--disabled-color,#87949b);cursor:pointer;transition:background .15s}input[type=checkbox].setting-toggle::before{content:"";display:block;width:22px;height:22px;border-radius:50%;background:white;box-shadow:0 1px 3px #0003;transition:transform .15s}input[type=checkbox].setting-toggle:checked{background:var(--primary-color,#087c85)}input[type=checkbox].setting-toggle:checked::before{transform:translateX(18px)}input[type=checkbox].setting-toggle:focus-visible{outline:2px solid var(--primary-color,#087c85);outline-offset:3px}details{border-top:1px solid #ddd;padding:18px 0}summary{font-weight:600;cursor:pointer;margin-bottom:20px}.room-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;align-items:start;margin:20px 0}.room-card{position:relative;min-width:0;border:1px solid var(--divider-color,#dce4e8);border-radius:12px;padding:20px;background:var(--card-background-color,white)}.room-card details{border:0;padding:0}.room-card summary{margin:0;min-height:26px;padding-right:78px;overflow-wrap:anywhere}.room-target{font-weight:normal;color:var(--secondary-text-color,#60737b);white-space:nowrap;margin-left:8px}.room-card details[open] summary{margin-bottom:20px}.room-fields{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.room-fields label{min-width:0}.room-fields input,.room-fields select{min-width:0;max-width:100%}.room-actions{position:absolute;top:10px;right:10px;display:flex;gap:4px;margin:0}.room-actions .icon-button{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:7px;margin:0;border:0;background:transparent;border-radius:50%}.room-actions .icon-button:hover{background:var(--secondary-background-color,#eef2f4)}.room-actions .icon-button:focus-visible{outline:2px solid var(--primary-color,#087c85);outline-offset:2px}.room-actions .delete-room{color:var(--error-color,#c62828)}.icon-button svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}@media(max-width:900px){.room-cards{grid-template-columns:minmax(0,1fr)}}@media(max-width:600px){.room-fields{grid-template-columns:minmax(0,1fr)}.room-card{padding:16px}}.metrics{display:flex;gap:24px;flex-wrap:wrap}.metrics strong{display:block;font-size:24px;margin-top:8px}.notice-icon{width:20px;height:20px;max-height:none;flex:0 0 20px;fill:none;stroke:var(--notice-accent,#3498db);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;margin-top:2px}.notice-text{min-width:0;overflow-wrap:anywhere}.notice-level{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.notice,.message{display:flex;align-items:flex-start;gap:10px;padding:12px 16px;border-radius:8px;color:var(--primary-text-color,#213547);border-left:3px solid var(--notice-accent,#3498db);background:linear-gradient(var(--notice-tint,#3498db18),var(--notice-tint,#3498db18)),var(--card-background-color,white)}.notice-info{--notice-accent:#3498db;--notice-tint:#3498db18}.notice-warning{--notice-accent:#d9a400;--notice-tint:#f5c51820}.notice-error{--notice-accent:#d64545;--notice-tint:#d6454518}.save-toast{position:fixed;bottom:calc(24px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);z-index:10000;width:max-content;max-width:calc(100% - 32px);margin:0;padding:14px 20px;box-shadow:0 4px 18px #0002;pointer-events:none}
.save-error{pointer-events:auto;width:min(680px,calc(100% - 32px));max-height:45vh;overflow:auto;display:flex;align-items:flex-start;gap:12px;border:1px solid #c0392b66;border-left:4px solid #c0392b;background:linear-gradient(#e74c3c18,#e74c3c18),var(--card-background-color,white)}.save-error .notice-text{flex:1;min-width:0;overflow-wrap:anywhere}.save-error button{flex:none;margin:0;padding:0 3px;border:0;background:transparent;font-size:24px;line-height:1;align-self:flex-start}.save-error button:focus-visible{outline:2px solid var(--primary-color,#087c85)}
.chart-legend{display:flex;flex-wrap:wrap;gap:12px 24px;margin:14px 0 6px}.chart-legend span{display:flex;align-items:center;gap:8px}.chart-legend i{display:inline-block;width:24px;height:3px}.temperature-chart{overflow-x:auto;margin:8px 0}.temperature-chart svg{display:block;min-width:800px;width:100%;max-height:none}.scroll{overflow:auto;max-height:420px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #ddd;white-space:nowrap}.heat{background:#00857718}svg{width:100%;max-height:230px}svg text{fill:var(--primary-text-color,#213547);font-size:12px}p{line-height:1.6}@media(max-width:600px){header,main{padding:12px}header.page-layout .header-status{display:none}section{padding:16px}}
/* Compact settings layout; keep the other tabs at their readable content width. */
.settings-layout{max-width:none;padding:16px 24px}
#settings{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}
#settings>section,#settings>.settings-zone-column>section{min-width:0;margin:0;padding:20px}
.settings-zone-column{display:grid;gap:inherit;min-width:0}
#settings h2{margin:0 0 12px}
#settings p{margin:0 0 14px;line-height:1.45}
#settings .settings-group{margin-top:16px}
.solar-threshold{display:flex;align-items:center;gap:12px}.solar-threshold input[type=range]{flex:1;min-width:0;accent-color:var(--primary-color,#087c85)}.solar-threshold input[type=number]{width:100px;flex:none}
.source-checks h5{font-size:14px;margin:12px 0 6px}.source-checks p{margin:6px 0;overflow-wrap:anywhere}
#settings .settings-group+.settings-group{padding-top:12px}
#settings .settings-group h3{margin:0 0 12px}
#settings .grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 16px}
#settings .grid>label{min-width:0}
#settings .grid>[hidden]{display:none}
#settings .grid>label>span:first-child,#settings .grid>.sensor-list-field>span:first-child{min-height:2.5em;line-height:1.25}
#settings input,#settings select{min-width:0;max-width:100%;padding:8px 10px}
#settings input.setting-toggle{padding:2px}
#settings .room-fields{grid-template-columns:repeat(2,minmax(0,1fr))}
#settings .settings-zones>.room-card+.room-card{margin-top:16px}
#settings .settings-fireplaces{background:linear-gradient(#cc554d17,#cc554d17),var(--card-background-color,#fff)}
#settings .settings-fireplaces>.room-card+.room-card{margin-top:16px}
#settings #add-zone,#settings #add-fireplace{margin-top:16px}
#settings .zone-empty-note{grid-column:1/-1;font-size:13px;color:var(--secondary-text-color,#60737b)}
.room-cards-group{padding-block:12px;background:linear-gradient(#829aa312,#829aa312),var(--card-background-color,white)}
.room-cards-group>.observation-accordion>summary h2{margin-block:.415em}
.retention-summary{font-size:14px;color:var(--secondary-text-color,#526b75)}.retention-help{border:0;padding:0;margin:12px 0 0;font-size:14px;line-height:1.5}.retention-help>summary{margin:0;cursor:pointer;color:var(--primary-color,#087c85);padding:4px 0}.retention-help p{margin:10px 0}
.retention-help .retention-scale{table-layout:auto;width:100%;margin:12px 0}.retention-help .retention-scale th,.retention-help .retention-scale td{width:auto;white-space:normal;overflow-wrap:normal;word-break:normal;text-align:left}.retention-help .retention-scale tbody th{background:transparent;font-weight:normal}.retention-help .retention-scale .retention-rating{box-sizing:border-box;max-width:100%;white-space:normal;overflow-wrap:normal;word-break:normal}
.retention-sort{margin:0;font:inherit;font-weight:inherit;color:inherit;border:0;background:transparent;padding:0;display:inline-flex;align-items:center;gap:6px;text-align:left;cursor:pointer}.retention-sort:focus-visible{outline:2px solid var(--primary-color,#087c85);outline-offset:4px}
.retention-card table tbody tr.garage-retention-row,.season-archives table tbody tr.garage-archive-row{background:linear-gradient(#91785e38,#91785e38),var(--card-background-color,white)}
#settings .garage-settings-heading{grid-column:1/-1;font-size:17px;margin:0 0 4px}
#settings .garage-settings-divider{grid-column:1/-1;border-top:1px solid var(--divider-color,#91a5ad);margin:10px 0 2px}
#settings .room-cards{gap:16px;margin:16px 0}
#settings .room-card{padding:16px}
#settings .room-card details[open] summary{margin-bottom:16px}
#settings>.sticky{
  position:sticky;bottom:0;z-index:10;grid-column:1/-1;
  display:flex;align-items:center;gap:12px;flex-wrap:wrap;
  padding:8px 0 calc(8px + env(safe-area-inset-bottom));background:var(--card-background-color,white);
}
#settings .settings-save-actions{display:flex;align-items:center;gap:8px;margin-inline-start:auto}
#settings .settings-save-actions>button{margin:0}
@supports(grid-template-rows:subgrid){
 #settings .grid>label,#settings .grid>.sensor-list-field{display:grid;grid-row:span 3;grid-template-rows:subgrid;gap:6px;align-items:start}
 #settings .grid>label>span:first-child,#settings .grid>.sensor-list-field>span:first-child{min-height:0}
}
@media(min-width:1400px){
 #settings{grid-template-columns:repeat(2,minmax(0,1fr))}#settings>.settings-sources{grid-column:1/-1}#settings>.settings-house{grid-column:1;grid-row:1}#settings>.settings-shared{grid-column:2;grid-row:1}#settings>.settings-rooms{grid-column:1;grid-row:2}#settings>.settings-zone-column{grid-column:2;grid-row:2}#settings .settings-group>.grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(min-width:1800px){#settings .settings-group>.grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(max-width:1000px){#settings .settings-group>.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){
 .settings-layout{padding:12px}
 #settings .grid,#settings .settings-group>.grid{grid-template-columns:minmax(0,1fr)}
 #settings>section,#settings>.settings-zone-column>section{padding:16px}
 #settings .room-fields{grid-template-columns:minmax(0,1fr)}
 #settings .grid>label,#settings .grid>.sensor-list-field{display:flex;flex-direction:column;grid-row:auto;gap:6px}
 #settings .grid>label>span:first-child,#settings .grid>.sensor-list-field>span:first-child{min-height:0}
 #settings .grid>label>input:not([type=checkbox]),#settings .grid>label>select{width:100%;box-sizing:border-box}
}
/* Keep dropdown arrows inset from the field border. */
select{appearance:none;-webkit-appearance:none;padding-right:36px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='m2 4 4 4 4-4' fill='none' stroke='%23808b93' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:12px 12px}
#settings select{padding-right:36px}
@media(forced-colors:active){select{appearance:auto;background-image:none}}

/* Compact numeric controls remain bounded by their grid cell on phones. */
#settings input[type=number]{width:120px;max-width:100%;font-variant-numeric:tabular-nums}
#settings .number-unit{width:155px;max-width:100%}
#settings .number-unit input[type=number]{flex:0 1 120px}

/* Use parallel room cards on Plan and History without shrinking mobile layouts. */
.page-layout{max-width:none;padding:16px 24px}
/* Keep all header popups, including operation and season help, above sticky table headings. */
header.page-layout{position:relative;z-index:20;padding-bottom:0}
.tab-list{gap:5px;margin-top:22px;padding:0;align-items:flex-end}
.tab-list button{margin:0 0 -1px;border:1px solid #91a5ad;border-radius:9px 9px 0 0;padding:12px 28px;background:var(--secondary-background-color,#eaf0f4);color:var(--secondary-text-color,#526671);font-weight:500;min-width:105px}
.tab-list button:hover{color:var(--primary-text-color,#213547);background:var(--card-background-color,#fff)}
.tab-list button.active{border-top:3px solid #087c85;border-bottom-color:var(--card-background-color,#fff);padding-top:10px;background:var(--card-background-color,#fff);color:var(--primary-color,#087c85);font-weight:700;position:relative;z-index:1}
.tab-list button:focus-visible{outline:2px solid #087c85;outline-offset:-5px}
.tab-panel.page-layout{margin:0 24px 24px;border:1px solid #91a5ad;border-radius:0 12px 12px 12px;padding:24px;background:var(--card-background-color,#fff);min-height:320px;box-shadow:0 2px 6px #00000008}
.collection-date{display:block;margin-bottom:6px}
@media(max-width:600px){.tab-panel.page-layout{margin:0 12px 12px;padding:12px}.tab-list{padding:0;gap:3px;flex-wrap:wrap}.tab-list button{min-width:0;padding-left:18px;padding-right:18px}}
.observation-cards,.history-summary{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}
.observation-cards>section,.history-summary>section{min-width:0;margin:0;padding:20px}
.history-summary{margin-bottom:16px}
.history-summary label{max-width:240px}
.history-period{display:inline-flex;flex-direction:row;align-items:center;gap:8px;margin-left:auto;font-size:14px}.history-period select{width:auto;min-width:125px;margin:0}.room-history-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:12px 0}.room-history-toolbar h3{margin:0}.room-history-toolbar .history-period{flex-shrink:0}
.history-explanation{margin:18px 0 0;display:grid;gap:16px}.history-explanation dt{font-weight:600;margin:0 0 4px}.history-explanation dd{margin:0;line-height:1.5}
.observation-card h2,.history-summary h2,.status-card h2{margin:0 0 12px}
.observation-card h2 small{display:block;margin-top:4px}
.observation-card h3{margin:14px 0 8px;font-size:17px}
.observation-card p,.history-summary p,.status-card p{margin:8px 0;line-height:1.45}
.status-card{padding:20px;margin-bottom:16px}
.observation-card .metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}
.observation-card .metrics strong{font-size:21px;margin-top:4px}
.observation-card .scroll{max-height:250px}
.observation-card th{white-space:normal;vertical-align:bottom;line-height:1.3}
.observation-card th,.observation-card td{padding:8px}
.observation-card .temperature-chart{overflow:hidden}.observation-card .temperature-chart svg{min-width:0;width:100%;max-height:220px}
.observation-card .chart-legend{gap:8px 16px;font-size:14px}
@media(min-width:1200px){.observation-cards,.history-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){
 .page-layout{padding:12px}
 .observation-cards>section,.history-summary>section,.status-card{padding:16px}
}

/* History has distinct surfaces for room headings, charts and observations. */
.history-layout .history-summary>section:first-child{background:linear-gradient(#2196f312,#2196f312),var(--card-background-color,white)}
.history-layout .history-summary>section.season-archives{background:linear-gradient(#0085770c,#0085770c),var(--card-background-color,white)}
.observation-layout .observation-card{background:linear-gradient(#00857709,#00857709),var(--card-background-color,white);box-shadow:0 2px 8px #00000008}
.observation-layout .observation-card .observation-accordion>summary{padding:12px 14px;border-left:4px solid var(--primary-color,#087c85);border-radius:8px;background:linear-gradient(#00857718,#00857718),var(--card-background-color,white)}
.observation-layout .observation-card>h3{color:var(--secondary-text-color,#526671)}
.observation-layout .temperature-chart{padding:12px;border:1px solid var(--divider-color,#dce4e8);border-radius:10px;background:var(--card-background-color,white)}
.observation-layout .chart-legend{padding:10px 12px;border-radius:8px;background:linear-gradient(#2196f30c,#2196f30c),var(--card-background-color,white)}
.observation-layout .observation-card .observation-content>.scroll{margin-top:12px;border:1px solid var(--divider-color,#dce4e8);border-radius:10px;background:var(--card-background-color,white)}
.observation-layout th{position:sticky;top:0;z-index:1;background:linear-gradient(#00857720,#00857720),var(--card-background-color,white);padding:10px}
.observation-layout tbody tr:nth-child(even){background:#0085770a}
.observation-layout tbody tr:hover{background:#2196f314}
.observation-layout tbody tr:last-child td{border-bottom:0}
.observation-layout .observation-card .observation-content>p{color:var(--secondary-text-color,#526671);font-size:14px}

.plan-layout .status-card{background:linear-gradient(#2196f312,#2196f312),var(--card-background-color,white)}
.plan-layout .metrics>div{padding:12px 14px;border:1px solid var(--divider-color,#dce4e8);border-radius:10px;background:var(--card-background-color,white)}
.plan-layout .metrics>div:nth-child(2){background:linear-gradient(#00857712,#00857712),var(--card-background-color,white)}
.plan-layout .metrics>div:nth-child(4){background:linear-gradient(#e4902512,#e4902512),var(--card-background-color,white)}
.plan-layout .metrics strong{color:var(--primary-text-color,#213547)}
.plan-layout .observation-card tbody tr.heat{background:#00857720}

/* A gentle elevation separates cards and their inset content surfaces. */
section,.room-card,.plan-layout .metrics>div,.observation-layout .temperature-chart,.observation-layout .observation-card .observation-content>.scroll{box-shadow:0 2px 6px #0000000a,0 1px 2px #00000008}

/* Stronger outlines keep container boundaries visible in light and dark themes. */
section,.room-card,.plan-layout .metrics>div,.observation-layout .temperature-chart,.observation-layout .observation-card .observation-content>.scroll{border-color:#91a5ad}
@supports(color:color-mix(in srgb,white,black)){
 section,.room-card,.plan-layout .metrics>div,.observation-layout .temperature-chart,.observation-layout .observation-card .observation-content>.scroll{border-color:color-mix(in srgb,var(--primary-text-color,#213547) 34%,var(--card-background-color,white))}
}

/* Increase spacing between containers without spreading out individual fields. */
section{margin-bottom:30px}
#settings,.observation-cards,.history-summary{gap:24px}
.history-summary,.status-card{margin-bottom:24px}
#settings .room-cards{gap:24px;margin:24px 0}

.observation-accordion{border:0;padding:0}
details{scroll-margin-block:16px}
.observation-accordion>summary{display:flex;align-items:center;gap:10px;list-style:none;margin:0}
.history-summary .observation-accordion>summary h2{margin:0;line-height:1.3}
.observation-accordion>summary::-webkit-details-marker{display:none}
.observation-accordion>summary::before{content:"▸";font-size:18px;transform:rotate(0);flex:none}
.observation-accordion[open]>summary::before{transform:rotate(90deg)}
.observation-card .observation-accordion>summary h2{display:flex;flex-wrap:wrap;align-items:center;column-gap:12px;row-gap:8px;flex:1;min-width:0;margin:0;font-size:21px}
.observation-card .observation-accordion>summary h2>.room-heating{flex:0 0 30px;margin:0}
.observation-card .observation-accordion>summary h2>.room-learning,.observation-card .observation-accordion>summary h2>.room-forecast-badge{margin:0;max-width:100%;white-space:normal}
.observation-card .observation-accordion>summary h2>small{flex-basis:100%}
.observation-accordion>summary:focus-visible{outline:2px solid var(--primary-color,#087c85);outline-offset:3px}
.observation-content{padding-top:16px;min-width:0}

.status-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.status-heading h2{margin:0}
.status-heading button{margin:0}
.status-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin:0}
.status-block{min-width:0;padding:14px;border:1px solid #91a5ad;border-radius:10px;background:var(--card-background-color,white);box-shadow:0 2px 6px #0000000a,0 1px 2px #00000008}
[data-temperature-history-entity]:focus-visible{outline:2px solid var(--primary-color,#087c85);outline-offset:3px;border-radius:2px}
.status-temperature{position:relative;overflow:hidden;padding-bottom:54px}
.status-temperature>dt,.status-temperature>dd,.status-temperature>small{position:relative;z-index:1}
.status-temperature .status-sparkline{position:absolute;bottom:0;left:0;width:100%;height:46px;max-height:none;pointer-events:none}
.status-block dt{font-size:14px;color:var(--secondary-text-color,#526671);margin-bottom:10px}
.status-block dd{margin:0 0 8px;font-size:24px;font-weight:650;overflow-wrap:anywhere}
.status-block small{font-size:13px;line-height:1.4;color:var(--secondary-text-color,#526671)}
.status-unit{font-size:14px;font-weight:normal}
.status-block .status-time{font-size:20px}
.status-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:7px;font-size:16px;background:var(--secondary-background-color,#eef2f4)}
.status-pill.winter{background:#3498db24;color:color-mix(in srgb,#3498db 45%,var(--primary-text-color,#213547));border-left:3px solid #3498db}
.status-pill.summer{background:#82e0aa33;color:color-mix(in srgb,#2ecc71 45%,var(--primary-text-color,#213547));border-left:3px solid #2ecc71}
.status-pill.active{background:#2ecc7126;color:var(--primary-text-color,#166534);border-left:3px solid #229954}
.status-help{position:relative;display:block;align-self:flex-start;border:0;padding:0;margin:0}
.status-help::details-content{content-visibility:visible}
.status-help>summary{align-items:center;gap:6px;list-style:none;cursor:pointer;margin:0;font-weight:normal}
.status-help>summary::-webkit-details-marker{display:none}
.status-help>summary:focus-visible{outline:2px solid var(--primary-color,#087c85);outline-offset:2px}
.status-info{display:inline-block;vertical-align:middle;width:14px;height:14px;flex:0 0 14px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;opacity:.8}
.status-info-dot{fill:currentColor;stroke:none}
.retention-rating .status-info{margin-left:6px}
.room-learning:focus-visible,.room-forecast-badge:focus-visible,.retention-rating:focus-visible,.status-temperature:focus-visible{outline:2px solid var(--primary-color,#087c85);outline-offset:2px}
.status-tooltip{display:none;position:absolute;left:0;top:calc(100% + 6px);z-index:40;width:280px;max-width:calc(100vw - 48px);padding:12px;border-radius:8px;background:var(--primary-text-color,#213547);color:var(--card-background-color,white);font-size:13px;line-height:1.45;box-shadow:0 3px 12px #0003}
.status-help[open]>.status-tooltip,.status-help:hover>.status-tooltip,.status-help:focus-within>.status-tooltip{display:block}
@media(max-width:600px){.status-tooltip{position:fixed;left:16px;right:16px;top:auto;bottom:calc(24px + env(safe-area-inset-bottom));width:auto;max-width:none;max-height:45vh;overflow:auto}}
.status-badges{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.status-block dd{display:flex;align-items:baseline;flex-wrap:wrap;gap:7px}
.status-pill.mode{background:#087c8518;border-left:3px solid #087c85}
.status-pill.missing,.quality-0{background:#e74c3c20;border-left:3px solid #c0392b}
.status-pill.quality-1{background:#e67e2220;border-left:3px solid #d35400}
.status-pill.quality-2{background:#f1c40f26;border-left:3px solid #b7950b}
.status-pill.quality-3{background:#82e0aa30;border-left:3px solid #52a56d}
.status-pill.quality-4{background:#2ecc7126;border-left:3px solid #229954}
.status-pill:focus-visible{outline:2px solid #087c85;outline-offset:2px}
.status-pill.paused{background:#e4902520;color:var(--primary-text-color,#213547);border-left:3px solid #b77918}
@supports(color:color-mix(in srgb,white,black)){.status-block{border-color:color-mix(in srgb,var(--primary-text-color,#213547) 34%,var(--card-background-color,white))}}
@media(max-width:600px){.status-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.status-block{padding:12px}.status-block dd{font-size:21px}.status-block.status-temperature{min-height:150px;padding-bottom:70px}.status-temperature .status-sparkline{height:56px}}
@media(max-width:380px){.status-grid{grid-template-columns:minmax(0,1fr)}}

.plan-layout .observation-content>.timing-table{margin-bottom:20px}
.observation-card td.empty-table{padding:16px;color:var(--secondary-text-color,#526671);white-space:normal;text-align:center}

.setting-help{position:relative;display:inline-flex;vertical-align:middle}
.setting-help .setting-info{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin:0 0 0 3px;padding:1px;border:0;border-radius:50%;background:transparent;color:var(--primary-color,#087c85);cursor:help}
.setting-info svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round}
.setting-info .info-dot{fill:currentColor;stroke:none}
.setting-info:focus-visible{outline:2px solid var(--primary-color,#087c85);outline-offset:2px}
.setting-tooltip{display:none;position:fixed;box-sizing:border-box;left:12px;top:12px;z-index:10000;width:304px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;white-space:pre-line;word-break:normal;overflow-wrap:anywhere;padding:12px;border-radius:8px;background:var(--primary-text-color,#213547);color:var(--card-background-color,white);font-size:13px;line-height:1.45;font-weight:normal;box-shadow:0 3px 12px #0003}
@media(min-width:601px){.setting-tooltip{width:440px}}
.setting-help.tooltip-open .setting-tooltip{display:block}
.native-tooltip-help{max-width:100%;min-width:0}.native-tooltip-help>[data-tooltip-trigger]{cursor:help}
.native-tooltip-help>.room-heating{margin:0;flex:0 0 30px}.native-tooltip-help>.room-learning,.native-tooltip-help>.room-forecast-badge{margin:0;max-width:100%;white-space:normal}

/* Alternating room-row colors follow the responsive one/two-column layout. */
.observation-layout .observation-cards>.observation-card{--room-tint:#00857712;--room-heading-tint:#00857724;background:linear-gradient(var(--room-tint),var(--room-tint)),var(--card-background-color,white)}
.observation-layout .observation-cards>.observation-card:nth-child(even){--room-tint:#2196f312;--room-heading-tint:#2196f324}
.observation-layout .observation-card .observation-accordion>summary{background:linear-gradient(var(--room-heading-tint),var(--room-heading-tint)),var(--card-background-color,white)}
@media(min-width:1200px){
 .observation-layout .observation-cards>.observation-card:nth-child(n){--room-tint:#00857712;--room-heading-tint:#00857724}
 .observation-layout .observation-cards>.observation-card:nth-child(4n+3),.observation-layout .observation-cards>.observation-card:nth-child(4n+4){--room-tint:#2196f312;--room-heading-tint:#2196f324}
}

.observation-layout .observation-cards>.observation-card.garage-observation-card:nth-child(n){--room-tint:#91785e38;--room-heading-tint:#91785e50;border-color:#a18a75}

@media(min-width:1400px){#settings>.settings-sources,#settings>.settings-house,#settings>.settings-shared{align-self:stretch}}

@media(min-width:1200px){.history-summary>section{align-self:start}}

.learning-card{padding:14px 16px;margin:16px 0;border:1px solid #91a5ad;border-radius:10px;background:linear-gradient(#2196f30c,#2196f30c),var(--card-background-color,white);box-shadow:0 2px 6px #0000000a}
.learning-heading,.learning-counts{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.learning-heading{margin-bottom:10px}
.learning-counts{margin-top:10px;font-size:14px}
.learning-counts strong{margin-left:5px}
.learning-card progress{display:block;width:100%;height:10px;border:0;border-radius:5px;overflow:hidden;appearance:none;background:var(--divider-color,#dce4e8)}
.learning-card progress::-webkit-progress-bar{background:var(--divider-color,#dce4e8)}
.learning-card progress::-webkit-progress-value{background:#087c85;border-radius:5px}
.learning-card progress::-moz-progress-bar{background:#087c85;border-radius:5px}
.learning-card small{font-size:13px;line-height:1.45;color:var(--secondary-text-color,#526671)}

.room-heating{display:inline-flex;vertical-align:middle;align-items:center;justify-content:center;width:30px;height:30px;margin-left:6px;border-radius:50%;color:#d32f2f;background:#e5393518}
.room-heating svg{width:19px;height:19px;fill:currentColor;stroke:currentColor;stroke-width:1.2;stroke-linejoin:round}
.room-heating.idle,.room-heating.unknown{color:var(--secondary-text-color,#6b7280);background:#7a879218}
.room-heating.idle svg{fill:none}
.room-heating.unknown{font-size:20px;font-weight:700}
.room-heating:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.room-learning{display:inline-flex;align-items:center;gap:6px;margin-left:8px;font-size:14px;font-weight:normal;vertical-align:middle;white-space:nowrap;color:var(--secondary-text-color,#526671)}

/* Keep navigation reachable and card content inside the phone viewport. */
:host{min-width:0;max-width:100%}
.header-tools{position:absolute;top:24px;right:24px;display:flex;align-items:center;gap:16px}.page-title{padding-right:56px;display:flex;align-items:center;gap:10px;margin-bottom:8px}
.page-title h1{margin:0;min-width:0}
.header-icon-button{position:relative;margin:0;z-index:30;display:inline-flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;padding:8px;border:1px solid var(--divider-color,#c6d2d8);border-radius:10px;background:transparent;color:var(--secondary-text-color,#526b75);cursor:pointer;transition:background-color .16s,border-color .16s,box-shadow .16s}.header-icon-button:hover:not(:disabled){background:#00838f14;border-color:var(--primary-color,#00838f);color:var(--primary-color,#00838f);box-shadow:0 3px 12px #00838f26}.header-icon-button svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.away-calendar-button.active{color:var(--primary-color,#00838f);background:#00838f15;border-color:var(--primary-color,#00838f)}.away-calendar-button.scheduled{color:var(--primary-color,#00838f);border-style:dashed}.header-icon-button:focus-visible{outline:2px solid var(--primary-color,#00838f);outline-offset:2px}
.header-actions{display:grid;gap:12px}
.notification-button[data-severity="warning"]{--notification-accent:#d9a400}
.notification-button[data-severity="error"]{--notification-accent:#d64545}
.header-icon-button.notification-button:is([data-severity="warning"],[data-severity="error"]){border:2px solid var(--notification-accent);animation:tp-notification-pulse 1.7s ease-in-out infinite}
@keyframes tp-notification-pulse{0%,100%{border-color:var(--notification-accent);box-shadow:0 0 0 1px var(--notification-accent)}50%{border-color:color-mix(in srgb,var(--notification-accent) 35%,transparent);box-shadow:0 0 0 3px transparent}}
.header-count{position:absolute;top:-5px;right:-5px;min-width:18px;padding:0 4px;border-radius:10px;background:var(--notification-accent,var(--primary-color,#00838f));color:#fff;font:bold 11px/18px system-ui;text-align:center}
.notification-button[data-severity="warning"] .notification-count{color:#26200b}
@media(prefers-reduced-motion:reduce){.header-icon-button.notification-button:is([data-severity="warning"],[data-severity="error"]){animation:none}}
@media(max-width:1199px){.page-title{min-height:92px;align-items:flex-start}.page-title h1{align-self:flex-start;margin-top:4px}}
@media(max-width:360px){.page-title h1{font-size:22px}}
.header-logo{display:block;width:36px;height:36px;object-fit:contain;flex:none}
.menu-button{display:none;align-items:center;justify-content:center;flex:none;width:44px;height:44px;margin:0;padding:10px;border:0;background:transparent}
.menu-button svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.menu-button:focus-visible{outline:2px solid var(--primary-color,#087c85);outline-offset:2px}
.page-layout,section,.scroll,.price-chart-viewport,.temperature-chart{min-width:0;max-width:100%}
@media(max-width:600px){
 .menu-button{display:inline-flex}
 header.page-layout{padding:12px 10px 0}
 .page-title h1{font-size:25px}
 .header-tools{top:12px;right:12px}
 .header-logo{width:28px;height:28px}
 .badge{font-size:13px;line-height:1.45;overflow-wrap:anywhere}
 .tab-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(48px,auto);align-items:stretch;gap:6px;margin:16px 0 12px;padding:6px;border-radius:12px;background:var(--secondary-background-color,#eaf0f4)}
 .tab-list button,.tab-list button.active{min-width:0;min-height:48px;height:100%;margin:0;padding:10px 12px;border:2px solid transparent;border-radius:8px;font-size:14px;line-height:1.35;white-space:normal;overflow-wrap:anywhere}
 .tab-list button{background:transparent;color:var(--secondary-text-color,#526671)}
 .tab-list button.active{background:var(--primary-color,#087c85);border-color:var(--primary-color,#087c85);color:var(--text-primary-color,#fff);font-weight:700;box-shadow:0 1px 4px #0002}
 .tab-list button:focus-visible{outline:2px solid var(--primary-text-color,#213547);outline-offset:1px}
 .tab-panel.page-layout{margin:0 10px 12px;padding:10px;border-radius:12px}
 #settings>section,#settings>.settings-zone-column>section,.observation-cards>section,.history-summary>section,.status-card,.price-card{padding:12px}
 #settings,.observation-cards,.history-summary{gap:16px}
 .grid{grid-template-columns:minmax(0,1fr)}
 .status-grid{grid-template-columns:minmax(0,1fr);gap:10px}
 .observation-card .metrics{grid-template-columns:minmax(0,1fr);gap:10px}
 .observation-card .observation-accordion>summary{padding:10px;gap:6px}
 .observation-card .observation-accordion>summary h2{font-size:18px;overflow-wrap:anywhere}
 .room-learning{display:inline-flex;margin:5px 0 0;white-space:normal;font-size:13px}
 .observation-card .temperature-chart svg{min-width:0;width:100%;height:195px;max-height:none}
 .temperature-chart{padding:6px}
 .scroll{overflow-x:auto;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}
 th,td{font-size:13px}
 #settings>.sticky{font-size:13px}
 input:not([type=checkbox]),select,#settings input:not([type=checkbox]),#settings select{font-size:16px;min-height:44px}
 #settings .solar-threshold{width:100%;gap:8px}
 #settings .solar-threshold input[type=range]{padding-inline:0}
 #settings .solar-threshold input[type=number]{width:76px;padding-inline:8px}
 input[type=checkbox].setting-toggle,#settings input.setting-toggle{width:44px;height:26px;min-height:26px;max-height:26px;padding:2px;align-self:start}
 .setting-help .setting-info{width:32px;height:32px}
 .room-card summary{min-height:36px}
 .room-actions .icon-button{width:40px;height:40px}
 .room-card summary{padding-right:88px}
 .chart-legend span{min-width:0;align-items:flex-start}
 .chart-legend i{flex:none;margin-top:7px}
 .learning-card{padding:12px}
}

.chart-tooltip{position:fixed;z-index:10000;max-width:min(340px,calc(100vw - 16px));padding:12px 14px;border-radius:8px;background:var(--primary-text-color,#213547);color:var(--card-background-color,#fff);box-shadow:0 4px 16px #0003;font-size:14px;line-height:1.5;white-space:pre-line;pointer-events:none}
.chart-tooltip[hidden]{display:none}
[data-chart-detail]{cursor:pointer}
[data-chart-detail]:focus-visible{outline:2px solid #213547;outline-offset:2px}
.forecast-heading,.timing-heading{display:flex;align-items:center;gap:4px}.forecast-toolbar{display:flex;align-items:flex-end;justify-content:flex-start;flex-wrap:wrap;gap:12px 24px;margin:14px 0}.forecast-selection{display:inline-flex;flex-direction:row;align-items:center;gap:8px;flex:0 0 auto;max-width:none;margin:0;margin-inline-start:auto}.forecast-selection select{width:auto;min-width:160px;margin:0}.forecast-metrics{display:flex;align-items:center;flex-wrap:wrap;gap:10px 0;width:fit-content;max-width:100%;box-sizing:border-box;margin:0;padding:12px 16px;background:var(--card-background-color,white);border:1px solid var(--divider-color,#ccdadd);border-radius:8px;min-height:38px}.forecast-metrics-title{font-size:13px;color:var(--secondary-text-color,#526b75);margin-inline-end:16px}.forecast-metric{display:flex;align-items:baseline;gap:8px;padding:0 16px;border-inline-start:1px solid var(--divider-color,#ccdadd)}.forecast-metric:nth-child(2){padding-inline-start:0;border-inline-start:0}.forecast-metric:last-child{padding-inline-end:0}.forecast-metric-label{font-size:13px;font-weight:500;color:var(--secondary-text-color,#526b75);white-space:nowrap}.forecast-metric-value{font-size:17px;font-weight:600;color:var(--primary-text-color,#213547);font-variant-numeric:tabular-nums;white-space:nowrap}@media(max-width:600px){.forecast-toolbar{flex-direction:column;align-items:stretch}.forecast-toolbar .forecast-selection{flex:0 0 auto;max-width:none;margin-inline-start:0;align-self:flex-start;justify-content:flex-start}.forecast-metrics{flex-direction:column;align-items:stretch;gap:0;width:100%}.forecast-metrics-title{margin:0 0 8px}.forecast-metric,.forecast-metric:nth-child(2){justify-content:space-between;padding:10px 0;border:0;border-bottom:1px solid var(--divider-color,#ccdadd)}.forecast-metric:last-child{padding-bottom:0;border-bottom:0}}
.unsaved-notice{padding:6px 10px;border-radius:8px;background:#ffb30026;color:var(--primary-text-color,#7a4b00);border-left:3px solid #e49025;font-weight:600}.unsaved-notice[hidden]{display:none}
.plan-comparison-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;margin-bottom:20px;align-items:start}.plan-comparison-grid>section{min-width:0;margin-bottom:0!important}
@media(min-width:1800px){.plan-comparison-grid{grid-template-columns:minmax(0,1.7fr) minmax(600px,1fr);align-items:stretch}.plan-comparison-grid>section{height:100%}.plan-comparison-grid .retention-bar{width:70px;margin-left:6px}.plan-comparison-grid .retention-value{min-width:65px}}
.plan-comparison-grid>section:has(>details:not([open])){height:auto;align-self:start}
.retention-rating{display:inline-block;padding:5px 18px 5px 9px;font-size:13px;font-weight:600;white-space:nowrap;line-height:1.3;clip-path:polygon(0 0,calc(100% - 9px) 0,100% 50%,calc(100% - 9px) 100%,0 100%)}.retention-rating-very-fast{background:#f8d7da;color:#86242e}.retention-rating-fast{background:#ffe0b2;color:#743b08}.retention-rating-moderate{background:#fff1ad;color:#665111}.retention-rating-slow{background:#dcedc8;color:#36571e}.retention-rating-very-slow{background:#bce7c9;color:#175b31}.retention-rating-learning{clip-path:none;border-radius:5px;padding-right:9px;background:var(--secondary-background-color,#e7ebed);color:var(--secondary-text-color,#526b75)}
.retention-card{background:linear-gradient(#0085770c,#0085770c),var(--card-background-color,white)}.retention-value{display:inline-block;min-width:80px}.retention-bar{display:inline-block;width:110px;height:7px;margin-left:10px;border-radius:4px;background:#819aa324}.retention-bar i{display:block;height:100%;border-radius:4px;background:#418ba4}.retention-card .scroll{max-height:none}.retention-card h2{margin:0}.retention-card th,.retention-card td{padding:8px;vertical-align:middle}
.retention-card .retention-numeric{text-align:right;font-variant-numeric:tabular-nums}
.season-archives .retention-bar{width:70px;margin:0 10px 0 0;vertical-align:middle}.season-archives .scroll{max-height:none}.season-archives table{width:100%}.season-archives th,.season-archives td{padding:9px 12px;white-space:nowrap}.season-archives .archive-numeric{text-align:right;font-variant-numeric:tabular-nums}
.retention-numeric .retention-sort,.archive-numeric .retention-sort{justify-content:flex-end;text-align:right;width:100%}
.retention-card .retention-value{min-width:0;text-align:right}
@media(max-width:600px){
 .retention-card .retention-numeric{display:none}
 .retention-card table{table-layout:fixed}
 .retention-card th:first-child,.retention-card td:first-child{width:43%;white-space:normal;overflow-wrap:anywhere}
 .retention-card th:nth-child(4),.retention-card td:nth-child(4){white-space:normal;overflow-wrap:normal;word-break:normal}
 .retention-card .retention-sort{max-width:100%;white-space:normal;gap:4px}
 .retention-card .retention-sort span:first-child{min-width:0;overflow-wrap:anywhere}
 .retention-sort span[aria-hidden]{flex-shrink:0}
 .retention-card .retention-rating{box-sizing:border-box;max-width:100%;white-space:normal;overflow-wrap:normal;word-break:normal}
 .season-archives .archive-numeric{display:none}
 .season-archives table{table-layout:fixed}
 .season-archives th,.season-archives td{padding:8px 5px;white-space:normal;overflow-wrap:anywhere}
 .season-archives th:first-child,.season-archives td:first-child{width:43%}
 .season-archives .retention-sort{max-width:100%;white-space:normal}
 .season-archives .retention-sort span{min-width:0}
 .season-archives .retention-rating{box-sizing:border-box;max-width:100%;white-space:normal;overflow-wrap:normal;word-break:normal}
}

.retention-card .retention-bar{margin-left:0;margin-right:10px;vertical-align:middle}
/* The desktop alignment transform creates a stacking context. Raise that
   context above sticky table headings so the details popup can overlap them. */
.compact-status{display:none;position:relative;z-index:20}

 @media(min-width:1200px){
 header.page-layout{display:grid;grid-template-columns:minmax(230px,1fr) minmax(0,1279px);align-items:center;gap:0 32px;padding-top:20px;grid-template-rows:minmax(100px,auto) auto}
 header.page-layout .page-title{grid-column:1;grid-row:1;margin:0;padding:0}
 header.page-layout .header-tools{position:static;grid-column:2;grid-row:1;width:100%;min-width:0}
 .header-tools>.header-actions{position:absolute;top:16px;right:24px}
 .header-tools .compact-status{padding-right:56px;box-sizing:border-box}
 header.page-layout .page-title h1{font-size:30px}
 header.page-layout .header-status{display:none}
 .plan-layout .status-card{display:none}
 header.page-layout .tab-list{grid-column:1/-1;grid-row:2;margin-top:8px}
 header.page-layout .tab-list button{font-size:16px}
 .compact-status{grid-column:2;grid-row:1;display:grid;grid-template-columns:minmax(250px,600px) 110px 125px minmax(235px,300px);align-items:start;gap:48px;min-width:0;padding:0;justify-self:end;align-self:center;transform:translateY(7px);width:100%}
 .compact-badges{min-width:0;margin:0;display:grid;grid-template-rows:44px auto;align-content:start}
 .compact-badges .status-badges{gap:8px;margin:0}
 .compact-status .status-pill{font-size:14px;line-height:1.2;padding:5px 8px;white-space:nowrap}
 .compact-status .status-info{width:15px;height:15px;flex-basis:15px}
 .compact-metric{display:grid;grid-template-rows:44px auto;gap:0;align-content:start;min-width:0}
 .compact-label,.compact-metric>span{font-size:14px;font-weight:600;line-height:1.3;margin-bottom:12px;color:var(--secondary-text-color,#526671)}
 .compact-metric>strong{padding-top:3px;font-size:20px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}
 .compact-metric small{font-size:12px;font-weight:400}
 .compact-secondary{display:grid;grid-template-rows:44px auto auto;justify-items:start;align-content:start;gap:0}.compact-secondary>.status-pill{margin:0 0 6px}
 .compact-status.compact-no-water{grid-template-columns:minmax(250px,600px) 110px minmax(235px,300px);max-width:1106px}
 .compact-extra{position:relative;padding:0;margin:0;border:0;font-size:12px}
 .compact-extra>summary{list-style:revert;display:list-item;cursor:pointer;font-size:12px;font-weight:normal;margin:0;color:var(--secondary-text-color,#526671)}
 .compact-extra>summary span{font-variant-numeric:tabular-nums}
 .compact-extra-body{position:absolute;right:0;top:calc(100% + 10px);z-index:80;width:320px;border:1px solid var(--divider-color,#c4d0d6);border-radius:10px;padding:16px;background:var(--card-background-color,white);box-shadow:0 5px 20px #0002}
 .compact-extra-body h3{margin:0 0 14px;font-size:16px}
 .compact-extra-body dl{margin:0;display:grid;gap:4px}
 .compact-extra-body dt{color:var(--secondary-text-color,#526671);font-size:12px}
 .compact-extra-body dd{margin:0 0 8px;font-size:14px}
 .compact-extra-body p{margin:4px 0 0;font-size:13px}
 }

 @media(min-width:1200px) and (max-width:1599px){
 .compact-status{grid-template-columns:minmax(280px,1fr) 110px 125px minmax(190px,220px);gap:24px;transform:translateY(4px)}
 .compact-status .status-pill{font-size:14px;padding:5px 8px}
 .compact-status .status-info{width:15px;height:15px;flex-basis:15px}
 .compact-badges .status-badges{gap:6px}
 .compact-status.compact-no-water{grid-template-columns:minmax(280px,1fr) 110px minmax(190px,220px)}
 }
 

/* Price source and transfer time/rate pairs use explicit rows, not auto-flow. */
#settings .price-settings-fields{max-width:1000px}
#settings .price-settings-fields .grid.price-fields{grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:16px}
#settings .price-transfer-fields{border-top:1px solid var(--divider-color,#dce4e8);padding-top:16px}
#settings .price-fields input[type="time"]{width:180px;max-width:100%}
@media(max-width:600px){
 #settings .price-settings-fields .grid.price-fields{grid-template-columns:minmax(0,1fr)}
}

#settings .away-settings-fields{display:grid;gap:20px}
#settings .away-settings-fields>.grid{grid-template-columns:repeat(3,minmax(0,1fr))}
@media(max-width:600px){#settings .away-settings-fields>.grid{grid-template-columns:minmax(0,1fr)}}
#settings{--settings-columns-width:1480px}
#settings .settings-source-columns,
#settings[data-settings-page="settings"]>.sticky{width:100%;max-width:var(--settings-columns-width)}
#settings>.settings-sources{
  position:relative;container:settings-sources / inline-size;
  width:100%;min-width:0;padding:0;border:0;border-radius:0;background:none;box-shadow:none;
}
.settings-pipework{display:none}
@container settings-sources (min-width:1850px){
 .settings-pipework{
   position:absolute;inset:0 0 0 calc(var(--settings-columns-width) + 48px);
   display:grid;place-items:center;pointer-events:none;user-select:none;
   color:var(--primary-text-color,#213547);opacity:.32;
 }
 .settings-pipework svg{display:block;width:min(92%,1080px);max-height:100%}
 .settings-pipework .pipework-surface{fill:var(--card-background-color,#fff)}
 .settings-pipework .pipework-accent,.settings-pipework .pipework-code{
   color:#098048;color:light-dark(#098048,#55ed9b)
 }
 .settings-pipework .pipework-accent{stroke:currentColor}
 .settings-pipework .pipework-code{
   fill:currentColor;font:600 10px ui-monospace,monospace;
   writing-mode:vertical-rl;text-orientation:upright;letter-spacing:2px;
 }
 .settings-pipework .pipework-faint{opacity:.35}
 .settings-pipework .pipework-tube{stroke:currentColor}
 .settings-pipework .pipework-interior{stroke:var(--card-background-color,#fff)}
}
#settings>.settings-sources>h2{margin-bottom:14px}
.settings-source-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,480px),1fr));gap:14px;align-items:start}
.settings-source-column{display:grid;min-width:0;gap:14px}
#settings .settings-source-column>.settings-group{
  min-width:0;margin:0;padding:16px;border:1px solid var(--divider-color,#dce4e8);border-radius:12px;
  background:linear-gradient(var(--settings-tint,#8080801a),var(--settings-tint,#8080801a)),var(--card-background-color,#fff);
}
.settings-sources [data-setting-group="heating_enabled"]{--settings-tint:#2196f311}
.settings-sources [data-setting-group="price_entity"]{--settings-tint:#536be71a}
.settings-sources [data-setting-group="solar_power_entity"]{--settings-tint:#e4902513}
.settings-sources [data-setting-group="away_automatic"]{--settings-tint:#c6588618}
.settings-sources [data-setting-group="weather_entity"]{--settings-tint:#65a54324}
#settings .settings-source-column h3{margin:0 0 10px}
.maintenance-settings h4{font-size:14px;margin:0 0 8px}
.maintenance-settings .backup-controls{border-top:1px solid var(--divider-color,#dce4e8);margin-top:12px;padding-top:12px}
#settings .settings-source-column .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px}
#settings .settings-source-column [data-integration-group]>.grid{grid-template-columns:repeat(3,minmax(0,1fr))}
#settings .settings-source-column .price-settings-fields .grid.price-fields{margin-bottom:10px}
#settings .settings-source-column .price-transfer-fields>.grid:last-child{margin-bottom:0}
#settings .settings-source-column .price-transfer-fields{padding-top:10px}
#settings .settings-source-column .away-settings-fields{gap:12px}
@media(max-width:600px){
 #settings .settings-source-column>.settings-group{padding:14px}
 #settings .settings-source-column .grid,
 #settings .settings-source-column [data-integration-group]>.grid,
 #settings .settings-source-column .price-settings-fields .grid.price-fields{grid-template-columns:minmax(0,1fr)}
}
</style>
    <header class="page-layout ${['settings','rooms'].includes(this.tab)?'settings-layout':this.tab==='history'?'history-layout observation-layout':'plan-layout observation-layout'}"><div class="page-title"><button type="button" class="menu-button" id="ha-menu" aria-label="Open Home Assistant menu" title="Open Home Assistant menu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button><img class="header-logo" src="/thermal_pilot/icon.png" width="36" height="36" alt="" aria-hidden="true"><h1>ThermalPilot</h1></div>${this.headerStatus()}<div class="header-tools"><div class="header-actions">${this.notificationButton()}${this.awayCalendarButton()}</div>${this.compactStatusView()}</div><nav class="tab-list" role="tablist" aria-label="ThermalPilot pages">${[['overview','Plan'],['history','History'],['rooms','Climate setup'],['settings','Settings']].map(([id,label])=>`<button id="tab-${id}" role="tab" aria-selected="${this.tab===id}" aria-controls="thermal-pilot-tab-panel" tabindex="${this.tab===id?0:-1}" data-tab="${id}" class="${this.tab===id?'active':''}">${label}</button>`).join('')}</nav>${this.message&&!this.saveConfirmation&&!(['settings','rooms'].includes(this.tab)&&this.messageLevel==='error')?`${statusNotice(this.message,this.messageLevel||'info','message')}`:''}</header><main id="thermal-pilot-tab-panel" role="tabpanel" aria-labelledby="tab-${this.tab}" class="tab-panel page-layout ${['settings','rooms'].includes(this.tab)?'settings-layout':this.tab==='history'?'history-layout observation-layout':'plan-layout observation-layout'}">${!this.info?'Loading…':['settings','rooms'].includes(this.tab)?this.settingsView(this.tab):this.tab==='history'?this.historyView():this.overview()}</main>${this.message&&this.saveConfirmation?`<div class="message save-toast notice-info" role="status" aria-live="polite">${statusIcon('info')}<span class="notice-text">${escapeHTML(this.t(this.message))}</span></div>`:''}${this.message&&!this.saveConfirmation&&['settings','rooms'].includes(this.tab)&&this.messageLevel==='error'?`<div class="message save-toast notice-error save-error" role="alert" aria-live="assertive" tabindex="-1">${statusIcon('error')}<span class="notice-text">${escapeHTML(this.t(this.message))}</span><button type="button" id="dismiss-save-error" aria-label="Dismiss error notification" title="Dismiss error notification">×</button></div>`:''}`;
    this.shadowRoot.querySelector('#dismiss-save-error')?.addEventListener('click',()=>{this.message='';this.saveConfirmation=false;this.shadowRoot.querySelector('.save-error')?.remove();});
    this.shadowRoot.querySelector('.save-error')?.focus?.({preventScroll:true});
    this.shadowRoot.querySelector('#ha-menu')?.addEventListener('click',()=>this.openSidebar());
    this.shadowRoot.querySelector('#notification-center')?.addEventListener('click',()=>this.openNotifications());
    this.bindStatusTemperatures();
    this.bindHistorySections();
    this.bindResponsiveTemperatureCharts();
    this.bindSettingTooltips();
    const statusDetails=this.shadowRoot.querySelector('#status-details');statusDetails?.addEventListener('toggle',()=>{this.statusDetailsOpen=statusDetails.open;});
    const retention=this.shadowRoot.querySelector('#retention-accordion');if(retention)retention.addEventListener('toggle',()=>{this.retentionOpen=retention.open;});
    const retentionHelp=this.shadowRoot.querySelector('#retention-help');retentionHelp?.addEventListener('toggle',()=>{this.retentionHelpOpen=retentionHelp.open;});
    const priceAccordion=this.shadowRoot.querySelector('#price-accordion');if(priceAccordion){const tab=this.tab;priceAccordion.addEventListener('toggle',()=>{this.priceAccordionState??={};this.priceAccordionState[tab]=priceAccordion.open;});}
    this.shadowRoot.querySelectorAll('[data-away-calendar]').forEach(button=>button.addEventListener('click',event=>this.openAwayCalendar(event.currentTarget)));
    this.shadowRoot.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>this.switchTab(b.dataset.tab));
    this.shadowRoot.querySelector('.tab-list')?.addEventListener('keydown',event=>{
      const tabs=['overview','history','rooms','settings'],index=tabs.indexOf(event.target.dataset.tab);
      let next;
      if(event.key==='ArrowRight')next=(index+1)%tabs.length;
      else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=tabs.length-1;
      else return;
      event.preventDefault();this.focusTabRequested=true;this.switchTab(tabs[next]);
    });
    if(this.focusTabRequested){this.shadowRoot.querySelector(`[data-tab="${this.tab}"]`)?.focus();this.focusTabRequested=false;}

    this.translateRoot(this.shadowRoot);
    this.updateNotifications();
    this.shadowRoot.querySelector('#add')?.addEventListener('click',()=>{this.message='';this.capture();this.settings.rooms.push({...this.info.room_defaults,id:roomId()});this.render();});
    this.shadowRoot.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{
      this.capture();const index=Number(b.dataset.remove),room=this.settings.rooms[index];if(!room)return;
      const zones=(this.settings.heating_zones||[]).filter(zone=>zone.id===room.heating_zone_id||(this.zoneRoomDrafts?.[zone.id]||[]).includes(room.id));
      const warning=zones.length?'\n\n'+this.t('This room belongs to a zone. Removing it also removes its zone membership.')+'\n'+zones.map(zone=>zone.name||this.t('New zone')).join(', '):'';
      if(!confirm(this.t(`Remove room "${room.name||'New room'}"? Save settings to apply this change.`)+warning))return;
      this.message='';this.settings.rooms.splice(index,1);
      for(const fireplace of this.settings.fireplaces||[])fireplace.room_ids=(fireplace.room_ids||[]).filter(id=>id!==room.id);
      for(const member of this.settings.rooms)member.shared_air_rooms=(member.shared_air_rooms||[]).filter(id=>id!==room.id);
      for(const zone of this.settings.heating_zones||[]){
        if(this.zoneRoomDrafts?.[zone.id])this.zoneRoomDrafts[zone.id]=this.zoneRoomDrafts[zone.id].filter(id=>id!==room.id);
        if(zone.main_room_id===room.id)zone.main_room_id=this.settings.rooms.find(member=>member.heating_zone_id===zone.id)?.id||'';
      }
      this.render();
    });
    this.shadowRoot.querySelectorAll('[data-reset]').forEach(b=>b.onclick=async()=>{const zone=b.dataset.reset.startsWith('zone:')?this.settings.heating_zones?.find(z=>'zone:'+z.id===b.dataset.reset):null;if(!confirm(zone?this.t('Reset learning')+': '+zone.name+'?':this.t('Reset the learned parameters for this room? Observation history will be retained.')))return;try{await this.call('reset',{room_id:b.dataset.reset});this.message=zone?this.t('Learning reset.'):'Room learning reset.';this.messageLevel='info';this.saveConfirmation=false;}catch(e){this.message=e.message;this.messageLevel='error';this.saveConfirmation=false;}this.capture();this.render();});
    const settingsForm=this.shadowRoot.querySelector('#settings');
    const clearSaveMessage=()=>{clearTimeout(this.saveMessageTimer);this.saveConfirmation=false;this.message='';this.shadowRoot.querySelector('.message')?.remove();};
    settingsForm?.addEventListener('input',event=>{
      const rangeField=event.target?.dataset?.solarRange;
      if(rangeField){
        const number=event.target.closest('.solar-threshold')?.querySelector('[data-field]');
        if(number)number.value=event.target.value;
      }else if(['source.solar_start_kw','source.solar_stop_kw'].includes(event.target?.dataset?.field)){
        const slider=event.target.closest('.solar-threshold')?.querySelector('[data-solar-range]');
        if(slider){slider.max=Math.max(20,Math.ceil(Number(event.target.value||0)/10)*10);slider.value=event.target.value;}
      }
      clearSaveMessage();this.sourceCheck=null;this.sourceCheckError='';this.shadowRoot.querySelector('[data-source-check-results]')?.replaceChildren();this.updateUnsavedNotice();
      const field=event.target?.dataset?.field;
      if(field?.startsWith('room')&&field.endsWith('.baseline')){
        const target=event.target.closest('.room-card')?.querySelector('.room-target');
        if(target)target.textContent=`${event.target.value||'—'} °C`;
      }
    });
    this.shadowRoot.querySelectorAll('[data-settings-disclosure]').forEach(d=>{d.open=settingsOpen.has(d.dataset.settingsDisclosure);});
    settingsForm?.addEventListener('click',event=>{
      const button=event.target.closest?.('[data-add-sensor],[data-remove-sensor]');if(!button)return;
      event.preventDefault();this.capture(true);const list=button.closest('[data-entity-list]');const [obj,key]=this.settingsFieldTarget(list.dataset.entityList);
      const values=key==='zone_rooms'?this.zoneRoomDrafts[obj.id]:obj[key];
      if(button.hasAttribute('data-add-sensor'))values.push('');
      else if(key==='shared_air_rooms')this.updateSharedAirRooms(obj.id,values.filter((id,index)=>id&&index!==Number(button.dataset.removeSensor)));
      else values.splice(Number(button.dataset.removeSensor),1);
      if(key==='zone_rooms'){const selected=new Set(values.filter(Boolean));this.settings.rooms.forEach(room=>{if(room.heating_zone_id===obj.id&&!selected.has(room.id))room.heating_zone_id='';});if(!selected.has(obj.main_room_id))obj.main_room_id=this.settings.rooms.find(room=>selected.has(room.id))?.id||'';}
      clearSaveMessage();this.render();
    });
    settingsForm?.addEventListener('change',event=>{this.updateSourceReadings();if(event?.target?.closest?.('[data-entity-list]')?.dataset.entityList?.endsWith('.garage_door_entities')){this.capture(true);clearSaveMessage();this.render();return;}if((event?.target?.hasAttribute?.('data-zone-member')||event?.target?.hasAttribute?.('data-shared-air-member')||event?.target?.hasAttribute?.('data-fireplace-link'))){this.capture(true);clearSaveMessage();this.render();return;}if(['is_garage','garage_heat_source','garage_use_fan_only','air_use_fan_only','heat_control','thermostat','heating_zone_id','heating_priority','fireplace_entity','fireplace_circulation','heating_enabled','source_type','climate_mode'].some(key=>event?.target?.dataset?.field?.endsWith('.'+key))){this.capture();const field=event.target.dataset.field;const room=field.startsWith('room')?this.settings.rooms[Number(field.split('.')[0].slice(4))]:null;if(room?.is_garage&&['is_garage','thermostat'].some(key=>field.endsWith('.'+key))){const modes=this._hass.states[room.thermostat]?.attributes?.fan_modes||[];for(const [key,mode] of [['garage_fan_heat','high'],['garage_fan_idle','low'],['garage_fan_presence','medium']])if(!room[key]&&modes.includes(mode))room[key]=mode;}this.render();return;}if(['source.price_entity','source.transfer_tariff','source.nordpool_entry','source.solar_power_entity','source.away_automatic'].includes(event?.target?.dataset?.field)){this.capture();this.render();return;}if(event?.target?.dataset?.field==='source.fireplace_entity'){this.capture();this.render();return;}if(event?.target?.dataset?.field==='source.house_heat_source'){this.capture();this.render();return;}if(event?.target?.dataset?.field==='source.language'){this.capture();this.render();return;}if(event?.target?.dataset?.field==='source.house_distribution'){this.capture();this.render();return;}clearSaveMessage();this.updateUnsavedNotice();if(event?.target?.dataset?.field?.endsWith('.solar_direction')){const exposure=event.target.closest('.room-card')?.querySelector('[data-solar-exposure]');if(exposure)exposure.hidden=event.target.value==='disabled';}});
    this.shadowRoot.querySelector('#settings-cancel')?.addEventListener('click',()=>this.discardSettingsChanges());
    settingsForm?.addEventListener('submit',async e=>{
      e.preventDefault();if(this.saving||this.backupBusy)return;this.capture();
      const enableLive=electricHeating(this.settings)&&this.settings.simulation_enabled===false&&!this.info.settings?.live_control_confirmed;
      if(enableLive&&this.settings.rooms.some(r=>r.is_garage||r.heat_control==='air_to_air'||r.heating_zone_id)&&!confirm(this.t('Air-to-air heat pump control changes HVAC modes, fan modes and any selected swing mode. Simulation sends no heat pump commands. Enable live control?')))return;
      if(enableLive&&!confirm(this.t('Enable real thermostat control? If another automation controls these thermostats, disable it first. ThermalPilot will apply its scheduled targets, even while the model is still learning. Missing essential data returns affected rooms to their seasonal fallback temperature.')))return;
      clearSaveMessage();this.saving=true;
      const saveButton=settingsForm.querySelector('button[type=submit]');
      if(saveButton)saveButton.textContent=this.t('Saving…');
      settingsForm.querySelectorAll('input,select,button').forEach(control=>control.disabled=true);
      try{
        await this.call('save',{settings:this.settings,enable_live_control:enableLive});
        this.settings.live_control_confirmed=!this.settings.simulation_enabled;this.info.settings=structuredClone(this.settings);this.message=`Settings saved at ${new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}. Suggestions will update shortly.`;this.saveConfirmation=true;this.messageLevel='info';
        const confirmation=this.message;
        clearTimeout(this.saveMessageTimer);
        this.saveMessageTimer=setTimeout(()=>{if(this.saveConfirmation&&this.message===confirmation){this.message='';this.saveConfirmation=false;this.shadowRoot.querySelector('.save-toast')?.remove();}},5000);
      }
      catch(error){this.message=`Settings were not saved: ${error.message||String(error)}`;this.messageLevel='error';this.saveConfirmation=false;}
      finally{this.saving=false;this.render();}
    });
    this.shadowRoot.querySelector('[data-test-sources]')?.addEventListener('click',()=>this.testSources());
    this.shadowRoot.querySelector('#backup-export')?.addEventListener('click',()=>this.transferBackup());
    this.shadowRoot.querySelector('#backup-import')?.addEventListener('click',()=>this.shadowRoot.querySelector('#backup-file')?.click());
    this.shadowRoot.querySelector('#backup-file')?.addEventListener('change',event=>{const file=event.target.files?.[0];if(file)this.transferBackup(file);});
    const disclosureTab=this.tab;
    this.shadowRoot.querySelectorAll('[data-room-accordion]').forEach(details=>details.addEventListener('toggle',()=>{this.roomDisclosureState.set(`${disclosureTab}:${details.dataset.roomAccordion}`,details.open);}));
    this.shadowRoot.querySelectorAll('[data-forecast-hours]').forEach(select=>select.addEventListener('change',event=>{this.forecastHours=Number(event.target.value);this.render();}));
    this.shadowRoot.querySelectorAll('[data-retention-sort]').forEach(button=>button.addEventListener('click',()=>this.sortRetention(button.dataset.retentionSort)));
    this.shadowRoot.querySelectorAll('[data-archive-sort]').forEach(button=>button.addEventListener('click',()=>this.sortArchives(button.dataset.archiveSort)));
    this.mountAccordionScrolling();
    this.mountLanguagePicker();
    this.mountPriceChartSizing();
    this.shadowRoot.querySelector('#add-fireplace')?.addEventListener('click',()=>{
      this.capture();
      this.settings.fireplaces??=[];
      const fireplace={...structuredClone(this.info.fireplace_defaults),id:roomId()};
      this.settings.fireplaces.push(fireplace);
      this.render();
      const details=this.shadowRoot.querySelector(`[data-settings-disclosure="${fireplace.id}"]`);
      if(details)details.open=true;
    });
    this.shadowRoot.querySelectorAll('[data-remove-fireplace]').forEach(button=>button.addEventListener('click',()=>{
      this.capture();
      const index=Number(button.dataset.removeFireplace);
      const fireplace=this.settings.fireplaces[index];
      if(!confirm(this.t('Remove fireplace')+' '+(fireplace.name||this.t('New fireplace'))+'?'))return;
      this.settings.fireplaces.splice(index,1);
      for(const zone of this.settings.heating_zones||[]){
        zone.fireplace_ids=(zone.fireplace_ids||[]).filter(id=>id!==fireplace.id);
      }
      this.render();
    }));
    this.shadowRoot.querySelector('#add-zone')?.addEventListener('click',()=>{this.capture();this.settings.heating_zones??=[];const zone={...this.info.zone_defaults,id:roomId()};this.settings.heating_zones.push(zone);this.render();const accordion=this.shadowRoot.querySelector(`[data-settings-disclosure="${zone.id}"]`);if(accordion)accordion.open=true;});
    this.shadowRoot.querySelectorAll('[data-remove-zone]').forEach(button=>button.addEventListener('click',()=>{this.capture();const zone=this.settings.heating_zones[Number(button.dataset.removeZone)];if(!confirm(this.t('Remove zone')+' '+zone.name+'?'))return;this.settings.heating_zones.splice(Number(button.dataset.removeZone),1);this.settings.rooms.forEach(room=>{if(room.heating_zone_id===zone.id){room.heating_zone_id='';}});this.render();}));
    this.shadowRoot.querySelectorAll('[data-history-period]').forEach(select=>select.addEventListener('change',event=>this.setHistoryPeriod(event.target.value,event.target.id)));
  }
}
if(!customElements.get('thermal-pilot-panel'))customElements.define('thermal-pilot-panel',ThermalPilotPanel);
