from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    async_add_entities([ScheduleControlStatusSensor(hass.data[DOMAIN][entry.entry_id])], True)


class ScheduleControlStatusSensor(SensorEntity):
    _attr_name = "Schedule Control Status"
    _attr_unique_id = "schedule_control_status"
    _attr_icon = "mdi:calendar-clock"
    _attr_should_poll = True

    def __init__(self, controller) -> None:
        self.controller = controller

    @property
    def native_value(self):
        statuses = self.controller.mapping_status.values()
        if any(status == "error" for status in statuses):
            return "error"
        if any(status == "boost_active" for status in statuses):
            return "boost_active"
        return "active"

    @property
    def extra_state_attributes(self):
        return {
            "mapping_count": len(self.controller.mappings),
            "mappings": self.controller.mapping_status,
            "priority_order": ["boost", "manual_override", "operating_mode", "schedule", "no_action"],
        }

    async def async_update(self) -> None:
        await self.controller.async_evaluate_all()
