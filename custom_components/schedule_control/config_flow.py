from __future__ import annotations

from homeassistant import config_entries

from .const import DOMAIN


class ScheduleControlConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if user_input is not None:
            return self.async_create_entry(title="Schedule Control", data={})
        return self.async_show_form(step_id="user")

    async def async_step_import(self, _user_input=None):
        """Create the entity-owning config entry for legacy YAML setups."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        return self.async_create_entry(title="Schedule Control", data={})
