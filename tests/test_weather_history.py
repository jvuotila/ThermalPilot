"""Saved weather is bounded, shared across rooms and frozen before its target hour."""
import json
from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'custom_components/thermal_pilot'
pkg = types.ModuleType('thermal_pilot')
pkg.__path__ = [str(ROOT)]
sys.modules.setdefault('thermal_pilot', pkg)
from thermal_pilot.history import HistoryDatabase


class WeatherHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'history.sqlite3'
        self.db = HistoryDatabase(self.path)
        self.db.initialize()
        self.now = datetime(2026, 11, 12, 9, tzinfo=timezone.utc).timestamp()

    def tearDown(self):
        self.temp.cleanup()

    def forecast(self, hour, temperature=2, condition='cloudy'):
        return {'datetime': datetime.fromtimestamp(hour, timezone.utc).isoformat(),
                'temperature': temperature, 'condition': condition}

    def stored(self):
        with self.db._connect() as connection:
            value = connection.execute("SELECT value FROM metadata WHERE key='weather_forecast_hours'").fetchone()
        return json.loads(value[0]) if value else []

    def test_latest_pre_hour_forecast_freezes_and_survives_restart(self):
        target = self.now + 3600
        self.assertEqual(self.db.save_weather_forecasts([self.forecast(target)], self.now, self.now), [])
        self.db.save_weather_forecasts([self.forecast(target, 3, 'rainy')], self.now + 1800, self.now + 1800)
        restarted = HistoryDatabase(self.path)
        restarted.initialize()
        history = restarted.save_weather_forecasts([self.forecast(target, 9, 'sunny')], target + 300, target + 300)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]['temperature'], 3)
        self.assertEqual(history[0]['condition'], 'rainy')
        self.assertEqual(history[0]['issued'], self.now + 1800)

    def test_new_forecast_cannot_backfill_old_hours(self):
        self.db.save_weather_forecasts([self.forecast(self.now - 3600)], self.now, self.now)
        self.assertEqual(self.stored(), [])

    def test_hourly_deduplication_and_seven_day_retention(self):
        rows = [self.forecast(self.now + hour * 3600) for hour in range(170)]
        self.db.save_weather_forecasts(rows + rows, self.now, self.now)
        self.assertLessEqual(len(self.stored()), 169)
        self.db.save_weather_forecasts(rows, self.now, self.now + 1200)
        self.assertEqual(len({row['time'] for row in self.stored()}), len(self.stored()))
        history = self.db.save_weather_forecasts([], self.now, self.now + 8 * 86400)
        self.assertTrue(history)
        self.assertTrue(all(row['time'] >= self.now + 86400 for row in history))
        self.db.save_weather_forecasts([], self.now, self.now + 15 * 86400)
        self.assertEqual(self.stored(), [])

    def test_missing_new_forecast_keeps_saved_history(self):
        self.db.save_weather_forecasts([self.forecast(self.now + 3600, -4)], self.now, self.now)
        history = self.db.save_weather_forecasts([], self.now + 7200, self.now + 7200)
        self.assertEqual(history[0]['temperature'], -4)
