# ✅ Dunzo

A browser-based tracker for your stuff. Plain HTML/CSS/JavaScript hosted on GitHub Pages, with data stored per-user in Firebase (Google sign-in + Firestore database). No build step, no server of your own.

## What it does

- **Sign in with Google** — each user's data is private to their account.
- **List-O-Stuff** — your list of "Trackables," each with an emoji, a name, and color-coded tags (emojis allowed in tag names).
- **Date types** for each Trackable:
  - **Exact Due Date** — a specific day.
  - **Goal Date** — a specific day, week, or month. For sorting, a goal week's due date is the Sunday ending that week; a goal month's is its last day.
  - **Countdown** — enter a number of days (e.g. 30) and it counts down from today: "30 days left," "29 days left," … then "overdue."
  - **None** — just shows how many days it's been listed.
- **Sorting** — by effective due date, soonest first. Dateless items sit at the bottom, oldest first. Countdown items sort by the date they're counting down to, but that date is never shown.
- **Tags** — the tag bar at the top fills in as you create tags. Click a tag to filter the list to matching Trackables; click again to clear the filter.
- **Dunzo!** — marks a Trackable complete. It disappears from the default view and gets the green **Dunzo ✅** tag; click that tag in the bar to see completed items (and un-Dunzo them if needed).
- **Edit Me** — change anything about a Trackable.
- **Notes** — attach text notes and images (JPEG, PNG, or auto-playing GIFs) to any Trackable. Images are compressed in your browser and stored inside the database, so everything stays on Firebase's free tier — no credit card needed. GIFs must be under ~350 KB (they can't be recompressed without losing animation).

## One-time setup

You need a (free) Firebase project. This takes about 10 minutes.

### 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with your Google account.
2. Click **Create a project** (or "Add project"), name it anything (e.g. `dunzo`), and continue. You can turn **off** Google Analytics when asked — it's not needed.

### 2. Turn on Google sign-in

1. In the left sidebar: **Build → Authentication → Get started**.
2. On the **Sign-in method** tab, click **Google**, toggle **Enable**, pick a support email, and **Save**.

### 3. Create the database

1. In the left sidebar: **Build → Firestore Database → Create database**.
2. Choose a location (pick one near you), and start in **production mode**.
3. Go to the **Rules** tab, replace the contents with the rules below, and click **Publish**. These make each user's data readable and writable only by that user:

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

1. **Project settings** (gear icon next to "Project Overview") → **General** tab.
2. Under "Your apps," click the **web icon `</>`**, give it a nickname (e.g. `dunzo-web`), and click **Register app**. Skip Firebase Hosting.
3. Firebase shows a `firebaseConfig` code block. Copy those values into **`js/firebase-config.js`** in this repo, replacing the `PASTE_YOUR_...` placeholders. (These values are safe to commit — they identify your project publicly; your security comes from the Firestore rules and Google sign-in, not from hiding the config.)

### 5. Authorize your GitHub Pages domain

Google sign-in only works from domains you approve:

1. **Build → Authentication → Settings → Authorized domains → Add domain**.
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

## Project layout

```
index.html            The whole UI (sign-in, list, modals)
styles.css            Styling
js/firebase-config.js Your Firebase project keys (fill this in)
js/app.js             All app logic (auth, Firestore, rendering, images)
```
