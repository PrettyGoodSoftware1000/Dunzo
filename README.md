# ✅ Dunzo

A browser-based tracker for your stuff. Plain HTML/CSS/JavaScript hosted on GitHub Pages, with data stored per-user in Firebase (Google sign-in + Firestore database). No build step, no server of your own.

## What it does

- **Sign in with Google** — each user's data is private to their account.
- **Dark, clean list view** — narrow rows with a clickable, color-coded title and a Dunzo! button.
- **Categories** — each has a name, an emoji (searchable picker with 900+ emojis), and a color from a palette of 24 bright, dark-background-friendly colors. Titles take their category's color; the category bar at the top filters the list. Selecting a category that's unused offers to remove it; selecting one whose trackables are all Dunzo offers to delete the category together with those completed trackables.
- **Date types** for each Trackable:
  - **Exact Due Date** — a specific day.
  - **Goal Date** — a date range (pick the same day twice for a single-day goal). For sorting, the due date is the range's last day.
  - **Countdown** — enter a number of days (e.g. 30) and it counts down from today: "30 days left," "29 days left," … then "overdue."
  - **Recurring** — repeats on a schedule: **weekly** (every N weeks on a weekday, e.g. "every other Tuesday"), **monthly** (the nth or last weekday, e.g. "first Wednesday of the month"), or **yearly** (a month/day, e.g. "every October 8th"). The list shows the next occurrence; the calendar shows every occurrence in view; the `.ics` export becomes a repeating event (`RRULE`) that Google Calendar expands automatically.
  - **None** — just shows how many days it's been listed.
- **Sorting** — by effective due date, soonest first. Dateless items sit at the bottom, oldest first. Countdown items sort by the date they're counting down to, but that date is never shown.
- **Trackable view** — click a title to open a large whiteboard for that Trackable. Add draggable, resizable text boxes and images (JPEG, PNG, or auto-playing GIFs — drag & drop them anywhere on the board). Images are compressed in your browser and stored inside the database, so everything stays on Firebase's free tier — no credit card needed. GIFs must be under ~350 KB (they can't be recompressed without losing animation). Edit, Dunzo, a subtle delete, and an X to close all live in the header.
- **🔗 Linking** — the **Connect** button relates Trackables to each other; linked items show as clickable chips for quick navigation.
- **Whiteboard links** — URLs typed into whiteboard text boxes (http/https or bare `www.`) become clickable links that open in a new tab.
- The trackable view header also has a **🔥 Important** toggle for flagging the item without opening the editor.
- **Freaking Important** — flag a Trackable when creating or editing it; flagged rows get a small static red glow, and the **Important** tab (between List and Calendar) lists only flagged items — category chips filter within it.
- **Search** — by Trackable name, whiteboard text content, or both.
- **Calendar view** — a month grid showing Trackables on their effective due dates; click one to open it.
- **Dunzo!** — marks a Trackable complete. It disappears from the default view and gets the green **Dunzo ✅** chip; click that chip in the bar to see completed items (and un-Dunzo them if needed).
- **Export / Import** — one click downloads three files: a `.json` backup (re-importable, restores everything including whiteboards), a human-readable `.rtf` with whiteboard text and images embedded, and a `.ics` calendar file importable into Google Calendar (Settings → Import & export → Import): every dated, not-yet-Dunzo trackable becomes an all-day event — exact dates and countdown targets on their day, goal ranges spanning their full date range — with categories, connections, and whiteboard text in the event description (calendar events can't hold images; dateless trackables are skipped). Images are written in both modern (JPEG/PNG) and legacy (WMF bitmap) RTF forms for maximum compatibility — note that macOS **TextEdit never shows images in plain RTF files** by design; open the file in Word, Pages, LibreOffice, or Google Docs to see them.
- **Developer menu** — a subtle "developer" link at the bottom opens a menu with a "Clear Firebase data" button that wipes all Dunzo data for your account (double confirmation) for a fresh start.

## One-time setup

You need a (free) Firebase project on the **Spark (no-cost)** plan — no credit card. This takes about 10 minutes.

> **Navigating the Firebase console:** the left sidebar groups products into categories like **Databases & Storage**, **Security**, and **Hosting & Serverless**. If you can't find something, use the **Search for products** box at the top of the sidebar — searching "Authentication" or "Firestore" jumps straight there. Direct URLs are given at each step below as a backup; they use this project's ID (`dunzo-b9651`) — if your project ID differs, swap it into the URL.

### 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with your Google account.
2. Click **Create a project** (or "Add project"), name it anything (e.g. `dunzo`), and continue. You can turn **off** Google Analytics when asked — it's not needed.
3. Firebase assigns a **Project ID** (e.g. `dunzo-b9651`) — you can see it anytime under **Settings → Project settings → General** ([direct link](https://console.firebase.google.com/project/dunzo-b9651/settings/general)).

### 2. Turn on Google sign-in

1. In the left sidebar: **Security → Authentication**, or search "Authentication" in the sidebar's search box.
   Direct link: <https://console.firebase.google.com/project/dunzo-b9651/authentication/providers>
2. Click **Get started** if prompted. On the **Sign-in method** tab, click **Google**, toggle **Enable**, pick a support email, and **Save**.

### 3. Create the database (Cloud Firestore)

1. In the left sidebar: **Databases & Storage → Firestore Database** (after it's created, a **Firestore** shortcut also appears under "Project shortcuts"). Or search "Firestore" in the sidebar's search box.
   Direct link: <https://console.firebase.google.com/project/dunzo-b9651/firestore>
2. Click **Create database**. If Firebase asks which data product you want, pick **Cloud Firestore** — *not* the Realtime Database, SQL Connect, or Cloud Storage. Dunzo only uses Firestore.
3. Accept the default database ID (`(default)`), choose a location near you (this can't be changed later), and start in **production mode**.
4. Open the **Rules** tab — it's in the horizontal row of tabs across the top of the Firestore page (**Data | Rules | Indexes | Usage**), not the left sidebar.
   Direct link: <https://console.firebase.google.com/project/dunzo-b9651/firestore/rules>
5. Delete the default rules in the editor, paste the block below (all of it — the braces must balance), and click **Publish**. These make each user's data readable and writable only by that user:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

### 4. Register the web app and copy the config

1. In the left sidebar click **Settings** (gear icon, near "Project Overview") → **Project settings**, and stay on the **General** tab.
   Direct link: <https://console.firebase.google.com/project/dunzo-b9651/settings/general>
2. Scroll down to **Your apps**, click the **web icon `</>`**, give it a nickname (e.g. `dunzo-web`), and click **Register app**. Skip Firebase Hosting if offered.
3. Firebase shows a `firebaseConfig` code block. Copy those values into **`js/firebase-config.js`** in this repo, replacing the `PASTE_YOUR_...` placeholders. (These values are safe to commit — they identify your project publicly; your security comes from the Firestore rules and Google sign-in, not from hiding the config.)

### 5. Authorize your GitHub Pages domain

Google sign-in only works from domains you approve:

1. Go to **Authentication** (see step 2), then its **Settings** tab → **Authorized domains** → **Add domain**.
   Direct link: <https://console.firebase.google.com/project/dunzo-b9651/authentication/settings>
2. Add your GitHub Pages domain, e.g. `YOUR-GITHUB-USERNAME.github.io`.

(`localhost` is pre-authorized, so local testing works out of the box.)

### 6. Turn on GitHub Pages

1. In this GitHub repo: **Settings → Pages**.
2. Under "Build and deployment," set Source to **Deploy from a branch**, pick your main branch and the **/ (root)** folder, and save.
3. After a minute or two your site is live at `https://YOUR-GITHUB-USERNAME.github.io/Dunzo/`.

That's it. Open the site, sign in with Google, and start tracking.

## Testing locally

Browsers block JavaScript modules on `file://` pages, so open the folder with any static server, e.g.:

```
python3 -m http.server 8000
```

then visit `http://localhost:8000`.

## Costs

Everything runs on Firebase's free **Spark** plan: Firestore allows ~1 GiB of storage and tens of thousands of reads/writes per day, far beyond what a personal tracker uses. No credit card is required. (Note images live inside Firestore, deliberately avoiding Firebase Cloud Storage, which now requires a card.)

## Security & privacy

Dunzo's data protection rests on **two layers**: Firebase Authentication (Google sign-in) proves *who* you are, and **Firestore Security Rules** enforce *what* you can touch. The rules are the real lock, and they run on Google's servers — they can't be bypassed by editing the page, using dev tools, or crafting a custom request. Every user's data lives under `/users/<their-uid>/`, and the rule from setup step 3 only allows access when the signed-in account's ID matches that path:

```
allow read, write: if request.auth != null && request.auth.uid == userId;
```

**What this means:**

- **No one else can see your data** — not other Dunzo users, not the public. There is no shared or public data in Dunzo; every path is owner-scoped.
- **One Google account cannot access another's data.** Each account has a distinct, permanent Firebase user ID; the rule compares it to the data's owner, and a mismatch is denied by the server.
- **The public code and config are not a leak.** Anyone can load the Dunzo page and the `firebaseConfig` values are public by design — those only identify the project and grant no access on their own. Your security comes from the rules and sign-in, not from hiding the config. After signing in, each person sees only their own data.

**Residual risks to be aware of** (these are about account/project hygiene, not flaws in how Dunzo gates data):

1. **A compromised Google account.** Dunzo trusts Google's sign-in, so anyone who gets into your Google account gets into your Dunzo data. **Turn on 2-factor authentication** for the Google account(s) you use — this is the single biggest protection.
2. **Loosened Firestore rules.** If the rules are ever republished in an open "test mode" (e.g. `allow read, write: if true;`), your data becomes public. Keep the rules exactly as documented, and periodically confirm the live rules (Firestore → Rules) still match this README and aren't in a temporary open-test state.
3. **An unlocked, signed-in device.** Firebase keeps you logged in, so anyone at an already-signed-in browser can see that account's data. Use the **Sign out** button on shared devices and lock your screen.
4. **Leaked project admin credentials.** A Firebase *service-account key* (very different from the public `firebaseConfig`) bypasses the rules entirely — never commit one to the repo, and keep the Firebase project owned by an account you control.

**Export files** (`.json`, `.rtf`, `.ics`) contain your data in plaintext and are unencrypted. They're only created when you click Export, but treat the downloaded files like any sensitive document.

## Project layout

```
index.html            The whole UI (sign-in, list, modals, whiteboard)
styles.css            Styling
js/firebase-config.js Your Firebase project keys (fill this in; safe to commit)
js/app.js             All app logic (auth, Firestore, rendering, images, export)
js/emoji-data.js      Searchable emoji library
test/                 Headless end-to-end test (export/wipe/import cycle)
```
