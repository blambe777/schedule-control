import importlib.util
import pathlib
import sys
import unittest
from datetime import datetime, timedelta


MODEL_PATH = pathlib.Path(__file__).parents[1] / "custom_components" / "schedule_control" / "model.py"
SPEC = importlib.util.spec_from_file_location("schedule_control_model", MODEL_PATH)
MODEL = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODEL
SPEC.loader.exec_module(MODEL)


class ControlPlanTests(unittest.TestCase):
    def test_manual_override_uses_timeout_when_it_is_sooner(self):
        now = datetime(2026, 9, 9, 10, 0)
        next_node = now + timedelta(hours=3)
        self.assertEqual(MODEL.manual_override_until(now, next_node, 60), now + timedelta(hours=1))

    def test_manual_override_still_ends_at_an_earlier_node(self):
        now = datetime(2026, 9, 9, 10, 0)
        next_node = now + timedelta(minutes=30)
        self.assertEqual(MODEL.manual_override_until(now, next_node, 60), next_node)

    def test_zero_timeout_preserves_next_node_only_behaviour(self):
        now = datetime(2026, 9, 9, 10, 0)
        next_node = now + timedelta(hours=8)
        self.assertEqual(MODEL.manual_override_until(now, next_node, 0), next_node)

    def test_stored_boost_timestamps_are_json_safe(self):
        live = datetime(2026, 9, 4, 15, 30)
        self.assertEqual(MODEL.public_override({"start": live, "until": "2026-09-04T16:30:00"}), {
            "start": "2026-09-04T15:30:00", "until": "2026-09-04T16:30:00"
        })

    def test_boost_always_wins_without_service_action(self):
        plan = MODEL.build_control_plan("climate.kitchen", False, {}, True)
        self.assertEqual((plan.priority, plan.state, plan.actions), ("boost", "boost_active", ()))

    def test_gap_turns_climate_off(self):
        plan = MODEL.build_control_plan("climate.kitchen", False)
        self.assertEqual(plan.actions[0], ("climate", "set_hvac_mode", {"entity_id": "climate.kitchen", "hvac_mode": "off"}))

    def test_internal_preset_applies_only_its_temperature(self):
        plan = MODEL.build_control_plan("climate.kitchen", True, {"mode": "comfort", "target_temp": 21.5})
        self.assertEqual(plan.state, "scheduled_comfort")
        self.assertEqual([action[1] for action in plan.actions], ["set_temperature"])
        self.assertEqual(plan.actions[0][2]["temperature"], 21.5)

    def test_active_heating_restores_supported_heat_mode(self):
        plan = MODEL.build_control_plan("climate.kitchen", True, {"mode": "eco"}, False, "off", {"hvac_modes": ["off", "heat"], "preset_modes": ["eco"]})
        self.assertEqual([action[1] for action in plan.actions], ["set_hvac_mode"])

    def test_internal_preset_name_is_not_forwarded_to_thermostat(self):
        plan = MODEL.build_control_plan("climate.kitchen", True, {"mode": "away", "target_temp": 14})
        self.assertNotIn("set_preset_mode", [action[1] for action in plan.actions])
        self.assertEqual(plan.actions[0], ("climate", "set_temperature", {"entity_id": "climate.kitchen", "temperature": 14}))

    def test_switch_period_turns_on(self):
        plan = MODEL.build_control_plan("switch.pump", True, {"mode": "on"})
        self.assertEqual(plan.actions, (("switch", "turn_on", {"entity_id": "switch.pump"}),))

    def test_switch_gap_takes_no_action(self):
        plan = MODEL.build_control_plan("switch.pump", False)
        self.assertEqual((plan.state, plan.actions), ("no_action", ()))
        self.assertTrue(MODEL.plan_is_satisfied(plan, "on"))
        self.assertTrue(MODEL.plan_is_satisfied(plan, "off"))

    def test_explicit_switch_off_period_turns_off(self):
        plan = MODEL.build_control_plan("switch.pump", True, {"mode": "off"})
        self.assertEqual((plan.state, plan.actions), ("scheduled_off", (("switch", "turn_off", {"entity_id": "switch.pump"}),)))

    def test_explicit_light_off_period_turns_off(self):
        plan = MODEL.build_control_plan("light.lamp", True, {"mode": "off"})
        self.assertEqual((plan.state, plan.actions), ("scheduled_off", (("light", "turn_off", {"entity_id": "light.lamp"}),)))

    def test_light_forwards_supported_schedule_values(self):
        data = {"mode": "on", "brightness_pct": 60, "color_temp_kelvin": 3200, "color_hex": "#0a141e"}
        plan = MODEL.build_control_plan("light.lamp", True, data)
        self.assertEqual(plan.actions[0][2], {"entity_id": "light.lamp", "brightness_pct": 60, "color_temp_kelvin": 3200, "rgb_color": [10, 20, 30]})

    def test_switch_plan_reasserts_when_target_is_still_off(self):
        plan = MODEL.build_control_plan("switch.pump", True, {"mode": "on"})
        self.assertFalse(MODEL.plan_is_satisfied(plan, "off"))
        self.assertTrue(MODEL.plan_is_satisfied(plan, "on"))

    def test_light_plan_checks_requested_values(self):
        plan = MODEL.build_control_plan("light.lamp", True, {"brightness_pct": 60, "color_hex": "#0a141e"})
        self.assertTrue(MODEL.plan_is_satisfied(plan, "on", {"brightness": 153, "rgb_color": [10, 20, 30]}))
        self.assertFalse(MODEL.plan_is_satisfied(plan, "on", {"brightness": 10, "rgb_color": [10, 20, 30]}))

    def test_away_turns_lights_and_switches_off(self):
        for entity in ("light.lamp", "switch.pump"):
            plan = MODEL.build_away_plan(entity, "on", {})
            self.assertEqual(plan.priority, "mode")
            self.assertEqual(plan.actions[0][1], "turn_off")
            self.assertFalse(MODEL.plan_is_satisfied(plan, "on"))
            self.assertTrue(MODEL.plan_is_satisfied(plan, "off"))

    def test_away_uses_integration_temperature_not_thermostat_preset(self):
        away = MODEL.build_away_plan("climate.room", "heat", {"preset_modes": ["eco", "away"]})
        eco = MODEL.build_away_plan("climate.room", "heat", {"preset_modes": ["eco"]})
        self.assertNotIn("set_preset_mode", [service for _, service, _ in away.actions])
        self.assertNotIn("set_preset_mode", [service for _, service, _ in eco.actions])
        self.assertEqual(away.actions[-1][2]["temperature"], 12)

    def test_away_climate_falls_back_to_low_temperature(self):
        plan = MODEL.build_away_plan("climate.room", "heat", {"preset_modes": []})
        self.assertEqual(plan.actions[-1][2]["temperature"], 12)
        self.assertTrue(MODEL.plan_is_satisfied(plan, "heat", {"temperature": 12}))

    def test_custom_mode_can_leave_one_target_unaffected(self):
        plan = MODEL.build_mode_plan("light.lamp", {"action": "none"}, "on", {})
        self.assertEqual((plan.priority, plan.state, plan.actions), ("mode", "mode_no_action", ()))

    def test_custom_party_mode_can_turn_selected_light_on(self):
        plan = MODEL.build_mode_plan("light.lamp", {"action": "on"}, "off", {})
        self.assertEqual(plan.actions, (("light", "turn_on", {"entity_id": "light.lamp"}),))

    def test_climate_off_mode_really_turns_hvac_off(self):
        plan = MODEL.build_mode_plan("climate.room", {"action": "off"}, "heat", {"hvac_modes": ["off", "heat"]})
        self.assertEqual(plan.state, "mode_off")
        self.assertEqual(plan.actions, (("climate", "set_hvac_mode", {"entity_id": "climate.room", "hvac_mode": "off"}),))
        self.assertTrue(MODEL.plan_is_satisfied(plan, "off", {}))

    def test_native_boost_applies_temperature_and_supported_preset(self):
        plan = MODEL.build_native_boost_plan(
            "climate.room", {"temperature": 22, "preset": "comfort"}, "off",
            {"hvac_modes": ["off", "heat"], "preset_modes": ["eco", "comfort"]},
        )
        self.assertEqual(plan.priority, "boost")
        self.assertEqual([action[1] for action in plan.actions], ["set_hvac_mode", "set_preset_mode", "set_temperature"])
        self.assertFalse(MODEL.plan_is_satisfied(plan, "heat", {"preset_mode": "comfort", "temperature": 20}))
        self.assertTrue(MODEL.plan_is_satisfied(plan, "heat", {"preset_mode": "comfort", "temperature": 22}))

    def test_missing_temperature_does_not_abort_controller_startup(self):
        plan = MODEL.ControlPlan(
            "mode", "mode_active",
            (("climate", "set_temperature", {"temperature": 12}),),
        )
        self.assertFalse(MODEL.plan_is_satisfied(plan, "heat", {"temperature": None}))


if __name__ == "__main__":
    unittest.main()
