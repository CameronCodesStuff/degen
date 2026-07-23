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
      allow read: if isSignedIn();
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
Drop all three files (`index.html`, `style.css`, `script.js`) into a GitHub Pages repo root, keeping them side by side — no build step needed.

---

## How the exchange actually works
- Every coin launches with a **virtual bonding curve** (constant-product AMM, same style pump.fun uses): $30 virtual liquidity vs. 1B token supply.
- Price = liquidity ÷ tokens remaining in the curve. As people buy, liquidity goes up and tokens in the curve go down, so price rises — and vice versa on sells.
- There are **no bots and no scheduled price changes** — a coin's price only ever moves when a real user submits a buy or sell.
- Coins "graduate" 🎓 cosmetically once market cap crosses $69,000 (just a fun badge, no extra mechanics).
- Launching a coin costs a $5 fee (from the $100 starting balance) to discourage spam.
- Avatars and coin logos are plain image URLs — paste a link to any hosted image (e.g. Imgur), or leave it blank for an auto-generated default.
