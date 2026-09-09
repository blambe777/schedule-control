from __future__ import annotations

import logging
from datetime import timedelta

from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Event, HomeAssistant
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.sun import get_astral_event_date
from homeassistant.util import dt as dt_util

from .const import DEFAULT_SCAN_SECONDS
from .model import ControlPlan, build_mode_plan, build_native_boost_plan, build_control_plan, manual_override_until, plan_is_satisfied, public_override
from .storage import ConfigurationStore, MappingStore, OwnershipStore

_LOGGER = logging.getLogger(__name__)


class ScheduleController:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.store = MappingStore(hass)
        self.ownership_store = OwnershipStore(hass)
        self.configuration_store = ConfigurationStore(hass)
        self.mappings: dict[str, dict] = {}
        self.cards: dict[str, dict] = {}
        self.thermostat_config: dict = {}
        self.mapping_status: dict[str, str] = {}
        self.override_info: dict[str, dict] = {}
        self._manual_overrides: dict[str, dict] = {}
        self._last_plans: dict[str, ControlPlan] = {}
        self._applying: set[str] = set()
        self._suppress_until: dict[str, object] = {}
        self._mode_listeners: set = set()
        self._unsub = None
        self._unsub_state = None

    async def async_start(self) -> None:
        self.mappings = await self.store.load()
        self.cards = await self.ownership_store.load()
        self.thermostat_config = await self.configuration_store.load()
        valid_prefixes = {
            f"{card_id}:{group_id}:"
            for card_id, card in self.cards.items()
            for group_id in card.get("groups", {})
        }
        self.mappings = {
            mapping_id: mapping
            for mapping_id, mapping in self.mappings.items()
            if any(mapping_id.startswith(prefix) for prefix in valid_prefixes)
        }
        await self.store.save(self.mappings)
        await self.async_evaluate_all()
        self._unsub = async_track_time_interval(
            self.hass, self._interval_update, timedelta(seconds=DEFAULT_SCAN_SECONDS)
        )
        self._unsub_state = self.hass.bus.async_listen(EVENT_STATE_CHANGED, self._state_changed)

    async def async_stop(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None
        if self._unsub_state:
            self._unsub_state()
            self._unsub_state = None

    async def _state_changed(self, event: Event) -> None:
        entity_id = event.data.get("entity_id")
        affected = [
            mapping_id for mapping_id, mapping in self.mappings.items()
            if entity_id in (mapping.get("target"), mapping.get("boost"), mapping.get("boost_timer"), mapping.get("schedule"))
            and mapping_id not in self._applying
            and dt_util.utcnow() >= self._suppress_until.get(mapping_id, dt_util.utcnow())
        ]
        for mapping_id in affected:
            mapping = self.mappings.get(mapping_id, {})
            new_state = event.data.get("new_state")
            domain = str(entity_id).split(".", 1)[0]
            if entity_id == mapping.get("target") and domain in ("climate", "light", "switch") and new_state is not None:
                is_user_climate_change = domain == "climate" and new_state.context.user_id is not None
                is_external_binary_change = domain in ("light", "switch")
                if not (is_user_climate_change or is_external_binary_change):
                    await self.async_evaluate(mapping_id)
                    continue
                schedule = self.hass.states.get(mapping.get("schedule"))
                now = dt_util.now()
                next_start = self._next_start(mapping.get("week", {}), schedule, now) if schedule else now + timedelta(hours=24)
                until = manual_override_until(now, next_start, mapping.get("manual_override_timeout", 0))
                manual = {
                    "kind": "manual",
                    "start": now,
                    "until": until,
                    "temperature": new_state.attributes.get("temperature"),
                    "preset": new_state.attributes.get("preset_mode"),
                    "state": new_state.state,
                    "brightness": new_state.attributes.get("brightness"),
                }
                self._manual_overrides[mapping_id] = manual
                self.override_info[mapping_id] = self._public_override(manual)
                self.mapping_status[mapping_id] = "manual_override"
            await self.async_evaluate(mapping_id)

    async def async_set_mapping(self, mapping_id: str, data: dict) -> None:
        for existing_id, existing in tuple(self.mappings.items()):
            if existing_id != mapping_id and existing.get("target") == data["target"]:
                self.mappings.pop(existing_id, None)
                self.mapping_status.pop(existing_id, None)
                self._last_plans.pop(existing_id, None)
        self.mappings[mapping_id] = {
            "target": data["target"],
            "schedule": data["schedule"],
            "boost": data.get("boost", ""),
            "boost_timer": data.get("boost_timer", ""),
            "enabled": data.get("enabled", True),
            "week": data.get("week", {}),
            "manual_override_timeout": max(0, int(data.get("manual_override_timeout", 0) or 0)),
        }
        await self.store.save(self.mappings)
        self._last_plans.pop(mapping_id, None)
        self._manual_overrides.pop(mapping_id, None)
        self.override_info.pop(mapping_id, None)
        await self.async_evaluate(mapping_id)

    async def async_delete_mapping(self, mapping_id: str) -> None:
        self.mappings.pop(mapping_id, None)
        self.mapping_status.pop(mapping_id, None)
        self._last_plans.pop(mapping_id, None)
        self._manual_overrides.pop(mapping_id, None)
        self.override_info.pop(mapping_id, None)
        await self.store.save(self.mappings)

    async def async_remove_group(self, card_id: str, group_id: str) -> None:
        """Forget one group only after its native helper has been removed."""
        card = self.cards.get(card_id)
        if not card:
            return
        card.get("groups", {}).pop(group_id, None)
        card.get("boosts", {}).pop(group_id, None)
        for mode in card.get("modes", []):
            mode.get("schedules", {}).pop(group_id, None)
        card.get("mode_profile", {}).get("schedules", {}).pop(group_id, None)
        deleted = set(card.get("deleted_groups", []))
        deleted.add(group_id)
        card["deleted_groups"] = sorted(deleted)
        prefix = f"{card_id}:{group_id}:"
        for mapping_id in [item for item in self.mappings if item.startswith(prefix)]:
            self.mappings.pop(mapping_id, None)
            self.mapping_status.pop(mapping_id, None)
            self._last_plans.pop(mapping_id, None)
            self._manual_overrides.pop(mapping_id, None)
            self.override_info.pop(mapping_id, None)
        await self.store.save(self.mappings)
        await self.ownership_store.save(self.cards)

    async def async_reset_card(self, card_id: str) -> None:
        """Remove every backend record for a card after helper cleanup succeeds."""
        self.cards.pop(card_id, None)
        prefix = f"{card_id}:"
        for mapping_id in [item for item in self.mappings if item.startswith(prefix)]:
            self.mappings.pop(mapping_id, None)
            self.mapping_status.pop(mapping_id, None)
            self._last_plans.pop(mapping_id, None)
            self._manual_overrides.pop(mapping_id, None)
            self.override_info.pop(mapping_id, None)
        await self.store.save(self.mappings)
        await self.ownership_store.save(self.cards)
        self._notify_mode_listeners(card_id)

    async def async_reconcile_card(self, card_id: str, groups: list[dict], modes: list[dict] | None = None) -> list[str]:
        previous_card = self.cards.get(card_id, {})
        previous = previous_card.get("groups", {})
        current = {group["group_id"]: group for group in groups}
        deleted_groups = set(previous_card.get("deleted_groups", []))
        schedules_to_delete: set[str] = set()
        for group_id, group in previous.items():
            if group_id in current:
                continue
            deleted_groups.add(group_id)
            prefix = f"{card_id}:{group_id}:"
            for mapping_id in [item for item in self.mappings if item.startswith(prefix)]:
                self.mappings.pop(mapping_id, None)
                self.mapping_status.pop(mapping_id, None)
                self._last_plans.pop(mapping_id, None)
            if group.get("schedule"):
                schedules_to_delete.add(group["schedule"])
        deleted_groups.difference_update(current)
        self.cards[card_id] = {
            "groups": current,
            "deleted_groups": sorted(deleted_groups),
            "mode": previous_card.get("mode", "normal"),
            "mode_profile": previous_card.get("mode_profile", {}),
            "modes": modes if modes is not None else previous_card.get("modes", []),
            "boosts": previous_card.get("boosts", {}),
        }
        await self.store.save(self.mappings)
        await self.ownership_store.save(self.cards)
        return sorted(schedules_to_delete)

    async def async_cleanup_cards(self, active_card_ids: list[str], scan_complete: bool) -> dict:
        """Prepare orphan cleanup without discarding ownership prematurely."""
        if not scan_complete:
            return {"card_ids": [], "delete_schedules": []}
        active = set(active_card_ids)
        schedules_to_delete: set[str] = set()
        orphan_ids = [item for item in self.cards if item not in active]
        for card_id in orphan_ids:
            card = self.cards[card_id]
            for group_id, group in card.get("groups", {}).items():
                if group.get("schedule"):
                    schedules_to_delete.add(group["schedule"])
                prefix = f"{card_id}:{group_id}:"
                schedules_to_delete.update(
                    mapping.get("schedule", "")
                    for mapping_id, mapping in self.mappings.items()
                    if mapping_id.startswith(prefix)
                )
        return {
            "card_ids": orphan_ids,
            "delete_schedules": sorted(item for item in schedules_to_delete if item),
        }

    async def async_finalize_cleanup_cards(self, card_ids: list[str]) -> None:
        """Commit orphan cleanup after the frontend confirms helper deletion."""
        for card_id in card_ids:
            await self.async_reset_card(card_id)

    async def async_set_card_mode(self, card_id: str, mode: str, profile: dict | None = None) -> None:
        card = self.cards.setdefault(card_id, {"groups": {}, "deleted_groups": []})
        if mode != "normal" and not profile:
            profile = next((item for item in card.get("modes", []) if item.get("id") == mode), None)
        card["mode"] = mode or "normal"
        card["mode_profile"] = profile or {}
        if profile and profile.get("id"):
            card["modes"] = [
                *[item for item in card.get("modes", []) if item.get("id") != profile["id"]],
                profile,
            ]
        await self.ownership_store.save(self.cards)
        self._notify_mode_listeners(card_id)
        for mapping_id in [item for item in self.mappings if item.startswith(f"{card_id}:")]:
            self._last_plans.pop(mapping_id, None)
            self._manual_overrides.pop(mapping_id, None)
            self.override_info.pop(mapping_id, None)
            await self.async_evaluate(mapping_id)

    async def async_set_modes(self, card_id: str, modes: list[dict]) -> None:
        """Persist card mode definitions independently of schedule changes."""
        card = self.cards.setdefault(card_id, {"groups": {}, "deleted_groups": []})
        card["modes"] = modes
        active = card.get("mode", "normal")
        if active != "normal":
            profile = next((item for item in modes if item.get("id") == active), None)
            if profile is None:
                card["mode"] = "normal"
                card["mode_profile"] = {}
            else:
                card["mode_profile"] = profile
        await self.ownership_store.save(self.cards)
        self._notify_mode_listeners(card_id)

    async def async_set_thermostat_config(self, configuration: dict) -> None:
        """Persist integration-wide thermostats, internal presets and groups."""
        entities = list(dict.fromkeys(str(item) for item in configuration.get("entities", []) if str(item).startswith("climate.")))
        presets = []
        seen_presets = set()
        for item in configuration.get("presets", []):
            preset_id = str(item.get("id") or item.get("name") or "preset").lower().replace(" ", "_")
            if preset_id in seen_presets:
                continue
            seen_presets.add(preset_id)
            presets.append({"id": preset_id, "name": str(item.get("name") or preset_id.title()), "temperature": float(item.get("temperature", 20)), "color": str(item.get("color") or "#2563eb"), "icon": str(item.get("icon") or "mdi:thermometer")})
        groups = []
        used_entities = set()
        for index, item in enumerate(configuration.get("groups", [])):
            members = [entity for entity in dict.fromkeys(item.get("entities", [])) if entity in entities and entity not in used_entities]
            used_entities.update(members)
            groups.append({"id": str(item.get("id") or f"thermostat_group_{index + 1}"), "name": str(item.get("name") or f"Thermostat group {index + 1}"), "entities": members})
        templates = []
        seen_templates = set()
        for index, item in enumerate(configuration.get("templates", [])):
            template_id = str(item.get("id") or f"routine_{index + 1}")
            if template_id in seen_templates or not isinstance(item.get("week"), dict):
                continue
            seen_templates.add(template_id)
            templates.append({
                "id": template_id,
                "name": str(item.get("name") or f"Routine {index + 1}"),
                "card_id": str(item.get("card_id") or ""),
                "week": item["week"],
                "routine": item.get("routine", {}),
            })
        self.thermostat_config = {"entities": entities, "presets": presets, "groups": groups, "templates": templates}
        await self.configuration_store.save(self.thermostat_config)

    async def async_start_boost(self, card_id: str, group_id: str, duration: int, temperature: float | None = None, preset: str = "") -> dict:
        card = self.cards.setdefault(card_id, {"groups": {}, "deleted_groups": []})
        if group_id not in card.get("groups", {}):
            raise ValueError(f"Unknown schedule/group ID: {group_id}")
        now = dt_util.now()
        boost = {
            "start": now.isoformat(),
            "until": (now + timedelta(minutes=max(1, int(duration)))).isoformat(),
            "temperature": temperature,
            "preset": preset or "",
        }
        existing = card.setdefault("boosts", {}).get(group_id)
        card["boosts"][group_id] = boost
        await self.ownership_store.save(self.cards)
        event = "schedule_control_boost_extended" if existing else "schedule_control_boost_started"
        self.hass.bus.async_fire(event, {"card_id": card_id, "group_id": group_id, **boost})
        mapping_ids = [item for item in self.mappings if item.startswith(f"{card_id}:{group_id}:")]
        mapped_targets = {self.mappings[item].get("target") for item in mapping_ids}
        for target_id in card["groups"][group_id].get("targets", []):
            if target_id in mapped_targets or not str(target_id).startswith("climate."):
                continue
            target = self.hass.states.get(target_id)
            if not target:
                continue
            plan = build_native_boost_plan(target_id, boost, target.state, dict(target.attributes))
            try:
                for domain, service, payload in plan.actions:
                    await self.hass.services.async_call(domain, service, payload, blocking=True)
            except Exception:  # noqa: BLE001 - one thermostat must not block the group
                _LOGGER.exception("Failed to apply direct boost for %s", target_id)
        for mapping_id in mapping_ids:
            self._last_plans.pop(mapping_id, None)
            self._manual_overrides.pop(mapping_id, None)
            await self.async_evaluate(mapping_id)
        return boost

    async def async_cancel_boost(self, card_id: str, group_id: str, reason: str = "cancelled") -> None:
        card = self.cards.get(card_id, {})
        boost = card.get("boosts", {}).pop(group_id, None)
        if not boost:
            return
        await self.ownership_store.save(self.cards)
        event = "schedule_control_boost_finished" if reason == "finished" else "schedule_control_boost_cancelled"
        self.hass.bus.async_fire(event, {"card_id": card_id, "group_id": group_id})
        for mapping_id in [item for item in self.mappings if item.startswith(f"{card_id}:{group_id}:")]:
            self._last_plans.pop(mapping_id, None)
            self.override_info.pop(mapping_id, None)
            await self.async_evaluate(mapping_id)

    def add_mode_listener(self, callback):
        self._mode_listeners.add(callback)
        return lambda: self._mode_listeners.discard(callback)

    def _notify_mode_listeners(self, card_id: str) -> None:
        for callback in tuple(self._mode_listeners):
            callback(card_id)

    async def _interval_update(self, _now) -> None:
        await self.async_evaluate_all()

    async def async_evaluate_all(self) -> None:
        for mapping_id in tuple(self.mappings):
            await self.async_evaluate(mapping_id)

    async def async_evaluate(self, mapping_id: str) -> None:
        mapping = self.mappings.get(mapping_id)
        if not mapping or not mapping.get("enabled", True):
            self.mapping_status[mapping_id] = "disabled"
            return
        schedule = self.hass.states.get(mapping["schedule"])
        target = self.hass.states.get(mapping["target"])
        if not schedule or not target:
            self.mapping_status[mapping_id] = "unavailable"
            return
        boost_id = mapping.get("boost")
        boost = self.hass.states.get(boost_id) if boost_id else None
        native_boost = str(target.attributes.get("preset_mode", "")).lower() == "boost"
        boost_on = native_boost or bool(boost and boost.state not in ("off", "idle", "unavailable", "unknown"))
        card_id = mapping_id.split(":", 1)[0]
        card = self.cards.get(card_id, {})
        card_mode = card.get("mode", "normal")
        group_id = mapping_id.split(":", 2)[1] if ":" in mapping_id else ""
        mode_rule = card.get("mode_profile", {}).get("schedules", {}).get(group_id)
        stored_boost = card.get("boosts", {}).get(group_id)
        if stored_boost:
            until = dt_util.parse_datetime(str(stored_boost.get("until", "")))
            if until is None or dt_util.now() >= dt_util.as_local(until):
                await self.async_cancel_boost(card_id, group_id, "finished")
                return
        schedule_on = schedule.state == "on"
        schedule_data = dict(schedule.attributes)
        anchored = self._anchored_state(mapping.get("week", {}))
        if anchored is not None:
            schedule_on, schedule_data = anchored
        if stored_boost:
            plan = build_native_boost_plan(mapping["target"], stored_boost, target.state, dict(target.attributes))
        elif boost_on:
            plan = build_control_plan(mapping["target"], schedule_on, schedule_data, True, target.state, dict(target.attributes))
        elif card_mode != "normal" and mode_rule and mode_rule.get("action") != "none":
            plan = build_mode_plan(mapping["target"], mode_rule, target.state, dict(target.attributes))
        else:
            plan = build_control_plan(mapping["target"], schedule_on, schedule_data, False, target.state, dict(target.attributes))
        if plan.priority == "boost":
            self.mapping_status[mapping_id] = "boost_active"
            self.override_info[mapping_id] = self._public_override(stored_boost) if stored_boost else self._boost_info(mapping, target)
            if not plan.actions:
                self._last_plans[mapping_id] = plan
                return
        previous_plan = self._last_plans.get(mapping_id)
        manual = self._manual_overrides.get(mapping_id)
        now = dt_util.now()
        manual_expired = bool(manual and now >= manual["until"])
        if manual and now < manual["until"] and (previous_plan == plan or plan.state == "no_action"):
            self.mapping_status[mapping_id] = "manual_override"
            self.override_info[mapping_id] = self._public_override(manual)
            return
        if manual:
            self._manual_overrides.pop(mapping_id, None)
            self.override_info.pop(mapping_id, None)
        satisfied = plan_is_satisfied(plan, target.state, dict(target.attributes))
        if plan.priority != "boost" and previous_plan == plan and not satisfied and mapping["target"].startswith("climate.") and not manual_expired:
            next_start = self._next_start(mapping.get("week", {}), schedule, now)
            until = manual_override_until(now, next_start, mapping.get("manual_override_timeout", 0))
            manual = {
                "kind": "manual",
                "start": now,
                "until": until,
                "temperature": target.attributes.get("temperature"),
                "preset": target.attributes.get("preset_mode"),
            }
            self._manual_overrides[mapping_id] = manual
            self.override_info[mapping_id] = self._public_override(manual)
            self.mapping_status[mapping_id] = "manual_override"
            return
        self.mapping_status[mapping_id] = plan.state
        self.override_info.pop(mapping_id, None)
        if previous_plan == plan and satisfied:
            return
        self._applying.add(mapping_id)
        self._suppress_until[mapping_id] = dt_util.utcnow() + timedelta(seconds=2)
        try:
            for domain, service, payload in plan.actions:
                await self.hass.services.async_call(domain, service, payload, blocking=True)
        except Exception:  # noqa: BLE001 - HA service errors must not stop other mappings
            _LOGGER.exception("Failed to apply %s for %s", plan.state, mapping_id)
            self.mapping_status[mapping_id] = "error"
            return
        finally:
            self._applying.discard(mapping_id)
        self._last_plans[mapping_id] = plan

    def _public_override(self, value: dict) -> dict:
        return public_override(value)

    def _boost_info(self, mapping: dict, target) -> dict:
        now = dt_util.now()
        timer = self.hass.states.get(mapping.get("boost_timer")) if mapping.get("boost_timer") else None
        finish = dt_util.parse_datetime(str(timer.attributes.get("finishes_at", ""))) if timer else None
        if finish is not None:
            finish = dt_util.as_local(finish)
        return self._public_override({"kind": "boost", "start": now, "until": finish, "temperature": target.attributes.get("temperature"), "preset": target.attributes.get("preset_mode")})

    def _next_start(self, week: dict, schedule, now):
        for day_offset in range(0, 8):
            date = (now + timedelta(days=day_offset)).date()
            day_name = date.strftime("%A").lower()
            for block in week.get(day_name, []):
                data = dict(block.get("data", {}))
                minute = self._edge_minute(block.get("from", "00:00"), data, "start", date)
                candidate = dt_util.start_of_local_day(now + timedelta(days=day_offset)) + timedelta(minutes=minute)
                if candidate > now:
                    return candidate
        event = dt_util.parse_datetime(str(schedule.attributes.get("next_event", "")))
        return dt_util.as_local(event) if event else now + timedelta(hours=24)

    def _anchored_state(self, week: dict) -> tuple[bool, dict] | None:
        """Evaluate weeks containing sunrise/sunset edges using HA's location."""
        if not week or not any(
            block.get("data", {}).get("start_anchor") or block.get("data", {}).get("end_anchor")
            for blocks in week.values() if isinstance(blocks, list)
            for block in blocks
        ):
            return None
        now = dt_util.now()
        minute = now.hour * 60 + now.minute + now.second / 60
        previous = now - timedelta(days=1)
        candidates = [
            (week.get(now.strftime("%A").lower(), []), now.date(), False),
            (week.get(previous.strftime("%A").lower(), []), previous.date(), True),
        ]
        for blocks, origin_day, carryover_only in candidates:
            for block in blocks:
                data = dict(block.get("data", {}))
                start = self._edge_minute(block.get("from", "00:00"), data, "start", origin_day)
                end = self._edge_minute(block.get("to", "24:00"), data, "end", origin_day)
                overnight = end <= start
                if overnight:
                    end = self._edge_minute(block.get("to", "24:00"), data, "end", origin_day + timedelta(days=1))
                active = (carryover_only and overnight and minute < end) or (
                    not carryover_only and ((overnight and minute >= start) or (not overnight and start <= minute < end))
                )
                if active:
                    return True, data
        return False, {}

    def _edge_minute(self, fallback: str, data: dict, edge: str, day) -> float:
        anchor = data.get(f"{edge}_anchor")
        if anchor in ("sunrise", "sunset"):
            event = get_astral_event_date(self.hass, anchor, day)
            if event is not None:
                local = dt_util.as_local(event)
                offset = int(data.get(f"{edge}_offset", 0))
                return max(0, min(1440, local.hour * 60 + local.minute + offset))
        hour, minute = [int(part) for part in str(fallback).split(":")[:2]]
        return hour * 60 + minute
