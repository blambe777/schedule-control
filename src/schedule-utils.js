export const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export function hexToRgb(value = "#ffffff") {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(value));
  return match ? match.slice(1).map((part) => parseInt(part, 16)) : [255, 255, 255];
}

export function rgbToHex(value = [255, 255, 255]) {
  return `#${value.slice(0, 3).map((part) => Math.min(255, Math.max(0, Number(part) || 0)).toString(16).padStart(2, "0")).join("")}`;
}

export function timeToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value || ""));
  if (!match) return NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 24 && minutes < 60 && !(hours === 24 && minutes) ? hours * 60 + minutes : NaN;
}

export function minutesToTime(value) {
  const minutes = Math.max(0, Math.min(1440, Math.round(Number(value) || 0)));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:00`;
}

export function normalizeBlock(block = {}) {
  const normalized = {
    from: minutesToTime(timeToMinutes(block.from)),
    to: minutesToTime(timeToMinutes(block.to)),
    data: {
      mode: typeof block.data?.mode === "string" && block.data.mode ? block.data.mode : "comfort",
    },
  };
  if (block.data?.target_temp !== undefined && block.data?.target_temp !== null && block.data?.target_temp !== "" && Number.isFinite(Number(block.data.target_temp))) {
    normalized.data.target_temp = Number(block.data.target_temp);
  }
  if (block.data?.brightness_pct !== undefined && Number.isFinite(Number(block.data.brightness_pct))) {
    normalized.data.brightness_pct = Math.min(100, Math.max(1, Number(block.data.brightness_pct)));
  }
  if (block.data?.color_temp_kelvin !== undefined && Number.isFinite(Number(block.data.color_temp_kelvin))) {
    normalized.data.color_temp_kelvin = Math.min(10000, Math.max(1000, Number(block.data.color_temp_kelvin)));
  }
  if (Array.isArray(block.data?.rgb_color) && block.data.rgb_color.length >= 3) {
    normalized.data.rgb_color = block.data.rgb_color.slice(0, 3).map((part) => Math.min(255, Math.max(0, Number(part) || 0)));
  }
  if (/^#[\da-f]{6}$/i.test(String(block.data?.color_hex || ""))) {
    normalized.data.color_hex = String(block.data.color_hex).toLowerCase();
  }
  for (const edge of ["start", "end"]) {
    const anchor = block.data?.[`${edge}_anchor`];
    if (["sunrise", "sunset"].includes(anchor)) {
      normalized.data[`${edge}_anchor`] = anchor;
      normalized.data[`${edge}_offset`] = Math.max(-180, Math.min(180, Number(block.data?.[`${edge}_offset`]) || 0));
    }
  }
  return normalized;
}

export function validateBlocks(blocks = [], minimumMinutes = 15) {
  const normalized = blocks.map(normalizeBlock).sort((a, b) => timeToMinutes(a.from) - timeToMinutes(b.from));
  for (let index = 0; index < normalized.length; index += 1) {
    const start = timeToMinutes(normalized[index].from);
    const end = timeToMinutes(normalized[index].to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < minimumMinutes) {
      return { valid: false, reason: `Period ${index + 1} must be at least ${minimumMinutes} minutes.` };
    }
    if (index && start < timeToMinutes(normalized[index - 1].to)) {
      return { valid: false, reason: `Period ${index + 1} overlaps the previous period.` };
    }
  }
  return { valid: true, blocks: normalized };
}

export function upsertBlock(blocks, block, originalIndex = -1, minimumMinutes = 15) {
  const next = [...(blocks || [])];
  if (originalIndex >= 0) next.splice(originalIndex, 1);
  next.push(normalizeBlock(block));
  const result = validateBlocks(next, minimumMinutes);
  if (!result.valid) throw new Error(result.reason);
  return result.blocks;
}

export function replaceBlockRange(blocks, block, originalIndex = -1, minimumMinutes = 15) {
  const replacement = normalizeBlock(block);
  const start = timeToMinutes(replacement.from);
  const end = timeToMinutes(replacement.to);
  const next = [];
  for (let index = 0; index < (blocks || []).length; index += 1) {
    if (index === originalIndex) continue;
    const existing = normalizeBlock(blocks[index]);
    const existingStart = timeToMinutes(existing.from);
    const existingEnd = timeToMinutes(existing.to);
    if (existingEnd <= start || existingStart >= end) { next.push(existing); continue; }
    if (start - existingStart >= minimumMinutes) next.push({ ...existing, to: minutesToTime(start) });
    if (existingEnd - end >= minimumMinutes) next.push({ ...existing, from: minutesToTime(end) });
  }
  next.push(replacement);
  const result = validateBlocks(next, minimumMinutes);
  if (!result.valid) throw new Error(result.reason);
  return result.blocks;
}

export function copyDay(schedule, sourceDay, targetDays) {
  const result = structuredClone(schedule);
  for (const day of targetDays) result[day] = structuredClone(schedule[sourceDay] || []);
  return result;
}

export function migrateConfig(input = {}) {
  const config = structuredClone(input);
  config.config_version = 2;
  config.schedule_type ||= "climate";
  config.title ||= "Heating Schedule";
  config.card_id ||= `card_${String(config.title).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "schedule"}`;
  config.minimum_period ||= 15;
  // Zero preserves the original behaviour: a manual change lasts until the
  // next scheduled node. Positive values cap that override in minutes.
  config.manual_override_timeout = Math.max(0, Number(config.manual_override_timeout) || 0);
  config.colors = {
    comfort: "#d97706",
    eco: "#477a45",
    away: "#7c3aed",
    on: "#2563eb",
    off: "#34465b",
    now: "#22d3ee",
    ...(config.colors || {}),
  };
  config.first_day ||= "monday";
  config.show_status ??= true;
  config.show_current_time ??= true;
  config.show_astronomical_markers ??= true;
  config.show_editor ??= true;
  config.operating_modes ||= [];
  config.operating_modes = config.operating_modes.map((mode, index) => ({
    id: mode.id || `mode_${index + 1}`,
    name: mode.name || `Mode ${index + 1}`,
    icon: mode.icon || "mdi:tune-variant",
    schedules: mode.schedules || {},
  }));
  // `zones` is retained as a read-only migration source. Version 2 calls these
  // organisational containers groups; schedules inside a group may be climate,
  // switch or light schedules.
  config.groups ||= config.zones || [];
  delete config.zones;
  const usedGroupIds = new Set();
  config.groups.forEach((group, groupIndex) => {
    group.schedules ||= group.rooms || [];
    delete group.rooms;
    group.schedules.forEach((room, roomIndex) => {
      const entityKey = String(room.entity || room.entities?.[0] || room.name || "schedule").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      let groupId = room.group_id || `schedule_${groupIndex}_${roomIndex}_${entityKey}`;
      if (usedGroupIds.has(groupId)) groupId = `schedule_${groupIndex}_${roomIndex}_${entityKey}`;
      room.group_id = groupId;
      usedGroupIds.add(groupId);
      room.entities ||= room.entity ? [room.entity] : [];
      room.entity ||= room.entities[0] || "";
      room.draft_source ||= "";
      room.routine_template_id ||= "";
      room.routine_synced ??= Boolean(room.routine_template_id);
      room.reset_schedule ??= false;
      room.enabled ??= true;
      room.native_boost = {
        enabled: room.entity_type === "climate" || String(room.entity || "").startsWith("climate."),
        duration: 60,
        durations: [15, 30, 60, 90, 120],
        temperature: 22,
        preset: "",
        ...(room.native_boost || {}),
      };
    });
  });
  config.hot_water ||= null;
  return config;
}

export function emptyWeek(name = "Schedule", icon = "mdi:calendar-clock") {
  return Object.fromEntries([["name", name], ["icon", icon], ...DAYS.map((day) => [day, []])]);
}

export function focusBounds(center, windowMinutes = 360) {
  const half = windowMinutes / 2;
  const start = Math.max(0, Math.min(1440 - windowMinutes, Number(center) - half));
  return { start, end: start + windowMinutes };
}

export function timelineMinuteToPercent(minute, mode = "overview", center = 720) {
  if (mode !== "focus") return Number(minute) / 14.4;
  const { start, end } = focusBounds(center);
  const left = start > 0 ? 15 : 0; const right = end < 1440 ? 15 : 0; const focusWidth = 100 - left - right;
  if (minute <= start) return start ? minute / start * left : 0;
  if (minute <= end) return left + (minute - start) / 360 * focusWidth;
  return left + focusWidth + (minute - end) / (1440 - end) * right;
}

export function timelinePercentToMinute(percent, mode = "overview", center = 720) {
  if (mode !== "focus") return Number(percent) * 14.4;
  const { start, end } = focusBounds(center);
  const left = start > 0 ? 15 : 0; const right = end < 1440 ? 15 : 0; const focusWidth = 100 - left - right;
  if (left && percent <= left) return percent / left * start;
  if (percent <= left + focusWidth) return start + (percent - left) / focusWidth * 360;
  return end + (percent - left - focusWidth) / right * (1440 - end);
}
