// End-to-end test: create trackables + whiteboard content, export,
// wipe all data via the dev menu, re-import the JSON, verify restore.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const SCRATCH = path.dirname(new URL(import.meta.url).pathname) // test dir; downloads land here;
const stub = fs.readFileSync(path.join(SCRATCH, "firebase-stub.mjs"), "utf8");

// Tiny valid 4x4 red PNG
const pngB64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGP8z8DwnwEJMDGgAXQBAEQrAxG6ffLGAAAAAElFTkSuQmCC";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();

const failures = [];
const check = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) failures.push(name);
};

page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept()); // accept all confirms/alerts

// Serve the Firebase stub instead of the CDN
await page.route("https://www.gstatic.com/firebasejs/**", (route) =>
  route.fulfill({ contentType: "application/javascript", body: stub })
);

await page.goto("http://localhost:8905/", { waitUntil: "networkidle" });
await page.waitForSelector("#app-screen:not(.hidden)", { timeout: 5000 });
check("app screen shown with stub auth", true);

// ---- Create trackable #1 with a new category (typed, no Add button) ----
await page.click("#add-btn");
await page.fill("#trackable-name", "Fix the fence");
await page.click('#date-type-row .choice-btn[data-value="countdown"]');
await page.fill("#countdown-days", "30");
await page.fill("#new-tag-name", "Chores");
await page.click("#trackable-save");
await page.waitForSelector(".trackable-row");
check("trackable created", (await page.locator(".trackable-row").count()) === 1);
check("category chip appears", await page.locator(".tag-bar .tag-chip", { hasText: "Chores" }).count() === 1);

// ---- Create trackable #2 ----
await page.click("#add-btn");
await page.fill("#trackable-name", "Plan vacation");
await page.click("#trackable-save");
await page.waitForFunction(() => document.querySelectorAll(".trackable-row").length === 2);

// ---- Open trackable view, add whiteboard text + image ----
await page.click(".trackable-row >> nth=0 >> .row-title");
await page.waitForSelector("#tview-overlay:not(.hidden)");
await page.click("#board-add-text");
await page.waitForSelector(".board-item.text-item .item-body");
await page.click(".board-item.text-item .item-body");
await page.keyboard.type("Buy cedar boards and nails");
await page.waitForTimeout(1000); // let the debounced save fire

await page.setInputFiles("#board-image-input", {
  name: "photo.png",
  mimeType: "image/png",
  buffer: Buffer.from(pngB64, "base64"),
});
await page.waitForSelector(".board-item.image-item img", { timeout: 5000 });
check("text + image on board", (await page.locator(".board-item").count()) === 2);

// ---- Link the two trackables ----
await page.click("#tview-link-btn");
await page.waitForSelector("#link-modal:not(.hidden)");
await page.check(".link-option input");
await page.click("#link-save");
await page.waitForSelector(".related-chip");
check("related chip shown", true);
await page.click("#tview-close-btn");

// ---- Export: capture both downloads ----
const downloads = [];
page.on("download", (d) => downloads.push(d));
await page.click("#export-btn");
await page.waitForFunction(() => document.getElementById("export-btn").textContent === "Export data");
await page.waitForTimeout(500);
check("two files downloaded (json + rtf)", downloads.length === 2);

let jsonText = "", rtfText = "";
for (const d of downloads) {
  const p = path.join(SCRATCH, d.suggestedFilename());
  await d.saveAs(p);
  const content = fs.readFileSync(p, "utf8");
  if (d.suggestedFilename().endsWith(".json")) jsonText = content;
  else rtfText = content;
}

const data = JSON.parse(jsonText);
const fence = data.trackables.find((t) => t.name === "Fix the fence");
check("JSON has both trackables", data.trackables.length === 2);
check("JSON has category with color+emoji", data.categories.some((c) => c.name === "Chores" && c.color && "emoji" in c));
check("JSON board has text item with content", fence.board.some((i) => i.type === "text" && i.text.includes("cedar boards")));
check("JSON board has image with data URL", fence.board.some((i) => i.type === "image" && i.src.startsWith("data:image/")));
check("JSON has link between trackables", (fence.relatedIds || []).length === 1);
check("JSON has countdown data", fence.dateType === "countdown" && fence.countdownDays === 30);

check("RTF has trackable heading", rtfText.includes("Fix the fence"));
check("RTF has whiteboard text", rtfText.includes("cedar boards and nails"));
check("RTF has embedded image (\\pict)", /\\pict\\(jpeg|png)blip/.test(rtfText));
check("RTF has connection line", rtfText.includes("Connected to: Plan vacation"));
check("RTF has category name", rtfText.includes("Chores"));

// ---- Wipe all data via dev menu ----
await page.click("#dev-btn");
await page.click("#dev-clear-btn");
await page.waitForFunction(() => document.getElementById("dev-status").textContent.includes("cleared"));
await page.click("#dev-close");
await page.waitForFunction(() => document.querySelectorAll(".trackable-row").length === 0);
check("wipe removed all rows", true);
check("wipe removed category chips", (await page.locator(".tag-bar .tag-chip").count()) === 0);

// ---- Re-import the JSON ----
await page.setInputFiles("#import-file-input", path.join(SCRATCH, downloads.find(d => d.suggestedFilename().endsWith(".json")).suggestedFilename()));
await page.waitForFunction(() => document.querySelectorAll(".trackable-row").length === 2, { timeout: 5000 });
check("import restored both trackables", true);
check("import restored category chip", await page.locator(".tag-bar .tag-chip", { hasText: "Chores" }).count() === 1);

// Countdown restored: row shows "days left"
const rowDates = await page.locator(".row-date").allTextContents();
check("countdown restored (30 days left)", rowDates.some((s) => s.includes("30 days left")));

// Open restored trackable: whiteboard content and link back
await page.click(".trackable-row:has-text('Fix the fence') .row-title");
await page.waitForSelector("#tview-overlay:not(.hidden)");
await page.waitForSelector(".board-item");
check("restored board has text item", await page.locator(".board-item.text-item", { hasText: "cedar boards" }).count() === 1);
check("restored board has image item", (await page.locator(".board-item.image-item img").count()) === 1);
check("restored link chip present", (await page.locator(".related-chip").count()) === 1);

console.log(failures.length ? `\n${failures.length} FAILURE(S)` : "\nALL TESTS PASSED");
await browser.close();
process.exit(failures.length ? 1 : 0);
