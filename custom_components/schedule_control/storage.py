from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import CONFIGURATION_KEY, OWNERSHIP_KEY, STORAGE_KEY, STORAGE_VERSION


class MappingStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)

    async def load(self) -> dict[str, dict]:
        data = await self._store.async_load() or {}
        return data.get("mappings", {})

    async def save(self, mappings: dict[str, dict]) -> None:
        await self._store.async_save({"mappings": mappings})


class OwnershipStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store = Store(hass, STORAGE_VERSION, OWNERSHIP_KEY)

    async def load(self) -> dict[str, dict]:
        data = await self._store.async_load() or {}
        return data.get("cards", {})

    async def save(self, cards: dict[str, dict]) -> None:
        await self._store.async_save({"cards": cards})


class ConfigurationStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store = Store(hass, STORAGE_VERSION, CONFIGURATION_KEY)

    async def load(self) -> dict:
        data = await self._store.async_load() or {}
        return data.get("thermostat_config", {})

    async def save(self, configuration: dict) -> None:
        await self._store.async_save({"thermostat_config": configuration})
