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
    // Real security boundary for the admin "reset economy" control — checked against the EMAIL
    // ON THE VERIFIED FIREBASE AUTH TOKEN, which can't be spoofed from devtools (unlike the
    // client-side username check the app also does, which only decides whether to SHOW the
    // reset button — this is what actually enforces it).
    function isAdmin() { return isSignedIn() && request.auth.token.email == 'detlaffcameron@gmail.com'; }

    match /users/{uid} {
      allow read: if isSignedIn();
      allow create: if isOwner(uid);
      // Owners can update their own doc except username/usernameLower/createdAt. The admin can
      // ALSO update any user's doc, but only balance/netWorth/netWorthHistory — nothing else —
      // which is exactly what the reset control needs and no more.
      allow update: if
        (isOwner(uid) && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['username','usernameLower','createdAt'])) ||
        (isAdmin() && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['balance','netWorth','netWorthHistory']));
      allow delete: if false;

      match /holdings/{coinId} {
        // any signed-in user can VIEW holdings — this is what makes public profiles (open
        // positions on someone else's page) and the coin-page Top Holders list possible.
        // The admin can also write here (delete-only in practice), needed to wipe every
        // account's holdings during a full economy reset.
        allow read: if isSignedIn();
        allow write: if isOwner(uid) || isAdmin();
      }

      match /closedPositions/{recordId} {
        // One record per sell (not per coin) — readable by anyone signed in so it shows up on
        // public profiles. Same admin allowance as holdings, for the same reset reason.
        allow read: if isSignedIn();
        allow write: if isOwner(uid) || isAdmin();
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
      allow update: if false;
      // Deletable by the admin — needed both to free up a ticker name after a rug-pull cleanup
      // and during a full economy reset.
      allow delete: if isAdmin();
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
      // Deletable by the admin — used for rug-pull cleanup (delisting a crashed bot coin) and
      // for wiping user-launched coins during a full economy reset.
      allow delete: if isAdmin();
    }

    match /activity/{tradeId} {
      allow read: if isSignedIn();
      allow create: if isSignedIn() && request.resource.data.uid == request.auth.uid;
      allow update: if false;
      allow delete: if isAdmin(); // wiping the global feed is part of a full economy reset
    }
  }
}
```

> Note: like most client-side trading demos, a determined user could tamper with balances via devtools since the trade math runs client-side inside a Firestore transaction rather than a Cloud Function. For a purely-for-fun/friends app this is fine. If you ever want it tamper-proof, the buy/sell logic should move into a Cloud Function — happy to help with that later. The one exception is the admin reset control, which genuinely is enforced server-side (see `isAdmin()` above) since it's checked against the verified email on the Firebase Auth token rather than anything the client sends.

## 4. Firestore indexes
The app queries coins ordered by `marketCap` and `createdAt`, and the Activity feed queries `activity` ordered by `createdAt`. Firestore will show a one-click "create index" link in the browser console the first time each query runs — just click it. These are all single-field queries, which Firestore usually auto-manages without needing a manual composite index.

**Two composite indexes are required** for the Bot Market tab (`coins` filtered by `isBotCoin == true`, sorted by `marketCap` or `createdAt`) — see the Bot Market section below for the exact fields.

**One collection-group index is required** for the coin-page Top Holders list:
- Firestore Database → Indexes → Composite → Create Index
- Collection ID: `holdings`
- **Query scope: Collection group** (not "Collection" — this one's easy to miss, it's a dropdown/toggle right next to the Collection ID field)
- Fields: `coinId` Ascending, `tokens` Descending
- As always, the browser console will also print a direct "create index" link the first time the query runs if you'd rather use that.


## 5. Deploy
Drop all files (`index.html`, `style.css`, `script.js`, `sw.js`, `manifest.json`) into a GitHub Pages repo root, keeping them side by side — no build step needed.

---

## How the exchange actually works
- Every coin launches with a **virtual bonding curve** (constant-product AMM, same style pump.fun uses): $8,000 virtual liquidity vs. 1B token supply, giving a realistic starting market cap instead of ballooning wildly on the first trade, and keeping any single buy from scooping up an outsized share of the supply.
- Price = liquidity ÷ tokens remaining in the curve. As people buy, liquidity goes up and tokens in the curve go down, so price rises — and vice versa on sells.
- Coins "graduate" 🎓 cosmetically once market cap crosses $69,000 (a nod to pump.fun's real graduation threshold — just a badge here, no extra mechanics).
- Launching a coin costs a $5 fee (from the $100 starting balance) to discourage spam.
- Avatars and coin logos are plain image URLs — paste a link to any hosted image (e.g. Imgur), or leave it blank for an auto-generated default.
- The chart has **1m / 5m / 1h / 1d / all** ranges and updates live in place (no page flicker, no losing whatever you were typing in the buy/sell box) whenever anyone trades.

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

### Admin "reset economy" control
Same gated account — holding **Right Shift** reveals a pulsing "☢️ Reset Economy" button in the bottom corner. Clicking it opens a confirmation modal requiring you to type `RESET`. Confirming:
- Permanently deletes every user-launched coin and frees up their ticker names (Bot Market coins are untouched)
- Clears the global Activity feed
- Resets every account's cash balance, net worth, holdings, and closed positions back to a fresh start

Unlike the pump easter egg, this one has a **real** server-side security boundary — the Firestore rules check `request.auth.token.email`, the verified email on the Firebase Auth token, which can't be spoofed from devtools the way the client-side username check can. The client-side check just decides whether to show the button.

### Rug-pull events
Bot Market coins aren't permanent — once a bot coin is at least 15 minutes old, each 14s tick gives it a small (~0.15%) chance of a dramatic crash-and-delist event: price collapses 90–98% in one shot, it gets a 💀 RUGGED badge, buying is disabled (selling to cut losses still works), and ~45 seconds later it's deleted to make room for a fresh spawn. This mirrors how real memecoins behave and gives holding a bot coin actual stakes instead of it being a risk-free chart to watch.

### Leaderboard
Explore → Leaderboard shows Daily / Weekly / All-Time top traders, ranked by change in total net worth (cash + realizable value of all holdings). Every real trade you make snapshots your net worth with a timestamp (`netWorthHistory` on your user doc); daily/weekly rankings compare your current net worth to your most recent snapshot from before that window.
- **Freshness fix**: previously, someone's displayed net worth only updated when *they* personally traded — so a person holding a coin that's mooning right now but hasn't traded today would look "frozen." The leaderboard now recomputes live net worth (cash + realizable holdings value, read fresh each load) for its top candidates every time it loads, rather than trusting the stored field. This is read-only — it doesn't write anything back, so it can't race with anyone else's data, it just freshens what's displayed. To keep read cost sane as the userbase grows, it's bounded to the top ~60 candidates by last-known value rather than doing this for all 200 fetched users.
- The leaderboard reads every user's top-level document (capped at 200 users) to build the candidate list — fine for a friends-group app, but something to be aware of if this ever grows to a large public userbase.
- Clicking anyone's name on the leaderboard opens their public profile.
- A "Find a trader" search box above the leaderboard does a prefix search on username (using the `usernameLower` field already stored for signup uniqueness checks) — good for jumping straight to someone's profile. It's a prefix match, not fuzzy/substring search, since that's what Firestore's query model actually supports well.

### Bot Market
Explore now has two tabs: **Community Coins** (real launches, unchanged) and **🤖 Bot Market** — coins nobody created, that trade themselves 24/7:
- A pool of up to 18 bot coins exists at any time. Roughly once a minute, whichever browser tab has the app open rolls a 5% chance to spawn a new one (procedurally named, e.g. "Turbo Frog" / $TUFR) if the pool isn't full — so new ones appear "randomly," a handful of minutes apart.
- **Realistic token counts.** Each bot coin gets its own total supply, randomly chosen from a human-scale list (100K–25M) instead of the 1B-token scale community coins use. A 1B-supply coin unavoidably hands out millions of raw tokens for a completely ordinary buy — that's just the math, not a bug — so the fix for "why did $50 get me millions of coins" was giving bot coins a realistic supply, not a deeper curve. Liquidity depth is still picked independently ($4,000–$16,000, in dollar terms) so price and depth don't fight each other regardless of where the coin's simulated price history landed.
- A brand-new bot coin is backfilled with a fabricated launch history at spawn time: a wobbly random-walk price chart spanning a fake 3–9 hours, a trade count already in the thousands, and some recent trades — so it never looks freshly-launched-and-empty.
- Every 14s tick, each bot coin has a 75% chance to trade, with sizes ranging from small ($10–$130) to medium ($150–$800) to whale-sized swings ($1,200–$8,000) that spike the chart hard. Buy vs. sell isn't pure coin-flip noise — each coin has a fast-shifting "mood" (recalculated every 90 seconds) that leans it strongly bullish or bearish for a stretch before flipping, so charts show frequent, pronounced up/down runs rather than static jitter — while staying net-neutral over the long run for the same reason the young-coin bots were rebalanced (see Bots, above): no free liquidity drifting in over time.
- **Keeps moving while nobody's on the site.** There's no server here, so nothing can literally tick with zero browser tabs open anywhere — but the moment any tab reopens, every bot coin checks how long it's been since it last ticked and replays that whole gap as a compressed batch of simulated ticks (same trade logic, same mood sequence), written as one update. From your perspective, a bot coin you're holding really did drift up or down while you were offline — your portfolio value on return reflects it — it's just computed in one lump sum on the next visit rather than trickling in the whole time. (A truly always-on version would need a scheduled Cloud Function running server-side, which means upgrading to Firebase's paid Blaze plan — out of scope for this no-backend setup, but let me know if you want that path instead.)
- Bot Market coins never age out of bot activity the way young user coins do (8-minute window) — they're meant to always be live, **except** for rug-pulls (see below), which is how they eventually leave the pool.
- They're clearly labeled everywhere (🤖 BOT badge on the coin card and detail page) so it's never ambiguous that you're trading against automated counterparties, not real people. Real trades against them are still 100% real — your buys/sells hit the same AMM math and update your real balance and holdings, same as any user coin.
- **Extra Firestore index needed**: the Bot Market tab queries `coins` filtered by `isBotCoin == true` and sorted by `marketCap` or `createdAt`, which needs a composite index (Firestore will show a one-click "create index" link in the browser console the first time it runs — or pre-create `isBotCoin` Ascending + `marketCap` Descending, and `isBotCoin` Ascending + `createdAt` Descending, under Firestore → Indexes).

### Top Holders
Every coin's page now has a "Top Holders" panel, listing the biggest wallets by token count and their % of total supply. This uses a Firestore **collection-group** query across every user's `holdings` subcollection, filtered to that one coin — which needs `coinId`, `username`, and `avatarURL` denormalized onto each holding doc (now written on every buy/sell) plus a collection-group composite index (see the indexes section above). Holdings written before this update won't show up here until that holder trades again, since they're missing those fields.

### Realized P&L: every sell is a closed position
Selling any amount of a coin — not just fully exiting it — writes its own record to a new `users/{uid}/closedPositions` subcollection: tokens sold, proceeds, and that specific sale's realized profit/loss. The "Closed Positions" list on a profile shows all of these, most recent first (up to 100), so a partial sell shows up immediately instead of waiting until the whole bag is gone. Open Positions (still holding tokens) show unrealized P&L the same way as before. **Needs a Firestore rules update** — see the `closedPositions` block above.

### Profile: overall balance, today's change, and win rate
Profiles (yours and anyone else's) now show "Overall account balance" (cash + realizable value of everything held) separately from cash, a green/red line under the username showing today's % and $ change in net worth (reusing the leaderboard's daily-baseline logic), and a win rate stat (% of closed positions that were profitable), computed straight from the closed-positions data described above.

### Net worth history chart
The same "Net Worth Over Time" line chart appears in three places now: the Portfolio page, your own profile, and everyone's public profile — all plotted from the `netWorthHistory` field on that user's doc, which is public data already (any signed-in user can read `users/{uid}`). Since it's just visualizing an existing field, an admin economy reset (which resets `netWorthHistory` back to a single starting point for every account) automatically wipes these charts too — nothing extra needed there.

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

