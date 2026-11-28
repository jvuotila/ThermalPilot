import sys, types, tempfile, unittest
import json
from contextlib import closing
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]/'custom_components/thermal_pilot'
pkg=types.ModuleType('thermal_pilot');pkg.__path__=[str(ROOT)];sys.modules.setdefault('thermal_pilot',pkg)
from thermal_pilot.history import HistoryDatabase
from thermal_pilot.model import collection_state, initial_model
from thermal_pilot.const import DEFAULTS as BASE_DEFAULTS,ROOM_DEFAULTS
DEFAULTS=BASE_DEFAULTS


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.db=HistoryDatabase(Path(self.temp.name)/'history.sqlite3');self.db.initialize()
    def tearDown(self):self.temp.cleanup()
    def row(self,time=900):
        return {'room_id':'test','time':time,'temperature':20,'outdoor':-10,'activity':1,'prediction':20.1}
    def test_five_minute_deduplication(self):
        self.db.append([self.row(),self.row(901)],0,'2026-2027')
        self.assertEqual(self.db.size()['rows'],1)
        self.assertEqual(self.db.read(0)[0]['time'],901)
    def test_collection_start_survives_retention_and_migrates(self):
        self.assertIsNone(self.db.size()['started_at'])
        self.db.append([self.row(900),self.row(1200)],0,'2026-2027')
        self.db.append([],2000,'2026-2027')
        self.assertEqual(self.db.size()['started_at'],900)
        with self.db._connect() as con:
            con.execute("DELETE FROM metadata WHERE key='collection_started_at'")
        self.db.initialize()
        self.assertEqual(self.db.size()['started_at'],900)
    def test_retention(self):
        self.db.append([self.row(0),self.row(3600)],3000,'2026-2027')
        self.assertEqual(self.db.size()['rows'],1)
    def test_compaction_preserves_full_season_and_model(self):
        self.db.append([self.row(0),self.row(900)],-1,'2026-2027')
        self.db.append([self.row(3600)],3000,'2026-2027')
        model=initial_model(ROOM_DEFAULTS)
        self.db.compact_season('2026-2027',{'test':model},{'test':['sensor.room']},4000)
        self.assertEqual(self.db.size()['rows'],0)
        archive=self.db.summaries()[0]
        self.assertEqual(archive['statistics']['samples'],3)
        self.assertEqual(archive['model']['gain'],model['gain'])
        self.assertEqual(archive['mapping_fingerprint'],['sensor.room'])
    def test_compaction_is_idempotent(self):
        self.db.append([self.row()],0,'2026-2027')
        for _ in range(2):self.db.compact_season('2026-2027',{'test':initial_model(ROOM_DEFAULTS)},{},0)
        self.assertEqual(len(self.db.summaries()),1)

    def forecast_room(self, temperature=20, demand=True):
        from datetime import datetime,timezone
        slots=[{'start':datetime.fromtimestamp(i*900,timezone.utc).isoformat(),
                'end':datetime.fromtimestamp((i+1)*900,timezone.utc).isoformat(),
                'temperature':temperature+(i+1)/24,'predicted_demand':demand} for i in range(24)]
        return {'test':{'temperature':temperature,'forecast_context':['sensor.room'], 'plan':{'slots':slots}}}

    def observed_forecast_rows(self, end=21600, activity=1):
        return [{**self.row(t),'forecast_context':['sensor.room'],'temperature':22,'activity':activity} for t in range(0,end+1,300)]

    def test_hourly_forecasts_freeze_original_values_and_survive_restart(self):
        self.db.record_forecasts(self.forecast_room(),0,-1)
        self.db.record_forecasts(self.forecast_room(99),100,-1)
        # Forecasts must survive restarting the integration/database object.
        restarted=HistoryDatabase(self.db.path);restarted.initialize()
        restarted.append(self.observed_forecast_rows(),-1)
        rows=restarted.read(0)
        due={r['time']:r for r in rows}
        for h in (1,3,6):
            self.assertAlmostEqual(due[h*3600][f'forecast_{h}h'],20+h/6)
            detail=due[h*3600][f'forecast_{h}h_details']
            self.assertEqual(detail['issued'],0)
            self.assertEqual(detail['persistence_error'],2)
            self.assertEqual(detail['heating_match'],1)
        stat=restarted.forecast_accuracy(0)['test']['3']
        self.assertEqual(stat['count'],1);self.assertAlmostEqual(stat['mae'],1.5)
        self.assertEqual(stat['persistence_mae'],2)

    def test_forecasts_do_not_fill_missing_future_measurements(self):
        self.db.record_forecasts(self.forecast_room(),0,-1)
        self.db.append(self.observed_forecast_rows(end=1800),-1)
        self.assertFalse(any('forecast_1h' in r for r in self.db.read(0)))
        self.db.append(self.observed_forecast_rows(end=21600)[-1:],-1)
        matched=self.db.read(0)[-1]
        self.assertIn('forecast_6h',matched)
        self.assertIsNone(matched['forecast_6h_details']['heating_match'])

    def test_chart_history_projects_fields_and_matches_only_recent_forecasts(self):
        self.db.record_forecasts(self.forecast_room(), 0, -1)
        observations = self.observed_forecast_rows()
        observations[1].update(time=305, water=31, suggested_heat=1, price=17)
        self.db.append(observations, -1)
        zone = {'room_id': 'zone:one', 'zone_id': 'one', 'time': 900, 'zone_mode': 'cool'}
        self.db.append_zones([zone], -1)

        plan = self.db.read_chart(304)
        self.assertEqual(plan[0], {'room_id': 'test', 'time': 305, 'activity': 1,
                                   'outdoor': -10, 'water': 31, 'suggested_heat': 1})
        self.assertIn(zone, plan)
        self.assertFalse(any('forecast_3h' in row for row in plan))

        history = {row['time']: row for row in self.db.read_chart(304, 10900)
                   if row['room_id'] == 'test'}
        self.assertEqual(history[305]['price'], 17)
        self.assertEqual(history[305]['suggested_heat'], 1)
        self.assertNotIn('forecast_1h', history[3600])
        full = {row['time']: row for row in self.db.read(304) if row['room_id'] == 'test'}
        self.assertEqual(history[10800]['forecast_3h_details'], full[10800]['forecast_3h_details'])
        self.assertEqual(history[21600]['forecast_6h_details'], full[21600]['forecast_6h_details'])
        self.assertNotIn('forecast_context', history[21600])

    def test_trimmed_plan_chart_matches_direct_reads_for_rooms_and_zones(self):
        self.db.append([self.row(901.25), self.row(1200.5), self.row(1500)], 0)
        self.db.append_zones([
            {'room_id': 'zone:one', 'zone_id': 'one', 'time': time, 'zone_mode': 'heat'}
            for time in (902.5, 1200.5, 1510)
        ], 0)
        broad = self.db.read_chart(900)
        for cutoff in (900, 900.99, 901, 901.5, 1199.25, 1200.75, 1201, 1500, 1501):
            with self.subTest(cutoff=cutoff):
                self.assertEqual(self.db.trim_plan_chart(broad, cutoff), self.db.read_chart(cutoff))

    def test_different_actual_heating_is_reported_and_context_changes_are_excluded(self):
        self.db.record_forecasts(self.forecast_room(demand=True),0,-1)
        self.db.append(self.observed_forecast_rows(activity=0),-1)
        matched=next(r for r in self.db.read(0) if r['time']==10800)
        self.assertEqual(matched['forecast_3h_details']['heating_match'],0)
        self.assertEqual(self.db.forecast_accuracy(0)['test']['3']['similar_heating_count'],0)
        self.db.append([{**matched,'forecast_context':['sensor.other']}],-1)
        # Stored observations never contain evaluated fields; real append payloads use raw readings.
        with self.db._connect() as con:
            import json
            raw={**self.row(10800),'forecast_context':['sensor.other']}
            con.execute('UPDATE observations SET payload=? WHERE time=10800',(json.dumps(raw),))
        self.assertNotIn('forecast_3h',next(r for r in self.db.read(0) if r['time']==10800))

    def test_short_price_horizon_does_not_invent_three_or_six_hour_forecasts(self):
        rooms=self.forecast_room();rooms['test']['plan']['slots']=rooms['test']['plan']['slots'][:4]
        self.db.record_forecasts(rooms,0,-1)
        with self.db._connect() as con:
            self.assertEqual([r[0] for r in con.execute('SELECT horizon FROM forecasts')],[1])

    def test_zone_history_is_independent_bounded_and_keeps_standby_boundaries(self):
        rows=[{'room_id':'zone:one','zone_id':'one','time':time,'zone_mode':mode,'zone_basis':'activity','zone_entity':'climate.pump'} for time,mode in [(900,'heat'),(1200,None),(1500,'cool')]]
        self.db.append_zones(rows,0)
        self.assertEqual([r['zone_mode'] for r in self.db.read(0)],['heat',None,'cool'])
        self.db.append_zones([{**rows[-1],'time':1501,'zone_mode':None}],0)
        self.assertEqual(len(self.db.read(0)),3)
        self.assertEqual(self.db.read(0)[-1]['zone_mode'],None)
        self.assertEqual(self.db.forecast_accuracy(0),{})
        self.db.append_zones([],1300)
        self.assertEqual(len(self.db.read(0)),1)

    def test_roomwise_accuracy_matches_history_with_cutoffs_and_replaced_samples(self):
        rooms = self.forecast_room()
        rooms['other'] = {**rooms['test'], 'forecast_context': ['sensor.other']}
        self.db.record_forecasts(rooms, 0, -1)
        observations = self.observed_forecast_rows()
        observations += [{**row, 'room_id': 'other', 'forecast_context': ['sensor.other'], 'activity': None}
                         for row in observations]
        self.db.append(observations, -1)
        self.db.append([{**observations[12], 'time': 3601, 'temperature': 23}], -1)
        # A later forecast of the same horizon can match the same observation.
        with self.db._connect() as connection:
            raw = connection.execute(
                "SELECT payload FROM forecasts WHERE room_id='test' AND horizon=1"
            ).fetchone()[0]
            later = {**json.loads(raw), 'issued': 200, 'due': 3700, 'temperature': 21}
            connection.execute('INSERT INTO forecasts VALUES (?,?,?,?,?)',
                               ('test', 1, 1, later['due'], json.dumps(later)))

        details = next(row for row in self.db.read(0) if row['time'] == 3601)
        self.assertEqual(details['forecast_1h_details']['error'], 2)
        for cutoff in (0, 3601, 3602, 10801, 21601):
            with self.subTest(cutoff=cutoff):
                expected = {}
                for row in self.db.read(cutoff):
                    for hours in (1, 3, 6):
                        detail = row.get(f'forecast_{hours}h_details')
                        if detail:
                            expected.setdefault(row['room_id'], {})[str(hours)] = detail
                actual = self.db.forecast_accuracy(cutoff)
                self.assertEqual(actual.keys(), expected.keys())
                for room, horizons in expected.items():
                    self.assertEqual(actual[room].keys(), horizons.keys())
                    for horizon, detail in horizons.items():
                        stat = actual[room][horizon]
                        similar = detail['heating_match'] is not None and detail['heating_match'] >= 0.9
                        self.assertEqual(stat['count'], 1)
                        self.assertEqual(stat['mae'], detail['error'])
                        self.assertEqual(stat['persistence_mae'], detail['persistence_error'])
                        self.assertEqual(stat['similar_heating_count'], int(similar))
                        self.assertEqual(stat['similar_heating_mae'], detail['error'] if similar else None)

    def test_accuracy_reads_one_snapshot_while_observations_are_replaced(self):
        rooms = self.forecast_room()
        rooms['zzz'] = rooms['test']
        self.db.record_forecasts(rooms, 0, -1)
        rows = self.observed_forecast_rows()
        self.db.append(rows + [{**row, 'room_id': 'zzz'} for row in rows], -1)
        with closing(self.db._forecast_accuracy_rows(0)) as reader:
            first = next(reader)
            self.assertEqual(first['room_id'], 'test')
            self.db.append([{**rows[12], 'room_id': 'zzz', 'temperature': 30}], -1)
            old_observation = next(row for row in reader if row['room_id'] == 'zzz' and row['time'] == 3600)
            self.assertEqual(old_observation['temperature'], 22)
        self.assertAlmostEqual(self.db.forecast_accuracy(0)['zzz']['1']['mae'], 30 - (20 + 1/6))


class SeasonTests(unittest.TestCase):
    def test_active_collects_in_warm_weather(self):
        self.assertTrue(collection_state({},25,0,DEFAULTS)['collecting'])
    def test_passive_does_not_collect_in_cold_weather(self):
        self.assertFalse(collection_state({},-20,0,{**DEFAULTS,'heating_enabled':False})['collecting'])
    def test_weather_does_not_change_manual_activity(self):
        s=collection_state({},-10,0,DEFAULTS)
        s=collection_state(s,25,300,DEFAULTS)
        self.assertTrue(s['collecting'])
    def test_legacy_pause_mode_is_ignored(self):
        self.assertTrue(collection_state({},10,0,{**DEFAULTS,'collection_mode':'paused'})['collecting'])
    def test_missing_outdoor_pauses(self):
        self.assertFalse(collection_state({},None,0,DEFAULTS)['collecting'])
    def test_legacy_average_is_removed(self):
        self.assertNotIn('average',collection_state({'average':10},5,0,DEFAULTS))

