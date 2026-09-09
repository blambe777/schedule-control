import test from "node:test";
import assert from "node:assert/strict";
import { copyDay, focusBounds, hexToRgb, migrateConfig, normalizeBlock, replaceBlockRange, rgbToHex, timelineMinuteToPercent, timelinePercentToMinute, timeToMinutes, upsertBlock, validateBlocks } from "../src/schedule-utils.js";

test("parses schedule times", () => {
  assert.equal(timeToMinutes("06:30:00"), 390);
  assert.ok(Number.isNaN(timeToMinutes("25:00")));
});

test("focus timeline enlarges six hours and remains reversible", () => {
  assert.deepEqual(focusBounds(720), { start: 540, end: 900 });
  assert.equal(timelineMinuteToPercent(540, "focus", 720), 15);
  assert.equal(timelineMinuteToPercent(720, "focus", 720), 50);
  assert.equal(timelineMinuteToPercent(900, "focus", 720), 85);
  for (const minute of [0, 120, 540, 615, 720, 899, 1100, 1440]) {
    const percent = timelineMinuteToPercent(minute, "focus", 720);
    assert.ok(Math.abs(timelinePercentToMinute(percent, "focus", 720) - minute) < 0.001);
  }
});

test("focus timeline clamps cleanly at midnight edges", () => {
  assert.deepEqual(focusBounds(60), { start: 0, end: 360 });
  assert.deepEqual(focusBounds(1380), { start: 1080, end: 1440 });
  assert.equal(timelineMinuteToPercent(0, "focus", 60), 0);
  assert.equal(timelineMinuteToPercent(1440, "focus", 1380), 100);
});

test("rejects short and overlapping periods", () => {
  assert.equal(validateBlocks([{ from: "06:00", to: "06:10" }], 15).valid, false);
  assert.equal(validateBlocks([{ from: "06:00", to: "08:00" }, { from: "07:30", to: "09:00" }]).valid, false);
});

test("sorts and inserts periods", () => {
  const result = upsertBlock([], { from: "06:30", to: "09:00", data: { mode: "comfort", target_temp: 20 } });
  assert.equal(result[0].from, "06:30:00");
  assert.equal(result[0].data.target_temp, 20);
});

test("replacing a climate range trims surrounding fill periods", () => {
  const blocks = [
    { from: "00:00", to: "08:00", data: { mode: "away", target_temp: 14 } },
    { from: "08:00", to: "10:00", data: { mode: "comfort", target_temp: 20 } },
    { from: "10:00", to: "24:00", data: { mode: "away", target_temp: 14 } },
  ];
  const result = replaceBlockRange(blocks, { from: "07:00", to: "11:00", data: { mode: "comfort", target_temp: 20 } }, 1, 15);
  assert.deepEqual(result.map(({from,to,data})=>[from,to,data.mode]), [
    ["00:00:00", "07:00:00", "away"],
    ["07:00:00", "11:00:00", "comfort"],
    ["11:00:00", "24:00:00", "away"],
  ]);
});

test("keeps thermostat presets unless a node temperature is overridden", () => {
  const inherited = upsertBlock([], { from: "06:30", to: "09:00", data: { mode: "comfort" } });
  assert.equal("target_temp" in inherited[0].data, false);
  const overridden = upsertBlock([], { from: "06:30", to: "09:00", data: { mode: "eco", target_temp: 17.5 } });
  assert.equal(overridden[0].data.target_temp, 17.5);
});

test("normalizes switch and lighting node data", () => {
  const light = upsertBlock([], { from: "18:00", to: "23:00", data: { mode: "on", brightness_pct: 150, color_temp_kelvin: 3500, color_hex: "#0C2238" } });
  assert.equal(light[0].data.mode, "on");
  assert.equal(light[0].data.brightness_pct, 100);
  assert.equal(light[0].data.color_temp_kelvin, 3500);
  assert.equal(light[0].data.color_hex, "#0c2238");
});

test("preserves explicit off nodes for switches and lights", () => {
  const result = upsertBlock([], { from: "23:00", to: "24:00", data: { mode: "off" } });
  assert.equal(result[0].data.mode, "off");
});

test("preserves and clamps astronomical lighting anchors", () => {
  const block = normalizeBlock({ from: "17:00", to: "23:00", data: { mode: "on", start_anchor: "sunset", start_offset: -30, end_anchor: "sunrise", end_offset: 999 } });
  assert.equal(block.data.start_anchor, "sunset");
  assert.equal(block.data.start_offset, -30);
  assert.equal(block.data.end_anchor, "sunrise");
  assert.equal(block.data.end_offset, 180);
});

test("keeps thermostat-specific preset names", () => {
  const result = upsertBlock([], { from: "00:00", to: "06:00", data: { mode: "away" } });
  assert.equal(result[0].data.mode, "away");
});

test("converts light colours between picker and service formats", () => {
  assert.deepEqual(hexToRgb("#0c2238"), [12, 34, 56]);
  assert.equal(rgbToHex([12, 34, 56]), "#0c2238");
});

test("copies days without sharing references", () => {
  const source = { monday: [{ from: "06:00", to: "07:00", data: { mode: "eco" } }], tuesday: [] };
  const result = copyDay(source, "monday", ["tuesday"]);
  result.tuesday[0].data.mode = "comfort";
  assert.equal(result.monday[0].data.mode, "eco");
});

test("migrates minimal config", () => {
  const result = migrateConfig({ type: "custom:heating-schedule-card" });
  assert.equal(result.config_version, 2);
  assert.equal(result.schedule_type, "climate");
  assert.equal(result.minimum_period, 15);
  assert.equal(result.colors.comfort, "#d97706");
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.operating_modes, []);
});

test("migrates a legacy room into an independent schedule group", () => {
  const result = migrateConfig({ zones: [{ name: "Bedrooms", rooms: [{ name: "Bedrooms", entity: "climate.bedroom_1" }] }] });
  assert.deepEqual(result.groups[0].schedules[0].entities, ["climate.bedroom_1"]);
  assert.equal(result.groups[0].schedules[0].group_id, "schedule_0_0_climate_bedroom_1");
});

test("repairs duplicate legacy group identifiers", () => {
  const result = migrateConfig({ zones: [{ rooms: [{ name: "Heat", entity: "climate.one", group_id: "group_0_0" }, { name: "NEDD", entity: "climate.two", group_id: "group_0_0" }] }] });
  assert.notEqual(result.groups[0].schedules[0].group_id, result.groups[0].schedules[1].group_id);
});

test("manual override timeout defaults safely and preserves configured minutes", () => {
  assert.equal(migrateConfig({}).manual_override_timeout, 0);
  assert.equal(migrateConfig({ manual_override_timeout: 60 }).manual_override_timeout, 60);
});
