import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, onSnapshot, collection, collectionGroup,
  query, orderBy, limit, runTransaction, serverTimestamp, where, getDocs, deleteField, Timestamp,
  getCountFromServer, writeBatch, deleteDoc, setLogLevel, documentId
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
const firebaseConfig = {
  apiKey: "AIzaSyCMDe_UPrNTjKnEoO2ngTe7wE6P7_G06ms",
  authDomain: "ccscrypto-418c3.firebaseapp.com",
  projectId: "ccscrypto-418c3",
  storageBucket: "ccscrypto-418c3.firebasestorage.app",
  messagingSenderId: "1006548579871",
  appId: "1:1006548579871:web:64f6c6c245b5b8258a072a",
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// The Firestore SDK logs a full RPC payload dump to console on every transaction retry/conflict
// (visible as those huge "RestConnection RPC 'Commit' failed" blocks) — with the bot economy
// generating a steady stream of trades, that's enough console volume for DevTools itself to
// start lagging the page. None of it is actionable for normal use (bot-vs-bot contention is
// already handled silently in code), so it's turned off at the source rather than just cleaned
// up after the fact.
setLogLevel('error');
// Local persistent cache (IndexedDB-backed) lets the app keep working — viewing cached
// prices/balances, queueing trades — when the connection drops, and syncs back up
// automatically once it returns. Falls back to in-memory-only if the browser can't support
// it (e.g. very old browsers, private browsing in some cases); the app still works either way.
let db;
try{
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
}catch(err){
  db = initializeFirestore(app, {});
}

// App-shell service worker: lets the page itself open even with no network at all.
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{ navigator.serviceWorker.register('./sw.js').catch(()=>{}); });
}

function updateOfflineBanner(){
  const banner = document.getElementById('offlineBanner');
  if(banner) banner.classList.toggle('show', !navigator.onLine);
}
window.addEventListener('online', updateOfflineBanner);
window.addEventListener('offline', updateOfflineBanner);
document.addEventListener('DOMContentLoaded', updateOfflineBanner);
updateOfflineBanner();

/* ===================== CONSTANTS ===================== */
const STARTING_BALANCE = 100;
const CREATE_FEE = 5;
// Market cap on a constant-product curve works out to marketCap = solReserve^2 / INITIAL_SOL_RESERVE.
// With too little starting liquidity (the old $30, then $4,200), a modest buy could scoop up a huge
// slice of the supply in one shot (e.g. ~$95 buying 2%+ of the whole 1B supply at $4,200 depth) and
// swing market cap hard on a single trade. $8,000 virtual depth cuts how many tokens/how much price
// impact a given dollar amount buys roughly in half versus the old setting, while still giving a
// realistic few-thousand-dollar starting mcap like a freshly launched real memecoin.
const INITIAL_SOL_RESERVE = 8000;     // virtual "liquidity" seed (USD)
const INITIAL_TOKEN_RESERVE = 1_000_000_000; // 1B token supply per coin
const GRAD_MARKET_CAP = 69000;        // fun homage threshold — pump.fun's real graduation mcap
const K = INITIAL_SOL_RESERVE * INITIAL_TOKEN_RESERVE;
// No single wallet can hold more than 35% of a coin's supply (down from 80%) — a much lower cap
// means no one buyer can dominate the curve, so price stays driven by many people trading rather
// than one whale's bag, and it keeps any single position's exit slippage from being catastrophic.
const MAX_OWNERSHIP_PCT = 0.35;

// Client-side "pump" easter egg, gated to one specific account. Like the rest of this demo
// (see SETUP.md), this is enforced in the browser, not by Firestore rules — a determined user
// could bypass it via devtools. Fine for a for-fun/friends app; not a real access control.
const PUMP_ADMIN_EMAIL = 'detlaffcameron@gmail.com';
const PUMP_ADMIN_USERNAME = 'cameron';
function isPumpAdmin(){
  const email = (auth.currentUser && auth.currentUser.email || '').toLowerCase();
  const uname = (state.userDoc && state.userDoc.username || '').toLowerCase();
  return email===PUMP_ADMIN_EMAIL && uname===PUMP_ADMIN_USERNAME;
}
// Same client-side-only gating pattern as isPumpAdmin — decides whether to SHOW the Insights
// option, not a real access-control boundary (like everything else admin-flavored in this app).
function canSeeInsights(){
  const uname = (state.userDoc && state.userDoc.username || '').toLowerCase();
  return isPumpAdmin() || uname==='j_frosty';
}

/* ===================== STATE ===================== */
const state = {
  uid: null,
  userDoc: null,
  route: { name: 'home', param: null },
  unsubs: [],
  coinsCache: new Map(),
  chart: null,
  tradeMode: 'buy',
  tradeAmount: 0,
};

// Batch-fetches whichever of the given coin IDs aren't already in state.coinsCache, using
// Firestore's documentId() 'in' queries (chunked to Firestore's 30-value limit per query) fired
// concurrently via Promise.all — instead of the old pattern of a sequential `for` loop doing one
// `await getDoc` at a time. That old pattern turned "load a page with N holdings" into N
// back-to-back network round-trips; this turns it into ceil(N/30) round-trips that all happen at
// once. Every caller just awaits this once, then reads state.coinsCache synchronously.
async function ensureCoinsCached(coinIds){
  const missing = [...new Set(coinIds)].filter(id=> id && !state.coinsCache.has(id));
  if(!missing.length) return;
  const chunks = [];
  for(let i=0;i<missing.length;i+=30) chunks.push(missing.slice(i,i+30));
  await Promise.all(chunks.map(async chunk=>{
    try{
      const snap = await getDocs(query(collection(db,'coins'), where(documentId(),'in',chunk)));
      snap.docs.forEach(d=> state.coinsCache.set(d.id, {id:d.id, ...d.data()}));
    }catch(err){ /* silent — callers already treat a cache miss as "coin unavailable" */ }
  }));
}

function clearUnsubs(){ state.unsubs.forEach(u=>u()); state.unsubs = []; }
// Shared by fmtUsd and fmtTok — extended well past the old M/B cap since compounding growth
// mechanics (guaranteed-growth, pump, bank interest, etc.) can realistically put some numbers
// in this app into the billions and beyond. Ordered largest-first so the first match wins.
// Named tiers up through decillion (1e33), same as before. Beyond that we programmatically
// generate 'e36', 'e39', 'e42' ... tiers every 3 orders of magnitude, all the way out to 1e306 —
// that's 90+ additional tiers on top of the 11 named ones below (100+ total), which covers
// every value a JS double can represent (doubles top out around 1.8e308, so 1e306 is as far as
// it's meaningful to go — anything past that isn't a "bigger number", it's just Infinity).
// Named tiers were kept short/pronounceable (Dc, No, Oc...); past that, plain scientific-notation
// suffixes are clearer than inventing more made-up abbreviations for numbers nobody will recite.
const NUM_TIERS = (function(){
  const named = [
    { v: 1e33, s: 'Dc' }, { v: 1e30, s: 'No' }, { v: 1e27, s: 'Oc' }, { v: 1e24, s: 'Sp' },
    { v: 1e21, s: 'Sx' }, { v: 1e18, s: 'Qi' }, { v: 1e15, s: 'Qa' }, { v: 1e12, s: 'T' },
    { v: 1e9,  s: 'B'  }, { v: 1e6,  s: 'M'  }, { v: 1e3,  s: 'K'  }
  ];
  const extended = [];
  for(let exp=306; exp>=36; exp-=3) extended.push({ v: Number('1e'+exp), s: 'e'+exp });
  return extended.concat(named); // largest-first so the first match in fmtUsd/fmtTok wins
})();
// Wealth-tier badges — same magnitude ladder as NUM_TIERS, starting at $1M (below that just isn't
// interesting enough to badge). Shown next to a username wherever one appears: leaderboard,
// activity feed, and both profile pages.
const WEALTH_TIERS = [
  { v: 1e33, icon: '♾️', label: 'Decillionaire' },
  { v: 1e30, icon: '🌈', label: 'Nonillionaire' },
  { v: 1e27, icon: '🛸', label: 'Octillionaire' },
  { v: 1e24, icon: '🌠', label: 'Septillionaire' },
  { v: 1e21, icon: '🔥', label: 'Sextillionaire' },
  { v: 1e18, icon: '⚡', label: 'Quintillionaire' },
  { v: 1e15, icon: '🌌', label: 'Quadrillionaire' },
  { v: 1e12, icon: '👑', label: 'Trillionaire' },
  { v: 1e9,  icon: '💎', label: 'Billionaire' },
  { v: 1e6,  icon: '💰', label: 'Millionaire' },
];
function wealthTierFor(netWorth){
  for(const t of WEALTH_TIERS) if(netWorth>=t.v) return t;
  return null;
}
function wealthBadgeHtml(netWorth){
  const t = wealthTierFor(netWorth);
  return t ? `<span class="wealth-badge" title="${t.label}">${t.icon}</span>` : '';
}
function fmtUsd(n){
  if(n===undefined||n===null||isNaN(n)) n=0;
  const neg = n<0;
  const abs = Math.abs(n);
  for(const tier of NUM_TIERS){
    if(abs>=tier.v) return (neg?'-':'')+'$'+(abs/tier.v).toFixed(2)+tier.s;
  }
  return (neg?'-':'')+'$'+abs.toFixed(abs<1?4:2);
}
const SUBSCRIPT_DIGITS = {'0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉'};
function fmtPrice(p){
  if(!p||isNaN(p)||p<=0) return '$0.00';
  if(p>=1) return '$'+p.toFixed(4);
  if(p>=0.01) return '$'+p.toFixed(4);
  const exp = Math.floor(Math.log10(p));         // e.g. -8 for 3e-8
  const leadingZeros = -exp - 1;                  // zeros between the decimal point and first sig. digit
  if(leadingZeros <= 3) return '$'+p.toFixed(6);   // still readable without special notation
  const mantissa = p / Math.pow(10, exp);          // 1.000–9.999
  const sig = mantissa.toFixed(1).replace('.','');  // 2 significant digits, e.g. "30" for 3.0
  const zeroStr = String(leadingZeros).split('').map(d=>SUBSCRIPT_DIGITS[d]).join('');
  return `$0.0${zeroStr}${sig}`;                    // e.g. $0.0₇30
}
function fmtTok(n){
  if(n===undefined||n===null||isNaN(n)) n=0;
  const neg = n<0;
  const abs = Math.abs(n);
  for(const tier of NUM_TIERS){
    if(abs>=tier.v) return (neg?'-':'')+(abs/tier.v).toFixed(2)+tier.s;
  }
  return (neg?'-':'')+abs.toFixed(2);
}
function timeAgo(ts){
  if(!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const s = Math.floor((Date.now()-d.getTime())/1000);
  if(s<60) return s+'s ago';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
// Like timeAgo but without the "ago" suffix and with week/month granularity for long-lived bot
// coins — timeAgo caps out at "Nd ago" which gets unwieldy once a coin's been around for weeks.
function ageText(ts){
  if(!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const s = Math.floor((Date.now()-d.getTime())/1000);
  if(s<60) return s+'s';
  if(s<3600) return Math.floor(s/60)+'m';
  if(s<86400) return Math.floor(s/3600)+'h';
  if(s<604800) return Math.floor(s/86400)+'d';
  if(s<2592000) return Math.floor(s/604800)+'w';
  return Math.floor(s/2592000)+'mo';
}
function avatarFor(username, url){
  if(url) return url;
  const seed = encodeURIComponent(username||'anon');
  return `https://api.dicebear.com/9.x/thumbs/svg?seed=${seed}&backgroundColor=8B6BFF,C6FF3D,FF3DAE&radius=50`;
}
function coinLogoFor(ticker, url){
  if(url) return url;
  const seed = encodeURIComponent(ticker||'coin');
  return `https://api.dicebear.com/9.x/shapes/svg?seed=${seed}&backgroundColor=8B6BFF,FF3DAE,3DE0FF`;
}
function toast(msg, type='', onClick=null){
  const c = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast '+type+(onClick?' toast-clickable':'');
  el.textContent = msg;
  if(onClick) el.addEventListener('click', onClick);
  c.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='.3s'; setTimeout(()=>el.remove(),300); }, onClick?5200:3200);
}
function esc(s){ const d=document.createElement('div'); d.textContent = s==null?'':s; return d.innerHTML; }

/* ===================== CONFETTI (milestones) ===================== */
function confettiBurst(){
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:400;';
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const colors = ['#C6FF3D','#FF4D6D','#8B6BFF','#FFD166','#4DD9FF'];
  const N = 90;
  const particles = Array.from({length:N}, ()=>({
    x: canvas.width/2 + (Math.random()-0.5)*120,
    y: canvas.height*0.35 + (Math.random()-0.5)*60,
    vx: (Math.random()-0.5)*14,
    vy: -Math.random()*14-4,
    size: 4+Math.random()*5,
    color: colors[Math.floor(Math.random()*colors.length)],
    rot: Math.random()*Math.PI*2,
    vrot: (Math.random()-0.5)*0.4,
    life: 1
  }));
  const gravity = 0.35;
  let running = true;
  function tick(){
    if(!running) return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    let alive = false;
    particles.forEach(p=>{
      if(p.life<=0) return;
      p.vy += gravity; p.x += p.vx; p.y += p.vy; p.rot += p.vrot; p.life -= 0.012;
      if(p.life<=0) return;
      alive = true;
      ctx.save();
      ctx.translate(p.x,p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.max(0,p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size/2,-p.size/2,p.size,p.size*0.6);
      ctx.restore();
    });
    if(alive) requestAnimationFrame(tick);
    else { running=false; canvas.remove(); }
  }
  requestAnimationFrame(tick);
  setTimeout(()=>{ running=false; canvas.remove(); }, 4000); // safety net
}

/* AMM math */
function priceOf(coin){ return coin.solReserve / coin.tokenReserve; }
function totalSupplyOf(coin){ return coin.totalSupply||INITIAL_TOKEN_RESERVE; }
function marketCapOf(coin){ return priceOf(coin) * totalSupplyOf(coin); }
function circulatingOf(coin){ return totalSupplyOf(coin) - coin.tokenReserve; }

// Standard constant-product swap math, computed directly from current reserves rather than
// via newSol = coin.solReserve+v; newTok = K/newSol; tokensOut = coin.tokenReserve-newTok.
// That older approach subtracted two huge nearly-equal numbers (both ~1e9) to get a tiny
// difference, which loses almost all precision in floating point — small trades would come
// back as effectively 0 tokens and get rejected as "too small" even though $0.01 is a
// perfectly valid trade. This formula computes the output directly with no cancellation.
function ammBuy(coin, usdAmount){
  let tokensOut = (coin.tokenReserve * usdAmount) / (coin.solReserve + usdAmount);
  // Safety clamp: cap at 99% of the reserve regardless of the math above. Mathematically
  // tokensOut always stays strictly below tokenReserve for any finite usdAmount, but at extreme
  // ratios (usdAmount many orders of magnitude larger than solReserve — which the moon-boost
  // mechanics can produce on a coin that's been pumped many times) float64 precision loses
  // enough significant digits that tokenReserve-tokensOut can round to zero or go negative,
  // making newPrice = newSol/newTok come out as Infinity or NaN. Firestore rejects non-finite
  // numbers outright with a 400, which is what was actually happening.
  const maxTokensOut = coin.tokenReserve*0.99;
  if(!(tokensOut < maxTokensOut)) tokensOut = maxTokensOut;
  const newSol = coin.solReserve + usdAmount;
  const newTok = coin.tokenReserve - tokensOut;
  return { tokensOut, newSol, newTok, newPrice: newSol/newTok };
}
function ammSell(coin, tokenAmount){
  const usdOut = (coin.solReserve * tokenAmount) / (coin.tokenReserve + tokenAmount);
  const newTok = coin.tokenReserve + tokenAmount;
  const newSol = coin.solReserve - usdOut;
  return { usdOut, newSol, newTok, newPrice: newSol/newTok };
}

// What a holding is actually worth if you sold it right now — i.e. run it through the same
// slippage math the real sell transaction uses, instead of tokens*spotPrice. Spot price is only
// the price of the next infinitesimal token; once you own a meaningful share of a shallow curve,
// dumping your whole bag moves the price a lot on the way out, so tokens*spotPrice can wildly
// overstate what you'd actually walk away with (this was the "shows $1k, only get $100" bug).
function sellValue(coin, tokens){
  if(!(tokens>0) || !coin) return 0;
  const capped = Math.min(tokens, coin.tokenReserve*0.999999); // can't drain the whole reserve
  const { usdOut } = ammSell(coin, capped);
  return Math.max(0, usdOut||0);
}
function pctChange(history){
  if(!history || history.length<2) return 0;
  const first = history[0].p, last = history[history.length-1].p;
  if(!first) return 0;
  return ((last-first)/first)*100;
}

/* ===================== AUTH ===================== */
document.querySelectorAll('.auth-tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('authError').style.display='none';
    if(tab.dataset.tab==='login'){
      document.getElementById('loginForm').classList.remove('hidden');
      document.getElementById('signupForm').classList.add('hidden');
    } else {
      document.getElementById('signupForm').classList.remove('hidden');
      document.getElementById('loginForm').classList.add('hidden');
    }
  });
});
function showAuthError(msg){
  const el = document.getElementById('authError');
  el.textContent = msg; el.style.display='block';
}

document.getElementById('loginForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = 'Logging in…';
  try{
    await signInWithEmailAndPassword(auth, document.getElementById('loginEmail').value.trim(), document.getElementById('loginPass').value);
  }catch(err){ showAuthError(friendlyAuthErr(err)); }
  btn.disabled = false; btn.textContent = 'Log In';
});

document.getElementById('signupForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const btn = document.getElementById('signupBtn');
  const username = document.getElementById('suUsername').value.trim();
  const email = document.getElementById('suEmail').value.trim();
  const pass = document.getElementById('suPass').value;
  if(!/^[a-zA-Z0-9_]{3,20}$/.test(username)){ showAuthError('Username must be 3-20 letters, numbers or _'); return; }
  btn.disabled = true; btn.textContent = 'Creating…';
  try{
    const unameLower = username.toLowerCase();
    const unameRef = doc(db,'usernames',unameLower);
    const unameSnap = await getDoc(unameRef);
    if(unameSnap.exists()){ showAuthError('That username is taken.'); btn.disabled=false; btn.textContent='Create Account'; return; }
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: username });
    await setDoc(doc(db,'users',cred.user.uid), {
      username, usernameLower: unameLower, bio:'', avatarURL:'',
      balance: STARTING_BALANCE, createdAt: serverTimestamp(),
      netWorth: STARTING_BALANCE, netWorthHistory: [{t:Date.now(), nw:STARTING_BALANCE}]
    });
    await setDoc(unameRef, { uid: cred.user.uid });
  }catch(err){ showAuthError(friendlyAuthErr(err)); }
  btn.disabled = false; btn.textContent = 'Create Account';
});

function friendlyAuthErr(err){
  const c = err.code||'';
  if(c.includes('email-already-in-use')) return 'That email is already registered.';
  if(c.includes('invalid-email')) return 'Invalid email address.';
  if(c.includes('weak-password')) return 'Password too weak (min 6 characters).';
  if(c.includes('invalid-credential')||c.includes('wrong-password')||c.includes('user-not-found')) return 'Incorrect email or password.';
  return err.message.replace('Firebase: ','');
}

document.getElementById('topAvatar').addEventListener('click', ()=> navigate('profile'));
document.querySelectorAll('[data-nav]').forEach(el=>{
  el.addEventListener('click', ()=> navigate(el.dataset.nav));
});

onAuthStateChanged(auth, async (user)=>{
  document.getElementById('loadscreen').classList.add('hidden');
  clearUnsubs();
  if(user){
    state.uid = user.uid;
    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    listenUserDoc();
    listenTickerTape();
    listenWhaleAlerts();
    listenAutoSnipe();
    listenIncomingTransfers();
    applyBankGrowth();
    refreshNetWorthSnapshot(); // also catches Hall of Legends crossings from passive gains (bank interest, held coins appreciating) — not just right after a trade
    listenCopyOrders();
    navigate('home');
    if(!document.hidden) startBots(); // a tab that starts already hidden shouldn't run the bot economy either — visibilitychange only fires on a transition, not the initial state
    startConsoleAutoClear();
  } else {
    state.uid = null; state.userDoc = null;
    document.getElementById('app').classList.add('hidden');
    document.getElementById('authScreen').classList.remove('hidden');
    stopBots();
    stopConsoleAutoClear();
  }
});

function listenUserDoc(){
  const un = onSnapshot(doc(db,'users',state.uid), snap=>{
    if(!snap.exists()) return;
    state.userDoc = snap.data();
    document.getElementById('balanceDisplay').textContent = fmtUsd(state.userDoc.balance);
    document.getElementById('topAvatar').src = avatarFor(state.userDoc.username, state.userDoc.avatarURL);
    if(state.route.name==='profile') renderProfile();
    if(state.route.name==='portfolio') renderPortfolio();
  });
  state.unsubs.push(un);
}

function listenTickerTape(){
  const q = query(collection(db,'coins'), orderBy('marketCap','desc'), limit(20));
  const un = onSnapshot(q, snap=>{
    const coins = snap.docs.map(d=>({id:d.id,...d.data()}));
    const track = document.getElementById('tickerTrack');
    const build = coins.map(c=>{
      const chg = pctChange(c.priceHistory||[]);
      const cls = chg>=0?'chg-up':'chg-down';
      const arrow = chg>=0?'▲':'▼';
      return `<div class="ticker-item"><b>$${esc(c.ticker)}</b> ${fmtPrice(priceOf(c))} <span class="${cls}">${arrow} ${Math.abs(chg).toFixed(1)}%</span></div>`;
    }).join('');
    track.innerHTML = build + build; // duplicate for seamless loop
  });
  state.unsubs.push(un);
}

/* ===================== ROUTER ===================== */
function navigate(name, param=null){
  state.route = {name, param};
  if(name!=='coin'){ stopViewerCount(); stopHolderCount(); stopViewingMicroTick(); }
  if(name!=='home'){ if(riskyScheduleUnsub){ riskyScheduleUnsub(); riskyScheduleUnsub=null; } if(riskyCoinUnsub){ riskyCoinUnsub(); riskyCoinUnsub=null; } }
  if(name!=='insights'){ stopInsightsCountdown(); if(insightsUnsub){ insightsUnsub(); insightsUnsub=null; } }
  document.querySelectorAll('.nav-item,.bn-item').forEach(el=>{
    el.classList.toggle('active', el.dataset.nav===name);
  });
  if(name==='home') renderHome();
  else if(name==='create') renderCreate();
  else if(name==='portfolio') renderPortfolio();
  else if(name==='bank') renderBank();
  else if(name==='leaderboard') renderLeaderboard();
  else if(name==='profile') renderProfile();
  else if(name==='coin') renderCoinDetail(param);
  else if(name==='user') renderUserProfile(param);
  else if(name==='activity') renderActivity();
  else if(name==='insights') renderInsights();
  window.scrollTo(0,0);
}

// Shared "go to this person's profile" helper used from the leaderboard, activity feed, and
// trade lists — sends you to your own editable profile if it's you, otherwise the read-only
// public profile view. Bots (uid 'bot' or missing) aren't real accounts, so this is a no-op.
function openProfile(uid){
  if(!uid || uid==='bot') return;
  navigate(uid===state.uid ? 'profile' : 'user', uid);
}

/* ===================== ADMIN "PUMP" EASTER EGG ===================== */
// Hold Right Alt (only does anything for the gated admin account) then click any coin
// card/row to send a wave of 10-50 bot buys at it, staggered randomly over the next 2 minutes.
let rightAltDown = false;
const activePumps = new Set();

document.addEventListener('keydown', (e)=>{
  if(e.code!=='AltRight') return;
  rightAltDown = true;
  document.body.classList.toggle('pump-armed', isPumpAdmin());
});
document.addEventListener('keyup', (e)=>{
  if(e.code!=='AltRight') return;
  rightAltDown = false;
  document.body.classList.remove('pump-armed');
});
window.addEventListener('blur', ()=>{ rightAltDown=false; document.body.classList.remove('pump-armed'); });

// Capture phase so this runs before the coin card's own click handler navigates away.
document.addEventListener('click', (e)=>{
  if(!rightAltDown || !isPumpAdmin()) return;
  const el = e.target.closest('[data-coin]');
  if(!el || !el.dataset.coin) return;
  e.preventDefault(); e.stopImmediatePropagation();
  triggerPump(el.dataset.coin);
}, true);

function triggerPump(coinId){
  if(activePumps.has(coinId)){ toast('Already pumping that one — let it finish.', 'err'); return; }
  activePumps.add(coinId);
  const botCount = 150 + Math.floor(Math.random()*101); // 150-250 real, individually-staggered buys
  const durationMs = 10000;
  // Written to the coin doc itself (not local JS state) so it survives a hard refresh and is
  // visible to every client checking this coin, not just the tab that triggered the pump.
  updateDoc(doc(db,'coins',coinId), { pumpSellSuppressUntil: Date.now()+5*60*1000 }).catch(()=>{});
  toast(`🚀🌕 Pump activated — 1000+ bots aping in, rocketing straight to the moon!`, 'ok');
  // Fires immediately, not staggered — this is the "instantly...to the moon" part. See
  // instantMoonBoost() for why this represents "1000+ bots" without literally writing 1000+
  // separate documents in a 10-second window.
  instantMoonBoost(coinId);
  for(let i=0;i<botCount;i++){
    const delay = Math.random()*durationMs;
    setTimeout(()=>{
      const usd = 150 + Math.random()*2500; // bigger purchases than the old $8-228 range
      botBuyOnCoin(coinId, usd, usd>800);
    }, delay);
  }
  // Guarantee, regardless of how far underwater the coin currently is: once every random bot buy
  // above has had a chance to land, top it up with one final buy sized to reach exactly +100%
  // from the coin's own reference point (same one pctChange()/Gainers-Losers uses) — kept as a
  // safety net under the much bigger instant moon-boost above, in case that one somehow fails.
  setTimeout(()=> guaranteePumpToPositive100(coinId), durationMs+800);
  setTimeout(()=> activePumps.delete(coinId), durationMs+3000);
}

// "Make over 1000 bots buy in and instantly boost it to the moon" — literally firing 1000+
// separate Firestore transactions in a burst would risk the exact rate-limit problem this app
// already hit once before from far smaller volume (see the fix noted elsewhere in this file).
// Instead: one immediate transaction that (a) solves the AMM directly for a genuinely massive
// price jump — +700% to +1400% from the coin's own reference point, not just +100% — and (b)
// adds a large tradeCount jump (3,000-8,000) standing in for that claimed scale of bot activity,
// honestly, rather than pretending 1000+ individual trades actually happened one by one. The 150-
// 250 real staggered buys already firing alongside this are genuine individual trades/writes;
// this is what represents the rest of "1000+" without the write-volume risk.
async function instantMoonBoost(coinId){
  try{
    await runTransaction(db, async (tx)=>{
      const coinRef = doc(db,'coins',coinId);
      const snap = await tx.get(coinRef);
      if(!snap.exists()) return;
      const coin = snap.data();
      const hist = coin.priceHistory||[];
      const anchor = (hist.length && hist[0].p>0) ? hist[0].p : priceOf(coin);
      const currentPrice = priceOf(coin);
      const targetPrice = Math.max(anchor, currentPrice) * (8+Math.random()*7); // +700% to +1400%
      const k = coin.solReserve*coin.tokenReserve;
      const dUSD = Math.sqrt(targetPrice*k) - coin.solReserve;
      if(!(dUSD>0) || !isFinite(dUSD)) return; // dUSD>0 alone lets Infinity through — Infinity>0 is true
      const { tokensOut, newSol, newTok, newPrice } = ammBuy(coin, dUSD);
      if(!(tokensOut>0) || !isFinite(newPrice) || !isFinite(newSol) || !isFinite(newTok) || newTok<=0 || !isFinite(newPrice*totalSupplyOf(coin))) return;
      const botName = randBotName();
      const h2 = hist.concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (coin.recentTrades||[]).concat([{uid:'bot', username:botName, type:'buy', usdAmount:dUSD, tokenAmount:tokensOut, t:Date.now(), isBot:true, isExplosion:true}]).slice(-110);
      const tradeCountBoost = 3000+Math.floor(Math.random()*5000);
      tx.update(coinRef, {
        solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*totalSupplyOf(coin),
        priceHistory:h2, recentTrades:trades, tradeCount:(coin.tradeCount||0)+tradeCountBoost, lastTickAt:Date.now()
      });
    });
  }catch(err){ /* silent — bot noise shouldn't surface errors to the user */ }
}

// Solves the constant-product AMM directly for the USD buy needed to reach a target price, then
// executes it as one closing trade. price = solReserve/tokenReserve; buying dUSD raises
// solReserve by dUSD and (via the k=solReserve*tokenReserve invariant) raises price to
// (solReserve+dUSD)^2/k — so dUSD = sqrt(targetPrice*k) - solReserve solves for exactly that.
const REALITY_WARP_UNLOCK_NET_WORTH = 1e18; // Qi
const HALL_OF_LEGENDS_NET_WORTH = 1e18; // Qi — a permanent record, distinct from the live wealth-tier badge
// A personal, scaled-down version of the admin's Right Alt pump — any Qi+ user can trigger it,
// once per real calendar day, on any coin they choose. Reuses the same underlying mechanics
// (staggered bot buys + a solved-AMM moon-boost) rather than building a parallel system, just
// smaller and gated by a cooldown instead of an admin-only account check.
async function triggerRealityWarp(coinId, ticker){
  const netWorth = state.userDoc?.netWorth ?? state.userDoc?.balance ?? 0;
  if(netWorth < REALITY_WARP_UNLOCK_NET_WORTH){ toast(`Reality Warp unlocks at ${fmtUsd(REALITY_WARP_UNLOCK_NET_WORTH)}+ net worth.`, 'err'); return; }
  const lastAt = state.userDoc?.lastRealityWarpAt;
  if(lastAt && Date.now()-toMillisLoose(lastAt) < 24*3600*1000){
    const hrsLeft = Math.ceil((24*3600*1000-(Date.now()-toMillisLoose(lastAt)))/3600000);
    toast(`Only once per real day — try again in about ${hrsLeft}h.`, 'err');
    return;
  }
  try{
    await updateDoc(doc(db,'users',state.uid), { lastRealityWarpAt: Date.now() });
    updateDoc(doc(db,'coins',coinId), { pumpSellSuppressUntil: Date.now()+3*60*1000 }).catch(()=>{});
    toast(`🌌 @${state.userDoc.username} warped reality on $${ticker}!`, 'ok');
    const botCount = 40+Math.floor(Math.random()*30); // fewer bots than the admin's 150-250 — this is a personal ability, not the official pump
    for(let i=0;i<botCount;i++){
      setTimeout(()=>{
        const usd = 100+Math.random()*1800;
        botBuyOnCoin(coinId, usd, usd>800);
      }, Math.random()*8000);
    }
    setTimeout(()=> realityWarpBoost(coinId), 8500);
  }catch(err){ toast("Couldn't warp reality: "+err.message, 'err'); }
}
async function realityWarpBoost(coinId){
  try{
    await runTransaction(db, async (tx)=>{
      const coinRef = doc(db,'coins',coinId);
      const snap = await tx.get(coinRef);
      if(!snap.exists()) return;
      const coin = snap.data();
      const hist = coin.priceHistory||[];
      const anchor = (hist.length && hist[0].p>0) ? hist[0].p : priceOf(coin);
      const currentPrice = priceOf(coin);
      const targetPrice = Math.max(anchor, currentPrice) * (3+Math.random()*4); // +200% to +600% — big, but smaller than the admin pump's +700-1400%
      const k = coin.solReserve*coin.tokenReserve;
      const dUSD = Math.sqrt(targetPrice*k) - coin.solReserve;
      if(!(dUSD>0) || !isFinite(dUSD)) return; // dUSD>0 alone lets Infinity through — Infinity>0 is true
      const { tokensOut, newSol, newTok, newPrice } = ammBuy(coin, dUSD);
      if(!(tokensOut>0) || !isFinite(newPrice) || !isFinite(newSol) || !isFinite(newTok) || newTok<=0 || !isFinite(newPrice*totalSupplyOf(coin))) return;
      const h2 = hist.concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (coin.recentTrades||[]).concat([{uid:'bot', username:`${state.userDoc?.username||'?'} (Reality Warp)`, type:'buy', usdAmount:dUSD, tokenAmount:tokensOut, t:Date.now(), isBot:true, isExplosion:true}]).slice(-110);
      tx.update(coinRef, {
        solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*totalSupplyOf(coin),
        priceHistory:h2, recentTrades:trades, tradeCount:(coin.tradeCount||0)+(400+Math.floor(Math.random()*1200)),
        lastTickAt:Date.now()
      });
    });
  }catch(err){ /* silent — non-critical */ }
}

async function guaranteePumpToPositive100(coinId){
  try{
    let whaleInfo = null;
    await runTransaction(db, async (tx)=>{
      const coinRef = doc(db,'coins',coinId);
      const snap = await tx.get(coinRef);
      if(!snap.exists()) return;
      const coin = snap.data();
      const hist = coin.priceHistory||[];
      if(!hist.length || !(hist[0].p>0)) return;
      const targetPrice = hist[0].p*2; // +100% from the same anchor pctChange() reads
      if(priceOf(coin) >= targetPrice) return; // the random bot buys already cleared it on their own
      const k = coin.solReserve*coin.tokenReserve;
      const dUSD = Math.sqrt(targetPrice*k) - coin.solReserve;
      if(!(dUSD>0) || !isFinite(dUSD)) return; // dUSD>0 alone lets Infinity through — Infinity>0 is true
      const { tokensOut, newSol, newTok, newPrice } = ammBuy(coin, dUSD);
      if(!(tokensOut>0) || !isFinite(newPrice) || !isFinite(newSol) || !isFinite(newTok) || newTok<=0 || !isFinite(newPrice*totalSupplyOf(coin))) return;
      const botName = randBotName();
      const h2 = hist.concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (coin.recentTrades||[]).concat([{uid:'bot', username:botName, type:'buy', usdAmount:dUSD, tokenAmount:tokensOut, t:Date.now(), isBot:true, isExplosion:true}]).slice(-110);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*totalSupplyOf(coin), priceHistory:h2, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1, lastTickAt:Date.now() });
      if(dUSD>=WHALE_THRESHOLD) whaleInfo = { username:botName, ticker:coin.ticker, coinName:coin.name, coinImage:coin.imageURL||'', usdAmount:dUSD, type:'buy' };
    });
    if(whaleInfo) await writeWhaleActivity(coinId, whaleInfo);
  }catch(err){ /* silent — bot noise shouldn't surface errors to the user */ }
}

/* ===================== ADMIN "RESET ECONOMY" CONTROL ===================== */
// Hold Right Shift (only does anything for the gated admin account) to reveal a floating button
// that wipes every user-launched coin, clears the global activity feed, and resets every account's
// balance/holdings/closed positions back to a clean start. Bot Market coins are left untouched.
// The client-side isPumpAdmin() check just decides whether to SHOW the button — the real security
// boundary is in Firestore rules, which only grant delete/cross-account-write power to the auth
// token whose *verified* email matches the admin account (see isAdmin() in firestore.rules), so
// this can't be exercised by spoofing local state the way the pump feature technically could be.
let rightShiftDown = false;
let resetFabEl = null;
function showResetFab(){
  if(resetFabEl) return;
  resetFabEl = document.createElement('button');
  resetFabEl.className = 'admin-reset-fab';
  resetFabEl.textContent = '☢️ Reset Economy';
  resetFabEl.addEventListener('click', openResetConfirmModal);
  document.body.appendChild(resetFabEl);
}
function hideResetFab(){ if(resetFabEl){ resetFabEl.remove(); resetFabEl = null; } }

document.addEventListener('keydown', (e)=>{
  if(e.code!=='ShiftRight') return;
  rightShiftDown = true;
  if(isPumpAdmin()) showResetFab();
});
document.addEventListener('keyup', (e)=>{
  if(e.code!=='ShiftRight') return;
  rightShiftDown = false;
  hideResetFab();
});
window.addEventListener('blur', ()=>{ rightShiftDown=false; hideResetFab(); });

// Right Ctrl: instantly force-spawn a new bot coin, bypassing the normal probabilistic ~5%-a-
// minute trickle and the pool cap (this is a deliberate admin action, not the ambient spawner).
// Guarded against firing repeatedly from the browser's own key-repeat while held down.
let rightCtrlDown = false;
document.addEventListener('keydown', (e)=>{
  if(e.code!=='ControlRight') return;
  if(rightCtrlDown) return;
  rightCtrlDown = true;
  if(!isPumpAdmin()) return;
  toast('🤖 Force-spawned a new bot coin — guaranteed 10k+ holders within the hour!', 'ok');
  spawnBotCoin(true).then(coin=>{
    // Snipe it directly and immediately, rather than waiting on the listener's round-trip
    // through Firestore — guarantees it fires right away for the coin you just force-spawned,
    // instead of depending on snapshot delivery timing.
    if(coin) trySnipeBuy(coin.id, coin);
  });
});
document.addEventListener('keyup', (e)=>{
  if(e.code!=='ControlRight') return;
  rightCtrlDown = false;
});
window.addEventListener('blur', ()=>{ rightCtrlDown=false; });

// Full stop / period key: instantly spawn a completely NORMAL bot coin (no guaranteedGrowth
// treatment, no holder-count ramp, no snipe) — just an ordinary ambient-style spawn on demand,
// distinct from Right Ctrl's guaranteed-growth version. Same key-repeat guard as the others.
let periodKeyDown = false;
document.addEventListener('keydown', (e)=>{
  if(e.code!=='Period') return;
  if(periodKeyDown) return;
  periodKeyDown = true;
  if(!isPumpAdmin()) return;
  toast('🤖 Spawned a normal bot coin.', 'ok');
  spawnBotCoin(false);
});
document.addEventListener('keyup', (e)=>{
  if(e.code!=='Period') return;
  periodKeyDown = false;
});
window.addEventListener('blur', ()=>{ periodKeyDown=false; });

// Right Arrow: instant, un-staggered version of the pump — since it's now spammable via
// cooldown+repeat rather than firing 100 bots per press, each individual press now fires just
// ONE bot buy, sized at the admin's own current sell value on THIS coin (spam it to stack up
// to the same ~100x-and-beyond totals as before, but visibly, one buy at a time). Only does
// anything while actually viewing a coin's detail page (state.route.param is the coin being
// looked at) and only for a holding >0, since the buy size needs a real sell value to scale
// from. Deliberately spammable: a short cooldown (not a one-shot down/up guard) lets you fire
// it repeatedly by tapping OR by just holding the key down and letting the browser's own
// key-repeat drive it — the cooldown just stops a single held key from queuing up more
// simultaneous Firestore writes than anyone could actually watch happen.
const ARROW_PUMP_COOLDOWN_MS = 400;
let lastArrowPumpAt = 0;
document.addEventListener('keydown', (e)=>{
  if(e.code!=='ArrowRight') return;
  if(!isPumpAdmin()) return;
  if(state.route.name!=='coin' || !state.route.param) return;
  const now = Date.now();
  if(now-lastArrowPumpAt < ARROW_PUMP_COOLDOWN_MS) return;
  lastArrowPumpAt = now;
  triggerArrowPump(state.route.param);
});

// Left Arrow: instantly doubles the current price of whatever coin is being viewed, solved
// directly against the AMM curve (same sqrt(targetPrice*k)-solReserve approach used by
// instantMoonBoost/realityWarpBoost elsewhere in this file) rather than staggered bot buys.
// Same admin-only gating, same coin-detail-page requirement, same spammable cooldown pattern
// as Right Arrow — hold it down or tap repeatedly to keep doubling.
const ARROW_DOUBLE_COOLDOWN_MS = 400;
let lastArrowDoubleAt = 0;
document.addEventListener('keydown', (e)=>{
  if(e.code!=='ArrowLeft') return;
  if(!isPumpAdmin()) return;
  if(state.route.name!=='coin' || !state.route.param) return;
  const now = Date.now();
  if(now-lastArrowDoubleAt < ARROW_DOUBLE_COOLDOWN_MS) return;
  lastArrowDoubleAt = now;
  triggerArrowDouble(state.route.param);
});

async function triggerArrowPump(coinId){
  const coin = state.coinsCache.get(coinId);
  if(!coin) return;
  // Fetch the holding directly rather than trusting state.myHolding — that field is only ever
  // populated when the Sell tab is opened (see wireTradePanel), so on the default Buy view
  // (exactly the screen you're on when you'd press this) it's stale/unset.
  let holding = 0;
  try{
    const hSnap = await getDoc(doc(db,'users',state.uid,'holdings',coinId));
    holding = hSnap.exists() ? hSnap.data().tokens : 0;
  }catch(err){ toast("Couldn't read your holding: "+err.message, 'err'); return; }
  if(!(holding>0)){ toast("You don't hold any of this coin yet — nothing to base the sell value on.", 'err'); return; }
  const { usdOut } = ammSell(coin, holding);
  if(!(usdOut>0) || !isFinite(usdOut)) return;
  botBuyOnCoin(coinId, usdOut, true);
  toast(`⚡ Bot bought in on $${coin.ticker} for ${fmtUsd(usdOut)}`, 'ok');
}

// Solves the AMM directly for the price-double, same math as instantMoonBoost/realityWarpBoost:
// price = solReserve/tokenReserve, and buying dUSD raises price to (solReserve+dUSD)^2/k, so
// dUSD = sqrt(targetPrice*k) - solReserve hits exactly 2x current price in one shot.
async function triggerArrowDouble(coinId){
  const coin = state.coinsCache.get(coinId);
  if(!coin) return;
  try{
    let doubledPrice = null;
    await runTransaction(db, async (tx)=>{
      const coinRef = doc(db,'coins',coinId);
      const snap = await tx.get(coinRef);
      if(!snap.exists()) return;
      const c = snap.data();
      const currentPrice = priceOf(c);
      if(!(currentPrice>0)) return;
      const targetPrice = currentPrice*2;
      const k = c.solReserve*c.tokenReserve;
      const dUSD = Math.sqrt(targetPrice*k) - c.solReserve;
      if(!(dUSD>0) || !isFinite(dUSD)) return;
      const { tokensOut, newSol, newTok, newPrice } = ammBuy(c, dUSD);
      if(!(tokensOut>0) || !isFinite(newPrice) || !isFinite(newSol) || !isFinite(newTok) || newTok<=0 || !isFinite(newPrice*totalSupplyOf(c))) return;
      const hist = (c.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (c.recentTrades||[]).concat([{uid:'bot', username:randBotName(), type:'buy', usdAmount:dUSD, tokenAmount:tokensOut, t:Date.now(), isBot:true, isExplosion:true}]).slice(-110);
      tx.update(coinRef, {
        solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*totalSupplyOf(c),
        priceHistory:hist, recentTrades:trades, tradeCount:(c.tradeCount||0)+1, lastTickAt:Date.now()
      });
      doubledPrice = newPrice;
    });
    if(doubledPrice!=null) toast(`⚡ $${coin.ticker} price doubled — now ${fmtPrice(doubledPrice)}`, 'ok');
  }catch(err){ toast("Couldn't double price: "+err.message, 'err'); }
}

function openResetConfirmModal(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>☢️ Reset the entire economy?</h3>
      <p style="color:var(--txt-dim);font-size:13.5px;line-height:1.6;margin:10px 0 16px;">
        This permanently deletes every user-launched coin and frees up their tickers, clears the
        global Activity feed, and resets <b>every</b> account's cash, holdings, and closed positions
        back to a fresh $${STARTING_BALANCE}. Bot Market coins are left alone. This cannot be undone.
      </p>
      <label class="flabel">Type RESET to confirm</label>
      <input class="field" id="resetConfirmInput" placeholder="RESET" autocomplete="off">
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-ghost btn-block" id="resetCancel">Cancel</button>
        <button class="btn btn-block" id="resetConfirmBtn" style="background:var(--down);color:#fff;" disabled>Reset Everything</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e=>{ if(e.target===overlay) overlay.remove(); });
  const input = document.getElementById('resetConfirmInput');
  const confirmBtn = document.getElementById('resetConfirmBtn');
  input.addEventListener('input', ()=>{ confirmBtn.disabled = input.value.trim().toUpperCase()!=='RESET'; });
  document.getElementById('resetCancel').addEventListener('click', ()=> overlay.remove());
  confirmBtn.addEventListener('click', async ()=>{
    overlay.remove(); hideResetFab();
    await performAdminReset();
  });
}

async function performAdminReset(){
  toast('☢️ Resetting the economy — this may take a moment…', 'ok');
  try{
    let batch = writeBatch(db), ops = 0;
    const commit = async ()=>{ if(ops>0){ await batch.commit(); batch = writeBatch(db); ops = 0; } };
    const queueDelete = async (ref)=>{ batch.delete(ref); ops++; if(ops>=450) await commit(); };
    const queueUpdate = async (ref, data)=>{ batch.update(ref, data); ops++; if(ops>=450) await commit(); };

    // Delete every user-launched coin (and its ticker doc, freeing the name) — Bot Market left alone.
    const coinsSnap = await getDocs(collection(db,'coins'));
    for(const d of coinsSnap.docs){
      const c = d.data();
      if(c.isBotCoin) continue;
      await queueDelete(d.ref);
      if(c.ticker) await queueDelete(doc(db,'tickers',c.ticker));
    }

    // Wipe the global activity feed.
    const actSnap = await getDocs(collection(db,'activity'));
    for(const d of actSnap.docs) await queueDelete(d.ref);

    // Reset every account: balance/net worth back to start, and wipe holdings + closed positions.
    const usersSnap = await getDocs(collection(db,'users'));
    for(const uDoc of usersSnap.docs){
      await queueUpdate(uDoc.ref, {
        balance: STARTING_BALANCE, netWorth: STARTING_BALANCE,
        netWorthHistory: [{t:Date.now(), nw:STARTING_BALANCE}]
      });
      const holdSnap = await getDocs(collection(db,'users',uDoc.id,'holdings'));
      for(const h of holdSnap.docs) await queueDelete(h.ref);
      const closedSnap = await getDocs(collection(db,'users',uDoc.id,'closedPositions'));
      for(const c of closedSnap.docs) await queueDelete(c.ref);
    }

    await commit();
    toast('☢️ Economy reset — everyone is back to $'+STARTING_BALANCE+'.', 'ok');
  }catch(err){
    toast('Reset failed: '+err.message, 'err');
  }
}


let homeUnsub = null, homeSort='new', homeCategory='user';
function renderHome(){
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="section-title">Explore Coins</div>
    <div class="chip-row" id="categoryChips">
      <div class="chip" data-cat="user">🧑‍🤝‍🧑 Community Coins</div>
      <div class="chip" data-cat="bot">🤖 Bot Market</div>
      <div class="chip" data-cat="risky">⚠️ Risky</div>
    </div>
    <div class="cat-blurb" id="categoryBlurb"></div>
    <div id="sortSearchWrap">
      <div class="searchbar">🔍 <input id="homeSearch" placeholder="Search by name or ticker..."></div>
      <div class="chip-row" id="sortChips">
        <div class="chip" data-sort="new">🆕 New</div>
        <div class="chip" data-sort="oldest">🕰️ Oldest</div>
        <div class="chip" data-sort="cap">💰 Market Cap</div>
        <div class="chip" data-sort="gainers">🔥 Gainers</div>
        <div class="chip" data-sort="losers">📉 Losers</div>
      </div>
    </div>
    <div id="coinGrid" class="coin-grid"><div class="spinner" style="margin-top:40px;"></div></div>
  `;
  const blurb = document.getElementById('categoryBlurb');
  function updateBlurb(){
    blurb.textContent = homeCategory==='bot'
      ? "Fully simulated coins — nobody launched these, prices move automatically 24/7. Real market, real trades, but the counterparty pressure is bots, not people. Good for practicing reads on volatility."
      : homeCategory==='risky'
      ? "One coin, replaced every day. No bias, no guarantees — massive spikes, massive drops, and a real (boosted) chance it just gets rugged. Extremely unpredictable on purpose."
      : "Coins launched by real people. Price only moves when someone actually buys or sells.";
  }
  updateBlurb();
  document.querySelectorAll('#categoryChips .chip').forEach(c=>{
    c.classList.toggle('active', c.dataset.cat===homeCategory);
    c.addEventListener('click', ()=>{
      homeCategory=c.dataset.cat;
      document.querySelectorAll('#categoryChips .chip').forEach(x=>x.classList.remove('active'));
      c.classList.add('active'); updateBlurb();
      document.getElementById('sortSearchWrap').style.display = homeCategory==='risky' ? 'none' : '';
      if(homeCategory==='risky') loadRiskyCoin(); else loadHomeCoins();
    });
  });
  document.getElementById('sortSearchWrap').style.display = homeCategory==='risky' ? 'none' : '';
  document.querySelectorAll('#sortChips .chip').forEach(c=>{
    c.classList.toggle('active', c.dataset.sort===homeSort);
    c.addEventListener('click', ()=>{ homeSort=c.dataset.sort; document.querySelectorAll('#sortChips .chip').forEach(x=>x.classList.remove('active')); c.classList.add('active'); loadHomeCoins(); });
  });
  document.getElementById('homeSearch').addEventListener('input', ()=> loadHomeCoins());
  if(homeCategory==='risky') loadRiskyCoin(); else loadHomeCoins();
}

function loadHomeCoins(){
  if(homeUnsub) homeUnsub();
  if(riskyScheduleUnsub){ riskyScheduleUnsub(); riskyScheduleUnsub = null; }
  if(riskyCoinUnsub){ riskyCoinUnsub(); riskyCoinUnsub = null; }
  const sortField = homeSort==='cap'?'marketCap':'createdAt';
  const sortDir = homeSort==='oldest'?'asc':'desc';
  // Bot Market is a server-side filter (needs a composite index — see SETUP.md); Community stays
  // an unfiltered query + client-side exclusion so older coins launched before this feature
  // (which have no isBotCoin field at all) still show up correctly.
  // Capped at 100 (was briefly fully unbounded) — that showed up directly in Firebase's own
  // query-insights metrics as ~228 docs scanned per result returned once the coin collection
  // grew large from months of nothing ever getting deleted (rugged coins persist, every special
  // coin type accumulates too). 100 is still far more than the original 60-coin cap, just no
  // longer literally unbounded against an ever-growing collection.
  const q = homeCategory==='bot'
    ? query(collection(db,'coins'), where('isBotCoin','==',true), orderBy(sortField,sortDir), limit(100))
    : query(collection(db,'coins'), orderBy(sortField,sortDir), limit(100));
  homeUnsub = onSnapshot(q, snap=>{
    let coins = snap.docs.map(d=>({id:d.id,...d.data()}));
    coins.forEach(c=> state.coinsCache.set(c.id,c));
    if(homeCategory==='user') coins = coins.filter(c=> !c.isBotCoin);
    if(homeCategory==='bot') coins = coins.filter(c=> !c.isRisky); // Risky has its own dedicated tab
    const term = (document.getElementById('homeSearch')?.value||'').toLowerCase();
    if(term) coins = coins.filter(c=> c.ticker.toLowerCase().includes(term) || c.name.toLowerCase().includes(term));
    if(homeSort==='gainers') coins = coins.slice().sort((a,b)=> pctChange(b.priceHistory)-pctChange(a.priceHistory));
    if(homeSort==='losers') coins = coins.slice().sort((a,b)=> pctChange(a.priceHistory)-pctChange(b.priceHistory));
    renderCoinGrid(coins);
  }, ()=>{
    const grid = document.getElementById('coinGrid');
    if(grid) grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">Couldn't load coins — if this is the Bot Market tab, it may need a Firestore index (see SETUP.md).</div>`;
  });
  state.unsubs.push(homeUnsub);
}

function sparklineSvg(history, up){
  const pts = (history&&history.length>1)?history:[{p:1},{p:1}];
  const vals = pts.map(p=>p.p);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = (max-min)||1;
  const w=200,h=40;
  const step = w/(vals.length-1);
  const coords = vals.map((v,i)=> `${(i*step).toFixed(1)},${(h-((v-min)/range)*h*0.8-h*0.1).toFixed(1)}`).join(' ');
  const color = up? 'var(--up)':'var(--down)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// The Risky tab shows exactly one coin, replaced daily — watches meta/riskySchedule for today's
// pick (rather than a category query over the coins collection), then watches that single coin
// doc directly. Reuses renderCoinGrid so the card looks and behaves identically to every other
// coin card, just with a single-element array and its own badge (see the ⚠️ RISKY badge logic).
let riskyScheduleUnsub = null, riskyCoinUnsub = null;

function loadRiskyCoin(){
  if(homeUnsub){ homeUnsub(); homeUnsub = null; }
  if(riskyScheduleUnsub) riskyScheduleUnsub();
  if(riskyCoinUnsub){ riskyCoinUnsub(); riskyCoinUnsub = null; }
  const grid = document.getElementById('coinGrid');
  if(grid) grid.innerHTML = '<div class="spinner" style="margin-top:40px;grid-column:1/-1;"></div>';
  riskyScheduleUnsub = onSnapshot(doc(db,'meta','riskySchedule'), snap=>{
    const coinId = snap.exists() ? snap.data().coinId : null;
    if(riskyCoinUnsub){ riskyCoinUnsub(); riskyCoinUnsub = null; }
    if(!coinId){
      if(grid) grid.innerHTML = `<div class="empty" style="grid-column:1/-1;"><div class="em-ic">⚠️</div>Today's risky coin hasn't been picked yet — check back shortly.</div>`;
      return;
    }
    riskyCoinUnsub = onSnapshot(doc(db,'coins',coinId), cSnap=>{
      const g = document.getElementById('coinGrid');
      if(!g) return;
      if(!cSnap.exists()){ g.innerHTML = `<div class="empty" style="grid-column:1/-1;"><div class="em-ic">⚠️</div>Today's risky coin is gone — check back tomorrow.</div>`; return; }
      const coin = {id:cSnap.id, ...cSnap.data()};
      state.coinsCache.set(coin.id, coin);
      renderCoinGrid([coin]);
    });
  }, ()=>{ if(grid) grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">Couldn't load today's risky coin.</div>`; });
}

function renderCoinGrid(coins){
  const grid = document.getElementById('coinGrid');
  if(!grid) return;
  if(coins.length===0){
    grid.innerHTML = homeCategory==='bot'
      ? `<div class="empty" style="grid-column:1/-1;"><div class="em-ic">🤖</div>No bot coins yet — new ones spawn automatically every few minutes while the app's open. Check back shortly!</div>`
      : `<div class="empty" style="grid-column:1/-1;"><div class="em-ic">👻</div>No coins found. Be the first to launch one!</div>`;
    return;
  }
  grid.innerHTML = coins.map(c=>{
    const price = priceOf(c);
    const chg = pctChange(c.priceHistory||[]);
    const up = chg>=0;
    const mc = marketCapOf(c);
    const gradPct = Math.min(100, (mc/GRAD_MARKET_CAP)*100);
    return `
    <div class="coin-card" data-coin="${c.id}">
      <div class="coin-card-top">
        <img class="coin-logo" src="${coinLogoFor(c.ticker,c.imageURL)}" alt="">
        <div class="coin-names">
          <div class="coin-ticker">$${esc(c.ticker)}</div>
          <div class="coin-name">${esc(c.name)}</div>
        </div>
        ${c.ruggedAt?'<div class="grad-badge rug-badge">💀 RUGGED</div>':(c.isRisky?'<div class="grad-badge risky-badge">⚠️ RISKY</div>':(c.guaranteedGrowth?'<div class="grad-badge guaranteed-badge">🚀 GUARANTEED</div>':(c.isBotCoin?'<div class="grad-badge bot-badge">🤖 BOT</div>':(mc>=GRAD_MARKET_CAP?'<div class="grad-badge">🎓 GRAD</div>':''))))}
      </div>
      ${sparklineSvg(c.priceHistory, up)}
      <div class="coin-card-mid">
        <div class="coin-price mono">${fmtPrice(price)}</div>
        <div class="coin-chg ${up?'up':'down'}">${up?'▲':'▼'} ${Math.abs(chg).toFixed(1)}%</div>
      </div>
      <div class="coin-card-foot"><span>MCAP ${fmtUsd(mc)}</span><span>${c.isBotCoin?`${(c.tradeCount||0).toLocaleString()} trades`:'by @'+esc(c.creatorUsername)}</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${gradPct}%"></div></div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.coin-card').forEach(el=>{
    el.addEventListener('click', ()=> navigate('coin', el.dataset.coin));
  });
}

/* ===================== COIN DETAIL ===================== */
let coinUnsub = null, chartRange='1h', shellCoinId=null, currentRecalc=null, currentDetailCoin=null;
function renderCoinDetail(coinId){
  if(coinUnsub) coinUnsub();
  if(state.chart){ state.chart.destroy(); state.chart=null; }
  state.tradeMode='buy'; state.tradeAmount=0; shellCoinId=null; currentRecalc=null; currentDetailCoin=null;
  const view = document.getElementById('view');
  view.innerHTML = `<div class="spinner" style="margin-top:60px;"></div>`;
  coinUnsub = onSnapshot(doc(db,'coins',coinId), snap=>{
    if(!snap.exists()){ view.innerHTML = `<div class="empty"><div class="em-ic">💀</div>This coin no longer exists.</div>`; return; }
    const coin = {id:snap.id, ...snap.data()};
    state.coinsCache.set(coin.id, coin);
    if(shellCoinId !== coin.id){
      shellCoinId = coin.id;
      buildCoinDetailShell(coin); // full DOM build — only happens once per coin visit
      // Fire-and-forget, once per visit (not on every live re-render) — feeds the "coins people
      // are actually looking at trade faster" behavior in the bot tick loops.
      updateDoc(doc(db,'coins',coinId), { lastViewedAt: Date.now() }).catch(()=>{});
    } else {
      updateCoinDetailLive(coin); // cheap in-place refresh — keeps inputs/focus intact
    }
  });
  state.unsubs.push(coinUnsub);
}

function buildCoinDetailShell(coin){
  currentDetailCoin = coin;
  const view = document.getElementById('view');
  const price = priceOf(coin);
  const chg = pctChange(coin.priceHistory||[]);
  const up = chg>=0;
  const mc = marketCapOf(coin);
  const gradPct = Math.min(100, (mc/GRAD_MARKET_CAP)*100);
  const trades = (coin.recentTrades||[]).slice().reverse();

  view.innerHTML = `
    <div class="back-btn" id="backBtn">← Back to Explore</div>
    <div class="detail-grid">
      <div>
        <div class="detail-head">
          <img class="detail-logo" src="${coinLogoFor(coin.ticker,coin.imageURL)}">
          <div>
            <div class="detail-ticker" id="detailTicker">$${esc(coin.ticker)} ${coin.ruggedAt?'<span class="grad-badge rug-badge">💀 RUGGED</span>':(coin.isRisky?'<span class="grad-badge risky-badge">⚠️ RISKY — replaced daily</span>':(coin.guaranteedGrowth?'<span class="grad-badge guaranteed-badge">🚀 GUARANTEED GROWTH</span>':(coin.isBotCoin?'<span class="grad-badge bot-badge">🤖 BOT MARKET</span>':(mc>=GRAD_MARKET_CAP?'<span class="grad-badge">🎓 GRADUATED</span>':''))))}</div>
            <div class="detail-name">${coin.isBotCoin? `${esc(coin.name)} · fully automated, trades 24/7 · live for ${ageText(coin.createdAt)} · ${(coin.tradeCount||0).toLocaleString()} trades so far` : `${esc(coin.name)} · launched by @${esc(coin.creatorUsername)} · ${timeAgo(coin.createdAt)}`}</div>
          </div>
        </div>
        <div class="price-row">
          <div class="price-big mono" id="livePrice">${fmtPrice(price)}</div>
          <div class="coin-chg ${up?'up':'down'}" id="liveChg">${up?'▲':'▼'} ${Math.abs(chg).toFixed(1)}%</div>
          <span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--txt-faint);"><span style="width:7px;height:7px;border-radius:50%;background:var(--lime);display:inline-block;animation:spin 2s linear infinite;"></span>LIVE</span>
        </div>
        <div class="panel">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;">
            <div><div style="font-size:11.5px;color:var(--txt-dim);">MARKET CAP</div><div class="mono" style="font-weight:600;" id="liveMcap">${fmtUsd(mc)}</div></div>
            <div><div style="font-size:11.5px;color:var(--txt-dim);">SUPPLY</div><div class="mono" style="font-weight:600;">${fmtTok(totalSupplyOf(coin))}</div></div>
            <div><div style="font-size:11.5px;color:var(--txt-dim);">TRADES</div><div class="mono" style="font-weight:600;" id="liveTradeCount">${(coin.tradeCount||0)}</div></div>
          </div>
          <div class="chart-wrap"><canvas id="priceChart"></canvas></div>
          <div class="range-row" id="rangeRow">
            ${['1M','5M','1H','1D','ALL'].map(r=>`<div class="range-btn ${r.toLowerCase()===chartRange?'active':''}" data-range="${r.toLowerCase()}">${r}</div>`).join('')}
          </div>
          <div style="margin-top:14px;" id="gradWrap">
            <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--txt-dim);margin-bottom:4px;">
              <span>Bonding curve progress</span><span id="gradPctText">${gradPct.toFixed(1)}% to $${(GRAD_MARKET_CAP/1000)}K</span>
            </div>
            <div class="progress-track"><div class="progress-fill" id="gradFill" style="width:${gradPct}%"></div></div>
          </div>
        </div>

        <div class="panel" style="margin-top:16px;">
          <div style="font-weight:700;margin-bottom:6px;">About $${esc(coin.ticker)}</div>
          <div class="desc-text">${esc(coin.description)||'No description provided.'}</div>
          <div class="meta-row">
            <span class="meta-tag">🎟️ ${esc(coin.ticker)}</span>
            <span class="meta-tag ${coin.isBotCoin?'':'user-link'}" data-uid="${coin.creatorUid||''}" style="${coin.isBotCoin?'':'cursor:pointer;'}">👤 @${esc(coin.creatorUsername)}</span>
            <span class="meta-tag" id="liveLiquidity">💧 Virtual liquidity ${fmtUsd(coin.solReserve)}</span>
            <span class="meta-tag" id="viewerCount">👀 — watching</span>
          </div>
        </div>

        <div class="panel" style="margin-top:16px;">
          <div style="font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:8px;">Top Holders <span class="meta-tag" id="holderCount" style="font-weight:600;">— holders</span></div>
          <div id="topHoldersList"><div class="spinner" style="margin:10px 0;"></div></div>
        </div>

        <div class="panel" style="margin-top:16px;">
          <div style="font-weight:700;margin-bottom:10px;">Recent Trades</div>
          <div id="recentTradesList">${recentTradesHtml(trades)}</div>
        </div>
      </div>

      <div class="trade-panel">
        <div class="panel">
          <div class="trade-tabs">
            <div class="trade-tab buy ${state.tradeMode==='buy'?'active':''}" data-mode="buy">Buy</div>
            <div class="trade-tab sell ${state.tradeMode==='sell'?'active':''}" data-mode="sell">Sell</div>
          </div>
          <div id="tradePanelInner">${state.tradeMode==='buy'? buyPanelHtml(coin) : sellPanelHtml(coin)}</div>
        </div>
        ${(state.userDoc?.netWorth ?? state.userDoc?.balance ?? 0) >= REALITY_WARP_UNLOCK_NET_WORTH ? `
        <button class="btn btn-block" id="realityWarpBtn" style="margin-top:12px;background:linear-gradient(90deg,#8B6BFF,#00C9FF);color:#fff;font-weight:700;">🌌 Reality Warp</button>
        ` : ''}
      </div>
    </div>
  `;

  document.getElementById('backBtn').addEventListener('click', ()=> navigate('home'));
  document.getElementById('realityWarpBtn')?.addEventListener('click', ()=> triggerRealityWarp(coin.id, coin.ticker));
  wireUserLinks(view);
  loadTopHolders(coin.id);
  startViewerCount(coin);
  startHolderCount(coin.id);
  startViewingMicroTick(coin.id, coin);
  drawChart(coin, true);
  document.querySelectorAll('#rangeRow .range-btn').forEach(b=>{
    b.addEventListener('click', ()=>{ chartRange=b.dataset.range; document.querySelectorAll('#rangeRow .range-btn').forEach(x=>x.classList.remove('active')); b.classList.add('active'); drawChart(currentDetailCoin||coin, true); });
  });
  document.querySelectorAll('.trade-tab').forEach(t=>{
    t.addEventListener('click', ()=>{ state.tradeMode=t.dataset.mode; state.tradeAmount=0; rebuildTradePanel(currentDetailCoin||coin); });
  });
  wireTradePanel(coin);
}

function recentTradesHtml(trades){
  if(!trades.length) return '<div class="empty" style="padding:20px;">No trades yet — be the first!</div>';
  return trades.slice(0,14).map(t=>`
    <div class="holder-line">
      <div class="user-link" data-uid="${t.isBot?'':(t.uid||'')}" style="display:flex;align-items:center;gap:8px;${t.isBot?'':'cursor:pointer;'}">
        <img class="avatar-sm" src="${avatarFor(t.username, t.avatarURL)}" style="border-radius:50%;">
        <span>${t.isBot?'🤖 ':''}@${esc(t.username)}${t.viaSnipe?'\'s 🎯 snipe bot':''}${t.isExplosion?' 💥':''}${t.isDump?' 📉':''}</span>
      </div>
      <span class="${t.type==='buy'?'coin-chg up':'coin-chg down'}" style="padding:2px 7px;">${t.type==='buy'?'Bought':'Sold'}</span>
      <span class="amt mono">${fmtUsd(t.usdAmount)}</span>
    </div>`).join('');
}
/* ===================== FAKE VIEWER COUNT ===================== */
// A plausible-looking "N people watching" that's deterministic per coin+time-bucket (same
// hash-bucket trick used for bot coin mood) rather than pure Math.random every refresh — so it
// drifts naturally instead of visibly jumping around, and hotter coins (by trade count) tend to
// show more watchers.
let viewerCountInterval = null;
function estimateViewers(coin){
  const bucket = Math.floor(Date.now()/20000); // shifts every 20s
  const seed = Math.abs(Math.sin(hashStr((coin.id||'')+':'+bucket)))*10000;
  const roll = seed-Math.floor(seed); // 0..1
  const heat = Math.min(1, (coin.tradeCount||0)/2000);
  const base = 1 + heat*14;
  return Math.max(1, Math.round(base + (roll-0.5)*4));
}
function startViewerCount(coin){
  stopViewerCount();
  const update = ()=>{
    const el = document.getElementById('viewerCount');
    if(!el){ stopViewerCount(); return; }
    el.textContent = `👀 ${estimateViewers(coin)} watching`;
  };
  update();
  viewerCountInterval = setInterval(update, 8000);
}
function stopViewerCount(){ if(viewerCountInterval){ clearInterval(viewerCountInterval); viewerCountInterval=null; } }

/* ===================== LIVE HOLDER COUNT ===================== */
// A genuinely live count (not fake, unlike the viewer counter above) of distinct accounts
// currently holding this coin — uses the same collection-group index the Top Holders list needs.
let holderCountInterval = null;
// For coins force-spawned via the admin's Right Ctrl gesture: a simulated "guaranteed 10k
// holders within the hour" display boost, layered on top of the real holder count. This is NOT
// backed by 10,000 real accounts — there aren't that many real users of this app, and even if
// there were, writing 10,000 real holding documents on a single keypress would be a Firestore
// write spike bad enough to risk tripping rate limits again (see the fix noted above). Same
// honest "fake-but-plausible display number" pattern already used for the viewer count — ramps
// linearly from 0 to 10,000 over the first hour after spawn, then keeps trickling slowly upward
// afterward so it doesn't look frozen once it hits the mark.
function guaranteedHolderBoost(coin){
  if(!coin?.guaranteedHolderRampStart) return 0;
  const elapsedMs = Date.now() - toMillisLoose(coin.guaranteedHolderRampStart);
  const ONE_HOUR = 3600000;
  if(elapsedMs >= ONE_HOUR) return 10000 + Math.floor((elapsedMs-ONE_HOUR)/60000)*3;
  return Math.floor(10000 * Math.max(0, elapsedMs/ONE_HOUR));
}
async function refreshHolderCount(coinId){
  const el = document.getElementById('holderCount');
  if(!el) { stopHolderCount(); return; }
  try{
    const snap = await getCountFromServer(query(collectionGroup(db,'holdings'), where('coinId','==',coinId), where('tokens','>',0.0001)));
    const el2 = document.getElementById('holderCount'); // re-check — the await may have outlived the page
    if(!el2) return;
    const coin = state.coinsCache.get(coinId);
    const total = snap.data().count + guaranteedHolderBoost(coin);
    el2.textContent = `👥 ${total.toLocaleString()} holder${total===1?'':'s'}`;
  }catch(err){ if(el) el.textContent = '👥 —'; }
}
function startHolderCount(coinId){
  stopHolderCount();
  refreshHolderCount(coinId);
  holderCountInterval = setInterval(()=> refreshHolderCount(coinId), 60000);
}
function stopHolderCount(){ if(holderCountInterval){ clearInterval(holderCountInterval); holderCountInterval=null; } }

function wireUserLinks(container){
  container.querySelectorAll('.user-link[data-uid]').forEach(el=>{
    if(!el.dataset.uid) return;
    el.addEventListener('click', ()=> openProfile(el.dataset.uid));
  });
}

// Uses a Firestore collection-group query across every user's `holdings` subcollection, filtered
// to this one coin — only works for holdings written after coinId/username/avatarURL started
// being denormalized onto each holding doc, so older untouched holdings just won't show up here
// until that holder trades again. Needs a collection-group composite index (coinId + tokens) —
// see SETUP.md.
async function loadTopHolders(coinId){
  const list = document.getElementById('topHoldersList');
  if(!list) return;
  try{
    const snap = await getDocs(query(collectionGroup(db,'holdings'), where('coinId','==',coinId), orderBy('tokens','desc'), limit(15)));
    const coin = state.coinsCache.get(coinId);
    const totalSupply = coin ? totalSupplyOf(coin) : INITIAL_TOKEN_RESERVE;
    const holders = snap.docs.map(d=>({ uid: d.ref.parent.parent.id, ...d.data() })).filter(h=>h.tokens>0.0001);
    if(!holders.length){ list.innerHTML = '<div class="empty" style="padding:16px;">No holders yet.</div>'; return; }
    list.innerHTML = holders.map(h=>{
      const pct = totalSupply? (h.tokens/totalSupply)*100 : 0;
      return `
      <div class="holder-line">
        <div class="user-link" data-uid="${h.uid}" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <img class="avatar-sm" src="${avatarFor(h.username, h.avatarURL)}" style="border-radius:50%;">
          <span>@${esc(h.username||'anon')}${h.viaSnipe?' 🎯':''}</span>
        </div>
        <span class="mono" style="margin-left:auto;">${fmtTok(h.tokens)}</span>
        <span style="font-size:11.5px;color:var(--txt-dim);min-width:44px;text-align:right;">${pct.toFixed(1)}%</span>
      </div>`;
    }).join('');
    wireUserLinks(list);
  }catch(err){
    console.error('loadTopHolders failed:', err);
    list.innerHTML = `<div class="empty">Couldn't load holders: ${esc(err.message||err.code||'unknown error')}</div>`;
  }
}

// Cheap refresh used on every live snapshot after the shell already exists.
// Never touches the trade amount input, so typing isn't interrupted by other users' trades.
function updateCoinDetailLive(coin){
  currentDetailCoin = coin;
  const price = priceOf(coin);
  const chg = pctChange(coin.priceHistory||[]);
  const up = chg>=0;
  const mc = marketCapOf(coin);
  const gradPct = Math.min(100, (mc/GRAD_MARKET_CAP)*100);

  const priceEl = document.getElementById('livePrice');
  if(priceEl){ priceEl.textContent = fmtPrice(price); priceEl.classList.remove('flash-up','flash-down'); void priceEl.offsetWidth; priceEl.classList.add(up?'flash-up':'flash-down'); }
  const chgEl = document.getElementById('liveChg');
  if(chgEl){ chgEl.className = 'coin-chg '+(up?'up':'down'); chgEl.textContent = `${up?'▲':'▼'} ${Math.abs(chg).toFixed(1)}%`; }
  const mcapEl = document.getElementById('liveMcap'); if(mcapEl) mcapEl.textContent = fmtUsd(mc);
  const tcEl = document.getElementById('liveTradeCount'); if(tcEl) tcEl.textContent = coin.tradeCount||0;
  const liqEl = document.getElementById('liveLiquidity'); if(liqEl) liqEl.textContent = `💧 Virtual liquidity ${fmtUsd(coin.solReserve)}`;
  const gradFill = document.getElementById('gradFill'); if(gradFill) gradFill.style.width = gradPct+'%';
  const gradPctText = document.getElementById('gradPctText'); if(gradPctText) gradPctText.textContent = `${gradPct.toFixed(1)}% to $${(GRAD_MARKET_CAP/1000)}K`;
  const tickerEl = document.getElementById('detailTicker');
  if(tickerEl) tickerEl.innerHTML = `$${esc(coin.ticker)} ${coin.ruggedAt?'<span class="grad-badge rug-badge">💀 RUGGED</span>':(coin.isRisky?'<span class="grad-badge risky-badge">⚠️ RISKY — replaced daily</span>':(coin.guaranteedGrowth?'<span class="grad-badge guaranteed-badge">🚀 GUARANTEED GROWTH</span>':(coin.isBotCoin?'<span class="grad-badge bot-badge">🤖 BOT MARKET</span>':(mc>=GRAD_MARKET_CAP?'<span class="grad-badge">🎓 GRADUATED</span>':''))))}`;
  const tradesEl = document.getElementById('recentTradesList');
  if(tradesEl){ tradesEl.innerHTML = recentTradesHtml((coin.recentTrades||[]).slice().reverse()); wireUserLinks(tradesEl); }

  drawChart(coin, false);
  if(currentRecalc) currentRecalc(coin);
}

function rebuildTradePanel(coin){
  const box = document.getElementById('tradePanelInner');
  document.querySelectorAll('.trade-tab').forEach(t=> t.classList.toggle('active', t.dataset.mode===state.tradeMode));
  box.innerHTML = state.tradeMode==='buy'? buyPanelHtml(coin) : sellPanelHtml(coin);
  wireTradePanel(coin);
}

function buyPanelHtml(coin){
  const bal = state.userDoc?.balance||0;
  const amts = state.userDoc?.tradeDefaults?.buyAmounts || [5,20,50];
  return `
    ${coin.ruggedAt?(coin.isRisky
      ? '<div class="empty" style="padding:10px 4px 16px;color:var(--down);font-size:12.5px;">💀 Today\'s risky pick got rugged. Buying and selling stay completely open — rugging never blocks trading, here or anywhere else — but recovery odds on this specific coin are essentially nil until it\'s replaced tomorrow.</div>'
      : '<div class="empty" style="padding:10px 4px 16px;color:var(--down);font-size:12.5px;">💀 This coin got rugged. Still fully tradeable, but the odds of a real comeback are deliberately very low — buy in knowing it\'s mostly a long shot.</div>'
    ):''}
    <div class="amt-display"><input id="tradeAmt" inputmode="decimal" placeholder="$0" value="${state.tradeAmount||''}"></div>
    <div class="amt-sub">Balance: ${fmtUsd(bal)}</div>
    <div class="quick-row">
      <div class="quick-btn" data-amt="${amts[0]}">${fmtUsd(amts[0])}</div>
      <div class="quick-btn" data-amt="${amts[1]}">${fmtUsd(amts[1])}</div>
      <div class="quick-btn" data-amt="${amts[2]}">${fmtUsd(amts[2])}</div>
      <div class="quick-btn" data-pct="1">MAX</div>
    </div>
    <button class="btn btn-lime btn-block" id="tradeSubmit">Buy $${esc(coin.ticker)}</button>
    <div class="trade-stat-row"><span>You'll receive</span><span class="mono" id="estOut">0 ${esc(coin.ticker)}</span></div>
    <div class="trade-stat-row"><span>Price impact</span><span class="mono" id="estImpact">0.00%</span></div>
  `;
}
function sellPanelHtml(coin){
  const holding = state.myHolding || 0;
  return `
    <div class="amt-display"><input id="tradeAmt" inputmode="decimal" placeholder="0" value="${state.tradeAmount||''}"></div>
    <div class="amt-sub" id="sellSub">You own: ${fmtTok(holding)} ${esc(coin.ticker)}</div>
    <div class="quick-row">
      <div class="quick-btn" data-pct=".25">25%</div>
      <div class="quick-btn" data-pct=".5">50%</div>
      <div class="quick-btn" data-pct=".75">75%</div>
      <div class="quick-btn" data-pct="1">MAX</div>
    </div>
    <button class="btn btn-magenta btn-block" id="tradeSubmit">Sell $${esc(coin.ticker)}</button>
    <div class="trade-stat-row"><span>You'll receive</span><span class="mono" id="estOut">$0.00</span></div>
    <div class="trade-stat-row"><span>Price impact</span><span class="mono" id="estImpact">0.00%</span></div>
    <button class="btn btn-ghost btn-block" style="margin-top:10px;" id="sendCoinBtn">🎁 Send to a user</button>
  `;
}

async function wireTradePanel(coin){
  let liveCoin = coin;
  // fetch my holding for sell mode
  if(state.tradeMode==='sell'){
    const hSnap = await getDoc(doc(db,'users',state.uid,'holdings',coin.id));
    state.myHolding = hSnap.exists()? hSnap.data().tokens : 0;
    const subEl = document.getElementById('sellSub');
    if(subEl) subEl.textContent = `You own: ${fmtTok(state.myHolding)} ${coin.ticker}`;
  }
  const input = document.getElementById('tradeAmt');
  const estOut = document.getElementById('estOut');
  const estImpact = document.getElementById('estImpact');
  if(!input) return; // panel not in DOM (mode switched again before this resolved)
  function recalc(updatedCoin){
    if(updatedCoin) liveCoin = updatedCoin;
    const v = parseFloat(input.value)||0;
    state.tradeAmount = v;
    if(v<=0){ estOut.textContent = state.tradeMode==='buy'? ('0 '+liveCoin.ticker) : '$0.00'; estImpact.textContent='0.00%'; return; }
    if(state.tradeMode==='buy'){
      const { tokensOut, newPrice } = ammBuy(liveCoin, v);
      estOut.textContent = fmtTok(Math.max(0,tokensOut))+' '+liveCoin.ticker;
      const oldPrice = priceOf(liveCoin);
      estImpact.textContent = (oldPrice? (((newPrice-oldPrice)/oldPrice)*100).toFixed(2):'0.00')+'%';
    } else {
      const { usdOut, newPrice } = ammSell(liveCoin, v);
      estOut.textContent = fmtUsd(Math.max(0,usdOut));
      const oldPrice = priceOf(liveCoin);
      estImpact.textContent = (oldPrice? (((newPrice-oldPrice)/oldPrice)*100).toFixed(2):'0.00')+'%';
    }
  }
  input.addEventListener('input', ()=>recalc());
  recalc();
  currentRecalc = recalc; // let live snapshot updates recompute against fresh reserves

  document.querySelectorAll('.quick-btn').forEach(b=>{
    b.addEventListener('click', ()=>{
      if(b.dataset.amt){ input.value = b.dataset.amt; }
      else if(b.dataset.pct){
        const pct = parseFloat(b.dataset.pct);
        if(state.tradeMode==='buy'){ input.value = ((state.userDoc?.balance||0)*pct).toFixed(2); }
        else { input.value = ((state.myHolding||0)*pct).toFixed(4); }
      }
      recalc();
    });
  });

  const submitBtn = document.getElementById('tradeSubmit');
  submitBtn.addEventListener('click', ()=>{
    if(state.tradeMode==='buy') doBuy(coin.id, parseFloat(input.value)||0);
    else doSell(coin.id, parseFloat(input.value)||0);
  });
  document.getElementById('sendCoinBtn')?.addEventListener('click', ()=> openSendCoinModal(coin));
}

function openSendCoinModal(coin){
  const holding = state.myHolding||0;
  if(!(holding>0)){ toast("You don't hold any of this coin to send.", 'err'); return; }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>🎁 Send $${esc(coin.ticker)}</h3>
      <div style="font-size:12.5px;color:var(--txt-dim);margin:10px 0;">You own ${fmtTok(holding)} tokens. This is a gift, not a sale — no coins are created or destroyed, they just move from your holdings to theirs.</div>
      <label class="flabel">Recipient username</label>
      <input class="field" id="sendCoinUser" placeholder="username">
      <label class="flabel" style="margin-top:10px;">Amount of tokens</label>
      <div style="display:flex;gap:8px;">
        <input class="field" id="sendCoinAmount" style="flex:1;" inputmode="decimal" placeholder="0">
        <button class="btn btn-ghost" id="sendCoinMaxBtn">MAX</button>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-ghost btn-block" id="sendCoinCancelBtn">Cancel</button>
        <button class="btn btn-lime btn-block" id="sendCoinConfirmBtn">Send</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e=>{ if(e.target===overlay) overlay.remove(); });
  attachUserAutocomplete(document.getElementById('sendCoinUser'));
  document.getElementById('sendCoinCancelBtn').addEventListener('click', ()=> overlay.remove());
  document.getElementById('sendCoinMaxBtn').addEventListener('click', ()=>{ document.getElementById('sendCoinAmount').value = holding; });
  document.getElementById('sendCoinConfirmBtn').addEventListener('click', async ()=>{
    const uname = document.getElementById('sendCoinUser').value;
    const amount = parseFloat(document.getElementById('sendCoinAmount').value);
    if(!uname.trim()){ toast('Enter a username.', 'err'); return; }
    overlay.remove();
    await sendCoinToUser(uname, coin.id, amount);
  });
}

function rangeMs(){
  if(chartRange==='1m') return 60000;
  if(chartRange==='5m') return 300000;
  if(chartRange==='1h') return 3600000;
  if(chartRange==='1d') return 86400000;
  return Infinity;
}

// Cache of loaded <img> elements per avatar URL, reused across every chart redraw instead of
// re-fetching/re-decoding on every tick. Triggers a redraw once an image finishes loading so a
// marker doesn't just silently stay invisible until the next live update happens to fire.
const avatarImgCache = new Map();
function getAvatarImg(url){
  if(!url) return null;
  let img = avatarImgCache.get(url);
  if(!img){
    img = new Image();
    img.src = url;
    img.onload = ()=>{ if(state.chart) state.chart.update('none'); };
    avatarImgCache.set(url, img);
  }
  return img;
}
// Matches each recent trade to the nearest visible chart point by timestamp (trades land a
// price point at the same instant, via the same transaction, so this is normally an exact or
// near-exact match) — only kept if it actually falls within the current time window/range.
function buildTradeMarkers(coin, windowed, windowMs){
  const trades = coin.recentTrades||[];
  if(!trades.length || !windowed.length) return [];
  const now = Date.now();
  const markers = [];
  trades.forEach(t=>{
    const tMs = toMillis(t.t);
    if(windowMs!==Infinity && (now-tMs)>windowMs) return;
    let bestIdx = 0, bestDiff = Infinity;
    windowed.forEach((p,i)=>{
      const diff = Math.abs(toMillis(p.t)-tMs);
      if(diff<bestDiff){ bestDiff=diff; bestIdx=i; }
    });
    // Most real users never bother setting a custom avatarURL, which left it as an empty string
    // on their trade records — getAvatarImg('') always returned null, so a plain "no custom
    // avatar" real trade silently never got a marker at all (bought or sold, not sell-specific,
    // but sells are just as likely to hit this). Falling back to the same generated default
    // avatar used everywhere else in the app fixes that. Bots (uid 'bot' or missing) stay
    // excluded on purpose — this is specifically about real people.
    const isBotTrade = !t.uid || t.uid==='bot';
    const img = isBotTrade ? null : getAvatarImg(avatarFor(t.username, t.avatarURL));
    markers.push({ index:bestIdx, trade:t, img });
  });
  return markers;
}
// Draws a small clipped-circle avatar at each matched trade's chart position — lime ring for a
// buy, red ring for a sell — and records where each ended up so canvas clicks can hit-test them
// (see the click listener set up at chart creation, below).
const tradeAvatarsPlugin = {
  id:'tradeAvatars',
  afterDatasetsDraw(chart, args, opts){
    if(!opts || !opts.markers || !opts.markers.length) return;
    const {ctx, scales, chartArea} = chart;
    const R = 10;
    const positions = [];
    // Stagger markers that land on/near the same x index so they don't fully overlap.
    const seenAtIndex = {};
    opts.markers.forEach(m=>{
      if(!m.img || !m.img.complete || !m.img.naturalWidth) { positions.push(null); return; }
      const p = scales.y.getPixelForValue(chart.data.datasets[0].data[m.index]);
      let x = scales.x.getPixelForValue(m.index);
      const bump = (seenAtIndex[m.index]||0); seenAtIndex[m.index]=bump+1;
      x += bump*16;
      const y = p - R - 10 - (bump%2)*22; // float just above the line, alternate row on stack
      if(x<chartArea.left-R || x>chartArea.right+R){ positions.push(null); return; }
      const isSell = m.trade.type==='sell';
      ctx.save();
      ctx.beginPath(); ctx.arc(x,y,R,0,Math.PI*2); ctx.closePath();
      ctx.strokeStyle = isSell? '#FF4D6D' : '#C6FF3D';
      ctx.lineWidth = 2.5; ctx.stroke();
      ctx.save();
      ctx.beginPath(); ctx.arc(x,y,R-2,0,Math.PI*2); ctx.closePath(); ctx.clip();
      ctx.drawImage(m.img, x-(R-2), y-(R-2), (R-2)*2, (R-2)*2);
      ctx.restore();
      ctx.restore();
      positions.push({x,y,r:R,trade:m.trade});
    });
    chart.$tradeAvatarPositions = positions.filter(Boolean);
  }
};

function drawChart(coin, forceRebuild){
  const ctx = document.getElementById('priceChart');
  if(!ctx) return;
  // Chart.js failing to load (CDN blocked, etc.) should never break buying/selling —
  // fail quietly here instead of throwing.
  if(typeof Chart === 'undefined'){
    if(!ctx.dataset.warned){ ctx.dataset.warned='1'; ctx.parentElement.insertAdjacentHTML('beforeend','<div style="text-align:center;color:var(--txt-faint);font-size:12px;padding-top:10px;">Chart library failed to load — trading still works fine.</div>'); }
    return;
  }
  const window_ = rangeMs();
  let hist = coin.priceHistory||[];
  let windowed = window_===Infinity ? hist : hist.filter(p=> p.t && (Date.now()-toMillis(p.t)) <= window_);
  if(windowed.length===0) windowed = hist.length? [hist[hist.length-1]] : [{p:priceOf(coin),t:Date.now()}];
  if(windowed.length===1) windowed = [{p:windowed[0].p, t:toMillis(windowed[0].t)-1000}, windowed[0]];
  const labels = windowed.map(p=> new Date(toMillis(p.t)).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second: (chartRange==='1m'||chartRange==='5m')?'2-digit':undefined}));
  const prices = windowed.map(p=>p.p);
  const up = prices[prices.length-1] >= prices[0];
  const color = up? '#C6FF3D' : '#FF4D6D';
  const UP='#C6FF3D', DOWN='#FF4D6D';

  // Spike markers: any point that jumped >2.5% from the previous one (a real buy/sell impact,
  // not just noise) gets a visible dot sized by how big the move was — this is what makes a
  // single whale buy or dump actually read as a spike instead of disappearing into the line.
  const pointRadii = prices.map((p,i)=>{
    if(i===0) return 0;
    const prev = prices[i-1];
    if(!prev) return 0;
    const chg = Math.abs((p-prev)/prev);
    if(chg > .12) return 5.5;
    if(chg > .05) return 4;
    if(chg > .025) return 2.5;
    return 0;
  });
  const pointColors = prices.map((p,i)=> i===0? UP : (p>=prices[i-1]? UP:DOWN));
  const tradeMarkers = buildTradeMarkers(coin, windowed, window_);

  if(state.chart && !forceRebuild){
    // live update: patch data in place for a smooth, non-flickery redraw
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = prices;
    state.chart.data.datasets[0].borderColor = color;
    state.chart.data.datasets[0].pointRadius = pointRadii;
    state.chart.data.datasets[0].pointBackgroundColor = pointColors;
    state.chart.options.plugins.currentPriceLine.price = prices[prices.length-1];
    state.chart.options.plugins.currentPriceLine.color = color;
    state.chart.options.plugins.tradeAvatars.markers = tradeMarkers;
    state.chart.update('none');
    return;
  }
  if(state.chart) state.chart.destroy();

  // Small local plugin (no extra CDN needed): draws a dashed "last price" reference line,
  // the way real trading terminals do, so you can see at a glance whether the latest wick
  // is above or below where price has recently been.
  const currentPriceLinePlugin = {
    id:'currentPriceLine',
    afterDraw(chart, args, opts){
      if(!opts || !(opts.price>0)) return;
      const {ctx, chartArea, scales} = chart;
      const y = scales.y.getPixelForValue(opts.price);
      if(y < chartArea.top || y > chartArea.bottom) return;
      ctx.save();
      ctx.setLineDash([4,4]);
      ctx.strokeStyle = opts.color || '#C6FF3D';
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      ctx.restore();
    }
  };

  state.chart = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[{
      data: prices, borderColor: color, borderWidth:2, tension:0,
      pointRadius: pointRadii, pointHoverRadius:5, pointBackgroundColor: pointColors, pointBorderWidth:0,
      segment:{ borderColor: (c)=> c.p0.parsed.y <= c.p1.parsed.y ? UP : DOWN },
      fill:true,
      backgroundColor: (context)=>{
        const g = context.chart.ctx.createLinearGradient(0,0,0,280);
        g.addColorStop(0, up? 'rgba(198,255,61,0.22)':'rgba(255,77,109,0.22)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        return g;
      }
    }]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:300},
      plugins:{ legend:{display:false}, currentPriceLine:{price: prices[prices.length-1], color},
        tradeAvatars:{ markers: tradeMarkers },
        tooltip:{ mode:'index', intersect:false,
        backgroundColor:'#161425', borderColor:'rgba(255,255,255,0.1)', borderWidth:1, padding:10,
        callbacks:{ label:(c)=> fmtPrice(c.parsed.y) } } },
      scales:{
        x:{ grid:{display:false}, ticks:{ color:'#615C7D', maxTicksLimit:6, font:{size:10} } },
        y:{ grid:{color:'rgba(255,255,255,0.05)'}, ticks:{ color:'#615C7D', font:{size:10}, callback:(v)=>fmtPrice(v) } }
      },
      interaction:{mode:'nearest',axis:'x',intersect:false}
    },
    plugins:[currentPriceLinePlugin, tradeAvatarsPlugin]
  });

  // Click a trade avatar to jump to that trader's profile — hit-tests against the positions the
  // plugin recorded on its last draw (see tradeAvatarsPlugin.afterDatasetsDraw above).
  ctx.onclick = (e)=>{
    const positions = state.chart?.$tradeAvatarPositions;
    if(!positions || !positions.length) return;
    const rect = ctx.getBoundingClientRect();
    const mx = e.clientX-rect.left, my = e.clientY-rect.top;
    for(const p of positions){
      if(Math.hypot(mx-p.x, my-p.y) <= p.r+3){ openProfile(p.trade.uid); return; }
    }
  };
}
function toMillis(t){ if(!t) return Date.now(); if(t.toDate) return t.toDate().getTime(); if(t.seconds) return t.seconds*1000; return t; }

let pfChartInstance = null;
function drawNetWorthChart(canvasId, history){
  const ctx = document.getElementById(canvasId);
  if(!ctx) return;
  if(typeof Chart === 'undefined'){
    ctx.parentElement.insertAdjacentHTML('beforeend','<div style="text-align:center;color:var(--txt-faint);font-size:12px;padding-top:10px;">Chart library failed to load.</div>');
    return;
  }
  if(pfChartInstance){ pfChartInstance.destroy(); pfChartInstance = null; }
  let hist = (history||[]).slice().sort((a,b)=>a.t-b.t);
  if(!hist.length) hist = [{t:Date.now(), nw:STARTING_BALANCE}];
  if(hist.length===1) hist = [{t:hist[0].t-1000, nw:hist[0].nw}, hist[0]];
  const labels = hist.map(h=> new Date(h.t).toLocaleDateString([], {month:'short', day:'numeric'}));
  const values = hist.map(h=>h.nw);
  const up = values[values.length-1] >= values[0];
  const color = up? '#C6FF3D' : '#FF4D6D';
  pfChartInstance = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[{
      data: values, borderColor: color, borderWidth:2, tension:.15, pointRadius:0, pointHoverRadius:4,
      fill:true,
      backgroundColor:(context)=>{
        const g = context.chart.ctx.createLinearGradient(0,0,0,180);
        g.addColorStop(0, up? 'rgba(198,255,61,0.2)':'rgba(255,77,109,0.2)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        return g;
      }
    }]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:300},
      plugins:{ legend:{display:false}, tooltip:{ backgroundColor:'#161425', borderColor:'rgba(255,255,255,0.1)', borderWidth:1, padding:10, callbacks:{ label:(c)=>fmtUsd(c.parsed.y) } } },
      scales:{
        x:{ grid:{display:false}, ticks:{ color:'#615C7D', maxTicksLimit:5, font:{size:10} } },
        y:{ grid:{color:'rgba(255,255,255,0.05)'}, ticks:{ color:'#615C7D', font:{size:10}, callback:(v)=>fmtUsd(v) } }
      }
    }
  });
}

/* ===================== TRADE EXECUTION ===================== */
// While a real trade is in flight on a coin, bot ticks skip that exact coin (see botTick and
// botCoinTick below) — bots racing to update the SAME document a real user's transaction is
// touching is what caused buys/sells to sometimes take ages or look stuck. Bots still trade
// everything else normally; this only pauses the one coin actively mid-transaction.
const coinsWithPendingUserTrade = new Set();

// Shows the trader's own avatar popping onto the chart, then resolves once it's actually been
// visible for a moment — callers await this BEFORE running the real trade, so the profile shows
// up first and the chart's price jump visibly happens after, not simultaneously with it. Only
// does anything if this coin's own detail page (with its chart) is what's currently on screen;
// resolves immediately otherwise so a buy/sell from Portfolio or a snipe/bot trade isn't delayed
// waiting on an animation nobody would see.
function previewTradeAvatar(coinId, type){
  return new Promise(resolve=>{
    if(state.route.name!=='coin' || state.route.param!==coinId){ resolve(); return; }
    const wrap = document.querySelector('.chart-wrap');
    if(!wrap){ resolve(); return; }
    const img = document.createElement('img');
    img.className = 'trade-avatar-preview '+(type==='buy'?'buy':'sell');
    img.src = avatarFor(state.userDoc?.username, state.userDoc?.avatarURL);
    wrap.appendChild(img);
    setTimeout(()=>{ img.remove(); resolve(); }, 450);
  });
}

async function doBuy(coinId, usdAmount, viaSnipe=false){
  if(!usdAmount || usdAmount<=0){ toast('Enter an amount to buy.', 'err'); return; }
  if(!state.userDoc){ toast("Still loading your account — try again in a second.", 'err'); return; }
  const btn = document.getElementById('tradeSubmit');
  const originalBtnText = btn?.textContent;
  if(btn){ btn.disabled=true; btn.textContent='Buying…'; }
  coinsWithPendingUserTrade.add(coinId);
  try{
    await previewTradeAvatar(coinId, 'buy');
    const result = await runTransaction(db, async (tx)=>{
      const userRef = doc(db,'users',state.uid);
      const coinRef = doc(db,'coins',coinId);
      const holdRef = doc(db,'users',state.uid,'holdings',coinId);
      const [userSnap, coinSnap, holdSnap] = await Promise.all([tx.get(userRef), tx.get(coinRef), tx.get(holdRef)]);
      if(!userSnap.exists() || !coinSnap.exists()) throw new Error('Not found.');
      const user = userSnap.data(); const coin = coinSnap.data();
      if(!isCoinHealthy(coin)) throw new Error("This coin's price data looks corrupted — try again in a moment, an ambient bot tick should repair it automatically.");
      // Same idea as the sell-side fix below: the MAX button rounds to 2 decimals, which can
      // occasionally round UP a fraction of a cent past the real balance. Clamp instead of
      // rejecting a legitimate "spend everything" buy.
      if(usdAmount > user.balance){
        if(usdAmount - user.balance <= 0.01) usdAmount = user.balance;
        else throw new Error("You don't have enough balance.");
      }
      const prevTokens = holdSnap.exists()? holdSnap.data().tokens:0;
      const maxOwnershipTokens = totalSupplyOf(coin)*MAX_OWNERSHIP_PCT;
      if(prevTokens >= maxOwnershipTokens) throw new Error(`You already hold the max allowed ${Math.round(MAX_OWNERSHIP_PCT*100)}% of this coin's supply.`);

      let { tokensOut, newSol, newTok, newPrice } = ammBuy(coin, usdAmount);
      let finalUsd = usdAmount, wasCapped = false;

      // If this buy would push the buyer over the ownership cap, only fill it up to the cap
      // and charge/refund accordingly instead of rejecting the whole trade outright.
      if(prevTokens + tokensOut > maxOwnershipTokens){
        const capTokens = maxOwnershipTokens - prevTokens;
        const denom = coin.tokenReserve - capTokens;
        if(!(capTokens>0) || denom<=0) throw new Error("Not enough of this coin left in the curve to buy more.");
        finalUsd = (capTokens*coin.solReserve)/denom;
        if(!isFinite(finalUsd) || finalUsd<=0) throw new Error("Couldn't size that trade against the ownership cap — try a smaller amount.");
        const capped = ammBuy(coin, finalUsd);
        tokensOut = capped.tokensOut; newSol = capped.newSol; newTok = capped.newTok; newPrice = capped.newPrice;
        wasCapped = true;
      }

      if(!(tokensOut>0) || !isFinite(newPrice) || !isFinite(newSol) || !isFinite(newTok) || newTok<=0 || !isFinite(newPrice*totalSupplyOf(coin))) throw new Error('Amount too small to result in a trade.');
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (coin.recentTrades||[]).concat([{uid:state.uid, username:state.userDoc.username, avatarURL:state.userDoc.avatarURL||'', type:'buy', usdAmount:finalUsd, tokenAmount:tokensOut, t:Date.now(), viaSnipe:!!viaSnipe}]).slice(-110);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*totalSupplyOf(coin), priceHistory:hist, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1, lastTickAt:Date.now(), lastRealActivityAt:Date.now() });
      tx.update(userRef, { balance: user.balance - finalUsd });
      // costBasis/totalBoughtUsd/realizedPnl power the open/closed positions shown on a profile.
      const prevHold = holdSnap.exists()? holdSnap.data() : {};
      tx.set(holdRef, {
        tokens: prevTokens+tokensOut, ticker:coin.ticker, name:coin.name, imageURL:coin.imageURL||'',
        coinId, username: state.userDoc.username, avatarURL: state.userDoc.avatarURL||'',
        costBasis: (prevHold.costBasis||0) + finalUsd,
        totalBoughtUsd: (prevHold.totalBoughtUsd||0) + finalUsd,
        totalSoldUsd: prevHold.totalSoldUsd||0, realizedPnl: prevHold.realizedPnl||0,
        firstBuyAt: prevTokens>0.0001 ? (prevHold.firstBuyAt||Date.now()) : Date.now(),
        viaSnipe: !!viaSnipe, // reflects whether the MOST RECENT trade touching this holding was a snipe buy
        updatedAt: Date.now()
      }, {merge:true});
      const activityRef = doc(collection(db,'activity'));
      tx.set(activityRef, {
        uid: state.uid, username: state.userDoc.username, avatarURL: state.userDoc.avatarURL||'',
        netWorth: state.userDoc.netWorth||0,
        type:'buy', usdAmount: finalUsd, tokenAmount: tokensOut, viaSnipe: !!viaSnipe,
        coinId: coin.id||coinId, ticker: coin.ticker, coinName: coin.name, coinImage: coin.imageURL||'',
        createdAt: serverTimestamp()
      });
      return { tokensOut, wasCapped, finalUsd, ticker: coin.ticker, name: coin.name, imageURL: coin.imageURL||'' };
    });
    if(result.wasCapped) toast(`Bought ${fmtTok(result.tokensOut)} tokens for ${fmtUsd(result.finalUsd)} — capped at ${Math.round(MAX_OWNERSHIP_PCT*100)}% ownership, rest refunded.`, 'ok');
    else if(!viaSnipe) toast(`Bought ${fmtTok(result.tokensOut)} tokens!`, 'ok');
    state.tradeAmount = 0;
    // Fire-and-forget: the trade itself already succeeded and the UI shouldn't sit on a
    // disabled button waiting for this. refreshNetWorthSnapshot batches its own coin lookups
    // internally, but even a fast batch call is still latency the person shouldn't have to watch.
    refreshNetWorthSnapshot().then(nw=>{ checkMilestones(null, nw); checkRankOvertake(); });
    pushCopyOrdersForTrade(coinId, result.ticker, result.name, result.imageURL, 'buy');
    return result;
  }catch(err){ toast(err.message, 'err'); return null; }
  finally{
    coinsWithPendingUserTrade.delete(coinId);
    if(btn){ btn.disabled=false; if(originalBtnText!=null) btn.textContent=originalBtnText; }
  }
}

async function doSell(coinId, tokenAmount){
  if(!tokenAmount || tokenAmount<=0){ toast('Enter an amount to sell.', 'err'); return; }
  if(!state.userDoc){ toast("Still loading your account — try again in a second.", 'err'); return; }
  const btn = document.getElementById('tradeSubmit');
  const originalBtnText = btn?.textContent;
  if(btn){ btn.disabled=true; btn.textContent='Selling…'; }
  coinsWithPendingUserTrade.add(coinId);
  try{
    await previewTradeAvatar(coinId, 'sell');
    const result = await runTransaction(db, async (tx)=>{
      const userRef = doc(db,'users',state.uid);
      const coinRef = doc(db,'coins',coinId);
      const holdRef = doc(db,'users',state.uid,'holdings',coinId);
      const [userSnap, coinSnap, holdSnap] = await Promise.all([tx.get(userRef), tx.get(coinRef), tx.get(holdRef)]);
      if(!userSnap.exists() || !coinSnap.exists()) throw new Error('Not found.');
      const user = userSnap.data(); const coin = coinSnap.data();
      if(!isCoinHealthy(coin)) throw new Error("This coin's price data looks corrupted — try again in a moment, an ambient bot tick should repair it automatically.");
      const owned = holdSnap.exists()? holdSnap.data().tokens:0;
      // The MAX/25%/50%/75% quick buttons round the displayed amount to 4 decimal places, which
      // can occasionally round UP a hair past what's actually owned (e.g. selling "MAX" on a
      // holding with more precision than 4 decimals). Treat anything within a tiny tolerance as
      // "sell everything" instead of rejecting a perfectly reasonable MAX sell outright.
      if(tokenAmount > owned){
        const tolerance = Math.max(owned*0.0005, 0.0001);
        if(tokenAmount - owned <= tolerance) tokenAmount = owned;
        else throw new Error("You don't own that many tokens.");
      }
      const { usdOut, newSol, newTok, newPrice } = ammSell(coin, tokenAmount);
      if(!(usdOut>0) || !isFinite(newPrice) || !isFinite(newSol) || !isFinite(newTok) || newTok<=0 || !isFinite(newPrice*totalSupplyOf(coin))) throw new Error('Amount too small to result in a trade.');
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (coin.recentTrades||[]).concat([{uid:state.uid, username:state.userDoc.username, avatarURL:state.userDoc.avatarURL||'', type:'sell', usdAmount:usdOut, tokenAmount, t:Date.now()}]).slice(-110);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*totalSupplyOf(coin), priceHistory:hist, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1, lastTickAt:Date.now(), lastRealActivityAt:Date.now() });
      tx.update(userRef, { balance: user.balance + usdOut });
      // Peel off this sell's proportional share of cost basis to get realized P&L for the trade,
      // so open positions (unrealized) and closed positions (realized) can both be shown accurately.
      const prevHold = holdSnap.exists()? holdSnap.data() : {};
      const prevCostBasis = prevHold.costBasis||0;
      const avgCost = owned>0 ? prevCostBasis/owned : 0;
      const costRemoved = Math.min(prevCostBasis, avgCost*tokenAmount);
      tx.set(holdRef, {
        tokens: owned-tokenAmount, ticker:coin.ticker, name:coin.name, imageURL:coin.imageURL||'',
        coinId, username: state.userDoc.username, avatarURL: state.userDoc.avatarURL||'',
        costBasis: Math.max(0, prevCostBasis-costRemoved),
        totalBoughtUsd: prevHold.totalBoughtUsd||0,
        totalSoldUsd: (prevHold.totalSoldUsd||0) + usdOut,
        realizedPnl: (prevHold.realizedPnl||0) + (usdOut-costRemoved),
        updatedAt: Date.now()
      }, {merge:true});
      const activityRef = doc(collection(db,'activity'));
      tx.set(activityRef, {
        uid: state.uid, username: state.userDoc.username, avatarURL: state.userDoc.avatarURL||'',
        netWorth: state.userDoc.netWorth||0,
        type:'sell', usdAmount: usdOut, tokenAmount,
        coinId: coin.id||coinId, ticker: coin.ticker, coinName: coin.name, coinImage: coin.imageURL||'',
        createdAt: serverTimestamp()
      });
      // Every sell is its own closed position (not just a full exit) — a discrete record of that
      // specific sale's cost basis, proceeds, and realized P&L, so a partial sell shows up in
      // "Closed Positions" immediately rather than waiting until the whole bag is gone.
      const closedRef = doc(collection(db,'users',state.uid,'closedPositions'));
      tx.set(closedRef, {
        coinId: coin.id||coinId, ticker: coin.ticker, name: coin.name, imageURL: coin.imageURL||'',
        tokensSold: tokenAmount, costBasis: costRemoved, proceeds: usdOut, pnl: usdOut-costRemoved,
        heldMs: Date.now() - (prevHold.firstBuyAt || Date.now()),
        viaSnipe: !!prevHold.viaSnipe, // same "most recent touch" convention as the holding's own flag
        closedAt: Date.now()
      });
      return { usdOut, pnl: usdOut-costRemoved, ticker: coin.ticker, name: coin.name, imageURL: coin.imageURL||'' };
    });
    toast(`Sold for ${fmtUsd(result.usdOut)}!`, 'ok');
    state.tradeAmount = 0;
    // Fire-and-forget — see the matching comment in doBuy above.
    refreshNetWorthSnapshot().then(nw=>{ checkMilestones(result.pnl, nw); checkRankOvertake(); });
    pushCopyOrdersForTrade(coinId, result.ticker, result.name, result.imageURL, 'sell');
    return result;
  }catch(err){ toast(err.message, 'err'); return null; }
  finally{
    coinsWithPendingUserTrade.delete(coinId);
    if(btn){ btn.disabled=false; if(originalBtnText!=null) btn.textContent=originalBtnText; }
  }
}

// Best-effort snapshot of the current user's total net worth (cash + all holdings at current
// price), appended to a timestamped history on their user doc. Powers the daily/weekly/all-time
// leaderboard views. Never blocks or throws into the calling trade flow — if this fails for any
// reason (offline, etc.) the trade itself has already succeeded.
async function refreshNetWorthSnapshot(){
  try{
    const holdSnap = await getDocs(collection(db,'users',state.uid,'holdings'));
    const holdings = holdSnap.docs.map(d=>({id:d.id,...d.data()})).filter(h=>h.tokens>0.0001);
    await ensureCoinsCached(holdings.map(h=>h.id));
    let holdingsVal = 0;
    for(const h of holdings){
      const coin = state.coinsCache.get(h.id);
      if(coin) holdingsVal += sellValue(coin, h.tokens);
    }
    const uSnap = await getDoc(doc(db,'users',state.uid));
    if(!uSnap.exists()) return null;
    const u = uSnap.data();
    const netWorth = (u.balance||0) + (u.bank?.balance||0) + holdingsVal;
    const now = Date.now();
    const cutoffKeep = now - 35*86400000; // keep ~5 weeks of history, plenty for daily/weekly lookback
    let hist = (u.netWorthHistory||[]).filter(h=>h.t>=cutoffKeep);
    hist.push({t:now, nw:netWorth});
    if(hist.length>300) hist = hist.slice(-300);
    const update = { netWorth, netWorthHistory: hist };
    // Hall of Legends: a PERMANENT record, distinct from the live wealth-tier badge (which
    // reflects current standing and disappears if net worth drops). Once you cross Qi, this
    // never gets cleared — legendAchievedAt is the presence marker (also what the Legends
    // leaderboard sorts are filtered by, implicitly — see loadHallOfLegends), and
    // legendPeakNetWorth keeps climbing if net worth goes even higher afterward.
    if(netWorth>=HALL_OF_LEGENDS_NET_WORTH && !u.legendAchievedAt){
      update.legendAchievedAt = serverTimestamp();
      update.legendPeakNetWorth = netWorth;
    } else if(netWorth>=HALL_OF_LEGENDS_NET_WORTH && netWorth>(u.legendPeakNetWorth||0)){
      update.legendPeakNetWorth = netWorth;
    }
    await updateDoc(doc(db,'users',state.uid), update);
    return netWorth;
  }catch(err){ return null; /* leaderboard snapshotting is best-effort */ }
}

/* ===================== MILESTONES (confetti) ===================== */
// First profitable trade, first $1,000 net worth, biggest single win — each fires once (tracked
// via flags on the user doc) and triggers a confetti burst + toast. pnlThisSale is null for buys
// (which can still trigger the net-worth milestone via unrealized gains, just not the P&L ones).
async function checkMilestones(pnlThisSale, netWorth){
  const u = state.userDoc; if(!u) return;
  const ms = u.milestones||{};
  const updates = {};
  const fired = [];
  netWorth = netWorth ?? (u.netWorth ?? u.balance ?? STARTING_BALANCE);
  if(pnlThisSale!=null && pnlThisSale>0 && !ms.firstProfit){
    updates['milestones.firstProfit'] = true;
    fired.push('🎉 First profitable trade!');
  }
  if(netWorth>=1000 && !ms.first1k){
    updates['milestones.first1k'] = true;
    fired.push('💰 You hit $1,000 net worth!');
  }
  if(pnlThisSale!=null && pnlThisSale>(ms.bestWinPnl||0)){
    updates['milestones.bestWinPnl'] = pnlThisSale;
    if(pnlThisSale>0) fired.push(`🏆 New biggest win: ${fmtUsd(pnlThisSale)}!`);
  }
  if(Object.keys(updates).length){
    try{ await updateDoc(doc(db,'users',state.uid), updates); }catch(err){}
  }
  fired.forEach(msg=>{ confettiBurst(); toast(msg, 'ok'); });
}

/* ===================== RANK OVERTAKE TOAST ===================== */
let lastKnownRank = null, lastKnownRankRows = null;
async function checkRankOvertake(){
  try{
    const snap = await getDocs(query(collection(db,'users'), orderBy('netWorth','desc'), limit(10)));
    const rows = snap.docs.map((d,i)=>({uid:d.id, username:d.data().username, rank:i+1}));
    const myRow = rows.find(r=>r.uid===state.uid);
    if(!myRow){ lastKnownRank = null; lastKnownRankRows = rows; return; }
    if(lastKnownRank!=null && myRow.rank<lastKnownRank){
      const prevOccupant = (lastKnownRankRows||[]).find(r=>r.rank===myRow.rank && r.uid!==state.uid);
      if(prevOccupant?.username) toast(`🚀 You just overtook @${prevOccupant.username} for #${myRow.rank}!`, 'ok', ()=> navigate('leaderboard'));
      else toast(`🚀 You climbed to #${myRow.rank} on the leaderboard!`, 'ok', ()=> navigate('leaderboard'));
    }
    lastKnownRank = myRow.rank;
    lastKnownRankRows = rows;
  }catch(err){ /* best-effort — never blocks the trade flow */ }
}

/* ===================== BOT ACTIVITY ===================== */
// There's no backend here — this app is 100% static Firestore + client JS, so "bots" are
// just simulated trades that any currently-open browser tab occasionally submits on behalf
// of a pool of fake trader names. They only touch a coin's own reserves/price history —
// never a real user's balance or holdings — and only target coins launched in the last
// few minutes, so a coin gets some early liquidity/action before it goes quiet.
const BOT_YOUNG_MS = 8*60*1000;      // bots only touch coins younger than this
const BOT_TICK_MS = 22000;           // how often this tab rolls the dice
// Buy/sell and explode/dump use matching chance + size ranges on purpose. Bots don't have real
// balances — a bot "buy" just pushes solReserve up as if real money arrived, and a real user who
// sells after can walk away with that virtual liquidity as actual spendable balance. If bot buying
// outweighs bot selling even slightly, every young coin's reserve drifts upward for free over time,
// which is easy money that isn't backed by anything — a big part of how balances snowballed too
// fast. Symmetric chances/sizes keep the long-run drift at ~zero: still plenty of chart chaos,
// no ambient free liquidity.
const BOT_EXPLODE_CHANCE = 0.03;     // per young coin, per tick — a dramatic pump
const BOT_DUMP_CHANCE    = 0.03;     // per young coin, per tick — a dramatic sell-off (the "drop" half of a spike)
const BOT_BUY_CHANCE     = 0.2;      // per young coin, per tick — small buy pressure
const BOT_SELL_CHANCE    = 0.2;      // per young coin, per tick — small profit-taking, keeps the line from only ever going up
let botRunning = false;

function randBotName(){ return 'Bot'+(1000+Math.floor(Math.random()*9000)); }

const WHALE_THRESHOLD = 2500; // usd — triggers a platform-wide whale alert toast for anyone online

// If a coin's reserves are already non-finite (from before the fix above existed, or any other
// corruption), every future read of it keeps producing NaN/Infinity downstream forever — Infinity
// times anything is still Infinity. Rather than leaving a coin permanently stuck, the ambient bot
// paths check for this and repair it back to sane reserves (proportioned the same way a fresh
// spawn would be) instead of attempting a doomed trade.
function isCoinHealthy(coin){
  return isFinite(coin.solReserve) && isFinite(coin.tokenReserve) && coin.solReserve>0 && coin.tokenReserve>0;
}
function repairedReserves(coin){
  const totalSupply = totalSupplyOf(coin);
  const solReserve = 4000+Math.random()*12000;
  const tokenReserve = totalSupply*0.5; // mid-curve — a reasonable, unremarkable starting point
  return { solReserve, tokenReserve, price: solReserve/tokenReserve };
}

async function botBuyOnCoin(coinId, usdAmount, isExplosion){
  try{
    let whaleInfo = null;
    await runTransaction(db, async (tx)=>{
      const coinRef = doc(db,'coins',coinId);
      const coinSnap = await tx.get(coinRef);
      if(!coinSnap.exists()) return;
      const coin = coinSnap.data();
      if(!isCoinHealthy(coin)){
        const r = repairedReserves(coin);
        tx.update(coinRef, { solReserve:r.solReserve, tokenReserve:r.tokenReserve, price:r.price, marketCap:r.price*totalSupplyOf(coin), lastTickAt:Date.now() });
        return;
      }
      const { tokensOut, newSol, newTok, newPrice } = ammBuy(coin, usdAmount);
      if(!(tokensOut>0) || !isFinite(newPrice) || !isFinite(newSol) || !isFinite(newTok) || newTok<=0 || !isFinite(newPrice*totalSupplyOf(coin))) return;
      const botName = randBotName();
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (coin.recentTrades||[]).concat([{uid:'bot', username:botName, type:'buy', usdAmount, tokenAmount:tokensOut, t:Date.now(), isBot:true, isExplosion:!!isExplosion}]).slice(-110);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*totalSupplyOf(coin), priceHistory:hist, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1, lastTickAt:Date.now() });
      if(usdAmount>=WHALE_THRESHOLD) whaleInfo = { username:botName, ticker:coin.ticker, coinName:coin.name, coinImage:coin.imageURL||'', usdAmount, type:'buy' };
    });
    if(whaleInfo) await writeWhaleActivity(coinId, whaleInfo);
  }catch(err){ /* silent — bot noise shouldn't surface errors to the user */ }
}

// Sell-side bot pressure, mirroring botBuyOnCoin. Bots don't carry real token inventory, so
// this treats the "sell" purely as curve math (same constant-product formula ammSell uses for
// real users) — it just pushes price back down instead of up. Without this, bot activity only
// ever ratchets price upward, which reads as fake; real memecoin charts pump AND dump.
async function botSellOnCoin(coinId, usdAmount, isDump, maxSellFrac=0.05){
  try{
    let whaleInfo = null;
    await runTransaction(db, async (tx)=>{
      const coinRef = doc(db,'coins',coinId);
      const coinSnap = await tx.get(coinRef);
      if(!coinSnap.exists()) return;
      const coin = coinSnap.data();
      if(!isCoinHealthy(coin)){
        const r = repairedReserves(coin);
        tx.update(coinRef, { solReserve:r.solReserve, tokenReserve:r.tokenReserve, price:r.price, marketCap:r.price*totalSupplyOf(coin), lastTickAt:Date.now() });
        return;
      }
      const price = priceOf(coin);
      if(!(price>0) || !isFinite(price)) return;
      let tokenAmount = usdAmount/price;
      const maxSellable = coin.tokenReserve*maxSellFrac; // cap so one dump can't crater the curve to near-zero
      if(tokenAmount > maxSellable) tokenAmount = maxSellable;
      const { usdOut, newSol, newTok, newPrice } = ammSell(coin, tokenAmount);
      if(!(usdOut>0) || !isFinite(newPrice) || !isFinite(newSol) || !isFinite(newTok) || newTok<=0 || !isFinite(newPrice*totalSupplyOf(coin))) return;
      const botName = randBotName();
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (coin.recentTrades||[]).concat([{uid:'bot', username:botName, type:'sell', usdAmount:usdOut, tokenAmount, t:Date.now(), isBot:true, isDump:!!isDump}]).slice(-110);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*totalSupplyOf(coin), priceHistory:hist, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1, lastTickAt:Date.now() });
      if(usdOut>=WHALE_THRESHOLD) whaleInfo = { username:botName, ticker:coin.ticker, coinName:coin.name, coinImage:coin.imageURL||'', usdAmount:usdOut, type:'sell' };
    });
    if(whaleInfo) await writeWhaleActivity(coinId, whaleInfo);
  }catch(err){ /* silent — bot noise shouldn't surface errors to the user */ }
}

// Writes a bot whale trade to the global activity feed (tagged uid:'bot', mirroring the pattern
// already used for bot-spawned coins) so the platform-wide whale alert listener picks it up for
// everyone currently online — not just a toast in whichever tab happened to run this bot tick.
async function writeWhaleActivity(coinId, info){
  try{
    await setDoc(doc(collection(db,'activity')), {
      uid:'bot', username: info.username, avatarURL:'', isBot:true,
      type: info.type, usdAmount: info.usdAmount, tokenAmount: 0,
      coinId, ticker: info.ticker, coinName: info.coinName, coinImage: info.coinImage,
      createdAt: serverTimestamp()
    });
  }catch(err){ /* silent */ }
}

/* ===================== BOT MARKET COINS ===================== */
// A second flavor of coin, fully separate from user launches: nobody creates these, they spawn
// themselves periodically and trade forever (not just for their first 8 minutes like the young-
// coin noise above), so Explore → Bot Market always has a handful of live, chaotic charts to
// practice reading — no waiting around for real people to launch and trade something.
const BOT_COIN_POOL_CAP = 18;         // don't let the pool of bot coins grow unbounded
const BOT_COIN_TRADE_CHANCE = 0.35;   // per bot coin, per tick — was 0.75, cut hard to stay within Firestore rate limits
const BOT_COIN_QUERY_LIMIT = 15;      // was 30 — fewer coins touched per tick
// Rare, dramatic crash-and-delist event — mirrors how real memecoins actually behave, and gives
// holding a bot coin genuine stakes instead of it just being a risk-free chart to watch. ~0.15%
// chance per coin per tick means most coins live a good while, but over a long enough run it's
// basically guaranteed eventually. After the crash, the coin sticks around briefly (so the crash
// is actually visible/tradeable) before being delisted to make room for a fresh spawn.
const BOT_COIN_RUG_CHANCE = 0.0015;
const BOT_COIN_RUG_MIN_AGE_MS = 15*60*1000; // too unfair to rug something seconds after it's born
const RUGGED_RECOVERY_CHANCE = 0.06; // fixed low buy-chance for a rugged coin, replacing the normal trend-bias split
const GUARANTEED_GROWTH_QUIET_MS = 2*60*1000; // Right-Ctrl coins sit ~flat for 2 min before the rapid-growth phase kicks in
// Risky tab: exactly one coin, replaced daily, with extreme unbiased volatility and a much
// higher chance of getting rugged outright — the opposite design goal of guaranteedGrowth coins.
const RISKY_TICK_MS = 9000;          // ticks much faster than the main bot loop — just one doc, so cheap
const RISKY_TRADE_CHANCE = 0.9;
const RISKY_MIN_SWING = 800;
const RISKY_MAX_SWING = 15000;       // bigger than even Bot Market's normal whale range
const RISKY_RUG_CHANCE = 0.035;      // ~23x the normal bot-coin rug chance — was 0.012
const RISKY_RUG_MIN_AGE_MS = 5*60*1000; // short grace period so it can't rug the instant it's picked
const RISKY_MEGA_CHANCE = 0.55; // 55% of trades are genuinely violent, sized off the coin's own reserve — was 0.4

const BOT_COIN_ADJ = ['Turbo','Quantum','Galactic','Feral','Based','Chunky','Radioactive','Crimson','Velvet','Salty','Cosmic','Rusty','Electric','Ancient','Sneaky','Wobbly','Frozen','Spicy','Glitchy','Lucky','Rabid','Molten','Cursed','Giga'];
const BOT_COIN_NOUN = ['Frog','Kebab','Yeti','Sock','Wizard','Hamster','Toaster','Falcon','Pickle','Ninja','Goblin','Turtle','Rocket','Panda','Wolf','Potato','Dragon','Otter','Cactus','Robot','Gremlin','Waffle','Moose','Shrimp'];

function hashStr(s){ let h=0; for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; } return h; }
// Deterministic pseudo-random "mood" for a given coin over a short window, so price action has
// believable runs (trending up, then down) instead of pure tick-to-tick noise — same idea real
// charts show, without needing any server-side state to track it. Short bucket (90s) so the mood
// flips often, giving frequent up/down reversals rather than long flat stretches.
function botCoinTrendBias(coinId, atMs){
  const bucket = Math.floor((atMs??Date.now())/(90*1000));
  const x = Math.abs(Math.sin(hashStr(coinId+':'+bucket)))*10000;
  return (x-Math.floor(x))*2-1; // -1..1
}
function botCoinTradeSize(){
  const r = Math.random();
  if(r<0.40) return 1500+Math.random()*9000;  // whale-sized swing — now much more common, not a rare spike
  if(r<0.78) return 400+Math.random()*1400;   // medium-large — still a real, visible move
  return 100+Math.random()*350;                // smallest tier is still meaningful, no more tiny wobbles
}

// Fabricates a plausible "this coin has been live for hours" backstory at spawn time: a wobbly
// random-walk price history, a trade count already in the thousands, and a handful of recent
// trades — so a freshly-spawned bot coin immediately looks like an established, volatile market
// instead of starting flat at zero like a brand new launch.
// Bot coins deliberately use a small, human-scale supply (thousands to tens of millions, chosen
// per coin) instead of the 1B/fraction-of-a-cent scale community coins use. That's what keeps a
// normal $50 buy landing on a modest, plausible number of tokens instead of millions — with a 1B
// supply, millions of tokens per dollar is unavoidable math, not a bug, so the fix is a smaller
// supply, not a deeper curve.
const BOT_COIN_SUPPLY_CHOICES = [100_000, 500_000, 1_000_000, 5_000_000, 10_000_000, 25_000_000];

function simulateBotCoinLaunch(guaranteedGrowth=false){
  const totalSupply = BOT_COIN_SUPPLY_CHOICES[Math.floor(Math.random()*BOT_COIN_SUPPLY_CHOICES.length)];
  const now = Date.now();

  // Guaranteed-growth (Right Ctrl) coins always spawn genuinely fresh — 0 trades, a single flat
  // price point, exactly $10,000 market cap, nothing fabricated. The "rapid growth" is a real,
  // visible thing that happens afterward (see botCoinTick's guaranteedGrowth phase logic), not a
  // fake backstory pretending it already happened.
  if(guaranteedGrowth){
    const initPrice = 10000/totalSupply;
    return {
      priceHistory: [{p:initPrice, t:now}],
      currentPrice: initPrice,
      tradeCountSeed: 0,
      recentTrades: [],
      totalSupply
    };
  }

  const startMcap = 2000+Math.random()*78000; // wide spread — some tiny, some near graduation-scale
  const initPrice = startMcap/totalSupply;

  // ~30% of spawns are genuinely brand new — zero trades, flat single-point history, nothing
  // fabricated — instead of every single coin arriving with a fake multi-hour backstory. Gives
  // Explore a real mix: some coins you're seeing at literally trade #0, others already established.
  if(Math.random() < 0.3){
    return {
      priceHistory: [{p:initPrice, t:now}],
      currentPrice: initPrice,
      tradeCountSeed: 0,
      recentTrades: [],
      totalSupply
    };
  }

  const steps = 90;
  const stepGapMs = Math.floor((3+Math.random()*6)*3600000/steps); // spread over a fake 3-9hr past
  let p = initPrice;
  const priceHistory = [];
  for(let i=0;i<steps;i++){
    let mult;
    if(Math.random()<0.14){
      mult = 1 + (Math.random()<0.5?-1:1)*(0.35+Math.random()*0.55); // big jump
    } else {
      // Bigger and more frequent moves than a community coin's organic trading — this is what's
      // "priced in" as the coin's whole simulated history, so it should already look properly wild.
      mult = 1 + (Math.random()-0.5)*0.22; // energetic wobble
    }
    p = Math.max(initPrice*0.03, p*mult);
    priceHistory.push({ p, t: now-(steps-i)*stepGapMs });
  }
  const recentTrades = [];
  for(let i=0;i<14;i++){
    const isBuy = Math.random()<0.5;
    recentTrades.push({
      uid:'bot', username: randBotName(), type: isBuy?'buy':'sell',
      usdAmount: 8+Math.random()*300, tokenAmount: 20+Math.random()*5000,
      t: now-(14-i)*(stepGapMs/3), isBot:true
    });
  }
  const tradeCountSeed = 900+Math.floor(Math.random()*5200);
  return { priceHistory, currentPrice: p, tradeCountSeed, recentTrades, totalSupply };
}

async function makeUniqueBotTicker(){
  for(let attempt=0; attempt<6; attempt++){
    const adj = BOT_COIN_ADJ[Math.floor(Math.random()*BOT_COIN_ADJ.length)];
    const noun = BOT_COIN_NOUN[Math.floor(Math.random()*BOT_COIN_NOUN.length)];
    const name = `${adj} ${noun}`;
    let ticker = (adj.slice(0,2)+noun.slice(0,2)).toUpperCase();
    if(attempt>0) ticker += Math.floor(Math.random()*10);
    const tSnap = await getDoc(doc(db,'tickers',ticker));
    if(!tSnap.exists()) return { name, ticker };
  }
  return null; // give up quietly this round — next spawn check will try again
}

async function spawnBotCoin(forceSpawn=false, preset=null, isInsider=false, isRisky=false){
  try{
    const picked = preset || await makeUniqueBotTicker();
    if(!picked) return;
    const { name, ticker } = picked;
    const { priceHistory, currentPrice, tradeCountSeed, recentTrades, totalSupply } = simulateBotCoinLaunch(forceSpawn||isInsider);
    // Liquidity depth is chosen directly in dollar terms (same order of magnitude as a real
    // community coin's $8,000 depth) rather than derived from the fabricated price walk. Deriving
    // it from price meant a coin whose random walk happened to land low ended up with almost no
    // liquidity (e.g. a coin sitting at a fraction of a cent could have only ~$900 in reserve),
    // so a completely ordinary $95 buy could scoop up tens of millions of tokens. Picking depth
    // independently, then solving tokenReserve = solReserve / price, keeps token payout per
    // dollar sane regardless of where the price walk ended up. tokenReserve is clamped against
    // THIS coin's own totalSupply (not the 1B community-coin constant) — bot coins run on a much
    // smaller, human-scale supply, see BOT_COIN_SUPPLY_CHOICES above.
    let solReserve = 4000+Math.random()*12000;
    let tokenReserve = solReserve/currentPrice;
    const MIN_TOK = totalSupply*0.05, MAX_TOK = totalSupply*0.95;
    if(tokenReserve < MIN_TOK) tokenReserve = MIN_TOK;
    if(tokenReserve > MAX_TOK) tokenReserve = MAX_TOK;
    solReserve = currentPrice*tokenReserve; // keep price = solReserve/tokenReserve consistent after clamping
    const coinRef = doc(collection(db,'coins'));
    const coinData = {
      name, ticker,
      description: forceSpawn
        ? "Fully automated market. Word is this one's going to blow up — guaranteed to hit 10,000 holders within the hour."
        : isInsider
        ? "Fully automated market. Quietly seeded ahead of time — no rug risk, built to hold up for the long haul."
        : isRisky
        ? "Today's risky pick. No bias, no guarantees — could double, could get rugged. Extremely unpredictable on purpose."
        : 'Fully automated market — no creator, no roadmap, just a chaotic 24/7 chart. Real trades are still real, only the counterparty is a bot.',
      imageURL:'', creatorUid:'bot', creatorUsername:'BotNet', isBotCoin:true, totalSupply,
      solReserve, tokenReserve,
      price: currentPrice, marketCap: currentPrice*totalSupply,
      priceHistory, recentTrades, tradeCount: tradeCountSeed,
      // guaranteedGrowth is the single flag botCoinTick checks to skip rug-eligibility and swap
      // in the heavily-bullish trade bias below — shared by both the Right-Ctrl force-spawn and
      // Insider Insights coins. guaranteedHolderRampStart independently drives the simulated
      // holder-count ramp (see refreshHolderCount) and is specific to the force-spawn easter egg.
      ...((forceSpawn||isInsider) ? { guaranteedGrowth: true } : {}),
      ...(forceSpawn ? { guaranteedHolderRampStart: Date.now() } : {}),
      ...(isInsider ? { isInsider: true } : {}),
      ...(isRisky ? { isRisky: true } : {}),
      createdAt: serverTimestamp(), lastTickAt: Date.now()
    };
    await setDoc(coinRef, coinData);
    await setDoc(doc(db,'tickers',ticker), { coinId: coinRef.id });
    return { id: coinRef.id, ...coinData };
  }catch(err){ /* silent — e.g. a rare ticker race; next spawn check will just try again */ return null; }
}

let botCoinSpawnCheckCounter = 0;
async function maybeSpawnBotCoin(){
  botCoinSpawnCheckCounter++;
  const isFirstCheck = botCoinSpawnCheckCounter === 1;
  if(!isFirstCheck && botCoinSpawnCheckCounter % 4 !== 0) return; // otherwise only check roughly once a minute
  try{
    // Cheap first pass: a plain aggregation count of ALL bot coins (rugged or not). Since active
    // count can never exceed total count, if total is already comfortably under the cap we know
    // active is too, without needing to read any actual documents. Only fall back to fetching
    // full docs (to filter out rugged ones) once the total is close enough to the cap that it
    // actually matters — keeps the common case a single cheap aggregation query instead of a
    // full collection read every single check.
    const totalSnap = await getCountFromServer(query(collection(db,'coins'), where('isBotCoin','==',true)));
    const total = totalSnap.data().count;
    let count = total;
    if(total >= BOT_COIN_POOL_CAP){
      const snap = await getDocs(query(collection(db,'coins'), where('isBotCoin','==',true)));
      count = snap.docs.filter(d=>!d.data().ruggedAt).length;
    }
    if(count >= BOT_COIN_POOL_CAP) return;
    // Bootstrap: if the pool is completely empty (e.g. first time this feature has ever run),
    // spawn a handful right away instead of waiting on the ~5%-per-minute probabilistic trickle —
    // otherwise Bot Market can sit empty for 15-20+ minutes before showing anything.
    if(count===0){
      const toSpawn = Math.min(5, BOT_COIN_POOL_CAP);
      for(let i=0;i<toSpawn;i++) spawnBotCoin();
      return;
    }
    // Guaranteed bounded cadence (5–60 min) instead of a flat per-check probability, which had an
    // unbounded tail — technically possible (if unlikely) to go a very long time with no new
    // spawn at all. A persisted "next spawn at" timestamp guarantees a new coin lands somewhere
    // in that window every time, while still feeling random since the exact minute within the
    // window is picked fresh each time.
    const scheduleRef = doc(db,'meta','botSpawnSchedule');
    const scheduleSnap = await getDoc(scheduleRef);
    const now = Date.now();
    const nextAt = scheduleSnap.exists() ? toMillisLoose(scheduleSnap.data().nextSpawnAt) : 0;
    if(now >= nextAt){
      spawnBotCoin();
      const delay = (5+Math.random()*55)*60000; // 5–60 minutes out
      await setDoc(scheduleRef, { nextSpawnAt: now+delay });
    }
  }catch(err){ /* ignore — e.g. missing index while Firestore builds one */ }
}

// Insider Insights: a small number of upcoming bot coins are decided in advance (name/ticker +
// exact spawn time) and stashed in a shared doc, rather than being generated at spawn time like
// every other bot coin — that's what makes it possible to "leak" one ahead of its public launch
// to whoever can see the Insights page. Capped at INSIDER_DAILY_CAP per calendar day. Runs off
// the same once-a-minute throttle as maybeSpawnBotCoin (both piggyback on botCoinTick).
const INSIDER_DAILY_CAP = 3;
let insiderCheckCounter = 0;
async function checkInsiderSchedule(){
  insiderCheckCounter++;
  if(insiderCheckCounter!==1 && insiderCheckCounter%4!==0) return; // otherwise only check roughly once a minute
  try{
    const ref = doc(db,'meta','insiderSchedule');
    const snap = await getDoc(ref);
    const today = new Date().toISOString().slice(0,10);
    let data = snap.exists() ? snap.data() : {};
    if(data.dayKey !== today) data = { dayKey: today, spawnedToday: 0 };
    const now = Date.now();

    // Time to actually reveal-and-spawn the one that was scheduled?
    if(data.nextCoinTicker && data.nextSpawnAt && now >= toMillisLoose(data.nextSpawnAt)){
      const preset = { name: data.nextCoinName, ticker: data.nextCoinTicker };
      // Clear the schedule FIRST (best-effort claim) so another tab checking at nearly the same
      // instant won't also try to spawn the same preset coin.
      await setDoc(ref, { dayKey: data.dayKey, spawnedToday: data.spawnedToday, nextSpawnAt: null, nextCoinName: null, nextCoinTicker: null });
      await spawnBotCoin(false, preset, true);
      data = { dayKey: data.dayKey, spawnedToday: (data.spawnedToday||0)+1 };
      await setDoc(ref, data);
    }

    // Schedule the next one if there isn't one queued and we're still under the daily cap.
    if(!data.nextCoinTicker && (data.spawnedToday||0) < INSIDER_DAILY_CAP){
      const picked = await makeUniqueBotTicker();
      if(picked){
        const delay = (20+Math.random()*220)*60000; // 20 min – 4 hours out
        await setDoc(ref, {
          dayKey: data.dayKey, spawnedToday: data.spawnedToday||0,
          nextCoinName: picked.name, nextCoinTicker: picked.ticker, nextSpawnAt: now+delay
        });
      }
    }
  }catch(err){ /* ignore — e.g. missing index while Firestore builds one, or a rare scheduling race */ }
}

// Risky tab: exactly one coin, replaced once per calendar day. Simpler than Insider Insights —
// no advance leak/countdown, just "is there already a pick for today? if not, make one." Small
// accepted race risk if two tabs both check right at day-rollover (same tradeoff already made
// for Insider Insights): worst case, two risky coins get created and whichever write lands last
// wins the schedule doc, leaving one orphaned (still exists, just never shown or referenced).
let riskyCheckCounter = 0;
async function checkRiskySchedule(){
  riskyCheckCounter++;
  if(riskyCheckCounter!==1 && riskyCheckCounter%4!==0) return; // otherwise only check roughly once a minute
  try{
    const ref = doc(db,'meta','riskySchedule');
    const snap = await getDoc(ref);
    const today = new Date().toISOString().slice(0,10);
    const data = snap.exists() ? snap.data() : {};
    if(data.dayKey===today && data.coinId) return; // today's pick already exists
    const picked = await makeUniqueBotTicker();
    if(!picked) return;
    const newCoin = await spawnBotCoin(false, picked, false, true);
    if(newCoin) await setDoc(ref, { dayKey: today, coinId: newCoin.id });
  }catch(err){ /* ignore — e.g. a rare ticker/scheduling race, next check will just retry */ }
}


async function riskyCoinTick(){
  try{
    const snap = await getDoc(doc(db,'meta','riskySchedule'));
    if(!snap.exists() || !snap.data().coinId) return;
    const coinId = snap.data().coinId;
    if(coinsWithPendingUserTrade.has(coinId)) return;
    const coinSnap = await getDoc(doc(db,'coins',coinId));
    if(!coinSnap.exists()) return;
    const coin = coinSnap.data();
    if(coin.ruggedAt) return; // already rugged today — just sits until tomorrow's replacement
    const ageMs = Date.now()-toMillisLoose(coin.createdAt);
    if(ageMs>RISKY_RUG_MIN_AGE_MS && Math.random()<RISKY_RUG_CHANCE){ ruggedCoinEvent(coinId); return; }
    const hot = isCoinHot(coin);
    if(Math.random() >= (hot?0.98:RISKY_TRADE_CHANCE)) return;
    // A flat dollar range can sometimes land as a fairly mild move depending on how deep this
    // particular coin's liquidity happens to be. "Unhinged" means guaranteeing real violence a
    // good chunk of the time — mega mode sizes the trade as a large fraction of the coin's OWN
    // current reserve instead, which forces a genuinely dramatic bottom-to-top (or top-to-bottom)
    // swing regardless of depth. Sell-side mega moves also need the normal 5%-of-supply safety
    // cap relaxed, or they'd get clamped down to something tame.
    const isMega = Math.random() < RISKY_MEGA_CHANCE;
    const usd = isMega
      ? coin.solReserve * (0.6+Math.random()*1.4) // 60%–200% of current liquidity — genuinely violent
      : RISKY_MIN_SWING + Math.random()*(RISKY_MAX_SWING-RISKY_MIN_SWING);
    // Deliberately a flat 50/50 coin-flip, no trend bias at all — that's what makes it "extremely
    // unpredictable" rather than just volatile-but-still-biased like guaranteedGrowth or the
    // normal Bot Market trend logic.
    setTimeout(()=>{
      if(coinsWithPendingUserTrade.has(coinId)) return;
      if(Math.random()<0.5) botBuyOnCoin(coinId, usd, true);
      else if(pumpAllowsSell(coin)) botSellOnCoin(coinId, usd, true, isMega?0.35:0.05);
    }, hot ? Math.random()*2000 : Math.random()*7000);
  }catch(err){ /* non-critical */ }
}

// This is a static site with no server — literally nothing can move while zero browser tabs are
// open anywhere. What we CAN do: the moment any tab reopens, check how long it's been since a
// bot coin last ticked and replay that whole gap as a compressed batch of simulated ticks (same
// trade logic as the live loop, same trend-bias sequence so it reads as one coherent stretch of
// history, not random static) — then write the result in a single update. From the person's
// perspective their bot-coin holdings really did drift while they were away; it's just computed
// in one lump sum on return rather than trickling in continuously.
const BOT_COIN_CATCHUP_MAX_TICKS = 350; // cap ~80 min worth of simulated ticks per coin per catch-up
function toMillisLoose(t){ if(!t) return Date.now(); if(t.toDate) return t.toDate().getTime(); if(t.seconds) return t.seconds*1000; return t; }

async function catchUpBotCoin(coinId, coin){
  if(!isCoinHealthy(coin)) return; // already corrupted — the next live bot tick will repair it instead
  const lastTs = toMillisLoose(coin.lastTickAt || (coin.priceHistory?.length ? coin.priceHistory[coin.priceHistory.length-1].t : Date.now()));
  const elapsed = Date.now()-lastTs;
  const ticksOwed = Math.floor(elapsed/BOT_TICK_MS);
  if(ticksOwed < 3) return; // not stale enough to bother — the live loop will pick it up shortly anyway
  const steps = Math.min(ticksOwed, BOT_COIN_CATCHUP_MAX_TICKS);
  let solReserve = coin.solReserve, tokenReserve = coin.tokenReserve;
  let hist = (coin.priceHistory||[]).slice();
  let trades = (coin.recentTrades||[]).slice();
  let tradeCount = coin.tradeCount||0;
  for(let i=0;i<steps;i++){
    if(Math.random() >= BOT_COIN_TRADE_CHANCE) continue;
    const simTime = lastTs + (i+1)*BOT_TICK_MS;
    const bias = botCoinTrendBias(coinId, simTime);
    const buyChance = Math.min(0.95, Math.max(0.05, 0.5+bias*0.5));
    const usd = botCoinTradeSize();
    if(Math.random() < buyChance){
      const { tokensOut, newSol, newTok, newPrice } = ammBuy({solReserve,tokenReserve}, usd);
      if(tokensOut>0 && isFinite(newSol) && isFinite(newTok) && isFinite(newPrice) && newTok>0){
        solReserve=newSol; tokenReserve=newTok; tradeCount++;
        hist.push({p:newPrice,t:simTime});
        trades.push({uid:'bot',username:randBotName(),type:'buy',usdAmount:usd,tokenAmount:tokensOut,t:simTime,isBot:true});
      }
    } else {
      const price = solReserve/tokenReserve;
      let tokenAmount = usd/price;
      const maxSellable = tokenReserve*0.05;
      if(tokenAmount>maxSellable) tokenAmount = maxSellable;
      const { usdOut, newSol, newTok, newPrice } = ammSell({solReserve,tokenReserve}, tokenAmount);
      if(usdOut>0 && isFinite(newSol) && isFinite(newTok) && isFinite(newPrice) && newTok>0){
        solReserve=newSol; tokenReserve=newTok; tradeCount++;
        hist.push({p:newPrice,t:simTime});
        trades.push({uid:'bot',username:randBotName(),type:'sell',usdAmount:usdOut,tokenAmount,t:simTime,isBot:true});
      }
    }
  }
  hist = hist.slice(-110); trades = trades.slice(-110);
  const newPrice = solReserve/tokenReserve;
  if(!isFinite(solReserve) || !isFinite(tokenReserve) || !isFinite(newPrice) || solReserve<=0 || tokenReserve<=0 || !isFinite(newPrice*totalSupplyOf(coin))) return; // compounded across many iterations — bail rather than write a corrupted final state
  try{
    await updateDoc(doc(db,'coins',coinId), {
      solReserve, tokenReserve, price:newPrice, marketCap:newPrice*totalSupplyOf(coin),
      priceHistory:hist, recentTrades:trades, tradeCount, lastTickAt: Date.now()
    });
  }catch(err){ /* another tab may have just done the same catch-up — fine either way */ }
}

let catchUpInFlight = false;
async function catchUpAllBotCoins(){
  if(catchUpInFlight) return; // a previous call is still running — don't pile another one on top of it
  catchUpInFlight = true;
  try{
    const snap = await getDocs(query(collection(db,'coins'), where('isBotCoin','==',true), limit(BOT_COIN_QUERY_LIMIT)));
    // Parallel, not sequential — awaiting each coin one at a time meant up to 15 sequential
    // network round-trips stacking up on every single sign-in before the app felt usable. These
    // are independent documents, so there's no correctness reason to serialize them.
    await Promise.all(snap.docs.map(d=> catchUpBotCoin(d.id, d.data())));
  }catch(err){ /* ignore — e.g. missing index while Firestore builds one */ }
  finally{ catchUpInFlight = false; }
}

// "Hot" coins — someone real looked at this coin's page recently, or actually traded it
// recently — get noticeably more frequent and faster bot activity. Applies to any bot-driven
// coin (normal, rugged, guaranteed-growth, risky): boosts the effective trade-chance roll and
// shrinks the stagger delay, so a coin someone's actually paying attention to feels alive
// instead of moving at the same pace as one nobody's looked at in hours.
// The shared bot tick loops (even "hot"-boosted) still only fire every several seconds at best —
// nowhere near frequent enough to fill a 1m/5m chart window with real up-down wiggling instead
// of a mostly-flat line with the occasional jump. This is a separate, much faster loop scoped to
// whatever ONE bot-driven coin is currently open on THIS tab's detail page — never touches
// community coins at all (price there only ever moves from a real trade, which is the honest,
// correct behavior; faking movement on someone's real launch would undermine that entirely).
const VIEWING_MICRO_TICK_MS_MIN = 1400, VIEWING_MICRO_TICK_MS_MAX = 2400;
let viewingMicroTickTimer = null, viewingMicroTickCoinId = null;
function startViewingMicroTick(coinId, coin){
  stopViewingMicroTick();
  if(!coin?.isBotCoin || coin.ruggedAt) return; // never fake movement on community coins or already-rugged ones
  viewingMicroTickCoinId = coinId;
  const run = ()=>{
    viewingCoinMicroTick(viewingMicroTickCoinId);
    viewingMicroTickTimer = setTimeout(run, VIEWING_MICRO_TICK_MS_MIN + Math.random()*(VIEWING_MICRO_TICK_MS_MAX-VIEWING_MICRO_TICK_MS_MIN));
  };
  viewingMicroTickTimer = setTimeout(run, 1000);
}
function stopViewingMicroTick(){ if(viewingMicroTickTimer){ clearTimeout(viewingMicroTickTimer); viewingMicroTickTimer=null; } viewingMicroTickCoinId=null; }
async function viewingCoinMicroTick(coinId){
  try{
    if(coinsWithPendingUserTrade.has(coinId)) return;
    const coin = state.coinsCache.get(coinId);
    if(!coin || !coin.isBotCoin || coin.ruggedAt) return; // re-check — state may have changed since this was scheduled
    // Small, frequent wiggles layered on top of whatever directional bias the coin already has —
    // not meant to move price much per tick, just often enough that short timeframes look alive.
    const usd = 4 + Math.random()*40;
    const buyChance = coin.isRisky ? 0.5 : coin.guaranteedGrowth ? 0.85 : Math.min(0.9, Math.max(0.1, 0.5+botCoinTrendBias(coinId)*0.5));
    if(Math.random() < buyChance) botBuyOnCoin(coinId, usd, false);
    else botSellOnCoin(coinId, usd, false);
  }catch(err){ /* non-critical */ }
}

const HOT_COIN_WINDOW_MS = 5*60*1000;
function isCoinHot(coin){
  const now = Date.now();
  return (now-toMillisLoose(coin.lastRealActivityAt||0) < HOT_COIN_WINDOW_MS)
      || (now-toMillisLoose(coin.lastViewedAt||0) < HOT_COIN_WINDOW_MS);
}

async function botCoinTick(){
  try{
    const q = query(collection(db,'coins'), where('isBotCoin','==',true), limit(BOT_COIN_QUERY_LIMIT));
    const snap = await getDocs(q);
    snap.docs.forEach(d=>{
      if(coinsWithPendingUserTrade.has(d.id)) return; // don't fight a real trade in flight
      const coin = d.data();
      if(coin.isRisky) return; // handled entirely by its own dedicated riskyCoinTick loop instead
      const hot = isCoinHot(coin);
      const hotStagger = (ms)=> hot ? ms*0.35 : ms; // hot coins fire sooner, not just more often
      if(coin.guaranteedGrowth){
        // Right-Ctrl force-spawned coins: never eligible for a rug-pull (checked before this
        // branch is even reached, see below). Two phases, timed off guaranteedHolderRampStart
        // (set at spawn): a ~2-minute "quiet start" where it barely trades at all, so it's
        // visibly sitting flat at $10k right after spawn — then a much more aggressive rapid-
        // growth phase kicks in, heavy buy bias and bigger sizes, so the jump actually reads as
        // a jump rather than a slow climb from the very first tick.
        const spawnedAt = toMillisLoose(coin.guaranteedHolderRampStart||coin.createdAt);
        const elapsed = Date.now()-spawnedAt;
        const inQuietPhase = elapsed < GUARANTEED_GROWTH_QUIET_MS;
        if(inQuietPhase){
          if(Math.random() >= (hot?0.35:0.12)) return; // mostly nothing happens yet, unless someone's watching
          const usd = 5+Math.random()*30; // small, unremarkable
          setTimeout(()=>{
            if(coinsWithPendingUserTrade.has(d.id)) return;
            if(Math.random()<0.85) botBuyOnCoin(d.id, usd, false);
            else if(pumpAllowsSell(coin)) botSellOnCoin(d.id, usd*0.5, false);
          }, hotStagger(Math.random()*18000));
          return;
        }
        if(Math.random() >= (hot?0.97:0.9)) return; // rapid-growth phase: very high trade chance
        const usd = botCoinTradeSize()*2.2; // bigger than normal for a dramatic climb
        const big = true;
        const realDip = Math.random() < 0.28; // frequent, genuinely visible drops — not just a shallower buy
        const buyChance = realDip ? 0.15 : 0.92;
        setTimeout(()=>{
          if(coinsWithPendingUserTrade.has(d.id)) return;
          if(Math.random() < buyChance) botBuyOnCoin(d.id, usd, big);
          else if(pumpAllowsSell(coin)) botSellOnCoin(d.id, usd*(0.8+Math.random()*0.6), false); // real drop, not shallow — the overall bullish bias still wins out over time
        }, hotStagger(Math.random()*18000));
        return;
      }
      if(coin.ruggedAt){
        // Rugged coins stay in the pool forever now — no deletion, still fully tradeable — but
        // recovery is deliberately rare: buy chance is fixed low instead of using the normal
        // trend-bias split, so it mostly keeps drifting down or sideways with only an occasional
        // small bounce. Betting on a rugged coin's comeback is meant to be a real long-shot, not
        // a guaranteed loss or a normal coin in disguise.
        if(Math.random() >= (hot?Math.min(0.95,BOT_COIN_TRADE_CHANCE*2):BOT_COIN_TRADE_CHANCE)) return;
        const usd = botCoinTradeSize();
        const big = usd>800;
        setTimeout(()=>{
          if(coinsWithPendingUserTrade.has(d.id)) return;
          if(Math.random() < RUGGED_RECOVERY_CHANCE) botBuyOnCoin(d.id, usd, big);
          else if(pumpAllowsSell(coin)) botSellOnCoin(d.id, usd, big);
        }, hotStagger(Math.random()*18000));
        return;
      }
      const ageMs = Date.now()-toMillisLoose(coin.createdAt);
      if(ageMs > BOT_COIN_RUG_MIN_AGE_MS && Math.random() < BOT_COIN_RUG_CHANCE){ ruggedCoinEvent(d.id); return; }
      if(Math.random() >= (hot?Math.min(0.95,BOT_COIN_TRADE_CHANCE*2):BOT_COIN_TRADE_CHANCE)) return;
      const bias = botCoinTrendBias(d.id);
      const buyChance = Math.min(0.95, Math.max(0.05, 0.5+bias*0.5));
      const usd = botCoinTradeSize();
      const big = usd>800;
      // Stagger across most of the tick window instead of firing every qualifying coin's
      // transaction in the same synchronous instant — this loop can touch up to 30 coins per
      // tick, so without spreading them out that's up to ~20+ concurrent Firestore transactions
      // landing at once, which is what made real buys/sells occasionally take ages. Hot coins
      // still get a shrunk delay on top — someone's actually watching, so it should feel snappy.
      setTimeout(()=>{
        if(coinsWithPendingUserTrade.has(d.id)) return; // re-check — a trade may have started since
        if(Math.random() < buyChance) botBuyOnCoin(d.id, usd, big);
        else if(pumpAllowsSell(coin)) botSellOnCoin(d.id, usd, big);
      }, hotStagger(Math.random()*18000));
    });
  }catch(err){ /* ignore — e.g. missing index while Firestore builds one */ }
  maybeSpawnBotCoin();
  checkInsiderSchedule();
  checkRiskySchedule();
}

async function ruggedCoinEvent(coinId){
  let ticker = '';
  let wasRisky = false;
  try{
    await runTransaction(db, async (tx)=>{
      const coinRef = doc(db,'coins',coinId);
      const snap = await tx.get(coinRef);
      if(!snap.exists()) return;
      const c = snap.data();
      if(c.ruggedAt) return; // already rugged by another tab racing this same tick
      if(!isCoinHealthy(c)) return; // corrupted — let the next live bot tick repair it instead of rugging garbage
      ticker = c.ticker;
      wasRisky = !!c.isRisky;
      // Risky coins crash much harder than a normal rug — the whole point is a real chance of
      // losing essentially everything, not just a bad-but-survivable 90-98% hit.
      const crashFactor = c.isRisky ? (0.002+Math.random()*0.018) : (0.02+Math.random()*0.08); // risky: keep 0.2-2% (98-99.8% crash) vs normal 2-10% (90-98% crash)
      const newSol = c.solReserve*crashFactor;
      const newPrice = newSol/c.tokenReserve;
      if(!isFinite(newSol) || !isFinite(newPrice) || !isFinite(newPrice*totalSupplyOf(c))) return; // pre-crash price was already too extreme to safely shrink from
      const hist = (c.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (c.recentTrades||[]).concat([{uid:'bot', username:randBotName(), type:'sell', usdAmount:c.solReserve-newSol, tokenAmount:0, t:Date.now(), isBot:true, isRug:true}]).slice(-110);
      tx.update(coinRef, {
        solReserve:newSol, price:newPrice, marketCap:newPrice*totalSupplyOf(c),
        priceHistory:hist, recentTrades:trades, tradeCount:(c.tradeCount||0)+1,
        ruggedAt: Date.now(), lastTickAt: Date.now()
      });
    });
    if(ticker && botNotificationsEnabled()) toast(wasRisky
      ? `💀 Today's risky pick ($${ticker}) just got rugged — wiped out almost entirely in seconds. That's the risk.`
      : `💀 $${ticker} just got rugged — crashed ~90%+ in seconds. Still tradeable, but don't expect a comeback.`, 'err');
  }catch(err){ /* silent — bot noise shouldn't surface errors to the user */ }
}

// While pumpSellSuppressUntil is in the future for a coin, bot sells are heavily dampened rather
// than completely blocked — a pump should still read as strongly one-sided, but a total sell
// blackout felt too artificial/one-directional. ~15% of sell rolls still go through.
function pumpAllowsSell(coin){
  const until = coin.pumpSellSuppressUntil||0;
  if(until <= Date.now()) return true;
  return Math.random() < 0.15;
}

async function botTick(){
  try{
    const cutoff = Timestamp.fromDate(new Date(Date.now()-BOT_YOUNG_MS));
    const q = query(collection(db,'coins'), where('createdAt','>',cutoff), limit(15));
    const snap = await getDocs(q);
    snap.docs.forEach(d=>{
      const coin = d.data();
      // Bot Market coins are exclusively handled by botCoinTick — if this loop touched them too,
      // both loops fire on the same 14s cadence and can race to update the same freshly-spawned
      // doc at nearly the same instant, which is exactly what produces Firestore transaction
      // contention ("stored version doesn't match") on commit. One owner per coin, no race.
      if(coin.isBotCoin) return;
      if(coinsWithPendingUserTrade.has(d.id)) return; // don't fight a real trade in flight
      const mc = marketCapOf({...coin});
      if(mc >= GRAD_MARKET_CAP) return; // graduated coins are left alone
      // Single roll split into ranges so buy/sell/explode/dump stay mutually exclusive per tick.
      const r = Math.random();
      let acc = 0;
      // Stagger the actual write across a few seconds instead of firing every qualifying coin's
      // transaction in the same instant — spreading out when each transaction actually lands cuts
      // down peak concurrent load on Firestore, which is what made real buys/sells occasionally
      // take ages or look stuck when a lot of bot activity landed on the same coin at once.
      const fire = (fn)=> setTimeout(()=>{ if(!coinsWithPendingUserTrade.has(d.id)) fn(); }, Math.random()*18000);
      if(r < (acc += BOT_EXPLODE_CHANCE)){
        fire(()=> botBuyOnCoin(d.id, 200+Math.random()*500, true));
      } else if(r < (acc += BOT_DUMP_CHANCE)){
        if(pumpAllowsSell(coin)) fire(()=> botSellOnCoin(d.id, 200+Math.random()*500, true));
      } else if(r < (acc += BOT_BUY_CHANCE)){
        fire(()=> botBuyOnCoin(d.id, 4+Math.random()*36, false));
      } else if(r < (acc += BOT_SELL_CHANCE)){
        if(pumpAllowsSell(coin)) fire(()=> botSellOnCoin(d.id, 4+Math.random()*36, false));
      }
    });
  }catch(err){ /* ignore — e.g. missing index while Firestore builds one */ }
}

// Belt-and-suspenders on top of setLogLevel above: periodically clear the console so it can't
// silently build up a huge scrollback over a long session (e.g. from the app's own toasts/errors,
// or anything else that logs) even with Firestore's own noise already turned off.
let consoleClearInterval = null;
function startConsoleAutoClear(){
  if(consoleClearInterval) return;
  consoleClearInterval = setInterval(()=>{ try{ console.clear(); }catch(err){} }, 60000);
}

function startBots(){
  if(botRunning) return;
  botRunning = true;
  catchUpAllBotCoins(); // fast-forward anything that went stale while nobody had a tab open
  // Self-scheduling with jitter (±3s) rather than a fixed setInterval — if two tabs (or, before
  // the fix above, two loops in the same tab) both tick on a perfectly synced clock, they're far
  // more likely to race to update the same document at the same instant. Randomized spacing
  // spreads that out and cuts down on transaction contention.
  function scheduleNext(fn, base){
    if(!botRunning) return;
    setTimeout(()=>{ if(!botRunning) return; fn(); scheduleNext(fn, base); }, base + (Math.random()*6000-3000));
  }
  setTimeout(botTick, 3000);       // one early tick shortly after load
  setTimeout(botCoinTick, 4500);
  setTimeout(riskyCoinTick, 6000);
  scheduleNext(botTick, BOT_TICK_MS);
  scheduleNext(botCoinTick, BOT_TICK_MS);
  scheduleNext(riskyCoinTick, RISKY_TICK_MS);
}
function stopBots(){
  botRunning = false;
}

// The entire ambient bot economy — every tick loop in this file — only actually does anything
// while botRunning is true; scheduleNext() and both setInterval callbacks already check it
// before firing. That flag just never used to react to whether anyone was actually looking at
// the tab. A backgrounded or minimized tab was running every tick loop at full speed for no
// visible benefit to anyone, which is real, wasted load. Now: hide the tab, everything pauses
// completely; come back, startBots() restarts it (its own guard against double-starting already
// exists) and immediately re-runs the same catch-up sweep it already does on a fresh sign-in, so
// time spent hidden gets fast-forwarded the same way time spent fully offline already was.
let visibilityDebounceTimer = null;
document.addEventListener('visibilitychange', ()=>{
  clearTimeout(visibilityDebounceTimer);
  // Debounced — some browsers/embedded or preview contexts can fire visibilitychange rapidly or
  // spuriously rather than on a single clean transition. Without this, rapid flapping meant
  // repeated stopBots()/startBots() cycles, each one kicking off a fresh catchUpAllBotCoins()
  // that could overlap with a still-in-flight previous one — many concurrent transactions
  // hitting the same handful of coins at once, which is exactly what produces a fast burst of
  // errors. Only react once visibility has actually been stable for a moment.
  visibilityDebounceTimer = setTimeout(()=>{
    if(document.hidden){ stopBots(); }
    else if(state.uid){ startBots(); }
  }, 800);
});
function stopConsoleAutoClear(){ if(consoleClearInterval){ clearInterval(consoleClearInterval); consoleClearInterval = null; } }

/* ===================== CREATE COIN ===================== */
function renderCreate(){
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="create-wrap">
      <div class="section-title">Launch a Memecoin</div>
      <div class="img-upload" id="createImgPreview"><span class="plus">🖼️</span></div>
      <div class="fgroup"><label class="flabel">Logo Image URL (optional)</label><input class="field" id="cImgUrl" placeholder="https://example.com/logo.png"></div>
      <div class="fgroup"><label class="flabel">Coin Name</label><input class="field" id="cName" maxlength="32" placeholder="e.g. Kiwi Rocket"></div>
      <div class="fgroup"><label class="flabel">Ticker</label><input class="field" id="cTicker" maxlength="8" placeholder="e.g. KIWI" style="text-transform:uppercase;"></div>
      <div class="fgroup"><label class="flabel">Description</label><textarea class="field" id="cDesc" rows="3" maxlength="280" placeholder="What's this coin about?"></textarea></div>
      <div class="fee-note"><span>Launch fee</span><b>${fmtUsd(CREATE_FEE)}</b></div>
      <button class="btn btn-primary btn-block" id="createSubmit">🚀 Launch Coin</button>
      <div style="text-align:center;color:var(--txt-faint);font-size:12px;margin-top:14px;">Starts at a $${INITIAL_SOL_RESERVE} market cap with a live bonding curve. No bots — price only moves when real users trade.</div>
      ${canSeeInsights()? `<div id="insightsLink" style="text-align:center;margin-top:18px;"><a style="color:var(--violet);font-size:12.5px;cursor:pointer;text-decoration:underline;">🔮 Insider Insights</a></div>` : ''}
    </div>
  `;
  document.getElementById('insightsLink')?.addEventListener('click', ()=> navigate('insights'));
  const urlInput = document.getElementById('cImgUrl');
  const preview = document.getElementById('createImgPreview');
  urlInput.addEventListener('input', ()=>{
    const v = urlInput.value.trim();
    preview.innerHTML = v ? `<img src="${esc(v)}" onerror="this.parentElement.innerHTML='<span class=&quot;plus&quot;>⚠️</span>'">` : `<span class="plus">🖼️</span>`;
  });
  document.getElementById('createSubmit').addEventListener('click', submitCreateCoin);
}

let insightsUnsub = null, insightsCountdownInterval = null, insightsTargetMs = null;
function stopInsightsCountdown(){ if(insightsCountdownInterval){ clearInterval(insightsCountdownInterval); insightsCountdownInterval=null; } }
function updateInsightsCountdownText(){
  const el = document.getElementById('insightsCountdown');
  if(!el || !insightsTargetMs) return;
  const remaining = insightsTargetMs - Date.now();
  if(remaining<=0){ el.textContent = 'Launching…'; return; }
  const h = Math.floor(remaining/3600000);
  const m = Math.floor((remaining%3600000)/60000);
  const s = Math.floor((remaining%60000)/1000);
  el.textContent = `${h>0?h+':':''}${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
async function renderInsights(){
  const view = document.getElementById('view');
  if(!canSeeInsights()){ view.innerHTML = `<div class="empty"><div class="em-ic">🔒</div>Nothing to see here.</div>`; return; }
  view.innerHTML = `
    <div class="section-title">🔮 Insider Insights</div>
    <div class="panel">
      <div style="font-size:12.5px;color:var(--txt-dim);line-height:1.5;margin-bottom:14px;">A small number of upcoming Bot Market coins are decided ahead of time. Once one launches, it's guaranteed never to get rugged and built to hold up for the long haul — still a real, fully tradeable coin like any other, just with a head start on knowing it's coming.</div>
      <div id="insightsBody"><div class="spinner" style="margin:10px 0;"></div></div>
    </div>
  `;
  if(insightsUnsub) insightsUnsub();
  insightsUnsub = onSnapshot(doc(db,'meta','insiderSchedule'), snap=>{
    const data = snap.exists() ? snap.data() : {};
    const today = new Date().toISOString().slice(0,10);
    const spawnedToday = data.dayKey===today ? (data.spawnedToday||0) : 0;
    const body = document.getElementById('insightsBody');
    if(!body) return;
    if(data.nextCoinTicker && data.nextSpawnAt){
      insightsTargetMs = toMillisLoose(data.nextSpawnAt);
      body.innerHTML = `
        <div style="text-align:center;padding:10px 0;">
          <div style="font-size:12px;color:var(--txt-faint);">NEXT INSIDER COIN</div>
          <div style="font-size:22px;font-weight:700;margin:6px 0;">${esc(data.nextCoinName)} · $${esc(data.nextCoinTicker)}</div>
          <div class="mono" id="insightsCountdown" style="font-size:28px;font-weight:700;color:var(--lime);margin:10px 0;">--:--:--</div>
          <div style="font-size:11.5px;color:var(--txt-faint);">${spawnedToday}/${INSIDER_DAILY_CAP} revealed today</div>
        </div>`;
      stopInsightsCountdown();
      updateInsightsCountdownText();
      insightsCountdownInterval = setInterval(updateInsightsCountdownText, 1000);
    } else {
      insightsTargetMs = null;
      stopInsightsCountdown();
      body.innerHTML = `<div class="empty" style="padding:20px;">${spawnedToday>=INSIDER_DAILY_CAP ? `That's all ${INSIDER_DAILY_CAP} for today — check back tomorrow.` : 'Nothing scheduled right this second — check back in a bit.'}</div>`;
    }
  }, ()=>{ const body = document.getElementById('insightsBody'); if(body) body.innerHTML = `<div class="empty">Couldn't load — needs the meta/insiderSchedule Firestore rule (see SETUP.md).</div>`; });
  state.unsubs.push(insightsUnsub);
}

async function submitCreateCoin(){
  const name = document.getElementById('cName').value.trim();
  const ticker = document.getElementById('cTicker').value.trim().toUpperCase();
  const desc = document.getElementById('cDesc').value.trim();
  if(name.length<2){ toast('Enter a coin name.', 'err'); return; }
  if(!/^[A-Z0-9]{2,8}$/.test(ticker)){ toast('Ticker must be 2-8 letters/numbers.', 'err'); return; }
  if(!state.userDoc){ toast("Still loading your account — try again in a second.", 'err'); return; }
  if((state.userDoc?.balance||0) < CREATE_FEE){ toast('Not enough balance to cover the launch fee.', 'err'); return; }
  const btn = document.getElementById('createSubmit');
  btn.disabled = true; btn.textContent = 'Launching…';
  try{
    const tickerRef = doc(db,'tickers',ticker);
    const tSnap = await getDoc(tickerRef);
    if(tSnap.exists()){ toast('That ticker is already taken.', 'err'); btn.disabled=false; btn.textContent='🚀 Launch Coin'; return; }

    const coinRef = doc(collection(db,'coins'));
    const imageURL = document.getElementById('cImgUrl').value.trim();
    const initPrice = INITIAL_SOL_RESERVE/INITIAL_TOKEN_RESERVE;
    await setDoc(coinRef, {
      name, ticker, description:desc, imageURL,
      creatorUid: state.uid, creatorUsername: state.userDoc.username, isBotCoin:false,
      solReserve: INITIAL_SOL_RESERVE, tokenReserve: INITIAL_TOKEN_RESERVE, totalSupply: INITIAL_TOKEN_RESERVE,
      price: initPrice, marketCap: initPrice*INITIAL_TOKEN_RESERVE,
      priceHistory: [{p:initPrice, t:Date.now()}], recentTrades: [], tradeCount:0,
      createdAt: serverTimestamp()
    });
    await setDoc(tickerRef, { coinId: coinRef.id });
    await updateDoc(doc(db,'users',state.uid), { balance: state.userDoc.balance - CREATE_FEE });
    toast(`$${ticker} is live!`, 'ok');
    navigate('coin', coinRef.id);
  }catch(err){ toast(err.message, 'err'); btn.disabled=false; btn.textContent='🚀 Launch Coin'; }
}

/* ===================== BANK (dedicated tab) ===================== */
function bankHistoryIcon(type){
  return type==='deposit'?'⬇️':type==='withdraw'?'⬆️':type==='sent'?'📤':type==='received'?'📥':type==='giveaway'?'🎉':'📈';
}
function bankHistoryLabel(h){
  if(h.type==='deposit') return `Deposited ${fmtUsd(h.amount)}`;
  if(h.type==='withdraw') return `Withdrew ${fmtUsd(h.amount)}`;
  if(h.type==='sent') return `Sent ${fmtUsd(h.amount)} to @${esc(h.counterparty||'?')}`;
  if(h.type==='received') return `Received ${fmtUsd(h.amount)} from @${esc(h.counterparty||'?')}`;
  if(h.type==='growth') return `Grew by ${fmtUsd(h.amount)} (${h.days} day${h.days===1?'':'s'})`;
  if(h.type==='giveaway') return `Funded a giveaway — ${fmtUsd(h.amount)} to ${h.winners} people`;
  return 'Bank activity';
}
function renderBank(){
  const view = document.getElementById('view');
  const u = state.userDoc||{};
  const bank = u.bank||{};
  const history = (bank.history||[]).slice().reverse();
  view.innerHTML = `
    <div class="section-title">🏦 Bank</div>
    <div class="pf-hero">
      <div class="lbl">Bank Balance</div>
      <div class="val mono" id="bankHeroBalance">${fmtUsd(bank.balance||0)}</div>
      <div class="pf-stats">
        <div class="pf-stat"><div class="n mono">${(BANK_DAILY_GROWTH_RATE*100).toFixed(0)}%</div><div class="l">Daily Growth</div></div>
        <div class="pf-stat"><div class="n mono">${fmtUsd(bank.totalInterestEarned||0)}</div><div class="l">Interest Earned</div></div>
        <div class="pf-stat"><div class="n mono">${bank.lastGrowthAt? timeAgo(bank.lastGrowthAt) : '—'}</div><div class="l">Last Grew</div></div>
      </div>
    </div>
    <div class="panel" style="margin-bottom:20px;">
      <div style="font-weight:700;margin-bottom:10px;">Deposit / Withdraw</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input class="field" id="bankDepositInput" style="flex:1;min-width:90px;" inputmode="decimal" placeholder="Amount">
        <button class="btn btn-lime" id="bankDepositBtn">Deposit</button>
        <button class="btn btn-ghost" id="bankWithdrawBtn">Withdraw</button>
      </div>
      <div class="quick-row" style="margin-top:8px;">
        <div class="quick-btn" data-bankpct=".25">25%</div>
        <div class="quick-btn" data-bankpct=".5">50%</div>
        <div class="quick-btn" data-bankpct=".75">75%</div>
        <div class="quick-btn" data-bankpct="1">All</div>
      </div>
      <div style="font-size:10.5px;color:var(--txt-faint);margin-top:6px;">% buttons fill the amount from your current cash balance — for withdrawing, just type an amount or use MAX-equivalent by checking your Bank balance above.</div>
      <div style="font-size:11px;color:var(--txt-faint);margin-top:10px;line-height:1.4;">Growth is applied in one lump sum whenever you sign back in (whole days elapsed since last time), not continuously — there's no server here to run it in the background.</div>
    </div>
    <div class="panel" style="margin-bottom:20px;">
      <div style="font-weight:700;margin-bottom:10px;">Send to another user</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input class="field" id="bankSendUser" style="flex:1;min-width:90px;" placeholder="username">
        <input class="field" id="bankSendAmount" style="width:90px;" inputmode="decimal" placeholder="$">
        <button class="btn btn-ghost" id="bankSendBtn">Send</button>
      </div>
      <div style="font-size:11px;color:var(--txt-faint);margin-top:10px;line-height:1.4;">Sends only actually arrive once the recipient's own account is signed in somewhere — nothing sensitive is exposed in the meantime, it just waits as a pending transfer.</div>
    </div>
    <div class="panel" style="margin-bottom:20px;">
      <div style="font-weight:700;margin-bottom:10px;">🎉 Fund a Giveaway</div>
      <div style="font-size:12.5px;color:var(--txt-dim);line-height:1.5;margin-bottom:10px;">Split a lump sum randomly between a handful of other active users — a public flex that actually benefits someone else, instead of the money just sitting there as a number.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input class="field" id="giveawayAmount" style="flex:1;min-width:90px;" inputmode="decimal" placeholder="Total amount">
        <input class="field" id="giveawayWinners" style="width:110px;" inputmode="numeric" placeholder="# winners" value="5">
        <button class="btn btn-lime" id="giveawayFundBtn">Fund it</button>
      </div>
      <div style="font-size:11px;color:var(--txt-faint);margin-top:10px;line-height:1.4;">Winners are drawn from real people who've actually traded recently — not a fully random pull — and the split isn't perfectly even on purpose. Announced publicly in the Activity feed once it goes out.</div>
    </div>
    <div class="section-title" style="font-size:16px;">Recent Activity</div>
    <div id="bankHistoryList">${history.length? history.map(h=>`
      <div class="holder-line">
        <span style="font-size:18px;">${bankHistoryIcon(h.type)}</span>
        <div class="hold-info">
          <div class="coin-ticker" style="font-size:13.5px;">${bankHistoryLabel(h)}</div>
          <div class="coin-name">${timeAgo(h.at)}</div>
        </div>
      </div>`).join('') : '<div class="empty" style="padding:16px;">No bank activity yet.</div>'}</div>
  `;
  document.getElementById('bankDepositBtn').addEventListener('click', ()=>{
    bankDeposit(parseFloat(document.getElementById('bankDepositInput').value));
  });
  document.getElementById('bankWithdrawBtn').addEventListener('click', ()=>{
    bankWithdraw(parseFloat(document.getElementById('bankDepositInput').value));
  });
  document.querySelectorAll('[data-bankpct]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const pct = parseFloat(btn.dataset.bankpct);
      document.getElementById('bankDepositInput').value = ((state.userDoc?.balance||0)*pct).toFixed(2);
    });
  });
  document.getElementById('bankSendBtn').addEventListener('click', ()=>{
    sendCashToUser(document.getElementById('bankSendUser').value, parseFloat(document.getElementById('bankSendAmount').value));
  });
  attachUserAutocomplete(document.getElementById('bankSendUser'));
  document.getElementById('giveawayFundBtn').addEventListener('click', ()=>{
    fundGiveaway(parseFloat(document.getElementById('giveawayAmount').value), parseInt(document.getElementById('giveawayWinners').value,10));
  });
}

/* ===================== PORTFOLIO ===================== */
async function renderPortfolio(){
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="section-title">Portfolio</div>
    <div class="pf-hero">
      <div class="lbl">Total Portfolio Value</div>
      <div class="val mono" id="pfTotal">—</div>
      <div class="pf-stats">
        <div class="pf-stat"><div class="n mono" id="pfCash">—</div><div class="l">Cash</div></div>
        <div class="pf-stat"><div class="n mono" id="pfHoldingsVal">—</div><div class="l">Holdings</div></div>
        <div class="pf-stat"><div class="n mono" id="pfCoinsCount">—</div><div class="l">Coins Held</div></div>
      </div>
    </div>
    <div class="panel" style="margin-bottom:20px;">
      <div style="font-weight:700;margin-bottom:10px;">Net Worth Over Time</div>
      <div class="chart-wrap" style="height:180px;"><canvas id="pfChart"></canvas></div>
    </div>
    <div class="panel" style="margin-bottom:20px;cursor:pointer;" id="bankSummaryCard">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-weight:700;">🏦 Bank</div>
          <div style="font-size:11.5px;color:var(--txt-faint);margin-top:2px;">Tap to deposit, withdraw, send money, and see stats</div>
        </div>
        <div class="mono" style="font-size:18px;font-weight:700;">${fmtUsd(state.userDoc?.bank?.balance||0)}</div>
      </div>
    </div>
    <div class="section-title" style="font-size:16px;">Your Holdings</div>
    <div id="holdingsList"><div class="spinner"></div></div>
  `;
  document.getElementById('bankSummaryCard').addEventListener('click', ()=> navigate('bank'));
  drawNetWorthChart('pfChart', state.userDoc?.netWorthHistory);
  const holdSnap = await getDocs(collection(db,'users',state.uid,'holdings'));
  const holdings = holdSnap.docs.map(d=>({id:d.id,...d.data()})).filter(h=>h.tokens>0.0001);
  await ensureCoinsCached(holdings.map(h=>h.id));
  let holdingsVal = 0;
  const rows = [];
  for(const h of holdings){
    const coin = state.coinsCache.get(h.id);
    if(!coin) continue;
    const price = priceOf(coin);
    const val = sellValue(coin, h.tokens);
    const costBasis = h.costBasis||0;
    const pnl = val-costBasis;
    holdingsVal += val;
    rows.push({h, coin, price, val, pnl});
  }
  if(state.route.name!=='portfolio') return; // navigated away while the above was loading
  const cash = state.userDoc?.balance||0;
  document.getElementById('pfTotal').textContent = fmtUsd(cash+holdingsVal);
  document.getElementById('pfCash').textContent = fmtUsd(cash);
  document.getElementById('pfHoldingsVal').textContent = fmtUsd(holdingsVal);
  document.getElementById('pfCoinsCount').textContent = rows.length;

  const list = document.getElementById('holdingsList');
  if(rows.length===0){ list.innerHTML = `<div class="empty"><div class="em-ic">📭</div>No holdings yet. Head to Explore and buy your first coin!</div>`; return; }
  const pinnedIds = state.userDoc?.pinnedCoins||[];
  rows.sort((a,b)=> (pinnedIds.includes(b.coin.id)?1:0)-(pinnedIds.includes(a.coin.id)?1:0));
  list.innerHTML = rows.map(r=>{
    const up = r.pnl>=0;
    const isPinned = pinnedIds.includes(r.coin.id);
    return `
    <div class="hold-row" data-coin="${r.coin.id}">
      <img class="coin-logo" src="${coinLogoFor(r.coin.ticker,r.coin.imageURL)}">
      <div class="hold-info">
        <div class="coin-ticker">${isPinned?'📌 ':''}$${esc(r.coin.ticker)}</div>
        <div class="coin-name">${fmtTok(r.h.tokens)} tokens</div>
      </div>
      <div class="hold-right">
        <div class="hold-val mono">${fmtUsd(r.val)}</div>
        <div class="mono" style="font-size:11.5px;color:${up?'var(--up)':'var(--down)'};">${up?'▲':'▼'} ${fmtUsd(Math.abs(r.pnl))}</div>
      </div>
      <button class="btn btn-ghost" data-pin-coin="${r.coin.id}" style="padding:6px 10px;font-size:11px;margin-left:8px;flex-shrink:0;">${isPinned?'Unpin':'📌 Pin'}</button>
    </div>`;}).join('');
  list.querySelectorAll('.hold-row').forEach(el=> el.addEventListener('click', ()=> navigate('coin', el.dataset.coin)));
  list.querySelectorAll('[data-pin-coin]').forEach(el=>{
    el.addEventListener('click', (e)=>{ e.stopPropagation(); togglePinCoin(el.dataset.pinCoin).then(()=> renderPortfolio()); });
  });
}

/* ===================== ACTIVITY FEED ===================== */
// Global feed of real trades (buys/sells) across every coin, newest first. Written to the
// top-level `activity` collection inside the same transaction as each real doBuy/doSell — bot
// trades aren't logged here, since this is specifically about what real people are doing.
let activityUnsub = null;
/* ===================== WHALE ALERTS (platform-wide) ===================== */
// Watches the global activity feed for anything at/above WHALE_THRESHOLD — real trades or bot
// whale trades alike (see writeWhaleActivity above) — and surfaces a clickable toast for
// EVERYONE currently online, not just whoever triggered the trade. Starts once at sign-in,
// independent of whatever page you're on.
let whaleAlertsReady = false;
// Default is ON (matches existing behavior) unless the user has explicitly turned it off.
function botNotificationsEnabled(){
  return state.userDoc?.notifPrefs?.botNotifications !== false;
}
async function toggleBotNotifications(){
  const current = botNotificationsEnabled();
  try{ await updateDoc(doc(db,'users',state.uid), { 'notifPrefs.botNotifications': !current }); }
  catch(err){ toast("Couldn't update: "+err.message, 'err'); }
}
// Full-screen "billionaire explosion" overlay — default is ON (matches existing behavior)
// unless the user has explicitly turned it off.
function billionaireAlertsEnabled(){
  return state.userDoc?.notifPrefs?.billionaireAlerts !== false;
}
async function toggleBillionaireAlerts(){
  const current = billionaireAlertsEnabled();
  try{ await updateDoc(doc(db,'users',state.uid), { 'notifPrefs.billionaireAlerts': !current }); }
  catch(err){ toast("Couldn't update: "+err.message, 'err'); }
}

function listenWhaleAlerts(){
  whaleAlertsReady = false;
  const q = query(collection(db,'activity'), orderBy('createdAt','desc'), limit(5));
  const un = onSnapshot(q, snap=>{
    if(!whaleAlertsReady){ whaleAlertsReady = true; return; } // skip the initial existing batch
    snap.docChanges().forEach(change=>{
      if(change.type!=='added') return;
      const t = change.doc.data();
      // Billionaire+ trades get a full-screen moment for everyone, real money moving at that
      // scale — shown regardless of the bot-notifications setting (that toggle is specifically
      // for ambient bot noise; this is real trades from real people), but suppressible on its
      // own via billionaireAlertsEnabled() for anyone who just doesn't want the screen takeover.
      if((t.type==='buy'||t.type==='sell') && t.netWorth>=1e9 && billionaireAlertsEnabled()) showBillionaireExplosion(t);
      if(!(t.usdAmount>=WHALE_THRESHOLD)) return;
      if(t.uid==='bot' && !botNotificationsEnabled()) return; // ambient bot noise, suppressible — real user whale alerts are unaffected
      const verb = t.type==='buy' ? 'dropped' : 'pulled';
      toast(`🐋 @${t.username} just ${verb} ${fmtUsd(t.usdAmount)} ${t.type==='buy'?'into':'out of'} $${t.ticker}!`, 'ok', ()=> navigate('coin', t.coinId));
    });
  }, ()=>{ /* silent — non-critical */ });
  state.unsubs.push(un);
}

// A dramatic full-screen moment, not just a toast — someone worth $1B+ just moved real money.
// Auto-dismisses after ~4.5s, or click anywhere to jump straight to the coin. Paired with the
// existing confetti burst for extra "explosion" feel.
function showBillionaireExplosion(t){
  const tier = wealthTierFor(t.netWorth) || { icon:'💎', label:'Billionaire' };
  const overlay = document.createElement('div');
  overlay.className = 'billionaire-explosion-overlay';
  overlay.innerHTML = `
    <div class="billionaire-explosion-content">
      <div class="billionaire-explosion-icon">${tier.icon}</div>
      <div class="billionaire-explosion-text">
        <b>@${esc(t.username)}</b> the <b>${tier.label}</b><br>
        just ${t.type==='buy'?'BOUGHT':'SOLD'} ${fmtUsd(t.usdAmount)} of $${esc(t.ticker)}!
      </div>
    </div>`;
  document.body.appendChild(overlay);
  confettiBurst();
  overlay.addEventListener('click', ()=>{ overlay.remove(); navigate('coin', t.coinId); });
  setTimeout(()=> overlay.remove(), 4500);
}

/* ===================== AUTO-SNIPE BOT ===================== */
const SNIPE_BOT_PRICE = 500; // one-time cost to unlock; pausing/resuming afterward is free
const SNIPE_CATEGORY_UPGRADE_PRICE = 1000;
const SNIPE_COPYTRADE_UPGRADE_PRICE = 2500;
// Watches for every newly-created coin — community launches AND Bot Market spawns alike — and
// auto-buys a fixed dollar amount into each one, for as long as the feature is toggled on. Real,
// structural limitation worth being upfront about: since there's no backend, this can only fire
// while YOUR OWN account is signed in on some open tab of yours — unlike the ambient bot system
// (which just needs *any* tab open), this needs specifically yours, because a buy has to run
// under your own authenticated session to touch your own balance and holdings. It does NOT
// retroactively buy coins launched before you turned it on — only ones launched from that point
// forward. Since Bot Market spawns happen more often than community launches, turning this on
// means noticeably more frequent snipe buys than before.
let snipeCursorMs = null;
const snipeAttempted = new Set(); // guards against double-sniping the same coin (listener + direct call racing)
function trySnipeBuy(coinId, c){
  if(snipeAttempted.has(coinId)) return;
  const snipe = state.userDoc?.snipeBot;
  if(!snipe?.active) return;
  // Now includes Bot Market spawns too, not just community launches.
  if(c.creatorUid===state.uid && !c.isBotCoin) return; // don't snipe your own community launch
  // Category amounts upgrade ($1k): guaranteed-growth coins (Right Ctrl/Insider) count as their
  // own category, distinct from ordinary bot coins, since they're a very different risk profile.
  const category = !c.isBotCoin ? 'community' : (c.guaranteedGrowth ? 'guaranteed' : 'bot');
  const amount = snipe.categoryUpgrade ? (snipe.amounts?.[category]||0) : (snipe.amountPerCoin||0);
  if(!(amount>0)) return;
  if((state.userDoc?.balance||0) < amount) return; // can't afford it right now — skip quietly
  snipeAttempted.add(coinId);
  doBuy(coinId, amount, true).then(result=>{
    if(!result){ snipeAttempted.delete(coinId); return; } // buy failed — allow retrying this coin
    toast(`🎯 Auto-snipe: bought ${fmtUsd(amount)} of $${esc(c.ticker)}`, 'ok', ()=> navigate('coin', coinId));
    logSnipeLedger(coinId, c.ticker, c.name, c.imageURL||'', amount);
  });
}

/* ===================== BANK ===================== */
const BANK_DAILY_GROWTH_RATE = 0.02; // 2%/day, compounding
// Same "catch-up" idea used elsewhere in this app (bot coins, snipe sweeps): there's no server
// to run a daily cron, so growth is computed as whole days elapsed since bank.lastGrowthAt,
// compounded in one shot, whenever you next sign in. Miss five days, get five days' growth at
// once — not more, not less, just applied late instead of continuously.
async function applyBankGrowth(){
  try{
    await runTransaction(db, async (tx)=>{
      const userRef = doc(db,'users',state.uid);
      const uSnap = await tx.get(userRef);
      if(!uSnap.exists()) return;
      const bank = uSnap.data().bank;
      const now = Date.now();
      if(!bank){ tx.update(userRef, { bank: { balance:0, lastGrowthAt: now, totalInterestEarned:0, history:[] } }); return; }
      const bal = bank.balance||0;
      const lastAt = toMillisLoose(bank.lastGrowthAt||now);
      const days = Math.floor((now-lastAt)/86400000);
      if(days<=0) return;
      if(bal<=0){ tx.update(userRef, { 'bank.lastGrowthAt': lastAt+days*86400000 }); return; }
      const grown = bal*Math.pow(1+BANK_DAILY_GROWTH_RATE, days);
      const interest = grown-bal;
      const history = (bank.history||[]).concat([{ type:'growth', amount:interest, days, at:now }]).slice(-20);
      tx.update(userRef, {
        'bank.balance': grown, 'bank.lastGrowthAt': lastAt+days*86400000,
        'bank.totalInterestEarned': (bank.totalInterestEarned||0)+interest,
        'bank.history': history
      });
    });
  }catch(err){ /* non-critical */ }
}
async function bankDeposit(amount){
  if(!(amount>0)){ toast('Enter an amount to deposit.', 'err'); return; }
  try{
    await runTransaction(db, async (tx)=>{
      const userRef = doc(db,'users',state.uid);
      const uSnap = await tx.get(userRef);
      const u = uSnap.data();
      if((u.balance||0) < amount) throw new Error("You don't have enough cash.");
      const history = (u.bank?.history||[]).concat([{type:'deposit', amount, at:Date.now()}]).slice(-20);
      tx.update(userRef, { balance: u.balance-amount, 'bank.balance': (u.bank?.balance||0)+amount, 'bank.lastGrowthAt': u.bank?.lastGrowthAt||Date.now(), 'bank.history': history });
    });
    toast(`🏦 Deposited ${fmtUsd(amount)}.`, 'ok');
  }catch(err){ toast(err.message, 'err'); }
}
async function bankWithdraw(amount){
  if(!(amount>0)){ toast('Enter an amount to withdraw.', 'err'); return; }
  try{
    await runTransaction(db, async (tx)=>{
      const userRef = doc(db,'users',state.uid);
      const uSnap = await tx.get(userRef);
      const u = uSnap.data();
      const bankBal = u.bank?.balance||0;
      if(bankBal < amount) throw new Error("Not enough in your bank balance.");
      const history = (u.bank?.history||[]).concat([{type:'withdraw', amount, at:Date.now()}]).slice(-20);
      tx.update(userRef, { balance: (u.balance||0)+amount, 'bank.balance': bankBal-amount, 'bank.history': history });
    });
    toast(`🏦 Withdrew ${fmtUsd(amount)} back to cash.`, 'ok');
  }catch(err){ toast(err.message, 'err'); }
}

/* ===================== PEER-TO-PEER TRANSFERS (bank sends + coin sends) ===================== */
// Security design worth being explicit about: Firestore rules only let you write your OWN
// balance/holdings (see isOwner() throughout). A naive "send money" feature would need to credit
// SOMEONE ELSE's balance directly, which would require relaxing that to "any signed-in user can
// write any other user's balance" — a real, serious hole (unlike the narrow, single-account
// admin relaxations elsewhere in this app). Instead: sending debits your OWN account and creates
// a `transfers` doc addressed to the recipient; the RECIPIENT's own client is the only thing that
// ever credits their account, when it notices a pending transfer meant for them. Every write is
// still always to your own doc — the transfers collection is just the coordination point.
// Consequence worth knowing: like the auto-snipe bot, this only actually lands once the
// recipient's own account is signed in on some tab of theirs — "even while they're offline"
// isn't literally achievable without a real backend. The very first snapshot this listener gets
// naturally includes anything that arrived while they were away (Firestore delivers existing
// matching docs as 'added' on initial sync), so it self-catches-up with no extra cursor logic.
function listenIncomingTransfers(){
  const q = query(collection(db,'transfers'), where('toUid','==',state.uid), where('status','==','pending'));
  const un = onSnapshot(q, snap=>{
    snap.docChanges().forEach(change=>{
      if(change.type!=='added') return;
      processIncomingTransfer(change.doc.id, change.doc.data());
    });
  }, ()=>{ /* silent — non-critical, e.g. missing index while Firestore builds one */ });
  state.unsubs.push(un);
}
async function processIncomingTransfer(transferId, t){
  try{
    await runTransaction(db, async (tx)=>{
      const transferRef = doc(db,'transfers',transferId);
      const tSnap = await tx.get(transferRef);
      if(!tSnap.exists() || tSnap.data().status!=='pending') return; // already claimed by another tab
      const userRef = doc(db,'users',state.uid);
      const uSnap = await tx.get(userRef);
      if(!uSnap.exists()) return;
      const u = uSnap.data();
      if(t.type==='cash'){
        const history = (u.bank?.history||[]).concat([{type:'received', amount:t.amount, counterparty:t.fromUsername, at:Date.now()}]).slice(-20);
        tx.update(userRef, { 'bank.balance': (u.bank?.balance||0) + t.amount, 'bank.history': history });
      } else if(t.type==='coin'){
        const holdRef = doc(db,'users',state.uid,'holdings',t.coinId);
        const hSnap = await tx.get(holdRef);
        const prevHold = hSnap.exists() ? hSnap.data() : {};
        // Gifted tokens are valued at their market price at send-time for cost-basis purposes —
        // not free, not zero — so receiving a gift can't manufacture profit or loss out of
        // nothing; your P&L on it starts fresh from whatever it was actually worth at that moment.
        tx.set(holdRef, {
          tokens: (prevHold.tokens||0) + t.tokens,
          ticker: t.ticker, name: t.name||t.ticker, imageURL: t.imageURL||'',
          coinId: t.coinId, username: state.userDoc?.username||'', avatarURL: state.userDoc?.avatarURL||'',
          costBasis: (prevHold.costBasis||0) + (t.valueAtSend||0),
          totalBoughtUsd: prevHold.totalBoughtUsd||0, totalSoldUsd: prevHold.totalSoldUsd||0, realizedPnl: prevHold.realizedPnl||0,
          firstBuyAt: (prevHold.tokens>0.0001) ? (prevHold.firstBuyAt||Date.now()) : Date.now(),
          updatedAt: Date.now()
        }, {merge:true});
      }
      tx.update(transferRef, { status:'completed' });
    });
    if(t.isGiveaway) showGiveawayWinOverlay(t);
    else if(t.type==='cash') toast(`💸 @${t.fromUsername} sent you ${fmtUsd(t.amount)}!`, 'ok', ()=> navigate('portfolio'));
    else toast(`🎁 @${t.fromUsername} sent you ${fmtTok(t.tokens)} $${t.ticker}!`, 'ok', ()=> navigate('coin', t.coinId));
  }catch(err){ /* silent — will just get picked up again next time this listener re-evaluates */ }
}

// A proper celebratory moment for a giveaway winner — not just the generic "sent you money" toast
// every other transfer gets. Reuses the same full-screen overlay pattern as the billionaire
// explosion, plus confetti, since "you just won free money" deserves more than a small toast.
function showGiveawayWinOverlay(t){
  const overlay = document.createElement('div');
  overlay.className = 'billionaire-explosion-overlay';
  overlay.innerHTML = `
    <div class="billionaire-explosion-content">
      <div class="billionaire-explosion-icon">🎉</div>
      <div class="billionaire-explosion-text">You won <b>${fmtUsd(t.amount)}</b>!<br>@${esc(t.fromUsername)} just funded a giveaway and you were picked.</div>
    </div>`;
  document.body.appendChild(overlay);
  confettiBurst();
  overlay.addEventListener('click', ()=>{ overlay.remove(); navigate('bank'); });
  setTimeout(()=> overlay.remove(), 5000);
}

async function sendCashToUser(rawUsername, amount){
  if(!(amount>0)){ toast('Enter an amount to send.', 'err'); return; }
  const toUsername = rawUsername.trim().replace(/^@/,'');
  const toLower = toUsername.toLowerCase();
  if(toLower === (state.userDoc?.username||'').toLowerCase()){ toast("You can't send money to yourself.", 'err'); return; }
  try{
    const unameSnap = await getDoc(doc(db,'usernames',toLower));
    if(!unameSnap.exists()){ toast('No user found with that username.', 'err'); return; }
    const toUid = unameSnap.data().uid;
    await runTransaction(db, async (tx)=>{
      const userRef = doc(db,'users',state.uid);
      const uSnap = await tx.get(userRef);
      if(!uSnap.exists()) throw new Error('Account not found.');
      const u = uSnap.data();
      const bankBal = u.bank?.balance||0;
      if(bankBal < amount) throw new Error("Not enough in your bank balance.");
      const history = (u.bank?.history||[]).concat([{type:'sent', amount, counterparty:toUsername, at:Date.now()}]).slice(-20);
      tx.update(userRef, { 'bank.balance': bankBal-amount, 'bank.history': history, totalGivenUsd: (u.totalGivenUsd||0)+amount });
      const transferRef = doc(collection(db,'transfers'));
      tx.set(transferRef, {
        fromUid: state.uid, fromUsername: state.userDoc.username,
        toUid, toUsername,
        type:'cash', amount, status:'pending', createdAt: serverTimestamp()
      });
    });
    toast(`💸 Sent ${fmtUsd(amount)} to @${toUsername}!`, 'ok');
  }catch(err){ toast(err.message, 'err'); }
}

// Reuses the exact same transfer system as a normal send — the funder debits their own bank
// balance and creates one transfer doc per winner (still addressed correctly, still only ever
// crediting each winner's own account via their own client, same as a regular send). Winners are
// drawn from real names in the last 100 activity entries (excluding bots and the funder), so it's
// biased toward people who've actually been active recently rather than a fully random uid pull.
// Split isn't perfectly even on purpose — a little randomness makes "who got what" more fun to
// find out.
async function fundGiveaway(amount, winnerCount){
  if(!(amount>0)){ toast('Enter an amount to fund.', 'err'); return; }
  if(!(winnerCount>=1)){ toast('Pick at least 1 winner.', 'err'); return; }
  try{
    const actSnap = await getDocs(query(collection(db,'activity'), orderBy('createdAt','desc'), limit(100)));
    const seen = new Map();
    actSnap.docs.forEach(d=>{
      const t = d.data();
      if(t.uid && t.uid!=='bot' && t.uid!==state.uid && !seen.has(t.uid)) seen.set(t.uid, t.username);
    });
    const candidates = [...seen.entries()].map(([uid,username])=>({uid,username}));
    if(!candidates.length){ toast('No other active users found to give to yet.', 'err'); return; }
    const winners = candidates.sort(()=>Math.random()-0.5).slice(0, Math.min(winnerCount, candidates.length));
    const weights = winners.map(()=> 0.3+Math.random());
    const totalWeight = weights.reduce((a,b)=>a+b,0);
    const shares = weights.map(w=> Math.round((w/totalWeight)*amount*100)/100);
    const shareSum = shares.reduce((a,b)=>a+b,0);
    shares[shares.length-1] = Math.max(0.01, shares[shares.length-1] + Math.round((amount-shareSum)*100)/100);

    await runTransaction(db, async (tx)=>{
      const userRef = doc(db,'users',state.uid);
      const uSnap = await tx.get(userRef);
      if(!uSnap.exists()) throw new Error('Account not found.');
      const u = uSnap.data();
      const bankBal = u.bank?.balance||0;
      if(bankBal < amount) throw new Error("Not enough in your bank balance.");
      const history = (u.bank?.history||[]).concat([{type:'giveaway', amount, winners:winners.length, at:Date.now()}]).slice(-20);
      tx.update(userRef, { 'bank.balance': bankBal-amount, 'bank.history': history, totalGivenUsd: (u.totalGivenUsd||0)+amount });
      winners.forEach((w,i)=>{
        const transferRef = doc(collection(db,'transfers'));
        tx.set(transferRef, {
          fromUid: state.uid, fromUsername: state.userDoc.username,
          toUid: w.uid, toUsername: w.username,
          type:'cash', amount: shares[i], status:'pending', createdAt: serverTimestamp(), isGiveaway:true
        });
      });
      const annRef = doc(collection(db,'activity'));
      tx.set(annRef, {
        uid: state.uid, username: state.userDoc.username, avatarURL: state.userDoc.avatarURL||'',
        netWorth: state.userDoc.netWorth||0, type:'giveaway', usdAmount: amount, winnerCount: winners.length,
        winnerUsernames: winners.map(w=>w.username),
        createdAt: serverTimestamp()
      });
    });
    toast(`🎉 Giveaway funded! ${fmtUsd(amount)} split between ${winners.length} people.`, 'ok');
  }catch(err){ toast(err.message, 'err'); }
}

async function sendCoinToUser(rawUsername, coinId, tokens){
  if(!(tokens>0)){ toast('Enter an amount to send.', 'err'); return; }
  const toUsername = rawUsername.trim().replace(/^@/,'');
  const toLower = toUsername.toLowerCase();
  if(toLower === (state.userDoc?.username||'').toLowerCase()){ toast("You can't send a coin to yourself.", 'err'); return; }
  try{
    const unameSnap = await getDoc(doc(db,'usernames',toLower));
    if(!unameSnap.exists()){ toast('No user found with that username.', 'err'); return; }
    const toUid = unameSnap.data().uid;
    await runTransaction(db, async (tx)=>{
      const holdRef = doc(db,'users',state.uid,'holdings',coinId);
      const userRef = doc(db,'users',state.uid);
      const [hSnap, uSnap] = await Promise.all([tx.get(holdRef), tx.get(userRef)]);
      if(!hSnap.exists()) throw new Error("You don't hold any of this coin.");
      const h = hSnap.data();
      if(tokens > h.tokens){
        if(tokens - h.tokens <= h.tokens*0.0001 + 0.0001) tokens = h.tokens; // tiny float rounding from the MAX button — clamp instead of reject
        else throw new Error("You don't have that many tokens.");
      }
      const coinSnap = await tx.get(doc(db,'coins',coinId));
      const coin = coinSnap.exists() ? coinSnap.data() : null;
      const valueAtSend = coin ? sellValue(coin, tokens) : 0;
      const avgCost = h.tokens>0 ? (h.costBasis||0)/h.tokens : 0;
      const costRemoved = Math.min(h.costBasis||0, avgCost*tokens);
      tx.set(holdRef, { tokens: h.tokens-tokens, costBasis: Math.max(0,(h.costBasis||0)-costRemoved) }, {merge:true});
      if(uSnap.exists()) tx.update(userRef, { totalGivenUsd: (uSnap.data().totalGivenUsd||0)+valueAtSend });
      const transferRef = doc(collection(db,'transfers'));
      tx.set(transferRef, {
        fromUid: state.uid, fromUsername: state.userDoc.username,
        toUid, toUsername,
        type:'coin', coinId, ticker: h.ticker, name: h.name, imageURL: h.imageURL||'',
        tokens, valueAtSend, status:'pending', createdAt: serverTimestamp()
      });
    });
    toast(`🎁 Sent ${fmtTok(tokens)} tokens to @${toUsername}!`, 'ok');
  }catch(err){ toast(err.message, 'err'); }
}

function listenAutoSnipe(){
  snipeCursorMs = Date.now(); // only react to coins created after this instant
  catchUpSnipeMisses(); // separately sweep anything created while you were fully offline
  // limit(150) is just a safety cap on the query itself, not the "how many can I catch" window —
  // the actual new-vs-already-existed decision is the createdAt-vs-cursor check below, which
  // works correctly no matter how many coins arrive in one snapshot batch or how Firestore
  // chunks delivery. The old approach (a tiny limit(5) + treat every 'added' as new) missed
  // coins whenever more than a handful were created close together — e.g. the 5-coin bootstrap
  // spawn, or a few Right Ctrl presses in a row — since Firestore doesn't guarantee one event
  // per document in that scenario. 150 leaves a very large margin against ever overflowing given
  // how bounded bot-coin spawn rates are now (5-60 min ambient, up to 3/day insider, plus manual
  // admin triggers) alongside real community launches.
  const q = query(collection(db,'coins'), orderBy('createdAt','desc'), limit(150));
  const un = onSnapshot(q, snap=>{
    snap.docChanges().forEach(change=>{
      if(change.type!=='added') return;
      const c = change.doc.data();
      const createdMs = toMillisLoose(c.createdAt);
      if(createdMs <= snipeCursorMs) return; // existed before we started watching — not new
      trySnipeBuy(change.doc.id, c);
    });
  }, ()=>{ /* silent — non-critical */ });
  state.unsubs.push(un);
}

// One-time sweep run at the start of each session: catches any coin created between your last
// session and this one — i.e. while you were fully signed out everywhere, not just a brief
// disconnect (the live listener above already handles reconnects fine on its own). Without this,
// "snipe every new coin, no matter what" wasn't really true — anything launched while you had
// zero tabs open anywhere would've been missed forever, since nothing was watching.
async function catchUpSnipeMisses(){
  try{
    await waitForUserDoc(); // listenAutoSnipe fires right after listenUserDoc, with no guarantee
                            // the first snapshot has landed yet — trySnipeBuy relies on
                            // state.userDoc being real, so this has to actually wait for it.
    const snipe = state.userDoc?.snipeBot;
    if(!snipe?.owned) return; // never bought the feature — nothing to track or sweep
    if(snipe.active && snipe.lastCheckedAt){
      const cutoff = Timestamp.fromMillis(toMillisLoose(snipe.lastCheckedAt));
      const snap = await getDocs(query(collection(db,'coins'), where('createdAt','>',cutoff), orderBy('createdAt','asc'), limit(200)));
      snap.docs.forEach(d=> trySnipeBuy(d.id, d.data()));
    }
    await updateDoc(doc(db,'users',state.uid), { 'snipeBot.lastCheckedAt': Date.now() });
  }catch(err){ /* non-critical — e.g. missing index while Firestore builds one */ }
}
function waitForUserDoc(timeoutMs=5000){
  return new Promise(resolve=>{
    if(state.userDoc) return resolve();
    const start = Date.now();
    const iv = setInterval(()=>{
      if(state.userDoc || Date.now()-start>timeoutMs){ clearInterval(iv); resolve(); }
    }, 100);
  });
}

// Keeps a lightweight record of snipe activity (total spent + last 30 coins sniped into) on the
// user doc, purely for the stats menu on the profile page — not used for any trading logic.
// Read-modify-write against state.userDoc rather than a transaction; a rare race between two
// snipe buys landing in the same instant would at worst drop one ledger entry, not corrupt
// anything real (balance/holdings are handled properly inside doBuy's own transaction).
async function logSnipeLedger(coinId, ticker, name, imageURL, amount){
  try{
    const snipe = state.userDoc?.snipeBot || {};
    const list = (snipe.snipedCoins||[]).concat([{ coinId, ticker, name, imageURL, amount, at:Date.now() }]).slice(-30);
    await updateDoc(doc(db,'users',state.uid), {
      'snipeBot.totalSpent': (snipe.totalSpent||0) + amount,
      'snipeBot.snipedCoins': list
    });
  }catch(err){ /* non-critical */ }
}

// Shows total spent, count sniped, and — since a sniped coin's holding can also get topped up
// or partly sold manually afterward — an approximate live picture rather than a perfectly
// decomposed ledger: current realizable value of whatever you still hold in every coin you've
// ever sniped into, versus total spent via snipe. If you've also traded those same coins by
// hand, this blends both; it's described that way in the modal rather than pretending otherwise.
// Renders the "Currently Holding" list inside the snipe stats modal, each row with a quick-sell
// button that sells the entire position right from the modal — no need to navigate to the
// coin's own page first just to dump a bag you sniped into.
function renderSnipeHeldList(held, overlay){
  const listEl = overlay.querySelector('#snipeHeldList');
  if(!listEl) return;
  if(!held.length){ listEl.innerHTML = '<div class="empty" style="padding:16px;">Not currently holding any sniped coins.</div>'; return; }
  listEl.innerHTML = held.map(h=>{
    const up = h.pnl>=0;
    return `
    <div class="holder-line" data-row-coin="${h.coinId}">
      <img class="coin-logo" src="${coinLogoFor(h.ticker, h.imageURL)}">
      <div class="hold-info">
        <div class="coin-ticker">$${esc(h.ticker)}</div>
        <div class="coin-name">${fmtTok(h.tokens)} · ${fmtUsd(h.val)} <span style="color:${up?'var(--up)':'var(--down)'};">${up?'▲':'▼'} ${fmtUsd(Math.abs(h.pnl))}</span></div>
      </div>
      <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px;" data-sell-coin="${h.coinId}" data-sell-tokens="${h.tokens}">Sell</button>
    </div>`;
  }).join('');
  listEl.querySelectorAll('[data-sell-coin]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const coinId = btn.dataset.sellCoin;
      const tokens = parseFloat(btn.dataset.sellTokens);
      btn.disabled = true; btn.textContent = 'Selling…';
      const result = await doSell(coinId, tokens);
      if(result){
        const row = listEl.querySelector(`[data-row-coin="${coinId}"]`);
        row?.remove();
        if(!listEl.querySelector('[data-row-coin]')) listEl.innerHTML = '<div class="empty" style="padding:16px;">Not currently holding any sniped coins.</div>';
      } else {
        btn.disabled = false; btn.textContent = 'Sell';
      }
    });
  });
}

async function openSnipeStatsModal(){
  const snipe = state.userDoc?.snipeBot || {};
  const list = (snipe.snipedCoins||[]).slice().reverse(); // newest first
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>🎯 Auto-Snipe Stats</h3>
      <div style="display:flex;gap:20px;margin:14px 0;flex-wrap:wrap;">
        <div><div style="font-size:11px;color:var(--txt-faint);">TOTAL SPENT</div><div class="mono" style="font-size:18px;font-weight:700;">${fmtUsd(snipe.totalSpent||0)}</div></div>
        <div><div style="font-size:11px;color:var(--txt-faint);">COINS SNIPED</div><div class="mono" style="font-size:18px;font-weight:700;">${list.length}</div></div>
        <div><div style="font-size:11px;color:var(--txt-faint);">CURRENT VALUE</div><div class="mono" style="font-size:18px;font-weight:700;" id="snipeCurValue">—</div></div>
        <div><div style="font-size:11px;color:var(--txt-faint);">REALIZED P&L (SOLD)</div><div class="mono" style="font-size:18px;font-weight:700;" id="snipeRealizedPnl">—</div></div>
      </div>
      <div style="font-size:11px;color:var(--txt-faint);line-height:1.4;margin-bottom:10px;">Current value only counts coins you still hold from the list below. Realized P&L sums every past sell tagged as coming from a sniped position. Since a sniped coin's position can also get topped up or sold by hand, both numbers blend snipe and manual activity on the same coin rather than isolating just the snipe portion.</div>
      <div style="font-weight:700;font-size:13px;margin:14px 0 8px;">Currently Holding</div>
      <div id="snipeHeldList" style="max-height:220px;overflow-y:auto;margin-bottom:14px;"><div class="spinner" style="margin:10px 0;"></div></div>
      <div style="font-weight:700;font-size:13px;margin:14px 0 8px;">Recently Sniped</div>
      <div id="snipeCoinList" style="max-height:220px;overflow-y:auto;">${list.length? list.map(s=>`
        <div class="holder-line" data-coin="${s.coinId}" style="cursor:pointer;">
          <img class="coin-logo" src="${coinLogoFor(s.ticker, s.imageURL)}">
          <div class="hold-info">
            <div class="coin-ticker">$${esc(s.ticker)}</div>
            <div class="coin-name">Sniped ${fmtUsd(s.amount)} · ${timeAgo(s.at)}</div>
          </div>
        </div>`).join('') : '<div class="empty" style="padding:16px;">No snipes yet.</div>'}</div>
      <button class="btn btn-ghost btn-block" style="margin-top:16px;" id="snipeStatsCloseBtn">Close</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e=>{ if(e.target===overlay) overlay.remove(); });
  document.getElementById('snipeStatsCloseBtn').addEventListener('click', ()=> overlay.remove());
  overlay.querySelectorAll('[data-coin]').forEach(el=> el.addEventListener('click', ()=>{ overlay.remove(); navigate('coin', el.dataset.coin); }));

  // Live current-value tally, computed after the modal is already showing (avoids blocking the
  // open on a batch of reads) — sums realizable value across every distinct coin ever sniped,
  // for whatever amount of it you currently still hold. Also builds the Currently Holding list
  // with a quick-sell button per coin, so a sniped bag can be dumped right from this modal
  // without navigating to the coin's own page first.
  try{
    const uniqueCoinIds = [...new Set(list.map(s=>s.coinId))];
    const uniqueSet = new Set(uniqueCoinIds);
    const holdSnap = await getDocs(collection(db,'users',state.uid,'holdings'));
    const holdings = holdSnap.docs
      .filter(d=> uniqueSet.has(d.id))
      .map(d=>({id:d.id,...d.data()}))
      .filter(h=>h.tokens>0.0001);
    await ensureCoinsCached(holdings.map(h=>h.id));
    let total = 0;
    const held = [];
    for(const h of holdings){
      const coin = state.coinsCache.get(h.id);
      if(!coin) continue;
      const val = sellValue(coin, h.tokens);
      total += val;
      held.push({ coinId: h.id, ticker: h.ticker, imageURL: h.imageURL, tokens: h.tokens, val, pnl: val-(h.costBasis||0) });
    }
    const el = document.getElementById('snipeCurValue');
    if(el) el.textContent = fmtUsd(total);
    renderSnipeHeldList(held, overlay);
  }catch(err){
    const el = document.getElementById('snipeCurValue'); if(el) el.textContent = '—';
    const heldEl = document.getElementById('snipeHeldList'); if(heldEl) heldEl.innerHTML = `<div class="empty" style="padding:16px;">Couldn't load holdings.</div>`;
  }

  try{
    const closedSnap = await getDocs(collection(db,'users',state.uid,'closedPositions'));
    const realizedPnl = closedSnap.docs
      .map(d=>d.data())
      .filter(c=>c.viaSnipe)
      .reduce((sum,c)=> sum+(c.pnl||0), 0);
    const el = document.getElementById('snipeRealizedPnl');
    if(el){
      const up = realizedPnl>=0;
      el.style.color = up? 'var(--up)':'var(--down)';
      el.textContent = `${up?'▲':'▼'} ${fmtUsd(Math.abs(realizedPnl))}`;
    }
  }catch(err){ const el = document.getElementById('snipeRealizedPnl'); if(el) el.textContent = '—'; }
}

/* ===================== SNIPE BOT UPGRADES ===================== */
async function purchaseSnipeCategoryUpgrade(){
  if(!state.userDoc?.snipeBot?.owned){ toast('Unlock the base auto-snipe bot first.', 'err'); return; }
  const bal = state.userDoc?.balance||0;
  if(bal < SNIPE_CATEGORY_UPGRADE_PRICE){ toast(`Need ${fmtUsd(SNIPE_CATEGORY_UPGRADE_PRICE)} to unlock this upgrade.`, 'err'); return; }
  try{
    const amt = state.userDoc.snipeBot.amountPerCoin||10;
    await updateDoc(doc(db,'users',state.uid), {
      balance: bal-SNIPE_CATEGORY_UPGRADE_PRICE,
      'snipeBot.categoryUpgrade': true,
      'snipeBot.amounts': { community:amt, bot:amt, guaranteed:amt }
    });
    toast('🎯 Category amounts unlocked!', 'ok');
  }catch(err){ toast('Purchase failed: '+err.message, 'err'); }
}
async function updateSnipeCategoryAmount(category, amount){
  if(!(amount>0)){ toast('Enter an amount greater than $0.', 'err'); return; }
  try{ await updateDoc(doc(db,'users',state.uid), { [`snipeBot.amounts.${category}`]: amount }); toast('Updated.', 'ok'); }
  catch(err){ toast("Couldn't update: "+err.message, 'err'); }
}

async function purchaseCopyTradeUpgrade(){
  if(!state.userDoc?.snipeBot?.owned){ toast('Unlock the base auto-snipe bot first.', 'err'); return; }
  const bal = state.userDoc?.balance||0;
  if(bal < SNIPE_COPYTRADE_UPGRADE_PRICE){ toast(`Need ${fmtUsd(SNIPE_COPYTRADE_UPGRADE_PRICE)} to unlock this upgrade.`, 'err'); return; }
  try{
    await updateDoc(doc(db,'users',state.uid), {
      balance: bal-SNIPE_COPYTRADE_UPGRADE_PRICE,
      'snipeBot.copyTrade': { owned:true, active:true, targets:[] }
    });
    toast('🪞 Copy Trade unlocked!', 'ok');
  }catch(err){ toast('Purchase failed: '+err.message, 'err'); }
}
async function toggleCopyTrade(){
  const ct = state.userDoc?.snipeBot?.copyTrade;
  if(!ct?.owned) return;
  try{ await updateDoc(doc(db,'users',state.uid), { 'snipeBot.copyTrade.active': !ct.active }); }
  catch(err){ toast("Couldn't update: "+err.message, 'err'); }
}
async function addCopyTarget(rawUsername, amount){
  if(!(amount>0)){ toast('Enter an amount greater than $0.', 'err'); return; }
  const uname = rawUsername.trim().replace(/^@/,'');
  const lower = uname.toLowerCase();
  if(lower === (state.userDoc?.username||'').toLowerCase()){ toast("You can't copy yourself.", 'err'); return; }
  try{
    const unameSnap = await getDoc(doc(db,'usernames',lower));
    if(!unameSnap.exists()){ toast('No user found with that username.', 'err'); return; }
    const targetUid = unameSnap.data().uid;
    const ct = state.userDoc?.snipeBot?.copyTrade || {owned:true, active:true, targets:[]};
    const targets = ct.targets||[];
    if(targets.some(t=>t.uid===targetUid)){ toast('Already copying that user.', 'err'); return; }
    if(targets.length>=5){ toast('You can copy up to 5 users.', 'err'); return; }
    await updateDoc(doc(db,'users',state.uid), { 'snipeBot.copyTrade.targets': [...targets, {uid:targetUid, username:uname, amount}] });
    // Register as a follower on the TARGET's own follower list — a doc keyed by our own uid, so
    // this is still just "write your own doc" even though it lives under someone else's path.
    // This is what lets the target's client find us and push orders our way the instant they
    // trade, without needing to grant them any write access to our account.
    await setDoc(doc(db,'copyFollowers',targetUid,'followers',state.uid), {
      copierUid: state.uid, copierUsername: state.userDoc.username, amount
    });
    toast(`Now copying @${uname}'s trades.`, 'ok');
  }catch(err){ toast(err.message, 'err'); }
}
async function removeCopyTarget(targetUid){
  const ct = state.userDoc?.snipeBot?.copyTrade;
  if(!ct) return;
  try{
    await updateDoc(doc(db,'users',state.uid), { 'snipeBot.copyTrade.targets': (ct.targets||[]).filter(t=>t.uid!==targetUid) });
    await deleteDoc(doc(db,'copyFollowers',targetUid,'followers',state.uid)).catch(()=>{});
  }catch(err){ toast("Couldn't update: "+err.message, 'err'); }
}

// Copy Trade, push-based design: rather than the COPIER's own tab watching the global activity
// feed for trades to mirror (which only works while their tab happens to be open around the
// same time), the TARGET's own client — which is guaranteed to be online right at that instant,
// since it's mid-trade — looks up its own followers and immediately queues a `copyOrders` doc
// for each one. This means the decision to copy a trade is captured reliably in real time by
// whoever is definitely online (the target), regardless of whether any of their followers are
// around at that moment. The follower's own client then processes its queue whenever it's next
// online — same "must be signed in somewhere to actually spend your own money" boundary as
// everything else here (that part genuinely can't be worked around without a real backend), but
// the ORDER itself is never missed or dependent on both people being online at the same time.
async function pushCopyOrdersForTrade(coinId, ticker, name, imageURL, type){
  try{
    const followersSnap = await getDocs(collection(db,'copyFollowers',state.uid,'followers'));
    if(followersSnap.empty) return;
    let batch = writeBatch(db);
    followersSnap.docs.forEach(f=>{
      const follower = f.data();
      const orderRef = doc(collection(db,'copyOrders'));
      batch.set(orderRef, {
        copierUid: follower.copierUid, copierUsername: follower.copierUsername, amount: follower.amount||0,
        targetUid: state.uid, targetUsername: state.userDoc?.username||'',
        coinId, ticker, name: name||ticker, imageURL: imageURL||'',
        type, status:'pending', createdAt: serverTimestamp()
      });
    });
    await batch.commit();
  }catch(err){ /* non-critical — a missed push just means that one copy doesn't happen */ }
}

// Copier-side: watches for orders queued by whoever they're following. The very first snapshot
// naturally includes anything queued while this account was offline (Firestore delivers existing
// matching docs as 'added' on initial sync), so it self-catches-up with no separate cursor logic.
function listenCopyOrders(){
  const q = query(collection(db,'copyOrders'), where('copierUid','==',state.uid), where('status','==','pending'));
  const un = onSnapshot(q, snap=>{
    snap.docChanges().forEach(change=>{
      if(change.type!=='added') return;
      processCopyOrder(change.doc.id, change.doc.data());
    });
  }, ()=>{ /* silent — non-critical, e.g. missing index while Firestore builds one */ });
  state.unsubs.push(un);
}
async function processCopyOrder(orderId, o){
  const ct = state.userDoc?.snipeBot?.copyTrade;
  if(!ct?.active) return; // paused — leave the order pending in case they resume later
  try{
    let result = null;
    if(o.type==='buy'){
      if((state.userDoc?.balance||0) < o.amount) return; // can't afford it right now — try again next time this re-evaluates
      result = await doBuy(o.coinId, o.amount, true);
    } else {
      const hSnap = await getDoc(doc(db,'users',state.uid,'holdings',o.coinId));
      if(!hSnap.exists() || !(hSnap.data().tokens>0.0001)) result = {}; // nothing to sell — treat as handled, not an error
      else result = await doSell(o.coinId, hSnap.data().tokens);
    }
    if(!result) return; // trade failed — leave pending, will retry on next snapshot re-evaluation
    await updateDoc(doc(db,'copyOrders',orderId), { status:'completed' });
    if(o.type==='buy') toast(`🪞 Copied @${o.targetUsername}'s buy — ${fmtUsd(o.amount)} into $${o.ticker}`, 'ok', ()=> navigate('coin', o.coinId));
    else toast(`🪞 Copied @${o.targetUsername}'s sell of $${o.ticker}`, 'ok');
  }catch(err){ /* non-critical */ }
}

async function purchaseSnipeBot(){
  const bal = state.userDoc?.balance||0;
  if(bal < SNIPE_BOT_PRICE){ toast(`Need ${fmtUsd(SNIPE_BOT_PRICE)} to unlock the auto-snipe bot.`, 'err'); return; }
  try{
    await updateDoc(doc(db,'users',state.uid), {
      balance: bal - SNIPE_BOT_PRICE,
      snipeBot: { owned:true, active:true, amountPerCoin:10 }
    });
    toast('🎯 Auto-snipe bot unlocked and active!', 'ok');
  }catch(err){ toast('Purchase failed: '+err.message, 'err'); }
}
async function toggleSnipeBot(){
  const snipe = state.userDoc?.snipeBot;
  if(!snipe?.owned) return;
  try{ await updateDoc(doc(db,'users',state.uid), { 'snipeBot.active': !snipe.active }); }
  catch(err){ toast('Couldn\'t update: '+err.message, 'err'); }
}
async function updateSnipeAmount(newAmount){
  if(!(newAmount>0)){ toast('Enter an amount greater than $0.', 'err'); return; }
  try{ await updateDoc(doc(db,'users',state.uid), { 'snipeBot.amountPerCoin': newAmount }); toast('Snipe amount updated.', 'ok'); }
  catch(err){ toast('Couldn\'t update: '+err.message, 'err'); }
}

function renderActivity(){
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="section-title">🕒 Recent Activity</div>
    <div id="activityList"><div class="spinner" style="margin-top:40px;"></div></div>
  `;
  loadActivity();
}
function loadActivity(){
  if(activityUnsub) activityUnsub();
  const list = document.getElementById('activityList');
  // Fetch a bit more than we show — bot whale trades also live in this collection now (to power
  // the whale alert listener) but shouldn't appear in the feed itself, which is specifically
  // about real people. Filtering client-side and over-fetching a little compensates for however
  // many of the most recent 50 get filtered out.
  const q = query(collection(db,'activity'), orderBy('createdAt','desc'), limit(80));
  activityUnsub = onSnapshot(q, snap=>{
    if(!list) return;
    const items = snap.docs.map(d=>({id:d.id,...d.data()})).filter(t=>!t.isBot).slice(0,50);
    if(!items.length){ list.innerHTML = `<div class="empty"><div class="em-ic">🕒</div>No trades yet — activity will show up here as people buy and sell.</div>`; return; }
    list.innerHTML = items.map(t=> t.type==='giveaway' ? `
      <div class="holder-line" style="flex-wrap:wrap;">
        <div class="user-link" data-uid="${t.uid||''}" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <img class="avatar-sm" src="${avatarFor(t.username, t.avatarURL)}" style="border-radius:50%;">
          <span>@${esc(t.username)}${wealthBadgeHtml(t.netWorth||0)}</span>
        </div>
        <span class="coin-chg up" style="padding:2px 7px;">🎉 Funded a giveaway</span>
        <span class="amt mono">${fmtUsd(t.usdAmount)}</span>
        <span style="font-size:11px;color:var(--txt-faint);margin-left:8px;">${timeAgo(t.createdAt)}</span>
        ${(t.winnerUsernames||[]).length ? `<div style="width:100%;font-size:11.5px;color:var(--txt-dim);margin-top:6px;padding-left:34px;">🏆 Went to: ${t.winnerUsernames.map(w=>'@'+esc(w)).join(', ')}</div>` : ''}
      </div>` : `
      <div class="holder-line">
        <div class="user-link" data-uid="${t.uid||''}" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <img class="avatar-sm" src="${avatarFor(t.username, t.avatarURL)}" style="border-radius:50%;">
          <span>@${esc(t.username)}${wealthBadgeHtml(t.netWorth||0)}${t.viaSnipe?'\'s 🎯 snipe bot':''}</span>
        </div>
        <span class="${t.type==='buy'?'coin-chg up':'coin-chg down'}" style="padding:2px 7px;">${t.type==='buy'?'Bought':'Sold'}</span>
        <span class="coin-tag" data-coin="${t.coinId||''}" style="cursor:pointer;font-weight:600;">$${esc(t.ticker)}</span>
        <span class="amt mono">${fmtUsd(t.usdAmount)}</span>
        <span style="font-size:11px;color:var(--txt-faint);margin-left:8px;">${timeAgo(t.createdAt)}</span>
      </div>`).join('');
    wireUserLinks(list);
    list.querySelectorAll('[data-coin]').forEach(el=>{
      if(el.dataset.coin) el.addEventListener('click', ()=> navigate('coin', el.dataset.coin));
    });
  }, ()=>{ if(list) list.innerHTML = `<div class="empty">Couldn't load activity right now.</div>`; });
  state.unsubs.push(activityUnsub);
}

/* ===================== LEADERBOARD ===================== */
// "Daily"/"Weekly" are computed from each user's netWorthHistory (see refreshNetWorthSnapshot),
// which only gets a fresh point whenever that user actually trades — so someone who hasn't
// traded in a while will look frozen at their last snapshot rather than reflecting live price
// moves on coins they're still holding. Good enough for a friends-group leaderboard; a fully
// live version would need a backend job continuously repricing every portfolio.
let lbCategory = 'daily';
function renderLeaderboard(){
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="section-title">🏆 Leaderboard</div>
    <div class="searchbar"><span>🔍</span><input id="userSearch" placeholder="Find a trader by username..."></div>
    <div id="userSearchResults"></div>
    <div class="chip-row" id="lbChips">
      <div class="chip" data-cat="daily">📅 Daily</div>
      <div class="chip" data-cat="weekly">🗓️ Weekly</div>
      <div class="chip" data-cat="alltime">👑 All-Time</div>
      <div class="chip" data-cat="philanthropy">🎁 Philanthropy</div>
      <div class="chip" data-cat="legends">🏛️ Legends</div>
    </div>
    <div id="lbList"><div class="spinner" style="margin-top:40px;"></div></div>
  `;
  const searchInput = document.getElementById('userSearch');
  let searchDebounce = null;
  searchInput.addEventListener('input', ()=>{
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(()=> runUserSearch(searchInput.value.trim()), 250);
  });
  document.querySelectorAll('#lbChips .chip').forEach(c=>{
    c.classList.toggle('active', c.dataset.cat===lbCategory);
    c.addEventListener('click', ()=>{
      lbCategory = c.dataset.cat;
      document.querySelectorAll('#lbChips .chip').forEach(x=>x.classList.remove('active'));
      c.classList.add('active');
      if(lbCategory==='philanthropy') loadPhilanthropyLeaderboard(); else if(lbCategory==='legends') loadHallOfLegends(); else loadLeaderboard();
    });
  });
  if(lbCategory==='philanthropy') loadPhilanthropyLeaderboard(); else if(lbCategory==='legends') loadHallOfLegends(); else loadLeaderboard();
}

// Prefix search on usernameLower (already stored on every user doc for signup uniqueness checks).
// A true fuzzy/substring search isn't practical with Firestore's query model, but prefix search
// covers "jump straight to someone's profile by username" well enough for a friends-scale app.
// Reusable "type to find a user" autocomplete for recipient inputs (bank send, coin send, copy
// trade). Same prefix-search approach as the Leaderboard's user search, just rendered as a
// small dropdown under whichever input it's attached to instead of a full results panel.
function attachUserAutocomplete(inputEl){
  if(!inputEl || inputEl.dataset.autocompleteAttached) return;
  inputEl.dataset.autocompleteAttached = '1';
  // Wrap the input in its own small positioned container so the dropdown always sits directly
  // under THIS input specifically — relying on inputEl.parentElement was fragile, since in some
  // call sites (like the Send Coin modal) the parent is a large shared container (the whole
  // modal-box), which meant the dropdown was positioned relative to the ENTIRE modal instead of
  // just the input, and could end up visually overlapping the Send/Cancel buttons below it.
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  inputEl.parentElement.insertBefore(wrapper, inputEl);
  wrapper.appendChild(inputEl);
  const dropdown = document.createElement('div');
  dropdown.className = 'user-autocomplete-dropdown';
  wrapper.appendChild(dropdown);
  let debounceTimer = null;
  function hide(){ dropdown.style.display='none'; dropdown.innerHTML=''; }
  inputEl.addEventListener('input', ()=>{
    clearTimeout(debounceTimer);
    const term = inputEl.value.trim().toLowerCase().replace(/^@/,'');
    if(!term){ hide(); return; }
    debounceTimer = setTimeout(async ()=>{
      try{
        const snap = await getDocs(query(collection(db,'users'), orderBy('usernameLower'), where('usernameLower','>=',term), where('usernameLower','<',term+'\uf8ff'), limit(6)));
        const results = snap.docs.map(d=>d.data()).filter(u=>u.username);
        if(!results.length){ hide(); return; }
        dropdown.style.display = 'block';
        dropdown.innerHTML = results.map(u=>`
          <div class="user-autocomplete-item" data-username="${esc(u.username)}">
            <img src="${avatarFor(u.username,u.avatarURL)}">
            <span>@${esc(u.username)}</span>
          </div>`).join('');
        dropdown.querySelectorAll('[data-username]').forEach(item=>{
          item.addEventListener('mousedown', (e)=>{ e.preventDefault(); inputEl.value = item.dataset.username; hide(); });
        });
      }catch(err){ hide(); }
    }, 200);
  });
  inputEl.addEventListener('blur', ()=> setTimeout(hide, 120)); // small delay so the click above still lands
}

async function runUserSearch(term){
  const box = document.getElementById('userSearchResults');
  if(!box) return;
  if(!term){ box.innerHTML = ''; return; }
  const termLower = term.toLowerCase();
  box.innerHTML = '<div class="spinner" style="margin:10px 0;"></div>';
  try{
    const snap = await getDocs(query(collection(db,'users'), orderBy('usernameLower'), where('usernameLower','>=',termLower), where('usernameLower','<',termLower+'\uf8ff'), limit(8)));
    const results = snap.docs.map(d=>({uid:d.id, ...d.data()}));
    if(!results.length){ box.innerHTML = '<div class="empty" style="padding:14px;">No traders found.</div>'; return; }
    box.innerHTML = `<div class="panel" style="margin-bottom:16px;">` + results.map(u=>`
      <div class="holder-line user-link" data-uid="${u.uid}" style="cursor:pointer;">
        <img class="avatar-sm" src="${avatarFor(u.username, u.avatarURL)}" style="border-radius:50%;">
        <span>@${esc(u.username)}</span>
        <span class="mono" style="margin-left:auto;color:var(--txt-dim);font-size:12.5px;">${fmtUsd(u.netWorth ?? u.balance)}</span>
      </div>`).join('') + `</div>`;
    wireUserLinks(box);
  }catch(err){
    box.innerHTML = `<div class="empty" style="padding:14px;">Search failed: ${esc(err.message)}</div>`;
  }
}

function netWorthChange(u, category){
  const current = u.netWorth ?? u.balance ?? STARTING_BALANCE;
  if(category==='alltime') return current - STARTING_BALANCE;
  const windowMs = category==='weekly' ? 7*86400000 : 86400000;
  const cutoff = Date.now() - windowMs;
  const hist = u.netWorthHistory||[];
  let baseline = null;
  for(const h of hist){ if(h.t<=cutoff && (!baseline || h.t>baseline.t)) baseline = h; }
  if(!baseline) baseline = hist.length ? hist.reduce((a,b)=> a.t<b.t?a:b) : {nw:STARTING_BALANCE};
  return current - baseline.nw;
}
// Same baseline logic as the daily leaderboard, but also returns a percentage — used for the
// green/red "today" indicator on profile pages.
function todaysChange(u){
  const current = u.netWorth ?? u.balance ?? STARTING_BALANCE;
  const cutoff = Date.now() - 86400000;
  const hist = u.netWorthHistory||[];
  let baseline = null;
  for(const h of hist){ if(h.t<=cutoff && (!baseline || h.t>baseline.t)) baseline = h; }
  if(!baseline) baseline = hist.length ? hist.reduce((a,b)=> a.t<b.t?a:b) : {nw:STARTING_BALANCE};
  const change = current-baseline.nw;
  const pct = baseline.nw ? (change/baseline.nw)*100 : 0;
  return { change, pct };
}

// Read-only "catch-up" for the leaderboard: rather than trusting each user's stored netWorth
// field (which only updates when THEY trade — see the class comment above), recompute cash +
// realizable holdings value fresh, on the spot, whenever the leaderboard loads. This doesn't
// write anything back (unlike the bot-coin catch-up), so it's cheap and can't race with anyone
// else's data — it just freshens what's displayed.
async function liveNetWorthFor(uid, cashBalance){
  try{
    const holdSnap = await getDocs(collection(db,'users',uid,'holdings'));
    const holdings = holdSnap.docs.map(d=>({id:d.id,...d.data()})).filter(h=>h.tokens>0.0001);
    await ensureCoinsCached(holdings.map(h=>h.id));
    let holdingsVal = 0;
    for(const h of holdings){
      const coin = state.coinsCache.get(h.id);
      if(coin) holdingsVal += sellValue(coin, h.tokens);
    }
    return (cashBalance||0) + holdingsVal;
  }catch(err){ return cashBalance||0; }
}

async function loadLeaderboard(){
  const list = document.getElementById('lbList');
  if(!list) return;
  list.innerHTML = `<div class="spinner" style="margin-top:40px;"></div>`;
  try{
    refreshNetWorthSnapshot(); // keep our own row fresh; doesn't block the rest of the list
    const snap = await getDocs(query(collection(db,'users'), limit(200)));
    const users = snap.docs.map(d=>({uid:d.id, ...d.data()})).filter(u=>u.username);
    // Recomputing live value for everyone fetched could mean a lot of reads if the userbase
    // grows — bound it to a reasonable candidate pool (ranked by last-known value) rather than
    // doing it for all 200.
    const candidates = users.slice().sort((a,b)=> (b.netWorth??b.balance??0)-(a.netWorth??a.balance??0)).slice(0,60);
    const rowsRaw = await Promise.all(candidates.map(async u=>{
      const live = await liveNetWorthFor(u.uid, (u.balance||0)+(u.bank?.balance||0));
      return { uid:u.uid, username:u.username, avatarURL:u.avatarURL, current: live, change: netWorthChange({...u, netWorth: live}, lbCategory) };
    }));
    const rows = rowsRaw.sort((a,b)=> b.change-a.change).slice(0,25);
    if(!rows.length){ list.innerHTML = `<div class="empty"><div class="em-ic">🏆</div>No traders yet.</div>`; return; }
    list.innerHTML = rows.map((r,i)=>{
      const up = r.change>=0;
      const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`;
      return `
      <div class="holder-line">
        <span style="width:26px;text-align:center;font-weight:700;">${medal}</span>
        <div class="user-link" data-uid="${r.uid}" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <img class="avatar-sm" src="${avatarFor(r.username, r.avatarURL)}" style="border-radius:50%;">
          <span>@${esc(r.username)}${wealthBadgeHtml(r.current)}</span>
        </div>
        <span class="mono" style="margin-left:auto;">${fmtUsd(r.current)}</span>
        <span class="coin-chg ${up?'up':'down'}" style="padding:2px 7px;">${up?'▲':'▼'} ${fmtUsd(Math.abs(r.change))}</span>
      </div>`;
    }).join('');
    list.querySelectorAll('.user-link').forEach(el=> el.addEventListener('click', ()=> openProfile(el.dataset.uid)));
  }catch(err){
    list.innerHTML = `<div class="empty">Couldn't load the leaderboard: ${esc(err.message)}</div>`;
  }
}

// Tracks totalGivenUsd (see sendCashToUser/sendCoinToUser) — a single-field sort, no composite
// index needed. Reframes "having too much money" as a flex that actually helps other players,
// instead of it just sitting there as a number nobody else benefits from.
// Cosmetic flexes — pure vanity, no gameplay effect, unlocked at wealth milestones (reusing the
// same thresholds as the wealth-tier badges). A cosmetic only actually shows if BOTH toggled on
// AND currently still eligible — if net worth ever drops back below the threshold, it stops
// showing rather than persisting as a stale flex from a wealth level someone's no longer at.
const COSMETIC_UNLOCKS = { glow: 1e6, ring: 1e9, color: 1e9, banner: 1e12, flair: 1e15 };
const BANNER_PRESETS = {
  sunset:   'linear-gradient(135deg,#FF6B6B,#FFD93D)',
  neon:     'linear-gradient(135deg,#8B6BFF,#C6FF3D)',
  aurora:   'linear-gradient(135deg,#00C9FF,#92FE9D)',
  inferno:  'linear-gradient(135deg,#FF3DAE,#FF8A00)',
  midnight: 'linear-gradient(135deg,#0F0C29,#302B63,#24243E)',
  gold:     'linear-gradient(135deg,#F7971E,#FFD200)',
  royal:    'linear-gradient(135deg,#654EA3,#EAAFC8)',
  matrix:   'linear-gradient(135deg,#000000,#00FF41)',
};
function activeCosmetics(u, netWorth){
  const c = u.cosmetics||{};
  return {
    glow: !!c.glowOn && netWorth>=COSMETIC_UNLOCKS.glow,
    ring: !!c.ringOn && netWorth>=COSMETIC_UNLOCKS.ring,
    color: !!c.colorOn && netWorth>=COSMETIC_UNLOCKS.color,
    bannerGrad: (c.bannerPreset && netWorth>=COSMETIC_UNLOCKS.banner) ? BANNER_PRESETS[c.bannerPreset] : null,
    flairText: (c.flairText && netWorth>=COSMETIC_UNLOCKS.flair) ? c.flairText : null,
  };
}

async function updateBuyDefaults(a, b, c){
  const amts = [a,b,c].map(v=> Math.max(0.01, v||0));
  if(amts.some(v=>!(v>0))){ toast('All three amounts must be greater than $0.', 'err'); return; }
  try{ await updateDoc(doc(db,'users',state.uid), { 'tradeDefaults.buyAmounts': amts }); toast('Default buy amounts updated.', 'ok'); }
  catch(err){ toast("Couldn't update: "+err.message, 'err'); }
}

async function toggleCosmetic(field){
  const netWorth = state.userDoc?.netWorth ?? state.userDoc?.balance ?? 0;
  const threshold = field==='glowOn' ? COSMETIC_UNLOCKS.glow : field==='colorOn' ? COSMETIC_UNLOCKS.color : COSMETIC_UNLOCKS.ring;
  if(netWorth < threshold){ toast(`Need ${fmtUsd(threshold)}+ net worth to unlock this.`, 'err'); return; }
  const current = !!state.userDoc?.cosmetics?.[field];
  try{ await updateDoc(doc(db,'users',state.uid), { [`cosmetics.${field}`]: !current }); }
  catch(err){ toast("Couldn't update: "+err.message, 'err'); }
}
async function setFlairText(text){
  const netWorth = state.userDoc?.netWorth ?? state.userDoc?.balance ?? 0;
  if(netWorth < COSMETIC_UNLOCKS.flair){ toast(`Need ${fmtUsd(COSMETIC_UNLOCKS.flair)}+ net worth to unlock this.`, 'err'); return; }
  const clean = (text||'').trim().slice(0,24);
  try{ await updateDoc(doc(db,'users',state.uid), { 'cosmetics.flairText': clean }); toast(clean?'Flair updated.':'Flair cleared.', 'ok'); }
  catch(err){ toast("Couldn't update: "+err.message, 'err'); }
}
async function setBannerPreset(key){
  const netWorth = state.userDoc?.netWorth ?? state.userDoc?.balance ?? 0;
  if(key && netWorth < COSMETIC_UNLOCKS.banner){ toast(`Need ${fmtUsd(COSMETIC_UNLOCKS.banner)}+ net worth to unlock this.`, 'err'); return; }
  if(key && !BANNER_PRESETS[key]) return;
  try{ await updateDoc(doc(db,'users',state.uid), { 'cosmetics.bannerPreset': key||null }); }
  catch(err){ toast("Couldn't update: "+err.message, 'err'); }
}

// Sorted by legendPeakNetWorth — a single-field orderBy with no where clause needed at all.
// Anyone who's never crossed Qi simply doesn't have this field set, and Firestore excludes docs
// missing the ordered field from range/order queries entirely — so this naturally returns only
// legends, correctly sorted, without a composite index (same trick already used for Philanthropy).
async function loadHallOfLegends(){
  const list = document.getElementById('lbList');
  if(!list) return;
  list.innerHTML = `<div class="spinner" style="margin-top:40px;"></div>`;
  try{
    const snap = await getDocs(query(collection(db,'users'), orderBy('legendPeakNetWorth','desc'), limit(25)));
    const rows = snap.docs.map(d=>({uid:d.id, ...d.data()})).filter(u=>u.username && u.legendAchievedAt);
    if(!rows.length){ list.innerHTML = `<div class="empty"><div class="em-ic">🏛️</div>Nobody's crossed ${fmtUsd(HALL_OF_LEGENDS_NET_WORTH)} yet — this record is permanent once someone does.</div>`; return; }
    list.innerHTML = `
      <div style="font-size:11.5px;color:var(--txt-faint);margin-bottom:12px;line-height:1.5;">A permanent record, not a live ranking — everyone here crossed ${fmtUsd(HALL_OF_LEGENDS_NET_WORTH)} at some point and stays listed even if net worth drops later. Sorted by peak, not current standing.</div>
      ${rows.map((r,i)=>{
        const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`;
        return `
        <div class="holder-line">
          <span style="width:26px;text-align:center;font-weight:700;">${medal}</span>
          <div class="user-link" data-uid="${r.uid}" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <img class="avatar-sm" src="${avatarFor(r.username, r.avatarURL)}" style="border-radius:50%;">
            <span>@${esc(r.username)}${wealthBadgeHtml(r.netWorth||r.balance||0)}</span>
          </div>
          <span class="mono" style="margin-left:auto;color:#B8A8FF;">🏛️ ${fmtUsd(r.legendPeakNetWorth)}</span>
        </div>`;
      }).join('')}`;
    list.querySelectorAll('.user-link').forEach(el=> el.addEventListener('click', ()=> openProfile(el.dataset.uid)));
  }catch(err){
    list.innerHTML = `<div class="empty">Couldn't load the Hall of Legends: ${esc(err.message)}</div>`;
  }
}

async function loadPhilanthropyLeaderboard(){
  const list = document.getElementById('lbList');
  if(!list) return;
  list.innerHTML = `<div class="spinner" style="margin-top:40px;"></div>`;
  try{
    const snap = await getDocs(query(collection(db,'users'), orderBy('totalGivenUsd','desc'), limit(25)));
    const rows = snap.docs.map(d=>({uid:d.id, ...d.data()})).filter(u=>u.username && (u.totalGivenUsd||0)>0);
    if(!rows.length){ list.innerHTML = `<div class="empty"><div class="em-ic">🎁</div>Nobody's given anything away yet — be the first.</div>`; return; }
    list.innerHTML = rows.map((r,i)=>{
      const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`;
      return `
      <div class="holder-line">
        <span style="width:26px;text-align:center;font-weight:700;">${medal}</span>
        <div class="user-link" data-uid="${r.uid}" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <img class="avatar-sm" src="${avatarFor(r.username, r.avatarURL)}" style="border-radius:50%;">
          <span>@${esc(r.username)}${wealthBadgeHtml(r.netWorth||r.balance||0)}</span>
        </div>
        <span class="mono" style="margin-left:auto;color:var(--lime);">🎁 ${fmtUsd(r.totalGivenUsd)}</span>
      </div>`;
    }).join('');
    list.querySelectorAll('.user-link').forEach(el=> el.addEventListener('click', ()=> openProfile(el.dataset.uid)));
  }catch(err){
    list.innerHTML = `<div class="empty">Couldn't load the philanthropy leaderboard: ${esc(err.message)}</div>`;
  }
}

/* ===================== POSITIONS (shared by own + public profile) ===================== */
// Reads a user's holdings subcollection and splits it into open positions (still holding tokens)
// and closed ones (fully exited at some point, i.e. had activity but zero tokens left now).
// Requires holdings to be readable by any signed-in user (see updated Firestore rules in
// SETUP.md) so a public profile can show someone else's positions, not just your own.
async function loadPositions(uid){
  const holdSnap = await getDocs(collection(db,'users',uid,'holdings'));
  const holdings = holdSnap.docs.map(d=>({id:d.id,...d.data()})).filter(h=>h.tokens>0.0001);
  await ensureCoinsCached(holdings.map(h=>h.id));
  const open = [];
  for(const h of holdings){
    const coin = state.coinsCache.get(h.id);
    const val = coin? sellValue(coin, h.tokens) : 0;
    open.push({ h, coin, val, pnl: val-(h.costBasis||0) });
  }
  open.sort((a,b)=> b.val-a.val);
  // Every sell writes its own record here, so this is a running list of individual sales —
  // not just coins you've fully exited — sorted most recent first.
  const closedSnap = await getDocs(query(collection(db,'users',uid,'closedPositions'), orderBy('closedAt','desc'), limit(100)));
  const closed = closedSnap.docs.map(d=>({id:d.id,...d.data()}));
  return { open, closed };
}
function openPositionsHtml(open){
  if(!open.length) return '<div class="empty" style="padding:16px;">No open positions.</div>';
  return open.map(r=>{
    const up = r.pnl>=0;
    const ticker = r.coin?.ticker || r.h.ticker;
    return `
    <div class="hold-row" data-coin="${r.h.id}">
      <img class="coin-logo" src="${coinLogoFor(ticker, r.coin?.imageURL||r.h.imageURL)}">
      <div class="hold-info">
        <div class="coin-ticker">$${esc(ticker)}</div>
        <div class="coin-name">${fmtTok(r.h.tokens)} tokens</div>
      </div>
      <div class="hold-right">
        <div class="hold-val mono">${fmtUsd(r.val)}</div>
        <div class="mono" style="font-size:11.5px;color:${up?'var(--up)':'var(--down)'};">${up?'▲':'▼'} ${fmtUsd(Math.abs(r.pnl))}</div>
      </div>
    </div>`;
  }).join('');
}
// Pins are capped at 3 and stored directly on the user doc (public field, so pinned coins show
// on both your own and public profile the same way). Sorting pinned-first happens at the call
// site, not in here — this function just renders whatever order it's given.
async function togglePinCoin(coinId){
  const pinned = state.userDoc?.pinnedCoins||[];
  const isPinned = pinned.includes(coinId);
  let next;
  if(isPinned) next = pinned.filter(id=>id!==coinId);
  else{
    if(pinned.length>=3){ toast('You can only pin up to 3 coins — unpin one first.', 'err'); return; }
    next = [...pinned, coinId];
  }
  try{ await updateDoc(doc(db,'users',state.uid), { pinnedCoins: next }); }
  catch(err){ toast("Couldn't update pins: "+err.message, 'err'); }
}
function closedPositionsHtml(closed){
  if(!closed.length) return '<div class="empty" style="padding:16px;">No closed positions yet — sell something to see it here.</div>';
  return closed.map(r=>{
    const pnl = r.pnl||0;
    const up = pnl>=0;
    return `
    <div class="hold-row" data-coin="${r.coinId}" style="cursor:pointer;">
      <img class="coin-logo" src="${coinLogoFor(r.ticker, r.imageURL)}">
      <div class="hold-info">
        <div class="coin-ticker">$${esc(r.ticker)}</div>
        <div class="coin-name">Sold ${fmtTok(r.tokensSold)} for ${fmtUsd(r.proceeds)} · ${timeAgo(r.closedAt)}</div>
      </div>
      <div class="hold-right">
        <div class="mono" style="font-weight:600;color:${up?'var(--up)':'var(--down)'};">${up?'▲':'▼'} ${fmtUsd(Math.abs(pnl))}</div>
        <div style="font-size:11px;color:var(--txt-faint);">realized P&L</div>
      </div>
    </div>`;
  }).join('');
}
function wirePositionRows(container){
  container.querySelectorAll('[data-coin]').forEach(el=>{
    if(el.dataset.coin) el.addEventListener('click', ()=> navigate('coin', el.dataset.coin));
  });
  container.querySelectorAll('[data-pin-coin]').forEach(el=>{
    el.addEventListener('click', (e)=>{ e.stopPropagation(); togglePinCoin(el.dataset.pinCoin); });
  });
}

/* ===================== PUBLIC PROFILE (someone else's) ===================== */
async function renderUserProfile(uid){
  const view = document.getElementById('view');
  view.innerHTML = `<div class="spinner" style="margin-top:60px;"></div>`;
  const uSnap = await getDoc(doc(db,'users',uid));
  if(!uSnap.exists()){ view.innerHTML = `<div class="empty"><div class="em-ic">👻</div>Couldn't find that trader.</div>`; return; }
  const u = uSnap.data();
  const today = todaysChange(u);
  const todayUp = today.change>=0;
  const cos = activeCosmetics(u, u.netWorth ?? u.balance ?? 0);
  view.innerHTML = `
    <div class="back-btn" id="backBtn">← Back</div>
    <div class="profile-head${cos.bannerGrad?' has-banner':''}" ${cos.bannerGrad?`style="background:${cos.bannerGrad};"`:''}>
      <div class="avatar-ring-wrap${cos.ring?' ring-active':''}">
        <img class="avatar-lg${cos.glow?' avatar-glow':''}" src="${avatarFor(u.username,u.avatarURL)}">
      </div>
      <div>
        <div class="profile-name"><span class="${cos.color?'username-gradient':''}">@${esc(u.username)}</span>${wealthBadgeHtml(u.netWorth ?? u.balance ?? 0)}${cos.flairText?`<span class="flair-pill">${esc(cos.flairText)}</span>`:''}</div>
        <div class="profile-bio">${esc(u.bio)||'No bio yet.'}</div>
        <div class="mono" style="font-size:13px;font-weight:600;margin-top:4px;color:${todayUp?'var(--up)':'var(--down)'};">${todayUp?'▲':'▼'} ${Math.abs(today.pct).toFixed(1)}% today (${todayUp?'+':'-'}${fmtUsd(Math.abs(today.change))})</div>
      </div>
    </div>
    <div class="panel">
      <div class="settings-row"><span>Overall account balance</span><b class="mono">${fmtUsd(u.netWorth ?? u.balance)}</b></div>
      <div class="settings-row"><span>Cash</span><b class="mono">${fmtUsd(u.balance)}</b></div>
      <div class="settings-row"><span>Bank</span><b class="mono">${fmtUsd(u.bank?.balance||0)}</b></div>
      <div class="settings-row"><span>Win rate</span><b class="mono" id="winRateStat">—</b></div>
      <div class="settings-row"><span>Streak</span><b class="mono" id="winStreakStat">—</b></div>
      <div class="settings-row" style="border:none;"><span>Trading style</span><b class="mono" id="handsStat">—</b></div>
    </div>
    <div class="panel" style="margin-top:16px;">
      <div style="font-weight:700;margin-bottom:10px;">Net Worth Over Time</div>
      <div class="chart-wrap" style="height:180px;"><canvas id="userProfChart"></canvas></div>
    </div>
    <div class="section-title" style="font-size:16px;margin-top:20px;">Open Positions</div>
    <div id="openPosList"><div class="spinner"></div></div>
    <div class="section-title" style="font-size:16px;margin-top:20px;">Closed Positions</div>
    <div id="closedPosList"><div class="spinner"></div></div>
  `;
  document.getElementById('backBtn').addEventListener('click', ()=> navigate('leaderboard'));
  drawNetWorthChart('userProfChart', u.netWorthHistory);
  try{
    const { open, closed } = await loadPositions(uid);
    const openEl = document.getElementById('openPosList');
    const closedEl = document.getElementById('closedPosList');
    if(openEl){ openEl.innerHTML = openPositionsHtml(open); wirePositionRows(openEl); }
    if(closedEl){ closedEl.innerHTML = closedPositionsHtml(closed); wirePositionRows(closedEl); }
    const wrEl = document.getElementById('winRateStat'); if(wrEl) wrEl.textContent = winRateText(closed);
    const wsEl = document.getElementById('winStreakStat'); if(wsEl) wsEl.textContent = winStreakText(closed);
    const hEl = document.getElementById('handsStat'); if(hEl) hEl.textContent = handsBadgeText(closed);
  }catch(err){
    const openEl = document.getElementById('openPosList');
    if(openEl) openEl.innerHTML = `<div class="empty">Couldn't load positions: ${esc(err.message)}</div>`;
    const closedEl = document.getElementById('closedPosList');
    if(closedEl) closedEl.innerHTML = '';
  }
}

function winRateText(closed){
  if(!closed.length) return 'No sells yet';
  const wins = closed.filter(c=>(c.pnl||0)>0).length;
  return `${Math.round(wins/closed.length*100)}% (${wins}/${closed.length})`;
}
// closed is sorted most-recent-first (see loadPositions) — counts consecutive profitable sells
// starting from the most recent one.
function winStreakText(closed){
  if(!closed.length) return '—';
  let streak = 0;
  for(const c of closed){
    if((c.pnl||0)>0) streak++;
    else break;
  }
  return streak>0 ? `🔥 ${streak} in a row` : 'No active streak';
}
// Average hold time across closed positions, classified into a fun badge. Thresholds are tuned
// to this app's pace (bot coins can swing meaningfully within minutes), not real-market scale.
function handsBadgeText(closed){
  if(!closed.length) return '—';
  const withDuration = closed.filter(c=>c.heldMs!=null);
  if(!withDuration.length) return '—';
  const avgMs = withDuration.reduce((sum,c)=>sum+c.heldMs,0)/withDuration.length;
  const avgMin = avgMs/60000;
  if(avgMin>=15) return `💎 Diamond Hands (avg ${avgMin>=60?(avgMin/60).toFixed(1)+'h':Math.round(avgMin)+'m'} hold)`;
  return `🧻 Paper Hands (avg ${avgMin<1?Math.round(avgMs/1000)+'s':Math.round(avgMin)+'m'} hold)`;
}
/* ===================== PROFILE ===================== */
function renderProfile(){
  const u = state.userDoc;
  if(!u){
    const view = document.getElementById('view');
    if(view) view.innerHTML = `<div class="spinner" style="margin-top:60px;"></div>`;
    // listenUserDoc's onSnapshot re-calls renderProfile() the moment the account loads — but if
    // that never happens (a genuinely broken/missing account doc, not just a brief load race),
    // don't leave the person staring at a spinner forever with no explanation.
    setTimeout(()=>{
      if(state.userDoc || state.route.name!=='profile') return;
      const v = document.getElementById('view');
      if(v) v.innerHTML = `
        <div class="empty">
          <div class="em-ic">⚠️</div>
          Couldn't load your account. This usually clears up by logging out and back in.
          <button class="btn btn-ghost" style="margin-top:14px;" id="profileReloadBtn">Log Out</button>
        </div>`;
      document.getElementById('profileReloadBtn')?.addEventListener('click', ()=> signOut(auth));
    }, 6000);
    return;
  }
  const view = document.getElementById('view');
  const today = todaysChange(u);
  const todayUp = today.change>=0;
  const cos = activeCosmetics(u, u.netWorth ?? u.balance ?? 0);
  view.innerHTML = `
    <div class="section-title">Profile</div>
    <div class="profile-head${cos.bannerGrad?' has-banner':''}" ${cos.bannerGrad?`style="background:${cos.bannerGrad};"`:''}>
      <div class="avatar-ring-wrap${cos.ring?' ring-active':''}">
        <img class="avatar-lg${cos.glow?' avatar-glow':''}" id="profAvatarImg" src="${avatarFor(u.username,u.avatarURL)}">
      </div>
      <div>
        <div class="profile-name"><span class="${cos.color?'username-gradient':''}">@${esc(u.username)}</span>${wealthBadgeHtml(u.netWorth ?? u.balance ?? 0)}${cos.flairText?`<span class="flair-pill">${esc(cos.flairText)}</span>`:''}</div>
        <div class="profile-bio">${esc(u.bio)||'No bio yet.'}</div>
        <div class="mono" style="font-size:13px;font-weight:600;margin-top:4px;color:${todayUp?'var(--up)':'var(--down)'};">${todayUp?'▲':'▼'} ${Math.abs(today.pct).toFixed(1)}% today (${todayUp?'+':'-'}${fmtUsd(Math.abs(today.change))})</div>
      </div>
    </div>
    <div class="panel">
      <div class="settings-row"><span>Avatar image URL</span><button class="btn btn-ghost" id="changeAvatarBtn">Edit</button></div>
      <div class="settings-row"><span>Bio</span><button class="btn btn-ghost" id="editBioBtn">Edit</button></div>
      <div class="settings-row"><span>🔔 Bot notifications</span><button class="btn ${botNotificationsEnabled()?'btn-lime':'btn-ghost'}" id="botNotifToggleBtn">${botNotificationsEnabled()?'On':'Off'}</button></div>
      <div class="settings-row"><span>💰 Billionaire full-screen alerts</span><button class="btn ${billionaireAlertsEnabled()?'btn-lime':'btn-ghost'}" id="billionaireAlertToggleBtn">${billionaireAlertsEnabled()?'On':'Off'}</button></div>
      <div class="settings-row"><span>Overall account balance</span><b class="mono">${fmtUsd(u.netWorth ?? u.balance)}</b></div>
      <div class="settings-row"><span>Cash</span><b class="mono">${fmtUsd(u.balance)}</b></div>
      <div class="settings-row"><span>Bank</span><b class="mono">${fmtUsd(u.bank?.balance||0)}</b></div>
      <div class="settings-row"><span>Win rate</span><b class="mono" id="winRateStat">—</b></div>
      <div class="settings-row"><span>Streak</span><b class="mono" id="winStreakStat">—</b></div>
      <div class="settings-row" style="border:none;"><span>Trading style</span><b class="mono" id="handsStat">—</b></div>
    </div>
    <div class="panel" style="margin-top:16px;">
      <div style="font-weight:700;margin-bottom:10px;">💵 Default Buy Amounts</div>
      <div style="font-size:11.5px;color:var(--txt-faint);margin-bottom:10px;line-height:1.5;">Replaces the quick-buy buttons on every coin's buy panel — set whatever amounts actually match how you trade instead of the default $5/$20/$50.</div>
      <div style="display:flex;gap:8px;">
        <input class="field" id="buyDefault1" style="flex:1;" inputmode="decimal" value="${state.userDoc?.tradeDefaults?.buyAmounts?.[0] ?? 5}">
        <input class="field" id="buyDefault2" style="flex:1;" inputmode="decimal" value="${state.userDoc?.tradeDefaults?.buyAmounts?.[1] ?? 20}">
        <input class="field" id="buyDefault3" style="flex:1;" inputmode="decimal" value="${state.userDoc?.tradeDefaults?.buyAmounts?.[2] ?? 50}">
      </div>
      <button class="btn btn-ghost btn-block" style="margin-top:10px;" id="saveBuyDefaultsBtn">Save</button>
    </div>
    <div class="panel" style="margin-top:16px;">
      <div style="font-weight:700;margin-bottom:10px;">🎨 Cosmetic Flexes</div>
      <div style="font-size:11.5px;color:var(--txt-faint);margin-bottom:12px;line-height:1.5;">Pure vanity, no gameplay effect — unlocked automatically at wealth milestones. If net worth ever drops back below the threshold, the effect stops showing until it's crossed again.</div>
      <div class="settings-row">
        <span>✨ Avatar glow ${(u.netWorth??u.balance??0)>=COSMETIC_UNLOCKS.glow?'':`<span style="color:var(--txt-faint);font-size:11px;">(needs ${fmtUsd(COSMETIC_UNLOCKS.glow)}+)</span>`}</span>
        <button class="btn ${u.cosmetics?.glowOn?'btn-lime':'btn-ghost'}" id="cosGlowBtn" ${(u.netWorth??u.balance??0)<COSMETIC_UNLOCKS.glow?'disabled style="opacity:.4;"':''}>${u.cosmetics?.glowOn?'On':'Off'}</button>
      </div>
      <div class="settings-row">
        <span>💫 Animated ring ${(u.netWorth??u.balance??0)>=COSMETIC_UNLOCKS.ring?'':`<span style="color:var(--txt-faint);font-size:11px;">(needs ${fmtUsd(COSMETIC_UNLOCKS.ring)}+)</span>`}</span>
        <button class="btn ${u.cosmetics?.ringOn?'btn-lime':'btn-ghost'}" id="cosRingBtn" ${(u.netWorth??u.balance??0)<COSMETIC_UNLOCKS.ring?'disabled style="opacity:.4;"':''}>${u.cosmetics?.ringOn?'On':'Off'}</button>
      </div>
      <div class="settings-row">
        <span>🌈 Gradient username ${(u.netWorth??u.balance??0)>=COSMETIC_UNLOCKS.color?'':`<span style="color:var(--txt-faint);font-size:11px;">(needs ${fmtUsd(COSMETIC_UNLOCKS.color)}+)</span>`}</span>
        <button class="btn ${u.cosmetics?.colorOn?'btn-lime':'btn-ghost'}" id="cosColorBtn" ${(u.netWorth??u.balance??0)<COSMETIC_UNLOCKS.color?'disabled style="opacity:.4;"':''}>${u.cosmetics?.colorOn?'On':'Off'}</button>
      </div>
      <div class="settings-row" style="flex-wrap:wrap;gap:8px;">
        <span>🎨 Profile banner ${(u.netWorth??u.balance??0)>=COSMETIC_UNLOCKS.banner?'':`<span style="color:var(--txt-faint);font-size:11px;">(needs ${fmtUsd(COSMETIC_UNLOCKS.banner)}+)</span>`}</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${(u.netWorth??u.balance??0)>=COSMETIC_UNLOCKS.banner ? Object.keys(BANNER_PRESETS).map(key=>`
            <button class="btn ${u.cosmetics?.bannerPreset===key?'btn-lime':'btn-ghost'}" data-banner-preset="${key}" style="padding:6px 10px;font-size:11px;text-transform:capitalize;">${key}</button>
          `).join('') + `<button class="btn btn-ghost" data-banner-preset="" style="padding:6px 10px;font-size:11px;">None</button>` : ''}
        </div>
      </div>
      <div class="settings-row" style="border:none;flex-wrap:wrap;gap:8px;">
        <span>🏷️ Custom flair ${(u.netWorth??u.balance??0)>=COSMETIC_UNLOCKS.flair?'':`<span style="color:var(--txt-faint);font-size:11px;">(needs ${fmtUsd(COSMETIC_UNLOCKS.flair)}+)</span>`}</span>
        ${(u.netWorth??u.balance??0)>=COSMETIC_UNLOCKS.flair ? `
          <div style="display:flex;gap:8px;">
            <input class="field" id="flairTextInput" style="width:160px;padding:8px 10px;" maxlength="24" placeholder="e.g. Certified Degen" value="${esc(u.cosmetics?.flairText||'')}">
            <button class="btn btn-ghost" id="saveFlairBtn">Save</button>
          </div>` : ''}
      </div>
    </div>
    <div class="panel" style="margin-top:16px;">
      <div style="font-weight:700;margin-bottom:10px;">🎯 Auto-Snipe Bot</div>
      ${u.snipeBot?.owned ? `
        <div class="settings-row">
          <span>Status</span>
          <button class="btn ${u.snipeBot.active?'btn-lime':'btn-ghost'}" id="snipeToggleBtn">${u.snipeBot.active?'Active — tap to pause':'Paused — tap to resume'}</button>
        </div>
        ${u.snipeBot.categoryUpgrade ? `
        <div class="settings-row" style="flex-wrap:wrap;gap:8px;"><span>Community coins</span><div style="display:flex;gap:8px;"><input class="field" id="snipeAmtCommunity" style="width:80px;padding:8px 10px;" inputmode="decimal" value="${u.snipeBot.amounts?.community||10}"><button class="btn btn-ghost" data-cat="community" data-cat-save>Save</button></div></div>
        <div class="settings-row" style="flex-wrap:wrap;gap:8px;"><span>Bot Market coins</span><div style="display:flex;gap:8px;"><input class="field" id="snipeAmtBot" style="width:80px;padding:8px 10px;" inputmode="decimal" value="${u.snipeBot.amounts?.bot||10}"><button class="btn btn-ghost" data-cat="bot" data-cat-save>Save</button></div></div>
        <div class="settings-row" style="border:none;flex-wrap:wrap;gap:8px;"><span>Guaranteed-growth coins</span><div style="display:flex;gap:8px;"><input class="field" id="snipeAmtGuaranteed" style="width:80px;padding:8px 10px;" inputmode="decimal" value="${u.snipeBot.amounts?.guaranteed||10}"><button class="btn btn-ghost" data-cat="guaranteed" data-cat-save>Save</button></div></div>
        ` : `
        <div class="settings-row" style="border:none;flex-wrap:wrap;gap:8px;">
          <span>Amount per coin</span>
          <div style="display:flex;gap:8px;align-items:center;">
            <input class="field" id="snipeAmountInput" style="width:90px;padding:8px 10px;" inputmode="decimal" value="${u.snipeBot.amountPerCoin||10}">
            <button class="btn btn-ghost" id="snipeAmountSaveBtn">Save</button>
          </div>
        </div>
        <button class="btn btn-ghost btn-block" style="margin-top:6px;" id="snipeCategoryUpgradeBtn">Upgrade: set separate amounts per coin type — ${fmtUsd(SNIPE_CATEGORY_UPGRADE_PRICE)}</button>
        `}
        <div style="display:flex;gap:16px;margin:12px 0 4px;font-size:12.5px;color:var(--txt-dim);">
          <span>Spent: <b class="mono" style="color:var(--txt);">${fmtUsd(u.snipeBot.totalSpent||0)}</b></span>
          <span>Coins sniped: <b class="mono" style="color:var(--txt);">${(u.snipeBot.snipedCoins||[]).length}</b></span>
        </div>
        <button class="btn btn-ghost btn-block" style="margin-top:8px;" id="snipeStatsBtn">📊 View Stats</button>
        <div style="font-size:11.5px;color:var(--txt-faint);margin-top:8px;line-height:1.5;">Auto-buys into every new coin — community launches and Bot Market spawns alike — from now on, only while your account is signed in on some open tab of yours. Doesn't touch coins that already existed before you turned this on, and never snipes your own launches.</div>
      ` : `
        <div style="font-size:13px;color:var(--txt-dim);line-height:1.5;margin-bottom:12px;">Auto-buy a set dollar amount into every new coin the moment it launches — community coins and Bot Market spawns alike — for as long as it's toggled on. One-time unlock, pause/resume anytime after.</div>
        <button class="btn btn-lime btn-block" id="snipeBuyBtn">Unlock for ${fmtUsd(SNIPE_BOT_PRICE)}</button>
      `}
    </div>
    <div class="panel" style="margin-top:16px;">
      <div style="font-weight:700;margin-bottom:10px;">🪞 Copy Trade</div>
      ${u.snipeBot?.copyTrade?.owned ? `
        <div class="settings-row">
          <span>Status</span>
          <button class="btn ${u.snipeBot.copyTrade.active?'btn-lime':'btn-ghost'}" id="copyTradeToggleBtn">${u.snipeBot.copyTrade.active?'Active — tap to pause':'Paused — tap to resume'}</button>
        </div>
        <div id="copyTargetsList">${(u.snipeBot.copyTrade.targets||[]).length? u.snipeBot.copyTrade.targets.map(t=>`
          <div class="settings-row">
            <span>@${esc(t.username)} · ${fmtUsd(t.amount)}/trade</span>
            <button class="btn btn-ghost" data-remove-target="${t.uid}" style="padding:6px 10px;font-size:11px;">Remove</button>
          </div>`).join('') : '<div style="font-size:12px;color:var(--txt-faint);padding:6px 0;">Not copying anyone yet.</div>'}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
          <input class="field" id="copyTargetUser" style="flex:1;min-width:90px;" placeholder="username">
          <input class="field" id="copyTargetAmount" style="width:80px;" inputmode="decimal" placeholder="$/trade">
          <button class="btn btn-ghost" id="copyTargetAddBtn">Add</button>
        </div>
        <div style="font-size:11.5px;color:var(--txt-faint);margin-top:10px;line-height:1.5;">Mirrors up to 5 users' real buys and sells — each buy uses your own chosen dollar amount, not theirs; a copied sell dumps your entire position in that coin. Same rule as everything else here: only fires while your account is signed in somewhere.</div>
      ` : `
        <div style="font-size:13px;color:var(--txt-dim);line-height:1.5;margin-bottom:12px;">Pick up to 5 real traders and automatically mirror their buys and sells, at a dollar amount you choose per trade — not theirs.</div>
        <button class="btn btn-lime btn-block" id="copyTradeBuyBtn">Unlock for ${fmtUsd(SNIPE_COPYTRADE_UPGRADE_PRICE)}</button>
      `}
    </div>
    <div class="panel" style="margin-top:16px;">
      <div style="font-weight:700;margin-bottom:10px;">Net Worth Over Time</div>
      <div class="chart-wrap" style="height:180px;"><canvas id="profChart"></canvas></div>
    </div>
    <div class="section-title" style="font-size:16px;margin-top:20px;">Open Positions</div>
    <div id="openPosList"><div class="spinner"></div></div>
    <div class="section-title" style="font-size:16px;margin-top:20px;">Closed Positions</div>
    <div id="closedPosList"><div class="spinner"></div></div>
    <button class="btn btn-ghost btn-block" style="margin-top:20px;color:var(--down);" id="logoutBtn">Log Out</button>
  `;
  document.getElementById('logoutBtn').addEventListener('click', ()=> signOut(auth));
  document.getElementById('editBioBtn').addEventListener('click', ()=> openBioModal());
  document.getElementById('botNotifToggleBtn').addEventListener('click', ()=> toggleBotNotifications().then(()=> renderProfile()));
  document.getElementById('billionaireAlertToggleBtn').addEventListener('click', ()=> toggleBillionaireAlerts().then(()=> renderProfile()));
  document.getElementById('saveBuyDefaultsBtn').addEventListener('click', ()=>{
    updateBuyDefaults(
      parseFloat(document.getElementById('buyDefault1').value),
      parseFloat(document.getElementById('buyDefault2').value),
      parseFloat(document.getElementById('buyDefault3').value)
    );
  });
  document.getElementById('cosGlowBtn')?.addEventListener('click', ()=> toggleCosmetic('glowOn').then(()=> renderProfile()));
  document.getElementById('cosRingBtn')?.addEventListener('click', ()=> toggleCosmetic('ringOn').then(()=> renderProfile()));
  document.getElementById('cosColorBtn')?.addEventListener('click', ()=> toggleCosmetic('colorOn').then(()=> renderProfile()));
  document.getElementById('saveFlairBtn')?.addEventListener('click', ()=> setFlairText(document.getElementById('flairTextInput').value).then(()=> renderProfile()));
  document.querySelectorAll('[data-banner-preset]').forEach(btn=>{
    btn.addEventListener('click', ()=> setBannerPreset(btn.dataset.bannerPreset).then(()=> renderProfile()));
  });
  document.getElementById('changeAvatarBtn').addEventListener('click', ()=> openAvatarModal());
  document.getElementById('snipeBuyBtn')?.addEventListener('click', ()=> purchaseSnipeBot());
  document.getElementById('snipeToggleBtn')?.addEventListener('click', ()=> toggleSnipeBot());
  document.getElementById('snipeStatsBtn')?.addEventListener('click', ()=> openSnipeStatsModal());
  document.getElementById('snipeAmountSaveBtn')?.addEventListener('click', ()=>{
    const v = parseFloat(document.getElementById('snipeAmountInput').value);
    updateSnipeAmount(v);
  });
  document.getElementById('snipeCategoryUpgradeBtn')?.addEventListener('click', ()=> purchaseSnipeCategoryUpgrade());
  document.querySelectorAll('[data-cat-save]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const cat = btn.dataset.cat;
      const inputId = cat==='community'?'snipeAmtCommunity':cat==='bot'?'snipeAmtBot':'snipeAmtGuaranteed';
      updateSnipeCategoryAmount(cat, parseFloat(document.getElementById(inputId).value));
    });
  });
  document.getElementById('copyTradeBuyBtn')?.addEventListener('click', ()=> purchaseCopyTradeUpgrade());
  document.getElementById('copyTradeToggleBtn')?.addEventListener('click', ()=> toggleCopyTrade());
  document.getElementById('copyTargetAddBtn')?.addEventListener('click', ()=>{
    addCopyTarget(document.getElementById('copyTargetUser').value, parseFloat(document.getElementById('copyTargetAmount').value));
  });
  if(document.getElementById('copyTargetUser')) attachUserAutocomplete(document.getElementById('copyTargetUser'));
  document.querySelectorAll('[data-remove-target]').forEach(btn=>{
    btn.addEventListener('click', ()=> removeCopyTarget(btn.dataset.removeTarget));
  });
  drawNetWorthChart('profChart', u.netWorthHistory);
  loadPositions(state.uid).then(({open, closed})=>{
    const openEl = document.getElementById('openPosList');
    const closedEl = document.getElementById('closedPosList');
    if(openEl){ openEl.innerHTML = openPositionsHtml(open); wirePositionRows(openEl); }
    if(closedEl){ closedEl.innerHTML = closedPositionsHtml(closed); wirePositionRows(closedEl); }
    const wrEl = document.getElementById('winRateStat'); if(wrEl) wrEl.textContent = winRateText(closed);
    const wsEl = document.getElementById('winStreakStat'); if(wsEl) wsEl.textContent = winStreakText(closed);
    const hEl = document.getElementById('handsStat'); if(hEl) hEl.textContent = handsBadgeText(closed);
  }).catch(err=>{
    const openEl = document.getElementById('openPosList');
    if(openEl) openEl.innerHTML = `<div class="empty">Couldn't load positions: ${esc(err.message)}</div>`;
  });
}

function openAvatarModal(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>Edit Avatar</h3>
      <img id="avatarPreview" src="${avatarFor(state.userDoc.username, state.userDoc.avatarURL)}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;display:block;margin:0 auto 16px;background:#1c1a2e;">
      <label class="flabel">Image URL</label>
      <input class="field" id="avatarInput" placeholder="https://example.com/me.png" value="${esc(state.userDoc.avatarURL||'')}">
      <div style="text-align:center;color:var(--txt-faint);font-size:12px;margin-top:10px;">Leave blank to use your generated default avatar.</div>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-ghost btn-block" id="avatarCancel">Cancel</button>
        <button class="btn btn-primary btn-block" id="avatarSave">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e=>{ if(e.target===overlay) overlay.remove(); });
  const input = document.getElementById('avatarInput');
  const preview = document.getElementById('avatarPreview');
  input.addEventListener('input', ()=>{ preview.src = avatarFor(state.userDoc.username, input.value.trim()); });
  document.getElementById('avatarCancel').addEventListener('click', ()=> overlay.remove());
  document.getElementById('avatarSave').addEventListener('click', async ()=>{
    await updateDoc(doc(db,'users',state.uid), { avatarURL: input.value.trim() });
    overlay.remove(); toast('Avatar updated!', 'ok');
  });
}

function openBioModal(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>Edit Bio</h3>
      <textarea class="field" id="bioInput" rows="3" maxlength="140">${esc(state.userDoc.bio||'')}</textarea>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-ghost btn-block" id="bioCancel">Cancel</button>
        <button class="btn btn-primary btn-block" id="bioSave">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e=>{ if(e.target===overlay) overlay.remove(); });
  document.getElementById('bioCancel').addEventListener('click', ()=> overlay.remove());
  document.getElementById('bioSave').addEventListener('click', async ()=>{
    await updateDoc(doc(db,'users',state.uid), { bio: document.getElementById('bioInput').value.trim() });
    overlay.remove(); toast('Bio saved.', 'ok');
  });
}
