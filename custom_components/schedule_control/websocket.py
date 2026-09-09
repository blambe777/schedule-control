from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN


def _controller(hass: HomeAssistant):
    entries = hass.data.get(DOMAIN, {})
    # The config-entry controller owns the HA entities and their listeners.
    # A legacy YAML bootstrap may coexist during migration, but must not
    # receive WebSocket mutations or the exposed select entity becomes stale.
    return next((value for key, value in entries.items() if key != "__yaml__"), None) or entries.get("__yaml__")


@websocket_api.websocket_command({vol.Required("type"): "schedule_control/list"})
@websocket_api.async_response
async def websocket_list(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    connection.send_result(msg["id"], {"mappings": controller.mappings, "status": controller.mapping_status, "override_info": controller.override_info, "cards": controller.cards, "thermostat_config": controller.thermostat_config})


@websocket_api.websocket_command({vol.Required("type"): "schedule_control/get_thermostat_config"})
@websocket_api.async_response
async def websocket_get_thermostat_config(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    connection.send_result(msg["id"], controller.thermostat_config)


@websocket_api.websocket_command({vol.Required("type"): "schedule_control/set_thermostat_config", vol.Required("configuration"): dict})
@websocket_api.async_response
async def websocket_set_thermostat_config(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    await controller.async_set_thermostat_config(msg["configuration"])
    connection.send_result(msg["id"], controller.thermostat_config)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "schedule_control/set",
        vol.Required("mapping_id"): str,
        vol.Required("target"): str,
        vol.Required("schedule"): str,
        vol.Optional("boost", default=""): str,
        vol.Optional("boost_timer", default=""): str,
        vol.Optional("enabled", default=True): bool,
        vol.Optional("week", default={}): dict,
        vol.Optional("manual_override_timeout", default=0): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def websocket_set(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    await controller.async_set_mapping(msg["mapping_id"], msg)
    connection.send_result(msg["id"], {"mapping_id": msg["mapping_id"]})


@websocket_api.websocket_command(
    {vol.Required("type"): "schedule_control/delete", vol.Required("mapping_id"): str}
)
@websocket_api.async_response
async def websocket_delete(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    await controller.async_delete_mapping(msg["mapping_id"])
    connection.send_result(msg["id"], {"mapping_id": msg["mapping_id"]})


@websocket_api.websocket_command(
    {vol.Required("type"): "schedule_control/reconcile", vol.Required("card_id"): str, vol.Required("groups"): list, vol.Optional("modes", default=[]): list}
)
@websocket_api.async_response
async def websocket_reconcile(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    schedules = await controller.async_reconcile_card(msg["card_id"], msg["groups"], msg.get("modes"))
    connection.send_result(msg["id"], {"delete_schedules": schedules})


@websocket_api.websocket_command(
    {vol.Required("type"): "schedule_control/cleanup", vol.Required("active_card_ids"): list, vol.Required("scan_complete"): bool}
)
@websocket_api.async_response
async def websocket_cleanup(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    cleanup = await controller.async_cleanup_cards(msg["active_card_ids"], msg["scan_complete"])
    connection.send_result(msg["id"], cleanup)


@websocket_api.websocket_command(
    {vol.Required("type"): "schedule_control/finalize_cleanup", vol.Required("card_ids"): list}
)
@websocket_api.async_response
async def websocket_finalize_cleanup(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    await controller.async_finalize_cleanup_cards(msg["card_ids"])
    connection.send_result(msg["id"], {"card_ids": msg["card_ids"]})


@websocket_api.websocket_command(
    {vol.Required("type"): "schedule_control/remove_group", vol.Required("card_id"): str, vol.Required("group_id"): str}
)
@websocket_api.async_response
async def websocket_remove_group(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    await controller.async_remove_group(msg["card_id"], msg["group_id"])
    connection.send_result(msg["id"], {"card_id": msg["card_id"], "group_id": msg["group_id"]})


@websocket_api.websocket_command(
    {vol.Required("type"): "schedule_control/reset_card", vol.Required("card_id"): str}
)
@websocket_api.async_response
async def websocket_reset_card(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    await controller.async_reset_card(msg["card_id"])
    connection.send_result(msg["id"], {"card_id": msg["card_id"]})


@websocket_api.websocket_command(
    {vol.Required("type"): "schedule_control/set_mode", vol.Required("card_id"): str, vol.Required("mode"): str, vol.Optional("profile", default={}): dict}
)
@websocket_api.async_response
async def websocket_set_mode(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    await controller.async_set_card_mode(msg["card_id"], msg["mode"], msg.get("profile"))
    connection.send_result(msg["id"], {"card_id": msg["card_id"], "mode": msg["mode"]})


@websocket_api.websocket_command(
    {vol.Required("type"): "schedule_control/set_modes", vol.Required("card_id"): str, vol.Required("modes"): list}
)
@websocket_api.async_response
async def websocket_set_modes(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    await controller.async_set_modes(msg["card_id"], msg["modes"])
    connection.send_result(msg["id"], {"card_id": msg["card_id"]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "schedule_control/start_boost",
        vol.Required("card_id"): str,
        vol.Required("group_id"): str,
        vol.Required("duration"): vol.Coerce(int),
        vol.Optional("temperature"): vol.Coerce(float),
        vol.Optional("preset", default=""): str,
    }
)
@websocket_api.async_response
async def websocket_start_boost(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    try:
        boost = await controller.async_start_boost(msg["card_id"], msg["group_id"], msg["duration"], msg.get("temperature"), msg.get("preset", ""))
    except ValueError as error:
        connection.send_error(msg["id"], "invalid_group", str(error))
        return
    connection.send_result(msg["id"], boost)


@websocket_api.websocket_command(
    {vol.Required("type"): "schedule_control/cancel_boost", vol.Required("card_id"): str, vol.Required("group_id"): str}
)
@websocket_api.async_response
async def websocket_cancel_boost(hass, connection, msg):
    controller = _controller(hass)
    if not controller:
        connection.send_error(msg["id"], "not_loaded", "Schedule Control is not loaded")
        return
    await controller.async_cancel_boost(msg["card_id"], msg["group_id"])
    connection.send_result(msg["id"], {"card_id": msg["card_id"], "group_id": msg["group_id"]})


def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, websocket_list)
    websocket_api.async_register_command(hass, websocket_get_thermostat_config)
    websocket_api.async_register_command(hass, websocket_set_thermostat_config)
    websocket_api.async_register_command(hass, websocket_set)
    websocket_api.async_register_command(hass, websocket_delete)
    websocket_api.async_register_command(hass, websocket_reconcile)
    websocket_api.async_register_command(hass, websocket_cleanup)
    websocket_api.async_register_command(hass, websocket_finalize_cleanup)
    websocket_api.async_register_command(hass, websocket_remove_group)
    websocket_api.async_register_command(hass, websocket_reset_card)
    websocket_api.async_register_command(hass, websocket_set_mode)
    websocket_api.async_register_command(hass, websocket_set_modes)
    websocket_api.async_register_command(hass, websocket_start_boost)
    websocket_api.async_register_command(hass, websocket_cancel_boost)
