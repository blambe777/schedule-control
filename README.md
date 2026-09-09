# Schedule Control for Home Assistant

Schedule Control is a touch-friendly weekly scheduler and controller for Home Assistant. It combines a Lovelace card with a companion custom integration, while Home Assistant remains the source of truth.

> **Beta software:** install this on a test Home Assistant system first. Back up Home Assistant before using it with production heating, hot-water, lighting, or switching equipment.

## What it does

- Displays each device, or compatible group of devices, as a clear 24-hour timeline.
- Supports climate entities, switches, lights, and hot-water climate entities.
- Provides draggable and resizable schedule periods with configurable presets and colours.
- Offers a six-hour focus view as well as the complete 24-hour view.
- Shows current temperature, current time, the active period, the next change, manual overrides, and boosts.
- Supports reusable starting routines without permanently linking independently edited rows.
- Supports operating modes such as Normal, Away, Party, Holiday, or user-defined modes.
- Exposes modes and boost controls to Home Assistant services and automations.
- Includes cleanup and factory-reset tools for data owned by the card.

## Installation with HACS (recommended for testers)

1. Make a Home Assistant backup.
2. Open **HACS → Integrations**.
3. Open the three-dot menu and choose **Custom repositories**.
4. Enter `https://github.com/blambe777/schedule-control` and select **Integration** as the category.
5. Install **Schedule Control**.
6. Restart Home Assistant.
7. Open **Settings → Devices & services → Add integration**.
8. Search for **Schedule Control** and add it.
9. Open **Settings → Dashboards → Resources**.
10. Add `/schedule-control/heating-schedule-card.js` as a **JavaScript module**.
11. Refresh the browser or fully reload the Home Assistant app.
12. Edit a dashboard, choose **Add card**, and select **Schedule Control**.

If the card does not appear, confirm the resource URL is exact, restart Home Assistant, and clear the frontend cache or reload the companion app.

## Manual installation

1. Download the latest release archive.
2. Copy `custom_components/schedule_control` into `/config/custom_components/`.
3. Restart Home Assistant.
4. Add the **Schedule Control** integration from **Settings → Devices & services**.
5. Add `/schedule-control/heating-schedule-card.js` as a JavaScript module under **Settings → Dashboards → Resources**.
6. Add the card to a dashboard through the visual card picker.

## First-time setup

Open the card editor and select **Setup Schedule Control**.

1. **Card** — Choose the title, default view, minimum period, and manual-override timeout.
2. **Layout** — Create and name groups such as Downstairs, Bedrooms, or Hot Water.
3. **Devices** — Choose a destination group, add entities, give each row a friendly name, and review assignments.
4. **Starting timelines** — Create reusable routines or choose a blank timeline. A routine supplies a starting point; a row becomes independent once edited.
5. **Presets & boost** — Define temperatures, colours, icons, and the default boost duration.
6. **Modes** — Configure modes and choose exactly which rows each mode affects.
7. **Maintenance** — Review the setup and select **Save and finish**.

Finally, press **Save** in Home Assistant's card editor and **Done** on the dashboard.

## Everyday use

- Select a day to inspect its schedule.
- Select **24h** for the whole day or **6h** for a touch-friendly focused view.
- Tap a period to edit it; drag the period or its handles to change its time.
- Tap an empty area to add a period.
- Use the flame button beside a row to start or cancel a boost.
- A red overlay shows an active boost. An orange overlay shows a manual change.
- A manual temperature change returns to the schedule at the next period boundary, or at the configured timeout when that occurs sooner.
- Select the mode control in the header to activate Normal, Away, Party, or another configured mode.

## Home Assistant automation services

Set a mode:

```yaml
action: schedule_control.set_mode
data:
  card_id: YOUR_CARD_ID
  mode: away
```

Start a boost:

```yaml
action: schedule_control.start_boost
data:
  card_id: YOUR_CARD_ID
  group_id: YOUR_ROW_ID
  duration: 60
  temperature: 22
```

Cancel a boost:

```yaml
action: schedule_control.cancel_boost
data:
  card_id: YOUR_CARD_ID
  group_id: YOUR_ROW_ID
```

The card ID and row IDs are available in the card's code editor. Normal configuration should use the visual setup wizard.

## Removing data

- **Clean up unused data** removes orphaned data owned by Schedule Control while retaining the current card.
- **Factory reset card** removes the selected card's groups, mappings, and owned schedules.
- For the safest uninstall, factory-reset every Schedule Control card before deleting the cards and integration.

Schedule Control deliberately avoids deleting helpers or entities it does not own.

## Reporting beta issues

Include the Home Assistant version and installation type, browser or app version, Schedule Control version, entity type, exact reproduction steps, screenshots, and relevant logs with secrets removed.

Never post access tokens, credential-bearing URLs, or complete Home Assistant backups.

## Development

```text
npm install
npm test
npm run build
```

The build creates `dist/heating-schedule-card.js` and the integration-served copy at `custom_components/schedule_control/www/heating-schedule-card.js`.

## License

MIT
