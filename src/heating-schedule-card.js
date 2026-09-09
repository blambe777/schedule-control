import { DAYS, emptyWeek, focusBounds, migrateConfig, minutesToTime, replaceBlockRange, rgbToHex, timelineMinuteToPercent, timelinePercentToMinute, timeToMinutes, upsertBlock, validateBlocks } from "./schedule-utils.js?v=1.25.0-dev32";

const DAY_LABELS = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };
const MODE_LABELS = { comfort: "Comfort", eco: "Eco", off: "Off" };
const PROFILES = {
  climate: { label: "Climate", domain: "climate", modes: ["comfort", "eco"], defaultMode: "comfort", icon: "mdi:radiator" },
  switch: { label: "Switch", domain: "switch", modes: ["on", "off"], defaultMode: "on", icon: "mdi:toggle-switch" },
  light: { label: "Lighting", domain: "light", modes: ["on", "off"], defaultMode: "on", icon: "mdi:lightbulb" },
};

function roomType(room, fallback = "climate") {
  if (room?.hot_water) return "climate";
  const domain = String(room?.entities?.[0] || room?.entity || "").split(".")[0];
  return PROFILES[domain] ? domain : PROFILES[room?.entity_type] ? room.entity_type : fallback;
}

function pendingSchedule(value) {
  if (!String(value || "").startsWith("pending:")) return null;
  try { return JSON.parse(decodeURIComponent(String(value).slice(8))); } catch { return null; }
}

function pendingScheduleValue(name, copyFrom = "") {
  return `pending:${encodeURIComponent(JSON.stringify({ name, copyFrom }))}`;
}

function uniqueScheduleName(baseName, schedules = []) {
  const names = new Set(schedules.map((schedule) => schedule.name));
  if (!names.has(baseName)) return baseName;
  let suffix = 2;
  while (names.has(`${baseName} (${suffix})`)) suffix += 1;
  return `${baseName} (${suffix})`;
}

function fireChanged(element, config) {
  element.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function timeSelectOptions(step, selected, includeMidnightEnd = false) {
  const interval = Math.max(5, Number(step) || 15);
  const limit = includeMidnightEnd ? 1440 : 1440 - interval;
  const values = new Set();
  for (let minute = includeMidnightEnd ? interval : 0; minute <= limit; minute += interval) values.add(minutesToTime(minute).slice(0, 5));
  if (selected) values.add(String(selected).slice(0, 5));
  return [...values].sort((a, b) => timeToMinutes(a) - timeToMinutes(b)).map((value) => `<option value="${value}" ${value === String(selected).slice(0, 5) ? "selected" : ""}>${value}</option>`).join("");
}

function safeColor(value, fallback) {
  return /^#[\da-f]{6}$/i.test(String(value || "")) ? String(value) : fallback;
}

class HeatingScheduleCard extends HTMLElement {
  static getConfigElement() { return document.createElement("schedule-control-card-editor"); }
  static getStubConfig(hass) {
    const firstClimate = Object.keys(hass?.states || {}).find((id) => id.startsWith("climate."));
    return migrateConfig({ type: "custom:schedule-control-card", groups: [{ name: "Heating", schedules: firstClimate ? [{ name: hass.states[firstClimate].attributes.friendly_name || "Thermostat", entity: firstClimate, schedule: "" }] : [] }] });
  }

  setConfig(value) {
    if (!value) throw new Error("Card configuration is required.");
    this.config = migrateConfig(value);
    this.selectedDay ||= DAYS[(new Date().getDay() + 6) % 7];
    this.undoStack ||= [];
    this.redoStack ||= [];
    this.workingSchedules ||= new Map();
    this.dirtyGroups ||= new Set();
    this._followingToday ??= true;
    this._lastInteraction ||= Date.now();
    this._calendarDate ||= new Date().toDateString();
    this.timelineMode ||= localStorage.getItem("schedule-control-timeline-mode") || this.config.default_timeline_view || "overview";
    this.focusCenter ??= new Date().getHours() * 60 + new Date().getMinutes();
    this.render();
    if (this._hass && this._initialDataLoaded) queueMicrotask(() => this.ensurePendingSchedules());
  }

  focusBounds() {
    return focusBounds(this.focusCenter);
  }

  minuteToPercent(minute) {
    return timelineMinuteToPercent(minute, this.timelineMode, this.focusCenter);
  }

  percentToMinute(percent) {
    return timelinePercentToMinute(percent, this.timelineMode, this.focusCenter);
  }

  setTimelineMode(mode, center = this.focusCenter) {
    this.timelineMode = mode;
    this.focusCenter = Math.max(180, Math.min(1260, center));
    localStorage.setItem("schedule-control-timeline-mode", mode);
    this.render();
  }

  set hass(value) {
    this._hass = value;
    if (this.config && !this._initialLoadStarted) {
      this._initialLoadStarted = true;
      Promise.all([this.loadSchedules(), this.loadBackendStatus()]).finally(() => {
        this._initialDataLoaded = true;
      });
    }
  }

  getCardSize() { return 9; }

  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._dayTimer) this._dayTimer = setInterval(() => this.followTodayTick(), 30000);
    if (!this._statusTimer) this._statusTimer = setInterval(() => this.loadBackendStatus(), 5000);
    this.render();
  }

  disconnectedCallback() { clearInterval(this._dayTimer); this._dayTimer = null; clearInterval(this._statusTimer); this._statusTimer = null; }

  followTodayTick() {
    const now = new Date(); const today = DAYS[(now.getDay() + 6) % 7]; const date = now.toDateString();
    const dateChanged = date !== this._calendarDate;
    this._calendarDate = date;
    if ((dateChanged && this._followingToday) || (!this._followingToday && Date.now() - this._lastInteraction >= 300000)) {
      this.selectedDay = today; this._followingToday = true; this.editing = null; this.render();
    }
  }

  async loadSchedules() {
    if (!this._hass || this._loading) return;
    this._loading = true;
    try {
      const schedules = await this._hass.callWS({ type: "schedule/list" });
      this.schedules = Object.fromEntries((schedules || []).map((item) => [item.id, item]));
      for (const key of this.workingSchedules?.keys?.() || []) if (!this.dirtyGroups?.has(key)) this.workingSchedules.delete(key);
      this.error = "";
    } catch (error) {
      this.error = `Unable to load schedules: ${error?.message || error}`;
    } finally {
      this._loading = false;
      this.render();
    }
    this.ensurePendingSchedules();
  }

  async loadBackendStatus() {
    if (!this._hass || this._backendLoading) return;
    this._backendLoading = true;
    try {
      const result = await this._hass.callWS({ type: "schedule_control/list" });
      this.backendConnected = true;
      this.backendStatus = result || {};
      // Keep one authoritative preset/template model everywhere in the card.
      // Otherwise setup can save a preset while the mode editor keeps stale ids.
      this.thermostatConfig = structuredClone(result?.thermostat_config || {});
      // Status polling is read-only. Several dashboard views may contain an
      // older copy of a card with the same legacy card_id; allowing any of
      // them to push their local mode list on every poll makes the copies
      // continually erase each other's backend configuration. Modes are
      // written only by an explicit setup save or a user mode selection.
      this.hydrateOwnedGroups();
      for (const key of this.workingSchedules?.keys?.() || []) if (!this.dirtyGroups?.has(key)) this.workingSchedules.delete(key);
    } catch {
      this.backendConnected = false;
      this.backendStatus = {};
    } finally {
      this._backendLoading = false;
      // The backend is polled every five seconds. Rebuilding the shadow DOM
      // while a form control is active replaces that control and steals focus.
      // Keep the fresh status in memory and let the next user-driven render
      // display it once the open interaction has finished.
      const active = this.shadowRoot?.activeElement;
      const formControlFocused = active?.matches?.("input, select, textarea");
      const interactionOpen = Boolean(
        this.editing || this.creatingGroup || this.copyingDay || this.managingSchedule ||
        this.shadowRoot?.querySelector(".top-mode[open]") || this.shadowRoot?.querySelector(".boost-picker-backdrop")
      );
      if (!formControlFocused && !interactionOpen) this.render();
    }
  }

  async setCardMode(mode) {
    if (!this._hass || this._changingMode) return;
    const profile = (this.config.operating_modes || []).find((item) => item.id === mode) || {};
    this._changingMode = true;
    this.render();
    try {
      // A mode can be created and selected before the next background status
      // refresh. Persist the complete list first so both the controller and
      // its Home Assistant select entity know about every visible choice.
      await this._hass.callWS({
        type: "schedule_control/set_modes",
        card_id: this.config.card_id,
        modes: this.config.operating_modes || [],
      });
      await this._hass.callWS({ type: "schedule_control/set_mode", card_id: this.config.card_id, mode, profile });
      this.backendStatus.cards ||= {};
      this.backendStatus.cards[this.config.card_id] ||= { groups: {} };
      this.backendStatus.cards[this.config.card_id].mode = mode;
      this.backendStatus.cards[this.config.card_id].mode_profile = profile;
      await this.loadBackendStatus();
    } catch (error) {
      this.saveError = `Could not change operating mode: ${error?.message || error}`;
    } finally {
      this._changingMode = false;
      this.render();
    }
  }

  hydrateOwnedGroups() {
    const cardRecord = this.backendStatus?.cards?.[this.config?.card_id];
    const owned = cardRecord?.groups || {};
    const deletedGroups = new Set(cardRecord?.deleted_groups || []);
    // Once a card has an ownership record, it is the authority for schedules
    // created by that card. This prevents an old Lovelace snapshot from
    // resurrecting a schedule after its helper and ownership were deleted.
    if (cardRecord) {
      for (const group of this.config.groups || []) {
        group.schedules = (group.schedules || []).filter((room) => {
          if (deletedGroups.has(room.group_id)) return false;
          if (owned[room.group_id] || pendingSchedule(room.schedule)) return true;
          // Keep legitimate legacy helpers long enough to be adopted, but
          // permanently suppress stale Lovelace rows whose helper is gone.
          return Boolean(room.schedule && this._hass?.states?.[room.schedule]);
        });
      }
    }
    for (const room of (this.config?.groups || []).flatMap((group) => group.schedules || [])) {
      const saved = owned[room.group_id];
      if (!saved) continue;
      if (saved.schedule) room.schedule = saved.schedule;
      if (saved.enabled !== undefined) room.enabled = saved.enabled;
      if (saved.name) room.name = saved.name;
      if (Array.isArray(saved.targets) && saved.targets.length) { room.entities = [...saved.targets]; room.entity = saved.targets[0]; }
    }
    // Ownership is the durable source of truth after a dashboard reload. Move
    // existing rows into their persisted container as well as hydrating their
    // other fields; previously only newly discovered rows respected container.
    if (cardRecord && this.config?.groups?.length) {
      const moves = [];
      for (const source of this.config.groups) {
        for (const room of source.schedules || []) {
          const destinationName = owned[room.group_id]?.container;
          if (destinationName && destinationName !== source.name) moves.push({ source, room, destinationName });
        }
      }
      for (const { source, room, destinationName } of moves) {
        const destination = this.config.groups.find((group) => group.name === destinationName);
        if (!destination) continue;
        source.schedules = (source.schedules || []).filter((item) => item !== room);
        destination.schedules ||= [];
        if (!destination.schedules.some((item) => item.group_id === room.group_id)) destination.schedules.push(room);
      }
    }
    // Rebuild the actual saved containers when Lovelace lost its group list.
    // Falling back to one generic "Schedules" group discards useful ownership
    // metadata and a later reconcile can permanently overwrite the originals.
    if (cardRecord && !this.config?.groups?.length) {
      const containers = [...new Set(Object.values(owned).map((group) => String(group.container || "Schedules").trim() || "Schedules"))];
      this.config.groups = containers.map((name) => ({ name, schedules: [] }));
    }
    const existing = new Set((this.config?.groups || []).flatMap((group) => group.schedules || []).map((room) => room.group_id));
    const missing = Object.values(owned).filter((group) => !existing.has(group.group_id));
    if (!missing.length) return;
    this.config.groups ||= [];
    this.config.groups[0] ||= { name: "Schedules", schedules: [] };
    for (const group of missing) {
      const containerName = String(group.container || "Schedules").trim() || "Schedules";
      let container = this.config.groups.find((item) => item.name === containerName);
      if (!container) {
        container = { name: containerName, schedules: [] };
        this.config.groups.push(container);
      }
      container.schedules ||= [];
      container.schedules.push({ name: group.name, group_id: group.group_id, entities: group.targets || [], entity: group.targets?.[0] || "", entity_type: group.entity_type || String(group.targets?.[0] || "climate").split(".")[0], schedule: group.schedule || "", draft_source: group.draft_source || "", reset_schedule: !group.schedule });
    }
  }

  scheduleId(room) { return String(room.schedule || "").replace(/^schedule\./, ""); }
  scheduleFor(room) {
    const key = room.group_id || room._key;
    if (this.workingSchedules?.has(key)) return this.workingSchedules.get(key);
    const mappingPrefix = `${this.config.card_id}:${room.group_id || room._key}:`;
    const mapped = room.reset_schedule ? null : Object.entries(this.backendStatus?.mappings || {}).find(([mappingId]) => mappingId.startsWith(mappingPrefix))?.[1];
    if (!room.schedule && mapped?.schedule) room = { ...room, schedule: mapped.schedule };
    const pending = pendingSchedule(room.schedule);
    if (pending) return Object.values(this.schedules || {}).find((schedule) => schedule.name === pending.name);
    if (String(room.schedule || "").startsWith("name:")) {
      const name = room.schedule.slice(5);
      return Object.values(this.schedules || {}).find((schedule) => schedule.name === name);
    }
    const saved = this.schedules?.[this.scheduleId(room)];
    if (saved) return saved;
    if (room.schedule) return null;
    const source = room.draft_source ? this.schedules?.[String(room.draft_source).replace(/^schedule\./, "")] : null;
    if (room.draft_source && !source) return null;
    const draft = source ? structuredClone(source) : emptyWeek(`${room.name || "New"} Schedule`, "mdi:calendar-clock");
    if (!source && room.suggested_week) for (const day of DAYS) draft[day] = structuredClone(room.suggested_week[day] || []);
    delete draft.id;
    draft.name = `${room.name || "New"} Schedule`;
    draft._draft = true;
    this.workingSchedules?.set(key, draft);
    return draft;
  }

  isEditorPreview() { return Boolean(this.closest("hui-card-preview, hui-dialog-edit-card, ha-dialog")); }
  async ensurePendingSchedules() {
    if (this._ensuringPending || this.isEditorPreview() || !this._hass) return;
    // Every pending row must be committed. A helper with the same friendly
    // name may already exist but still be blank; it must be adopted and
    // updated rather than filtering the row out here.
    const pendingRooms = this.allRooms().filter((room) => pendingSchedule(room.schedule));
    if (!pendingRooms.length) return;
    this._ensuringPending = true;
    let changed = false;
    try {
      for (const room of pendingRooms) {
        const spec = pendingSchedule(room.schedule);
        if (!spec) continue;
        const payload = emptyWeek(spec.name, "mdi:calendar-clock");
        if (room.suggested_week) for (const day of DAYS) payload[day] = structuredClone(room.suggested_week[day] || []);
        if (spec.copyFrom) {
          const source = this.schedules?.[String(spec.copyFrom).replace(/^schedule\./, "")];
          if (!source) throw new Error(`Copy source for ${spec.name} is unavailable.`);
          for (const day of DAYS) payload[day] = structuredClone(source[day] || []);
        }
        const existing = Object.values(this.schedules || {}).find((schedule) => schedule.name === spec.name);
        let scheduleId = existing?.id;
        if (existing) {
          await this._hass.callWS({ type: "schedule/update", schedule_id: existing.id, ...payload });
        } else {
          const created = await this._hass.callWS({ type: "schedule/create", ...payload });
          scheduleId = created.id;
        }
        const configured = (this.config.groups || []).flatMap((group) => group.schedules || []).find((item) => item.group_id === room.group_id);
        if (configured && scheduleId) { configured.schedule = `schedule.${scheduleId}`; configured.reset_schedule = false; configured.draft_source = ""; }
        if (room._key === "__hot_water" && scheduleId) this.config.hot_water.schedule = `schedule.${scheduleId}`;
        changed = true;
      }
    } catch (error) {
      this.error = `Could not prepare schedule: ${error?.message || error}`;
    } finally {
      this._ensuringPending = false;
    }
    if (changed) {
      fireChanged(this, this.config);
      await this.loadSchedules();
      await this.reconcileAndCleanup();
      await this.loadBackendStatus();
    } else this.render();
  }
  climatePresetModes(room) {
    const configured = this.backendStatus?.thermostat_config?.presets;
    if (Array.isArray(configured) && configured.length) return configured.map((preset) => preset.id);
    const entities = room.entities || [room.entity].filter(Boolean);
    const lists = entities.map((entity) => this._hass?.states?.[entity]?.attributes?.preset_modes).filter((modes) => Array.isArray(modes) && modes.length);
    if (!lists.length) return ["comfort", "eco", "away"];
    const common = lists[0].filter((mode) => lists.every((modes) => modes.includes(mode)));
    return common.length ? common : lists[0];
  }
  profile(room) {
    const type = roomType(room, this.config.schedule_type);
    const profile = PROFILES[type] || PROFILES.climate;
    return type === "climate" ? { ...profile, modes: this.climatePresetModes(room), defaultMode: this.climatePresetModes(room)[0] || "comfort" } : profile;
  }
  modeLabel(mode) { const preset=this.backendStatus?.thermostat_config?.presets?.find((item)=>item.id===mode); return mode === "on" ? "On" : preset?.name || MODE_LABELS[mode] || String(mode || "").replace(/[\s_-]+thermostat$/i, "").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
  presetDefinition(mode) { return this.backendStatus?.thermostat_config?.presets?.find((item)=>item.id===mode); }
  rowPresetDefinition(room, mode) {
    const base = this.presetDefinition(mode) || {};
    const override = room?.preset_overrides?.[mode];
    return override == null ? base : { ...base, temperature: Number(override) };
  }
  thermostatTemperature(room, mode = "") {
    const presetTemperature = this.rowPresetDefinition(room, mode)?.temperature;
    if (Number.isFinite(Number(presetTemperature))) return Number(presetTemperature);
    const value = this._hass?.states?.[room.entity]?.attributes?.temperature;
    return Number.isFinite(Number(value)) ? Number(value) : 20;
  }

  openEditor(room, index = -1, event) {
    if (!room) return;
    const schedule = this.scheduleFor(room);
    if (!schedule) return;
    const existing = index >= 0 ? schedule[this.selectedDay]?.[index] : null;
    let start = existing?.from || "06:30:00";
    let end = existing?.to || "07:30:00";
    if (!existing && event?.currentTarget) {
      const rect = event.currentTarget.getBoundingClientRect();
      const clickMinutes = Math.min(1425, Math.max(0, Math.round((this.percentToMinute((event.clientX - rect.left) / rect.width * 100)) / 15) * 15));
      start = minutesToTime(clickMinutes);
      end = minutesToTime(Math.min(1440, clickMinutes + 60));
    }
    const hasOverride = existing?.data?.temperature_override === true;
    const lightState = this._hass?.states?.[room.entity];
    const colorModes = lightState?.attributes?.supported_color_modes || [];
    const currentBrightness = Math.round(Number(lightState?.attributes?.brightness || 191) / 2.55);
    const minKelvin = Number(lightState?.attributes?.min_color_temp_kelvin || 2000);
    const maxKelvin = Number(lightState?.attributes?.max_color_temp_kelvin || 6500);
    const initialMode=existing?.data?.mode || this.profile(room).defaultMode;
    this.editing = { room, index, from: start.slice(0, 5), to: end.slice(0, 5), startAnchor: existing?.data?.start_anchor || "fixed", startOffset: Number(existing?.data?.start_offset || 0), endAnchor: existing?.data?.end_anchor || "fixed", endOffset: Number(existing?.data?.end_offset || 0), mode: initialMode, override: hasOverride, target: Number(existing?.data?.target_temp ?? this.thermostatTemperature(room,initialMode)), brightness: Number(existing?.data?.brightness_pct ?? currentBrightness), supportsBrightness: colorModes.some((mode) => mode !== "onoff"), supportsColorTemp: colorModes.includes("color_temp"), supportsColor: colorModes.some((mode) => ["hs", "xy", "rgb", "rgbw", "rgbww"].includes(mode)), colorTemp: Number(existing?.data?.color_temp_kelvin ?? lightState?.attributes?.color_temp_kelvin ?? Math.round((minKelvin + maxKelvin) / 2)), minKelvin, maxKelvin, color: existing?.data?.color_hex || rgbToHex(existing?.data?.rgb_color ?? lightState?.attributes?.rgb_color ?? [255, 255, 255]), copyDays: [] };
    this.render();
  }

  async createSchedule(room) {
    const name = room.name || this._hass?.states?.[room.entity]?.attributes?.friendly_name || "Heating schedule";
    try {
      const created = await this._hass.callWS({ type: "schedule/create", ...emptyWeek(`${name} Schedule`, "mdi:calendar-clock") });
      const next = structuredClone(this.config);
      if (room._key === "__hot_water") next.hot_water.schedule = `schedule.${created.id}`;
      else {
        const [zoneIndex, roomIndex] = room._key.split(":").map(Number);
        next.groups[zoneIndex].schedules[roomIndex].schedule = `schedule.${created.id}`;
      }
      this.config = next;
      fireChanged(this, next);
      await this.loadSchedules();
    } catch (error) { this.error = `Could not create schedule: ${error?.message || error}`; this.render(); }
  }

  async savePeriod() {
    const edit = this.editing;
    const schedule = this.scheduleFor(edit.room);
    if (!schedule) return;
    try {
      const updated = structuredClone(schedule);
      const data = { mode: edit.mode };
      const type = roomType(edit.room, this.config.schedule_type);
      if (type === "climate") { data.target_temp = Number(edit.override ? edit.target : this.thermostatTemperature(edit.room,edit.mode)); if(edit.override)data.temperature_override=true; }
      if (type === "light" && edit.mode === "on") {
        if (edit.supportsBrightness) data.brightness_pct = Number(edit.brightness);
        if (edit.supportsColorTemp) data.color_temp_kelvin = Number(edit.colorTemp);
        if (edit.supportsColor) data.color_hex = edit.color;
        if (["sunrise", "sunset"].includes(edit.startAnchor)) { data.start_anchor = edit.startAnchor; data.start_offset = Number(edit.startOffset) || 0; }
        if (["sunrise", "sunset"].includes(edit.endAnchor)) { data.end_anchor = edit.endAnchor; data.end_offset = Number(edit.endOffset) || 0; }
      }
      const originalBlocks = updated[this.selectedDay] || [];
      const cleanBlocks = type === "climate" ? originalBlocks.filter((block) => block.data?.mode !== "off") : originalBlocks;
      const cleanIndex = edit.index < 0 ? -1 : type === "climate" ? originalBlocks.slice(0, edit.index).filter((block) => block.data?.mode !== "off").length : edit.index;
      updated[this.selectedDay] = type === "climate" ? replaceBlockRange(cleanBlocks, { from: edit.from, to: edit.to, data }, cleanIndex, this.config.minimum_period) : upsertBlock(cleanBlocks, { from: edit.from, to: edit.to, data }, cleanIndex, this.config.minimum_period);
      for (const day of edit.copyDays || []) updated[day] = structuredClone(updated[this.selectedDay]);
      this.recordDraft(edit.room, updated, schedule);
      const fillAfterSave=this._fillAfterSave;this._fillAfterSave="";
      this.editing = null;
      if(fillAfterSave){this.fillClimateGaps(edit.room,fillAfterSave);return;}
      this.render();
    } catch (error) { this.editorError = error?.message || String(error); this.render(); }
  }

  async deletePeriod() {
    const edit = this.editing;
    const original = this.scheduleFor(edit.room);
    const schedule = structuredClone(original);
    if (!schedule || edit.index < 0) return;
    schedule[this.selectedDay].splice(edit.index, 1);
    this.recordDraft(edit.room, schedule, original);
    this.editing = null;
    this.render();
  }

  recordDraft(room, schedule, previous) {
    this.undoStack.push({ group: room.group_id || room._key, schedule: structuredClone(previous) });
    this.undoStack = this.undoStack.slice(-30);
    this.redoStack = [];
    this.workingSchedules.set(room.group_id || room._key, schedule);
    this.dirtyGroups.add(room.group_id || room._key);
    const configured = (this.config.groups || []).flatMap((group) => group.schedules || []).find((item) => item.group_id === room.group_id);
    if (configured?.routine_template_id) configured.routine_synced = false;
  }

  fillClimateGaps(room, preset) {
    const original = this.scheduleFor(room);
    if (!original || !preset) return;
    const updated = structuredClone(original);
    const minimum = Math.max(5, Number(this.config.minimum_period) || 15);
    const active = (updated[this.selectedDay] || []).filter((block) => block.data?.mode !== "off").sort((a, b) => timeToMinutes(a.from) - timeToMinutes(b.from));
    const filled = [];
    let cursor = 0;
    for (const block of active) {
      const start = timeToMinutes(block.from);
      if (start - cursor >= minimum) filled.push({ from: minutesToTime(cursor), to: minutesToTime(start), data: { mode: preset, target_temp:this.thermostatTemperature(room,preset) } });
      filled.push(block);
      cursor = Math.max(cursor, timeToMinutes(block.to));
    }
    if (1440 - cursor >= minimum) filled.push({ from: minutesToTime(cursor), to: minutesToTime(1440), data: { mode: preset, target_temp:this.thermostatTemperature(room,preset) } });
    const validation = validateBlocks(filled, minimum);
    if (!validation.valid) { this.editorError = validation.reason; this.render(); return; }
    updated[this.selectedDay] = validation.blocks;
    this.recordDraft(room, updated, original);
    this.editorError = "";
    this.render();
  }

  async saveDrafts() {
    if (!this.dirtyGroups.size || this._savingDrafts) return;
    this._savingDrafts = true;
    this.saveError = "";
    try {
      for (const room of this.allRooms().filter((item) => this.dirtyGroups.has(item.group_id || item._key))) {
        const key = room.group_id || room._key;
        const draft = this.workingSchedules.get(key);
        let scheduleEntity = room.schedule;
        if (draft?.id) {
          await this.updateSchedule(draft);
          scheduleEntity = `schedule.${draft.id}`;
        } else {
          const payload = structuredClone(draft);
          delete payload._draft;
          const created = await this._hass.callWS({ type: "schedule/create", ...payload });
          scheduleEntity = `schedule.${created.id}`;
        }
        for (const entity of room.entities || [room.entity].filter(Boolean)) {
          if (this.backendConnected) await this._hass.callWS({ type: "schedule_control/set", mapping_id: `${this.config.card_id}:${key}:${entity}`, target: entity, schedule: scheduleEntity, boost: room.boost_entity || "", boost_timer: room.boost_timer || "", enabled: room.enabled !== false, manual_override_timeout: Number(this.config.manual_override_timeout || 0), week: Object.fromEntries(DAYS.map((day) => [day, draft?.[day] || []])) });
        }
        room.schedule = scheduleEntity;
        const configured = this.config.groups.flatMap((group) => group.schedules || []).find((item) => item.group_id === key);
        if (configured) { configured.schedule = scheduleEntity; configured.reset_schedule = false; configured.draft_source = ""; }
        this.dirtyGroups.delete(key);
        this.workingSchedules.delete(key);
      }
      fireChanged(this, this.config);
      await this.reconcileAndCleanup();
      await this.loadBackendStatus();
      await this.loadSchedules();
    } catch (error) {
      this.saveError = `Could not save schedules: ${error?.message || error}`;
      this.render();
    } finally { this._savingDrafts = false; }
  }

  configuredGroups() {
    return this.allRooms().map((room) => ({
      group_id: room.group_id || room._key,
      name: room.name || "Schedule",
      schedule: room.schedule || Object.entries(this.backendStatus?.mappings || {}).find(([mappingId]) => mappingId.startsWith(`${this.config.card_id}:${room.group_id || room._key}:`))?.[1]?.schedule || "",
      targets: room.entities || [room.entity].filter(Boolean),
      entity_type: roomType(room, this.config.schedule_type),
      draft_source: room.draft_source || "",
      enabled: room.enabled !== false,
      boost_entity: room.boost_entity || "",
      boost_timer: room.boost_timer || "",
      container: room._zone || "Schedules",
      order: this.allRooms().findIndex((item) => item.group_id === room.group_id),
    }));
  }

  resolveScheduleEntities(scheduleValues = []) {
    const resolved = new Set();
    for (const value of scheduleValues.filter(Boolean)) {
      const pending = pendingSchedule(value);
      if (!pending) {
        if (String(value).startsWith("schedule.")) resolved.add(String(value));
        continue;
      }
      for (const [entityId, state] of Object.entries(this._hass?.states || {})) {
        if (entityId.startsWith("schedule.") && state.attributes?.friendly_name === pending.name) resolved.add(entityId);
      }
    }
    return [...resolved];
  }

  async deleteOwnedSchedules(scheduleEntities = []) {
    const failures = [];
    for (const schedule of this.resolveScheduleEntities(scheduleEntities)) {
      if (!this._hass?.states?.[schedule]) continue;
      try { await this._hass.callWS({ type: "schedule/delete", schedule_id: schedule.replace(/^schedule\./, "") }); }
      catch (error) {
        let detail = error?.message;
        if (!detail) { try { detail = JSON.stringify(error); } catch { detail = String(error); } }
        failures.push(`${schedule}: ${detail || "unknown error"}`);
      }
    }
    if (failures.length) throw new Error(`Native helper cleanup failed — ${failures.join("; ")}`);
  }

  collectScheduleCardIds(value, result = new Set()) {
    if (!value || typeof value !== "object") return result;
    if (["custom:schedule-control-card", "custom:heating-schedule-card"].includes(value.type) && value.card_id) result.add(value.card_id);
    for (const child of Object.values(value)) this.collectScheduleCardIds(child, result);
    return result;
  }

  async activeScheduleCardInventory() {
    const ids = new Set([this.config.card_id]);
    try {
      const dashboards = await this._hass.callWS({ type: "lovelace/dashboards/list" });
      const targets = [{ url_path: null }, ...(dashboards || []).map((dashboard) => ({ url_path: dashboard.url_path }))];
      for (const target of targets) {
        const request = { type: "lovelace/config" };
        if (target.url_path) request.url_path = target.url_path;
        this.collectScheduleCardIds(await this._hass.callWS(request), ids);
      }
      return { ids: [...ids], complete: true };
    } catch {
      return { ids: [...ids], complete: false };
    }
  }

  async reconcileAndCleanup() {
    if (!this.backendConnected) return;
    const reconciled = await this._hass.callWS({ type: "schedule_control/reconcile", card_id: this.config.card_id, groups: this.configuredGroups(), modes: this.config.operating_modes || [] });
    await this.deleteOwnedSchedules(reconciled?.delete_schedules || []);
    const inventory = await this.activeScheduleCardInventory();
    const cleanup = await this._hass.callWS({ type: "schedule_control/cleanup", active_card_ids: inventory.ids, scan_complete: inventory.complete });
    await this.deleteOwnedSchedules(cleanup?.delete_schedules || []);
    if (cleanup?.card_ids?.length) await this._hass.callWS({ type: "schedule_control/finalize_cleanup", card_ids: cleanup.card_ids });
  }

  discardDrafts() {
    this.workingSchedules.clear();
    this.dirtyGroups.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.editing = null;
    this.render();
  }

  openCreateGroup() {
    this.editing = null;
    this.copyingDay = null;
    this.creatingGroup = { name: "New Schedule", target: "", entitySearch: "", source: "", container: this.config.groups?.[0]?.name || "Schedules" };
    this.createError = "";
    this.render();
  }

  openCopyDay() {
    this.editing = null;
    this.creatingGroup = null;
    const available = this.allRooms().filter((room) => this.scheduleFor(room));
    this.copyingDay = { roomKey: available[0]?._key || "", days: [] };
    this.copyDayError = available.length ? "" : "Create a schedule before copying a day.";
    this.render();
  }

  copyDayPanel() {
    if (!this.copyingDay) return "";
    const rooms = this.allRooms().filter((room) => this.scheduleFor(room));
    const roomOptions = rooms.map((room) => `<option value="${esc(room._key)}">${esc(room.name || room.entity || "Schedule")}</option>`).join("");
    const targets = DAYS.filter((day) => day !== this.selectedDay).map((day) => `<label class="check"><input type="checkbox" data-copy-full-day="${day}" ${this.copyingDay.days.includes(day) ? "checked" : ""}>${DAY_LABELS[day]}</label>`).join("");
    return `<aside class="period-editor copy-day-editor"><div class="editor-title"><div><small>Copy complete day</small><h2>${DAY_LABELS[this.selectedDay]} schedule</h2></div><button data-copy-day-cancel aria-label="Close day copier">×</button></div>${this.copyDayError ? `<p class="error">${esc(this.copyDayError)}</p>` : ""}<label>Schedule<select data-copy-day-room>${roomOptions}</select></label><fieldset><legend>Copy ${DAY_LABELS[this.selectedDay]} to</legend>${targets}</fieldset><p class="capability-note">The selected days will be replaced with an independent copy of this complete day.</p><button class="save create-submit" data-copy-day-apply ${rooms.length ? "" : "disabled"}>Copy schedule</button></aside>`;
  }

  applyDayCopy() {
    const room = this.roomByKey(this.copyingDay?.roomKey);
    const schedule = room && this.scheduleFor(room);
    const days = this.copyingDay?.days || [];
    if (!room || !schedule || !days.length) { this.copyDayError = "Select a schedule and at least one destination day."; this.render(); return; }
    const updated = structuredClone(schedule);
    for (const day of days) updated[day] = structuredClone(updated[this.selectedDay] || []);
    this.recordDraft(room, updated, schedule);
    this.copyingDay = null;
    this.render();
  }

  startResize(event, room, index, edge) {
    if (this._resizing) return;
    this._resizing = true;
    event.preventDefault();
    event.stopPropagation();
    const schedule = this.scheduleFor(room);
    const block = schedule?.[this.selectedDay]?.[index];
    const timeline = event.currentTarget.closest(".timeline");
    if (!schedule || !block || !timeline) { this._resizing = false; return; }
    const original = structuredClone(schedule);
    const start = timeToMinutes(block.from);
    const end = timeToMinutes(block.to);
    const minimum = Math.max(5, Number(this.config.minimum_period) || 15);
    const dayBlocks = schedule[this.selectedDay] || [];
    const others = dayBlocks.map((item, itemIndex) => ({ item, itemIndex })).filter(({ itemIndex, item }) => itemIndex !== index && item.data?.mode !== "off");
    const previous = others.filter(({ item }) => timeToMinutes(item.to) <= start).sort((a,b) => timeToMinutes(b.item.to) - timeToMinutes(a.item.to))[0];
    const following = others.filter(({ item }) => timeToMinutes(item.from) >= end).sort((a,b) => timeToMinutes(a.item.from) - timeToMinutes(b.item.from))[0];
    const linkedPrevious = previous && timeToMinutes(previous.item.to) === start ? previous : null;
    const linkedFollowing = following && timeToMinutes(following.item.from) === end ? following : null;
    const previousEnd = previous ? timeToMinutes(previous.item.to) : 0;
    const followingStart = following ? timeToMinutes(following.item.from) : 1440;
    const replaceAdjacent = roomType(room, this.config.schedule_type) === "climate";
    const rect = timeline.getBoundingClientRect();
    const period = event.currentTarget.closest(".period");
    const clientX = (input) => input.touches?.[0]?.clientX ?? input.changedTouches?.[0]?.clientX ?? input.clientX;
    const move = (moveEvent) => {
      moveEvent.preventDefault?.();
      const raw = Math.round((this.percentToMinute((clientX(moveEvent) - rect.left) / rect.width * 100)) / minimum) * minimum;
      const lower = replaceAdjacent ? 0 : edge === "start" && linkedPrevious ? timeToMinutes(linkedPrevious.item.from) + minimum : previousEnd;
      const upper = replaceAdjacent ? 1440 : edge === "end" && linkedFollowing ? timeToMinutes(linkedFollowing.item.to) - minimum : followingStart;
      const minute = edge === "start" ? Math.max(lower, Math.min(end - minimum, raw)) : Math.min(upper, Math.max(start + minimum, raw));
      const nextStart = edge === "start" ? minute : start;
      const nextEnd = edge === "end" ? minute : end;
      period.style.left = `${this.minuteToPercent(nextStart)}%`;
      period.style.width = `${this.minuteToPercent(nextEnd) - this.minuteToPercent(nextStart)}%`;
      period.dataset.resizeMinute = String(minute);
      period.title = `${this.modeLabel(block.data?.mode || this.profile(room).defaultMode)} ${minutesToTime(nextStart).slice(0, 5)}–${minutesToTime(nextEnd).slice(0, 5)}`;
    };
    const handle = event.currentTarget;
    const pointerInput = event.type === "pointerdown";
    const touchInput = event.type === "touchstart";
    const moveEvent = pointerInput ? "pointermove" : touchInput ? "touchmove" : "mousemove";
    const upEvent = pointerInput ? "pointerup" : touchInput ? "touchend" : "mouseup";
    const cancelEvent = pointerInput ? "pointercancel" : touchInput ? "touchcancel" : "mouseleave";
    const target = window;
    const cleanup = () => {
      target.removeEventListener(moveEvent, move);
      target.removeEventListener(upEvent, finish);
      target.removeEventListener(cancelEvent, cancel);
      this._resizing = false;
    };
    const finish = () => {
      cleanup();
      const minute = Number(period.dataset.resizeMinute);
      if (Number.isFinite(minute) && minute !== (edge === "start" ? start : end)) {
        const updated = structuredClone(schedule);
        const resized={...updated[this.selectedDay][index],[edge === "start" ? "from" : "to"]:minutesToTime(minute)};
        if(replaceAdjacent){const cleanBlocks=updated[this.selectedDay].filter((item)=>item.data?.mode!=="off");const cleanIndex=updated[this.selectedDay].slice(0,index).filter((item)=>item.data?.mode!=="off").length;updated[this.selectedDay]=replaceBlockRange(cleanBlocks,resized,cleanIndex,minimum);this.recordDraft(room,updated,original);}
        else{
          updated[this.selectedDay][index]=resized;
          if (edge === "start" && linkedPrevious) updated[this.selectedDay][linkedPrevious.itemIndex].to = minutesToTime(minute);
          if (edge === "end" && linkedFollowing) updated[this.selectedDay][linkedFollowing.itemIndex].from = minutesToTime(minute);
          const validation = validateBlocks(updated[this.selectedDay], minimum);
          if (validation.valid) { updated[this.selectedDay] = validation.blocks; this.recordDraft(room, updated, original); }
        }
      }
      this._suppressClickUntil = Date.now() + 350;
      this.render();
    };
    const cancel = () => { cleanup(); this._suppressClickUntil = Date.now() + 350; this.render(); };
    target.addEventListener(moveEvent, move, touchInput ? { passive: false } : undefined);
    target.addEventListener(upEvent, finish);
    target.addEventListener(cancelEvent, cancel);
  }

  async addCreatedGroup() {
    const draft = this.creatingGroup;
    const setup=this.backendStatus?.thermostat_config||{};
    if (!draft?.name?.trim() || !draft?.target) { this.createError = "Enter a schedule name and select a thermostat or thermostat group."; this.render(); return; }
    const helperName=`${draft.name.trim()} Schedule`.toLowerCase();
    if(Object.values(this.schedules||{}).some((schedule)=>String(schedule.name||"").toLowerCase()===helperName)){this.createError="That schedule name is already in use. Choose a unique name for the independent schedule.";this.render();return;}
    let entities=[];
    if(draft.target.startsWith("group:")) entities=[...(setup.groups?.find((item)=>item.id===draft.target.slice(6))?.entities||[])];
    if(draft.target.startsWith("entity:")) entities=[draft.target.slice(7)];
    entities=[...new Set(entities)].filter((entity)=>setup.entities?.includes(entity)&&entity.startsWith("climate."));
    if(!entities.length){this.createError="That thermostat target is no longer available. Reopen Thermostat setup and check its members.";this.render();return;}
    const template=draft.source?.startsWith("template:")?setup.templates?.find((item)=>item.id===draft.source.slice(9)):null;
    const copySource=template?"":draft.source||"";
    const group = { name: draft.name.trim(), group_id: `group_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, entities, entity: entities[0], entity_type: "climate", schedule: pendingScheduleValue(`${draft.name.trim()} Schedule`, copySource), draft_source: copySource, reset_schedule: true, enabled: true, ...(template?{suggested_week:structuredClone(template.week)}:{}) };
    this.config.groups ||= [];
    let containerIndex = this.config.groups.findIndex((item) => item.name === draft.container);
    if (containerIndex < 0) { this.config.groups.push({ name: draft.container || "Schedules", schedules: [] }); containerIndex = this.config.groups.length - 1; }
    this.config.groups[containerIndex].schedules.push(group);
    this.creatingGroup = null;
    fireChanged(this, this.config);
    try { if (this.backendConnected) await this._hass.callWS({ type: "schedule_control/reconcile", card_id: this.config.card_id, groups: this.configuredGroups(), modes: this.config.operating_modes || [] }); }
    catch (error) { this.error = `Could not register schedule group: ${error?.message || error}`; }
    this.render();
    this.ensurePendingSchedules();
  }

  createGroupPanel() {
    if (!this.creatingGroup) return "";
    const setup=this.backendStatus?.thermostat_config||{entities:[],groups:[]};
    const query = String(this.creatingGroup.entitySearch || "").toLowerCase();
    const grouped=new Set((setup.groups||[]).flatMap((group)=>group.entities||[]));
    const groupOptionsList=(setup.groups||[]).filter((group)=>group.entities?.length).map((group)=>({value:`group:${group.id}`,name:group.name,detail:`${group.entities.length} thermostat${group.entities.length===1?"":"s"}`,icon:"mdi:home-thermometer-outline"}));
    const individualOptions=(setup.entities||[]).filter((entity)=>!grouped.has(entity)).map((entity)=>{const state=this._hass?.states?.[entity];return{value:`entity:${entity}`,name:state?.attributes?.friendly_name||entity,detail:entity,icon:state?.attributes?.icon||"mdi:thermostat"};});
    const targetOptions=[...groupOptionsList,...individualOptions].filter((item)=>!query||`${item.name} ${item.detail}`.toLowerCase().includes(query)).map((item)=>`<button data-create-target="${esc(item.value)}" class="${this.creatingGroup.target===item.value?"active":""}"><ha-icon icon="${esc(item.icon)}"></ha-icon><span><b>${esc(item.name)}</b><small>${esc(item.detail)}</small></span><ha-icon icon="${this.creatingGroup.target===item.value?"mdi:check-circle":"mdi:circle-outline"}"></ha-icon></button>`).join("");
    const copySources=this.allRooms().filter((room)=>String(room.schedule||"").startsWith("schedule.")&&this.scheduleFor(room)?.id).map((room)=>({entity:room.schedule,name:room.name||this.scheduleFor(room).name||"Saved schedule"}));
    const templateOptions=(setup.templates||[]).map((template)=>`<option value="template:${esc(template.id)}" ${this.creatingGroup.source===`template:${template.id}`?"selected":""}>Use routine: ${esc(template.name)}</option>`).join("");
    const sourceOptions=`${templateOptions}${copySources.map((source)=>`<option value="${esc(source.entity)}" ${this.creatingGroup.source===source.entity?"selected":""}>Duplicate ${esc(source.name)}</option>`).join("")}`;
    const groupOptions = (this.config.groups || []).map((group) => `<option value="${esc(group.name)}">${esc(group.name)}</option>`).join("");
    const fromTemplate=this.creatingGroup.source?.startsWith("template:");const duplicating=Boolean(this.creatingGroup.source)&&!fromTemplate;
return `<aside class="period-editor create-editor climate-create-editor"><div class="editor-title"><div><small>Climate scheduling</small><h2>Add device row</h2></div><button data-create-cancel aria-label="Close creator">×</button></div><p class="create-help">Choose a thermostat target from Thermostat setup. A thermostat group follows one shared timeline.</p>${this.createError ? `<p class="error">${esc(this.createError)}</p>` : ""}<label>Row name<input data-create-name value="${esc(this.creatingGroup.name)}" placeholder="For example: Bedrooms weekdays"></label><label>Card section<select data-create-container>${groupOptions}</select><small>This controls where the device row is displayed on this card.</small></label><div class="entity-picker"><b>Thermostat target</b><input type="search" data-create-entity-search value="${esc(this.creatingGroup.entitySearch)}" placeholder="Search configured thermostats and groups"><div class="thermostat-target-list">${targetOptions||"<p>No matching thermostat targets. Use Thermostat setup first.</p>"}</div></div><label>Starting point<select data-create-source><option value="">New blank schedule</option>${sourceOptions}</select><small>${fromTemplate?"The routine becomes an independent editable schedule for this target.":duplicating?"All seven days and nodes will be copied once. The new schedule is then fully independent.":"Start with an empty seven-day timeline."}</small></label><div class="blank-start"><ha-icon icon="${fromTemplate?"mdi:account-clock":duplicating?"mdi:content-copy":"mdi:calendar-blank-outline"}"></ha-icon><span><b>${fromTemplate?"Routine starting point":duplicating?"Independent duplicate":"New blank schedule"}</b><small>${fromTemplate?"Review and adjust every generated node after creation.":duplicating?"Changes to this copy will not alter the original timeline.":"You will add the first preset node directly on the timeline."}</small></span></div><button class="save create-submit" data-create-submit>${fromTemplate?"Create from routine":duplicating?"Copy timeline":"Create blank timeline"}</button></aside>`;
  }

  async updateSchedule(schedule, historySnapshot = null) {
    const payload = { type: "schedule/update", schedule_id: schedule.id, name: schedule.name, icon: schedule.icon || "mdi:calendar-clock" };
    for (const day of DAYS) {
      const validation = validateBlocks((schedule[day] || []).filter((block) => block.data?.mode !== "off"), this.config.minimum_period);
      if (!validation.valid) throw new Error(validation.reason);
      payload[day] = validation.blocks;
    }
    await this._hass.callWS(payload);
    if (historySnapshot) {
      this.undoStack.push(structuredClone(historySnapshot));
      this.undoStack = this.undoStack.slice(-30);
      this.redoStack = [];
    }
  }

  async undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    const current = this.workingSchedules.get(previous.group);
    if (current) this.redoStack.push({ group: previous.group, schedule: structuredClone(current) });
    this.workingSchedules.set(previous.group, structuredClone(previous.schedule));
    this.dirtyGroups.add(previous.group);
    this.editing = null;
    this.render();
  }

  async redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    const current = this.workingSchedules.get(next.group);
    if (current) this.undoStack.push({ group: next.group, schedule: structuredClone(current) });
    this.workingSchedules.set(next.group, structuredClone(next.schedule));
    this.dirtyGroups.add(next.group);
    this.editing = null;
    this.render();
  }

  resolvedEdgeMinute(block, edge) {
    const anchor = block?.data?.[`${edge}_anchor`];
    if (["sunrise", "sunset"].includes(anchor)) {
      const attribute = anchor === "sunrise" ? "next_rising" : "next_setting";
      const event = new Date(this._hass?.states?.["sun.sun"]?.attributes?.[attribute]);
      if (!Number.isNaN(event.getTime())) {
        return Math.max(0, Math.min(1440, event.getHours() * 60 + event.getMinutes() + Number(block.data?.[`${edge}_offset`] || 0)));
      }
    }
    return timeToMinutes(block?.[edge === "start" ? "from" : "to"]);
  }

  scheduleSummary() {
    const now = new Date();
    const today = DAYS[(now.getDay() + 6) % 7];
    const minute = now.getHours() * 60 + now.getMinutes();
    let active = 0;
    const activeLabels = [];
    const changes = [];
    for (const room of this.allRooms().filter((item) => item.enabled !== false)) {
      const blocks = this.scheduleFor(room)?.[today] || [];
      const activeBlocks = blocks.filter((item) => item.data?.mode !== "off");
      for (const block of activeBlocks) {
        const from = this.resolvedEdgeMinute(block, "start"); const to = this.resolvedEdgeMinute(block, "end");
        if ((to > from && from <= minute && minute < to) || (to <= from && (minute >= from || minute < to))) { active += 1; activeLabels.push(this.modeLabel(block.data?.mode)); }
        if (from > minute) changes.push({ at: from, room: room.name || room.entity || "Schedule", action: this.modeLabel(block.data?.mode) });
        if (to > minute && !activeBlocks.some((next) => timeToMinutes(next.from) === to)) changes.push({ at: to, room: room.name || room.entity || "Schedule", action: "Off" });
      }
    }
    const unique = [...new Set(activeLabels.filter(Boolean))];
    const nextMinute = Math.min(Infinity, ...changes.map((change) => change.at));
    const nextChanges = changes.filter((change) => change.at === nextMinute);
    let nextDescription = "Tomorrow";
    if (nextChanges.length) {
      const actions = [...new Set(nextChanges.map((change) => change.action))];
      nextDescription = actions.length === 1 && nextChanges.length > 1
        ? `${nextChanges.length} devices → ${actions[0]} at ${minutesToTime(nextMinute).slice(0, 5)}`
        : `${nextChanges.slice(0, 2).map((change) => `${change.room} → ${change.action}`).join(" · ")}${nextChanges.length > 2 ? ` +${nextChanges.length - 2} more` : ""} at ${minutesToTime(nextMinute).slice(0, 5)}`;
    }
    return { active, current: active ? (unique.length === 1 ? unique[0] : `${active} schedules active`) : "All schedules off", next: nextDescription };
  }

  bindEvents() {
    this.shadowRoot.querySelector("[data-health]")?.addEventListener("click", () => { this.healthOpen = !this.healthOpen; this.render(); });
    this.shadowRoot.querySelectorAll("[data-card-mode]").forEach((button) => button.addEventListener("click", () => this.setCardMode(button.dataset.cardMode)));
    this.shadowRoot.querySelector("[data-health-close]")?.addEventListener("click", () => { this.healthOpen = false; this.render(); });
    this.shadowRoot.querySelector("ha-card")?.addEventListener("pointerdown", () => { this._lastInteraction = Date.now(); });
    this.shadowRoot.querySelector("[data-view-overview]")?.addEventListener("click", () => this.setTimelineMode("overview"));
    this.shadowRoot.querySelector("[data-view-focus]")?.addEventListener("click", () => this.setTimelineMode("focus"));
    this.shadowRoot.querySelector("[data-view-now]")?.addEventListener("click", () => { const now = new Date(); this.setTimelineMode("focus", now.getHours() * 60 + now.getMinutes()); });
    const ruler = this.shadowRoot.querySelector("[data-time-ruler]");
    if (ruler) ruler.onpointerdown = (event) => {
      const startX = event.clientX; const startCenter = this.focusCenter; const rect = ruler.getBoundingClientRect();
      const move = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        if (Math.abs(delta) < 6) return;
        if (this.timelineMode !== "focus") this.timelineMode = "focus";
        this.focusCenter = Math.max(180, Math.min(1260, startCenter - delta / rect.width * (360 / .7)));
        this.render();
      };
      const end = () => { localStorage.setItem("schedule-control-timeline-mode", this.timelineMode); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end, { once: true });
    };
    this.shadowRoot.querySelectorAll("[data-day]").forEach((button) => button.onclick = () => { const today = DAYS[(new Date().getDay() + 6) % 7]; this.selectedDay = button.dataset.day; this._followingToday = this.selectedDay === today; this.editing = null; this.render(); });
    this.shadowRoot.querySelector("[data-today]")?.addEventListener("click", () => { this.selectedDay = DAYS[(new Date().getDay() + 6) % 7]; this._followingToday = true; this.editing = null; this.render(); });
    this.shadowRoot.querySelectorAll("[data-create]").forEach((button) => button.onclick = () => this.createSchedule(this.roomByKey(button.dataset.create)));
    this.shadowRoot.querySelectorAll("[data-timeline]").forEach((timeline) => timeline.onclick = (event) => this.openEditor(this.roomByKey(timeline.dataset.timeline), -1, event));
    this.shadowRoot.querySelectorAll("[data-block-room]").forEach((block) => block.onclick = (event) => {
      event.stopPropagation();
      if (Date.now() < (this._suppressClickUntil || 0)) return;
      const room = this.roomByKey(block.dataset.blockRoom); const index = Number(block.dataset.blockIndex);
      const sourceDay = block.dataset.blockDay || this.selectedDay;
      const period = this.scheduleFor(room)?.[sourceDay]?.[index];
      const start = this.resolvedEdgeMinute(period, "start"); const rawEnd = this.resolvedEdgeMinute(period, "end"); const end = rawEnd <= start ? 1440 : rawEnd;
      if (period && this.minuteToPercent(end) - this.minuteToPercent(start) < 8) { this.setTimelineMode("focus", (start + end) / 2); return; }
      if (sourceDay !== this.selectedDay) this.selectedDay = sourceDay;
      this.openEditor(room, index);
    });
    this.shadowRoot.querySelectorAll("[data-resize-edge]").forEach((handle) => {
      const begin = (event) => this.startResize(event, this.roomByKey(handle.dataset.resizeRoom), Number(handle.dataset.resizeIndex), handle.dataset.resizeEdge);
      if (window.PointerEvent) handle.addEventListener("pointerdown", begin);
      else { handle.addEventListener("mousedown", begin); handle.addEventListener("touchstart", begin, { passive: false }); }
    });
    this.shadowRoot.querySelector("[data-save]")?.addEventListener("click", () => this.savePeriod());
    this.shadowRoot.querySelector("[data-delete]")?.addEventListener("click", () => this.deletePeriod());
    this.shadowRoot.querySelector("[data-cancel]")?.addEventListener("click", () => { this.editing = null; this.render(); });
    this.shadowRoot.querySelector("[data-undo]")?.addEventListener("click", () => this.undo());
    this.shadowRoot.querySelector("[data-redo]")?.addEventListener("click", () => this.redo());
    this.shadowRoot.querySelector("[data-create-group]")?.addEventListener("click", () => this.openCreateGroup());
    this.shadowRoot.querySelector("[data-build-routine]")?.addEventListener("click", () => this.openRoutineBuilder());
    this.shadowRoot.querySelectorAll("[data-routine-close]").forEach((button)=>button.onclick=()=>{this.routineDraft=null;this.render();});
    this.shadowRoot.querySelector("[data-routine-save]")?.addEventListener("click",()=>this.saveRoutineTemplate());
    this.shadowRoot.querySelectorAll("[data-routine-field]").forEach((input)=>input.onchange=()=>this.routineDraft[input.dataset.routineField]=input.value);
    this.shadowRoot.querySelector("[data-routine-occupied]")?.addEventListener("change",(event)=>{this.routineDraft.occupied=event.target.checked;});
    this.shadowRoot.querySelectorAll("[data-routine-day]").forEach((input)=>input.onchange=()=>{this.routineDraft.days=input.checked?[...new Set([...this.routineDraft.days,input.dataset.routineDay])]:this.routineDraft.days.filter((day)=>day!==input.dataset.routineDay);});
    this.shadowRoot.querySelector("[data-copy-day-open]")?.addEventListener("click", () => this.openCopyDay());
    this.shadowRoot.querySelector("[data-copy-day-cancel]")?.addEventListener("click", () => { this.copyingDay = null; this.render(); });
    this.shadowRoot.querySelector("[data-copy-day-apply]")?.addEventListener("click", () => this.applyDayCopy());
    const copyRoom = this.shadowRoot.querySelector("[data-copy-day-room]"); if (copyRoom) { copyRoom.value = this.copyingDay?.roomKey || ""; copyRoom.onchange = () => this.copyingDay.roomKey = copyRoom.value; }
    this.shadowRoot.querySelectorAll("[data-copy-full-day]").forEach((input) => input.onchange = () => { const day = input.dataset.copyFullDay; this.copyingDay.days = input.checked ? [...new Set([...this.copyingDay.days, day])] : this.copyingDay.days.filter((item) => item !== day); });
    this.shadowRoot.querySelector("[data-create-cancel]")?.addEventListener("click", () => { this.creatingGroup = null; this.render(); });
    this.shadowRoot.querySelector("[data-create-submit]")?.addEventListener("click", () => this.addCreatedGroup());
    const createName = this.shadowRoot.querySelector("[data-create-name]"); if (createName) createName.oninput = () => this.creatingGroup.name = createName.value;
    const createEntitySearch = this.shadowRoot.querySelector("[data-create-entity-search]"); if (createEntitySearch) createEntitySearch.oninput = () => { const query = createEntitySearch.value.trim().toLowerCase(); this.creatingGroup.entitySearch = query; this.shadowRoot.querySelectorAll("[data-create-target]").forEach((button) => button.hidden = Boolean(query && !button.textContent.toLowerCase().includes(query))); };
    this.shadowRoot.querySelectorAll("[data-create-target]").forEach((button)=>button.onclick=()=>{this.creatingGroup.target=button.dataset.createTarget;this.render();});
    const createSource = this.shadowRoot.querySelector("[data-create-source]"); if (createSource) { createSource.value = this.creatingGroup?.source || ""; createSource.onchange = () => {this.creatingGroup.source=createSource.value;this.render();}; }
    const createContainer = this.shadowRoot.querySelector("[data-create-container]"); if (createContainer) { createContainer.value = this.creatingGroup?.container || ""; createContainer.onchange = () => this.creatingGroup.container = createContainer.value; }
    this.shadowRoot.querySelector("[data-save-all]")?.addEventListener("click", () => this.saveDrafts());
    this.shadowRoot.querySelector("[data-discard-all]")?.addEventListener("click", () => this.discardDrafts());
    this.shadowRoot.querySelectorAll("[data-manage-schedule]").forEach((button) => button.onclick = (event) => { event.stopPropagation(); this.openScheduleManager(this.roomByKey(button.dataset.manageSchedule)); });
    this.shadowRoot.querySelectorAll("[data-quick-boost]").forEach((button) => button.onclick = (event) => { event.stopPropagation(); const room=this.roomByKey(button.dataset.quickBoost); const active=this.backendStatus?.cards?.[this.config.card_id]?.boosts?.[room?.group_id]; if(active)this.quickBoost(room);else{this.boostPickerRoom=room?._key;this.render();} });
    this.shadowRoot.querySelector("[data-boost-picker-close]")?.addEventListener("click",()=>{this.boostPickerRoom=null;this.render();});
    this.shadowRoot.querySelectorAll("[data-boost-duration]").forEach(button=>button.onclick=()=>this.quickBoost(this.roomByKey(this.boostPickerRoom),Number(button.dataset.boostDuration)));
    this.shadowRoot.querySelector("[data-manage-cancel]")?.addEventListener("click", () => { this.managingSchedule = null; this.render(); });
    this.shadowRoot.querySelector("[data-manage-save]")?.addEventListener("click", () => this.saveScheduleDetails());
    this.shadowRoot.querySelector("[data-manage-delete]")?.addEventListener("click", () => this.deleteManagedSchedule());
    this.shadowRoot.querySelector("[data-native-boost-action]")?.addEventListener("click", () => this.toggleManagedBoost());
    this.shadowRoot.querySelector("[data-manage-add-entity]")?.addEventListener("click", () => { this.managingSchedule.entities.push(""); this.render(); });
    this.shadowRoot.querySelectorAll("[data-manage-entity]").forEach((select) => { const index = Number(select.dataset.manageEntity); select.value = this.managingSchedule?.entities[index] || ""; select.onchange = () => { this.managingSchedule.entities[index] = select.value; }; });
    const manageSearch = this.shadowRoot.querySelector("[data-manage-entity-search]"); if (manageSearch) manageSearch.oninput = () => { const query = manageSearch.value.trim().toLowerCase(); this.shadowRoot.querySelectorAll("[data-manage-entity] option").forEach((option,index) => { if(index) option.hidden = Boolean(query && !option.textContent.toLowerCase().includes(query)); }); };
    this.shadowRoot.querySelectorAll("[data-manage-remove-entity]").forEach((button) => button.onclick = () => { this.managingSchedule.entities.splice(Number(button.dataset.manageRemoveEntity), 1); this.render(); });
    this.shadowRoot.querySelectorAll("[data-edit]").forEach((input) => input.onchange = () => { this.editing[input.dataset.edit] = ["number", "range"].includes(input.type) ? Number(input.value) : input.value; if (["mode", "brightness", "colorTemp", "startAnchor", "endAnchor"].includes(input.dataset.edit)) this.render(); });
    this.shadowRoot.querySelectorAll("[data-mode-choice]").forEach((button) => button.onclick = () => { this.editing.mode = button.dataset.modeChoice; if(!this.editing.override)this.editing.target=this.thermostatTemperature(this.editing.room,this.editing.mode); this.render(); });
    this.shadowRoot.querySelectorAll("[data-temp-step]").forEach((button) => button.onclick = () => { this.editing.target = Math.min(35, Math.max(5, Number(this.editing.target) + Number(button.dataset.tempStep))); this.render(); });
    this.shadowRoot.querySelector("[data-override]")?.addEventListener("change", (event) => { this.editing.override = event.target.checked; this.render(); });
    this.shadowRoot.querySelector("[data-fill-gaps]")?.addEventListener("click", () => this.fillClimateGaps(this.editing.room, this.shadowRoot.querySelector("[data-fill-preset]")?.value));
    this.shadowRoot.querySelector("[data-save-fill-gaps]")?.addEventListener("click", () => {this._fillAfterSave=this.shadowRoot.querySelector("[data-fill-preset]")?.value||"away";this.savePeriod();});
    this.shadowRoot.querySelectorAll("[data-copy-day]").forEach((input) => input.onchange = () => { const day = input.dataset.copyDay; this.editing.copyDays = input.checked ? [...new Set([...this.editing.copyDays, day])] : this.editing.copyDays.filter((item) => item !== day); });
  }

  allRooms() {
    const rooms = (this.config?.groups || []).flatMap((group, groupIndex) => (group.schedules || []).map((room, roomIndex) => ({ ...room, _key: `${groupIndex}:${roomIndex}`, _zone: group.name })));
    if (this.config?.hot_water) rooms.push({ ...this.config.hot_water, _key: "__hot_water", _zone: "Hot Water", hot_water: true });
    return rooms;
  }

  roomByKey(key) { return this.allRooms().find((room) => room._key === key); }

  ownedMappingEntries(room) {
    const prefix = `${this.config.card_id}:${room.group_id}:`;
    return Object.entries(this.backendStatus?.mappings || {}).filter(([mappingId]) => mappingId.startsWith(prefix));
  }

  async deleteGroupSchedule(groupIndex, scheduleIndex) {
    const room = this.config.groups?.[groupIndex]?.schedules?.[scheduleIndex];
    if (!room) return;
    const ownedMappings = this.ownedMappingEntries(room);
    if (!window.confirm(`Delete ${room.name || "this schedule"}? This permanently removes its saved schedule and all nodes.`)) return;
    try {
      const ownedGroup = this.backendStatus?.cards?.[this.config.card_id]?.groups?.[room.group_id];
      const schedules = [room.schedule, ownedGroup?.schedule, ...ownedMappings.map(([, mapping]) => mapping.schedule)];
      await this.deleteOwnedSchedules(schedules);
      if (this.backendConnected) await this._hass.callWS({ type: "schedule_control/remove_group", card_id: this.config.card_id, group_id: room.group_id });
      const next = structuredClone(this.config);
      next.groups[groupIndex].schedules.splice(scheduleIndex, 1);
      this.config = next;
      this.workingSchedules.delete(room.group_id);
      this.dirtyGroups.delete(room.group_id);
      fireChanged(this, next);
      await this.loadBackendStatus();
      await this.loadSchedules();
      this.saveError = "";
      this.render();
    } catch (error) { this.saveError = `Could not delete schedule: ${error?.message || error}`; this.render(); }
  }

  async resetCardData() {
    if (!window.confirm("Reset this Schedule Control card? Every schedule helper, mapping, boost and mode owned by this card will be permanently removed.")) return;
    try {
      const card = this.backendStatus?.cards?.[this.config.card_id] || {};
      const schedules = [
        ...this.allRooms().map((room) => room.schedule),
        ...Object.values(card.groups || {}).map((group) => group.schedule),
        ...Object.entries(this.backendStatus?.mappings || {}).filter(([mappingId]) => mappingId.startsWith(`${this.config.card_id}:`)).map(([, mapping]) => mapping.schedule),
      ];
      if (this.backendConnected) await this._hass.callWS({ type: "schedule_control/reset_card", card_id: this.config.card_id });
      await this.deleteOwnedSchedules(schedules);
      const next = structuredClone(this.config);
      next.groups = [];
      next.hot_water = null;
      next.operating_modes = [];
      this.config = next;
      this.workingSchedules.clear(); this.dirtyGroups.clear(); this.undoStack = []; this.redoStack = [];
      fireChanged(this, next);
      await this.loadBackendStatus();
      this.editorMessage = "Card reset complete. All owned schedules and backend control data were removed.";
      this.render();
    } catch (error) {
      this.editorMessage = `Reset stopped safely: ${error?.message || error}`;
      this.render();
    }
  }

  openScheduleManager(room) {
    if (!room || room._key === "__hot_water") return;
    this.editing = null; this.creatingGroup = null; this.copyingDay = null;
    this.managingSchedule = { key: room._key, groupId: room.group_id, name: room.name || "Schedule", container: room._zone, entities: [...(room.entities || [room.entity].filter(Boolean))], enabled: room.enabled !== false, boostEntity: room.boost_entity || "", boostTimer: room.boost_timer || "", presetOverrides: { ...(room.preset_overrides || {}) }, nativeBoost: { enabled: true, duration: 60, temperature: 22, preset: "", ...(room.native_boost || {}) } };
    this.render();
  }

  scheduleManager() {
    const edit = this.managingSchedule; if (!edit) return "";
    const currentDomain = edit.entities.find(Boolean)?.split(".")[0] || "";
    const options = Object.entries(this._hass?.states || {}).filter(([id]) => !currentDomain || id.startsWith(`${currentDomain}.`)).filter(([id]) => PROFILES[id.split(".")[0]]).map(([id,state]) => `<option value="${esc(id)}">${esc(state.attributes.friendly_name || id)}</option>`).join("");
    const groupOptions = (this.config.groups || []).map((group) => `<option value="${esc(group.name)}" ${group.name === edit.container ? "selected" : ""}>${esc(group.name)}</option>`).join("");
    const entities = edit.entities.map((entity,index) => `<div class="manage-entity"><select data-manage-entity="${index}"><option value="">Select entity</option>${options}</select><button data-manage-remove-entity="${index}" aria-label="Remove entity">×</button></div>`).join("");
    const activeBoost = this.backendStatus?.cards?.[this.config.card_id]?.boosts?.[edit.groupId];
    const presets = currentDomain === "climate" ? [...new Set(edit.entities.flatMap((id) => this._hass?.states?.[id]?.attributes?.preset_modes || []))] : [];
    const boostPanel = currentDomain === "climate" ? `<details class="boost-settings" open><summary>Schedule Control boost</summary><label class="schedule-enabled"><span><input type="checkbox" data-native-boost-enabled ${edit.nativeBoost.enabled ? "checked" : ""}><b>Enable boost for this device row</b></span><small>Schedule Control owns the timer and restores the active mode or schedule when it ends.</small></label><div class="boost-grid"><label>Default duration<select data-native-boost-duration>${[15,30,45,60,90,120,180].map((value)=>`<option value="${value}" ${Number(edit.nativeBoost.duration)===value?"selected":""}>${value} minutes</option>`).join("")}</select></label><label>Boost temperature<input type="number" min="5" max="65" step="0.5" data-native-boost-temperature value="${Number(edit.nativeBoost.temperature ?? 22)}"></label><label>Preset (optional)<select data-native-boost-preset><option value="">Temperature only</option>${presets.map((preset)=>`<option value="${esc(preset)}" ${edit.nativeBoost.preset===preset?"selected":""}>${esc(this.modeLabel(preset))}</option>`).join("")}</select></label></div><button class="${activeBoost ? "danger" : "boost-now"}" data-native-boost-action>${activeBoost ? "Cancel active boost" : "Start boost now"}</button></details>` : "";
    const rowPresetPanel = currentDomain === "climate" ? `<details class="boost-settings row-presets"><summary>Device preset temperatures</summary><p class="capability-note">Optional temperatures for this row only. Leave blank to use the shared preset.</p><div class="boost-grid">${(this.backendStatus?.thermostat_config?.presets || []).map((preset)=>`<label>${esc(preset.name)}<input type="number" min="5" max="65" step="0.5" data-row-preset="${esc(preset.id)}" placeholder="Shared: ${Number(preset.temperature)}°C" value="${edit.presetOverrides[preset.id] ?? ""}"></label>`).join("")}</div></details>` : "";
    return `<aside class="period-editor manage-editor"><div class="editor-title"><div><small>Edit device row</small><h2>${esc(edit.name)}</h2></div><button data-manage-cancel aria-label="Close">×</button></div><label class="schedule-enabled"><span><input type="checkbox" data-manage-enabled ${edit.enabled ? "checked" : ""}><b>Automatic control</b></span><small>${edit.enabled ? "This row currently follows its timeline." : "Paused — this row has no effect on its devices."}</small></label><label>Row name<input data-manage-name value="${esc(edit.name)}"></label><label>Group<select data-manage-container>${groupOptions}</select></label><div class="controlled-entities"><small>Controlled entities · ${esc(currentDomain || "select one type")}</small><input type="search" data-manage-entity-search placeholder="Search name or entity ID">${entities}<button data-manage-add-entity>+ Add entity</button></div>${rowPresetPanel}${boostPanel}<div class="editor-actions"><button class="danger" data-manage-delete>Remove device row</button><button class="save" data-manage-save>Save details</button></div></aside>`;
  }

  async saveScheduleDetails() {
    const edit = this.managingSchedule; if (!edit) return;
    edit.name = this.shadowRoot.querySelector("[data-manage-name]")?.value.trim() || edit.name;
    edit.container = this.shadowRoot.querySelector("[data-manage-container]")?.value || edit.container;
    edit.enabled = this.shadowRoot.querySelector("[data-manage-enabled]")?.checked !== false;
    edit.boostEntity = this.shadowRoot.querySelector("[data-manage-boost]")?.value || "";
    edit.boostTimer = this.shadowRoot.querySelector("[data-manage-boost-timer]")?.value || "";
    edit.nativeBoost.enabled = this.shadowRoot.querySelector("[data-native-boost-enabled]")?.checked !== false;
    edit.nativeBoost.duration = Number(this.shadowRoot.querySelector("[data-native-boost-duration]")?.value || edit.nativeBoost.duration || 60);
    edit.nativeBoost.temperature = Number(this.shadowRoot.querySelector("[data-native-boost-temperature]")?.value || edit.nativeBoost.temperature || 22);
    edit.nativeBoost.preset = this.shadowRoot.querySelector("[data-native-boost-preset]")?.value || "";
    edit.presetOverrides = {};
    this.shadowRoot.querySelectorAll("[data-row-preset]").forEach((input) => { if (input.value !== "") edit.presetOverrides[input.dataset.rowPreset] = Number(input.value); });
    const [oldGroup, oldIndex] = edit.key.split(":").map(Number);
    const original = this.config.groups[oldGroup].schedules[oldIndex];
    const entities = [...new Set(edit.entities.filter(Boolean))];
    const domains = new Set(entities.map((entity) => entity.split(".")[0]));
    if (!entities.length || domains.size !== 1) { this.saveError = "A schedule needs at least one entity, and all entities must be the same type."; this.render(); return; }
    try {
      const next = structuredClone(this.config); const schedule = next.groups[oldGroup].schedules.splice(oldIndex,1)[0];
      schedule.name = edit.name; schedule.entities = entities; schedule.entity = entities[0]; schedule.entity_type = schedule.entity.split(".")[0]; schedule.enabled = edit.enabled; schedule.boost_entity = edit.boostEntity; schedule.boost_timer = edit.boostTimer; schedule.native_boost = edit.nativeBoost; schedule.preset_overrides = edit.presetOverrides;
      const target = next.groups.find((group) => group.name === edit.container) || next.groups[0]; target.schedules.push(schedule);
      const native = this.scheduleFor({ ...original, _key: edit.key });
      if (native?.id && native.name !== `${edit.name} Schedule`) await this.updateSchedule({ ...structuredClone(native), name: `${edit.name} Schedule` });
      if (this.backendConnected && schedule.schedule) {
        const prefix = `${this.config.card_id}:${schedule.group_id}:`;
        for (const [mappingId,mapping] of Object.entries(this.backendStatus?.mappings || {})) if (mappingId.startsWith(prefix) && !entities.includes(mapping.target)) await this._hass.callWS({ type:"schedule_control/delete", mapping_id:mappingId });
        for (const entity of entities) await this._hass.callWS({ type:"schedule_control/set", mapping_id:`${prefix}${entity}`, target:entity, schedule:schedule.schedule, boost:schedule.boost_entity || "", boost_timer:schedule.boost_timer || "", enabled:edit.enabled, manual_override_timeout:Number(next.manual_override_timeout || 0), week:Object.fromEntries(DAYS.map((day)=>[day,native?.[day] || []])) });
      }
      this.config = next; this.managingSchedule = null; fireChanged(this,next); await this.reconcileAndCleanup(); await this.loadBackendStatus(); this.render();
    } catch (error) { this.saveError = `Could not update schedule: ${error?.message || error}`; this.render(); }
  }

  async deleteManagedSchedule() {
    const edit = this.managingSchedule; if (!edit) return;
    const [groupIndex,scheduleIndex] = edit.key.split(":").map(Number); this.managingSchedule = null;
    await this.deleteGroupSchedule(groupIndex,scheduleIndex);
  }

  async toggleManagedBoost() {
    const edit = this.managingSchedule;
    if (!edit || !this.backendConnected) return;
    const active = this.backendStatus?.cards?.[this.config.card_id]?.boosts?.[edit.groupId];
    try {
      if (active) {
        await this._hass.callWS({ type: "schedule_control/cancel_boost", card_id: this.config.card_id, group_id: edit.groupId });
      } else {
        const duration = Number(this.shadowRoot.querySelector("[data-native-boost-duration]")?.value || edit.nativeBoost.duration || 60);
        const temperature = Number(this.shadowRoot.querySelector("[data-native-boost-temperature]")?.value || edit.nativeBoost.temperature || 22);
        const preset = this.shadowRoot.querySelector("[data-native-boost-preset]")?.value || edit.nativeBoost.preset || "";
        await this._hass.callWS({ type: "schedule_control/start_boost", card_id: this.config.card_id, group_id: edit.groupId, duration, temperature, preset });
      }
      await this.loadBackendStatus();
      this.render();
    } catch (error) {
      this.saveError = `Could not change boost: ${error?.message || error}`;
      this.render();
    }
  }

  async quickBoost(room, selectedDuration = null) {
    if (!room?.group_id || !this.backendConnected) return;
    const active = this.backendStatus?.cards?.[this.config.card_id]?.boosts?.[room.group_id];
    const settings = { enabled: true, duration: 60, temperature: Number(this.presetDefinition("boost")?.temperature ?? 22), preset: "", ...(room.native_boost || {}) };
    if (!settings.enabled && !active) return;
    this.boostPickerRoom = null;
    this.render();
    try {
      if (active) await this._hass.callWS({ type: "schedule_control/cancel_boost", card_id: this.config.card_id, group_id: room.group_id });
      else await this._hass.callWS({ type: "schedule_control/start_boost", card_id: this.config.card_id, group_id: room.group_id, duration: Number(selectedDuration || settings.duration), temperature: Number(settings.temperature), preset: settings.preset || "" });
      await this.loadBackendStatus();
      this.render();
    } catch (error) { this.saveError = `Could not change boost: ${error?.message || error}`; this.render(); }
  }

  openRoutineBuilder() {
    const presets=this.backendStatus?.thermostat_config?.presets||[];
    const fallback=(id,index)=>presets.find((item)=>item.id===id)?.id||presets[index]?.id||"";
    this.routineDraft={name:"Weekdays",wake:"06:30",leave:"08:30",return:"17:30",bed:"22:30",occupied:false,days:["monday","tuesday","wednesday","thursday","friday"],morning:fallback("comfort",0),dayHome:fallback("eco",1),away:fallback("away",2),evening:fallback("comfort",0),night:fallback("night",3)};
    this.routineError="";this.render();
  }

  routineBuilderHtml() {
    const draft=this.routineDraft;if(!draft)return "";
    const presets=this.backendStatus?.thermostat_config?.presets||[];
    const options=(selected)=>presets.map((preset)=>`<option value="${esc(preset.id)}" ${preset.id===selected?"selected":""}>${esc(preset.name)} · ${Number(preset.temperature).toFixed(1)}°C</option>`).join("");
    const dayChoices=DAYS.map((day)=>`<label><input type="checkbox" data-routine-day="${day}" ${draft.days.includes(day)?"checked":""}>${DAY_LABELS[day]}</label>`).join("");
    return `<div class="routine-backdrop"><div class="routine-wizard"><header><div><small>Guided starting point</small><h2>Build from my routine</h2></div><button data-routine-close>×</button></header><main>${this.routineError?`<p class="error">${esc(this.routineError)}</p>`:""}<p class="routine-intro">Answer these everyday questions and Schedule Control will generate a reusable seven-day template. It does not control a thermostat until you select it while creating a schedule.</p><label>Template name<input data-routine-field="name" value="${esc(draft.name)}" placeholder="Weekdays"></label><fieldset><legend>Which days follow this routine?</legend><div class="routine-days">${dayChoices}</div></fieldset><div class="routine-phases"><label>Wake up<input type="time" data-routine-field="wake" value="${draft.wake}"><select data-routine-field="morning">${options(draft.morning)}</select></label><label>Leave home<input type="time" data-routine-field="leave" value="${draft.leave}"><select data-routine-field="away">${options(draft.away)}</select></label><label>Return home<input type="time" data-routine-field="return" value="${draft.return}"><select data-routine-field="evening">${options(draft.evening)}</select></label><label>Bedtime<input type="time" data-routine-field="bed" value="${draft.bed}"><select data-routine-field="night">${options(draft.night)}</select></label></div><label class="routine-occupied"><input type="checkbox" data-routine-occupied ${draft.occupied?"checked":""}><span><b>Someone is normally home during the day</b><small>Use a daytime preset instead of the away preset between leaving and returning.</small></span><select data-routine-field="dayHome">${options(draft.dayHome)}</select></label></main><footer><button data-routine-close>Cancel</button><button class="save" data-routine-save>Save routine template</button></footer></div></div>`;
  }

  async saveRoutineTemplate() {
    const draft=this.routineDraft;if(!draft)return;
    this.shadowRoot.querySelectorAll("[data-routine-field]").forEach((input)=>draft[input.dataset.routineField]=input.value);
    draft.occupied=this.shadowRoot.querySelector("[data-routine-occupied]")?.checked===true;
    draft.days=[...this.shadowRoot.querySelectorAll("[data-routine-day]:checked")].map((input)=>input.dataset.routineDay);
    const times=[draft.wake,draft.leave,draft.return,draft.bed].map(timeToMinutes);
    if(!draft.name.trim()||!draft.days.length||times.some(Number.isNaN)||times[0]<=0||times[3]>=1440||!times.every((value,index)=>index===0||value>times[index-1])){this.routineError="Enter a unique name, select at least one day, and keep Wake, Leave, Return and Bedtime in chronological order.";this.render();return;}
    const preset=(id)=>this.backendStatus?.thermostat_config?.presets?.find((item)=>item.id===id);
    const block=(from,to,id)=>({from:`${from}:00`,to:to==="24:00"?"24:00:00":`${to}:00`,data:{mode:id,target_temp:Number(preset(id)?.temperature??20)}});
    const active=[block("00:00",draft.wake,draft.night),block(draft.wake,draft.leave,draft.morning),block(draft.leave,draft.return,draft.occupied?draft.dayHome:draft.away),block(draft.return,draft.bed,draft.evening),block(draft.bed,"24:00",draft.night)];
    const week=Object.fromEntries(DAYS.map((day)=>[day,draft.days.includes(day)?structuredClone(active):[]]));
    const configuration=structuredClone(this.backendStatus?.thermostat_config||{});configuration.templates||=[];
    if(configuration.templates.some((item)=>item.name.toLowerCase()===draft.name.trim().toLowerCase())){this.routineError="A routine template with that name already exists.";this.render();return;}
    configuration.templates.push({id:`routine_${Date.now()}`,name:draft.name.trim(),week});
    try{const saved=await this._hass.callWS({type:"schedule_control/set_thermostat_config",configuration});this.backendStatus.thermostat_config=saved;this.routineDraft=null;this.render();}
    catch(error){this.routineError=`Could not save routine: ${error?.message||error}`;this.render();}
  }

  boostPicker() {
    const room=this.roomByKey(this.boostPickerRoom); if(!room)return "";
    const settings={duration:60,durations:[15,30,60,90,120],temperature:Number(this.presetDefinition("boost")?.temperature??22),...(room.native_boost||{})};
    const durations=[...new Set((settings.durations||[15,30,60,90,120]).map(Number).filter(Boolean))].sort((a,b)=>a-b);
    return `<div class="boost-picker-backdrop"><div class="boost-picker"><header><div><small>Schedule Control boost</small><h2>${esc(room.name||room.entity)}</h2></div><button data-boost-picker-close>×</button></header><p>Choose how long to hold <b>${Number(settings.temperature).toFixed(1)}°C</b>. The weekly schedule or active mode resumes automatically afterwards.</p><div>${durations.map(duration=>`<button data-boost-duration="${duration}" class="${duration===Number(settings.duration)?"default":""}"><b>${duration}</b><span>minutes</span>${duration===Number(settings.duration)?"<small>Default</small>":""}</button>`).join("")}</div></div></div>`;
  }

  timeline(room) {
    const schedule = this.scheduleFor(room);
    const pending = pendingSchedule(room.schedule);
    if (!schedule && pending) return `<div class="missing">Preparing ${esc(pending.name)}…</div>`;
    if (!schedule && room.schedule) return `<button class="missing warning" data-manage-schedule="${esc(room._key)}" title="Open schedule settings"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><span>Schedule unavailable</span><small>Review settings</small></button>`;
    if (!schedule) return `<div class="missing">Choose a schedule in card settings</div>`;
    const blocks = schedule[this.selectedDay] || [];
    const dayIndex = DAYS.indexOf(this.selectedDay);
    const previousDay = DAYS[(dayIndex + DAYS.length - 1) % DAYS.length];
    const type = roomType(room, this.config.schedule_type);
    const currentBlocks = blocks.map((block, index) => { const start = this.resolvedEdgeMinute(block, "start"); const rawEnd = this.resolvedEdgeMinute(block, "end"); return { block, index, sourceDay: this.selectedDay, carryover: false, start, end: rawEnd <= start ? 1440 : rawEnd }; }).filter(({ block }) => type !== "climate" || block.data?.mode !== "off");
    const carryoverBlocks = (schedule[previousDay] || []).map((block, index) => { const start = this.resolvedEdgeMinute(block, "start"); const end = this.resolvedEdgeMinute(block, "end"); return { block, index, sourceDay: previousDay, carryover: true, start: 0, end, overnight: end <= start }; }).filter(({ block, overnight, end }) => (type !== "climate" || block.data?.mode !== "off") && overnight && end > 0);
    const activeBlocks = [...carryoverBlocks, ...currentBlocks];
    const profile = this.profile(room);
    const sortedBlocks = [...activeBlocks].sort((a, b) => a.start - b.start);
    let gapStart = 0;
    const gaps = [];
    for (const item of sortedBlocks) {
      const start = item.start;
      if (start > gapStart) gaps.push([gapStart, start]);
      gapStart = Math.max(gapStart, item.end);
    }
    if (gapStart < 1440) gaps.push([gapStart, 1440]);
    const gapLabel = type === "climate" ? "OFF" : "NO ACTION";
    const gapHtml = gaps.map(([start, end]) => `<span class="off-gap no-action-gap" style="left:${this.minuteToPercent(start)}%;width:${this.minuteToPercent(end) - this.minuteToPercent(start)}%">${this.minuteToPercent(end) - this.minuteToPercent(start) >= 5 ? gapLabel : ""}</span>`).join("");
    const blockHtml = activeBlocks.map(({ block, index, sourceDay, carryover, start, end }) => {
      const mode = block.data?.mode || profile.defaultMode;
      const modeClass = mode === "on" ? "on" : mode === "off" ? "off" : "dynamic-preset";
      const fallbackColors = { comfort: "#d97706", eco: "#477a45", away: "#7c3aed" };
      const periodColor = mode === "on" ? safeColor(this.config.colors?.on, "#2563eb") : mode === "off" ? safeColor(this.config.colors?.off, "#34465b") : safeColor(this.presetDefinition(mode)?.color || this.config.colors?.[`preset_${mode}`] || this.config.colors?.[mode], fallbackColors[mode] || "#7c3aed");
      const temperature = block.data?.target_temp;
      const detail = type === "climate" ? (temperature === undefined ? "" : `${Number(temperature)}°`) : type === "light" && mode === "on" ? `${Number(block.data?.brightness_pct ?? 75)}%` : "";
      const duration = end - start;
      const displayWidth = this.minuteToPercent(end) - this.minuteToPercent(start);
      const compactLabel = type === "climate" ? `${String(mode).slice(0, 1).toUpperCase()}${Number.isFinite(Number(temperature)) ? ` · ${Number(temperature)}°` : ""}` : mode === "off" ? "OFF" : "ON";
      const compact = displayWidth < 8;
      const label = compact ? compactLabel : this.modeLabel(mode);
      const resolvedTitle = carryover ? `Continued from ${DAY_LABELS[sourceDay]} until ${block.data?.end_anchor ? this.modeLabel(block.data.end_anchor) : block.to.slice(0, 5)}` : `${block.data?.start_anchor ? this.modeLabel(block.data.start_anchor) : block.from.slice(0, 5)}–${block.data?.end_anchor ? this.modeLabel(block.data.end_anchor) : block.to.slice(0, 5)}`;
      return `<button class="period ${modeClass} ${compact ? "compact" : ""} ${carryover ? "carryover" : ""}" data-block-room="${esc(room._key)}" data-block-index="${index}" data-block-day="${sourceDay}" style="left:${this.minuteToPercent(start)}%;width:${displayWidth}%;--period-color:${periodColor}" title="${esc(this.modeLabel(mode))} ${resolvedTitle}" aria-label="Edit ${this.modeLabel(mode)} ${resolvedTitle}">${carryover ? `<ha-icon icon="mdi:arrow-right"></ha-icon>` : `<i class="resize-handle start" data-resize-edge="start" data-resize-room="${esc(room._key)}" data-resize-index="${index}" title="Drag to change start time"></i>`}<b>${label}</b>${detail && displayWidth >= 12 ? `<span>${detail}</span>` : ""}${carryover ? "" : `<i class="resize-handle end" data-resize-edge="end" data-resize-room="${esc(room._key)}" data-resize-index="${index}" title="Drag to change end time"></i>`}</button>`;
    }).join("");
    const now = new Date(); const today = DAYS[(now.getDay() + 6) % 7];
    const override = this.selectedDay === today ? this.overrideFor(room) : null;
    const overrideHtml = override ? (() => { const started = new Date(override.start || now); const finished = override.until ? new Date(override.until) : new Date(now.getTime() + 60 * 60 * 1000); const start = started.toDateString() === now.toDateString() ? started.getHours() * 60 + started.getMinutes() : 0; const end = finished.toDateString() === now.toDateString() ? finished.getHours() * 60 + finished.getMinutes() : 1440; const exactLeft = this.minuteToPercent(start); const exactWidth = Math.max(.35, this.minuteToPercent(end) - exactLeft); const width = Math.min(100, Math.max(12, exactWidth)); const left = Math.max(0, Math.min(100 - width, exactLeft - (width - exactWidth) / 2)); const kind = override.status === "boost_active" ? "boost" : "manual"; const value = override.temperature != null ? `${Number(override.temperature).toFixed(1)}°` : override.preset || (override.state ? String(override.state).toUpperCase() : ""); const lightDetail = override.brightness != null && override.state === "on" ? ` ${Math.round(Number(override.brightness) / 2.55)}%` : ""; const label = `${kind === "boost" ? "BOOST" : "MANUAL"}${value ? ` ${value}${lightDetail}` : ""}`; return `<div class="override-band ${kind}" style="left:${left}%;width:${width}%" title="${kind === "boost" ? "Boost" : "Manual change"}${value ? ` · ${value}${lightDetail}` : ""} until ${finished.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}">${kind === "boost" ? `<ha-icon icon="mdi:fire"></ha-icon>` : ""}<b>${label}</b></div>`; })() : "";
    const activeModeId = this.backendStatus?.cards?.[this.config.card_id]?.mode || "normal";
    const activeMode = (this.config.operating_modes || []).find((item) => item.id === activeModeId);
    const modeRule = activeMode?.schedules?.[room.group_id];
    const modeValue = modeRule?.action === "preset" ? `${this.modeLabel(modeRule.preset || "preset")} · ${Number(modeRule.temperature ?? 12).toFixed(1)}°C` : this.modeLabel(modeRule?.action);
    const modeHtml = activeModeId !== "normal" && modeRule?.action && modeRule.action !== "none" ? `<div class="mode-row-overlay" style="position:absolute;z-index:11;inset:4px;display:flex;align-items:center;justify-content:center;gap:8px;border:2px solid var(--warning-color,#f59e0b);border-radius:9px;background:linear-gradient(100deg,color-mix(in srgb,var(--warning-color,#f59e0b) 82%,#7c2d12),color-mix(in srgb,var(--warning-color,#f59e0b) 62%,#431407));box-shadow:inset 0 1px #ffffff55,0 3px 12px #0008;color:white;pointer-events:none"><ha-icon icon="${esc(activeMode.icon || "mdi:tune-variant")}" style="--mdc-icon-size:19px"></ha-icon><b style="font-size:13px;letter-spacing:.04em">${esc(activeMode.name)}: ${esc(modeValue)}</b></div>` : "";
    const marker = this.config.show_current_time !== false && this.selectedDay === today ? `<i class="now" aria-hidden="true" style="left:${this.minuteToPercent(now.getHours() * 60 + now.getMinutes())}%"></i>` : "";
    const emptyHint = activeBlocks.length ? "" : `<span class="empty-hint">${type === "climate" ? "Off all day" : "No action all day"} · tap to add a period</span>`;
    return `<div class="timeline ${this.timelineMode}" data-timeline="${esc(room._key)}">${gapHtml}${emptyHint}${blockHtml}${modeHtml}${overrideHtml}${marker}</div>`;
  }

  editor() {
    if (!this.editing || !this.config.show_editor) return "";
    const edit = this.editing;
    const type = roomType(edit.room, this.config.schedule_type);
    const controlledEntities = (edit.room.entities || [edit.room.entity].filter(Boolean)).map((entity) => {
      const state = this._hass?.states?.[entity];
      const name = state?.attributes?.friendly_name || entity;
      const icon = state?.attributes?.icon || this.profile(edit.room).icon;
      return `<li><ha-icon icon="${esc(icon)}"></ha-icon><span><b>${esc(name)}</b><small>${esc(entity)}</small></span></li>`;
    }).join("");
    const entityCount = (edit.room.entities || [edit.room.entity].filter(Boolean)).length;
    const entityList = `<details class="controlled-entities compact-disclosure"><summary>Entities <span>${entityCount}</span></summary><ul>${controlledEntities || "<li><span><b>No entities assigned</b></span></li>"}</ul></details>`;
    const modeOptions = this.profile(edit.room).modes.map((mode) => `<option value="${mode}" ${edit.mode === mode ? "selected" : ""}>${this.modeLabel(mode)}</option>`).join("");
    const modeButtons = this.profile(edit.room).modes.map((mode) => `<button class="mode-choice ${edit.mode === mode ? "active" : ""}" data-mode-choice="${esc(mode)}"><ha-icon icon="${mode === "comfort" ? "mdi:white-balance-sunny" : mode === "eco" ? "mdi:leaf" : mode === "on" ? "mdi:power" : mode === "off" ? "mdi:power-off" : "mdi:thermostat"}"></ha-icon><span>${esc(this.modeLabel(mode))}</span></button>`).join("");
    const gapPresetOptions = type === "climate" ? this.climatePresetModes(edit.room).map((mode) => `<option value="${esc(mode)}" ${mode === "away" ? "selected" : ""}>${esc(this.modeLabel(mode))}</option>`).join("") : "";
    const gapControls = type === "climate" ? `<div class="gap-fill"><label>Fill remaining gaps with<select data-fill-preset aria-label="Gap preset">${gapPresetOptions}</select></label><button ${edit.index>=0?"data-fill-gaps":"data-save-fill-gaps"}>${edit.index>=0?"Fill gaps":"Apply and fill gaps"}</button></div>` : "";
    const startOptions = timeSelectOptions(this.config.minimum_period, edit.from, false);
    const endOptions = timeSelectOptions(this.config.minimum_period, edit.to, true);
    const climateControls = type === "climate" ? `<label class="override"><span><input type="checkbox" data-override ${edit.override ? "checked" : ""}><b>Override preset temperature</b></span><small>${edit.override ? "This period uses its own setpoint." : `${this.modeLabel(edit.mode)} uses its Schedule Control preset temperature.`}</small></label><div class="target touch-target ${edit.override ? "" : "disabled"}"><span>Target temperature</span><div><button data-temp-step="-0.5" ${edit.override ? "" : "disabled"}>−</button><output>${Number(edit.target).toFixed(1)}°C</output><button data-temp-step="0.5" ${edit.override ? "" : "disabled"}>＋</button></div></div>` : "";
    const anchorOptions = (value) => `<option value="fixed" ${value === "fixed" ? "selected" : ""}>Fixed time</option><option value="sunset" ${value === "sunset" ? "selected" : ""}>Sunset</option><option value="sunrise" ${value === "sunrise" ? "selected" : ""}>Sunrise</option>`;
    const astronomicalControls = type === "light" && edit.mode === "on" ? `<details class="astro-controls"><summary><ha-icon icon="mdi:weather-sunset"></ha-icon> Sunrise / sunset timing</summary><div class="astro-grid"><label>Start basis<select data-edit="startAnchor">${anchorOptions(edit.startAnchor)}</select></label>${edit.startAnchor !== "fixed" ? `<label>Start offset<select data-edit="startOffset">${Array.from({length:25},(_,i)=>(i-12)*15).map((value)=>`<option value="${value}" ${Number(edit.startOffset)===value?"selected":""}>${value>0?"+":""}${value} min</option>`).join("")}</select></label>` : ""}<label>End basis<select data-edit="endAnchor">${anchorOptions(edit.endAnchor)}</select></label>${edit.endAnchor !== "fixed" ? `<label>End offset<select data-edit="endOffset">${Array.from({length:25},(_,i)=>(i-12)*15).map((value)=>`<option value="${value}" ${Number(edit.endOffset)===value?"selected":""}>${value>0?"+":""}${value} min</option>`).join("")}</select></label>` : ""}</div><small>Calculated daily from Home Assistant’s location. The clock times remain as fallback values.</small></details>` : "";
    const lightControls = type === "light" && edit.mode === "on" ? `<div class="light-controls">${astronomicalControls}${edit.supportsBrightness ? `<label>Brightness<input type="range" min="1" max="100" step="1" value="${edit.brightness}" data-edit="brightness"><output>${edit.brightness}%</output></label>` : ""}${edit.supportsColorTemp ? `<label>Colour temperature<input type="range" min="${edit.minKelvin}" max="${edit.maxKelvin}" step="50" value="${edit.colorTemp}" data-edit="colorTemp"><output>${edit.colorTemp} K</output></label>` : ""}${edit.supportsColor ? `<label>Colour<input type="color" value="${esc(edit.color)}" data-edit="color"></label>` : ""}${!edit.supportsBrightness && !edit.supportsColorTemp && !edit.supportsColor ? `<p class="capability-note">This light only exposes On/Off.</p>` : ""}</div>` : "";
    const dayChoices = DAYS.map((day) => day === this.selectedDay ? `<label class="check current-day"><input type="checkbox" disabled><span>${DAY_LABELS[day]} · current</span></label>` : `<label class="check"><input type="checkbox" data-copy-day="${day}" ${edit.copyDays?.includes(day) ? "checked" : ""}><span>${DAY_LABELS[day]}</span></label>`).join("");
       return `<aside class="period-editor touch-editor"><div class="editor-title"><div><small>${esc(edit.room._zone)} · ${DAY_LABELS[this.selectedDay]}</small><h2>${esc(edit.room.name || "Period")}</h2></div><button data-cancel aria-label="Close editor">×</button></div>${entityList}${this.editorError ? `<p class="error">${esc(this.editorError)}</p>` : ""}<div class="control-section action-section"><div class="mode-grid">${modeButtons}</div><select class="mode-fallback" data-edit="mode" aria-label="Action">${modeOptions}</select></div><div class="control-section time-section"><div class="time-grid"><label>Start<select data-edit="from" aria-label="Start time">${startOptions}</select></label><label>End<select data-edit="to" aria-label="End time">${endOptions}</select></label></div></div>${climateControls}${lightControls}<div class="editor-menu-row"><details class="editor-menu"><summary><ha-icon icon="mdi:calendar-multiple"></ha-icon> Copy to days</summary><fieldset class="day-pills">${dayChoices}</fieldset></details><details class="editor-menu"><summary><ha-icon icon="mdi:dots-horizontal"></ha-icon> Actions</summary><div class="action-popout">${gapControls}${edit.index >= 0 ? `<button class="danger" data-delete><ha-icon icon="mdi:trash-can-outline"></ha-icon> Delete period</button>` : ""}</div></details></div><div class="editor-actions"><button class="save" data-save><ha-icon icon="mdi:check-circle-outline"></ha-icon>Apply</button></div></aside>`;
  }

  healthSummary() {
    const issues = [];
    if (!this.backendConnected) issues.push("Schedule Control backend is disconnected");
    for (const room of this.allRooms()) {
      const name = room.name || room.entity || "Schedule";
      for (const entity of room.entities || [room.entity].filter(Boolean)) {
        const state = this._hass?.states?.[entity];
        if (!state || ["unavailable", "unknown"].includes(state.state)) issues.push(`${name}: ${entity} is unavailable`);
      }
      const prefix = `${this.config.card_id}:${room.group_id || room._key}:`;
      for (const [mappingId, status] of Object.entries(this.backendStatus?.status || {})) {
        if (!mappingId.startsWith(prefix)) continue;
        if (status === "error") issues.push(`${name}: the last action failed`);
        else if (status === "unavailable") issues.push(`${name}: schedule or target unavailable`);
      }
      if (room.enabled !== false && room.schedule && !this.scheduleFor(room)) issues.push(`${name}: saved schedule unavailable`);
    }
    const controllers = new Map();
    for (const room of this.allRooms()) {
      if (room.enabled === false) continue;
      for (const entity of room.entities || [room.entity].filter(Boolean)) {
        const names = controllers.get(entity) || [];
        names.push(room.name || entity);
        controllers.set(entity, names);
      }
    }
    for (const [entity, names] of controllers) {
      if (names.length > 1) issues.push(`${entity} is controlled by multiple schedules: ${[...new Set(names)].join(", ")}`);
    }
    const backendTargets = new Map();
    for (const [mappingId, mapping] of Object.entries(this.backendStatus?.mappings || {})) {
      if (!mapping?.target) continue;
      const ids = backendTargets.get(mapping.target) || [];
      ids.push(mappingId);
      backendTargets.set(mapping.target, ids);
    }
    for (const [entity, ids] of backendTargets) {
      if (ids.length > 1) issues.push(`${entity} has ${ids.length} active backend controllers`);
    }
    const ownedTargets = new Map();
    for (const [cardId, card] of Object.entries(this.backendStatus?.cards || {})) {
      for (const group of Object.values(card?.groups || {})) {
        for (const entity of group?.targets || []) {
          const owners = ownedTargets.get(entity) || [];
          owners.push(`${group.name || "Schedule"} (${cardId})`);
          ownedTargets.set(entity, owners);
        }
      }
    }
    for (const [entity, owners] of ownedTargets) {
      if (owners.length > 1) issues.push(`${entity} is assigned more than once: ${[...new Set(owners)].join(", ")}`);
    }
    return { issues: [...new Set(issues)], state: issues.length ? "warning" : "healthy" };
  }

  overrideFor(room) {
    // Schedule Control boosts are owned by the card/group.  They must remain
    // visible even while entity mappings are being created or reconciled.
    const cardBoost = this.backendStatus?.cards?.[this.config.card_id]?.boosts?.[room.group_id];
    if (cardBoost) {
      const until = cardBoost.until ? new Date(cardBoost.until) : null;
      if (!until || Number.isNaN(until.getTime()) || until.getTime() > Date.now()) {
        return { status: "boost_active", ...cardBoost };
      }
    }
    const prefix = `${this.config.card_id}:${room.group_id || room._key}:`;
    const entries = Object.entries(this.backendStatus?.status || {}).filter(([mappingId]) => mappingId.startsWith(prefix));
    const selected = entries.find(([,status]) => status === "boost_active") || entries.find(([,status]) => status === "manual_override");
    if (!selected) return null;
    const [mappingId, status] = selected;
    return { status, ...(this.backendStatus?.override_info?.[mappingId] || {}) };
  }

  render() {
    if (!this.shadowRoot) return;
    if (!this.config) { this.shadowRoot.innerHTML = ""; return; }
    const zones = (this.config.groups || []).map((group, groupIndex) => `<section><h2><ha-icon icon="mdi:home-outline"></ha-icon>${esc(group.name)}</h2><div class="schedule-list">${(group.schedules || []).map((room, roomIndex) => { const item = { ...room, _key: `${groupIndex}:${roomIndex}`, _zone: group.name }; const profile = this.profile(item); const entities = room.entities || [room.entity].filter(Boolean); const entityNames = entities.map((id) => this._hass?.states?.[id]?.attributes?.friendly_name || id); const temperatures = entities.map((id) => Number(this._hass?.states?.[id]?.attributes?.current_temperature)).filter(Number.isFinite); const liveTemperature = temperatures.length ? `${temperatures.length > 1 ? "Avg " : ""}${(temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length).toFixed(1)}°` : ""; const boostActive = Boolean(this.backendStatus?.cards?.[this.config.card_id]?.boosts?.[room.group_id]); const boostEnabled = roomType(room) === "climate" && room.native_boost?.enabled !== false; return `<div class="room ${room.enabled === false ? "schedule-paused" : ""}"><div class="room-name"><ha-icon icon="${esc(room.enabled === false ? "mdi:pause-circle-outline" : room.icon || profile.icon)}"></ha-icon><span><b><span class="room-label-text">${esc(room.name || entityNames[0] || profile.label)}</span>${liveTemperature ? `<span class="room-temperature" title="Current temperature">${liveTemperature}</span>` : ""}</b>${room.enabled === false ? "<small>Paused</small>" : ""}</span><button class="manage-button" data-manage-schedule="${item._key}" title="Edit, pause or remove device row" aria-label="Edit ${esc(room.name || "device row")}">⋮</button></div><span class="row-boost-slot">${boostEnabled ? `<button class="quick-boost ${boostActive ? "active" : ""}" data-quick-boost="${item._key}" title="${boostActive ? "Cancel boost" : "Start boost"}" aria-label="${boostActive ? "Cancel" : "Start"} ${esc(room.name || "device row")} boost"><ha-icon icon="mdi:fire"></ha-icon></button>` : ""}</span>${this.timeline(item)}</div>`; }).join("")}</div></section>`).join("");
    const hotWater = this.config.hot_water ? `<section class="hot"><h2>Hot Water</h2><div class="room"><div class="room-name"><ha-icon icon="mdi:water-boiler"></ha-icon><span><b>${esc(this.config.hot_water.name || "Hot Water")}</b><small>${esc(this._hass?.states?.[this.config.hot_water.entity]?.state || "Unavailable")}</small></span></div>${this.timeline({ ...this.config.hot_water, _key: "__hot_water", _zone: "Hot Water", hot_water: true })}</div></section>` : "";
    const backend = this.backendConnected || this._hass?.states?.["sensor.schedule_control_status"];
    const summary = this.scheduleSummary();
    const health = this.healthSummary();
    const cardMode = this.backendStatus?.cards?.[this.config.card_id]?.mode || "normal";
    const activeMode = (this.config.operating_modes || []).find((item) => item.id === cardMode);
    const modeChoices = [{ id: "normal", name: "Normal", icon: "mdi:calendar-clock" }, ...(this.config.operating_modes || [])];
    const modeControl = `<details class="top-mode"><summary><ha-icon icon="${esc(activeMode?.icon || "mdi:calendar-clock")}"></ha-icon><span><small>Mode</small><b>${esc(activeMode?.name || "Normal")}</b></span><ha-icon icon="mdi:chevron-down"></ha-icon></summary><div class="mode-popout">${modeChoices.map((mode) => `<button data-card-mode="${esc(mode.id)}" class="${cardMode === mode.id ? "active" : ""}" ${this._changingMode ? "disabled" : ""}><ha-icon icon="${esc(mode.icon)}"></ha-icon><span>${esc(mode.name)}</span>${cardMode === mode.id ? `<ha-icon icon="mdi:check-circle"></ha-icon>` : ""}</button>`).join("")}</div></details>`;
    const timelineTools = `<div class="timeline-tools"><div class="view-switch"><button data-view-overview class="${this.timelineMode === "overview" ? "active" : ""}">24h</button><button data-view-focus class="${this.timelineMode === "focus" ? "active" : ""}">6h</button></div><button data-view-now title="Centre on current time"><ha-icon icon="mdi:crosshairs-gps"></ha-icon><span>Now</span></button></div>`;
    const status = this.config.show_status ? `<div class="status-strip"><button class="chip health ${health.state}" data-health title="Open schedule health"><ha-icon icon="${health.state === "healthy" ? "mdi:check-circle-outline" : "mdi:alert-circle-outline"}"></ha-icon><b>${health.state === "healthy" ? "All schedules healthy" : `${health.issues.length} issue${health.issues.length === 1 ? "" : "s"}`}</b></button>${modeControl}<span class="chip current"><ha-icon icon="mdi:progress-clock"></ha-icon>Now: <b>${cardMode !== "normal" ? esc(activeMode?.name || cardMode) : esc(summary.current)}</b></span><span class="chip next"><ha-icon icon="mdi:clock-outline"></ha-icon>Next: <b>${cardMode !== "normal" ? "Mode active" : esc(summary.next)}</b></span>${timelineTools}</div>${this.healthOpen ? `<div class="health-panel"><header><b>Schedule health</b><button data-health-close aria-label="Close">×</button></header>${health.issues.length ? `<ul>${health.issues.map((issue)=>`<li><ha-icon icon="mdi:alert-outline"></ha-icon>${esc(issue)}</li>`).join("")}</ul>` : `<p><ha-icon icon="mdi:check-circle-outline"></ha-icon> Backend connected and all configured entities are available.</p>`}</div>` : ""}` : "";
    const dirty = this.dirtyGroups?.size || 0;
    const draftBar = dirty ? `<div class="draft-bar"><span><b>${dirty} unsaved schedule${dirty === 1 ? "" : "s"}</b><small>Changes are only a draft until saved.</small></span><button data-discard-all>Discard</button><button class="save" data-save-all>${this._savingDrafts ? "Saving…" : "Save schedules"}</button></div>` : "";
    const colors = this.config.colors || {};
    const selectedTheme = this.config.theme && this._hass?.themes?.themes?.[this.config.theme] || {};
    const themeStyle = Object.entries(selectedTheme).filter(([,value]) => ["string","number"].includes(typeof value)).map(([key,value]) => `--${key}:${value}`).join(";");
    const colorStyle = `${themeStyle};--comfort:${safeColor(colors.comfort, "#d97706")};--eco:${safeColor(colors.eco, "#477a45")};--away:${safeColor(colors.away, "#7c3aed")};--on:${safeColor(colors.on, "#2563eb")};--off:${safeColor(colors.off, "#34465b")};--now:${safeColor(colors.now, "#22d3ee")}`;
    const today = DAYS[(new Date().getDay() + 6) % 7];
    const current = new Date();
    const nowMinute = current.getHours() * 60 + current.getMinutes();
    const nowPercent = this.minuteToPercent(nowMinute);
    const nowEdge = nowPercent < 5 ? "edge-left" : nowPercent > 95 ? "edge-right" : "";
    const nowBadge = this.config.show_current_time !== false && this.selectedDay === today ? `<i class="now-badge ${nowEdge}" style="left:${nowPercent}%">${String(current.getHours()).padStart(2,"0")}:${String(current.getMinutes()).padStart(2,"0")}</i>` : "";
    const focus = this.focusBounds();
    const tickMinutes = this.timelineMode === "focus" ? [...new Set([0, focus.start, ...Array.from({length:7},(_,i)=>focus.start+i*60), focus.end, 1440])] : Array.from({length:9},(_,i)=>i*180);
    const hourTicks = tickMinutes.sort((a,b)=>a-b).map((minute)=>`<span style="left:${this.minuteToPercent(minute)}%">${minutesToTime(minute).slice(0,5)}</span>`).join("");
    const sunState = this._hass?.states?.["sun.sun"];
    const sunMarkers = this.config.show_astronomical_markers ? [["next_rising", "mdi:weather-sunset-up", "Sunrise"], ["next_setting", "mdi:weather-sunset-down", "Sunset"]].map(([attribute, icon, label]) => { const value = new Date(sunState?.attributes?.[attribute]); if (Number.isNaN(value.getTime())) return ""; const minute = value.getHours() * 60 + value.getMinutes(); return `<ha-icon class="astro-ruler-marker" icon="${icon}" style="left:${this.minuteToPercent(minute)}%" title="${label} ${String(value.getHours()).padStart(2,"0")}:${String(value.getMinutes()).padStart(2,"0")}"></ha-icon>`; }).join("") : "";
    this.shadowRoot.innerHTML = `<style>${CARD_CSS}${CARD_COMPACT_CSS}</style><ha-card style="${colorStyle}"><header><div class="title"><ha-icon icon="mdi:calendar-clock"></ha-icon><h1>${esc(this.config.title)}</h1></div><div class="history ${dirty ? "" : "editing-history-hidden"}"><button data-undo ${this.undoStack?.length ? "" : "disabled"} title="Undo draft change">↶ <span>Undo</span></button><button data-redo ${this.redoStack?.length ? "" : "disabled"} title="Redo draft change">↷ <span>Redo</span></button></div></header>${status}${draftBar}<nav><button class="today ${this.selectedDay === today ? "selected" : ""}" data-today><ha-icon icon="mdi:calendar-today"></ha-icon><span>Today</span></button>${DAYS.map((day) => `<button data-day="${day}" class="${day === this.selectedDay ? "selected" : ""}">${DAY_LABELS[day]}</button>`).join("")}</nav><div class="layout"><main>${this.error ? `<p class="error">${esc(this.error)}</p>` : ""}${this.saveError ? `<p class="error">${esc(this.saveError)}</p>` : ""}<div class="hours" data-time-ruler>${hourTicks}${sunMarkers}${nowBadge}</div>${zones}${hotWater}</main>${this.editor()}</div>${this.boostPicker()}</ha-card>`;
    const topMode = this.shadowRoot.querySelector(".top-mode");
    if (topMode) this.shadowRoot.querySelector("header .history")?.before(topMode);
    if (cardMode !== "normal") {
      const affected = Object.values(activeMode?.schedules || {}).filter((rule) => rule?.action && rule.action !== "none").length;
      this.shadowRoot.querySelector("ha-card>header")?.insertAdjacentHTML("afterend", `<style>.mode-active-banner{display:grid;grid-template-columns:38px 1fr auto;align-items:center;gap:12px;margin:0 0 10px;padding:11px 14px;border:2px solid var(--warning-color,#f59e0b);border-radius:14px;background:linear-gradient(100deg,color-mix(in srgb,var(--warning-color,#f59e0b) 28%,var(--card-background-color)),color-mix(in srgb,var(--warning-color,#f59e0b) 10%,var(--card-background-color)));box-shadow:0 5px 18px color-mix(in srgb,var(--warning-color,#f59e0b) 22%,transparent)}.mode-active-banner>ha-icon{--mdc-icon-size:30px;color:var(--warning-color,#f59e0b)}.mode-active-banner span{display:flex;flex-direction:column}.mode-active-banner b{font-size:16px;letter-spacing:.06em}.mode-active-banner small{color:var(--secondary-text-color)}.mode-active-banner button{min-height:42px;padding:0 14px;border:1px solid var(--warning-color,#f59e0b);border-radius:10px;background:var(--secondary-background-color);color:var(--primary-text-color);font-weight:750}@media(max-width:650px){.mode-active-banner{grid-template-columns:32px 1fr}.mode-active-banner button{grid-column:1/-1}}</style><div class="mode-active-banner"><ha-icon icon="${esc(activeMode?.icon || "mdi:tune-variant")}"></ha-icon><span><b>${esc(activeMode?.name || cardMode)} MODE ACTIVE</b><small>${affected} schedule${affected === 1 ? "" : "s"} overridden · Boost remains available</small></span><button data-card-mode="normal">Return to Normal</button></div>`);
    }
    if (this.creatingGroup) this.shadowRoot.querySelector(".layout")?.insertAdjacentHTML("beforeend", this.createGroupPanel());
    if (this.copyingDay) this.shadowRoot.querySelector(".layout")?.insertAdjacentHTML("beforeend", this.copyDayPanel());
    if (this.managingSchedule) this.shadowRoot.querySelector(".layout")?.insertAdjacentHTML("beforeend", this.scheduleManager());
    const extraStyle = document.createElement("style");
    extraStyle.textContent = `${EXTRA_CARD_CSS}${PRESET_CARD_CSS}${SOFT_CARD_CSS}${COMPOSED_ROW_CSS}${SCHEDULE_BUBBLE_CSS}${TOUCH_EDITOR_CSS}${COMPACT_TOUCH_EDITOR_CSS}${WIDE_TOUCH_EDITOR_CSS}${WIDE_CREATE_EDITOR_CSS}${CONSISTENT_EDITOR_WIDTH_CSS}${FOCUS_TIMELINE_CSS}${STATUS_VIEW_CSS}${CARD_MODE_CSS}${TOP_MODE_CSS}${COMPACT_DAY_CSS}${DEFINED_RULER_CSS}${NEUTRAL_RULER_CSS}${ASTRO_HEALTH_CSS}${ASTRO_MARKER_CSS}${OVERRIDE_BAND_CSS}${MANUAL_BAND_CSS}${ENTITY_PICKER_CSS}${CLIMATE_CREATE_CSS}${BOOST_PICKER_CSS}${RESIZE_FIX_CSS}${BOOST_PLACEMENT_CSS}${ROUTINE_WIZARD_CSS}${LIVE_INDICATOR_CSS}${DAILY_CONTROL_CSS}${RESPONSIVE_FINISH_CSS}${CARD_COMPACT_CSS}${FINAL_ROW_CSS}${BULK_SETUP_CSS}${MODE_RESPONSIVE_CSS}${ROW_NAME_CSS}`;
    this.shadowRoot.prepend(extraStyle);
    const modeLayoutFix = document.createElement("style");
    modeLayoutFix.textContent = `.status-strip{grid-template-columns:auto minmax(120px,.55fr) minmax(190px,1fr) auto!important}.mode-row-overlay{z-index:7!important}`;
    this.shadowRoot.prepend(modeLayoutFix);
    this.bindEvents();
  }
}

const CARD_COMPACT_CSS = `ha-card{padding:7px 10px}ha-card>header h1{font-size:23px}.status-strip{margin:3px 0 2px;gap:6px}.chip{min-height:24px;padding:1px 9px}ha-card>nav{margin:2px 0 4px;gap:6px}ha-card>nav button{min-height:32px}.hours{min-height:23px}section{padding:3px 5px;margin-bottom:3px;border-radius:12px}section>h2{min-height:20px;margin:0 0 1px;font-size:13px}.room{min-height:36px!important;padding:1px!important;gap:5px!important}.room-label{min-height:32px!important;padding-block:2px!important}.room-label small{display:none}.timeline{height:31px!important;min-height:31px!important}.period,.off-gap{top:1px!important;height:29px!important}.period{font-size:11px}.period small{font-size:10px}.boost-button{width:32px!important;height:32px!important;min-height:32px!important}`;

const CARD_CSS = `:host{display:block;--comfort:#d97706;--eco:#477a45;--off:#34465b;--on:#2563eb;--boost:#7c3aed;color:var(--primary-text-color)}*{box-sizing:border-box}ha-card{padding:16px;background:linear-gradient(135deg,color-mix(in srgb,var(--ha-card-background,var(--card-background-color)) 92%,#06213a),var(--ha-card-background,var(--card-background-color)));border:1px solid var(--divider-color);overflow:hidden}header{display:flex;justify-content:space-between;align-items:center;gap:12px}h1{font-size:28px;margin:0}.status-strip{display:flex;flex-wrap:wrap;gap:6px;margin:7px 0 4px}.chip{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:3px 9px;border:1px solid var(--divider-color);border-radius:999px;background:color-mix(in srgb,var(--card-background-color) 84%,#10243a);color:var(--secondary-text-color);font-size:12px}.chip b{color:var(--primary-text-color)}.chip i{width:8px;height:8px;border-radius:50%;background:#f59e0b}.chip.connected i{background:#22c55e}.history{display:flex;gap:6px}.history button{min-height:40px;padding:0 12px;border:1px solid var(--divider-color);border-radius:9px;background:var(--secondary-background-color);color:var(--primary-text-color)}.history button:disabled{opacity:.35}.history button:not(:disabled){cursor:pointer}nav{display:grid;grid-template-columns:repeat(7,1fr);gap:7px;margin:6px 0 12px}button,input,select{font:inherit}nav button,.create{min-height:44px;border:1px solid var(--divider-color);border-radius:10px;background:color-mix(in srgb,var(--card-background-color) 82%,#10243a);color:var(--primary-text-color);cursor:pointer}.selected,.save{background:var(--primary-color)!important;color:var(--text-primary-color)!important}.layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px}.layout:not(:has(.period-editor)){grid-template-columns:1fr}main{min-width:0}.hours{margin-left:174px;display:flex;justify-content:space-between;color:var(--secondary-text-color);font-size:12px;padding:0 2px}section{border:1px solid var(--divider-color);border-radius:12px;padding:8px;margin-bottom:9px;background:color-mix(in srgb,var(--card-background-color) 88%,transparent)}section>h2{font-size:15px;color:var(--primary-color);margin:0 0 5px}.room{display:grid;grid-template-columns:160px minmax(0,1fr);gap:7px;align-items:center;min-height:50px;border-top:1px solid color-mix(in srgb,var(--divider-color) 60%,transparent)}.room-name{display:flex;gap:8px;align-items:center}.room-name ha-icon{color:var(--secondary-text-color)}.room-name span{display:flex;flex-direction:column;min-width:0}.room-name small{color:var(--secondary-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.timeline{height:42px;position:relative;border-radius:8px;overflow:hidden;cursor:crosshair;background:repeating-linear-gradient(90deg,color-mix(in srgb,var(--divider-color) 22%,transparent) 0,color-mix(in srgb,var(--divider-color) 22%,transparent) 1px,transparent 1px,transparent 12.5%)}.off-gap{position:absolute;top:2px;height:38px;display:grid;place-items:center;pointer-events:none;background:color-mix(in srgb,var(--secondary-background-color) 78%,#111827);border-right:1px solid color-mix(in srgb,var(--divider-color) 70%,transparent);color:color-mix(in srgb,var(--secondary-text-color) 80%,transparent);font-size:10px;font-weight:700;letter-spacing:.12em}.period{position:absolute;top:2px;height:38px;border:1px solid #ffffff33;border-radius:7px;color:#fff;cursor:pointer;overflow:hidden;display:flex;justify-content:center;align-items:center;gap:5px;min-width:3px}.period.comfort{background:var(--comfort)}.period.eco{background:var(--eco)}.period.on{background:var(--on)}.period.off{background:var(--off)}.period span{font-size:12px}.period.compact{font-size:12px;padding:0 2px}.now{position:absolute;z-index:3;top:0;bottom:0;width:2px;background:#22d3ee;box-shadow:0 0 6px #22d3ee}.missing,.create{height:42px;display:flex;align-items:center;justify-content:center;color:var(--secondary-text-color)}.period-editor{border:1px solid var(--divider-color);border-radius:14px;padding:14px;background:var(--card-background-color);align-self:start}.editor-title{display:flex;justify-content:space-between;align-items:start}.editor-title h2{margin:0}.editor-title small{color:var(--secondary-text-color)}.editor-title button{border:0;background:transparent;color:var(--primary-text-color);font-size:28px;min-width:44px;min-height:44px}.period-editor label{display:grid;gap:5px;margin:12px 0;color:var(--secondary-text-color)}.period-editor input,.period-editor select{min-height:48px;border:1px solid var(--divider-color);border-radius:9px;padding:8px 10px;background:var(--secondary-background-color);color:var(--primary-text-color)}.period-editor input[type=color]{width:100%;padding:5px}.period-editor input[type=range]{min-height:32px;padding:0}.light-controls{border-top:1px solid var(--divider-color);margin-top:10px}.capability-note{color:var(--secondary-text-color)}.period-editor .override{padding:10px;border:1px solid var(--divider-color);border-radius:9px}.period-editor .override span{display:flex;align-items:center;gap:8px;color:var(--primary-text-color)}.period-editor .override input{min-height:auto}.period-editor .override small{color:var(--secondary-text-color)}.period-editor .target.disabled{opacity:.45}.time-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.period-editor fieldset{border:1px solid var(--divider-color);border-radius:9px}.period-editor .check{display:inline-flex;align-items:center;gap:5px;margin:3px 7px}.period-editor .check input{min-height:auto}.editor-actions{display:flex;gap:8px;margin-top:14px}.editor-actions button{min-height:48px;border:0;border-radius:9px;padding:0 14px;flex:1}.danger{background:#7f1d1d;color:#fff}.error{color:var(--error-color);background:color-mix(in srgb,var(--error-color) 15%,transparent);padding:8px;border-radius:8px}@media(max-width:1000px){.layout{grid-template-columns:1fr}.period-editor{position:sticky;bottom:8px}.room{grid-template-columns:125px minmax(0,1fr)}.hours{margin-left:139px}.period b{font-size:12px}.period span{display:none}}@media(max-width:650px){header{align-items:flex-start}.history span{display:none}.history button{min-width:42px;padding:0}.chip{font-size:11px}}`;

const EXTRA_CARD_CSS = `.draft-bar{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;margin:10px 0;padding:9px 10px;border:1px solid color-mix(in srgb,var(--primary-color) 55%,var(--divider-color));border-radius:10px;background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))}.draft-bar span{display:flex;flex-direction:column}.draft-bar small{color:var(--secondary-text-color)}.draft-bar button{min-height:42px;padding:0 14px;border:1px solid var(--divider-color);border-radius:8px;background:var(--secondary-background-color);color:var(--primary-text-color)}.empty-hint{position:absolute;inset:0;z-index:1;display:grid;place-items:center;pointer-events:none;color:var(--secondary-text-color);font-size:12px}.resize-handle{position:absolute;z-index:4;top:0;bottom:0;width:20px;touch-action:none;cursor:ew-resize}.resize-handle::after{content:"";position:absolute;top:8px;bottom:8px;width:3px;border-radius:3px;background:#ffffff99}.resize-handle.start{left:0}.resize-handle.start::after{left:4px}.resize-handle.end{right:0}.resize-handle.end::after{right:4px}.controlled-entities{margin:12px 0;padding:9px;border:1px solid var(--divider-color);border-radius:9px;background:color-mix(in srgb,var(--secondary-background-color) 65%,transparent)}.controlled-entities>small{color:var(--secondary-text-color);font-weight:600}.controlled-entities ul{display:grid;gap:6px;margin:7px 0 0;padding:0;list-style:none}.controlled-entities li{display:flex;align-items:center;gap:8px;min-width:0}.controlled-entities ha-icon{flex:0 0 auto;color:var(--secondary-text-color)}.controlled-entities li span{display:flex;flex-direction:column;min-width:0}.controlled-entities li b,.controlled-entities li small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.controlled-entities li small{color:var(--secondary-text-color);font-size:11px}.gap-fill{display:grid;grid-template-columns:1fr;gap:7px;margin:10px 0;padding:10px;border:1px solid color-mix(in srgb,var(--primary-color) 45%,var(--divider-color));border-radius:10px;background:color-mix(in srgb,var(--primary-color) 9%,var(--card-background-color))}.gap-fill div{display:flex;flex-direction:column}.gap-fill small{color:var(--secondary-text-color);line-height:1.35}.gap-fill select,.gap-fill button{min-height:44px;border:1px solid var(--divider-color);border-radius:8px;padding:7px;background:var(--secondary-background-color);color:var(--primary-text-color)}.gap-fill button{background:color-mix(in srgb,var(--primary-color) 22%,var(--secondary-background-color));cursor:pointer}ha-card{border-radius:18px!important;box-shadow:0 12px 32px #00000026}section{border-color:color-mix(in srgb,var(--primary-text-color) 18%,var(--divider-color))!important;border-radius:14px!important;padding:10px!important;box-shadow:inset 0 1px #ffffff0a,0 4px 14px #00000012}section>h2{font-size:16px!important;margin-bottom:7px!important}.room{min-height:58px!important}.room-name b{font-size:15px}.timeline{height:50px!important;border:1px solid color-mix(in srgb,var(--primary-text-color) 16%,var(--divider-color));border-radius:10px!important;background-image:repeating-linear-gradient(90deg,color-mix(in srgb,var(--primary-text-color) 8%,transparent) 0,color-mix(in srgb,var(--primary-text-color) 8%,transparent) 1px,transparent 1px,transparent 4.166667%),repeating-linear-gradient(90deg,color-mix(in srgb,var(--primary-text-color) 16%,transparent) 0,color-mix(in srgb,var(--primary-text-color) 16%,transparent) 2px,transparent 2px,transparent 12.5%)!important}.off-gap,.period{top:3px!important;height:42px!important}.period{border-radius:8px!important;border-color:#ffffff55!important;box-shadow:inset 0 1px #ffffff35,0 3px 8px #00000035;font-size:13px}.period.comfort{background:linear-gradient(135deg,#f59e0b,#c96805)!important}.period.eco{background:linear-gradient(135deg,#65a765,#356b3c)!important}.period.on{background:linear-gradient(135deg,#3b82f6,#1d4ed8)!important}.hours{margin-bottom:4px!important}.hours span{font-size:11px;transform:translateX(-50%)}.hours span:first-child{transform:none}.hours span:last-child{transform:translateX(0)}.now{overflow:visible!important;z-index:7!important}.now span{position:absolute;top:2px;left:4px;padding:2px 5px;border-radius:5px;background:#0891b2;color:#fff;font-style:normal;font-size:10px;font-weight:700;letter-spacing:.02em;box-shadow:0 2px 6px #0008;white-space:nowrap}.copy-day-editor fieldset{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}.copy-day-editor .check{min-height:42px;margin:0}.copy-day-editor .create-submit{width:100%;min-height:48px;border:0;border-radius:9px}@media(max-width:650px){.draft-bar{grid-template-columns:1fr 1fr}.draft-bar span{grid-column:1/-1}.history{flex-wrap:wrap;justify-content:flex-end}.history button{min-width:42px;padding:0 8px}.hours span:nth-child(even){display:none}}`;

const PRESET_CARD_CSS = `.period.dynamic-preset,.period.on{background:linear-gradient(135deg,color-mix(in srgb,var(--period-color) 82%,white),color-mix(in srgb,var(--period-color) 86%,black))!important}.off-gap{background:color-mix(in srgb,var(--off) 26%,var(--secondary-background-color))!important}.now{background:var(--now)!important;box-shadow:0 0 9px var(--now)!important}.now span{background:color-mix(in srgb,var(--now) 78%,#003b4b)!important}.manage-button{margin-left:auto;flex:0 0 38px;width:38px;height:42px;border:1px solid transparent;border-radius:12px;background:transparent;color:var(--secondary-text-color);font-size:24px;cursor:pointer}.manage-button:hover{border-color:var(--divider-color);background:var(--secondary-background-color);color:var(--primary-text-color)}.manage-entity{display:grid;grid-template-columns:minmax(0,1fr) 44px;gap:6px;margin-top:7px}.manage-entity select,.manage-entity button,.controlled-entities>button{min-height:46px;border:1px solid var(--divider-color);border-radius:11px;background:var(--secondary-background-color);color:var(--primary-text-color)}.controlled-entities>button{margin-top:8px;padding:0 12px}
ha-card{background:var(--ha-card-background,var(--card-background-color))!important;border-color:color-mix(in srgb,var(--primary-text-color) 14%,transparent)!important}.title{display:flex;align-items:center;gap:12px}.title>ha-icon{--mdc-icon-size:32px;color:var(--primary-color)}header{margin-bottom:10px}.status-strip{display:grid!important;grid-template-columns:auto minmax(190px,1fr) minmax(190px,1fr);gap:8px!important;margin:0 0 12px!important}.chip{min-height:44px!important;border-radius:12px!important;padding:7px 13px!important;background:color-mix(in srgb,var(--secondary-background-color) 72%,transparent)!important;font-size:13px!important}.chip ha-icon{--mdc-icon-size:20px;color:var(--primary-color)}.chip.connected ha-icon{color:#22c55e}.chip.current ha-icon{color:#f59e0b}.chip.next ha-icon{color:var(--primary-color)}nav{grid-template-columns:1.15fr repeat(7,1fr)!important;border-radius:14px;padding:4px;background:color-mix(in srgb,var(--secondary-background-color) 50%,transparent)}nav button{border-color:transparent!important;background:transparent!important;border-radius:10px!important}.today{display:flex;align-items:center;justify-content:center;gap:7px;color:var(--primary-color)!important}.today ha-icon{--mdc-icon-size:20px}.selected{background:var(--primary-color)!important;color:var(--text-primary-color)!important;box-shadow:0 4px 14px color-mix(in srgb,var(--primary-color) 35%,transparent)}section{padding:0 10px 9px!important;border-radius:16px!important;background:color-mix(in srgb,var(--secondary-background-color) 32%,transparent)!important;box-shadow:none!important}section>h2{display:flex;align-items:center;min-height:40px;margin:0!important;padding:0 2px;border-bottom:1px solid color-mix(in srgb,var(--divider-color) 65%,transparent);font-size:15px!important;letter-spacing:.01em}.room{grid-template-columns:170px minmax(0,1fr)!important;min-height:62px!important;border-top:0!important;border-bottom:1px solid color-mix(in srgb,var(--divider-color) 42%,transparent)}.room:last-child{border-bottom:0}.room-name{gap:10px!important}.room-name>ha-icon{--mdc-icon-size:24px}.room-name b{font-size:16px!important}.room-name small{font-size:12px}.timeline{height:48px!important;border:0!important;border-radius:12px!important;overflow:visible!important;background-color:color-mix(in srgb,var(--secondary-background-color) 62%,transparent)!important}.off-gap,.period{top:3px!important;height:42px!important;border-radius:9px!important}.off-gap{border:2px solid var(--card-background-color)!important;color:color-mix(in srgb,var(--secondary-text-color) 70%,transparent)!important}.period{border:2px solid var(--card-background-color)!important;box-shadow:inset 0 1px #ffffff40,0 3px 8px #00000026!important}.period b{font-size:13px}.period span{font-size:11px}.resize-handle::after{opacity:.7}.period-editor{border-radius:18px!important;padding:17px!important;box-shadow:0 14px 36px #0005}.period-editor .editor-title{padding-bottom:12px;border-bottom:1px solid var(--divider-color)}.period-editor input,.period-editor select{border-radius:12px!important}.editor-actions button{border-radius:12px!important}.missing.warning{width:100%;border:1px solid color-mix(in srgb,var(--warning-color,#f59e0b) 55%,var(--divider-color));border-radius:12px;background:color-mix(in srgb,var(--warning-color,#f59e0b) 10%,var(--secondary-background-color));color:var(--warning-color,#f59e0b);display:flex;align-items:center;justify-content:center;gap:7px;cursor:pointer}.missing.warning small{color:var(--secondary-text-color)}
@media(max-width:1050px){.status-strip{grid-template-columns:1fr 1fr}.chip.connected{grid-column:1/-1}.room{grid-template-columns:145px minmax(0,1fr)!important}.today span{display:none}}@media(max-width:700px){.status-strip{grid-template-columns:1fr}.chip.connected{grid-column:auto}nav{grid-template-columns:44px repeat(7,1fr)!important}.room{grid-template-columns:118px minmax(0,1fr)!important}.room-name b{font-size:14px!important}}`;

const SOFT_CARD_CSS = `ha-card{position:relative;background:linear-gradient(145deg,color-mix(in srgb,var(--ha-card-background,var(--card-background-color)) 94%,#09233b),color-mix(in srgb,var(--ha-card-background,var(--card-background-color)) 97%,#030a12))!important;box-shadow:0 18px 45px #0004,inset 0 1px #ffffff0c!important}section{background:linear-gradient(145deg,color-mix(in srgb,var(--secondary-background-color) 50%,transparent),color-mix(in srgb,var(--card-background-color) 82%,transparent))!important;border-color:color-mix(in srgb,var(--primary-color) 15%,var(--divider-color))!important;box-shadow:inset 0 1px #ffffff08,0 8px 24px #00000018!important}.timeline{background:linear-gradient(180deg,color-mix(in srgb,var(--secondary-background-color) 76%,#17304a),color-mix(in srgb,var(--secondary-background-color) 88%,#050a11))!important;box-shadow:inset 0 1px #ffffff0c,inset 0 -1px #0006}.period.dynamic-preset,.period.on{isolation:isolate;background:linear-gradient(155deg,color-mix(in srgb,var(--period-color) 86%,white 14%),color-mix(in srgb,var(--period-color) 82%,#07111d))!important;border:1px solid color-mix(in srgb,var(--period-color) 72%,white 28%)!important;box-shadow:inset 0 1px #ffffff66,inset 0 -8px 18px #0002,0 3px 10px color-mix(in srgb,var(--period-color) 24%,transparent)!important}.period.dynamic-preset::before,.period.on::before{content:"";position:absolute;z-index:-1;inset:1px 3px auto;height:42%;border-radius:7px 7px 50% 50%;background:linear-gradient(180deg,#ffffff2e,transparent);pointer-events:none}.off-gap{background:linear-gradient(180deg,color-mix(in srgb,var(--off) 34%,#263a51),color-mix(in srgb,var(--off) 42%,#111a27))!important;border:1px solid color-mix(in srgb,var(--off) 68%,#708096)!important;box-shadow:inset 0 1px #ffffff12!important}.period b{text-shadow:0 1px 3px #0008;font-weight:700;letter-spacing:.01em}.resize-handle::after{opacity:.58}.chip{background:linear-gradient(145deg,color-mix(in srgb,var(--secondary-background-color) 82%,#17304a),color-mix(in srgb,var(--card-background-color) 92%,#050b12))!important;border-color:color-mix(in srgb,var(--primary-color) 18%,var(--divider-color))!important;box-shadow:inset 0 1px #ffffff12,0 4px 12px #0002}.today.selected,nav button.selected{background:linear-gradient(145deg,color-mix(in srgb,var(--primary-color) 88%,white),color-mix(in srgb,var(--primary-color) 82%,#06436a))!important;border:1px solid color-mix(in srgb,var(--primary-color) 70%,white)!important;box-shadow:inset 0 1px #ffffff55,0 6px 18px color-mix(in srgb,var(--primary-color) 32%,transparent)!important}.schedule-enabled{padding:11px;border:1px solid var(--divider-color);border-radius:12px;background:color-mix(in srgb,var(--primary-color) 7%,var(--secondary-background-color))}.schedule-enabled span{display:flex;align-items:center;gap:9px;color:var(--primary-text-color)}.schedule-enabled input{min-height:auto!important}.schedule-enabled small{color:var(--secondary-text-color)}.schedule-paused .timeline{opacity:.32;filter:saturate(.2)}.schedule-paused .room-name>ha-icon,.schedule-paused .room-name small{color:var(--warning-color,#f59e0b)!important}`;

const COMPOSED_ROW_CSS = `.hours{position:relative;overflow:visible;padding-top:22px!important}.now-badge{position:absolute;z-index:20;top:-5px;transform:translateX(-50%);min-width:50px;padding:3px 7px;border:1px solid color-mix(in srgb,var(--now) 70%,white);border-radius:7px;background:linear-gradient(180deg,color-mix(in srgb,var(--now) 78%,white),color-mix(in srgb,var(--now) 80%,#06435d));box-shadow:0 4px 12px color-mix(in srgb,var(--now) 35%,transparent),inset 0 1px #ffffff66;color:white;font-size:11px;font-style:normal;font-weight:800;text-align:center;line-height:16px}.room{gap:0!important;padding:4px 0}.room-name{align-self:stretch;margin-right:6px;padding:6px 7px 6px 10px;border:1px solid color-mix(in srgb,var(--primary-text-color) 11%,var(--divider-color));border-radius:11px;background:linear-gradient(145deg,color-mix(in srgb,var(--secondary-background-color) 72%,#15304b),color-mix(in srgb,var(--card-background-color) 91%,#050b13));box-shadow:inset 0 1px #ffffff10,0 3px 9px #0002}.room-name>ha-icon{color:color-mix(in srgb,var(--primary-color) 72%,var(--primary-text-color))!important}section>h2{gap:7px}section>h2 ha-icon{--mdc-icon-size:19px;color:var(--primary-color)}.timeline{align-self:stretch;height:auto!important;min-height:50px}.off-gap,.period{top:4px!important;height:calc(100% - 8px)!important}@media(max-width:700px){.hours{padding-top:18px!important}.now-badge{top:-7px}.room-name{margin-right:4px;padding-left:7px}}`;

const SCHEDULE_BUBBLE_CSS = `section{padding:0 7px 7px!important}.schedule-list{display:grid;gap:4px}.room{min-height:54px!important;padding:3px!important;border:1px solid color-mix(in srgb,var(--primary-text-color) 13%,var(--divider-color))!important;border-radius:13px!important;background:linear-gradient(145deg,color-mix(in srgb,var(--secondary-background-color) 58%,#142b43),color-mix(in srgb,var(--card-background-color) 88%,#050b12))!important;box-shadow:inset 0 1px #ffffff0c,0 3px 10px #00000020!important}.room-name{margin-right:4px!important;border-color:transparent!important;background:linear-gradient(145deg,color-mix(in srgb,var(--secondary-background-color) 76%,#1a3855),color-mix(in srgb,var(--card-background-color) 90%,#07101a))!important;box-shadow:inset 0 1px #ffffff12!important}.room-name span{justify-content:center}.room-name b{line-height:1.15}.room-name small{margin-top:2px;color:var(--warning-color,#f59e0b)!important;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.timeline{min-height:46px!important;border-radius:10px!important}.off-gap,.period{top:3px!important;height:calc(100% - 6px)!important}.manage-button{height:38px!important;flex-basis:34px!important;width:34px!important}.schedule-paused{border-color:color-mix(in srgb,var(--warning-color,#f59e0b) 35%,var(--divider-color))!important}@media(max-width:700px){.schedule-list{gap:3px}.room{min-height:50px!important}.timeline{min-height:42px!important}}`;

const TOUCH_EDITOR_CSS = `.layout:has(.touch-editor){grid-template-columns:minmax(0,1fr) 390px}.touch-editor{padding:18px!important;border-color:color-mix(in srgb,var(--primary-color) 25%,var(--divider-color))!important;background:linear-gradient(155deg,color-mix(in srgb,var(--card-background-color) 92%,#102a43),color-mix(in srgb,var(--card-background-color) 97%,#03080e))!important}.touch-editor .editor-title h2{font-size:25px}.touch-editor .editor-title small{color:var(--primary-color);font-weight:700;text-transform:uppercase;letter-spacing:.08em}.touch-editor .editor-title button{border:1px solid var(--divider-color);border-radius:50%;background:var(--secondary-background-color);font-size:23px}.control-section{display:grid;gap:9px;margin:14px 0;padding:12px;border:1px solid color-mix(in srgb,var(--primary-text-color) 14%,var(--divider-color));border-radius:14px;background:color-mix(in srgb,var(--secondary-background-color) 62%,transparent)}.section-label{font-size:14px;color:var(--secondary-text-color);text-transform:uppercase;letter-spacing:.07em}.mode-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(82px,1fr));gap:7px}.mode-choice{display:grid;place-items:center;gap:5px;min-height:76px;border:1px solid var(--divider-color);border-radius:12px;background:linear-gradient(145deg,var(--secondary-background-color),var(--card-background-color));color:var(--primary-text-color);font-weight:700;cursor:pointer}.mode-choice ha-icon{--mdc-icon-size:28px;color:var(--secondary-text-color)}.mode-choice.active{border-color:color-mix(in srgb,var(--primary-color) 72%,white);background:linear-gradient(145deg,color-mix(in srgb,var(--primary-color) 78%,white),color-mix(in srgb,var(--primary-color) 76%,#063653));box-shadow:inset 0 1px #ffffff55,0 5px 15px color-mix(in srgb,var(--primary-color) 28%,transparent);color:white}.mode-choice.active ha-icon{color:white}.mode-fallback{display:none}.touch-editor .time-grid{gap:10px}.touch-editor .time-grid label{margin:0;font-weight:700}.touch-editor .time-grid select{min-height:62px;font-size:23px;font-weight:750;text-align:center}.touch-target{display:grid;gap:8px;margin:13px 0;color:var(--secondary-text-color)}.touch-target>div{display:grid;grid-template-columns:58px 1fr 58px;min-height:60px;border:1px solid var(--divider-color);border-radius:13px;overflow:hidden}.touch-target button{border:0;background:var(--secondary-background-color);color:var(--primary-text-color);font-size:27px}.touch-target output{display:grid;place-items:center;border-inline:1px solid var(--divider-color);background:color-mix(in srgb,var(--secondary-background-color) 62%,transparent);color:var(--primary-text-color);font-size:24px;font-weight:750}.touch-target.disabled{opacity:.4}.touch-editor .override{margin:13px 0!important;border-radius:13px!important}.touch-editor .override span{min-height:36px}.touch-editor .override input{width:23px;height:23px}.day-pills{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;padding:10px!important}.day-pills legend{padding:0 5px;color:var(--secondary-text-color);font-weight:700}.day-pills .check{position:relative;display:grid!important;place-items:center;min-height:46px;margin:0!important;border:1px solid var(--divider-color);border-radius:10px;background:var(--secondary-background-color);cursor:pointer}.day-pills .check input{position:absolute;opacity:0}.day-pills .check:has(input:checked){border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 32%,var(--secondary-background-color));color:white}.touch-editor .editor-actions{position:sticky;bottom:0;gap:9px;padding-top:12px;background:linear-gradient(transparent,var(--card-background-color) 32%)}.touch-editor .editor-actions button{display:flex;align-items:center;justify-content:center;gap:8px;min-height:58px;font-size:16px;font-weight:750}.touch-editor .controlled-entities{margin:12px 0}.touch-editor .gap-fill{border-radius:13px}.touch-editor input[type=range]{height:38px}.touch-editor input[type=range]::-webkit-slider-thumb{width:28px;height:28px}@media(max-width:1100px){.layout:has(.touch-editor){grid-template-columns:1fr}.touch-editor{position:sticky;bottom:6px;max-height:82vh;overflow:auto}}`;

const COMPACT_TOUCH_EDITOR_CSS = `.touch-editor{padding:14px!important}.touch-editor .editor-title{padding-bottom:8px!important}.touch-editor .editor-title h2{font-size:21px}.compact-disclosure{margin:7px 0!important;padding:0!important;background:transparent!important}.compact-disclosure summary{display:flex;justify-content:space-between;align-items:center;min-height:34px;padding:0 10px;cursor:pointer;color:var(--secondary-text-color);font-size:12px;font-weight:700}.compact-disclosure summary span{display:grid;place-items:center;min-width:22px;height:22px;border-radius:11px;background:var(--secondary-background-color);color:var(--primary-text-color)}.compact-disclosure ul{padding:0 9px 8px!important}.touch-editor .control-section{margin:8px 0;padding:8px}.touch-editor .mode-grid{gap:6px}.touch-editor .mode-choice{min-height:58px;gap:2px}.touch-editor .mode-choice ha-icon{--mdc-icon-size:23px}.touch-editor .time-grid select{min-height:48px;font-size:19px}.touch-target{margin:8px 0}.touch-target>div{min-height:50px}.touch-target output{font-size:21px}.touch-editor .override{margin:8px 0!important;padding:7px!important}.touch-editor .override small{display:none}.editor-menu-row{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}.editor-menu{position:relative;overflow:visible!important}.editor-menu>summary{display:flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 8px;border:1px solid var(--divider-color);border-radius:11px;background:var(--secondary-background-color);cursor:pointer;font-weight:700;list-style:none}.editor-menu>summary::-webkit-details-marker{display:none}.editor-menu>summary ha-icon{--mdc-icon-size:20px}.editor-menu[open]>summary{border-color:var(--primary-color);color:var(--primary-color)}.editor-menu>fieldset,.editor-menu>.action-popout{position:absolute;z-index:30;right:0;bottom:50px;width:300px;padding:9px!important;border:1px solid var(--divider-color);border-radius:13px;background:var(--card-background-color);box-shadow:0 12px 30px #0009}.editor-menu:first-child>fieldset{left:0;right:auto}.day-pills{grid-template-columns:repeat(2,1fr)!important}.day-pills .check{min-height:40px!important}.day-pills .current-day{opacity:.5;cursor:default}.action-popout{display:grid;gap:8px}.action-popout .gap-fill{margin:0;padding:8px}.action-popout .gap-fill label{margin:0}.action-popout button{min-height:44px;border:0;border-radius:10px}.touch-editor .editor-actions{margin-top:7px;padding-top:0;background:none}.touch-editor .editor-actions button{min-height:48px}.touch-editor .light-controls{margin-top:7px}.touch-editor .light-controls label{margin:7px 0}@media(max-width:420px){.editor-menu>fieldset,.editor-menu>.action-popout{width:270px}}`;

const WIDE_TOUCH_EDITOR_CSS = `@media(min-width:1101px){.layout:has(.touch-editor){grid-template-columns:minmax(0,3fr) minmax(430px,2fr)}.touch-editor{padding-inline:20px!important}.touch-editor .mode-grid{grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px}.touch-editor .mode-choice{font-size:16px}.touch-editor .time-grid{gap:16px}.touch-editor .time-grid select{font-size:21px}.touch-target>div{grid-template-columns:76px 1fr 76px}.touch-target button{font-size:30px}.editor-menu-row{gap:12px}.editor-menu>summary{font-size:15px}.touch-editor .editor-actions button{font-size:18px}}`;

const WIDE_CREATE_EDITOR_CSS = `@media(min-width:1101px){.layout:has(.create-editor){grid-template-columns:minmax(0,3fr) minmax(430px,2fr)}.create-editor{width:auto!important;max-width:none!important;box-sizing:border-box;padding:18px 20px!important}.create-editor>label input,.create-editor>label select{min-height:50px!important;font-size:16px}.create-editor .entity-type-switch button{min-height:48px;font-size:15px}.create-editor .entity-picker input{min-height:48px;font-size:15px}.create-editor .entity-picker select{min-height:116px;font-size:15px}.create-editor .create-submit{min-height:52px!important;font-size:17px;font-weight:800}}`;

const CONSISTENT_EDITOR_WIDTH_CSS = `@media(min-width:1101px){.layout:has(>.period-editor){grid-template-columns:minmax(0,3fr) minmax(430px,2fr)!important}.layout>.period-editor{width:auto!important;max-width:none!important;box-sizing:border-box}}`;

const FOCUS_TIMELINE_CSS = `.timeline-tools{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:0 0 4px 174px}.timeline-tools button{min-height:36px;padding:0 11px;border:1px solid var(--divider-color);border-radius:9px;background:var(--secondary-background-color);color:var(--primary-text-color);cursor:pointer}.view-switch{display:grid;grid-template-columns:1fr 1fr;padding:3px;border-radius:11px;background:color-mix(in srgb,var(--secondary-background-color) 72%,transparent)}.view-switch button{border:0;background:transparent}.view-switch button.active{background:var(--primary-color);color:var(--text-primary-color);box-shadow:0 3px 10px color-mix(in srgb,var(--primary-color) 30%,transparent)}[data-view-now]{display:flex;align-items:center;gap:5px}.hours{display:block!important;position:relative;height:43px;margin-bottom:2px!important;padding-top:0!important;touch-action:none;cursor:ew-resize;user-select:none}.hours span{position:absolute;bottom:2px;transform:translateX(-50%)!important;white-space:nowrap;font-size:10px}.hours span:first-child{transform:none!important}.hours span:last-of-type{transform:translateX(-100%)!important}.timeline.focus{background-image:linear-gradient(90deg,transparent 0,transparent 15%,color-mix(in srgb,var(--primary-color) 7%,transparent) 15%,color-mix(in srgb,var(--primary-color) 7%,transparent) 85%,transparent 85%)!important}.now{width:3px!important;background:var(--now)!important;box-shadow:0 0 5px var(--now),0 0 13px var(--now)!important}.now-badge{bottom:20px!important;top:auto!important;z-index:40!important}.period.compact b{font-size:11px}.period.compact{padding-inline:3px}@media(max-width:1000px){.timeline-tools{margin-left:139px}}@media(max-width:650px){.timeline-tools{margin-left:0;justify-content:space-between}.timeline-tools button{font-size:12px;padding:0 8px}.hours{margin-left:125px!important}}`;

const STATUS_VIEW_CSS = `.status-strip{grid-template-columns:auto minmax(135px,.65fr) minmax(220px,1.35fr) auto!important}.status-strip .timeline-tools{margin:0!important;gap:5px}.status-strip .timeline-tools button{min-height:36px;padding:0 9px}.status-strip .view-switch{padding:2px}.status-strip .view-switch button{min-width:43px}.status-strip [data-view-now] ha-icon{--mdc-icon-size:18px}@media(max-width:850px){.status-strip{grid-template-columns:auto 1fr auto!important}.status-strip .current{display:none}.status-strip .next{min-width:0}.status-strip .next b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status-strip [data-view-now] span{display:none}}`;

const CARD_MODE_CSS = `.status-strip{grid-template-columns:auto auto minmax(120px,.55fr) minmax(190px,1fr) auto!important}.card-mode-select{display:flex;align-items:center;gap:6px;min-height:42px;padding:3px 7px;border:1px solid var(--divider-color);border-radius:12px;background:color-mix(in srgb,var(--secondary-background-color) 72%,transparent)}.card-mode-select ha-icon{--mdc-icon-size:19px;color:var(--primary-color)}.card-mode-select select{min-height:34px;border:0;background:transparent;color:var(--primary-text-color);font-weight:750}@media(max-width:1050px){.status-strip{grid-template-columns:auto auto 1fr auto!important}.status-strip .current{display:none}}@media(max-width:760px){.status-strip{grid-template-columns:1fr auto!important}.status-strip .next{display:none}.status-strip .timeline-tools{grid-column:1/-1}}`;

const TOP_MODE_CSS = `ha-card>header{position:relative}.top-mode{position:relative;margin-left:auto}.top-mode>summary{display:flex;align-items:center;gap:8px;min-width:150px;min-height:44px;padding:5px 10px;border:1px solid color-mix(in srgb,var(--primary-color) 30%,var(--divider-color));border-radius:11px;background:var(--secondary-background-color);cursor:pointer;list-style:none}.top-mode>summary::-webkit-details-marker{display:none}.top-mode>summary>ha-icon:first-child{color:var(--primary-color)}.top-mode>summary>span{display:flex;flex:1;flex-direction:column}.top-mode>summary small{color:var(--secondary-text-color);font-size:10px;text-transform:uppercase}.mode-popout{position:absolute;z-index:100;top:51px;right:0;display:grid;gap:8px;width:330px;padding:12px;border:1px solid var(--divider-color);border-radius:15px;background:var(--card-background-color);box-shadow:0 16px 38px #000a}.mode-popout button{display:grid;grid-template-columns:30px 1fr 26px;align-items:center;min-height:58px;padding:8px 12px;border:1px solid var(--divider-color);border-radius:12px;background:var(--secondary-background-color);color:var(--primary-text-color);font-size:16px;text-align:left;cursor:pointer}.mode-popout button.active{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 22%,var(--secondary-background-color));font-weight:800}.mode-popout button ha-icon{color:var(--primary-color)}.top-mode+.history{margin-left:14px;padding-left:14px;border-left:1px solid var(--divider-color)}@media(max-width:700px){.top-mode>summary{min-width:112px}.top-mode>summary small{display:none}.mode-popout{position:fixed;top:20%;left:8%;right:8%;width:auto}}`;

const COMPACT_DAY_CSS = `nav{margin:4px 0 8px!important;padding:3px!important;gap:5px!important}nav button{min-height:36px!important}.hours span{font-size:13px!important;font-weight:650}.now-badge{font-size:12px!important}`;

const DEFINED_RULER_CSS = `.hours{height:46px!important;border-bottom:1px solid color-mix(in srgb,var(--primary-text-color) 34%,var(--divider-color));background:repeating-linear-gradient(90deg,transparent 0,transparent calc(4.166667% - 1px),color-mix(in srgb,var(--primary-text-color) 8%,transparent) calc(4.166667% - 1px),color-mix(in srgb,var(--primary-text-color) 8%,transparent) 4.166667%);border-radius:8px 8px 0 0}.hours::before{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;background:linear-gradient(90deg,var(--primary-color),color-mix(in srgb,var(--primary-color) 45%,var(--divider-color)),var(--primary-color));opacity:.8}.hours span{bottom:12px!important;padding:1px 4px;border-radius:4px;background:color-mix(in srgb,var(--card-background-color) 82%,transparent);color:var(--primary-text-color)}.hours span::after{content:"";position:absolute;left:50%;top:100%;width:2px;height:10px;transform:translateX(-50%);background:color-mix(in srgb,var(--primary-color) 78%,var(--primary-text-color));border-radius:2px}.hours span:first-child::after{left:4px}.hours span:last-of-type::after{left:calc(100% - 4px)}.timeline.focus::after{content:"";position:absolute;z-index:0;inset:0 15%;border-inline:1px solid color-mix(in srgb,var(--primary-color) 42%,transparent);pointer-events:none}.now-badge::after{content:"";position:absolute;left:50%;top:100%;width:3px;height:25px;transform:translateX(-50%);background:var(--now);box-shadow:0 0 8px var(--now)}.period,.off-gap{z-index:1}.now{z-index:8!important}`;
const NEUTRAL_RULER_CSS = `.hours::before{height:1px;background:color-mix(in srgb,var(--primary-text-color) 46%,var(--divider-color));opacity:.72}`;
const ASTRO_HEALTH_CSS = `.chip.health{cursor:pointer}.chip.health.healthy{border-color:color-mix(in srgb,#22c55e 38%,var(--divider-color))}.chip.health.healthy ha-icon{color:#22c55e}.chip.health.warning{border-color:color-mix(in srgb,var(--warning-color,#f59e0b) 65%,var(--divider-color));background:color-mix(in srgb,var(--warning-color,#f59e0b) 12%,var(--card-background-color))!important}.chip.health.warning ha-icon{color:var(--warning-color,#f59e0b)}.health-panel{margin:-5px 0 10px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--primary-color) 28%,var(--divider-color));border-radius:12px;background:color-mix(in srgb,var(--secondary-background-color) 76%,var(--card-background-color));box-shadow:0 7px 20px #0003}.health-panel header{margin:0;min-height:34px}.health-panel header button{min-width:36px;min-height:34px;border:0;background:transparent;color:var(--primary-text-color);font-size:22px}.health-panel ul{display:grid;gap:6px;margin:5px 0 0;padding:0;list-style:none}.health-panel li,.health-panel p{display:flex;align-items:center;gap:8px;margin:0;color:var(--secondary-text-color)}.health-panel ha-icon{--mdc-icon-size:19px;color:var(--warning-color,#f59e0b)}.astro-controls{margin:8px 0;padding:9px;border:1px solid color-mix(in srgb,#f59e0b 28%,var(--divider-color));border-radius:12px;background:color-mix(in srgb,#f59e0b 6%,transparent)}.astro-controls summary{display:flex;align-items:center;gap:7px;min-height:36px;cursor:pointer;font-weight:700}.astro-controls summary ha-icon{color:#f59e0b}.astro-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.astro-controls small{display:block;margin-top:6px;color:var(--secondary-text-color);line-height:1.3}`;
const ASTRO_MARKER_CSS = `.astro-ruler-marker{position:absolute;z-index:18;bottom:-11px;width:23px;height:23px;padding:3px;border:1px solid color-mix(in srgb,#fbbf24 70%,white);border-radius:50%;transform:translateX(-50%);background:color-mix(in srgb,var(--card-background-color) 78%,#f59e0b);color:#fbbf24;box-shadow:0 2px 7px #0007;pointer-events:none}.astro-ruler-marker::before{content:"";position:absolute;left:50%;bottom:100%;width:1px;height:8px;background:color-mix(in srgb,#fbbf24 60%,var(--divider-color))}.period.carryover{border-left-style:dashed!important;border-top-left-radius:3px!important;border-bottom-left-radius:3px!important}.period.carryover>ha-icon{--mdc-icon-size:16px;opacity:.7}.period.carryover::after{content:"from previous day";position:absolute;right:7px;bottom:2px;font-size:8px;font-weight:600;opacity:.65}`;
const OVERRIDE_BAND_CSS = `.override-band{position:absolute;z-index:9;top:4px;height:15px;display:flex;align-items:center;justify-content:center;overflow:hidden;border:1px solid #ffffff88;border-radius:7px;box-shadow:0 2px 7px #0008,inset 0 1px #ffffff55;color:white;pointer-events:none}.override-band.boost{background:linear-gradient(90deg,#ef4444,#b91c1c)}.override-band.manual{background:linear-gradient(90deg,#fb923c,#c2410c)}.override-band b{padding:0 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;letter-spacing:.05em}.boost-settings{margin:9px 0;padding:8px;border:1px solid var(--divider-color);border-radius:11px}.boost-settings summary{min-height:36px;display:flex;align-items:center;cursor:pointer;font-weight:700}`;
const MANUAL_BAND_CSS = `.override-band.manual{top:9px;height:29px;border-width:2px;border-radius:10px;background:linear-gradient(135deg,#fb923c,#ea580c)!important;box-shadow:0 4px 12px #0009,inset 0 1px #ffffff70}.override-band.manual b{font-size:11px;font-weight:850;letter-spacing:.06em;text-shadow:0 1px 3px #0009}.override-band.boost{top:5px;height:20px}.override-band.boost b{font-size:10px}.quick-boost{display:grid;place-items:center;flex:0 0 34px;width:34px;height:34px;padding:0;border:1px solid color-mix(in srgb,#ef4444 55%,var(--divider-color));border-radius:50%;background:color-mix(in srgb,#ef4444 12%,var(--secondary-background-color));color:#fb7185;cursor:pointer}.quick-boost ha-icon{--mdc-icon-size:18px}.quick-boost.active{background:linear-gradient(135deg,#ef4444,#b91c1c);color:#fff;box-shadow:0 0 13px #ef444488}.room-name>span{flex:1}`;
const ENTITY_PICKER_CSS = `.entity-picker{display:grid;gap:8px;margin:11px 0}.entity-picker>b{color:var(--secondary-text-color)}.entity-type-switch{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.entity-type-switch button{display:flex;align-items:center;justify-content:center;gap:5px;min-height:44px;border:1px solid var(--divider-color);border-radius:10px;background:var(--secondary-background-color);color:var(--primary-text-color)}.entity-type-switch button.active{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 24%,var(--secondary-background-color));color:var(--primary-color);font-weight:750}.entity-type-switch ha-icon{--mdc-icon-size:19px}.entity-picker input,.entity-picker select,.controlled-entities input[type=search]{width:100%;min-height:44px;border:1px solid var(--divider-color);border-radius:10px;padding:8px;background:var(--secondary-background-color);color:var(--primary-text-color)}.entity-picker select{min-height:110px}.controlled-entities input[type=search]{margin:8px 0}`;

const CLIMATE_CREATE_CSS = `.climate-create-editor .create-help{margin:8px 0 14px;color:var(--secondary-text-color);line-height:1.4}.climate-create-editor label small{margin-top:2px;color:var(--secondary-text-color)}.thermostat-target-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:290px;overflow:auto}.thermostat-target-list>button{display:grid;grid-template-columns:30px minmax(0,1fr) 26px;align-items:center;gap:9px;min-height:64px;padding:9px 11px;border:1px solid var(--divider-color);border-radius:12px;background:var(--secondary-background-color);color:var(--primary-text-color);text-align:left;cursor:pointer}.thermostat-target-list>button span{display:grid;min-width:0}.thermostat-target-list>button small{overflow:hidden;text-overflow:ellipsis;color:var(--secondary-text-color);white-space:nowrap}.thermostat-target-list>button.active{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 20%,var(--secondary-background-color));box-shadow:inset 0 0 0 1px var(--primary-color)}.thermostat-target-list>button.active>ha-icon{color:var(--primary-color)}.blank-start{display:flex;align-items:center;gap:11px;margin:14px 0;padding:12px;border:1px dashed color-mix(in srgb,var(--primary-color) 55%,var(--divider-color));border-radius:12px;background:color-mix(in srgb,var(--primary-color) 8%,transparent)}.blank-start>ha-icon{color:var(--primary-color)}.blank-start span{display:grid}.blank-start small{color:var(--secondary-text-color)}@media(max-width:700px){.thermostat-target-list{grid-template-columns:1fr}}`;

const RESIZE_FIX_CSS = `.resize-handle{position:absolute!important;z-index:20!important;top:0!important;bottom:0!important;width:28px!important;pointer-events:auto!important;touch-action:none!important;cursor:ew-resize!important}.resize-handle::after{top:7px!important;bottom:7px!important;width:3px!important;background:#ffffffb8!important;box-shadow:0 0 4px #0008}.resize-handle.start::after{left:5px!important}.resize-handle.end::after{right:5px!important}`;

const BOOST_PLACEMENT_CSS = `.room{grid-template-columns:170px 42px minmax(0,1fr)!important}.row-boost-slot{display:grid;place-items:center;width:42px}.row-boost-slot:empty{visibility:hidden}.row-boost-slot .quick-boost{margin:0!important}.room-name{min-width:0}.room-name>span{min-width:0;overflow:hidden}.room-name b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hours,.timeline-tools{margin-left:216px!important}@media(max-width:1000px){.room{grid-template-columns:125px 40px minmax(0,1fr)!important}.row-boost-slot{width:40px}.hours,.timeline-tools{margin-left:179px!important}}@media(max-width:650px){.hours{margin-left:165px!important}.timeline-tools{margin-left:0!important}}`;

const ROUTINE_WIZARD_CSS = `.routine-backdrop{position:fixed;z-index:130;inset:0;display:grid;place-items:center;padding:18px;background:#000b;backdrop-filter:blur(8px)}.routine-wizard{display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:min(1050px,100%);max-height:min(850px,96vh);overflow:hidden;border:1px solid color-mix(in srgb,var(--primary-color) 40%,var(--divider-color));border-radius:22px;background:var(--card-background-color);box-shadow:0 28px 80px #000d}.routine-wizard>header,.routine-wizard>footer{display:flex;align-items:center;gap:10px;padding:17px 22px;border-bottom:1px solid var(--divider-color)}.routine-wizard>header h2,.routine-wizard>header small{margin:0}.routine-wizard>header small{color:var(--primary-color);font-weight:800;text-transform:uppercase;letter-spacing:.08em}.routine-wizard>header button{margin-left:auto;width:48px;border:0;background:transparent;color:var(--primary-text-color);font-size:28px}.routine-wizard>main{display:grid;gap:14px;overflow:auto;padding:22px}.routine-intro{margin:0;color:var(--secondary-text-color);line-height:1.45}.routine-wizard label{display:grid;gap:6px}.routine-wizard input,.routine-wizard select,.routine-wizard button{min-height:48px;border:1px solid var(--divider-color);border-radius:11px;padding:8px 10px;background:var(--secondary-background-color);color:var(--primary-text-color);font:inherit}.routine-wizard fieldset{border:1px solid var(--divider-color);border-radius:13px}.routine-days{display:grid;grid-template-columns:repeat(7,1fr);gap:7px}.routine-days label{display:flex;align-items:center;justify-content:center;gap:5px;min-height:46px;border:1px solid var(--divider-color);border-radius:9px}.routine-days input,.routine-occupied input{min-height:auto}.routine-phases{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.routine-phases label{grid-template-columns:110px minmax(0,.7fr) minmax(160px,1fr);align-items:center;padding:12px;border:1px solid var(--divider-color);border-radius:13px}.routine-occupied{display:grid!important;grid-template-columns:28px minmax(0,1fr) minmax(190px,.6fr);align-items:center;padding:13px;border:1px solid var(--divider-color);border-radius:13px}.routine-occupied span{display:grid}.routine-occupied small{color:var(--secondary-text-color)}.routine-wizard>footer{justify-content:flex-end;border-top:1px solid var(--divider-color);border-bottom:0}.routine-wizard>footer button{padding-inline:18px}@media(max-width:760px){.routine-days{grid-template-columns:repeat(4,1fr)}.routine-phases{grid-template-columns:1fr}.routine-occupied{grid-template-columns:28px 1fr}.routine-occupied select{grid-column:1/-1}}`;

const BOOST_PICKER_CSS = `.boost-picker-backdrop{position:fixed;z-index:120;inset:0;display:grid;place-items:center;padding:20px;background:#000a;backdrop-filter:blur(6px)}.boost-picker{width:min(620px,100%);padding:20px;border:1px solid color-mix(in srgb,#ef4444 55%,var(--divider-color));border-radius:20px;background:var(--card-background-color);box-shadow:0 24px 70px #000d}.boost-picker header{display:flex}.boost-picker h2,.boost-picker p{margin:3px 0}.boost-picker header small{color:#fb7185;text-transform:uppercase;font-weight:800;letter-spacing:.08em}.boost-picker header button{margin-left:auto;width:48px;border:0;background:transparent;color:var(--primary-text-color);font-size:28px}.boost-picker>p{margin:14px 0 18px;color:var(--secondary-text-color);font-size:15px}.boost-picker>div{display:grid;grid-template-columns:repeat(auto-fit,minmax(95px,1fr));gap:10px}.boost-picker>div button{position:relative;display:grid;place-items:center;min-height:92px;border:1px solid var(--divider-color);border-radius:14px;background:var(--secondary-background-color);color:var(--primary-text-color);cursor:pointer}.boost-picker>div button b{font-size:25px}.boost-picker>div button span{color:var(--secondary-text-color)}.boost-picker>div button.default{border-color:#ef4444;background:color-mix(in srgb,#ef4444 18%,var(--secondary-background-color))}.boost-picker>div button small{position:absolute;top:5px;right:6px;color:#fb7185;font-size:9px;text-transform:uppercase}`;

const LIVE_INDICATOR_CSS = `.now{width:1px!important;background:color-mix(in srgb,var(--primary-text-color) 78%,transparent)!important;box-shadow:0 0 0 1px #0005,0 0 5px color-mix(in srgb,var(--primary-text-color) 38%,transparent)!important;pointer-events:none}.now-badge{top:1px!important;bottom:auto!important;z-index:45!important;background:color-mix(in srgb,var(--card-background-color) 86%,#111827)!important;border-color:color-mix(in srgb,var(--primary-text-color) 55%,var(--divider-color))!important;color:var(--primary-text-color)!important;box-shadow:0 3px 9px #0008!important}.now-badge::after{width:1px!important;height:27px!important;background:color-mix(in srgb,var(--primary-text-color) 72%,transparent)!important;box-shadow:none!important}.override-band.boost{top:7px!important;height:34px!important;gap:4px;border-radius:11px;background:linear-gradient(135deg,#f43f5e,#b91c1c)!important;box-shadow:0 4px 13px #0009,inset 0 1px #ffffff70}.override-band.boost ha-icon{flex:0 0 auto;--mdc-icon-size:16px;margin-left:5px;color:#fff}.override-band.boost b{font-size:11px!important;font-weight:850;letter-spacing:.06em;text-shadow:0 1px 3px #0009}`;
const DAILY_CONTROL_CSS = `.editing-history-hidden{display:none!important}.draft-bar{position:sticky;z-index:50;bottom:6px}.room-name small{display:none}.manage-button{opacity:.55}.room:hover .manage-button,.manage-button:focus{opacity:1}`;
const RESPONSIVE_FINISH_CSS = `.now-badge.edge-left{transform:none!important}.now-badge.edge-right{transform:translateX(-100%)!important}.today span{display:inline!important}.row-presets .boost-grid{grid-template-columns:repeat(auto-fit,minmax(120px,1fr))}.row-presets p{margin:7px 0}.period.compact b{font-size:10px!important;white-space:nowrap}@media(min-width:1300px){.room{grid-template-columns:205px 42px minmax(0,1fr)!important}.hours{margin-left:251px!important}}@media(max-height:1100px) and (min-width:850px){ha-card{padding:10px!important}ha-card>header h1{font-size:25px!important}.status-strip{margin:4px 0 2px!important}.chip{min-height:26px!important}.top-mode>summary{min-height:38px!important}nav{margin:2px 0 5px!important}nav button{min-height:31px!important}.hours{height:38px!important}.schedule-list{gap:2px!important}section{margin-bottom:5px!important;padding-bottom:4px!important}section>h2{min-height:31px!important}.room{min-height:40px!important;padding:1px!important}.room-name{min-height:38px!important;padding-block:2px!important}.timeline{min-height:38px!important}.period,.off-gap{top:0!important;height:100%!important}.quick-boost{width:31px!important;height:31px!important}.now-badge{top:-1px!important}}`;
const FINAL_ROW_CSS = `.room{padding:0!important}.timeline{align-self:stretch!important;height:auto!important;min-height:46px!important}.period,.off-gap{top:0!important;height:100%!important;border-radius:10px!important}.room-name{min-height:46px!important}.room-name b{display:flex!important;align-items:center;gap:7px;min-width:0}.room-label-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.room-temperature{flex:0 0 auto;padding:2px 5px;border:1px solid color-mix(in srgb,var(--primary-color) 30%,var(--divider-color));border-radius:7px;background:color-mix(in srgb,var(--primary-color) 10%,transparent);color:var(--primary-text-color);font-size:11px;font-weight:800;line-height:1.2}.now{z-index:20!important;width:2px!important;background:color-mix(in srgb,var(--primary-text-color) 92%,white)!important;box-shadow:0 0 0 1px #0009,0 0 7px color-mix(in srgb,var(--primary-text-color) 65%,transparent)!important}.now-badge{font-weight:900!important;border-width:2px!important}.now-badge::after{width:2px!important;background:color-mix(in srgb,var(--primary-text-color) 92%,white)!important;box-shadow:0 0 0 1px #0007!important}@media(max-height:1100px) and (min-width:850px){.room{height:40px!important;min-height:40px!important}.room-name,.timeline{height:40px!important;min-height:40px!important}.period,.off-gap{top:0!important;height:100%!important}.room-temperature{font-size:10px;padding:1px 4px}}`;
const BULK_SETUP_CSS = `.bulk-setup,.mode-bulk-card{padding:18px!important;border:1px solid color-mix(in srgb,var(--primary-color) 42%,var(--divider-color))!important;border-radius:16px!important;background:color-mix(in srgb,var(--primary-color) 7%,var(--card-background-color))!important}.bulk-setup>header{display:flex;align-items:center;gap:12px;margin-bottom:14px}.bulk-setup>header ha-icon{--mdc-icon-size:32px;color:#fb7185}.bulk-setup h3{margin:0}.bulk-setup header span{display:grid}.bulk-setup small,.bulk-exceptions small{color:var(--secondary-text-color)}.bulk-controls{display:grid;grid-template-columns:minmax(170px,1fr) minmax(190px,1fr) minmax(140px,.7fr) minmax(140px,.7fr) auto;align-items:end;gap:10px}.bulk-controls>label{display:grid;gap:5px}.bulk-controls input,.bulk-controls select,.bulk-controls button{min-height:48px}.bulk-controls .wizard-toggle{margin:0!important;min-height:69px}.bulk-result{margin:12px 0 0;color:var(--secondary-text-color)}.bulk-exceptions{margin-top:12px;border:1px solid var(--divider-color);border-radius:13px}.bulk-exceptions>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px;cursor:pointer}.bulk-exceptions>summary span{display:grid}.bulk-exceptions>article{display:grid;grid-template-columns:minmax(190px,1fr) 130px 130px 130px;align-items:center;gap:9px;padding:9px 13px;border-top:1px solid var(--divider-color)}.bulk-exceptions>article label{display:flex;align-items:center;gap:6px}.mode-bulk-card>header{display:grid!important;grid-template-columns:36px minmax(170px,1fr) minmax(190px,1fr) auto!important;align-items:end!important}.mode-bulk-card>header>ha-icon{align-self:center;color:var(--primary-color)}.mode-bulk{grid-template-columns:minmax(170px,1fr) minmax(130px,.7fr) auto;margin-top:12px}.mode-targets{margin-top:14px;padding:12px;border:1px solid var(--divider-color);border-radius:13px}.mode-targets>header{display:flex;align-items:center;justify-content:space-between;gap:10px}.mode-targets>header span{display:grid}.mode-target-actions{display:flex;gap:7px}.mode-target-actions button{min-height:38px}.mode-target-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-top:10px}.mode-target-grid label{display:flex;align-items:center;gap:9px;min-height:46px;padding:0 12px;border:1px solid var(--divider-color);border-radius:12px;background:color-mix(in srgb,var(--card-background-color) 80%,transparent);cursor:pointer}.mode-target-grid input{width:20px;height:20px}.mode-target-grid span{display:grid}.mode-target-grid small{font-size:11px}.mode-summary{margin:12px 0 0;padding:10px 12px;border-radius:11px;background:color-mix(in srgb,var(--primary-color) 12%,transparent);color:var(--primary-text-color)}.mode-bulk-card .wizard-mode-rule{padding-inline:13px}@media(max-width:950px){.bulk-controls{grid-template-columns:repeat(2,minmax(0,1fr))}.bulk-exceptions>article{grid-template-columns:1fr 1fr}.mode-bulk-card>header{grid-template-columns:32px 1fr!important}.mode-targets>header{align-items:flex-start;flex-direction:column}}`;

const MODE_RESPONSIVE_CSS = `.wizard>main,.wizard-mode-list.full{min-width:0;overflow-x:hidden}.mode-bulk-card,.mode-bulk-card *{box-sizing:border-box;min-width:0}.mode-bulk-card{width:100%;max-width:100%;overflow:hidden}.mode-bulk-card>header{grid-template-columns:32px repeat(2,minmax(0,1fr))!important;align-items:end!important}.mode-bulk-card>header>*{min-width:0}.mode-bulk-card>header label{display:grid}.mode-bulk-card>header input{width:100%;max-width:100%;min-width:0}.mode-bulk-card>header>.danger{grid-column:2/-1;justify-self:end}.mode-target-grid{grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr))}.mode-bulk{grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(105px,.55fr) auto!important}.mode-bulk>.primary{min-width:140px}@media(max-width:1050px){.mode-bulk{grid-template-columns:repeat(2,minmax(0,1fr))!important}.mode-bulk>.primary{grid-column:1/-1}.mode-targets>header{align-items:flex-start;flex-direction:column}}@media(max-width:700px){.mode-bulk-card>header{grid-template-columns:28px minmax(0,1fr)!important}.mode-bulk-card>header label,.mode-bulk-card>header>.danger{grid-column:2}.mode-bulk-card>header>.danger{justify-self:stretch}.mode-bulk{grid-template-columns:1fr!important}}`;
const WIZARD_NAV_AUDIT_CSS = `.wizard>nav button span{display:block!important;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:clamp(9px,1vw,13px)}@media(max-width:720px){.wizard>nav{gap:2px!important;padding-inline:6px!important}.wizard>nav button{padding-inline:2px!important;gap:3px!important}.wizard>nav button i{width:22px!important;height:22px!important}.wizard>nav button span{font-size:9px!important}}`;

const WIZARD_ORDER_CSS = `.wizard-layout-group{display:grid!important;gap:10px;padding:12px!important;border:1px solid var(--divider-color);border-radius:13px}.wizard-layout-group>header{display:grid;grid-template-columns:minmax(140px,.7fr) minmax(180px,1fr) auto auto;align-items:center;gap:10px}.wizard-layout-group>header>span{display:grid}.order-buttons{display:flex;gap:6px}.order-buttons button,.wizard-row-order button{min-width:42px}.wizard-row-order{display:grid;gap:6px}.wizard-row-order>div{display:grid;grid-template-columns:minmax(0,1fr) 42px 42px;align-items:center;gap:6px;padding:7px 9px;border:1px solid color-mix(in srgb,var(--divider-color) 70%,transparent);border-radius:9px;background:color-mix(in srgb,var(--secondary-background-color) 60%,transparent)}.wizard-row-order span{display:grid;min-width:0}.wizard-row-order small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--secondary-text-color)}@media(max-width:750px){.wizard-layout-group>header{grid-template-columns:1fr auto}.wizard-layout-group>header>input{grid-column:1/-1}}`;

const ROW_NAME_CSS = `.wizard-row-order.editable>div{grid-template-columns:minmax(240px,1fr) minmax(220px,1fr) 44px 44px!important}.wizard-row-order.editable label{display:grid;gap:4px}.wizard-row-order.editable label span,.wizard-row-order.editable small{color:var(--secondary-text-color);font-size:11px}.wizard-row-order.editable input{min-height:42px}@media(max-width:800px){.wizard-row-order.editable>div{grid-template-columns:1fr 44px 44px!important}.wizard-row-order.editable small{grid-column:1/-1;grid-row:2}}`;

class HeatingScheduleCardEditor extends HTMLElement {
  setConfig(value) { this.config = migrateConfig(value); this.editorTab ||= "setup"; this.render(); }
  set hass(value) {
    const firstUpdate = !this._hass;
    this._hass = value;
    if (!this._backendLoaded) this.loadBackendMappings();
    if (firstUpdate) this.render();
  }
  connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: "open" }); this.render(); }
  modeLabel(mode) { const preset=this.thermostatConfig?.presets?.find((item)=>item.id===mode); return mode === "on" ? "On" : mode === "hvac_off" ? "Heating off" : preset?.name || MODE_LABELS[mode] || String(mode || "").replace(/[\s_-]+thermostat$/i, "").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
  async loadBackendMappings() {
    if (!this._hass || this._backendLoading || this._backendLoaded) return;
    this._backendLoading = true;
    try {
      const result = await this._hass.callWS({ type: "schedule_control/list" });
      this.backendMappings = result?.mappings || {};
      this.backendCards = result?.cards || {};
      this.thermostatConfig = result?.thermostat_config || {};
      const cardRecord = result?.cards?.[this.config?.card_id];
      this.backendCard = cardRecord || null;
      const owned = cardRecord?.groups || {};
      const deletedGroups = new Set(cardRecord?.deleted_groups || []);
      let removedStale = false;
      if (cardRecord) {
        for (const group of this.config?.groups || []) {
          group.schedules = (group.schedules || []).filter((room) => {
            if (deletedGroups.has(room.group_id)) { removedStale = true; return false; }
            if (owned[room.group_id] || pendingSchedule(room.schedule)) return true;
            if (room.schedule && this._hass?.states?.[room.schedule]) return true;
            removedStale = true;
            return false;
          });
        }
        const liveGroupIds = new Set((this.config?.groups || []).flatMap((group) => group.schedules || []).map((room) => room.group_id));
        for (const mode of this.config?.operating_modes || []) {
          for (const groupId of Object.keys(mode.schedules || {})) if (!liveGroupIds.has(groupId)) delete mode.schedules[groupId];
        }
      }
      for (const room of (this.config?.groups || []).flatMap((group) => group.schedules || [])) {
        const saved = owned[room.group_id];
        if (!saved) continue;
        if (saved.schedule) { room.schedule = saved.schedule; room.reset_schedule = false; }
        if (saved.enabled !== undefined) room.enabled = saved.enabled;
      }
      if (cardRecord && this.config?.groups?.length) {
        const moves = [];
        for (const source of this.config.groups) for (const room of source.schedules || []) {
          const destinationName = owned[room.group_id]?.container;
          if (destinationName && destinationName !== source.name) moves.push({ source, room, destinationName });
        }
        for (const { source, room, destinationName } of moves) {
          const destination = this.config.groups.find((group) => group.name === destinationName);
          if (!destination) continue;
          source.schedules = (source.schedules || []).filter((item) => item !== room);
          destination.schedules ||= [];
          if (!destination.schedules.some((item) => item.group_id === room.group_id)) destination.schedules.push(room);
        }
      }
      const existing = new Set((this.config?.groups || []).flatMap((group) => group.schedules || []).map((room) => room.group_id));
      const missing = Object.values(owned).filter((group) => !existing.has(group.group_id));
      if (missing.length) {
        this.config.groups ||= [];
        this.config.groups[0] ||= { name: "Schedules", schedules: [] };
        for (const group of missing) {
          const container = this.config.groups.find((item) => item.name === group.container) || this.config.groups[0];
          container.schedules ||= [];
          container.schedules.push({ name: group.name, group_id: group.group_id, entities: group.targets || [], entity: group.targets?.[0] || "", entity_type: group.entity_type, schedule: group.schedule || "", draft_source: group.draft_source || "", reset_schedule: !group.schedule });
        }
      }
      if (removedStale) fireChanged(this, this.config);
    } catch { this.backendMappings = {}; }
    this._backendLoading = false;
    this._backendLoaded = true;
    this.render();
  }
  resolvedSchedule(room) {
    if (room.reset_schedule) return "";
    if (room.schedule) return room.schedule;
    return this.ownedMappingEntries(room)[0]?.[1]?.schedule || "";
  }
  ownedMappingEntries(room) {
    const prefix = `${this.config.card_id}:${room.group_id}:`;
    return Object.entries(this.backendMappings || {}).filter(([mappingId]) => mappingId.startsWith(prefix));
  }
  async deleteNativeSchedules(scheduleEntities = []) {
    const failures = [];
    for (const schedule of [...new Set(scheduleEntities.filter((value) => String(value || "").startsWith("schedule.")))]) {
      if (!this._hass?.states?.[schedule]) continue;
      try { await this._hass.callWS({ type: "schedule/delete", schedule_id: schedule.slice(9) }); }
      catch (error) {
        let detail = error?.message;
        if (!detail) { try { detail = JSON.stringify(error); } catch { detail = String(error); } }
        failures.push(`${schedule}: ${detail || "unknown error"}`);
      }
    }
    if (failures.length) throw new Error(`Native helper cleanup failed — ${failures.join("; ")}`);
  }
  async resetCardData() {
    if (!window.confirm("Factory reset this Schedule Control card? Every device row, native schedule helper, mapping, boost and mode owned by this card will be permanently removed. This cannot be undone.")) return;
    try {
      const rooms = (this.config.groups || []).flatMap((group) => group.schedules || []);
      const ownedGroups = Object.values(this.backendCard?.groups || {});
      const ownedMappings = Object.entries(this.backendMappings || {}).filter(([mappingId]) => mappingId.startsWith(`${this.config.card_id}:`));
      const schedules = [
        ...rooms.map((room) => room.schedule),
        ...ownedGroups.map((group) => group.schedule),
        ...ownedMappings.map(([, mapping]) => mapping.schedule),
      ];
      const referencedTemplateIds = new Set(rooms.map((room) => room.routine_template_id).filter(Boolean));
      // Fetch the live library here instead of relying on the editor's
      // background load. Reset may be pressed immediately after opening the
      // editor, before that load has completed.
      const liveThermostatConfig = this._hass
        ? await this._hass.callWS({ type: "schedule_control/get_thermostat_config" })
        : this.thermostatConfig || {};
      const thermostatConfig = structuredClone(liveThermostatConfig || {});
      const templates = thermostatConfig.templates || [];
      thermostatConfig.templates = templates.filter((template) => {
        if (template.card_id === this.config.card_id || referencedTemplateIds.has(template.id)) return false;
        // Old builds did not record routine ownership. If this is the only
        // Schedule Control card, those legacy templates are necessarily
        // orphaned and belong in the factory reset as well.
        if (!template.card_id) return false;
        return true;
      });
      // Release backend ownership and live mappings before deleting helpers. Active
      // mappings can immediately re-read/recreate a helper while reset is running.
      if (this._hass && this.config.card_id) {
        await this._hass.callWS({ type: "schedule_control/reset_card", card_id: this.config.card_id });
        if (thermostatConfig.templates.length !== templates.length) {
          this.thermostatConfig = await this._hass.callWS({ type: "schedule_control/set_thermostat_config", configuration: thermostatConfig });
        }
      }
      await this.deleteNativeSchedules(schedules);
      this.wizardDraft = null;
      this.backendMappings = {};
      this.backendCard = null;
      // Use the editor's normal update path so Home Assistant receives and
      // previews the empty configuration immediately. Direct assignment here
      // could leave the preview and outer Save button holding the old rows.
      this.update((next) => {
        next.groups = [];
        next.hot_water = null;
        next.operating_modes = [];
      });
      this.editorMessage = "Factory reset complete — the card is empty and all data it owned was removed.";
      this.render();
    } catch (error) {
      this.editorMessage = `Reset stopped safely: ${error?.message || error}`;
      this.render();
    }
  }
  async cleanupUnusedData() {
    const activeIds = new Set((this.config.groups || []).flatMap((group) => group.schedules || []).map((room) => room.group_id));
    const staleGroups = Object.values(this.backendCard?.groups || {}).filter((group) => !activeIds.has(group.group_id));
    const staleGroupIds = new Set(staleGroups.map((group) => group.group_id));
    const staleMappings = Object.entries(this.backendMappings || {}).filter(([mappingId]) => {
      if (!mappingId.startsWith(`${this.config.card_id}:`)) return false;
      const groupId = mappingId.slice(this.config.card_id.length + 1).split(":")[0];
      return !activeIds.has(groupId);
    });
    const staleSchedules = [...staleGroups.map((group) => group.schedule), ...staleMappings.map(([, mapping]) => mapping.schedule)];
    const nativeCount = new Set(staleSchedules.filter((value) => String(value || "").startsWith("schedule.") && this._hass?.states?.[value])).size;
    if (!staleGroups.length && !staleMappings.length && !nativeCount) {
      this.editorMessage = "Cleanup complete — no unused Schedule Control data was found.";
      this.render();
      return;
    }
    if (!window.confirm(`Clean up unused data? This will remove ${nativeCount} orphaned native schedule helper${nativeCount === 1 ? "" : "s"}, ${staleMappings.length} stale mapping${staleMappings.length === 1 ? "" : "s"}, and ${staleGroups.length} unused ownership record${staleGroups.length === 1 ? "" : "s"}. Active device rows will not be changed.`)) return;
    try {
      await this.deleteNativeSchedules(staleSchedules);
      for (const group of staleGroups) {
        await this._hass.callWS({ type: "schedule_control/remove_group", card_id: this.config.card_id, group_id: group.group_id });
      }
      for (const [mappingId] of staleMappings) {
        if (staleGroupIds.has(mappingId.slice(this.config.card_id.length + 1).split(":")[0])) continue;
        await this._hass.callWS({ type: "schedule_control/delete", mapping_id: mappingId });
      }
      this._backendLoaded = false;
      await this.loadBackendMappings();
      this.editorMessage = `Cleanup complete — removed ${nativeCount} orphaned helper${nativeCount === 1 ? "" : "s"}, ${staleMappings.length} stale mapping${staleMappings.length === 1 ? "" : "s"}, and ${staleGroups.length} unused ownership record${staleGroups.length === 1 ? "" : "s"}.`;
      this.render();
    } catch (error) {
      this.editorMessage = `Cleanup stopped safely: ${error?.message || error}`;
      this.render();
    }
  }
  async deleteGroupSchedule(zoneIndex, roomIndex) {
    const room = this.config.groups[zoneIndex].schedules[roomIndex];
    const ownedMappings = this.ownedMappingEntries(room);
    const ownedGroup = this.backendCard?.groups?.[room.group_id];
    const schedules = [room.schedule, ownedGroup?.schedule, ...ownedMappings.map(([, mapping]) => mapping.schedule)];
    const schedule = schedules.find(Boolean) || "";
    if (schedule && !window.confirm(`Delete ${room.name || "this group"} and its saved schedule? This permanently removes all of its nodes.`)) return;
    try {
      const stillUsed = Object.entries(this.backendMappings || {}).some(([mappingId, mapping]) => !ownedMappings.some(([ownedId]) => ownedId === mappingId) && mapping?.schedule === schedule);
      if (!stillUsed) await this.deleteNativeSchedules(schedules);
      if (this.backendCard) await this._hass.callWS({ type: "schedule_control/remove_group", card_id: this.config.card_id, group_id: room.group_id });
      else for (const [mappingId] of ownedMappings) await this._hass.callWS({ type: "schedule_control/delete", mapping_id: mappingId });
      this.backendMappings = Object.fromEntries(Object.entries(this.backendMappings || {}).filter(([mappingId]) => !ownedMappings.some(([ownedId]) => ownedId === mappingId)));
      this.update((config) => config.groups[zoneIndex].schedules.splice(roomIndex, 1));
    } catch (error) { this.editorMessage = `Could not delete schedule: ${error?.message || error}`; this.render(); }
  }
  async saveWizardConfiguration() {
    const next = migrateConfig(this.wizardDraft);
    const nextIds = new Set(next.groups.flatMap((group) => group.schedules || []).map((room) => room.group_id));
    const removed = (this.config.groups || []).flatMap((group) => group.schedules || []).filter((room) => !nextIds.has(room.group_id));
    try {
      for (const room of removed) {
        const mappings = this.ownedMappingEntries(room);
        const ownedGroup = this.backendCard?.groups?.[room.group_id];
        await this.deleteNativeSchedules([room.schedule, ownedGroup?.schedule, ...mappings.map(([, mapping]) => mapping.schedule)]);
        if (this.backendCard) await this._hass.callWS({ type: "schedule_control/remove_group", card_id: this.config.card_id, group_id: room.group_id });
        else for (const [mappingId] of mappings) await this._hass.callWS({ type: "schedule_control/delete", mapping_id: mappingId });
      }
      for (const room of next.groups.flatMap((group) => group.schedules || [])) {
        const pending = pendingSchedule(room.schedule);
        if (!pending) continue;
        const payload = emptyWeek(pending.name, "mdi:calendar-clock");
        if (room.suggested_week) for (const day of DAYS) payload[day] = structuredClone(room.suggested_week[day] || []);
        const existingEntity = Object.entries(this._hass?.states || {}).find(([entityId, state]) => entityId.startsWith("schedule.") && state.attributes?.friendly_name === pending.name);
        let scheduleId = existingEntity?.[0]?.slice(9);
        if (scheduleId) await this._hass.callWS({ type: "schedule/update", schedule_id: scheduleId, ...payload });
        else { const created = await this._hass.callWS({ type: "schedule/create", ...payload }); scheduleId = created.id; }
        room.schedule = `schedule.${scheduleId}`;
        room.reset_schedule = false;
        room.draft_source = "";
      }
      for (const room of next.groups.flatMap((group) => group.schedules || [])) {
        if (!room.routine_template_id || room.routine_synced === false || !room.suggested_week || !String(room.schedule || "").startsWith("schedule.")) continue;
        const state = this._hass?.states?.[room.schedule];
        if (!state) continue;
        await this._hass.callWS({
          type: "schedule/update",
          schedule_id: room.schedule.slice(9),
          name: state.attributes?.friendly_name || `${room.name || "Device"} Schedule`,
          icon: state.attributes?.icon || "mdi:calendar-clock",
          ...Object.fromEntries(DAYS.map((day) => [day, structuredClone(room.suggested_week[day] || [])])),
        });
      }
      const manifest = next.groups.flatMap((group) => (group.schedules || []).map((room) => ({
        group_id: room.group_id,
        name: room.name || "Device",
        schedule: room.schedule || "",
        targets: room.entities || [room.entity].filter(Boolean),
        entity_type: roomType(room, next.schedule_type),
        enabled: room.enabled !== false,
        boost_entity: room.boost_entity || "",
        boost_timer: room.boost_timer || "",
        container: group.name,
      })));
      await this._hass.callWS({ type: "schedule_control/reconcile", card_id: next.card_id, groups: manifest, modes: next.operating_modes || [] });
      for (const room of next.groups.flatMap((group) => group.schedules || [])) {
        if (!String(room.schedule || "").startsWith("schedule.")) continue;
        for (const entity of room.entities || [room.entity].filter(Boolean)) await this._hass.callWS({
          type: "schedule_control/set",
          mapping_id: `${next.card_id}:${room.group_id}:${entity}`,
          target: entity,
          schedule: room.schedule,
          boost: room.boost_entity || "",
          boost_timer: room.boost_timer || "",
          enabled: room.enabled !== false,
          manual_override_timeout: Number(next.manual_override_timeout || 0),
          week: Object.fromEntries(DAYS.map((day) => [day, structuredClone(room.suggested_week?.[day] || [])])),
        });
      }
      this.config = next;
      this.wizardDraft = null;
      fireChanged(this, this.config);
      // Close the setup workspace as soon as its configuration is committed.
      // Backend hydration may take several seconds and must not leave the
      // finished wizard visibly blocking the dashboard during that wait.
      this.render();
      await this._hass?.callWS({ type: "schedule_control/set_modes", card_id: this.config.card_id, modes: this.config.operating_modes || [] });
      this._backendLoaded = false;
      await this.loadBackendMappings();
      const savedRows = this.config.groups.flatMap((group) => group.schedules || []);
      const blankRows = savedRows.filter((room) => !room.suggested_week && !String(room.schedule || "").startsWith("schedule.")).length;
      this.editorMessage = `Setup complete — ${this.config.groups.length} groups, ${savedRows.length} device rows and ${savedRows.reduce((total, room) => total + (room.entities || [room.entity].filter(Boolean)).length, 0)} entities saved.${blankRows ? ` ${blankRows} row${blankRows === 1 ? " has" : "s have"} a blank timeline.` : " All timelines are configured."}`;
      this.render();
    } catch (error) {
      this.editorMessage = `Setup was not saved because cleanup failed: ${error?.message || error}`;
      this.render();
    }
  }
  async removeGroupEntity(zoneIndex, roomIndex, entityIndex) {
    const room = this.config.groups[zoneIndex].schedules[roomIndex];
    if ((room.entities || []).length <= 1) { await this.deleteGroupSchedule(zoneIndex, roomIndex); return; }
    const entity = room.entities[entityIndex];
    try {
      for (const [mappingId, mapping] of this.ownedMappingEntries(room).filter(([, mapping]) => mapping?.target === entity)) {
        await this._hass.callWS({ type: "schedule_control/delete", mapping_id: mappingId });
        delete this.backendMappings[mappingId];
      }
      this.update((config) => { const target = config.groups[zoneIndex].schedules[roomIndex]; target.entities.splice(entityIndex, 1); target.entity = target.entities[0] || ""; });
    } catch (error) { this.editorMessage = `Could not remove entity: ${error?.message || error}`; this.render(); }
  }
  update(mutator) {
    const next = structuredClone(this.config);
    mutator(next);
    this.config = next;
    fireChanged(this, next);
    this.render();
    if (this._hass && next.card_id) {
      this._hass.callWS({ type: "schedule_control/set_modes", card_id: next.card_id, modes: next.operating_modes || [] }).catch(() => {});
    }
  }
  stageRoomSchedule(zoneIndex, roomIndex, sourceId = "") {
    const room = this.config.groups[zoneIndex].schedules[roomIndex];
    const roomName = room.name || this._hass?.states?.[room.entity]?.attributes?.friendly_name || "Entity";
    const existing = Object.entries(this._hass?.states || {}).filter(([id]) => id.startsWith("schedule.")).map(([id, state]) => ({ id: id.slice(9), name: state.attributes.friendly_name || id }));
    const scheduleName = uniqueScheduleName(`${roomName} Schedule`, existing);
    this.editorMessage = sourceId ? `${scheduleName} will be copied after you save the card.` : `${scheduleName} will be created after you save the card.`;
    this.update((config) => config.groups[zoneIndex].schedules[roomIndex].schedule = pendingScheduleValue(scheduleName, sourceId));
  }
  stageHotWaterSchedule(sourceId = "") {
    const existing = Object.entries(this._hass?.states || {}).filter(([id]) => id.startsWith("schedule.")).map(([id, state]) => ({ id: id.slice(9), name: state.attributes.friendly_name || id }));
    const scheduleName = uniqueScheduleName("Hot Water Schedule", existing);
    this.editorMessage = sourceId ? `${scheduleName} will be copied after you save the card.` : `${scheduleName} will be created after you save the card.`;
    this.update((config) => { if (config.hot_water) config.hot_water.schedule = pendingScheduleValue(scheduleName, sourceId); });
  }
  openWizard() {
    this.wizardDraft = structuredClone(this.config);
    if (!this.wizardDraft.groups?.length) this.wizardDraft.groups = [{ name: "New group", schedules: [] }];
    // Messages describe the previous operation and become misleading as soon as
    // a new setup session begins.
    this.editorMessage = "";
    this.wizardMessage = "";
    this.wizardStep = 0;
    this.wizardEntityType = "climate";
    this.wizardSelected = new Set();
    this.wizardTargetGroup = 0;
    this.render();
  }
  routineTemplates() { return this.thermostatConfig?.templates || []; }
  startingTimelinesHtml() {
    const templates = this.routineTemplates();
    const rows = this.wizardDraft.groups.flatMap((group, gi) => (group.schedules || []).map((room, ri) => ({ group, room, gi, ri })));
    const templateCards = templates.map((template) => `<article><span><b>${esc(template.name)}</b><small>${DAYS.filter((day) => (template.week?.[day] || []).length).map((day) => DAY_LABELS[day]).join(", ") || "No days configured"}</small></span><button data-edit-routine="${esc(template.id)}">Edit</button></article>`).join("");
    const assignments = rows.map(({ group, room, gi, ri }) => {
      const selected = room.routine_template_id || "";
      const state = selected ? (room.routine_synced === false ? "Customised — future routine changes will not alter this row" : "Following routine — routine updates will apply automatically") : "Independent blank timeline";
      return `<label><span><b>${esc(room.name || room.entity)}</b><small>${esc(group.name)} · ${esc(state)}</small></span><select data-plan-assignment="${gi}:${ri}"><option value="" ${!selected ? "selected" : ""}>New blank timeline</option>${templates.map((template) => `<option value="${esc(template.id)}" ${selected === template.id ? "selected" : ""}>${esc(template.name)}</option>`).join("")}</select></label>`;
    }).join("");
    return `<div class="wizard-copy"><h2>Weekly plans</h2><p>Build reusable routines, then use one as the starting point for any device row. Rows follow routine updates until you edit that row directly on the main timeline.</p><button class="primary wizard-subtool" data-new-routine><ha-icon icon="mdi:calendar-plus"></ha-icon><span><b>Build my routine</b><small>Create a named Weekdays, Weekends or other reusable plan.</small></span><ha-icon icon="mdi:chevron-right"></ha-icon></button></div><section class="routine-library"><header><h3>Saved routines</h3><small>${templates.length} available</small></header>${templateCards || "<p>No routines saved yet. Build your first routine above.</p>"}</section><section class="plan-assignments"><header><h3>Assign starting plans</h3><small>Each row receives its own editable timeline.</small></header><div class="wizard-start-list">${assignments || "<p>Add device rows before assigning weekly plans.</p>"}</div></section>`;
  }
  openRoutineSetup(templateId = "") {
    const presets = this.thermostatConfig?.presets || [];
    const defaultPreset = (id, index) => presets.find((item) => item.id === id)?.id || presets[index]?.id || id;
    const existing = this.routineTemplates().find((item) => item.id === templateId);
    const meta = existing?.routine || {};
    const phase = (key, time, preset, index) => ({ time, preset: defaultPreset(preset, index), override: false, temperature: Number(presets.find((item) => item.id === defaultPreset(preset, index))?.temperature ?? 20), ...(meta[key] || {}) });
    const availableName = uniqueScheduleName("New routine", this.routineTemplates());
    this.routineSetup = { id: existing?.id || `routine_${Date.now()}`, editing: Boolean(existing), step: 0, name: existing?.name || availableName, days: meta.days || ["monday","tuesday","wednesday","thursday","friday"], wake: phase("wake","06:30","comfort",0), leave: phase("leave","08:30","away",2), daytime: { enabled:false, end:"15:00", ...phase("daytime","12:00","eco",1), ...(meta.daytime || {}) }, returned: phase("returned","17:30","comfort",0), bed: phase("bed","22:30","night",3) };
    this.routineSetupError = "";
    this.render();
  }
  routineSetupHtml() {
    const draft = this.routineSetup; if (!draft) return "";
    const steps = ["Wake up","Leave home","Daytime","Return home","Bedtime","Name & days"];
    const presets = this.thermostatConfig?.presets || [];
    const phaseEditor = (key, question, help) => { const value=draft[key]; return `<div class="routine-question"><h2>${question}</h2><p>${help}</p><label>Time<input type="time" data-rs-time="${key}" value="${value.time}"></label><label>Preset<select data-rs-preset="${key}">${presets.map((preset)=>`<option value="${esc(preset.id)}" ${value.preset===preset.id?"selected":""}>${esc(preset.name)} · ${Number(preset.temperature).toFixed(1)}°C</option>`).join("")}</select></label><label class="wizard-toggle"><input type="checkbox" data-rs-override="${key}" ${value.override?"checked":""}><span><b>Override preset temperature</b><small>Use a different temperature for this routine period only.</small></span></label>${value.override?`<label>Temperature<input type="number" min="5" max="35" step="0.5" data-rs-temperature="${key}" value="${Number(value.temperature)}"></label>`:""}</div>`; };
    let body = draft.step===0?phaseEditor("wake","What time do you wake up?","This begins the first occupied heating period of the day."):draft.step===1?phaseEditor("leave","What time do you leave home?","Choose the preset used while the home is normally empty."):draft.step===3?phaseEditor("returned","What time do you return home?","Choose the preset used for the evening."):draft.step===4?phaseEditor("bed","What time do you go to bed?","This preset continues overnight until the next wake-up time."):"";
    if(draft.step===2) body=`<div class="routine-question"><h2>Do you need extra heating during the day?</h2><p>If disabled, the leave-home preset continues until you return.</p><label class="wizard-toggle"><input type="checkbox" data-rs-day-enabled ${draft.daytime.enabled?"checked":""}><span><b>Add a daytime heating period</b><small>Create an additional node between leaving and returning.</small></span></label>${draft.daytime.enabled?`${phaseEditor("daytime","Daytime heating period","Choose when it starts and how it should heat.")}<label>End time<input type="time" data-rs-day-end value="${draft.daytime.end}"></label>`:""}</div>`;
    if(draft.step===5) body=`<div class="routine-question"><h2>Name this routine and choose its days</h2><p>The routine becomes a reusable starting plan in Schedule Control.</p><label>Routine name<input data-rs-name value="${esc(draft.name)}" placeholder="Normal weekdays"></label><fieldset><legend>Apply this routine to</legend><div class="routine-days">${DAYS.map(day=>`<label><input type="checkbox" data-rs-day="${day}" ${draft.days.includes(day)?"checked":""}>${DAY_LABELS[day]}</label>`).join("")}</div></fieldset></div>`;
    return `<div class="wizard-backdrop"><div class="wizard routine-setup"><header><div><small>Build my routine</small><h1>${steps[draft.step]}</h1></div><button data-rs-close>×</button></header><nav>${steps.map((step,index)=>`<button data-rs-step="${index}" class="${index===draft.step?"active":""}"><i>${index+1}</i><span>${step}</span></button>`).join("")}</nav><main>${this.routineSetupError?`<p class="message">${esc(this.routineSetupError)}</p>`:""}${body}</main><footer><button data-rs-close>Cancel</button><span>Step ${draft.step+1} of 6</span>${draft.step?"<button data-rs-back>Back</button>":""}${draft.step<5?"<button class=\"primary\" data-rs-next>Continue</button>":`<button class="primary" data-rs-save>${draft.editing?"Save routine changes":"Save routine"}</button>`}</footer></div></div>`;
  }
  layoutSetupHtml(draft) {
    return `<div class="wizard-copy"><h2>Arrange and name the card</h2><p>Groups are headings such as Downstairs or Bedrooms. Give every row a short dashboard name here; the Home Assistant entity ID remains unchanged.</p></div><div class="wizard-groups-first">${draft.groups.map((group,index)=>`<section class="wizard-layout-group"><header><span><b>Group ${index+1}</b><small>Heading shown above these rows.</small></span><input data-wizard-group-name="${index}" value="${esc(group.name)}"><div class="order-buttons"><button data-wizard-group-up="${index}" ${index===0?"disabled":""}>↑</button><button data-wizard-group-down="${index}" ${index===draft.groups.length-1?"disabled":""}>↓</button></div><button data-wizard-remove-group="${index}" ${group.schedules.length?"disabled title=\"Move or remove its rows first\"":""}>Remove</button></header><div class="wizard-row-order editable">${group.schedules.map((room,ri)=>`<div><label><span>Name shown on card</span><input data-wizard-row-name="${index}:${ri}" value="${esc(room.name||room.entity)}"></label><small>${esc((room.entities||[room.entity]).join(", "))}</small><button data-wizard-row-up="${index}:${ri}" ${ri===0?"disabled":""}>↑</button><button data-wizard-row-down="${index}:${ri}" ${ri===group.schedules.length-1?"disabled":""}>↓</button></div>`).join("")||"<small>No device rows in this group yet.</small>"}</div></section>`).join("")}<button class="primary" data-wizard-add-group>+ Add group</button></div>`;
  }
  bulkBoostSetupHtml(draft) {
    const climateRows = draft.groups.flatMap((group, gi) => group.schedules.map((room, ri) => ({ group, room, gi, ri })).filter(({ room }) => roomType(room) === "climate"));
    const scopes = `<option value="all">All climate rows</option>${draft.groups.map((group, gi) => `<option value="group:${gi}">${esc(group.name)}</option>`).join("")}`;
    const details = draft.groups.map((group, gi) => { const rows=group.schedules.map((room,ri)=>({room,ri})).filter(({room})=>roomType(room)==="climate"); if(!rows.length)return ""; return `<details class="bulk-exceptions"><summary><span><b>${esc(group.name)} exceptions</b><small>Only open this when one thermostat needs different boost defaults.</small></span><ha-icon icon="mdi:chevron-down"></ha-icon></summary>${rows.map(({room,ri})=>{const boost={enabled:true,duration:60,temperature:22,...(room.native_boost||{})};return `<article><b>${esc(room.name||room.entity)}</b><label><input type="checkbox" data-wizard-boost-enabled="${gi}:${ri}" ${boost.enabled?"checked":""}> Enabled</label><select aria-label="Default duration" data-wizard-boost-duration="${gi}:${ri}">${[15,30,45,60,90,120,180].map(v=>`<option value="${v}" ${Number(boost.duration)===v?"selected":""}>${v} min</option>`).join("")}</select><label><input type="number" min="5" max="65" step="0.5" value="${Number(boost.temperature)}" data-wizard-boost-temperature="${gi}:${ri}"> °C</label></article>`}).join("")}</details>`; }).join("");
    return `<div class="wizard-copy"><h2>Presets and boost</h2><p>Set the normal boost behaviour once for the whole card or one group. Individual exceptions are optional.</p><button class="wizard-subtool" data-open-presets><ha-icon icon="mdi:thermostat-cog"></ha-icon><span><b>Edit shared thermostat presets</b><small>One preset library is used by every climate row.</small></span><ha-icon icon="mdi:chevron-right"></ha-icon></button></div><section class="bulk-setup"><header><ha-icon icon="mdi:fire"></ha-icon><span><h3>Apply boost defaults</h3><small>${climateRows.length} climate rows available</small></span></header><div class="bulk-controls"><label>Apply to<select data-bulk-boost-scope>${scopes}</select></label><label class="wizard-toggle compact"><input type="checkbox" data-bulk-boost-enabled checked><span><b>Boost enabled</b><small>Show the one-tap flame button.</small></span></label><label>Default duration<select data-bulk-boost-duration>${[15,30,45,60,90,120,180].map(v=>`<option value="${v}" ${v===60?"selected":""}>${v} min</option>`).join("")}</select></label><label>Boost temperature<input type="number" min="5" max="65" step="0.5" value="22" data-bulk-boost-temperature></label><button class="primary" data-apply-bulk-boost>Apply to selected rows</button></div><p class="bulk-result">Choose a scope once instead of editing every thermostat.</p></section>${details}`;
  }
  bulkModesSetupHtml(draft) {
    const sharedPresets=(this.thermostatConfig?.presets||[]).map(p=>p.id);
    const cards=(draft.operating_modes||[]).map((mode,index)=>{mode.schedules ||= {};const climateGroups=draft.groups.map((group,gi)=>({group,gi,rows:group.schedules.filter(room=>roomType(room)==="climate")})).filter(item=>item.rows.length);const targeted=climateGroups.filter(({rows})=>rows.some(room=>mode.schedules[room.group_id]?.action&&mode.schedules[room.group_id]?.action!=="none"));const targetedRules=targeted.flatMap(({rows})=>rows.map(room=>mode.schedules[room.group_id]).filter(rule=>rule?.action==="preset"));const bulkPreset=targetedRules[0]?.preset||sharedPresets[0]||"away";const bulkTemperature=Number(targetedRules[0]?.temperature??this.thermostatConfig?.presets?.find(item=>item.id===bulkPreset)?.temperature??12);const presetOptions=(sharedPresets.length?sharedPresets:["away","eco","comfort"]).map(p=>`<option value="${esc(p)}" ${p===bulkPreset?"selected":""}>${esc(this.modeLabel(p))}</option>`).join("");const targetPicker=climateGroups.map(({group,gi,rows})=>`<label><input type="checkbox" data-bulk-mode-group="${index}:${gi}" ${targeted.some(item=>item.gi===gi)?"checked":""}><span><b>${esc(group.name)}</b><small>${rows.length} thermostat${rows.length===1?"":"s"}</small></span></label>`).join("");const affected=targeted.reduce((sum,item)=>sum+item.rows.length,0);const excluded=climateGroups.filter(item=>!targeted.some(selected=>selected.gi===item.gi)).map(item=>item.group.name);const exceptions=draft.groups.flatMap(group=>group.schedules.map(room=>{const type=roomType(room);const rule=mode.schedules[room.group_id]||{action:"none"};const presets=type==="climate"?(sharedPresets.length?sharedPresets:["away","eco","comfort"]):[];return `<div class="wizard-mode-rule"><span><b>${esc(room.name||room.entity)}</b><small>${esc(group.name)} · ${esc(type)}</small></span><label>Action<select data-wizard-mode-action="${index}:${esc(room.group_id)}"><option value="none" ${rule.action==="none"?"selected":""}>Not affected</option>${type==="climate"?`<option value="preset" ${rule.action==="preset"?"selected":""}>Set preset temperature</option><option value="off" ${rule.action==="off"?"selected":""}>Turn heating off</option>`:`<option value="on" ${rule.action==="on"?"selected":""}>On</option><option value="off" ${rule.action==="off"?"selected":""}>Off</option>`}</select></label>${type==="climate"?`<label>Preset<select data-wizard-mode-preset="${index}:${esc(room.group_id)}" ${rule.action!=="preset"?"disabled":""}>${presets.map(p=>`<option value="${esc(p)}" ${rule.preset===p?"selected":""}>${esc(this.modeLabel(p))}</option>`).join("")}</select></label><label>Temperature<input type="number" min="5" max="35" step="0.5" value="${Number(rule.temperature??12)}" data-wizard-mode-temperature="${index}:${esc(room.group_id)}" ${rule.action!=="preset"?"disabled":""}></label>`:""}</div>`})).join("");return `<section class="mode-bulk-card"><header><ha-icon icon="${esc(mode.icon)}"></ha-icon><label>Mode name<input data-wizard-mode-name="${index}" value="${esc(mode.name)}"></label><label>Icon<input data-wizard-mode-icon="${index}" value="${esc(mode.icon)}"></label><button class="danger" data-wizard-remove-mode="${index}">Remove</button></header><div class="mode-targets"><header><span><b>Affected groups</b><small>Select several groups and apply the mode once.</small></span><div class="mode-target-actions"><button data-bulk-mode-select-all="${index}">Select all</button><button data-bulk-mode-clear="${index}">Clear</button></div></header><div class="mode-target-grid">${targetPicker}</div></div><div class="bulk-controls mode-bulk"><label>Action<select data-bulk-mode-action="${index}"><option value="preset">Set preset temperature</option><option value="off" ${targetedRules.length===0&&targeted.length?"selected":""}>Turn heating off</option></select></label><label>Preset<select data-bulk-mode-preset="${index}" ${targetedRules.length===0&&targeted.length?"disabled":""}>${presetOptions}</select></label><label>Temperature<input type="number" min="5" max="35" step="0.5" value="${bulkTemperature}" data-bulk-mode-temperature="${index}" ${targetedRules.length===0&&targeted.length?"disabled":""}></label><button class="primary" data-apply-bulk-mode="${index}">Apply mode</button></div><p class="mode-summary" data-mode-summary="${index}">${affected?`${affected} thermostat${affected===1?"":"s"} affected${excluded.length?`; ${esc(excluded.join(", "))} unaffected`:""}.`:"No groups selected. This mode currently affects nothing."}</p><details class="bulk-exceptions"><summary><span><b>Individual exceptions</b><small>Review or change only the rows that differ.</small></span><ha-icon icon="mdi:chevron-down"></ha-icon></summary>${exceptions}</details></section>`}).join("");
    return `<div class="wizard-copy"><h2>Operating modes</h2><p>Create the mode, choose a group, and apply one preset and temperature to every selected thermostat. Open Individual exceptions only when a row must behave differently.</p></div><div class="wizard-mode-list full">${cards||"<p>No additional modes configured.</p>"}<button data-wizard-add-mode>+ Add operating mode</button></div>`;
  }
  wizardHtml() {
    if (!this.wizardDraft) return "";
    const draft = this.wizardDraft;
    const steps = ["Card", "Layout", "Devices", "Starting timelines", "Presets & boost", "Modes", "Maintenance"];
    const assigned = new Set(draft.groups.flatMap((group) => group.schedules.flatMap((room) => room.entities || [room.entity].filter(Boolean))));
    const copyableRows = draft.groups.flatMap((section) => section.schedules || []).filter((row) => String(row.schedule || "").startsWith("schedule.") && this._hass?.states?.[row.schedule]).map((row) => ({ id: row.schedule, name: row.name || this._hass.states[row.schedule]?.attributes?.friendly_name || row.schedule }));
    const entities = Object.entries(this._hass?.states || {}).filter(([id]) => id.startsWith(`${this.wizardEntityType}.`)).sort((a,b)=>String(a[1].attributes.friendly_name||a[0]).localeCompare(String(b[1].attributes.friendly_name||b[0])));
    let body = "";
    if (this.wizardStep === 0) body = `<div class="wizard-copy"><h2>Card fundamentals</h2><p>These settings affect how the card looks and how precisely periods can be placed. They do not alter any entity until the wizard is saved.</p></div><div class="wizard-form"><label>Card title<small>Displayed at the top of the schedule card.</small><input data-wizard-title value="${esc(draft.title)}"></label><label>Minimum period<small>Controls the time increments offered while editing nodes.</small><select data-wizard-min>${[5,10,15,30,60].map(value=>`<option value="${value}" ${Number(draft.minimum_period)===value?"selected":""}>${value} minutes</option>`).join("")}</select></label><label class="wizard-toggle"><input type="checkbox" data-wizard-status ${draft.show_status?"checked":""}><span><b>Status bar</b><small>Show health, current action, next change and mode.</small></span></label><label class="wizard-toggle"><input type="checkbox" data-wizard-astro ${draft.show_astronomical_markers?"checked":""}><span><b>Sunrise and sunset markers</b><small>Display astronomical events on the main timeline.</small></span></label></div>`;
    if (this.wizardStep === 1) body = `<div class="wizard-copy"><h2>Arrange the card layout</h2><p>Groups are visual headings such as Downstairs or Bedrooms. Rows are the devices, or groups of devices, shown beneath them. Use the arrow buttons to set their display order.</p></div><div class="wizard-groups-first">${draft.groups.map((group,index)=>`<section class="wizard-layout-group"><header><span><b>Group ${index+1}</b><small>Name the heading that will contain related device rows.</small></span><input data-wizard-group-name="${index}" value="${esc(group.name)}"><div class="order-buttons"><button data-wizard-group-up="${index}" ${index===0?"disabled":""} aria-label="Move group up">↑</button><button data-wizard-group-down="${index}" ${index===draft.groups.length-1?"disabled":""} aria-label="Move group down">↓</button></div><button data-wizard-remove-group="${index}" ${group.schedules.length?"disabled title=\"Move or remove its device rows first\"":""}>Remove</button></header><div class="wizard-row-order">${group.schedules.map((room,ri)=>`<div><span><b>${esc(room.name||room.entity)}</b><small>${esc(room.entity)}</small></span><button data-wizard-row-up="${index}:${ri}" ${ri===0?"disabled":""} aria-label="Move row up">↑</button><button data-wizard-row-down="${index}:${ri}" ${ri===group.schedules.length-1?"disabled":""} aria-label="Move row down">↓</button></div>`).join("")||"<small>No device rows in this group yet.</small>"}</div></section>`).join("")}<button class="primary" data-wizard-add-group>+ Add group</button></div>`;
    if (this.wizardStep === 0) body = body.replace('<label class="wizard-toggle"><input type="checkbox" data-wizard-status', `<label>Manual override timeout<small>Return a manually changed thermostat to its schedule after this time, or sooner when the next node begins.</small><select data-wizard-manual-timeout><option value="0" ${Number(draft.manual_override_timeout||0)===0?"selected":""}>Next scheduled node only</option>${[15,30,45,60,90,120,180,240].map(value=>`<option value="${value}" ${Number(draft.manual_override_timeout)===value?"selected":""}>${value<60?`${value} minutes`:`${value/60} hour${value===60?"":"s"}`}</option>`).join("")}</select></label><label class="wizard-toggle"><input type="checkbox" data-wizard-status`);
    if (this.wizardStep === 2) {
      const rows = draft.groups.flatMap((group,gi)=>(group.schedules||[]).map((room,ri)=>({group,room,gi,ri})));
      const available = entities.filter(([id])=>!assigned.has(id));
      const added = rows.filter(({room})=>roomType(room)===this.wizardEntityType);
      const selectedCount = [...this.wizardSelected].filter(id=>available.some(([candidate])=>candidate===id)).length;
      body = `<div class="wizard-copy"><h2>Add and organise devices</h2><p>First choose the destination group, then select only the new devices you want to add. Devices already on the card are listed separately with their dashboard name and group.</p></div><div class="wizard-discover"><div class="wizard-domain">${Object.entries(PROFILES).map(([type,p])=>`<button data-wizard-domain="${type}" class="${this.wizardEntityType===type?"active":""}"><ha-icon icon="${p.icon}"></ha-icon><span><b>${p.label}</b><small>${type==="climate"?"Thermostats and HVAC":type==="light"?"Lights with supported brightness and colour":"On/off devices and relays"}</small></span></button>`).join("")}</div><section class="wizard-added"><header><span><h3>Already added</h3><small>${added.length} ${esc(PROFILES[this.wizardEntityType].label.toLowerCase())} row${added.length===1?"":"s"} on this card</small></span></header><div class="wizard-added-list">${added.map(({group,room,gi,ri})=>`<article><ha-icon icon="${esc(PROFILES[this.wizardEntityType].icon)}"></ha-icon><label><small>Name shown on card</small><input data-wizard-device-name="${gi}:${ri}" value="${esc(room.name||room.entity)}"></label><label><small>Assigned group</small><select data-wizard-device-group="${gi}:${ri}">${draft.groups.map((candidate,index)=>`<option value="${index}" ${index===gi?"selected":""}>${esc(candidate.name)}</option>`).join("")}</select></label><small class="entity-id">${esc((room.entities||[room.entity]).join(", "))}</small><button class="danger" data-wizard-remove-device="${gi}:${ri}">Remove</button></article>`).join("")||`<p>No ${esc(PROFILES[this.wizardEntityType].label.toLowerCase())} devices have been added yet.</p>`}</div></section><section class="wizard-available"><header><span><h3>Available devices</h3><small>Tick devices below, then add them to the selected group.</small></span><div class="wizard-add-destination"><label><small>Add selected devices to</small><select data-wizard-target-group>${draft.groups.map((group,index)=>`<option value="${index}" ${index===Math.min(this.wizardTargetGroup,draft.groups.length-1)?"selected":""}>${esc(group.name)}</option>`).join("")}</select></label><strong data-wizard-selection-summary>${selectedCount?`${selectedCount} selected → ${esc(draft.groups[Math.min(this.wizardTargetGroup,draft.groups.length-1)]?.name||"group")}`:"No devices selected"}</strong><button class="primary" data-wizard-add-selected ${selectedCount?"":"disabled"}>Add selected devices</button></div></header><div class="wizard-discover-tools"><input type="search" data-wizard-search placeholder="Search available name or entity ID"><button data-wizard-select-all>Select all available</button><button data-wizard-clear-selected>Clear selection</button></div><div class="wizard-entity-list">${available.map(([id,state])=>`<label data-wizard-entity-row><input type="checkbox" data-wizard-entity="${esc(id)}" ${this.wizardSelected.has(id)?"checked":""}><ha-icon icon="${esc(state.attributes.icon || PROFILES[this.wizardEntityType].icon)}"></ha-icon><span><b>${esc(state.attributes.friendly_name || id)}</b><small>${esc(id)}</small></span></label>`).join("") || `<p>All available ${esc(PROFILES[this.wizardEntityType].label.toLowerCase())} devices are already on this card.</p>`}</div></section></div>`;
    }
if (this.wizardStep === 4) body = `<div class="wizard-copy"><h2>Presets and boost</h2><p>Shared presets define the standard temperatures, colours and icons. Boost settings below are specific to each device row and can be changed at the time boost is started.</p><button class="wizard-subtool" data-open-presets><ha-icon icon="mdi:thermostat-cog"></ha-icon><span><b>Edit shared thermostat presets</b><small>All climate rows on this card are included automatically.</small></span><ha-icon icon="mdi:chevron-right"></ha-icon></button></div><div class="wizard-group-list">${draft.groups.map((group,gi)=>`<section><header><b>${esc(group.name)}</b><span>${group.schedules.filter(room=>roomType(room)==="climate").length} climate device rows</span></header>${group.schedules.map((room,ri)=>{const climate=roomType(room)==="climate";const boost={enabled:true,duration:60,temperature:22,durations:[15,30,60,90,120],...(room.native_boost||{})};return climate?`<article><div><b>${esc(room.name||room.entity)}</b><small>${esc((room.entities||[room.entity]).join(", "))}</small></div><label class="wizard-toggle compact"><input type="checkbox" data-wizard-boost-enabled="${gi}:${ri}" ${boost.enabled?"checked":""}><span><b>Enable Schedule Control boost</b><small>Adds the flame control to this device row.</small></span></label><label>Default duration<small>Preselected when the boost panel opens.</small><select data-wizard-boost-duration="${gi}:${ri}">${[15,30,45,60,90,120,180].map(v=>`<option value="${v}" ${Number(boost.duration)===v?"selected":""}>${v} min</option>`).join("")}</select></label><label>Boost temperature<small>Temporary target while boost is active.</small><input type="number" min="5" max="65" step="0.5" value="${Number(boost.temperature)}" data-wizard-boost-temperature="${gi}:${ri}"></label></article>`:""}).join("")||"<p>Add climate schedules to configure boost.</p>"}</section>`).join("")}</div>`;
    if (this.wizardStep === 3) body = `<div class="wizard-copy"><h2>Choose how timelines begin</h2><p>Every device row owns a timeline. Start blank, copy an existing device row as an independent starting point, or answer a few routine questions and let the wizard generate editable climate nodes.</p></div><div class="wizard-start-list">${draft.groups.flatMap((group,gi)=>group.schedules.map((room,ri)=>`<label><span><b>${esc(room.name||room.entity)}</b><small>${esc(group.name)} · ${esc(roomType(room))}</small></span><select data-wizard-start="${gi}:${ri}"><option value="blank">New blank timeline</option>${copyableRows.filter((source)=>source.id!==room.schedule).map((source)=>`<option value="copy:${esc(source.id)}">Copy timeline from ${esc(source.name)}</option>`).join("")}${roomType(room)==="climate"?`<option value="routine">Build from my routine</option>`:""}</select></label>`)).join("")||"<p>Add entities before choosing a schedule.</p>"}</div><details class="routine-builder" open><summary><ha-icon icon="mdi:home-clock"></ha-icon><span><b>Build from my routine</b><small>Generate a sensible first weekly climate schedule.</small></span></summary><div class="routine-grid"><label>Wake-up time<small>Comfort begins before the household gets up.</small><input type="time" data-routine-wake value="06:30"></label><label>Leave time<small>When the house can move to the away temperature.</small><input type="time" data-routine-leave value="08:30"></label><label>Return time<small>Comfort resumes for the evening.</small><input type="time" data-routine-return value="17:30"></label><label>Bedtime<small>The overnight temperature begins here.</small><input type="time" data-routine-bed value="22:30"></label><label>Home temperature<small>Used after waking and after returning.</small><input type="number" min="5" max="35" step="0.5" data-routine-home value="20"></label><label>Away temperature<small>Used while the home is empty.</small><input type="number" min="5" max="35" step="0.5" data-routine-away value="16"></label><label>Overnight temperature<small>Used between bedtime and wake-up.</small><input type="number" min="5" max="35" step="0.5" data-routine-night value="17"></label><label class="wizard-toggle"><input type="checkbox" data-routine-occupied><span><b>Someone is normally home during the day</b><small>Keep the home temperature instead of using Away.</small></span></label></div><fieldset><legend>Apply the generated routine to</legend>${draft.groups.flatMap((group,gi)=>group.schedules.map((room,ri)=>roomType(room)==="climate"?`<label><input type="checkbox" data-routine-target="${gi}:${ri}" checked>${esc(room.name||room.entity)}</label>`:"")).join("")}</fieldset><button class="primary" data-generate-routine>Generate suggested schedules</button><p class="routine-result">${esc(this.wizardRoutineMessage||"The generated nodes remain completely editable after setup.")}</p></details>`;
    if (this.wizardStep === 5) body = `<div class="wizard-copy"><h2>Operating modes</h2><p>Give each mode a recognisable name and Material Design icon, then choose exactly which schedules it affects. “Not affected” leaves that schedule under normal control. Climate modes can set a preset and temperature; lighting and switches can be turned on or off.</p></div><div class="wizard-mode-list full">${draft.operating_modes.map((mode,index)=>`<section><header><label>Mode name<input data-wizard-mode-name="${index}" value="${esc(mode.name)}"></label><label>Icon<input data-wizard-mode-icon="${index}" value="${esc(mode.icon)}" placeholder="mdi:home-export-outline"></label><ha-icon icon="${esc(mode.icon)}"></ha-icon><button class="danger" data-wizard-remove-mode="${index}">Remove</button></header>${draft.groups.flatMap(group=>group.schedules.map(room=>{const type=roomType(room);const rule=mode.schedules?.[room.group_id]||{action:"none"};const presets=type==="climate"?(this._hass?.states?.[room.entity]?.attributes?.preset_modes||["away","eco","comfort"]):[];return `<div class="wizard-mode-rule"><span><b>${esc(room.name||room.entity)}</b><small>${esc(group.name)} · ${esc(type)}</small></span><label>What this mode does<select data-wizard-mode-action="${index}:${esc(room.group_id)}"><option value="none" ${rule.action==="none"?"selected":""}>Not affected</option>${type==="climate"?`<option value="preset" ${rule.action==="preset"?"selected":""}>Set preset and temperature</option>`:`<option value="on" ${rule.action==="on"?"selected":""}>Turn on</option><option value="off" ${rule.action==="off"?"selected":""}>Turn off</option>`}</select></label>${type==="climate"?`<label>Preset<select data-wizard-mode-preset="${index}:${esc(room.group_id)}" ${rule.action!=="preset"?"disabled":""}>${presets.map(p=>`<option value="${esc(p)}" ${rule.preset===p?"selected":""}>${esc(this.modeLabel(p))}</option>`).join("")}</select></label><label>Temperature<input type="number" min="5" max="35" step="0.5" value="${Number(rule.temperature??12)}" data-wizard-mode-temperature="${index}:${esc(room.group_id)}" ${rule.action!=="preset"?"disabled":""}></label>`:""}</div>`})).join("")||"<p>Add schedules before configuring this mode.</p>"}</section>`).join("")||"<p>No additional modes configured.</p>"}<button data-wizard-add-mode>+ Add operating mode</button></div>`;
    if (this.wizardStep === 1) body = this.layoutSetupHtml(draft);
    if (this.wizardStep === 4) body = this.bulkBoostSetupHtml(draft);
    if (this.wizardStep === 5) body = this.bulkModesSetupHtml(draft);
    if (this.wizardStep === 3) body = this.startingTimelinesHtml();
    const scheduleCount = draft.groups.reduce((count,group)=>count+group.schedules.length,0); const entityCount = new Set(draft.groups.flatMap(group=>group.schedules.flatMap(room=>room.entities||[]))).size; const boostCount = draft.groups.flatMap(group=>group.schedules).filter(room=>roomType(room)==="climate"&&room.native_boost?.enabled!==false).length;
    const blankRows = draft.groups.flatMap((group) => group.schedules || []).filter((room) => !room.suggested_week && !String(room.schedule || "").startsWith("schedule.")).length;
    if (this.wizardStep === 6) body = `<div class="wizard-copy"><h2>Review and finish</h2><p>Nothing is committed until you press Save and finish. Each device row owns an independent timeline and remains editable from the main card.</p></div>${blankRows?`<p class="wizard-warning"><ha-icon icon="mdi:alert-outline"></ha-icon><b>${blankRows} device row${blankRows===1?" has":"s have"} a blank timeline.</b> These devices will remain off until periods are added.</p>`:`<p class="wizard-success"><ha-icon icon="mdi:check-circle-outline"></ha-icon>Every device row has a starting timeline.</p>`}<div class="wizard-review"><div><b>${draft.groups.length}</b><span>Groups</span></div><div><b>${scheduleCount}</b><span>Device rows</span></div><div><b>${entityCount}</b><span>Entities</span></div><div><b>${draft.operating_modes.length}</b><span>Modes</span></div><div><b>${boostCount}</b><span>Boost controls</span></div></div><section class="wizard-summary">${draft.groups.map(group=>`<div><b>${esc(group.name)}</b><span>${group.schedules.map(room=>`${esc(room.name||room.entity)}${room.suggested_week?" · routine ready":String(room.schedule||"").startsWith("schedule.")?" · saved timeline":" · blank"}`).join(" · ")||"Empty"}</span></div>`).join("")}</section><section class="wizard-maintenance"><h3>Card maintenance</h3><p>Cleanup removes only unused Schedule Control data. Factory reset permanently empties this card and removes everything it owns.</p><div class="maintenance-actions"><button data-wizard-cleanup-card>Clean up unused data</button><button class="danger" data-wizard-reset-card>Factory reset card</button></div></section>`;
    const progress = `${draft.groups.length} group${draft.groups.length===1?"":"s"} · ${scheduleCount} row${scheduleCount===1?"":"s"} · ${entityCount} entit${entityCount===1?"y":"ies"}${blankRows?` · ${blankRows} blank`:" · timelines ready"}`;
    return `<div class="wizard-backdrop"><div class="wizard"><header><div><small>Schedule Control setup wizard</small><h1>${esc(steps[this.wizardStep])}</h1></div><button data-wizard-close aria-label="Close">×</button></header><nav>${steps.map((step,index)=>`<button data-wizard-step="${index}" class="${index===this.wizardStep?"active":""}"><i>${index+1}</i><span>${step}</span></button>`).join("")}</nav><main>${this.wizardMessage?`<p class="wizard-warning"><ha-icon icon="mdi:alert-outline"></ha-icon>${esc(this.wizardMessage)}</p>`:""}${body}</main><footer><button data-wizard-cancel>Cancel</button><span>Step ${this.wizardStep+1} of ${steps.length} · ${progress}</span>${this.wizardStep?`<button data-wizard-back>Back</button>`:""}${this.wizardStep<steps.length-1?`<button class="primary" data-wizard-next>Continue</button>`:`<button class="primary" data-wizard-save>Save and finish</button>`}</footer></div></div>`;
  }
  bindWizard() {
    if (!this.wizardDraft) return;
    const close = () => { this.wizardDraft = null; this.render(); };
    const rerenderWizardInPlace = () => { const current=this.shadowRoot.querySelector(".wizard>main"); const scrollTop=current?.scrollTop||0; this.render(); requestAnimationFrame(()=>{const next=this.shadowRoot.querySelector(".wizard>main");if(next)next.scrollTop=scrollTop;}); };
    this.shadowRoot.querySelector("[data-wizard-close]")?.addEventListener("click", close);
    this.shadowRoot.querySelector("[data-wizard-cancel]")?.addEventListener("click", close);
    const move = (step) => {
      if (step > this.wizardStep) {
        const names = this.wizardDraft.groups.map((group) => String(group.name || "").trim());
        if (!names.length || names.some((name) => !name) || new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
          this.wizardMessage = "Give every group a unique name before continuing.";
          this.wizardStep = 1; this.render(); return;
        }
      }
      this.wizardMessage = "";
      this.wizardStep = Math.max(0,Math.min(6,step)); this.render();
    };
    this.shadowRoot.querySelector("[data-wizard-next]")?.addEventListener("click",()=>move(this.wizardStep+1));
    this.shadowRoot.querySelector("[data-wizard-back]")?.addEventListener("click",()=>move(this.wizardStep-1));
    this.shadowRoot.querySelectorAll("[data-wizard-step]").forEach(button=>button.onclick=()=>move(Number(button.dataset.wizardStep)));
    const title=this.shadowRoot.querySelector("[data-wizard-title]"); if(title) title.oninput=()=>this.wizardDraft.title=title.value;
    const min=this.shadowRoot.querySelector("[data-wizard-min]"); if(min) min.onchange=()=>this.wizardDraft.minimum_period=Number(min.value);
    const manualTimeout=this.shadowRoot.querySelector("[data-wizard-manual-timeout]"); if(manualTimeout) manualTimeout.onchange=()=>this.wizardDraft.manual_override_timeout=Number(manualTimeout.value);
    const status=this.shadowRoot.querySelector("[data-wizard-status]"); if(status) status.onchange=()=>this.wizardDraft.show_status=status.checked;
    const astro=this.shadowRoot.querySelector("[data-wizard-astro]"); if(astro) astro.onchange=()=>this.wizardDraft.show_astronomical_markers=astro.checked;
    this.shadowRoot.querySelectorAll("[data-wizard-domain]").forEach(button=>button.onclick=()=>{this.wizardEntityType=button.dataset.wizardDomain;this.wizardSelected.clear();this.render();});
    const updateDeviceSelection = () => {
      const count=this.wizardSelected.size;
      const group=this.wizardDraft.groups[this.wizardTargetGroup]||this.wizardDraft.groups[0];
      const summary=this.shadowRoot.querySelector("[data-wizard-selection-summary]");
      const add=this.shadowRoot.querySelector("[data-wizard-add-selected]");
      if(summary)summary.textContent=count?`${count} selected → ${group?.name||"group"}`:"No devices selected";
      if(add)add.disabled=!count;
    };
    this.shadowRoot.querySelectorAll("[data-wizard-entity]").forEach(input=>input.onchange=()=>{input.checked?this.wizardSelected.add(input.dataset.wizardEntity):this.wizardSelected.delete(input.dataset.wizardEntity);updateDeviceSelection();});
    const targetGroup=this.shadowRoot.querySelector("[data-wizard-target-group]"); if(targetGroup)targetGroup.onchange=()=>{this.wizardTargetGroup=Number(targetGroup.value);updateDeviceSelection();};
    this.shadowRoot.querySelectorAll("[data-wizard-device-name]").forEach(input=>input.oninput=()=>{const [gi,ri]=input.dataset.wizardDeviceName.split(":").map(Number);const room=this.wizardDraft.groups[gi]?.schedules?.[ri];if(room)room.name=input.value;});
    this.shadowRoot.querySelectorAll("[data-wizard-device-group]").forEach(select=>select.onchange=()=>{const [gi,ri]=select.dataset.wizardDeviceGroup.split(":").map(Number);const target=Number(select.value);if(target===gi)return;const [room]=this.wizardDraft.groups[gi]?.schedules?.splice(ri,1)||[];if(room)this.wizardDraft.groups[target].schedules.push(room);rerenderWizardInPlace();});
    this.shadowRoot.querySelectorAll("[data-wizard-remove-device]").forEach(button=>button.onclick=()=>{const [gi,ri]=button.dataset.wizardRemoveDevice.split(":").map(Number);this.wizardDraft.groups[gi]?.schedules?.splice(ri,1);rerenderWizardInPlace();});
    const search=this.shadowRoot.querySelector("[data-wizard-search]"); if(search) search.oninput=()=>{const q=search.value.toLowerCase();this.shadowRoot.querySelectorAll("[data-wizard-entity-row]").forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(q));};
    this.shadowRoot.querySelector("[data-wizard-select-all]")?.addEventListener("click",()=>{this.shadowRoot.querySelectorAll("[data-wizard-entity]:not(:disabled)").forEach(input=>{input.checked=true;this.wizardSelected.add(input.dataset.wizardEntity);});updateDeviceSelection();});
    this.shadowRoot.querySelector("[data-wizard-clear-selected]")?.addEventListener("click",()=>{this.wizardSelected.clear();this.shadowRoot.querySelectorAll("[data-wizard-entity]").forEach(input=>input.checked=false);updateDeviceSelection();});
    this.shadowRoot.querySelector("[data-wizard-add-selected]")?.addEventListener("click",()=>{if(!this.wizardDraft.groups.length)this.wizardDraft.groups.push({name:"New group",schedules:[]});const gi=Math.min(this.wizardTargetGroup,this.wizardDraft.groups.length-1);const group=this.wizardDraft.groups[gi]||this.wizardDraft.groups[0];for(const entity of this.wizardSelected){if(this.wizardDraft.groups.some(item=>item.schedules.some(room=>(room.entities||[room.entity]).includes(entity))))continue;const state=this._hass.states[entity];const name=state?.attributes?.friendly_name||entity;const hotWater=/hot[ _-]?water|water[ _-]?heater/i.test(`${entity} ${name}`);group.schedules.push({name,group_id:`group_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,entities:[entity],entity,entity_type:entity.split(".")[0],schedule:pendingScheduleValue(`${name} Schedule`,""),draft_source:"",enabled:true,preset_overrides:hotWater?{comfort:60,eco:50}:{},native_boost:{enabled:entity.startsWith("climate."),duration:60,durations:[15,30,60,90,120],temperature:hotWater?60:22,preset:""}});}const count=this.wizardSelected.size;this.wizardSelected.clear();this.wizardMessage=`Added ${count} device${count===1?"":"s"} to ${group.name}. Review the names and group below, or add another batch.`;rerenderWizardInPlace();});
    this.shadowRoot.querySelectorAll("[data-wizard-group-name]").forEach(input=>input.oninput=()=>this.wizardDraft.groups[Number(input.dataset.wizardGroupName)].name=input.value);
    this.shadowRoot.querySelectorAll("[data-wizard-row-name]").forEach(input=>input.oninput=()=>{const [gi,ri]=input.dataset.wizardRowName.split(":").map(Number);const room=this.wizardDraft.groups[gi]?.schedules?.[ri];if(room)room.name=input.value;});
    this.shadowRoot.querySelector("[data-wizard-add-group]")?.addEventListener("click",()=>{this.wizardDraft.groups.push({name:`New group ${this.wizardDraft.groups.length+1}`,schedules:[]});this.render();});
    this.shadowRoot.querySelectorAll("[data-wizard-remove-group]").forEach(button=>button.onclick=()=>{this.wizardDraft.groups.splice(Number(button.dataset.wizardRemoveGroup),1);this.render();});
    this.shadowRoot.querySelectorAll("[data-wizard-group-up]").forEach(button=>button.onclick=()=>{const i=Number(button.dataset.wizardGroupUp);if(i>0)[this.wizardDraft.groups[i-1],this.wizardDraft.groups[i]]=[this.wizardDraft.groups[i],this.wizardDraft.groups[i-1]];this.render();});
    this.shadowRoot.querySelectorAll("[data-wizard-group-down]").forEach(button=>button.onclick=()=>{const i=Number(button.dataset.wizardGroupDown);if(i<this.wizardDraft.groups.length-1)[this.wizardDraft.groups[i+1],this.wizardDraft.groups[i]]=[this.wizardDraft.groups[i],this.wizardDraft.groups[i+1]];this.render();});
    const moveRow=(token,offset)=>{const [gi,ri]=token.split(":").map(Number);const rows=this.wizardDraft.groups[gi]?.schedules;if(!rows)return;const ni=ri+offset;if(ni<0||ni>=rows.length)return;[rows[ri],rows[ni]]=[rows[ni],rows[ri]];this.render();};
    this.shadowRoot.querySelectorAll("[data-wizard-row-up]").forEach(button=>button.onclick=()=>moveRow(button.dataset.wizardRowUp,-1));
    this.shadowRoot.querySelectorAll("[data-wizard-row-down]").forEach(button=>button.onclick=()=>moveRow(button.dataset.wizardRowDown,1));
    this.shadowRoot.querySelectorAll("[data-wizard-start]").forEach(select=>select.onchange=()=>{const [gi,ri]=select.dataset.wizardStart.split(":").map(Number);const room=this.wizardDraft.groups[gi].schedules[ri];const name=`${room.name||"Schedule"} Schedule`;if(select.value==="blank"){room.schedule=pendingScheduleValue(name,"");room.draft_source="";delete room.suggested_week;}else if(select.value.startsWith("copy:")){const source=select.value.slice(5);room.schedule=pendingScheduleValue(name,source);room.draft_source=source;delete room.suggested_week;}});
    this.shadowRoot.querySelector("[data-generate-routine]")?.addEventListener("click",()=>{const value=(selector,fallback)=>this.shadowRoot.querySelector(selector)?.value||fallback;const wake=value("[data-routine-wake]","06:30"),leave=value("[data-routine-leave]","08:30"),back=value("[data-routine-return]","17:30"),bed=value("[data-routine-bed]","22:30");const home=Number(value("[data-routine-home]",20)),away=Number(value("[data-routine-away]",16)),night=Number(value("[data-routine-night]",17));const occupied=this.shadowRoot.querySelector("[data-routine-occupied]")?.checked;const blocks=[{from:"00:00:00",to:`${wake}:00`,data:{mode:"eco",target_temp:night}},{from:`${wake}:00`,to:`${leave}:00`,data:{mode:"comfort",target_temp:home}},{from:`${leave}:00`,to:`${back}:00`,data:{mode:occupied?"comfort":"away",target_temp:occupied?home:away}},{from:`${back}:00`,to:`${bed}:00`,data:{mode:"comfort",target_temp:home}},{from:`${bed}:00`,to:"24:00:00",data:{mode:"eco",target_temp:night}}];let count=0;this.shadowRoot.querySelectorAll("[data-routine-target]:checked").forEach(input=>{const [gi,ri]=input.dataset.routineTarget.split(":").map(Number);const room=this.wizardDraft.groups[gi].schedules[ri];room.suggested_week=Object.fromEntries(DAYS.map(day=>[day,structuredClone(blocks)]));room.schedule=pendingScheduleValue(`${room.name||"Schedule"} Schedule`,"");room.draft_source="";count++;});this.wizardRoutineMessage=`Generated an editable weekly routine for ${count} schedule${count===1?"":"s"}.`;this.render();});
    const boostUpdate=(selector,key,convert=v=>v)=>this.shadowRoot.querySelectorAll(selector).forEach(input=>input.onchange=()=>{const [gi,ri]=input.dataset[key].split(":").map(Number);const boost=this.wizardDraft.groups[gi].schedules[ri].native_boost||={};boost[key.replace("wizardBoost","").replace(/^./,c=>c.toLowerCase())]=convert(input.type==="checkbox"?input.checked:input.value);});
    boostUpdate("[data-wizard-boost-enabled]","wizardBoostEnabled",Boolean); boostUpdate("[data-wizard-boost-duration]","wizardBoostDuration",Number); boostUpdate("[data-wizard-boost-temperature]","wizardBoostTemperature",Number);
    this.shadowRoot.querySelector("[data-apply-bulk-boost]")?.addEventListener("click",()=>{const scope=this.shadowRoot.querySelector("[data-bulk-boost-scope]")?.value||"all";const enabled=Boolean(this.shadowRoot.querySelector("[data-bulk-boost-enabled]")?.checked);const duration=Number(this.shadowRoot.querySelector("[data-bulk-boost-duration]")?.value||60);const temperature=Number(this.shadowRoot.querySelector("[data-bulk-boost-temperature]")?.value||22);let count=0;this.wizardDraft.groups.forEach((group,gi)=>{if(scope!=="all"&&scope!==`group:${gi}`)return;group.schedules.forEach(room=>{if(roomType(room)!=="climate")return;room.native_boost={duration:60,durations:[15,30,60,90,120],temperature:22,preset:"",...(room.native_boost||{}),enabled,duration,temperature};count++;});});this.wizardMessage=`Boost defaults applied to ${count} climate row${count===1?"":"s"}.`;rerenderWizardInPlace();});
    this.shadowRoot.querySelectorAll('input[type="number"]').forEach(input=>input.onfocus=()=>input.select());
    this.shadowRoot.querySelectorAll("[data-wizard-mode-name]").forEach(input=>input.oninput=()=>this.wizardDraft.operating_modes[Number(input.dataset.wizardModeName)].name=input.value);
    this.shadowRoot.querySelectorAll("[data-wizard-mode-icon]").forEach(input=>input.onchange=()=>{this.wizardDraft.operating_modes[Number(input.dataset.wizardModeIcon)].icon=input.value;rerenderWizardInPlace();});
    this.shadowRoot.querySelectorAll("[data-wizard-remove-mode]").forEach(button=>button.onclick=()=>{this.wizardDraft.operating_modes.splice(Number(button.dataset.wizardRemoveMode),1);rerenderWizardInPlace();});
    const wizardModeRule=(token,change)=>{const [mi,...parts]=token.split(":");const groupId=parts.join(":");const mode=this.wizardDraft.operating_modes[Number(mi)];mode.schedules[groupId]||={action:"none"};change(mode.schedules[groupId]);};
    this.shadowRoot.querySelectorAll("[data-wizard-mode-action]").forEach(input=>input.onchange=()=>{wizardModeRule(input.dataset.wizardModeAction,rule=>rule.action=input.value);rerenderWizardInPlace();});
    this.shadowRoot.querySelectorAll("[data-wizard-mode-preset]").forEach(input=>input.onchange=()=>wizardModeRule(input.dataset.wizardModePreset,rule=>rule.preset=input.value));
    this.shadowRoot.querySelectorAll("[data-wizard-mode-temperature]").forEach(input=>input.onchange=()=>wizardModeRule(input.dataset.wizardModeTemperature,rule=>rule.temperature=Number(input.value)));
    const setModeGroups=(mi,checked)=>this.shadowRoot.querySelectorAll(`[data-bulk-mode-group^="${mi}:"]`).forEach(input=>input.checked=checked);
    this.shadowRoot.querySelectorAll("[data-bulk-mode-select-all]").forEach(button=>button.onclick=()=>setModeGroups(Number(button.dataset.bulkModeSelectAll),true));
    this.shadowRoot.querySelectorAll("[data-bulk-mode-clear]").forEach(button=>button.onclick=()=>setModeGroups(Number(button.dataset.bulkModeClear),false));
    this.shadowRoot.querySelectorAll("[data-bulk-mode-action]").forEach(select=>select.onchange=()=>{const mi=Number(select.dataset.bulkModeAction);const preset=this.shadowRoot.querySelector(`[data-bulk-mode-preset="${mi}"]`);const temperature=this.shadowRoot.querySelector(`[data-bulk-mode-temperature="${mi}"]`);const disabled=select.value==="off";if(preset)preset.disabled=disabled;if(temperature)temperature.disabled=disabled;}); this.shadowRoot.querySelectorAll("[data-bulk-mode-preset]").forEach(select=>select.onchange=()=>{const mi=Number(select.dataset.bulkModePreset);const preset=this.thermostatConfig?.presets?.find(item=>item.id===select.value);const temperature=this.shadowRoot.querySelector(`[data-bulk-mode-temperature="${mi}"]`);if(temperature&&preset)temperature.value=String(preset.temperature);}); this.shadowRoot.querySelectorAll("[data-apply-bulk-mode]").forEach(button=>button.onclick=()=>{const mi=Number(button.dataset.applyBulkMode);const mode=this.wizardDraft.operating_modes[mi];if(!mode)return;const selected=new Set([...this.shadowRoot.querySelectorAll(`[data-bulk-mode-group^="${mi}:"]:checked`)].map(input=>Number(input.dataset.bulkModeGroup.split(":")[1])));const action=this.shadowRoot.querySelector(`[data-bulk-mode-action="${mi}"]`)?.value||"preset";const preset=this.shadowRoot.querySelector(`[data-bulk-mode-preset="${mi}"]`)?.value||"away";const definition=this.thermostatConfig?.presets?.find(item=>item.id===preset);const temperature=Number(this.shadowRoot.querySelector(`[data-bulk-mode-temperature="${mi}"]`)?.value||definition?.temperature||12);let count=0;mode.schedules||={};this.wizardDraft.groups.forEach((group,gi)=>group.schedules.forEach(room=>{if(roomType(room)!=="climate")return;if(selected.has(gi)){mode.schedules[room.group_id]=action==="off"?{action:"off"}:{action:"preset",preset,temperature};count++;}else delete mode.schedules[room.group_id];}));const excluded=this.wizardDraft.groups.filter((group,gi)=>group.schedules.some(room=>roomType(room)==="climate")&&!selected.has(gi)).map(group=>group.name);this.wizardMessage=`${mode.name||"Mode"} applied to ${count} climate row${count===1?"":"s"}${excluded.length?`; ${excluded.join(", ")} unaffected`:""}.`;rerenderWizardInPlace();});
    this.shadowRoot.querySelector("[data-wizard-add-mode]")?.addEventListener("click",()=>{this.wizardDraft.operating_modes.push({id:`mode_${Date.now()}`,name:"New mode",icon:"mdi:tune-variant",schedules:{}});rerenderWizardInPlace();});
    this.shadowRoot.querySelector("[data-open-presets]")?.addEventListener("click",()=>this.openThermostatWizard());
    this.shadowRoot.querySelector("[data-wizard-reset-card]")?.addEventListener("click",()=>this.resetCardData());
    this.shadowRoot.querySelector("[data-wizard-cleanup-card]")?.addEventListener("click",()=>this.cleanupUnusedData());
    this.shadowRoot.querySelector("[data-wizard-save]")?.addEventListener("click",(event)=>{const button=event.currentTarget;button.disabled=true;button.textContent="Saving…";this.saveWizardConfiguration();});
    this.shadowRoot.querySelector("[data-new-routine]")?.addEventListener("click",()=>this.openRoutineSetup());
    this.shadowRoot.querySelectorAll("[data-edit-routine]").forEach((button)=>button.onclick=()=>this.openRoutineSetup(button.dataset.editRoutine));
    this.shadowRoot.querySelectorAll("[data-plan-assignment]").forEach((select)=>select.onchange=()=>{
      const [gi,ri]=select.dataset.planAssignment.split(":").map(Number); const room=this.wizardDraft.groups[gi].schedules[ri];
      const template=this.routineTemplates().find((item)=>item.id===select.value);
      room.routine_template_id=template?.id||""; room.routine_synced=Boolean(template); room.suggested_week=template?structuredClone(template.week):Object.fromEntries(DAYS.map((day)=>[day,[]]));
      room.schedule=pendingScheduleValue(`${room.name||"Device"} Schedule`,""); room.draft_source="";
    });
  }
  collectRoutineSetup() {
    const draft=this.routineSetup;if(!draft)return;
    this.shadowRoot.querySelectorAll("[data-rs-time]").forEach(input=>draft[input.dataset.rsTime].time=input.value);
    this.shadowRoot.querySelectorAll("[data-rs-preset]").forEach(input=>draft[input.dataset.rsPreset].preset=input.value);
    this.shadowRoot.querySelectorAll("[data-rs-override]").forEach(input=>draft[input.dataset.rsOverride].override=input.checked);
    this.shadowRoot.querySelectorAll("[data-rs-temperature]").forEach(input=>draft[input.dataset.rsTemperature].temperature=Number(input.value));
    const enabled=this.shadowRoot.querySelector("[data-rs-day-enabled]");if(enabled)draft.daytime.enabled=enabled.checked;
    const end=this.shadowRoot.querySelector("[data-rs-day-end]");if(end)draft.daytime.end=end.value;
    const name=this.shadowRoot.querySelector("[data-rs-name]");if(name)draft.name=name.value.trim();
    const days=this.shadowRoot.querySelectorAll("[data-rs-day]");if(days.length)draft.days=[...days].filter(input=>input.checked).map(input=>input.dataset.rsDay);
  }
  bindRoutineSetup() {
    if(!this.routineSetup)return;
    const close=()=>{this.routineSetup=null;this.render();};
    this.shadowRoot.querySelectorAll("[data-rs-close]").forEach(button=>button.onclick=close);
    const move=(step)=>{this.collectRoutineSetup();this.routineSetup.step=Math.max(0,Math.min(5,step));this.render();};
    this.shadowRoot.querySelector("[data-rs-next]")?.addEventListener("click",()=>move(this.routineSetup.step+1));
    this.shadowRoot.querySelector("[data-rs-back]")?.addEventListener("click",()=>move(this.routineSetup.step-1));
    this.shadowRoot.querySelectorAll("[data-rs-step]").forEach(button=>button.onclick=()=>move(Number(button.dataset.rsStep)));
    this.shadowRoot.querySelectorAll("[data-rs-override],[data-rs-day-enabled]").forEach(input=>input.onchange=()=>{this.collectRoutineSetup();this.render();});
    this.shadowRoot.querySelector("[data-rs-save]")?.addEventListener("click",()=>this.saveRoutineSetup());
  }
  async saveRoutineSetup() {
    this.collectRoutineSetup(); const draft=this.routineSetup; if(!draft)return;
    const ordered=[draft.wake.time,draft.leave.time,...(draft.daytime.enabled?[draft.daytime.time,draft.daytime.end]:[]),draft.returned.time,draft.bed.time].map(timeToMinutes);
    if(!draft.name||!draft.days.length||ordered.some(Number.isNaN)||!ordered.every((value,index)=>index===0||value>ordered[index-1])){this.routineSetupError="Choose a name and at least one day, and keep every selected time in chronological order.";this.render();return;}
    const presetTemperature=(id)=>Number(this.thermostatConfig?.presets?.find(item=>item.id===id)?.temperature??20);
    const data=(phase)=>({mode:phase.preset,target_temp:Number(phase.override?phase.temperature:presetTemperature(phase.preset)),...(phase.override?{temperature_override:true}:{})});
    const block=(from,to,phase)=>({from:`${from}:00`,to:to==="24:00"?"24:00:00":`${to}:00`,data:data(phase)});
    const periods=[block("00:00",draft.wake.time,draft.bed),block(draft.wake.time,draft.leave.time,draft.wake)];
    if(draft.daytime.enabled){periods.push(block(draft.leave.time,draft.daytime.time,draft.leave),block(draft.daytime.time,draft.daytime.end,draft.daytime),block(draft.daytime.end,draft.returned.time,draft.leave));}
    else periods.push(block(draft.leave.time,draft.returned.time,draft.leave));
    periods.push(block(draft.returned.time,draft.bed.time,draft.returned),block(draft.bed.time,"24:00",draft.bed));
    const week=Object.fromEntries(DAYS.map(day=>[day,draft.days.includes(day)?structuredClone(periods):[]]));
    const configuration=structuredClone(this.thermostatConfig||{});configuration.templates||=[];
    const duplicate=configuration.templates.find(item=>item.id!==draft.id&&String(item.name).toLowerCase()===draft.name.toLowerCase());if(duplicate){this.routineSetupError=`“${draft.name}” already exists. Choose a different name, or close this window and use Edit beside the existing routine.`;this.routineSetup.step=5;this.render();return;}
    const savedTemplate={id:draft.id,name:draft.name,card_id:this.config.card_id,week,routine:{days:draft.days,wake:draft.wake,leave:draft.leave,daytime:draft.daytime,returned:draft.returned,bed:draft.bed}};
    const index=configuration.templates.findIndex(item=>item.id===draft.id);if(index>=0)configuration.templates[index]=savedTemplate;else configuration.templates.push(savedTemplate);
    try{
      const saved=await this._hass.callWS({type:"schedule_control/set_thermostat_config",configuration});this.thermostatConfig=saved;
      for(const room of this.wizardDraft.groups.flatMap(group=>group.schedules||[]))if(room.routine_template_id===draft.id&&room.routine_synced!==false)room.suggested_week=structuredClone(week);
      this.routineSetup=null;this.wizardRoutineMessage=`Saved ${draft.name}. Choose it beside each device row, then press Apply timelines to card.`;this.render();
    }catch(error){this.routineSetupError=`Could not save routine: ${error?.message||error}`;this.render();}
  }
  openModeWizard() {
    this.modeWizardDraft=structuredClone(this.config.operating_modes||[]);
    this.modeWizardMessage="";this.render();
  }
  modeWizardHtml() {
    if(!this.modeWizardDraft)return "";
    const presets=this.thermostatConfig?.presets||[];
    const schedules=(this.config.groups||[]).flatMap((group)=>(group.schedules||[]).filter((room)=>roomType(room)==="climate").map((room)=>({...room,container:group.name})));
    const cards=this.modeWizardDraft.map((mode,modeIndex)=>`<section class="mode-wizard-card"><header><ha-icon icon="${esc(mode.icon||"mdi:tune-variant")}"></ha-icon><label>Mode name<input data-mw-name="${modeIndex}" value="${esc(mode.name)}"></label><label>Icon<input data-mw-icon="${modeIndex}" value="${esc(mode.icon||"mdi:tune-variant")}"></label><button class="danger" data-mw-remove="${modeIndex}">Delete mode</button></header><p>Choose an action for each thermostat. “Heating off” really turns HVAC off; an Off preset still means its configured frost-protection temperature.</p><div class="mode-wizard-schedules">${schedules.map((room)=>{const rule=mode.schedules?.[room.group_id]||{action:"none"};const active=rule.action!=="none";const usesPreset=rule.action==="preset";const selectedPreset=presets.find((preset)=>preset.id===(rule.preset||"away"))||presets[0];const defaultTemp=Number(selectedPreset?.temperature??14);const overridden=usesPreset&&rule.temperature_override===true;return `<article class="${active?"active":""}"><label class="mode-target"><input type="checkbox" data-mw-active="${modeIndex}:${esc(room.group_id)}" ${active?"checked":""}><span><b>${esc(room.name||room.entity)}</b><small>${esc(room.container)} · ${(room.entities||[room.entity]).filter(Boolean).length} thermostat${(room.entities||[room.entity]).filter(Boolean).length===1?"":"s"}</small></span></label><label>Action<select data-mw-action="${modeIndex}:${esc(room.group_id)}" ${active?"":"disabled"}><option value="preset" ${usesPreset?"selected":""}>Set preset temperature</option><option value="off" ${rule.action==="off"?"selected":""}>Turn thermostat off</option></select></label><label>Preset<select data-mw-preset="${modeIndex}:${esc(room.group_id)}" ${usesPreset?"":"disabled"}>${presets.map((preset)=>`<option value="${esc(preset.id)}" ${preset.id===selectedPreset?.id?"selected":""}>${esc(preset.name)} · ${Number(preset.temperature).toFixed(1)}°C</option>`).join("")}</select></label><label class="mode-temp-override"><span><input type="checkbox" data-mw-override="${modeIndex}:${esc(room.group_id)}" ${overridden?"checked":""} ${usesPreset?"":"disabled"}> Override temperature</span><input type="number" min="5" max="35" step="0.5" data-mw-temp="${modeIndex}:${esc(room.group_id)}" value="${Number(rule.temperature??defaultTemp)}" ${usesPreset&&overridden?"":"disabled"}></label></article>`}).join("")||"<p>Create a climate schedule before configuring modes.</p>"}</div></section>`).join("");
    return `<div class="wizard-backdrop"><div class="wizard mode-wizard"><header><div><small>Schedule Control</small><h1>Configure modes</h1><p>${esc(this.modeWizardMessage||"Modes temporarily override selected schedules. Boost always remains the highest priority.")}</p></div><button data-mw-close>×</button></header><main><section class="normal-mode"><ha-icon icon="mdi:calendar-sync"></ha-icon><span><b>Normal</b><small>Built in · follows every weekly schedule · cannot be deleted</small></span></section>${cards||"<p>No additional modes yet.</p>"}<button class="primary add-mode-large" data-mw-add>+ Add mode</button></main><footer><button data-mw-close>Cancel</button><span>${this.modeWizardDraft.length} configured mode${this.modeWizardDraft.length===1?"":"s"} plus Normal</span><button class="primary" data-mw-save>Save modes</button></footer></div></div>`;
  }
  bindModeWizard() {
    if(!this.modeWizardDraft)return;const close=()=>{this.modeWizardDraft=null;this.render();};
    const rerenderInPlace=()=>{const current=this.shadowRoot.querySelector(".mode-wizard>main");const scrollTop=current?.scrollTop||0;this.render();requestAnimationFrame(()=>{const next=this.shadowRoot.querySelector(".mode-wizard>main");if(next)next.scrollTop=scrollTop;});};
    this.shadowRoot.querySelectorAll("[data-mw-override]").forEach((input)=>{const token=input.dataset.mwOverride;const split=token.indexOf(":");const rule=this.modeWizardDraft[Number(token.slice(0,split))]?.schedules?.[token.slice(split+1)];if(rule?.temperature_override===true){input.checked=true;const temperature=[...this.shadowRoot.querySelectorAll("[data-mw-temp]")].find((item)=>item.dataset.mwTemp===token);if(temperature)temperature.disabled=false;}});
    this.shadowRoot.querySelectorAll("[data-mw-close]").forEach((button)=>button.onclick=close);
    this.shadowRoot.querySelector("[data-mw-add]")?.addEventListener("click",()=>{this.modeWizardDraft.push({id:`mode_${Date.now()}`,name:"New mode",icon:"mdi:tune-variant",schedules:{}});rerenderInPlace();});
    this.shadowRoot.querySelectorAll("[data-mw-remove]").forEach((button)=>button.onclick=()=>{this.modeWizardDraft.splice(Number(button.dataset.mwRemove),1);rerenderInPlace();});
    this.shadowRoot.querySelectorAll("[data-mw-name]").forEach((input)=>input.oninput=()=>this.modeWizardDraft[Number(input.dataset.mwName)].name=input.value);
    this.shadowRoot.querySelectorAll("[data-mw-icon]").forEach((input)=>input.onchange=()=>{this.modeWizardDraft[Number(input.dataset.mwIcon)].icon=input.value;rerenderInPlace();});
    const locate=(token)=>{const split=token.indexOf(":");const mode=this.modeWizardDraft[Number(token.slice(0,split))];const groupId=token.slice(split+1);mode.schedules||={};return{mode,groupId,rule:mode.schedules[groupId]};};
    this.shadowRoot.querySelectorAll("[data-mw-active]").forEach((input)=>input.onchange=()=>{const {mode,groupId}=locate(input.dataset.mwActive);if(input.checked){const preset=this.thermostatConfig?.presets?.[0];mode.schedules[groupId]={action:"preset",preset:preset?.id||"comfort",temperature:Number(preset?.temperature??20)};}else delete mode.schedules[groupId];rerenderInPlace();});
    this.shadowRoot.querySelectorAll("[data-mw-action]").forEach((select)=>select.onchange=()=>{const {mode,groupId,rule}=locate(select.dataset.mwAction);if(select.value==="off")mode.schedules[groupId]={action:"off"};else{const preset=this.thermostatConfig?.presets?.find((item)=>item.id===rule?.preset)||this.thermostatConfig?.presets?.[0];mode.schedules[groupId]={action:"preset",preset:preset?.id||"comfort",temperature:Number(preset?.temperature??20)};}rerenderInPlace();});
    this.shadowRoot.querySelectorAll("[data-mw-preset]").forEach((select)=>select.onchange=()=>{const {mode,groupId,rule}=locate(select.dataset.mwPreset);const preset=this.thermostatConfig?.presets?.find((item)=>item.id===select.value);mode.schedules[groupId]={...rule,action:"preset",preset:select.value,temperature:Number(preset?.temperature??20)};rerenderInPlace();});
    this.shadowRoot.querySelectorAll("[data-mw-override]").forEach((input)=>input.onchange=()=>{const token=input.dataset.mwOverride;const {mode,groupId,rule}=locate(token);const preset=this.thermostatConfig?.presets?.find((item)=>item.id===rule.preset);const defaultTemperature=Number(preset?.temperature??20);mode.schedules[groupId]={...rule,temperature:defaultTemperature,temperature_override:input.checked};const temperature=[...this.shadowRoot.querySelectorAll("[data-mw-temp]")].find((item)=>item.dataset.mwTemp===token);if(temperature){temperature.disabled=!input.checked;if(!input.checked)temperature.value=String(defaultTemperature);}});
    this.shadowRoot.querySelectorAll("[data-mw-temp]").forEach((input)=>input.onchange=()=>{const {rule}=locate(input.dataset.mwTemp);rule.temperature=Number(input.value);rule.temperature_override=true;});
    this.shadowRoot.querySelector("[data-mw-save]")?.addEventListener("click",async()=>{if(this.modeWizardDraft.some((mode)=>!mode.name.trim())){this.modeWizardMessage="Every mode needs a name.";this.render();return;}const names=this.modeWizardDraft.map(mode=>mode.name.trim().toLowerCase());if(new Set(names).size!==names.length){this.modeWizardMessage="Every mode needs a unique name.";this.render();return;}try{this.config.operating_modes=structuredClone(this.modeWizardDraft);await this._hass.callWS({type:"schedule_control/set_modes",card_id:this.config.card_id,modes:this.config.operating_modes});fireChanged(this,this.config);this.backendCard ||= {};this.backendCard.modes=structuredClone(this.config.operating_modes);this.modeWizardDraft=null;this.editorMessage="Operating modes saved. They are now available from the card and Home Assistant.";this.render();}catch(error){this.modeWizardMessage=`Could not save modes: ${error?.message||error}`;this.render();}});
  }
  async openThermostatWizard() {
    const defaults = { entities: [], presets: [
      { id:"comfort", name:"Comfort", temperature:20, color:"#e58a16", icon:"mdi:white-balance-sunny" },
      { id:"eco", name:"Eco", temperature:17, color:"#4f8a4b", icon:"mdi:leaf" },
      { id:"away", name:"Away", temperature:14, color:"#7c3aed", icon:"mdi:home-export-outline" },
      { id:"night", name:"Night", temperature:16, color:"#315b83", icon:"mdi:weather-night" },
      { id:"boost", name:"Boost", temperature:22, color:"#dc3f3f", icon:"mdi:fire" },
    ], groups: [] };
    try {
      const saved = await this._hass.callWS({ type:"schedule_control/get_thermostat_config" });
      const cardClimate = (this.wizardDraft?.groups || this.config.groups || []).flatMap(group=>group.schedules||[]).filter(room=>roomType(room)==="climate").flatMap(room=>room.entities||[room.entity].filter(Boolean));
      this.thermostatWizardDraft = { ...defaults, ...(saved || {}), entities:[...new Set([...(saved?.entities || []),...cardClimate])], presets:structuredClone(saved?.presets?.length ? saved.presets : defaults.presets), groups:structuredClone(saved?.groups || []) };
    } catch {
      const cardClimate = (this.wizardDraft?.groups || this.config.groups || []).flatMap(group=>group.schedules||[]).filter(room=>roomType(room)==="climate").flatMap(room=>room.entities||[room.entity].filter(Boolean));
      this.thermostatWizardDraft = {...structuredClone(defaults), entities:[...new Set(cardClimate)]};
    }
    this.thermostatWizardStep = 0; this.thermostatSearch = ""; this.thermostatWizardMessage = ""; this.render();
  }
  thermostatWizardHtml() {
    const draft=this.thermostatWizardDraft; if(!draft)return "";
    const steps=["Thermostats","Presets","Groups","Review"]; const allClimate=Object.entries(this._hass?.states||{}).filter(([id])=>id.startsWith("climate.")).sort((a,b)=>String(a[1].attributes.friendly_name||a[0]).localeCompare(String(b[1].attributes.friendly_name||b[0]))); let body="";
    if(this.thermostatWizardStep===0) body=`<div class="wizard-copy"><h2>Select controlled thermostats</h2><p>Only climate entities are shown. Selecting an entity registers it with Schedule Control; it does not create a schedule or change its temperature. You can return later to add or remove thermostats.</p></div><div class="thermostat-tools"><input type="search" data-ts-search placeholder="Search thermostat name or entity ID"><button data-ts-all>Select all thermostats</button><button data-ts-none>Clear selection</button></div><div class="wizard-entity-list thermostat-list">${allClimate.map(([id,state])=>`<label data-ts-row><input type="checkbox" data-ts-entity="${esc(id)}" ${draft.entities.includes(id)?"checked":""}><ha-icon icon="${esc(state.attributes.icon||"mdi:thermostat")}"></ha-icon><span><b>${esc(state.attributes.friendly_name||id)}</b><small>${esc(id)} · ${esc(state.state||"unknown")}</small></span></label>`).join("")||"<p>No climate entities were found in Home Assistant.</p>"}</div>`;
    if(this.thermostatWizardStep===1) body=`<div class="wizard-copy"><h2>Create Schedule Control presets</h2><p>These presets belong to Schedule Control and are identical for every selected thermostat. The integration ultimately sends only the target temperature. A schedule node can override that temperature without changing this library.</p></div><div class="preset-library"><header><span>Name<small>Label shown on timeline nodes</small></span><span>Temperature<small>Default target</small></span><span>Colour<small>Timeline colour</small></span><span>Icon<small>Material Design icon</small></span></header>${draft.presets.map((preset,index)=>`<div><input data-ts-preset-name="${index}" value="${esc(preset.name)}"><label><input type="number" min="5" max="35" step="0.5" data-ts-preset-temp="${index}" value="${Number(preset.temperature)}"><span>°C</span></label><input type="color" data-ts-preset-color="${index}" value="${safeColor(preset.color,"#2563eb")}"><label class="preset-icon"><ha-icon icon="${esc(preset.icon||"mdi:thermometer")}"></ha-icon><input data-ts-preset-icon="${index}" value="${esc(preset.icon||"mdi:thermometer")}"></label><button data-ts-preset-up="${index}" ${index===0?"disabled":""}>↑</button><button data-ts-preset-down="${index}" ${index===draft.presets.length-1?"disabled":""}>↓</button><button class="danger" data-ts-preset-remove="${index}">Remove</button></div>`).join("")}<button data-ts-preset-add>+ Add preset</button></div>`;
    const assigned=new Map(); for(const group of draft.groups)for(const entity of group.entities||[])assigned.set(entity,group.id);
    if(this.thermostatWizardStep===2) body=`<div class="wizard-copy"><h2>Group thermostats that share control</h2><p>A thermostat group is a reusable control target. For example, “Bedrooms” can contain Bedroom and Bedroom 2 so both follow one schedule. A thermostat can belong to only one thermostat group, but ungrouped thermostats remain available individually.</p></div><div class="thermostat-groups">${draft.groups.map((group,index)=>`<section><header><label>Group name<input data-ts-group-name="${index}" value="${esc(group.name)}"></label><button class="danger" data-ts-group-remove="${index}">Delete group</button></header><div>${draft.entities.map(entity=>{const state=this._hass?.states?.[entity];const owner=assigned.get(entity);return `<label class="wizard-toggle"><input type="checkbox" data-ts-group-entity="${index}:${esc(entity)}" ${(group.entities||[]).includes(entity)?"checked":""} ${owner&&owner!==group.id?"disabled":""}><span><b>${esc(state?.attributes?.friendly_name||entity)}</b><small>${owner&&owner!==group.id?`Already assigned to ${esc(draft.groups.find(item=>item.id===owner)?.name||"another group")}`:esc(entity)}</small></span></label>`}).join("")}</div></section>`).join("")||"<p>No thermostat groups yet. Individual thermostats can still be scheduled separately.</p>"}<button class="primary" data-ts-group-add>+ Create thermostat group</button></div>`;
    const grouped=new Set(draft.groups.flatMap(group=>group.entities||[])); if(this.thermostatWizardStep===3) body=`<div class="wizard-copy"><h2>Review thermostat setup</h2><p>Saving writes this configuration to the Schedule Control integration. It will survive dashboard changes and Home Assistant restarts. No heating setpoints or schedules are changed at this stage.</p></div><div class="wizard-review thermostat-review"><div><b>${draft.entities.length}</b><span>Thermostats</span></div><div><b>${draft.presets.length}</b><span>Internal presets</span></div><div><b>${draft.groups.length}</b><span>Thermostat groups</span></div><div><b>${draft.entities.filter(entity=>!grouped.has(entity)).length}</b><span>Individual controls</span></div></div><section class="review-presets"><h3>Preset library</h3>${draft.presets.map(preset=>`<span><i style="background:${safeColor(preset.color,"#2563eb")}"></i><ha-icon icon="${esc(preset.icon)}"></ha-icon><b>${esc(preset.name)}</b>${Number(preset.temperature).toFixed(1)}°C</span>`).join("")}</section><section class="wizard-summary"><h3>Thermostat groups</h3>${draft.groups.map(group=>`<div><b>${esc(group.name)}</b><span>${group.entities.map(entity=>esc(this._hass?.states?.[entity]?.attributes?.friendly_name||entity)).join(" · ")||"No members"}</span></div>`).join("")}</section>`;
    return `<div class="wizard-backdrop"><div class="wizard thermostat-wizard"><header><div><small>Schedule Control</small><h1>Thermostat setup</h1><p>${esc(this.thermostatWizardMessage||"Configure the climate devices and temperature presets used by future schedules.")}</p></div><button data-ts-close>×</button></header><nav>${steps.map((step,index)=>`<button data-ts-step="${index}" class="${index===this.thermostatWizardStep?"active":""}"><i>${index+1}</i><span>${step}</span></button>`).join("")}</nav><main>${body}</main><footer><button data-ts-cancel>Cancel</button><span>Step ${this.thermostatWizardStep+1} of 4</span>${this.thermostatWizardStep?"<button data-ts-back>Back</button>":""}${this.thermostatWizardStep<3?"<button class=\"primary\" data-ts-next>Continue</button>":"<button class=\"primary\" data-ts-save>Save thermostat setup</button>"}</footer></div></div>`;
  }
  bindThermostatWizard() {
    const draft=this.thermostatWizardDraft;if(!draft)return;const close=()=>{this.thermostatWizardDraft=null;this.render();};const move=step=>{this.thermostatWizardStep=Math.max(0,Math.min(3,step));this.render();};
    this.shadowRoot.querySelector("[data-ts-close]")?.addEventListener("click",close);this.shadowRoot.querySelector("[data-ts-cancel]")?.addEventListener("click",close);this.shadowRoot.querySelector("[data-ts-next]")?.addEventListener("click",()=>move(this.thermostatWizardStep+1));this.shadowRoot.querySelector("[data-ts-back]")?.addEventListener("click",()=>move(this.thermostatWizardStep-1));this.shadowRoot.querySelectorAll("[data-ts-step]").forEach(button=>button.onclick=()=>move(Number(button.dataset.tsStep)));
    this.shadowRoot.querySelectorAll("[data-ts-entity]").forEach(input=>input.onchange=()=>{draft.entities=input.checked?[...new Set([...draft.entities,input.dataset.tsEntity])]:draft.entities.filter(entity=>entity!==input.dataset.tsEntity);if(!input.checked)for(const group of draft.groups)group.entities=(group.entities||[]).filter(entity=>entity!==input.dataset.tsEntity);});
    const search=this.shadowRoot.querySelector("[data-ts-search]");if(search)search.oninput=()=>{const q=search.value.toLowerCase();this.shadowRoot.querySelectorAll("[data-ts-row]").forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(q));};this.shadowRoot.querySelector("[data-ts-all]")?.addEventListener("click",()=>{draft.entities=[...new Set([...draft.entities,...Object.keys(this._hass?.states||{}).filter(id=>id.startsWith("climate."))])];this.render();});this.shadowRoot.querySelector("[data-ts-none]")?.addEventListener("click",()=>{draft.entities=[];draft.groups.forEach(group=>group.entities=[]);this.render();});
    const presetField=(selector,dataKey,property,convert=value=>value)=>this.shadowRoot.querySelectorAll(selector).forEach(input=>input.oninput=()=>{draft.presets[Number(input.dataset[dataKey])][property]=convert(input.value);});presetField("[data-ts-preset-name]","tsPresetName","name");presetField("[data-ts-preset-temp]","tsPresetTemp","temperature",Number);presetField("[data-ts-preset-color]","tsPresetColor","color");presetField("[data-ts-preset-icon]","tsPresetIcon","icon");
    this.shadowRoot.querySelectorAll('input[type="number"]').forEach(input=>input.onfocus=()=>input.select());
    this.shadowRoot.querySelector("[data-ts-preset-add]")?.addEventListener("click",()=>{const used=new Set(draft.presets.map(preset=>String(preset.name||"").trim().toLowerCase()));let number=1;while(used.has(`preset ${number}`))number+=1;draft.presets.push({id:`preset_${Date.now()}`,name:`Preset ${number}`,temperature:20,color:"#2563eb",icon:"mdi:thermometer"});this.render();requestAnimationFrame(()=>{const fields=this.shadowRoot.querySelectorAll("[data-ts-preset-name]");const field=fields[fields.length-1];field?.scrollIntoView({block:"center"});field?.focus();field?.select();});});this.shadowRoot.querySelectorAll("[data-ts-preset-remove]").forEach(button=>button.onclick=()=>{draft.presets.splice(Number(button.dataset.tsPresetRemove),1);this.render();});this.shadowRoot.querySelectorAll("[data-ts-preset-up]").forEach(button=>button.onclick=()=>{const i=Number(button.dataset.tsPresetUp);[draft.presets[i-1],draft.presets[i]]=[draft.presets[i],draft.presets[i-1]];this.render();});this.shadowRoot.querySelectorAll("[data-ts-preset-down]").forEach(button=>button.onclick=()=>{const i=Number(button.dataset.tsPresetDown);[draft.presets[i+1],draft.presets[i]]=[draft.presets[i],draft.presets[i+1]];this.render();});
    this.shadowRoot.querySelector("[data-ts-group-add]")?.addEventListener("click",()=>{draft.groups.push({id:`thermostat_group_${Date.now()}`,name:"New thermostat group",entities:[]});this.render();});this.shadowRoot.querySelectorAll("[data-ts-group-name]").forEach(input=>input.oninput=()=>draft.groups[Number(input.dataset.tsGroupName)].name=input.value);this.shadowRoot.querySelectorAll("[data-ts-group-remove]").forEach(button=>button.onclick=()=>{draft.groups.splice(Number(button.dataset.tsGroupRemove),1);this.render();});this.shadowRoot.querySelectorAll("[data-ts-group-entity]").forEach(input=>input.onchange=()=>{const split=input.dataset.tsGroupEntity.indexOf(":");const index=Number(input.dataset.tsGroupEntity.slice(0,split));const entity=input.dataset.tsGroupEntity.slice(split+1);draft.groups[index].entities=input.checked?[...new Set([...(draft.groups[index].entities||[]),entity])]:(draft.groups[index].entities||[]).filter(item=>item!==entity);this.render();});
    this.shadowRoot.querySelector("[data-ts-save]")?.addEventListener("click",async()=>{const names=draft.presets.map(preset=>String(preset.name||"").trim().toLowerCase());if(names.some(name=>!name)||new Set(names).size!==names.length){this.thermostatWizardMessage="Every preset needs a unique name.";this.thermostatWizardStep=1;this.render();return;}for(const preset of draft.presets){preset.icon=/^mdi:[a-z0-9-]+$/i.test(String(preset.icon||""))?preset.icon:"mdi:thermometer";}try{const saved=await this._hass.callWS({type:"schedule_control/set_thermostat_config",configuration:draft});this.thermostatConfig=structuredClone(saved);this.backendStatus ||= {};this.backendStatus.thermostat_config=structuredClone(saved);this.thermostatWizardDraft=null;this.editorMessage=`Thermostat setup saved: ${saved.entities.length} thermostats, ${saved.presets.length} presets and ${saved.groups.length} groups.`;this.render();}catch(error){this.thermostatWizardMessage=`Could not save thermostat setup: ${error?.message||error}`;this.render();}});
  }
  render() {
    if (!this.shadowRoot || !this.config) return;
    const entityOptions = Object.entries(PROFILES).map(([type, profile]) => {
      const options = Object.entries(this._hass?.states || {}).filter(([id]) => id.startsWith(`${profile.domain}.`)).map(([id, state]) => `<option value="${esc(id)}">${esc(state.attributes.friendly_name || id)}</option>`).join("");
      return options ? `<optgroup label="${esc(profile.label)}">${options}</optgroup>` : "";
    }).join("");
    const climateEntityOptions = Object.entries(this._hass?.states || {}).filter(([id]) => id.startsWith("climate.")).map(([id, state]) => `<option value="${esc(id)}">${esc(state.attributes.friendly_name || id)}</option>`).join("");
    const allScheduleEntries = Object.entries(this._hass?.states || {}).filter(([id]) => id.startsWith("schedule.")).sort((a, b) => String(a[1].attributes.friendly_name || a[0]).localeCompare(String(b[1].attributes.friendly_name || b[0])));
    const nameCounts = new Map();
    for (const [id, state] of allScheduleEntries) { const name = state.attributes.friendly_name || id; nameCounts.set(name, (nameCounts.get(name) || 0) + 1); }
    const entryLabel = ([id, state]) => { const name = state.attributes.friendly_name || id; return nameCounts.get(name) > 1 ? `${name} (${id})` : name; };
    const themeOptions = Object.keys(this._hass?.themes?.themes || {}).sort().map((name) => `<option value="${esc(name)}" ${this.config.theme === name ? "selected" : ""}>${esc(name)}</option>`).join("");
    this.shadowRoot.innerHTML = `<style>${EDITOR_CSS}${EXTRA_EDITOR_CSS}</style><div class="editor streamlined-editor">${this.editorMessage ? `<p class="message">${esc(this.editorMessage)}</p>` : ""}<div class="card-settings"><label>Card title<input data-title value="${esc(this.config.title)}"></label><label>Card theme<select data-theme><option value="">Follow dashboard theme</option>${themeOptions}</select></label></div><div class="options"><label><input type="checkbox" data-status ${this.config.show_status ? "checked" : ""}> Status bar</label><label><input type="checkbox" data-time ${this.config.show_current_time !== false ? "checked" : ""}> Current-time marker</label><label><input type="checkbox" data-astro-markers ${this.config.show_astronomical_markers ? "checked" : ""}> Sunrise/sunset icons</label><label>Default view<select data-default-view><option value="overview" ${this.config.default_timeline_view !== "focus" ? "selected" : ""}>24 hour</option><option value="focus" ${this.config.default_timeline_view === "focus" ? "selected" : ""}>6 hour focus</option></select></label></div><button class="wizard-launch primary-setup" data-open-wizard><ha-icon icon="mdi:cog-box"></ha-icon><span><b>Setup Schedule Control</b><small>Configure devices, layout, presets, starting timelines, operating modes and maintenance in a full-screen workspace.</small></span><ha-icon icon="mdi:arrow-expand"></ha-icon></button><section class="maintenance-summary"><h3>Maintenance</h3><p>Clean unused backend data without changing the card, or return the card completely to its factory state.</p><div class="maintenance-actions"><button data-cleanup-card-data>Clean up unused data</button><button class="danger" data-reset-card-data>Factory reset card</button></div></section></div>`;
    const colorEditorStyle = document.createElement("style");
    colorEditorStyle.textContent = `${COLOR_EDITOR_CSS}${MODES_EDITOR_CSS}${MODES_REFLOW_CSS}${WIZARD_CSS}${WIZARD_FIT_CSS}${DEVICE_WIZARD_CSS}${WIZARD_ORDER_CSS}${THERMOSTAT_WIZARD_CSS}${MODE_WIZARD_CSS}${SETUP_HUB_CSS}${ROUTINE_SETUP_CSS}${WIZARD_USABILITY_CSS}${BULK_SETUP_CSS}${MODE_RESPONSIVE_CSS}`;
    this.shadowRoot.prepend(colorEditorStyle);
    const editorRoot = this.shadowRoot.querySelector(".editor");
    editorRoot.classList.toggle("colors-active", this.editorTab === "colors");
    editorRoot.classList.toggle("modes-active", this.editorTab === "modes");
    const colors = this.config.colors || {};
    const presets = new Set(["comfort", "eco", "away"]);
    for (const group of this.config.groups || []) for (const room of group.schedules || []) if (roomType(room) === "climate") for (const mode of (this._hass?.states?.[room.entity]?.attributes?.preset_modes || [])) presets.add(mode);
    const palette = ["#d97706", "#477a45", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#9333ea"];
    const colorDefinitions = [...presets].map((preset,index) => [`preset_${preset}`, this.modeLabel(preset), colors[`preset_${preset}`] || colors[preset] || palette[index % palette.length]]).concat([["on","On",colors.on || "#2563eb"],["off","Off gaps",colors.off || "#34465b"],["now","Current-time marker",colors.now || "#22d3ee"]]);
    const colorFields = colorDefinitions.map(([key, label, fallback]) => `<label><span><i style="background:${safeColor(colors[key], fallback)}"></i>${esc(label)}</span><input type="color" data-card-color="${esc(key)}" value="${safeColor(colors[key], fallback)}"></label>`).join("");
    editorRoot.insertAdjacentHTML("beforeend", `<div class="colors-panel"><h3>Timeline colours</h3><p>These colours apply only to this card.</p><div class="color-grid">${colorFields}</div><button data-reset-colors>Reset default colours</button></div>`);
    const modeCards = (this.config.operating_modes || []).map((mode, modeIndex) => {
      const rows = this.config.groups.flatMap((group) => group.schedules.map((room) => {
        const type = roomType(room); const rule = mode.schedules?.[room.group_id] || { action: "none" };
        const presets = type === "climate" ? (this._hass?.states?.[room.entity]?.attributes?.preset_modes || ["away", "eco", "comfort"]) : [];
        const control = type === "climate" ? `<select data-mode-action="${modeIndex}:${esc(room.group_id)}"><option value="none" ${rule.action === "none" ? "selected" : ""}>Not affected</option><option value="preset" ${rule.action === "preset" ? "selected" : ""}>Set preset</option></select><select data-mode-preset="${modeIndex}:${esc(room.group_id)}" ${rule.action !== "preset" ? "disabled" : ""}>${presets.map((preset) => `<option value="${esc(preset)}" ${rule.preset === preset ? "selected" : ""}>${esc(this.modeLabel(preset))}</option>`).join("")}</select><input type="number" min="5" max="35" step="0.5" title="Fallback temperature" data-mode-temp="${modeIndex}:${esc(room.group_id)}" value="${Number(rule.temperature ?? 12)}" ${rule.action !== "preset" ? "disabled" : ""}>` : `<select data-mode-action="${modeIndex}:${esc(room.group_id)}"><option value="none" ${rule.action === "none" ? "selected" : ""}>Not affected</option><option value="on" ${rule.action === "on" ? "selected" : ""}>On</option><option value="off" ${rule.action === "off" ? "selected" : ""}>Off</option></select>`;
        return `<div class="mode-schedule-row"><b>${esc(room.name || room.entity)}</b><small>${esc(type)}</small>${control}</div>`;
      })).join("");
      return `<section class="mode-card"><header><input data-mode-name="${modeIndex}" value="${esc(mode.name)}" aria-label="Mode name"><input data-mode-icon="${modeIndex}" value="${esc(mode.icon)}" aria-label="Mode icon"><button data-remove-mode="${modeIndex}" class="danger">Remove</button></header>${rows || "<p>Add schedules before configuring this mode.</p>"}</section>`;
    }).join("");
    editorRoot.insertAdjacentHTML("beforeend", `<div class="modes-panel"><h3>Operating modes</h3><p>Normal follows the weekly schedule. Configure Away, Party, Holiday and other overrides in a spacious guided window.</p><button class="wizard-launch" data-open-mode-wizard><ha-icon icon="mdi:tune-variant"></ha-icon><span><b>Configure modes</b><small>Choose icons, affected schedules, presets and optional temperatures.</small></span><ha-icon icon="mdi:arrow-expand"></ha-icon></button></div>`);
    this.shadowRoot.querySelectorAll("[data-editor-tab]").forEach((button) => button.onclick = () => { this.editorTab = button.dataset.editorTab; this.render(); });
    this.shadowRoot.querySelectorAll("[data-card-color]").forEach((input) => input.onchange = () => this.update((config) => config.colors[input.dataset.cardColor] = input.value));
    this.shadowRoot.querySelector("[data-add-mode]")?.addEventListener("click", () => this.update((config) => config.operating_modes.push({ id: `mode_${Date.now()}`, name: "New mode", icon: "mdi:tune-variant", schedules: {} })));
    this.shadowRoot.querySelectorAll("[data-remove-mode]").forEach((button) => button.onclick = () => this.update((config) => config.operating_modes.splice(Number(button.dataset.removeMode), 1)));
    this.shadowRoot.querySelectorAll("[data-mode-name]").forEach((input) => input.onchange = () => this.update((config) => config.operating_modes[Number(input.dataset.modeName)].name = input.value));
    this.shadowRoot.querySelectorAll("[data-mode-icon]").forEach((input) => input.onchange = () => this.update((config) => config.operating_modes[Number(input.dataset.modeIcon)].icon = input.value));
    const updateRule = (token, mutator) => this.update((config) => { const [mi, groupId] = token.split(":"); const mode = config.operating_modes[Number(mi)]; mode.schedules[groupId] ||= { action: "none" }; mutator(mode.schedules[groupId]); });
    this.shadowRoot.querySelectorAll("[data-mode-action]").forEach((input) => input.onchange = () => updateRule(input.dataset.modeAction, (rule) => rule.action = input.value));
    this.shadowRoot.querySelectorAll("[data-mode-preset]").forEach((input) => input.onchange = () => updateRule(input.dataset.modePreset, (rule) => rule.preset = input.value));
    this.shadowRoot.querySelectorAll("[data-mode-temp]").forEach((input) => input.onchange = () => updateRule(input.dataset.modeTemp, (rule) => rule.temperature = Number(input.value)));
    this.shadowRoot.querySelector("[data-reset-colors]").onclick = () => this.update((config) => config.colors = { comfort: "#d97706", eco: "#477a45", away: "#7c3aed", on: "#2563eb", off: "#34465b", now: "#22d3ee" });
    this.shadowRoot.querySelector("[data-title]").onchange = (e) => this.update((c) => c.title = e.target.value);
    this.shadowRoot.querySelector("[data-theme]").onchange = (e) => this.update((c) => c.theme = e.target.value);
    this.shadowRoot.querySelector("[data-status]").onchange = (e) => this.update((c) => c.show_status = e.target.checked);
    this.shadowRoot.querySelector("[data-time]").onchange = (e) => this.update((c) => c.show_current_time = e.target.checked);
    this.shadowRoot.querySelector("[data-astro-markers]").onchange = (e) => this.update((c) => c.show_astronomical_markers = e.target.checked);
    this.shadowRoot.querySelector("[data-default-view]").onchange = (e) => this.update((c) => c.default_timeline_view = e.target.value);
    const minimumPeriod = this.shadowRoot.querySelector("[data-min]"); if (minimumPeriod) minimumPeriod.onchange = (e) => this.update((c) => c.minimum_period = Number(e.target.value));
    this.shadowRoot.querySelectorAll("[data-group-name]").forEach((e) => e.onchange = () => this.update((c) => c.groups[Number(e.dataset.groupName)].name = e.value));
    this.shadowRoot.querySelectorAll("[data-remove-group]").forEach((e) => e.onclick = () => this.update((c) => c.groups.splice(Number(e.dataset.removeGroup), 1)));
    this.shadowRoot.querySelector("[data-add-group]")?.addEventListener("click", () => this.update((c) => c.groups.push({ name: "New group", schedules: [] })));
    const hwEntity = this.shadowRoot.querySelector("[data-hw-entity]"); if (hwEntity) { hwEntity.value = this.config.hot_water?.entity || ""; hwEntity.onchange = () => this.update((c) => c.hot_water = hwEntity.value ? { ...(c.hot_water || {}), name: "Hot Water", entity: hwEntity.value, schedule: c.hot_water?.schedule || "" } : null); }
    const hwSchedule = this.shadowRoot.querySelector("[data-hw-schedule]"); if (hwSchedule) { hwSchedule.value = this.config.hot_water?.schedule || "__blank__"; hwSchedule.onchange = () => this.update((c) => { if (c.hot_water) { c.hot_water.schedule = ""; c.hot_water.draft_source = hwSchedule.value.startsWith("__copy__:") ? hwSchedule.value.slice(9) : ""; } }); }
    this.shadowRoot.querySelector("[data-open-wizard]")?.addEventListener("click", () => this.openWizard());
    this.shadowRoot.querySelector("[data-open-mode-wizard]")?.addEventListener("click", () => this.openModeWizard());
    this.shadowRoot.querySelector("[data-reset-card-data]")?.addEventListener("click", () => this.resetCardData());
    this.shadowRoot.querySelector("[data-cleanup-card-data]")?.addEventListener("click", () => this.cleanupUnusedData());
    if (this.wizardDraft) {
      const setupHost = document.createElement("div");
      setupHost.innerHTML = this.wizardHtml();
      this.shadowRoot.append(...setupHost.childNodes);
      this.bindWizard();
    }
    if (this.routineSetup) {
      const routineHost = document.createElement("div");
      routineHost.innerHTML = this.routineSetupHtml();
      this.shadowRoot.append(...routineHost.childNodes);
      this.bindRoutineSetup();
    }
    if (this.thermostatWizardDraft) {
      const wizardHost = document.createElement("div");
      wizardHost.innerHTML = this.thermostatWizardHtml();
      this.shadowRoot.append(...wizardHost.childNodes);
      this.bindThermostatWizard();
    }
    if (this.modeWizardDraft) {
      const modeWizardHost=document.createElement("div");modeWizardHost.innerHTML=this.modeWizardHtml();this.shadowRoot.append(...modeWizardHost.childNodes);this.bindModeWizard();
    }
  }
}

const EDITOR_CSS = `:host{display:block;min-width:0}.editor{display:grid;gap:12px;min-width:0;overflow-x:hidden;color:var(--primary-text-color)}label{display:grid;gap:5px;min-width:0}.card-settings{display:grid;grid-template-columns:minmax(180px,1fr) minmax(180px,1fr);gap:10px;align-items:end}.mixed-note{margin:0;padding:8px 10px;border:1px solid var(--divider-color);border-radius:8px;color:var(--secondary-text-color);font-size:12px}.message{margin:0;padding:9px;border-radius:8px;background:color-mix(in srgb,var(--primary-color) 15%,transparent);color:var(--primary-text-color)}.options{display:flex;gap:14px;align-items:end;flex-wrap:wrap}input,select,button{font:inherit;min-width:0;max-width:100%;min-height:42px;border:1px solid var(--divider-color);border-radius:8px;padding:7px;background:var(--secondary-background-color);color:var(--primary-text-color)}section{min-width:0;border:1px solid var(--divider-color);border-radius:10px;padding:8px}.zone-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;margin-bottom:7px}.zone-head input{grid-column:1/-1}.zone-head button{white-space:normal}article{display:grid;grid-template-columns:28px minmax(90px,.7fr) minmax(130px,1fr) repeat(3,42px);gap:7px;margin-bottom:7px}article .drag{grid-column:1;grid-row:1/3}article>input{grid-column:2;grid-row:1}article>select:nth-of-type(1){grid-column:3/7;grid-row:1}article>select:nth-of-type(2){grid-column:2/4;grid-row:2}article>button:nth-of-type(1){grid-column:4;grid-row:2}article>button:nth-of-type(2){grid-column:5;grid-row:2}article>button:nth-of-type(3){grid-column:6;grid-row:2}.drag{display:grid;place-items:center}.add-zone{justify-self:start}details{min-width:0;overflow:hidden}details label{margin-top:8px}@media(max-width:560px){.card-settings{grid-template-columns:1fr}.zone-head{grid-template-columns:1fr}article{grid-template-columns:24px minmax(75px,.65fr) minmax(100px,1fr) repeat(3,38px);gap:5px}input,select,button{padding:5px}}`;

const EXTRA_EDITOR_CSS = `.group-settings{display:grid;gap:8px;border:1px solid var(--divider-color);border-radius:10px;padding:10px}.group-settings h3{margin:0}.group-settings>div{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:7px;align-items:center}.group-settings span{color:var(--secondary-text-color);font-size:12px;white-space:nowrap}.group-settings button{padding-inline:12px}.group-settings>button{justify-self:start}@media(max-width:560px){.group-settings>div{grid-template-columns:1fr auto}.group-settings>div span{grid-row:2}.group-settings>div button{grid-row:2}}`;

const COLOR_EDITOR_CSS = `.editor-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:4px;border-radius:10px;background:var(--secondary-background-color)}.editor-tabs button{border:0;background:transparent}.editor-tabs button.active{background:var(--primary-color);color:var(--text-primary-color);font-weight:700}.colors-panel{display:none}.colors-active>:not(.editor-tabs):not(.colors-panel):not(.message){display:none!important}.colors-active .colors-panel{display:grid;gap:12px}.colors-panel h3{margin:4px 0 0;font-size:20px}.colors-panel p{margin:0;color:var(--secondary-text-color)}.color-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.color-grid label{padding:10px;border:1px solid var(--divider-color);border-radius:10px;background:color-mix(in srgb,var(--secondary-background-color) 65%,transparent)}.color-grid label span{display:flex;align-items:center;gap:8px}.color-grid label i{width:16px;height:16px;border-radius:50%;border:1px solid #ffffff55}.color-grid input[type=color]{width:100%;height:48px;padding:4px;cursor:pointer}.colors-panel>button{justify-self:start;padding-inline:14px}@media(max-width:560px){.color-grid{grid-template-columns:1fr}}`;

const MODES_EDITOR_CSS = `.modes-panel{display:none}.modes-active>:not(.editor-tabs):not(.modes-panel):not(.message){display:none!important}.modes-active .modes-panel{display:grid;gap:10px}.modes-panel h3,.modes-panel p{margin:0}.modes-panel>p{color:var(--secondary-text-color)}.mode-card{display:grid;gap:7px}.mode-card header{display:grid;grid-template-columns:minmax(120px,1fr) minmax(150px,1fr) auto;gap:7px}.mode-schedule-row{display:grid;grid-template-columns:minmax(120px,1fr) 70px repeat(3,minmax(90px,.7fr));gap:7px;align-items:center;padding:7px;border-top:1px solid var(--divider-color)}.mode-schedule-row small{color:var(--secondary-text-color);text-transform:capitalize}.modes-panel>button{justify-self:start}@media(max-width:650px){.mode-card header,.mode-schedule-row{grid-template-columns:1fr}.mode-schedule-row small{display:none}}`;

const MODES_REFLOW_CSS = `.mode-card{padding:10px!important}.mode-card header{grid-template-columns:minmax(0,1fr) auto}.mode-card header [data-mode-name]{grid-column:1}.mode-card header [data-mode-icon]{grid-column:1}.mode-card header .danger{grid-column:2;grid-row:1/3}.mode-schedule-row{grid-template-columns:minmax(0,1fr) auto!important;padding:10px 4px!important}.mode-schedule-row>b{grid-column:1}.mode-schedule-row>small{grid-column:2}.mode-schedule-row>[data-mode-action]{grid-column:1/-1}.mode-schedule-row>[data-mode-preset]{grid-column:1}.mode-schedule-row>[data-mode-temp]{grid-column:2;min-width:90px}@media(max-width:420px){.mode-card header,.mode-schedule-row{grid-template-columns:1fr!important}.mode-card header>*,.mode-schedule-row>*{grid-column:1!important;grid-row:auto!important}}`;

const WIZARD_FIT_CSS = `.wizard-backdrop{inset:0!important;overflow:hidden!important;padding:12px!important}.wizard{width:min(1380px,100%)!important;max-width:100%!important;height:min(900px,100%)!important;max-height:100%!important;min-width:0!important}.wizard>nav{grid-template-columns:repeat(7,1fr)}.wizard>main,.wizard-discover,.wizard-group-list,.wizard-group-list section{min-width:0}.wizard-domain button span{display:grid;text-align:left}.wizard-domain button small{font-size:10px;color:var(--secondary-text-color)}.wizard-discover-tools{grid-template-columns:minmax(0,1fr) minmax(130px,auto) minmax(150px,.65fr) minmax(130px,auto)}.wizard-groups-first{display:grid;gap:10px}.wizard-groups-first>label{display:grid;grid-template-columns:minmax(150px,.7fr) minmax(180px,1fr) auto;align-items:center;gap:12px;padding:14px;border:1px solid var(--divider-color);border-radius:13px}.wizard-groups-first span{display:grid}.wizard-start-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.wizard-start-list>label{display:grid;grid-template-columns:minmax(150px,1fr) minmax(180px,1fr);align-items:center;gap:10px;padding:12px;border:1px solid var(--divider-color);border-radius:12px}.wizard-start-list span{display:grid}.routine-builder{margin-top:18px;padding:14px;border:1px solid color-mix(in srgb,var(--primary-color) 35%,var(--divider-color));border-radius:15px}.routine-builder>summary{display:flex;align-items:center;gap:10px;cursor:pointer}.routine-builder>summary span{display:grid}.routine-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:15px 0}.routine-builder fieldset{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0;border:1px solid var(--divider-color);border-radius:12px}.routine-builder fieldset label{display:flex;align-items:center;gap:5px}.routine-builder fieldset input{min-height:20px}.routine-result{color:var(--secondary-text-color)}.wizard-mode-list.full>section{padding:14px}.wizard-mode-list.full>section>header{display:grid;grid-template-columns:minmax(160px,1fr) minmax(190px,1fr) 42px auto;align-items:end;gap:10px}.wizard-mode-rule{display:grid;grid-template-columns:minmax(170px,1fr) minmax(190px,1fr) minmax(130px,.7fr) 120px;align-items:end;gap:9px;padding:10px 0;border-top:1px solid var(--divider-color)}.wizard-mode-rule>span{display:grid;align-self:center}@media(max-width:1050px){.wizard>nav span{display:none}.wizard-group-list article{grid-template-columns:minmax(0,1fr) minmax(150px,.7fr)!important}.wizard-group-list article>label{min-width:0}.wizard-discover-tools{grid-template-columns:minmax(0,1fr) minmax(130px,1fr)}.routine-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.wizard-mode-rule{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:650px){.wizard-groups-first>label,.wizard-start-list>label,.wizard-mode-list.full>section>header,.wizard-mode-rule{grid-template-columns:1fr}.routine-grid{grid-template-columns:1fr}}`;

const THERMOSTAT_WIZARD_CSS = `.thermostat-wizard>nav{grid-template-columns:repeat(4,1fr)!important}.thermostat-wizard>header p{margin:4px 0 0;color:var(--secondary-text-color)}.thermostat-tools{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;margin-bottom:12px}.thermostat-list label{min-height:58px}.preset-library{display:grid;gap:8px}.preset-library>header,.preset-library>div{display:grid;grid-template-columns:minmax(130px,1fr) 130px 90px minmax(190px,1fr) 44px 44px auto;gap:8px;align-items:center}.preset-library>header{padding:0 8px;color:var(--secondary-text-color)}.preset-library>header span{display:grid;font-weight:700}.preset-library>header small{font-weight:400}.preset-library>div{padding:10px;border:1px solid var(--divider-color);border-radius:13px;background:color-mix(in srgb,var(--secondary-background-color) 65%,transparent)}.preset-library>div>label{display:flex;align-items:center;gap:5px}.preset-library input[type=color]{height:42px;padding:3px}.preset-icon{display:grid!important;grid-template-columns:28px minmax(0,1fr);align-items:center}.preset-library>button{justify-self:start}.thermostat-groups{display:grid;gap:14px}.thermostat-groups>section{padding:14px}.thermostat-groups>section>header{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:12px;align-items:end}.thermostat-groups>section>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px}.thermostat-review{grid-template-columns:repeat(4,1fr)}.review-presets{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.review-presets h3{width:100%}.review-presets>span{display:flex;align-items:center;gap:7px;padding:9px 12px;border:1px solid var(--divider-color);border-radius:999px}.review-presets i{width:14px;height:14px;border-radius:50%}@media(max-width:900px){.preset-library>header{display:none}.preset-library>div{grid-template-columns:minmax(120px,1fr) 110px 70px minmax(150px,1fr) repeat(2,42px);}.preset-library>div .danger{grid-column:1/-1}.thermostat-groups>section>div{grid-template-columns:1fr}}@media(max-width:650px){.thermostat-tools,.preset-library>div,.thermostat-groups>section>header{grid-template-columns:1fr}.thermostat-review{grid-template-columns:repeat(2,1fr)}.preset-library>div>*{grid-column:1!important}}`;

const MODE_WIZARD_CSS = `.mode-wizard{grid-template-rows:auto minmax(0,1fr) auto!important}.mode-wizard>header p{margin:4px 0 0;color:var(--secondary-text-color)}.mode-wizard>main{display:grid;gap:14px}.normal-mode{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid color-mix(in srgb,#22c55e 45%,var(--divider-color));background:color-mix(in srgb,#22c55e 8%,var(--card-background-color))}.normal-mode>ha-icon{color:#22c55e;--mdc-icon-size:30px}.normal-mode span{display:grid}.normal-mode small,.mode-wizard-card>p,.mode-target small{color:var(--secondary-text-color)}.mode-wizard-card{padding:16px}.mode-wizard-card>header{display:grid;grid-template-columns:42px minmax(160px,1fr) minmax(200px,1fr) auto;gap:10px;align-items:end}.mode-wizard-card>header>ha-icon{align-self:center;--mdc-icon-size:30px;color:var(--primary-color)}.mode-wizard-card>p{margin:10px 0}.mode-wizard-schedules{display:grid;gap:8px}.mode-wizard-schedules>article{display:grid!important;grid-template-columns:minmax(210px,1fr) minmax(190px,.8fr) minmax(190px,.8fr)!important;gap:12px;align-items:center;margin:0;padding:12px;border:1px solid var(--divider-color);border-radius:13px;opacity:.62}.mode-wizard-schedules>article.active{opacity:1;border-color:color-mix(in srgb,var(--primary-color) 55%,var(--divider-color));background:color-mix(in srgb,var(--primary-color) 8%,transparent)}.mode-target{display:flex!important;align-items:center;gap:10px;padding:0!important;border:0!important}.mode-target input,.mode-temp-override input[type=checkbox]{width:25px;min-height:25px}.mode-target span{display:grid}.mode-temp-override{display:grid;grid-template-columns:1fr 100px;align-items:center;gap:8px}.mode-temp-override>span{display:flex;align-items:center;gap:7px}.add-mode-large{justify-self:start;padding-inline:20px}@media(max-width:850px){.mode-wizard-card>header,.mode-wizard-schedules>article{grid-template-columns:1fr!important}.mode-wizard-card>header>ha-icon{display:none}.mode-temp-override{grid-template-columns:1fr}}`;

const WIZARD_USABILITY_CSS = `.wizard-warning,.wizard-success{display:flex;align-items:center;gap:9px;margin:0 0 14px;padding:11px 13px;border:1px solid color-mix(in srgb,#f59e0b 55%,var(--divider-color));border-radius:12px;background:color-mix(in srgb,#f59e0b 10%,transparent)}.wizard-success{border-color:color-mix(in srgb,#22c55e 55%,var(--divider-color));background:color-mix(in srgb,#22c55e 9%,transparent)}.wizard-success ha-icon{color:#22c55e}.wizard-warning ha-icon{color:#f59e0b}.wizard>footer>span{font-size:13px}`;

const WIZARD_CSS = `.wizard-launch{display:grid;grid-template-columns:32px 1fr 28px;align-items:center;gap:10px;width:100%;padding:12px 14px;border-color:color-mix(in srgb,var(--primary-color) 55%,var(--divider-color));background:color-mix(in srgb,var(--primary-color) 13%,var(--card-background-color));text-align:left}.wizard-launch span{display:grid}.wizard-launch small{color:var(--secondary-text-color)}.wizard-backdrop{position:fixed;z-index:10000;inset:12px;display:grid;place-items:center;background:#000b;backdrop-filter:blur(8px)}.wizard{display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;width:min(1380px,96vw);height:min(900px,94vh);overflow:hidden;border:1px solid color-mix(in srgb,var(--primary-color) 35%,var(--divider-color));border-radius:20px;background:var(--card-background-color);box-shadow:0 28px 80px #000d}.wizard>header{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid var(--divider-color)}.wizard>header h1,.wizard>header small{margin:0}.wizard>header small{color:var(--primary-color);font-weight:800;text-transform:uppercase;letter-spacing:.08em}.wizard>header button{width:48px;font-size:28px}.wizard>nav{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:10px 18px;background:var(--secondary-background-color)}.wizard>nav button{display:flex;align-items:center;justify-content:center;gap:8px;border-color:transparent;background:transparent}.wizard>nav button i{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--divider-color);font-style:normal}.wizard>nav button.active{background:color-mix(in srgb,var(--primary-color) 20%,transparent);color:var(--primary-color);font-weight:800}.wizard>nav button.active i{background:var(--primary-color);color:var(--text-primary-color)}.wizard>main{overflow:auto;padding:24px}.wizard-copy{max-width:850px;margin-bottom:20px}.wizard-copy h2{margin:0 0 6px;font-size:27px}.wizard-copy p{margin:0;color:var(--secondary-text-color);font-size:15px;line-height:1.5}.wizard-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.wizard-form>label,.wizard-group-list label{padding:14px;border:1px solid var(--divider-color);border-radius:13px}.wizard label small{color:var(--secondary-text-color)}.wizard-toggle{display:flex!important;grid-template-columns:none!important;align-items:center;gap:12px}.wizard-toggle input{width:25px;min-height:25px}.wizard-toggle span{display:grid}.wizard-domain{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.wizard-domain button{display:flex;align-items:center;justify-content:center;gap:9px;min-height:58px}.wizard-domain button.active{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 20%,transparent);color:var(--primary-color);font-weight:800}.wizard-discover-tools{display:grid;grid-template-columns:minmax(180px,1fr) auto minmax(160px,.5fr) auto;gap:9px;margin:14px 0}.wizard-entity-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.wizard-entity-list label{display:grid;grid-template-columns:28px 28px 1fr;align-items:center;gap:9px;padding:11px;border:1px solid var(--divider-color);border-radius:11px}.wizard-entity-list span{display:grid}.wizard-entity-list input{min-height:22px}.wizard-group-list{display:grid;gap:14px}.wizard-group-list section{padding:14px}.wizard-group-list section>header{display:grid;grid-template-columns:minmax(200px,1fr) auto;gap:12px;align-items:center}.wizard-group-list article{display:grid!important;grid-template-columns:minmax(180px,1fr) minmax(170px,.65fr) 130px 130px!important;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid var(--divider-color)}.wizard-group-list article>div{display:grid}.wizard-group-list article small{color:var(--secondary-text-color)}.wizard-na{color:var(--secondary-text-color);grid-column:2/-1}.wizard-mode-list{display:grid;gap:10px}.wizard-mode-list label{display:grid;grid-template-columns:32px minmax(160px,1fr) minmax(180px,.7fr);align-items:center;gap:10px;padding:12px;border:1px solid var(--divider-color);border-radius:12px}.wizard-mode-list span{display:grid}.wizard-review{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}.wizard-review>div{display:grid;place-items:center;padding:22px;border:1px solid var(--divider-color);border-radius:15px;background:var(--secondary-background-color)}.wizard-review b{font-size:30px;color:var(--primary-color)}.wizard-summary{margin-top:18px}.wizard-summary div{display:grid;grid-template-columns:180px 1fr;gap:10px;padding:10px;border-bottom:1px solid var(--divider-color)}.wizard>footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid var(--divider-color);background:var(--secondary-background-color)}.wizard>footer span{margin-right:auto;color:var(--secondary-text-color)}.wizard .primary,.boost-now{border-color:var(--primary-color);background:var(--primary-color);color:var(--text-primary-color);font-weight:800}.boost-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.boost-settings>[data-native-boost-action]{width:100%;margin-top:10px}@media(max-width:800px){.wizard{width:100%;height:100%;border-radius:0}.wizard-backdrop{inset:0}.wizard>nav span{display:none}.wizard-form,.wizard-entity-list{grid-template-columns:1fr}.wizard-discover-tools{grid-template-columns:1fr 1fr}.wizard-group-list article{grid-template-columns:1fr 1fr!important}.wizard-review{grid-template-columns:repeat(2,1fr)}}`;
const SETUP_HUB_CSS = `.streamlined-editor>.colors-panel,.streamlined-editor>.modes-panel{display:none!important}.primary-setup{min-height:76px!important;border-radius:14px!important}.primary-setup>ha-icon:first-child{--mdc-icon-size:30px;color:var(--primary-color)}.maintenance-summary{padding:14px!important}.maintenance-summary h3,.maintenance-summary p{margin:0 0 8px}.maintenance-summary p{color:var(--secondary-text-color)}.maintenance-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.maintenance-actions button{min-height:48px}.wizard>nav{grid-template-columns:repeat(7,minmax(0,1fr))!important}.wizard>nav button{min-width:0}.wizard>nav button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wizard-copy{max-width:980px}.wizard-copy h2{font-size:29px}.wizard-copy p{font-size:16px}.wizard-subtool{display:grid;grid-template-columns:34px 1fr 28px;align-items:center;gap:10px;width:min(680px,100%);margin-top:16px;padding:14px;text-align:left}.wizard-subtool span{display:grid}.wizard-subtool small{color:var(--secondary-text-color)}@media(max-width:900px){.wizard>nav span{display:none}.maintenance-actions{grid-template-columns:1fr}}`;

const ROUTINE_SETUP_CSS = `.routine-library,.plan-assignments{display:grid;gap:10px;margin-top:16px;padding:16px!important}.routine-library>header,.plan-assignments>header{display:flex;align-items:center;justify-content:space-between}.routine-library h3,.plan-assignments h3{margin:0}.routine-library>article{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;align-items:center;margin:0!important;padding:12px!important;border:1px solid var(--divider-color);border-radius:12px}.routine-library>article span{display:grid}.routine-question{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:14px;max-width:920px;margin:auto}.routine-question>h2,.routine-question>p{grid-column:1/-1;margin:0}.routine-question>p{color:var(--secondary-text-color)}.routine-question>label{align-self:start;padding:14px;border:1px solid var(--divider-color);border-radius:13px}.routine-question>label:has([data-rs-name]),.routine-question>fieldset{grid-column:1/-1}.routine-question [data-rs-name]{height:48px;min-height:48px}.routine-question fieldset{margin:0;padding:14px;border:1px solid var(--divider-color);border-radius:13px}.routine-question .routine-days{display:grid;grid-template-columns:repeat(7,minmax(70px,1fr));gap:8px}.routine-question .routine-days label{display:flex;align-items:center;justify-content:center;gap:7px;min-height:50px;padding:7px;border:1px solid var(--divider-color);border-radius:10px;background:var(--secondary-background-color)}.routine-question .routine-days input[type=checkbox]{width:24px;height:24px;min-height:24px;margin:0;padding:0}.routine-setup>nav{grid-template-columns:repeat(6,1fr)!important}@media(max-width:700px){.routine-question{grid-template-columns:1fr}.routine-question>*{grid-column:1!important}.routine-question .routine-days{grid-template-columns:repeat(4,1fr)}}`;

const DEVICE_WIZARD_CSS = `.wizard-added,.wizard-available{margin-top:14px;padding:14px;border:1px solid var(--divider-color);border-radius:15px;background:color-mix(in srgb,var(--secondary-background-color) 55%,transparent)}.wizard-added>header,.wizard-available>header{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:10px}.wizard-added h3,.wizard-available h3{margin:0}.wizard-added header span,.wizard-available header span{display:grid}.wizard-added-list{display:grid;gap:8px}.wizard-added-list article{display:grid;grid-template-columns:28px minmax(180px,1fr) minmax(150px,.65fr) minmax(180px,1fr) auto;align-items:end;gap:9px;padding:9px 10px;border:1px solid color-mix(in srgb,var(--primary-color) 20%,var(--divider-color));border-radius:11px;background:var(--card-background-color)}.wizard-added-list article>label{display:grid}.wizard-added-list .entity-id{align-self:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wizard-add-destination{display:grid;grid-template-columns:minmax(170px,1fr) minmax(150px,auto) auto;align-items:end;gap:9px}.wizard-add-destination label{display:grid}.wizard-add-destination strong{align-self:center;color:var(--primary-color)}.wizard-available .wizard-discover-tools{grid-template-columns:minmax(0,1fr) minmax(130px,auto) minmax(130px,auto)}@media(max-width:900px){.wizard-added-list article{grid-template-columns:28px 1fr 1fr auto}.wizard-added-list .entity-id{grid-column:2/4}.wizard-add-destination{grid-template-columns:1fr 1fr}.wizard-add-destination button{grid-column:1/-1}}`;

if (!customElements.get("schedule-control-card")) customElements.define("schedule-control-card", HeatingScheduleCard);
if (!customElements.get("schedule-control-card-editor")) customElements.define("schedule-control-card-editor", HeatingScheduleCardEditor);
if (!customElements.get("heating-schedule-card")) customElements.define("heating-schedule-card", class extends HeatingScheduleCard {});
if (!customElements.get("heating-schedule-card-editor")) customElements.define("heating-schedule-card-editor", class extends HeatingScheduleCardEditor {});
window.customCards ||= [];
if (!window.customCards.some((card) => card.type === "schedule-control-card")) window.customCards.push({ type: "schedule-control-card", name: "Schedule Control Card", description: "Touch-friendly native Schedule helper editor for climate, switches and lighting", preview: true });

// A Lovelace resource stays loaded after its final card is removed. Use that
// lifetime to finish two-phase orphan cleanup on the next frontend session.
if (!window.__scheduleControlOrphanSweep) {
  window.__scheduleControlOrphanSweep = true;
  let sweepFailures = 0;
  let sweepTimer = 0;
  const collectCardIds = (value, result = new Set()) => {
    if (!value || typeof value !== "object") return result;
    if (["custom:schedule-control-card", "custom:heating-schedule-card"].includes(value.type) && value.card_id) result.add(value.card_id);
    for (const child of Object.values(value)) collectCardIds(child, result);
    return result;
  };
  const sweep = async () => {
    const hass = document.querySelector("home-assistant")?.hass;
    if (!hass?.callWS) return;
    try {
      const ids = new Set();
      const dashboards = await hass.callWS({ type: "lovelace/dashboards/list" });
      for (const target of [{ url_path: null }, ...(dashboards || []).map((item) => ({ url_path: item.url_path }))]) {
        const request = { type: "lovelace/config" };
        if (target.url_path) request.url_path = target.url_path;
        try {
          collectCardIds(await hass.callWS(request), ids);
        } catch (error) {
          // A Home Assistant installation may have no default Lovelace
          // dashboard at all. That is a valid configuration, not a failed
          // cleanup scan; continue with the explicitly registered dashboards.
          const detail = String(error?.message || error?.code || error || "");
          if (/no config found/i.test(detail)) continue;
          throw error;
        }
      }
      const cleanup = await hass.callWS({ type: "schedule_control/cleanup", active_card_ids: [...ids], scan_complete: true });
      const schedules = new Set();
      for (const value of cleanup?.delete_schedules || []) {
        const pending = pendingSchedule(value);
        if (pending) {
          for (const [entityId, state] of Object.entries(hass.states || {})) if (entityId.startsWith("schedule.") && state.attributes?.friendly_name === pending.name) schedules.add(entityId);
        } else if (String(value).startsWith("schedule.")) schedules.add(String(value));
      }
      for (const entityId of schedules) if (hass.states?.[entityId]) await hass.callWS({ type: "schedule/delete", schedule_id: entityId.slice(9) });
      if (cleanup?.card_ids?.length) await hass.callWS({ type: "schedule_control/finalize_cleanup", card_ids: cleanup.card_ids });
      sweepFailures = 0;
    } catch (error) {
      sweepFailures += 1;
      const detail = error?.message || error?.code || JSON.stringify(error) || String(error);
      if (sweepFailures <= 2) console.warn(`Schedule Control orphan cleanup deferred (${detail}). A later retry will be attempted.`);
    } finally {
      // Cleanup is housekeeping, not a reason to wake the UI every minute.
      // Back off after failures and avoid flooding the console indefinitely.
      const delay = sweepFailures ? Math.min(300000, 60000 * (2 ** Math.min(sweepFailures - 1, 3))) : 300000;
      sweepTimer = window.setTimeout(sweep, delay);
    }
  };
  window.setTimeout(sweep, 8000);
}

console.info("%c SCHEDULE-CONTROL-CARD %c v1.25.0-dev18q ", "color:white;background:#1565c0;font-weight:bold", "color:#1565c0;background:white");


