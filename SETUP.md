# DEGEN — Setup Checklist

Your Firebase project (`ccscrypto-418c3`) needs two things turned on before the app works. Both in the [Firebase Console](https://console.firebase.google.com/project/ccscrypto-418c3).

## 1. Enable Authentication
Build → Authentication → Sign-in method → enable **Email/Password**.

## 2. Enable Firestore
Build → Firestore Database → Create database → start in **production mode** (rules below lock it down properly).

Storage is **not** required — avatars and coin logos are just image URLs (pasted by the user, or a generated default via DiceBear if left blank), so there's nothing to upload or host yourself.

## 3. Firestore rules
Paste into Firestore → Rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isSignedIn() { return request.auth != null; }
    function isOwner(uid) { return isSignedIn() && request.auth.uid == uid; }

    match /users/{uid} {
      allow read: if isSignedIn();
      allow create: if isOwner(uid);
      // block direct balance edits from the client except via allowed fields
      allow update: if isOwner(uid) &&
        !request.resource.data.diff(resource.data).affectedKeys().hasAny(['username','usernameLower','createdAt']);
      allow delete: if false;

      match /holdings/{coinId} {
        allow read: if isOwner(uid);
        allow write: if isOwner(uid);
      }
    }

    match /usernames/{name} {
      // must be public: the app checks username availability BEFORE the
      // user is signed in, so isSignedIn() here would block every signup
      allow read: if true;
      allow create: if isSignedIn() && request.resource.data.uid == request.auth.uid;
      allow update, delete: if false;
    }

    match /tickers/{ticker} {
      allow read: if isSignedIn();
      allow create: if isSignedIn();
      allow update, delete: if false;
    }

    match /coins/{coinId} {
      allow read: if isSignedIn();
      allow create: if isSignedIn() && request.resource.data.creatorUid == request.auth.uid;
      allow update: if isSignedIn(); // trades update reserves; validated by AMM math client-side + transactions
      allow delete: if false;
    }
  }
}
```

> Note: like most client-side trading demos, a determined user could tamper with balances via devtools since the trade math runs client-side inside a Firestore transaction rather than a Cloud Function. For a purely-for-fun/friends app this is fine. If you ever want it tamper-proof, the buy/sell logic should move into a Cloud Function — happy to help with that later.

## 4. Firestore indexes
The app queries coins ordered by `marketCap` and `createdAt`. Firestore will show a one-click "create index" link in the browser console the first time each query runs — just click it.

## 5. Deploy
Drop all files (`index.html`, `style.css`, `script.js`, `sw.js`, `manifest.json`) into a GitHub Pages repo root, keeping them side by side — no build step needed.

---

## How the exchange actually works
- Every coin launches with a **virtual bonding curve** (constant-product AMM, same style pump.fun uses): $4,200 virtual liquidity vs. 1B token supply, giving a realistic ~$4K starting market cap instead of ballooning wildly on the first trade.
- Price = liquidity ÷ tokens remaining in the curve. As people buy, liquidity goes up and tokens in the curve go down, so price rises — and vice versa on sells.
- Coins "graduate" 🎓 cosmetically once market cap crosses $69,000 (a nod to pump.fun's real graduation threshold — just a badge here, no extra mechanics).
- Launching a coin costs a $5 fee (from the $100 starting balance) to discourage spam.
- Avatars and coin logos are plain image URLs — paste a link to any hosted image (e.g. Imgur), or leave it blank for an auto-generated default.
- The chart has **1m / 1h / 1d / all** ranges and updates live in place (no page flicker, no losing whatever you were typing in the buy/sell box) whenever anyone trades.

### Bots
There's no server here — it's a static site on Firestore — so "bots" are simulated trades that any currently-open browser tab occasionally submits under a `Bot####`-style name (e.g. `Bot4821`), targeting coins launched in the last ~8 minutes:
- ~22% chance per coin per 14s tick: a small bot buy ($4–$44)
- ~3.5% chance: a big "explosion" buy ($300–$1,200) that spikes the price hard
- ~17% chance: a small bot sell ($3–$38), so the chart naturally dips too, not just climbs
- ~3% chance: a big "dump" sell ($250–$950)
- Bots never touch a real user's balance or holdings — they only move a coin's own price curve, and they leave a 🤖 marker (plus 💥 for explosions, 📉 for dumps) in the trade feed so it's clear it wasn't a real trader.
- Because this runs client-side, bot activity only happens while at least one browser tab has the app open. That's a real limitation of a no-backend/no-Cloud-Functions setup — if you want bots to run 24/7 even with nobody online, that logic would need to move to a scheduled Cloud Function instead.

### 80% max-ownership cap
No single account can hold more than 80% of a coin's 1B supply. If a buy would push someone over that line, it's automatically partial-filled up to exactly 80% and they're only charged (and only receive tokens) for that partial amount — the rest of what they typed in is simply never spent. This is enforced inside the same Firestore transaction as the trade itself, so it can't be raced.

### Admin "pump" easter egg
If you're signed in as the account with username `cameron` and email `detlaffcameron@gmail.com`, holding **Right Alt** and clicking any coin card/row sends 10–50 bots to buy into that coin in random amounts, staggered randomly over the next 2 minutes (coin cards get a dashed lime outline while Right Alt is held, so you can see it's armed). Like the rest of the bot system, this is 100% client-side — it's a fun toggle for one account, not a real access-control feature, and a determined user could bypass the check via devtools.

### Leaderboard
Explore → Leaderboard shows Daily / Weekly / All-Time top traders, ranked by change in total net worth (cash + current value of all holdings). Every real trade you make snapshots your net worth with a timestamp (`netWorthHistory` on your user doc); daily/weekly rankings compare your current net worth to your most recent snapshot from before that window. Two caveats worth knowing:
- Your own ranking updates live on every trade, and also refreshes each time you open the leaderboard. Other players' rankings only refresh when *they* trade — so someone who's holding a coin that's mooning right now but hasn't personally bought/sold anything today will look "frozen" until their next trade. A fully live version of this would need a backend job continuously repricing every portfolio, which is out of scope for a no-backend static site.
- The leaderboard reads every user's top-level document (capped at 200 users) to build the rankings — fine for a friends-group app, but something to be aware of if this ever grows to a large public userbase.

### Offline support
The app now works reasonably well with no connection:
- The static shell (`index.html`/`style.css`/`script.js`) is cached by a small service worker (`sw.js`), so the page itself still opens even with zero connectivity.
- Firestore's local persistent cache is enabled, so previously-loaded prices/balances/coins remain visible offline, and any trades you make while offline are queued and automatically synced once you're back online.
- An amber banner appears at the top of the screen whenever the browser reports it's offline.
- Deploy `sw.js` and `manifest.json` alongside the other three files (same flat repo root, no build step).
