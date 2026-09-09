from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any


@dataclass(frozen=True)
class ControlPlan:
    priority: str
    state: str
    actions: tuple[tuple[str, str, dict[str, Any]], ...] = field(default_factory=tuple)


def _hex_to_rgb(value: str) -> list[int] | None:
    value = str(value or "").lstrip("#")
    if len(value) != 6:
        return None
    try:
        return [int(value[index:index + 2], 16) for index in (0, 2, 4)]
    except ValueError:
        return None


def public_override(value: dict[str, Any]) -> dict[str, Any]:
    """Return JSON-safe override data for live datetimes and stored strings."""
    return {
        key: (item.isoformat() if hasattr(item, "isoformat") else str(item))
        if key in ("start", "until") and item is not None else item
        for key, item in value.items()
    }


def manual_override_until(now, next_start, timeout_minutes: int | float | None):
    """Expire a manual change at the timeout or next node, whichever is first."""
    try:
        minutes = max(0.0, float(timeout_minutes or 0))
    except (TypeError, ValueError):
        minutes = 0.0
    if minutes <= 0:
        return next_start
    return min(next_start, now + timedelta(minutes=minutes))


def _same_number(actual: Any, expected: Any) -> bool:
    """Compare attributes without letting an unavailable value abort startup."""
    try:
        return float(actual) == float(expected)
    except (TypeError, ValueError):
        return False


def plan_is_satisfied(
    plan: ControlPlan, target_state: str | None, target_attributes: dict[str, Any] | None = None
) -> bool:
    """Return whether the target still reflects the plan that was last applied."""
    attributes = target_attributes or {}
    if plan.priority == "boost" and not plan.actions:
        return True
    if plan.priority in ("away", "mode", "boost"):
        if plan.state in ("away_off", "mode_off"):
            return target_state == "off"
        if plan.state == "mode_on":
            return target_state == "on"
        payloads = [payload for _, _, payload in plan.actions]
        preset = next((payload.get("preset_mode") for payload in payloads if payload.get("preset_mode")), None)
        temperature = next((payload.get("temperature") for payload in payloads if payload.get("temperature") is not None), None)
        if preset is not None and attributes.get("preset_mode") != preset:
            return False
        if temperature is not None and not _same_number(attributes.get("temperature"), temperature):
            return False
        return True
    if plan.state == "no_action":
        return True
    if plan.state == "scheduled_off":
        return target_state == "off"
    if plan.state == "scheduled_on":
        if target_state != "on":
            return False
        payload = plan.actions[0][2] if plan.actions else {}
        if payload.get("brightness_pct") is not None:
            actual = round(float(attributes.get("brightness", 0)) / 2.55)
            if abs(actual - float(payload["brightness_pct"])) > 1:
                return False
        if payload.get("color_temp_kelvin") is not None and attributes.get("color_temp_kelvin") != payload["color_temp_kelvin"]:
            return False
        if payload.get("rgb_color") is not None and list(attributes.get("rgb_color") or []) != list(payload["rgb_color"]):
            return False
        return True
    if plan.state.startswith("scheduled_"):
        if target_state == "off":
            return False
        temperature = next((payload.get("temperature") for _, service, payload in plan.actions if service == "set_temperature"), None)
        if temperature is not None and not _same_number(attributes.get("temperature"), temperature):
            return False
        return True
    return False


def build_control_plan(
    target_entity: str,
    schedule_on: bool,
    schedule_data: dict[str, Any] | None = None,
    boost_on: bool = False,
    target_state: str | None = None,
    target_attributes: dict[str, Any] | None = None,
) -> ControlPlan:
    """Translate current inputs into deterministic HA service actions."""
    if boost_on:
        return ControlPlan("boost", "boost_active")

    data = schedule_data or {}
    domain = target_entity.split(".", 1)[0]
    if not schedule_on:
        if domain == "climate":
            actions = (("climate", "set_hvac_mode", {"entity_id": target_entity, "hvac_mode": "off"}),)
            return ControlPlan("schedule", "scheduled_off", actions)
        return ControlPlan("schedule", "no_action")

    if domain == "climate":
        actions: list[tuple[str, str, dict[str, Any]]] = []
        target_attributes = target_attributes or {}
        if target_state == "off" and "heat" in target_attributes.get("hvac_modes", []):
            actions.append(("climate", "set_hvac_mode", {"entity_id": target_entity, "hvac_mode": "heat"}))
        mode = data.get("mode")
        if data.get("target_temp") is not None:
            actions.append(("climate", "set_temperature", {"entity_id": target_entity, "temperature": data["target_temp"]}))
        return ControlPlan("schedule", f"scheduled_{mode or 'on'}", tuple(actions))

    mode = data.get("mode")
    if mode == "off":
        return ControlPlan("schedule", "scheduled_off", ((domain, "turn_off", {"entity_id": target_entity}),))

    if domain == "light":
        payload = {"entity_id": target_entity}
        for key in ("brightness_pct", "color_temp_kelvin"):
            if data.get(key) is not None:
                payload[key] = data[key]
        color = _hex_to_rgb(data.get("color_hex", ""))
        if color is not None:
            payload["rgb_color"] = color
        elif data.get("rgb_color") is not None:
            payload["rgb_color"] = data["rgb_color"]
        return ControlPlan("schedule", "scheduled_on", (("light", "turn_on", payload),))

    return ControlPlan("schedule", "scheduled_on", ((domain, "turn_on", {"entity_id": target_entity}),))


def build_mode_plan(
    target_entity: str,
    rule: dict[str, Any],
    target_state: str | None = None,
    target_attributes: dict[str, Any] | None = None,
) -> ControlPlan:
    """Build one configured operating-mode action for a target."""
    domain = target_entity.split(".", 1)[0]
    attributes = target_attributes or {}
    action = rule.get("action", "none")
    if action == "none":
        return ControlPlan("mode", "mode_no_action")
    if domain in ("light", "switch"):
        service = "turn_on" if action == "on" else "turn_off"
        return ControlPlan("mode", f"mode_{action}", ((domain, service, {"entity_id": target_entity}),))
    if domain == "climate":
        if action == "off":
            return ControlPlan(
                "mode",
                "mode_off",
                (("climate", "set_hvac_mode", {"entity_id": target_entity, "hvac_mode": "off"}),),
            )
        actions: list[tuple[str, str, dict[str, Any]]] = []
        if target_state == "off" and "heat" in attributes.get("hvac_modes", []):
            actions.append(("climate", "set_hvac_mode", {"entity_id": target_entity, "hvac_mode": "heat"}))
        requested = str(rule.get("preset", "away")).lower()
        temperature = float(rule.get("temperature", 12))
        actions.append(("climate", "set_temperature", {"entity_id": target_entity, "temperature": temperature}))
        return ControlPlan("mode", f"mode_{requested}_{temperature:g}", tuple(actions))
    return ControlPlan("mode", "mode_no_action")


def build_native_boost_plan(
    target_entity: str,
    boost: dict[str, Any],
    target_state: str | None = None,
    target_attributes: dict[str, Any] | None = None,
) -> ControlPlan:
    """Build an enforceable, backend-owned climate boost plan."""
    if not target_entity.startswith("climate."):
        return ControlPlan("boost", "boost_active")
    attributes = target_attributes or {}
    actions: list[tuple[str, str, dict[str, Any]]] = []
    if target_state == "off" and "heat" in attributes.get("hvac_modes", []):
        actions.append(("climate", "set_hvac_mode", {"entity_id": target_entity, "hvac_mode": "heat"}))
    requested = str(boost.get("preset") or "").strip()
    if requested and requested in attributes.get("preset_modes", []):
        actions.append(("climate", "set_preset_mode", {"entity_id": target_entity, "preset_mode": requested}))
    if boost.get("temperature") is not None:
        actions.append(("climate", "set_temperature", {"entity_id": target_entity, "temperature": float(boost["temperature"])}))
    return ControlPlan("boost", "boost_active", tuple(actions))


def build_away_plan(target_entity, target_state=None, target_attributes=None):
    """Compatibility wrapper for the original Away defaults."""
    domain = target_entity.split(".", 1)[0]
    rule = {"action": "off"} if domain in ("light", "switch") else {"action": "preset", "preset": "away", "temperature": 12}
    return build_mode_plan(target_entity, rule, target_state, target_attributes)
