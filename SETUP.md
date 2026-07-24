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
        allow read: if isSignedIn();
        allow write: if isOwner(uid);
      }

      match /closedPositions/{recordId} {
        // One record per sell (not per coin) — readable by anyone signed in so it shows up on
        // public profiles, writable only by the account it belongs to.
        allow read: if isSignedIn();
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
      // Real launches must be tagged with the actual signed-in user. Bot Market coins are
      // self-spawned by whichever browser tab is running the bot loop — they're always tagged
      // creatorUid:'bot' + isBotCoin:true, never tied to a real uid, so they get their own clause.
      allow create: if isSignedIn() && (
        request.resource.data.creatorUid == request.auth.uid ||
        (request.resource.data.creatorUid == 'bot' && request.resource.data.isBotCoin == true)
      );
      allow update: if isSignedIn(); // trades update reserves; validated by AMM math client-side + transactions
      allow delete: if false;
    }

    match /activity/{tradeId} {
      allow read: if isSignedIn();
      allow create: if isSignedIn() && request.resource.data.uid == request.auth.uid;
      allow update, delete: if false;
    }
  }
}
```

> Note: like most client-side trading demos, a determined user could tamper with balances via devtools since the trade math runs client-side inside a Firestore transaction rather than a Cloud Function. For a purely-for-fun/friends app this is fine. If you ever want it tamper-proof, the buy/sell logic should move into a Cloud Function — happy to help with that later.

## 4. Firestore indexes
The app queries coins ordered by `marketCap` and `createdAt`, and the new Activity feed queries `activity` ordered by `createdAt`. Firestore will show a one-click "create index" link in the browser console the first time each query runs — just click it. These are all single-field queries, which Firestore usually auto-manages without needing a manual composite index.

## 5. Deploy
Drop all files (`index.html`, `style.css`, `script.js`, `sw.js`, `manifest.json`) into a GitHub Pages repo root, keeping them side by side — no build step needed.

---

## How the exchange actually works
- Every coin launches with a **virtual bonding curve** (constant-product AMM, same style pump.fun uses): $8,000 virtual liquidity vs. 1B token supply, giving a realistic starting market cap instead of ballooning wildly on the first trade, and keeping any single buy from scooping up an outsized share of the supply.
- Price = liquidity ÷ tokens remaining in the curve. As people buy, liquidity goes up and tokens in the curve go down, so price rises — and vice versa on sells.
- Coins "graduate" 🎓 cosmetically once market cap crosses $69,000 (a nod to pump.fun's real graduation threshold — just a badge here, no extra mechanics).
- Launching a coin costs a $5 fee (from the $100 starting balance) to discourage spam.
- Avatars and coin logos are plain image URLs — paste a link to any hosted image (e.g. Imgur), or leave it blank for an auto-generated default.
- The chart has **1m / 1h / 1d / all** ranges and updates live in place (no page flicker, no losing whatever you were typing in the buy/sell box) whenever anyone trades.

### Portfolio value now reflects real slippage
Previously, your portfolio and net worth (and therefore the leaderboard) valued every holding as `tokens × current spot price`. That overstated what you could actually walk away with, because spot price is only the price of the *next* token — selling a large stack pushes the price down as you sell, same as any bonding curve/AMM. Portfolio value, the leaderboard, and each holding's shown value now run the actual sell math (`ammSell`) to show what you'd realistically get if you sold right now, which is what fixes the "it said I'd get $1,000 but I only got $100" issue.

### Bots
There's no server here — it's a static site on Firestore — so "bots" are simulated trades that any currently-open browser tab occasionally submits under a `Bot####`-style name (e.g. `Bot4821`), targeting coins launched in the last ~8 minutes:
- ~20% chance per coin per 14s tick: a small bot buy ($4–$40)
- ~20% chance: a small bot sell ($4–$40)
- ~3% chance: a big "explosion" buy ($200–$700) that spikes the price hard
- ~3% chance: a big "dump" sell ($200–$700)
- Buy/sell chances and sizes are matched on purpose. Bots don't have real balances — a bot "buy" pushes a coin's liquidity up as if real money arrived, and a real user selling afterward can walk away with that as actual spendable balance. If bot buying outweighed bot selling even slightly (as it did before), every young coin's liquidity would drift upward for free over time — easy money backed by nothing. Symmetric bots keep that drift near zero while still giving the chart plenty of pump/dump chaos.
- Bots never touch a real user's balance or holdings — they only move a coin's own price curve, and they leave a 🤖 marker (plus 💥 for explosions, 📉 for dumps) in the trade feed so it's clear it wasn't a real trader. Bot trades also don't appear in the global Activity feed, since that's specifically for real people.
- Because this runs client-side, bot activity only happens while at least one browser tab has the app open. That's a real limitation of a no-backend/no-Cloud-Functions setup — if you want bots to run 24/7 even with nobody online, that logic would need to move to a scheduled Cloud Function instead.

### 35% max-ownership cap
No single account can hold more than 35% of a coin's 1B supply (down from the original 80%, which let one buyer dominate a coin's whole curve). If a buy would push someone over that line, it's automatically partial-filled up to exactly 35% and they're only charged (and only receive tokens) for that partial amount — the rest of what they typed in is simply never spent. This is enforced inside the same Firestore transaction as the trade itself, so it can't be raced.

### Admin "pump" easter egg
If you're signed in as the account with username `cameron` and email `detlaffcameron@gmail.com`, holding **Right Alt** and clicking any coin card/row sends 10–50 bots to buy into that coin in random amounts, staggered randomly over the next 2 minutes (coin cards get a dashed lime outline while Right Alt is held, so you can see it's armed). Like the rest of the bot system, this is 100% client-side — it's a fun toggle for one account, not a real access-control feature, and a determined user could bypass the check via devtools.

### Leaderboard
Explore → Leaderboard shows Daily / Weekly / All-Time top traders, ranked by change in total net worth (cash + realizable value of all holdings). Every real trade you make snapshots your net worth with a timestamp (`netWorthHistory` on your user doc); daily/weekly rankings compare your current net worth to your most recent snapshot from before that window. Two caveats worth knowing:
- Your own ranking updates live on every trade, and also refreshes each time you open the leaderboard. Other players' rankings only refresh when *they* trade — so someone who's holding a coin that's mooning right now but hasn't personally bought/sold anything today will look "frozen" until their next trade. A fully live version of this would need a backend job continuously repricing every portfolio, which is out of scope for a no-backend static site.
- The leaderboard reads every user's top-level document (capped at 200 users) to build the rankings — fine for a friends-group app, but something to be aware of if this ever grows to a large public userbase.
- Clicking anyone's name on the leaderboard opens their public profile.

### Bot Market
Explore now has two tabs: **Community Coins** (real launches, unchanged) and **🤖 Bot Market** — coins nobody created, that trade themselves 24/7:
- A pool of up to 18 bot coins exists at any time. Roughly once a minute, whichever browser tab has the app open rolls a 5% chance to spawn a new one (procedurally named, e.g. "Turbo Frog" / $TUFR) if the pool isn't full — so new ones appear "randomly," a handful of minutes apart, exactly like the ask.
- A brand-new bot coin is backfilled with a fabricated launch history at spawn time: a wobbly random-walk price chart spanning a fake 3–9 hours, a trade count already in the thousands, and some recent trades — so it never looks freshly-launched-and-empty, it looks like an established, volatile market from the moment it appears.
- Every 14s tick, each bot coin has a 50% chance to trade, with sizes ranging from small ($6–$60) to medium ($60–$360) to rare whale-sized swings ($500–$3,000) that spike the chart. Buy vs. sell isn't pure coin-flip noise — each coin has a slow-shifting "mood" (a deterministic pseudo-random bias recalculated every ~4 minutes) that leans it bullish or bearish for a stretch before flipping, so the chart shows believable multi-minute trends instead of static jitter, while staying net-neutral over the long run for the same reason the young-coin bots were rebalanced (see Bots, above) — no free liquidity drifting in over time.
- Bot Market coins never stop trading and never "graduate" out of bot activity, unlike young user coins which age out after 8 minutes — they're meant to always be live.
- They're clearly labeled everywhere (🤖 BOT badge on the coin card and detail page) so it's never ambiguous that you're trading against automated counterparties, not real people. Real trades against them are still 100% real — your buys/sells hit the same AMM math and update your real balance and holdings, same as any user coin.
- **Extra Firestore index needed**: the Bot Market tab queries `coins` filtered by `isBotCoin == true` and sorted by `marketCap` or `createdAt`, which needs a composite index (Firestore will show a one-click "create index" link in the browser console the first time it runs — or pre-create `isBotCoin` Ascending + `marketCap` Descending, and `isBotCoin` Ascending + `createdAt` Descending, under Firestore → Indexes).

### Recent Activity feed
A new "Activity" tab shows a live, global feed of real buys and sells across every coin (bot trades are excluded — this is about real people). Each real trade is written to a new top-level `activity` Firestore collection inside the same transaction as the trade itself. Clicking a username in the feed opens that person's profile, and clicking a ticker jumps to that coin.

### Public profiles
Clicking any username — on the leaderboard, in a coin's recent trades, in the Activity feed, or on the "launched by" tag on a coin's page — opens that person's profile (or your own editable one, if it's you). A profile shows:
- Cash balance
- **Open positions**: every coin still held, with current realizable value and unrealized profit/loss (▲/▼)
- **Closed positions**: coins fully exited at some point, with total bought, total sold, and realized profit/loss

This works off new fields tracked on each holding (`costBasis`, `totalBoughtUsd`, `totalSoldUsd`, `realizedPnl`), updated transactionally on every buy/sell. Because someone else's holdings need to be readable to show their profile, the Firestore rules above now allow any signed-in user to *read* (not write) anyone's holdings subcollection — writes are still locked to the owner.

### Offline support
The app now works reasonably well with no connection:
- The static shell (`index.html`/`style.css`/`script.js`) is cached by a small service worker (`sw.js`), so the page itself still opens even with zero connectivity.
- Firestore's local persistent cache is enabled, so previously-loaded prices/balances/coins remain visible offline, and any trades you make while offline are queued and automatically synced once you're back online.
- An amber banner appears at the top of the screen whenever the browser reports it's offline.
- Deploy `sw.js` and `manifest.json` alongside the other three files (same flat repo root, no build step).

