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

    // Nested subcollection rules (like the one above) only govern DIRECT access to a specific
    // user's holdings — they do NOT automatically extend to a Firestore collection-group query
    // (i.e. "search every user's holdings subcollection at once", which is what the Top Holders
    // list on a coin's page does). Collection-group access needs its own separate rule using the
    // {path=**} wildcard, matched at the top level rather than nested inside /users/{uid}.
    match /{path=**}/holdings/{coinId} {
      allow read: if isSignedIn();
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
      // Real trades are tagged with the actual signed-in user. Whale-sized BOT trades are also
      // logged here now (to power the platform-wide whale alert), always tagged uid:'bot' —
      // same pattern as bot-spawned coins.
      allow create: if isSignedIn() && (request.resource.data.uid == request.auth.uid || request.resource.data.uid == 'bot');
      allow update: if false;
      allow delete: if isAdmin(); // wiping the global feed is part of a full economy reset
    }

    match /meta/{docId} {
      // Small shared docs used by client-side bot scheduling: botSpawnSchedule (next guaranteed
      // ambient Bot Market spawn time) and insiderSchedule (the Insider Insights feature's
      // upcoming-coin reveal + countdown). Same trust model as everything else bot-related in
      // this app — any signed-in tab's bot loop can read/write these, not just the admin. The
      // Insights *page* itself is still gated client-side to specific accounts (see
      // canSeeInsights() in script.js) — like the other admin-flavored features, that's a UI
      // gate, not a real access-control boundary, and this doc being broadly readable doesn't
      // change that (there's nothing sensitive in it beyond a coin name arriving a bit early).
      allow read: if isSignedIn();
      allow write: if isSignedIn();
    }

    match /transfers/{transferId} {
      // The security design behind peer-to-peer sends (bank money + coins): nobody ever writes
      // directly to someone else's balance/holdings. The SENDER debits their own account and
      // creates this doc addressed to the recipient (create requires fromUid to be the real
      // signed-in user). The RECIPIENT is the only one allowed to update it, and only to flip
      // status from 'pending' to 'completed' — nothing else, so they can't tamper with the
      // amount/coinId on their way to crediting themselves in their own transaction.
      allow read: if isSignedIn();
      allow create: if isSignedIn() && request.resource.data.fromUid == request.auth.uid;
      allow update: if isSignedIn() && resource.data.toUid == request.auth.uid
        && resource.data.status == 'pending' && request.resource.data.status == 'completed'
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status']);
      allow delete: if false;
    }

    match /copyFollowers/{targetUid}/followers/{copierUid} {
      // Lets a target's own client find "who copies me" without needing any write access to
      // those people's accounts — each copier only ever writes the ONE doc keyed by their own
      // uid, regardless of whose followers subcollection it lives under.
      allow read: if isSignedIn();
      allow write: if isSignedIn() && request.auth.uid == copierUid;
    }

    match /copyOrders/{orderId} {
      // Push-based Copy Trade: the TARGET's own client creates this the instant it trades
      // (always tagged as itself, never able to impersonate being someone else's target). Only
      // the addressed COPIER can update it, and only to flip status from 'pending' to
      // 'completed' once they've actually executed the copy under their own session — same
      // pattern as transfers, for the same reason.
      allow read: if isSignedIn();
      allow create: if isSignedIn() && request.resource.data.targetUid == request.auth.uid;
      allow update: if isSignedIn() && resource.data.copierUid == request.auth.uid
        && resource.data.status == 'pending' && request.resource.data.status == 'completed'
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status']);
      allow delete: if false;
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

**One more composite index is required** for receiving peer-to-peer transfers (bank sends + coin sends):
- Collection ID: `transfers`
- Query scope: Collection
- Fields: `toUid` Ascending, `status` Ascending
- This powers `listenIncomingTransfers()`, which filters by both fields at once (two equality filters on different fields always need a composite index, unlike a single range filter + matching orderBy). Until this index exists, incoming transfers simply won't be noticed — the listener's error is caught silently, so it fails quiet rather than loud; check the browser console for the create-index link if sends don't seem to be arriving.

**One more composite index is required** for Copy Trade's push-based order queue:
- Collection ID: `copyOrders`
- Query scope: Collection
- Fields: `copierUid` Ascending, `status` Ascending
- Same reasoning as the transfers index above — powers `listenCopyOrders()`, which also filters two fields at once. Without it, queued copy orders simply won't be noticed by the copier's client.


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
- Explore (both Community and Bot Market tabs) shows **every** coin that exists — no cap. This used to be capped at the 60 most recent per tab; that cap is gone now. **Worth knowing**: since this is a live (`onSnapshot`) listener with no `limit()`, it re-syncs on every single matching document's changes while someone has Explore open — including every bot coin's price tick. As the total coin count grows over a long-running app (nothing gets deleted anymore — see Rug-pull events and the persistence notes below), this is a real, unbounded cost/performance tradeoff for "see literally everything," and it's the kind of thing that contributed to hitting Firestore's rate limits once already (see the fix noted under Bot Market below). Worth keeping an eye on if the coin count grows very large.

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
- **Fixed: real buys/sells occasionally taking ages or looking stuck.** The cause was contention — bot ticks (especially the Bot Market loop, which can touch up to 30 coins at 75% trade chance each) used to fire every qualifying transaction in the same synchronous instant, which meant a real trade could land on a coin at the exact same moment 10+ bot transactions were racing to update that same document, forcing Firestore-level retries. Two fixes: bot trades now fire on a randomized stagger spread across most of the 14s tick window instead of all at once (much lower peak concurrent load), and a coin with a real trade currently in flight is skipped by both bot loops entirely until it resolves.

### 35% max-ownership cap
No single account can hold more than 35% of a coin's 1B supply (down from the original 80%, which let one buyer dominate a coin's whole curve). If a buy would push someone over that line, it's automatically partial-filled up to exactly 35% and they're only charged (and only receive tokens) for that partial amount — the rest of what they typed in is simply never spent. This is enforced inside the same Firestore transaction as the trade itself, so it can't be raced.

### Admin "pump" easter egg
If you're signed in as the account with username `cameron` and email `detlaffcameron@gmail.com`, holding **Right Alt** and clicking any coin card/row sends **150–250 real bots** to buy into that coin in random amounts ($150–$2,650 each) over the next 10 seconds (coin cards get a dashed lime outline while Right Alt is held, so you can see it's armed). It also mutes bot-generated *sell* pressure on that specific coin for the next 5 minutes — real user sells are completely unaffected, this only stops the same bot loops from immediately dumping the pump back down. That 5-minute window is written to the coin's own Firestore doc (`pumpSellSuppressUntil`) rather than kept as local browser state, so it survives a hard refresh and is honored by every client, not just the tab that triggered it — only the in-flight staggered buy timers themselves are lost on a refresh, since those are genuinely ephemeral client-side timers with no backend to persist them.

**"1000+ bots, instantly to the moon"**: `instantMoonBoost()` fires the moment the pump starts, not staggered like the rest — one transaction that directly solves the constant-product AMM invariant (`k = solReserve × tokenReserve`) for a price jump of **+700% to +1400%** from the coin's own reference point, and adds a **tradeCount jump of 3,000–8,000** on top of whatever it already had. **Worth being fully honest about**: this does NOT mean 1000+ individual Firestore transactions actually fire — literally doing that in a 10-second burst would risk the exact rate-limit problem this app already hit once before, from far smaller volume (see the fix noted elsewhere in this file). Instead, the 150–250 real staggered bot buys are genuine individual trades, and the large tradeCount jump stands in for "the rest" of the claimed scale honestly, rather than pretending 1000+ separate trades actually happened one by one. The end result — price, trade count, and chart — looks and behaves like a coin that just got aped into by well over a thousand bots; the mechanism just doesn't require actually writing that many documents to get there.

The older +100%-minimum guarantee (`guaranteePumpToPositive100()`) still runs afterward as a safety net underneath the much bigger instant moon-boost, in case that one somehow fails to land.

Like the rest of the bot system, this is 100% client-side — it's a fun toggle for one account, not a real access-control feature, and a determined user could bypass the check via devtools.

### Wealth for people who already have more money than they know what to do with
Four things aimed specifically at whales, since "buy more of the same coin" stops being interesting past a certain point:

**Wealth-tier badges** — Millionaire ($1M) → Billionaire ($1B) → Trillionaire ($1T) → Quadrillionaire → Quintillionaire → Sextillionaire → Septillionaire → Octillionaire → Nonillionaire → Decillionaire ($1 undecillion... well, $1 followed by 33 zeros), each with its own emoji, shown next to a username wherever one appears — Leaderboard, the global Activity feed, and both profile pages. `wealthTierFor()`/`wealthBadgeHtml()` in script.js. For the Activity feed specifically, net worth is denormalized onto each trade record at write time (`netWorth: state.userDoc.netWorth||0` in both `doBuy` and `doSell`) rather than looked up per row when rendering — avoids needing an extra read for every distinct trader shown in a 50-entry feed. One honest caveat: this means the badge reflects net worth as of *just before* that specific trade, not the instant after — a vanity badge doesn't need to be that precise, but worth knowing if the numbers ever look slightly off from a live profile check.

**Cosmetic flexes** — pure vanity, zero gameplay effect, unlocked automatically at wealth milestones (no purchase needed, just cross the threshold): an avatar glow at $1M; an animated conic-gradient ring **and** a gradient shimmer username color at $1B; a custom gradient profile banner at $1T (8 presets now — Sunset, Neon, Aurora, Inferno, Midnight, Gold, Royal, Matrix, up from an initial 4); and a custom flair pill (any 24-character text you set yourself, e.g. "Certified Degen") next to your name at $1Qa (quadrillionaire). Toggleable/editable from a "🎨 Cosmetic Flexes" panel on your own profile. Deliberately re-evaluated live against *current* net worth every render (`activeCosmetics()`) rather than a one-time unlock flag — if net worth ever drops back below a threshold, that effect stops showing until crossed again, so it stays an honest reflection of where someone actually stands rather than a permanent trophy from a peak that's since passed.

**Philanthropy leaderboard** — a new "🎁 Philanthropy" tab alongside Daily/Weekly/All-Time, ranked by `totalGivenUsd` (a running total on your own user doc, incremented by both `sendCashToUser` and `sendCoinToUser` — a gifted coin counts at its market value at send-time, same valuation already used for the recipient's cost basis). Single-field sort, no composite index needed. Reframes "I have too much money" as a flex that actually helps other players instead of the wealth just sitting there as a number nobody else benefits from.

**Fund a Giveaway** — a new panel on the Bank page: pick a total amount and a number of winners, and it splits that amount (not perfectly evenly — some randomness in who gets what, for the reveal factor) between that many real, recently-active people, picked from the last 100 Activity feed entries (excluding bots and yourself). This reuses the **exact same secure transfer system** already built for regular sends — no new security design needed. The funder debits their own bank balance and creates one pending `transfers` doc per winner; each winner's own client is still the only thing that ever credits their account, exactly like a normal send, just fanned out to several people from one action. Publicly announced in the Activity feed with its own distinct row style (🎉 icon, doesn't try to force itself through the buy/sell template), and counts toward the funder's Philanthropy total too.

**Proper winner announcements**: winning is no longer just a generic "@x sent you money" toast. `showGiveawayWinOverlay()` gives the winner the same full-screen celebratory treatment as the billionaire explosion below (plus confetti) — "🎉 You won $X! @funder just funded a giveaway and you were picked." The public Activity feed announcement also names the actual winners now (`winnerUsernames` stored on the announcement doc), shown as a "🏆 Went to: @alice, @bob, ..." sub-line — not just a headcount like the first version had.

**Billionaire+ trade explosion**: any $1B+ net-worth user's buy or sell — any size, not just whale-sized — triggers a genuine full-screen moment for everyone currently using the app: a dramatic centered overlay with their wealth-tier icon, a confetti burst, and "@username the BILLIONAIRE just BOUGHT $X of $TICKER!", auto-dismissing after ~4.5s or click-to-jump-to-the-coin. Built by extending the existing whale-alert listener (`listenWhaleAlerts()`) rather than standing up a second listener watching the same `activity` collection — the net-worth check was already available there via the denormalized `netWorth` field. Deliberately **not** gated by the bot-notifications toggle — that setting is specifically for ambient bot noise, and this is real trades from real people, which felt like it should always show.

**Bank: Deposit All + percentages**: quick 25%/50%/75%/All buttons on the Deposit/Withdraw panel, filling the amount field from your current cash balance — the "All" button doubles as a one-tap Deposit All.

**Custom default buy amounts**: a new "💵 Default Buy Amounts" panel on your own profile lets you set your own three quick-buy dollar amounts (`tradeDefaults.buyAmounts` on your user doc), replacing the previously hardcoded $5/$20/$50 on every coin's buy panel — set whatever actually matches how you trade.

### Large number formatting (billions, trillions, and beyond)
`fmtUsd()` and `fmtTok()` used to cap out at M (millions) and B (billions) respectively — anything larger just printed as an absurdly large number with that same suffix (e.g. a $50 billion net worth would've shown as "$50000.00M"). With compounding mechanics in this app now (guaranteed-growth, pump, bank interest, Copy Trade snowballing, etc.), real numbers can land well past that. Both functions now share one extended suffix ladder: K, M, B, T, Qa (quadrillion), Qi (quintillion), Sx (sextillion), Sp (septillion), Oc (octillion), No (nonillion), Dc (decillion) — comfortably covers anything up to 33 zeros. A number with 20 zeros, for example, now reads as something like "$150.00Qi" instead of an unreadable string of digits.

### Bot notifications toggle
A "🔔 Bot notifications" On/Off toggle on your own profile settings — defaults to On (matches existing behavior). Turning it off suppresses two specific things: whale alert toasts for trades tagged `uid:'bot'` (real user whale trades are completely unaffected — those keep showing regardless), and the "💀 coin just got rugged" toast. Stored as `notifPrefs.botNotifications` on your user doc, checked via `botNotificationsEnabled()`. Deliberately scoped to ambient bot-market noise only — snipe-bot and Copy Trade confirmation toasts aren't touched by this setting, since those are actionable information about your own money moving, not background noise, even though they're technically automated too.

### Pinned coins
**Portfolio-only and private** — pinning moved off both profile pages entirely. Any held coin can be pinned from the Portfolio holdings list — up to 3 at a time — via a Pin/Unpin button next to each row; pinned coins sort to the top (marked with 📌) there. This is purely a personal organizational tool now: nobody else can see what you've pinned, not even on your own public profile, which shows holdings in plain value order with no pin awareness at all. Stored as a plain `pinnedCoins` array on your user doc — same underlying field as before, just no longer read by either profile page's rendering.

### Bank
Its own dedicated nav tab now (sidenav + bottom nav), separate from Portfolio — a compact summary card on the Portfolio page still shows the current balance and links through. Bank balance now counts toward your overall net worth (leaderboard ranking, profile "Overall account balance," and the net-worth chart) and shows as its own line — "Bank" — on both your own and public profiles, right alongside Cash. Separate from your regular cash balance otherwise:
- **Deposit** moves cash into the bank; **Withdraw** moves it back — both simple single-user transactions, nothing cross-account involved.
- **Daily growth**: 2%/day, compounding. There's no server to run this continuously, so it's computed the same "catch-up" way as the bot-coin offline mechanic elsewhere in this app — whole days elapsed since `bank.lastGrowthAt` are compounded in one shot whenever you next sign in. Miss five days, get five days' growth applied at once, not more, not less.
- **Send to another user** — see Peer-to-peer transfers below for how this actually works under the hood.
- **Stats**: total interest earned lifetime, when it last grew, and a Recent Activity list (last 20 entries: deposits, withdrawals, sends, receives, and each growth tick) stored in `bank.history` on your user doc.

### Username autocomplete on recipient fields
Every "type a username" field involved in sending or following someone — bank send, coin send, and the Copy Trade target field — now shows a live dropdown of matching users as you type (`attachUserAutocomplete()`, same prefix-search-on-`usernameLower` approach as the Leaderboard's user search, just rendered as a small dropdown under the input instead of a full panel). Click a result to fill it in. Debounced ~200ms so it's not firing a query on every keystroke.

**Fixed: dropdown positioning.** It originally positioned itself relative to `inputEl.parentElement`, assuming that would always be a small, input-sized wrapper. In the Send Coin modal specifically, the input has no dedicated wrapper — its parent is the entire modal box — so the dropdown ended up positioned relative to the whole modal instead of just the input, which could visually overlap or intercept clicks on the Send/Cancel buttons beneath it. Now `attachUserAutocomplete()` wraps the input in its own small positioned container on attach, so the dropdown is always correctly scoped to that one field regardless of what its surrounding markup looks like.

### Peer-to-peer transfers (bank sends + coin sends)
Firestore rules only ever let you write your OWN balance and holdings (see `isOwner()` throughout) — a naive "send money to someone" feature would need to relax that to "any signed-in user can write any other user's balance," which is a real, serious hole, unlike the narrow single-account admin relaxations elsewhere in this app. Instead: **sending debits your own account and creates a `transfers` doc addressed to the recipient; the recipient's own client is the only thing that ever credits their account**, the moment it notices a pending transfer meant for them (`listenIncomingTransfers()`, started at sign-in). Every write is still always to your own document — the `transfers` collection is purely the coordination point, enforced by the rules above (create locked to the sender being who they claim; update locked to the addressed recipient, and only for the pending→completed flip, nothing else).

Both bank-to-bank cash sends and coin gifts use this same system (`type:'cash'` or `type:'coin'` on the transfer doc). A gifted coin is valued at its market price at send-time for cost-basis purposes on the recipient's side — not free, not zero — so a gift can't manufacture profit or loss out of nothing for either party. Sending a coin is available from the Sell panel on that coin's own page ("🎁 Send to a user").

**Fixed: coin sending wasn't actually sending.** Two real, separate bugs:
1. Clicking MAX in the Send Coin modal sets the amount to your cached holding, but the *freshly read* holding inside the actual transaction can differ from that by a tiny float-rounding amount — same class of MAX-button precision bug already fixed twice before in regular buy/sell. That mismatch was rejecting legitimate "send everything" attempts outright with `"You don't have that many tokens."` Now clamped to whatever's actually available instead of rejected, same tolerance already used in `doBuy`/`doSell`.
2. The username-autocomplete dropdown (see below) was positioning itself relative to whatever the input's parent happened to be — in the Send Coin modal, that's the *entire* modal box, since the input has no dedicated wrapper div. That could visually overlap or intercept clicks meant for the Send/Cancel buttons beneath it. Fixed generally, not just for this one modal — see the autocomplete section.

**Same honest caveat as the rest of the bot system**: this can only actually land once the recipient's own account is signed in on some tab of theirs. The very first snapshot the recipient's listener receives naturally includes anything that arrived while they were fully away (Firestore delivers existing matching docs as 'added' on initial sync), so it self-catches-up with no extra cursor logic needed — but if they're never signed in again, it just waits indefinitely as a pending transfer.

### Snipe bot upgrade: category amounts ($1,000)
Replaces the single flat "amount per coin" with three separate amounts — community coins, Bot Market coins, and guaranteed-growth coins (Right Ctrl/Insider Insights) each get their own dollar figure, editable independently. Guaranteed-growth coins are deliberately their own category here, distinct from ordinary bot coins, since they're a very different risk profile (permanently rug-proof, heavily bullish-biased) and someone might reasonably want to snipe those harder than an ordinary coin. Requires owning the base auto-snipe bot first.

### Snipe bot upgrade: Copy Trade ($2,500)
Pick up to 5 real traders (by username) to automatically mirror. A copied **buy** uses your own chosen dollar amount for that target, not theirs; a copied **sell** dumps your entire position in that coin, since there's no clean way to mirror "they sold 40%" using a fixed dollar figure.

**Push-based design** (reworked from an earlier polling version): rather than YOUR OWN client watching the activity feed for trades to mirror — which only works while your tab happens to be open around the same time as theirs — the **target's own client** pushes the order the instant it trades. Concretely: `addCopyTarget()` writes a doc to `copyFollowers/{targetUid}/followers/{yourUid}` (each follower only ever writes the one doc keyed by their own uid, regardless of whose subcollection it's under — no write access to the target's account needed). Every real `doBuy`/`doSell` then calls `pushCopyOrdersForTrade()`, which reads that trader's *own* followers list and queues a `copyOrders` doc for each one, tagged with the amount *they* configured. The copier's client (`listenCopyOrders()`) watches for orders addressed to it and executes them — the first snapshot naturally includes anything queued while it was offline, so there's no separate catch-up sweep needed here, unlike the base snipe bot.

**What this does and doesn't fix**: the actual money movement still has to happen under the copier's own session — that's a hard Firebase Auth boundary, not something any client-side cleverness can route around, so "even while offline" still isn't literally true for the copier. What it *does* fix: the trade **decision** is now captured reliably in real time by whoever is definitely online at that instant — the target, mid-trade — instead of depending on both people happening to be online at the same moment for the copier's own listener to notice. Nothing is ever missed or timing-dependent on the recording side; only the eventual execution still waits on the copier.

### Auto-Snipe Bot
A purchasable feature in Profile settings: pay a one-time $500 to unlock, then optionally pause/resume it anytime after for free. While active, it auto-buys a dollar amount you choose (editable anytime) into **every new coin** the moment it's created — community launches and Bot Market spawns alike. It only reacts to coins created *after* you turn it on; nothing retroactive. It also never snipes your own community launches. Since Bot Market spawns happen more often than real launches, expect noticeably more frequent snipe buys than a community-only version would give.

**Real architectural limitation, worth being upfront about**: since there's no backend here, this can only actually fire while *your own* account is signed in on some browser tab of yours — not just any tab, unlike the ambient bot system. A buy has to run under your own authenticated session to touch your own balance and holdings, so if you're fully signed out everywhere, new coin launches just won't get sniped until you're back online, even though the setting stays "on." No Firestore rules changes were needed for this — it's implemented as a normal client-side listener (`listenAutoSnipe`, started once at sign-in alongside the whale alert listener) that watches the 5 most recent coins by creation time and reacts to newly-added ones, executing a normal `doBuy()` the same way a manual purchase would. Settings are stored directly on your own user doc (`snipeBot: {owned, active, amountPerCoin, totalSpent, snipedCoins}`), which you already have full write access to.

**Stats menu**: a "📊 View Stats" button on the profile panel opens a modal showing total spent, count of coins sniped, a live current-value tally (unrealized — only for whatever you still hold from the sniped list), a realized P&L tally (sums every past sell tagged as coming from a sniped position), a **Currently Holding** section listing every sniped coin you still hold with tokens/value/P&L and a quick **Sell** button per row (sells the entire position immediately, no need to navigate to the coin's own page first — reuses the normal `doSell()` under the hood, just triggered from the modal), and the last 30 coins sniped into with amount and time. Both value stats and the holding list are computed after the modal opens (a handful of reads, not blocking the open). Since a sniped coin's holding can also get topped up or partly sold by hand afterward, neither number is a perfectly isolated snipe-only figure — that's described plainly in the modal itself rather than pretending otherwise. Realized P&L works off a new `viaSnipe` flag written onto each closed-position record at sell time (mirroring the same flag already on the holding itself), reflecting whether the position's most recent touch before that sell was a snipe buy — closed positions from before this update won't have the flag and are simply excluded from the realized tally, same backward-compat gap as everywhere else denormalized fields got added after the fact.

**Labeling**: every snipe-triggered buy is tagged `viaSnipe:true` on the trade record, the coin's `recentTrades` entry, the resulting holding, and the Activity feed entry. Wherever a username shows up next to a buy/sell, a sniped one reads "@username's 🎯 snipe bot" instead of just "@username" — this shows up in a coin's Recent Trades list, the global Activity feed, and (as a small 🎯 next to the name, since that list doesn't show individual trades) the Top Holders list, reflecting whether the *most recent* trade touching that holding was a snipe buy.

### Admin "reset economy" control
Same gated account — holding **Right Shift** reveals a pulsing "☢️ Reset Economy" button in the bottom corner. Clicking it opens a confirmation modal requiring you to type `RESET`. Confirming:
- Permanently deletes every user-launched coin and frees up their ticker names (Bot Market coins are untouched)
- Clears the global Activity feed
- Resets every account's cash balance, net worth, holdings, and closed positions back to a fresh start

Unlike the pump easter egg, this one has a **real** server-side security boundary — the Firestore rules check `request.auth.token.email`, the verified email on the Firebase Auth token, which can't be spoofed from devtools the way the client-side username check can. The client-side check just decides whether to show the button.

### Admin "force-spawn" bot coin
Same gated account — pressing **Right Ctrl** instantly spawns a new bot coin, bypassing both the normal ~5%-a-minute probabilistic trickle and the 18-active-coin pool cap. Guarded against the browser's own key-repeat firing it over and over while held down (only fires once per press, not continuously). Like the other two, this is a client-side toggle for one account rather than real access control.

A force-spawned coin gets a whole set of guarantees, all driven by one `guaranteedGrowth:true` flag on the coin doc:
- **Starts genuinely fresh**: 0 trades, a single flat price point, exactly $10,000 market cap — no fabricated backstory pretending it's already been trading, unlike normal established bot coins.
- **~2 minutes of quiet**, then rapid growth: for the first 2 minutes (timed off `guaranteedHolderRampStart`), it barely trades at all (small, occasional, unremarkable buys) so it visibly sits flat right after spawn. After that, a much more aggressive phase kicks in — high trade chance, bigger-than-normal sizes, heavy buy bias (~94%, dropping to ~30% for a shallow dip roughly 10% of the time, sell size capped smaller than a real dump) — so the growth actually reads as a jump rather than a slow climb from tick one.
- **Can never be rugged** — `botCoinTick` checks this flag before even rolling for a rug-pull and skips the check entirely for these coins. Permanent, doesn't wear off.
- **Simulated holder growth** — its live holder count ramps from 0 to 10,000+ over the following hour, then keeps trickling up slowly afterward. **This is a simulated display number, not 10,000 real accounts** — there aren't remotely that many real users of this app, and even if there were, writing 10,000 real holding documents on a single keypress would be a Firestore write spike large enough to risk tripping rate limits again (see the fix noted above — this app already hit that wall once from much smaller volume). Same honest "fake-but-plausible" pattern already used for the viewer count elsewhere: a `guaranteedHolderRampStart` timestamp drives a calculated ramp value added on top of the real collection-group count in `refreshHolderCount()`. The Top Holders *list* itself is unaffected — still built entirely from real holding documents, so it won't show 10,000 fake names, just the real ones; only the aggregate count number is boosted.

Shown everywhere with a distinct 🚀 GUARANTEED GROWTH badge (lime, separate from the normal 🤖 BOT badge) so it's never ambiguous which coins these are.

**If you have an active auto-snipe bot, it now buys into a force-spawned coin immediately and directly** — the Right Ctrl handler calls the snipe logic itself the moment the coin is created, rather than only relying on the snipe listener to notice it asynchronously through Firestore. The listener (see the reliability fix below) still independently catches it too, in case the direct call ever fails for some reason — a small in-flight guard (`snipeAttempted`) stops the two paths from double-buying the same coin.

### Admin "spawn a normal coin" (full stop key)
Same gated account — pressing **.** (period/full stop) instantly spawns a completely ordinary bot coin: no `guaranteedGrowth`, no holder-count ramp, no forced snipe, none of the Right Ctrl coin's special treatment. It's exactly what the ambient spawner would create on its own (same 30%-fresh/70%-established split, same normal trading behavior, can still eventually get rugged like any other bot coin), just triggered on demand instead of waiting for the scheduled window. Same key-repeat guard as the other two gestures.

### Insider Insights (hidden page)
A hidden "🔮 Insider Insights" link appears at the bottom of the Launch page, only for the gated admin account or a specific username (`J_Frosty`, case-insensitive) — checked via `canSeeInsights()`, same client-side-gate pattern as the admin's other tricks (a UI gate, not real access control; the underlying `meta/insiderSchedule` doc is readable by any signed-in user, same trust model as the rest of the bot scheduling).

What it does: a small number of upcoming Bot Market coins (capped at `INSIDER_DAILY_CAP = 3` per calendar day) are decided *in advance* — name, ticker, and exact spawn time — and stashed in `meta/insiderSchedule` instead of being generated at spawn time like every other bot coin. The Insights page shows that upcoming coin's name/ticker and a live countdown to launch. Once the countdown hits zero, the next `botCoinTick` pass (same once-a-minute throttle as the ambient spawner) actually creates it using the exact identity that was revealed — then, if still under the daily cap, immediately schedules the next slot 20 minutes–4 hours out.

Every insider-revealed coin is created with `guaranteedGrowth: true` — the same flag the Right-Ctrl force-spawn uses — so it can never be rugged and trades on the same heavily-bullish bias (see the force-spawn section above for exactly how that works). It does *not* get the Right-Ctrl-specific holder-count ramp or the fresh-$10k-then-2-minutes-quiet spawn behavior — those stay specific to that easter egg; an insider coin just spawns as a normal established bot coin, permanently rug-proof and bullish-biased from the moment it appears. Tagged `isInsider: true` on the coin doc if you want to distinguish it further later (not currently surfaced as a separate badge — it shares the same underlying mechanism as force-spawned coins).

There's a small, accepted race risk worth knowing about: the scheduling reads/writes aren't wrapped in a Firestore transaction (the ticker-uniqueness check inside `makeUniqueBotTicker()` can't cleanly run inside one), so if two tabs both check at nearly the same instant, it's possible — rare — for a scheduled reveal to get overwritten by a second tab's own random pick right before it fires, or (very rarely) for the same preset coin to attempt spawning twice. Given this is a small friends app and the failure mode is "an insider coin's name flickers once" rather than anything actually breaking, this wasn't worth the complexity of proper transactional locking.

### Bigger, more frequent price swings (real zigzag, not a smooth wobbly climb)
Charts — especially guaranteed-growth coins — were reading as a mostly-smooth upward line with small wobbles rather than a genuine sawtooth. Root cause: `botCoinTradeSize()` had a 50% chance of picking a *tiny* trade ($10-$130), so only the occasional trade was ever big enough to actually move the line; most just nudged it. Rebalanced so the smallest tier is $100-$450 and 40% of trades are whale-sized ($1,500-$10,500), up from a 16% chance before — every trade now moves price meaningfully. Guaranteed-growth's rapid-growth phase also had its dips softened (sell size capped at 30% of the buy size, only a 10% chance of happening) — real dips now happen ~28% of the time at nearly full size, so it actually zigzags on the way up instead of climbing in a smooth line with the odd tiny notch.

### "Hot" coins trade faster
Any bot-driven coin (normal, rugged, guaranteed-growth, or risky) trades noticeably faster and more often for 5 minutes after a real person either opens its detail page or actually buys/sells it. Two new fields drive this: `lastViewedAt`, stamped once per coin visit (not on every live re-render) when the detail page first builds; and `lastRealActivityAt`, stamped by `doBuy`/`doSell` specifically — not by the bot trade functions, so a coin doesn't count as "hot" just because bots are already trading it. `isCoinHot()` checks both and, when true, roughly doubles the effective trade-chance roll and shrinks the stagger delay to about a third of normal in every tick branch, so a coin someone's actually watching or trading feels alive instead of moving at the same pace as one nobody's looked at in hours.

**That alone still wasn't frequent enough for the 1m/5m chart ranges specifically** — even hot-boosted, the shared tick loops fire every several seconds at best, nowhere near often enough to fill a 1-5 minute window with real up-down movement instead of a mostly-flat line with the occasional jump. Added a separate, much faster loop (`startViewingMicroTick()`/`viewingCoinMicroTick()`) scoped to whichever ONE bot-driven coin is currently open on a coin detail page — ticks every 1.4-2.4 seconds, small $4-$44 wiggles layered on top of whatever directional bias the coin already has (guaranteed-growth stays mostly bullish, risky stays a coin-flip, everything else follows its normal trend bias), starts when the detail page opens and stops the moment you navigate away. **Deliberately never touches community coins** — price there only ever moves from a real trade, which is the honest, correct behavior for a real person's launch; faking movement on someone's actual coin would undermine that entirely, so this only ever applies where the trading was already simulated to begin with. Also skips already-rugged coins, to avoid making a crashed coin look more alive than its own "recovery is a long shot" narrative intends.

### Guaranteed ambient Bot Market spawn cadence
The ambient (non-insider) Bot Market spawner used to be a flat 5%-per-minute-check probability, which technically had an unbounded tail — if unlucky, it was possible (if unlikely) to go a very long stretch with no new coin at all. Replaced with a persisted `meta/botSpawnSchedule` doc holding a `nextSpawnAt` timestamp: every check, if `now >= nextSpawnAt`, a coin spawns immediately and the next slot is scheduled 5–60 minutes out (randomized fresh each time). This guarantees a new ambient coin lands somewhere in that window every time, while still feeling random since the exact minute is different each cycle. The empty-pool bootstrap (spawn 5 immediately if the Bot Market has never had anything in it) is unchanged.

### Auto-snipe reliability fix
The snipe listener used to watch a small fixed window (the 5 most recent coins) and treat every newly-'added' document in that window as something to snipe. That missed coins whenever more than a handful were created close together — e.g. the 5-coin Bot Market bootstrap spawn, or a few Right Ctrl presses in a row — since Firestore doesn't guarantee one delivered event per document in that scenario, only a correct final state. Replaced with a timestamp-cursor approach: the listener records the exact instant it started watching, queries a much larger window (150 — widened again from an initial 50, given how many spawn mechanisms now exist: ambient, insider, Right Ctrl, Period-key, real launches) purely as a safety cap, and reacts to any coin whose actual `createdAt` is after that cursor — which works correctly no matter how many coins arrive in the same snapshot batch or how Firestore chunks delivery.

**Offline catch-up sweep**: the live listener above only helps while some tab of yours is open and connected — it handles brief disconnects/reconnects fine on its own (Firestore just redelivers the current state), but it can't catch anything created while you were fully signed out everywhere. A one-time sweep now runs at the start of every session (`catchUpSnipeMisses()`, called from `listenAutoSnipe()`): if you own the auto-snipe bot, it checks `snipeBot.lastCheckedAt` (a timestamp updated at the end of every session-start check) and retroactively snipes anything created since then, before the live listener even starts watching. This waits for your account data to actually finish loading first (`waitForUserDoc()`) rather than assuming it's already there — `listenAutoSnipe()` fires immediately after `listenUserDoc()` with no guarantee the first snapshot has landed yet, and skipping that wait would silently skip the whole sweep for anyone whose connection was a beat slow.

**Bot coins were never excluded, regardless of how they were spawned** — the only exclusion in `trySnipeBuy()` is for your *own* community launches (`creatorUid === your uid`); every bot coin has `creatorUid:'bot'`, so ambient spawns, Insider Insights reveals, Right Ctrl force-spawns, and the admin's Period-key normal-spawns are all equally snipeable with no special-casing needed.

### Risky (third Explore category)
A third chip on Explore, right alongside Community Coins and Bot Market (same row, same styling — no special positioning). Unlike the other two, it's not a category of many coins: it shows **exactly one coin, replaced once every calendar day** (`checkRiskySchedule()`, piggybacking on the same once-a-minute throttle as the ambient Bot Market spawner and Insider Insights). The Explore page swaps its normal grid+sort-chips UI for a single-card view when this tab is selected, and hides the sort/search row entirely since there's only ever one coin to show.

What makes it "risky":
- **No trend bias at all** — a flat 50/50 coin-flip on every trade (`riskyCoinTick()`, its own dedicated tick loop running every 9s — much faster than the main Bot Market loop, but cheap since it's only ever touching one document). Every other bot-coin mode (normal, guaranteed-growth, rugged-recovery) has *some* bias; this one deliberately doesn't, which is what makes it "extremely unpredictable" rather than just volatile-but-still-leaning-one-way.
- **Genuine bottom-to-top spikes, not just a flat dollar range.** A fixed dollar range can sometimes land as a fairly mild move depending on how deep that particular coin's liquidity happens to be. ~40% of trades (`RISKY_MEGA_CHANCE`) are "mega" mode instead: sized as 60%–200% of the coin's *own current reserve*, which forces a genuinely violent swing regardless of depth. The other ~60% still use the normal $800–$15,000 range for ordinary chaos in between the spikes. Mega-mode sells also relax the usual 5%-of-supply safety cap (which exists everywhere else to stop one dump from cratering a curve) up to 35%, or the "unhinged" drops would get clamped down to something tame.
- **Much higher rug chance, raised twice now** — currently ~23x the normal bot-coin rug rate (up from an initial 8x), with only a 5-minute grace period after being picked (versus 15 minutes for ordinary bot coins). The opposite design goal of guaranteed-growth coins: those are permanently rug-proof, this one is deliberately rug-*prone*.
- **A rugged risky coin loses almost everything, not just most of it.** A normal bot-coin rug keeps 2-10% of liquidity (a 90-98% crash) — survivable, if brutal. A rugged *risky* coin specifically keeps only 0.2-2% (a 98-99.8% crash), because the whole point of this tab is a real chance of losing essentially your entire position, not just a bad-but-recoverable hit. The rugged-coin warning message on its buy panel is also risky-specific, explicitly confirming trading stays completely open even after this — rugging has never actually blocked buying or selling anywhere in this app (`doBuy`/`doSell` never check `ruggedAt` at all), this just says so plainly instead of leaving it implicit.
- **Mega-spike frequency raised too** — 55% of trades now use the violent, reserve-relative sizing described above (up from an initial 40%).
- It's still a completely real, fully tradeable coin — same AMM math, same holdings, same P&L tracking as anything else. It's excluded from the normal Bot Market tab's listing (`isRisky` coins are filtered out client-side there) so it doesn't show up twice, and excluded from the main bot tick loop entirely (it has its own dedicated one) to avoid double-ticking the same document from two different loops at once.

**Fixed: selecting Risky didn't behave like a clean category switch.** `loadRiskyCoin()` never stopped the previous category's `onSnapshot` listener, and `loadHomeCoins()` never stopped the risky listeners — so switching between them left the old one running in the background, and it would randomly overwrite whatever was currently showing the next time any of its watched coins changed. Both functions now explicitly tear down the other side's listeners before starting their own, so switching category tabs is now a clean, isolated swap with nothing left running underneath.

No new Firestore rules or indexes were needed for this — `meta/riskySchedule` reuses the same broad `meta/{docId}` rule already in place for bot scheduling.

### The Abyss (sidenav-only, unlocked at $1B net worth)
A new sidenav item ("💀 The Abyss") — deliberately **sidenav only**, not added to the bottom nav, which was already getting crowded at 8 items; mobile users without a visible sidenav can still reach it once unlocked via the URL/route directly, but there's no dedicated bottom-nav entry point for it. Hidden entirely (`display:none`) until net worth crosses `ABYSS_UNLOCK_NET_WORTH` ($1B, the same threshold as the Billionaire wealth tier and the billionaire trade explosion) — `listenUserDoc()` toggles its visibility live on every account update, and also redirects away from the page automatically if net worth ever drops back below the threshold mid-visit. Like the other wealth-gated features in this app, this is a client-side gate, not a real access-control boundary — consistent with how Insider Insights and the admin tricks already work.

Unlike Risky (replaced daily), the Abyss is a **single permanent coin** — spawned exactly once, ever, the first time any tab checks `meta/abyssCoin` and finds it empty (`checkAbyssSchedule()`, same once-a-minute throttle as the other scheduling checks). It never gets replaced.

What makes it the most extreme thing in the app, and deliberately different from Risky rather than just "Risky but more":
- **Fastest tick in the app** — `abyssCoinTick()` runs every 4.5s, versus Risky's 9s and the main Bot Market loop's ~22s. Cheap to run this often since it's only ever touching one document.
- **Heavily sell-biased, not unbiased like Risky.** This is the actual mechanism behind "80% chance of losing money": ~68% of trades (`ABYSS_SELL_BIAS`) lean sell rather than a 50/50 coin-flip, producing a sustained downward drift over any random holding period. The upside spikes are still real (mega-mode buys can be huge) and catchable if you time it — the odds are stacked against you, not impossible to beat.
- **Even more violent mega-swings than Risky** — 60% of trades (`ABYSS_MEGA_CHANCE`) size themselves at 70%-250% of the coin's own current reserve (versus Risky's 60%-200%), and mega-sells relax the normal 5%-of-supply safety cap up to 50% (versus Risky's 35%).
- **Never gets rugged, on purpose** — the opposite design choice from Risky, whose whole identity is being rug-prone. The Abyss doesn't need a rug mechanic; the sustained sell bias already does the work of making it a bad long-term bet, and permanence (never disappearing, unlike a daily-replaced Risky pick) matters more for a coin billionaires are meant to keep coming back to.
- Still a completely real, fully tradeable coin — excluded from the normal Bot Market listing and the main bot tick loop (`isAbyss` coins are filtered out client-side and skipped in `botCoinTick`, same pattern as Risky) to avoid showing up twice or getting double-ticked from two loops at once.

No new Firestore rules or indexes needed — `meta/abyssCoin` reuses the same broad `meta/{docId}` rule already in place.

### For people with Qi (quintillion+) money
Four things aimed specifically at the tier above billionaires, where even the Abyss starts to feel routine:

**The Singularity** (sidenav, unlocked at $1Qi net worth) — a coin with **no independent behavior of its own at all**. Every other bot-driven coin in this app, even the wildest ones, trades on some kind of internal logic, random or otherwise. This one doesn't — its price only ever moves as a scaled-down echo of real trades happening anywhere else in the app, right now (`listenSingularityMirror()`, a global listener watching the activity feed for real trades — bots are always tagged `uid:'bot'` and never trigger it — and mirroring 5-20% of the trade's dollar value onto the Singularity, ~40% of the time to keep write volume sane). Trades on the Singularity itself are excluded from triggering more mirrors, avoiding a feedback loop. Genuinely emergent: nobody, including whoever built this, can predict its path in advance, since it depends entirely on what real people actually do elsewhere at that exact moment.

**The unnamed one** (sidenav, unlocked at $1Sx net worth, one tier above the Singularity) — deliberately **zero framing**: no description panel, no warning text, not even a real name in the nav (just "???"). Structurally unpredictable rather than just big: `mysteryCoinTick()` randomly picks a completely different behavior mode every tick from ones already built elsewhere in this file — sometimes unbiased 50/50 chaos like Risky, sometimes a heavy sell lean like the Abyss, sometimes a heavy buy lean, sometimes fully random with no lean at all. There's no single pattern to learn by watching it, which is the entire point — the mystery is the hook, not the mechanics.

**Reality Warp** (unlocked at $1Qi net worth) — a personal, once-per-real-calendar-day pump ability, usable on *any* coin from that coin's own detail page (a "🌌 Reality Warp" button appears there once unlocked). Reuses the exact same underlying mechanics as the admin's Right Alt pump — staggered bot buys plus a solved-AMM moon-boost (`realityWarpBoost()`, same `dUSD = √(targetPrice×k) − solReserve` math as `guaranteePumpToPositive100()`) — just scaled down (40-70 bots instead of 150-250, +200%–600% instead of +700%–1400%) and gated by a cooldown instead of an admin-only account check. Announced with a toast naming who did it, for the flex value.

**Hall of Legends** (a new "🏛️ Legends" tab on the Leaderboard) — a **permanent** record, deliberately different from the live wealth-tier badge. The first time your net worth crosses $1Qi, `refreshNetWorthSnapshot()` stamps `legendAchievedAt` and `legendPeakNetWorth` onto your user doc; neither field is ever cleared even if net worth drops back down afterward, and the peak keeps climbing if you go even higher later. The leaderboard query (`orderBy('legendPeakNetWorth','desc')`) needs no `where` clause and no composite index at all — anyone who's never crossed the threshold simply doesn't have that field set, and Firestore excludes documents missing the ordered field from range/order queries entirely, so the query naturally returns only legends, correctly sorted, for free (same trick already used for the Philanthropy leaderboard).

No new Firestore rules or indexes needed for any of these four — the two new coins reuse the same `meta/{docId}` bot-scheduling rule, Reality Warp only ever writes to the coin doc and your own user doc (already permitted), and Hall of Legends is a single-field sort.

### Rug-pull events
Once a bot coin is at least 15 minutes old — and isn't a guaranteed-growth coin, which is permanently exempt (see above) — each 14s tick gives it a small (~0.15%) chance of a dramatic crash event: price collapses 90–98% in one shot and it gets a permanent 💀 RUGGED badge. This mirrors how real memecoins behave and gives holding a bot coin actual stakes instead of it being a risk-free chart to watch. A rugged coin is **not** deleted or delisted — it stays in the Bot Market pool forever and remains fully tradeable (the buy panel shows a clear warning instead of being disabled). What changes permanently is its odds: instead of the normal trend-bias buy/sell split, a rugged coin's bot trade decisions use a fixed low buy chance (`RUGGED_RECOVERY_CHANCE`, currently 6%), so it mostly keeps drifting down or sideways with only the rare small bounce — betting on a real comeback is meant to be a genuine long shot, not just a normal coin with a scary badge.

### Leaderboard
Explore → Leaderboard shows Daily / Weekly / All-Time top traders, ranked by change in total net worth (cash + realizable value of all holdings). Every real trade you make snapshots your net worth with a timestamp (`netWorthHistory` on your user doc); daily/weekly rankings compare your current net worth to your most recent snapshot from before that window.
- **Freshness fix**: previously, someone's displayed net worth only updated when *they* personally traded — so a person holding a coin that's mooning right now but hasn't traded today would look "frozen." The leaderboard now recomputes live net worth (cash + realizable holdings value, read fresh each load) for its top candidates every time it loads, rather than trusting the stored field. This is read-only — it doesn't write anything back, so it can't race with anyone else's data, it just freshens what's displayed. To keep read cost sane as the userbase grows, it's bounded to the top ~60 candidates by last-known value rather than doing this for all 200 fetched users.
- The leaderboard reads every user's top-level document (capped at 200 users) to build the candidate list — fine for a friends-group app, but something to be aware of if this ever grows to a large public userbase.
- Clicking anyone's name on the leaderboard opens their public profile.
- A "Find a trader" search box above the leaderboard does a prefix search on username (using the `usernameLower` field already stored for signup uniqueness checks) — good for jumping straight to someone's profile. It's a prefix match, not fuzzy/substring search, since that's what Firestore's query model actually supports well.

### Bot Market
Explore now has two tabs: **Community Coins** (real launches, unchanged) and **🤖 Bot Market** — coins nobody created, that trade themselves 24/7:
- A pool of up to 18 *active* bot coins exists at any time — rugged ones don't count against this cap since they're never removed (see below), so the true total can grow beyond 18 over a long-running session as rugged coins pile up alongside the active ones. Roughly once a minute, whichever browser tab has the app open rolls a 5% chance to spawn a new one (procedurally named, e.g. "Turbo Frog" / $TUFR) if the active count isn't already at cap — so new ones appear "randomly," a handful of minutes apart.
- **Realistic token counts.** Each bot coin gets its own total supply, randomly chosen from a human-scale list (100K–25M) instead of the 1B-token scale community coins use. A 1B-supply coin unavoidably hands out millions of raw tokens for a completely ordinary buy — that's just the math, not a bug — so the fix for "why did $50 get me millions of coins" was giving bot coins a realistic supply, not a deeper curve. Liquidity depth is still picked independently ($4,000–$16,000, in dollar terms) so price and depth don't fight each other regardless of where the coin's simulated price history landed.
- A new bot coin has a 70% chance of being backfilled with a fabricated launch history at spawn time — a wobbly random-walk price chart spanning a fake 3–9 hours, a trade count already in the thousands, and some recent trades — and a 30% chance of being genuinely brand new instead: zero trades, a single flat price point, nothing fabricated. Explore always has a real mix of "already established" and "you're seeing this at trade #0" coins rather than every single one arriving with a fake backstory.
- Nothing ever deletes a non-rugged bot coin (and rugged ones don't get deleted either anymore — see Rug-pull events below), so a coin that's been around since the pool was first seeded can genuinely stick around for real-life weeks. An **🕰️ Oldest** sort chip (alongside New/Market Cap/Gainers/Losers) makes those long-lived survivors actually easy to find instead of always being buried under newer spawns — and the coin detail page shows "live for Nd/Nw" next to the trade count so it's obvious at a glance how long a coin's actually been trading.
- Every ~22s tick, each of up to 15 bot coins has a 35% chance to trade, with sizes ranging from small ($10–$130) to medium ($150–$800) to whale-sized swings ($1,200–$8,000) that spike the chart hard. Buy vs. sell isn't pure coin-flip noise — each coin has a fast-shifting "mood" (recalculated every 90 seconds) that leans it strongly bullish or bearish for a stretch before flipping, so charts show frequent, pronounced up/down runs rather than static jitter — while staying net-neutral over the long run for the same reason the young-coin bots were rebalanced (see Bots, above): no free liquidity drifting in over time.
- **Fixed: hitting Firestore's rate limits (HTTP 429).** Across several rounds of "make it more volatile/lively" tuning, bot request volume crept up to roughly 30 coins × 75% trade chance every 14 seconds from a single open tab — with more than one tab open at once (multiple people using the app, or the same person with a couple tabs), this was enough sustained transaction volume to trip Firestore's rate limiting, which in turn made *real* trades start failing too (a 429 doesn't distinguish bot transactions from real ones — they all share the same request quota). Pulled back hard: tick interval 14s→22s, per-tick coin count 30→15, trade chance 75%→35%, plus wider staggering across each tick and slower polling for the live holder count (20s→60s) and the Bot Market spawn-check (now does one cheap aggregation-count read in the common case instead of fetching every bot coin's full document on every check). Altogether this cuts steady-state Bot Market request volume by roughly 85% per open tab.
- **Keeps moving while nobody's on the site.** There's no server here, so nothing can literally tick with zero browser tabs open anywhere — but the moment any tab reopens, every bot coin checks how long it's been since it last ticked and replays that whole gap as a compressed batch of simulated ticks (same trade logic, same mood sequence), written as one update. From your perspective, a bot coin you're holding really did drift up or down while you were offline — your portfolio value on return reflects it — it's just computed in one lump sum on the next visit rather than trickling in the whole time. (A truly always-on version would need a scheduled Cloud Function running server-side, which means upgrading to Firebase's paid Blaze plan — out of scope for this no-backend setup, but let me know if you want that path instead.)
- Bot Market coins never age out of bot activity the way young user coins do (8-minute window) — they're meant to always be live, indefinitely, rugged or not (see Rug-pull events below).
- They're clearly labeled everywhere (🤖 BOT badge on the coin card and detail page) so it's never ambiguous that you're trading against automated counterparties, not real people. Real trades against them are still 100% real — your buys/sells hit the same AMM math and update your real balance and holdings, same as any user coin.
- **Extra Firestore indexes needed**: the Bot Market tab queries `coins` filtered by `isBotCoin == true` and sorted by `marketCap`, `createdAt` descending (New/Gainers/Losers), or `createdAt` ascending (Oldest) — **three** composite indexes total, since (unlike single-field indexes) a Firestore composite index only serves one specific sort direction; ascending and descending on the same fields need two separate indexes. Firestore will show a one-click "create index" link in the browser console the first time each distinct query runs — or pre-create all three under Firestore → Indexes: `isBotCoin` Ascending + `marketCap` Descending; `isBotCoin` Ascending + `createdAt` Descending; and `isBotCoin` Ascending + `createdAt` Ascending.

### Top Holders
Every coin's page now has a "Top Holders" panel, listing the biggest wallets by token count and their % of total supply, plus a live "N holders" count next to the panel title (a genuine `getCountFromServer` count, not a fake/simulated number like the viewer count — refreshes every 20s while you're on the page). This uses a Firestore **collection-group** query across every user's `holdings` subcollection, filtered to that one coin — which needs `coinId`, `username`, and `avatarURL` denormalized onto each holding doc (now written on every buy/sell), a collection-group composite index (see the indexes section above), **and** a dedicated collection-group rules block. That last one is easy to get wrong: nested rules like `match /users/{uid} { match /holdings/{coinId} {...} } }` only govern *direct* access to one user's own holdings — they do **not** automatically extend to a collection-group query. That needs its own separate `match /{path=**}/holdings/{coinId} {...}` block at the top level (see the rules above) — without it you'll get "Missing or insufficient permissions" even though the nested rule looks like it should cover it. Holdings written before this update won't show up in the list (or count) until that holder trades again, since they're missing the denormalized fields.

### Realized P&L: every sell is a closed position
Selling any amount of a coin — not just fully exiting it — writes its own record to a new `users/{uid}/closedPositions` subcollection: tokens sold, proceeds, and that specific sale's realized profit/loss. The "Closed Positions" list on a profile shows all of these, most recent first (up to 100), so a partial sell shows up immediately instead of waiting until the whole bag is gone. Open Positions (still holding tokens) show unrealized P&L the same way as before. **Needs a Firestore rules update** — see the `closedPositions` block above.

### Profile: overall balance, today's change, and win rate
Profiles (yours and anyone else's) now show "Overall account balance" (cash + realizable value of everything held) separately from cash, a green/red line under the username showing today's % and $ change in net worth (reusing the leaderboard's daily-baseline logic), and a win rate stat (% of closed positions that were profitable), computed straight from the closed-positions data described above.

### Net worth history chart
The same "Net Worth Over Time" line chart appears in three places now: the Portfolio page, your own profile, and everyone's public profile — all plotted from the `netWorthHistory` field on that user's doc, which is public data already (any signed-in user can read `users/{uid}`). Since it's just visualizing an existing field, an admin economy reset (which resets `netWorthHistory` back to a single starting point for every account) automatically wipes these charts too — nothing extra needed there.

### Recent Activity feed
A new "Activity" tab shows a live, global feed of real buys and sells across every coin — real people only, bots excluded. Each real trade is written to a top-level `activity` Firestore collection inside the same transaction as the trade itself. Clicking a username in the feed opens that person's profile, and clicking a ticker jumps to that coin. (Whale-sized bot trades also get written to this same collection now, tagged `isBot:true`, to power the whale alert listener below — the feed itself fetches a bit extra and filters those back out client-side, so it stays real-people-only regardless.)

### Intensity pass: confetti, whale alerts, streaks, chart avatars
A batch of feel/feedback features, all built on data that was already being tracked:
- **Milestone confetti** — a lightweight vanilla-JS particle burst (no external library) fires once each for: your first profitable trade, first $1,000 net worth, and your biggest single win. Tracked via a `milestones` map on your user doc so each only fires once, ever.
- **Whale alerts, actually platform-wide** — real trades were already logged to the global `activity` feed; bot trades weren't, so a huge bot pump only ever showed a toast in the one tab that happened to run it. Bot trades $2,500+ now also write to `activity` (tagged `uid:'bot'`, same pattern as bot-spawned coins), and a global listener — started once at sign-in, independent of what page you're on — shows a clickable toast for real *and* bot whale trades alike, for everyone online. Clicking it jumps straight to the coin. Threshold was raised from an initial $500 (which fired quite often given Bot Market's whale-sized trades) to $2,500, reserving it for genuinely large trades. **Needs the updated `activity` rules above** (bot trades need their own create clause, same as bot coin creation did).
- **Fake viewer count** — "N watching" on a coin's page. Deterministic per coin+20-second time-bucket (same hash trick used for bot coin mood) rather than pure random every refresh, so it drifts naturally instead of visibly jumping, and scales up with how much trading activity a coin has seen.
- **Win streak & Diamond/Paper Hands** — both computed straight from your closed-positions history (already being recorded). Streak counts consecutive profitable sells from most recent backward. Hands badge classifies you by average hold time — needs a new `firstBuyAt` field on holdings (set once per position, resets when you fully exit and start fresh) and a `heldMs` field recorded on each closed-position entry at sell time. Thresholds (15 min = diamond) are tuned to this app's pace, not real-market scale.
- **Rank-overtake toast** — after every trade, a lightweight top-10-by-net-worth check (no new index needed, single-field `orderBy`) compares your rank to last time; if you climbed, you get a toast naming whoever you just passed.
- **Avatar markers on the chart** — buy/sell trades from a coin's `recentTrades` are now plotted as small circular avatars directly on the price chart, positioned by matching each trade's timestamp to the nearest visible price point (they land at essentially the same instant already, since the price point and the trade write happen in the same transaction). Lime ring = buy, red ring = sell. Click one to jump to that trader's profile (bot avatars are unclickable, matching how bot accounts work everywhere else). This data lives on the coin doc itself, so it's always freshly loaded from Firestore on every page open — it was never actually tied to browser session state. What *was* broken: the avatar `<img>` elements were loaded with `crossOrigin="anonymous"`, which silently fails to load any image hosted somewhere that doesn't send CORS headers — true of most arbitrary image links people paste in as an avatar URL. Removed it (nothing in the app ever reads pixel data back out of these images, so it wasn't needed), which is what was actually causing markers to inconsistently not show for real users.

  **Retention raised from 14 trades to 110**, matching `priceHistory`'s own cap, so markers show for every trader still visible anywhere on the chart rather than just the last 14 — practically "everyone, for as long as the chart still shows that stretch of price history." Not literally forever: both `recentTrades` and `priceHistory` are rolling windows (oldest entries drop as new ones are pushed), which is a deliberate, sane limit — an actually-infinite array on a single Firestore document isn't something that scales, and a chart can't meaningfully show infinite history anyway. The Recent Trades *list* still only displays the most recent 14 regardless (`recentTradesHtml()` slices to 14 at render time), so that list didn't get longer — only the chart's own marker coverage did.

  **New: the trader's own avatar now pops onto the chart before the price actually jumps**, not simultaneously with it. `previewTradeAvatar()` shows a small avatar bubble in the corner of the chart (top-right, lime-ringed for a buy, red for a sell) with a quick pop-in animation, and `doBuy`/`doSell` now `await` it before running the real trade transaction — so the visible sequence is: your profile appears, briefly sits there, *then* the chart line moves. Only happens if that coin's own detail page (with its chart) is what's currently on screen; resolves instantly otherwise so a trade from Portfolio, or an auto-sniped/copy-traded/bot trade, isn't delayed waiting on an animation nobody would see.

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

