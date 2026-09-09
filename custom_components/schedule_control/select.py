from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    controller = hass.data[DOMAIN][entry.entry_id]
    known_card_ids: set[str] = set()

    def ensure_mode_select(card_id: str) -> None:
        """Add selectors for cards created after the platform started."""
        if not card_id or card_id in known_card_ids:
            return
        known_card_ids.add(card_id)
        async_add_entities([ScheduleControlModeSelect(controller, card_id)], True)

    for card_id in controller.cards:
        ensure_mode_select(card_id)

    # Cards are commonly created from the Lovelace editor after Home
    # Assistant has already loaded this platform. Without this listener their
    # entity-registry entry remains a restored/unavailable shell until the
    # entire integration is restarted.
    remove_listener = controller.add_mode_listener(ensure_mode_select)
    entry.async_on_unload(remove_listener)


class ScheduleControlModeSelect(SelectEntity):
    _attr_icon = "mdi:tune-variant"
    _attr_should_poll = True

    def __init__(self, controller, card_id: str) -> None:
        self.controller = controller
        self.card_id = card_id
        self._attr_name = f"Schedule Mode {card_id.removeprefix('card_').replace('_', ' ').title()}"
        self._attr_unique_id = f"schedule_control_mode_{card_id}"
        self._remove_listener = None

    async def async_added_to_hass(self) -> None:
        self._remove_listener = self.controller.add_mode_listener(self._modes_changed)

    async def async_will_remove_from_hass(self) -> None:
        if self._remove_listener:
            self._remove_listener()
            self._remove_listener = None

    def _modes_changed(self, card_id: str) -> None:
        if card_id == self.card_id:
            self.async_write_ha_state()

    @property
    def options(self) -> list[str]:
        return ["Normal", *[item.get("name", item.get("id", "Mode")) for item in self.controller.cards.get(self.card_id, {}).get("modes", [])]]

    @property
    def current_option(self) -> str:
        card = self.controller.cards.get(self.card_id, {})
        active = card.get("mode", "normal")
        if active == "normal":
            return "Normal"
        profile = next((item for item in card.get("modes", []) if item.get("id") == active), {})
        return profile.get("name", active)

    async def async_select_option(self, option: str) -> None:
        card = self.controller.cards.get(self.card_id, {})
        profile = next((item for item in card.get("modes", []) if item.get("name") == option), None)
        mode = "normal" if option == "Normal" else profile.get("id") if profile else "normal"
        await self.controller.async_set_card_mode(self.card_id, mode, profile)
        self.async_write_ha_state()

    @property
    def extra_state_attributes(self):
        return {"card_id": self.card_id, "mode_ids": {item.get("name"): item.get("id") for item in self.controller.cards.get(self.card_id, {}).get("modes", [])}}
