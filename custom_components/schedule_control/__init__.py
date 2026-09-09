from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.config_entries import SOURCE_IMPORT
from homeassistant.core import HomeAssistant
from homeassistant.components.http import StaticPathConfig
import voluptuous as vol
from pathlib import Path

from .const import DOMAIN, PLATFORMS
from .controller import ScheduleController
from .websocket import async_register


async def async_setup(hass: HomeAssistant, _config: dict) -> bool:
    if not hass.data.get(f"{DOMAIN}_frontend_registered"):
        frontend_path = Path(__file__).parent / "www" / "heating-schedule-card.js"
        await hass.http.async_register_static_paths(
            [StaticPathConfig("/schedule-control/heating-schedule-card.js", str(frontend_path), False)]
        )
        hass.data[f"{DOMAIN}_frontend_registered"] = True
    if not hass.data.get(f"{DOMAIN}_websocket_registered"):
        async_register(hass)
        hass.data[f"{DOMAIN}_websocket_registered"] = True
    def active_controller():
        controllers = hass.data.get(DOMAIN, {})
        # Prefer the config-entry controller because it owns the sensor/select
        # platforms. ``__yaml__`` is only a temporary import bootstrap.
        return next((value for key, value in controllers.items() if key != "__yaml__"), None) or controllers.get("__yaml__")

    if not hass.services.has_service(DOMAIN, "set_mode"):
        async def handle_set_mode(call):
            controller = active_controller()
            if not controller:
                return
            card_id = call.data["card_id"]
            requested = str(call.data["mode"])
            card = controller.cards.get(card_id, {})
            profile = next((item for item in card.get("modes", []) if requested in (item.get("id"), item.get("name"))), None)
            mode = "normal" if requested.lower() == "normal" else profile.get("id") if profile else "normal"
            await controller.async_set_card_mode(card_id, mode, profile)
        hass.services.async_register(DOMAIN, "set_mode", handle_set_mode, schema=vol.Schema({vol.Required("card_id"): str, vol.Required("mode"): str}))
    if not hass.services.has_service(DOMAIN, "start_boost"):
        async def handle_start_boost(call):
            controller = active_controller()
            if controller:
                await controller.async_start_boost(call.data["card_id"], call.data["group_id"], call.data["duration"], call.data.get("temperature"), call.data.get("preset", ""))
        hass.services.async_register(DOMAIN, "start_boost", handle_start_boost, schema=vol.Schema({vol.Required("card_id"): str, vol.Required("group_id"): str, vol.Required("duration"): vol.All(vol.Coerce(int), vol.Range(min=1, max=1440)), vol.Optional("temperature"): vol.Coerce(float), vol.Optional("preset", default=""): str}))
    if not hass.services.has_service(DOMAIN, "cancel_boost"):
        async def handle_cancel_boost(call):
            controller = active_controller()
            if controller:
                await controller.async_cancel_boost(call.data["card_id"], call.data["group_id"])
        hass.services.async_register(DOMAIN, "cancel_boost", handle_cancel_boost, schema=vol.Schema({vol.Required("card_id"): str, vol.Required("group_id"): str}))
    domain_data = hass.data.setdefault(DOMAIN, {})
    if DOMAIN in _config and "__yaml__" not in domain_data and not hass.config_entries.async_entries(DOMAIN):
        controller = ScheduleController(hass)
        domain_data["__yaml__"] = controller
        await controller.async_start()
        hass.async_create_task(
            hass.config_entries.flow.async_init(
                DOMAIN, context={"source": SOURCE_IMPORT}, data={}
            )
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    controller = hass.data.setdefault(DOMAIN, {}).get("__yaml__") or ScheduleController(hass)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = controller
    if "__yaml__" not in hass.data[DOMAIN]:
        await controller.async_start()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    controller = hass.data[DOMAIN].pop(entry.entry_id)
    if "__yaml__" not in hass.data[DOMAIN]:
        await controller.async_stop()
    return True
