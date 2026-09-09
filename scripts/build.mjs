import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const utilities = (await readFile(resolve(root, "src/schedule-utils.js"), "utf8"))
  .replaceAll("export const ", "const ")
  .replaceAll("export function ", "function ");
const card = (await readFile(resolve(root, "src/heating-schedule-card.js"), "utf8"))
  .replace(/^import .*?\.\/schedule-utils\.js(?:\?[^\"]*)?";\r?\n/, "");

await mkdir(resolve(root, "dist"), { recursive: true });
const bundle = `/* Schedule Control Card - generated file; edit src/ instead. */\n${utilities}\n${card}`;
await writeFile(resolve(root, "dist/heating-schedule-card.js"), bundle);
await mkdir(resolve(root, "custom_components/schedule_control/www"), { recursive: true });
await writeFile(resolve(root, "custom_components/schedule_control/www/heating-schedule-card.js"), bundle);
