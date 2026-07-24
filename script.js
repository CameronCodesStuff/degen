import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, onSnapshot, collection, collectionGroup,
  query, orderBy, limit, runTransaction, serverTimestamp, where, getDocs, deleteField, Timestamp,
  getCountFromServer, writeBatch, deleteDoc, setLogLevel
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

function clearUnsubs(){ state.unsubs.forEach(u=>u()); state.unsubs = []; }
function fmtUsd(n){
  if(n===undefined||n===null||isNaN(n)) n=0;
  const abs=Math.abs(n);
  if(abs>=1000000) return (n<0?'-':'')+'$'+(abs/1000000).toFixed(2)+'M';
  if(abs>=1000) return (n<0?'-':'')+'$'+(abs/1000).toFixed(2)+'K';
  return (n<0?'-':'')+'$'+abs.toFixed(abs<1?4:2);
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
  if(n>=1e9) return (n/1e9).toFixed(2)+'B';
  if(n>=1e6) return (n/1e6).toFixed(2)+'M';
  if(n>=1e3) return (n/1e3).toFixed(2)+'K';
  return n.toFixed(2);
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
  const tokensOut = (coin.tokenReserve * usdAmount) / (coin.solReserve + usdAmount);
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
    navigate('home');
    startBots();
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
    updatePortfolioVignette(state.userDoc);
    if(state.route.name==='profile') renderProfile();
    if(state.route.name==='portfolio') renderPortfolio();
  });
  state.unsubs.push(un);
}

/* ===================== PORTFOLIO VIGNETTE ===================== */
// A subtle full-screen pulsing edge glow that reflects how your day is going — red when you're
// deep in the red, green when you're way up. Only kicks in once today's swing is dramatic enough
// (±12%) so it's not just always-on background noise for normal fluctuations.
let vignetteEl = null;
function updatePortfolioVignette(u){
  if(!vignetteEl){
    vignetteEl = document.createElement('div');
    vignetteEl.id = 'portfolioVignette';
    document.body.appendChild(vignetteEl);
  }
  const { pct } = todaysChange(u);
  const THRESHOLD = 12;
  if(pct >= THRESHOLD){
    const intensity = Math.min(1, (pct-THRESHOLD)/40);
    vignetteEl.className = 'vignette-up';
    vignetteEl.style.opacity = (0.35+intensity*0.5).toFixed(2);
  } else if(pct <= -THRESHOLD){
    const intensity = Math.min(1, (Math.abs(pct)-THRESHOLD)/40);
    vignetteEl.className = 'vignette-down';
    vignetteEl.style.opacity = (0.35+intensity*0.5).toFixed(2);
  } else {
    vignetteEl.className = '';
    vignetteEl.style.opacity = '0';
  }
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
  if(name!=='coin') stopViewerCount();
  document.querySelectorAll('.nav-item,.bn-item').forEach(el=>{
    el.classList.toggle('active', el.dataset.nav===name);
  });
  if(name==='home') renderHome();
  else if(name==='create') renderCreate();
  else if(name==='portfolio') renderPortfolio();
  else if(name==='leaderboard') renderLeaderboard();
  else if(name==='profile') renderProfile();
  else if(name==='coin') renderCoinDetail(param);
  else if(name==='user') renderUserProfile(param);
  else if(name==='activity') renderActivity();
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
  const botCount = 10 + Math.floor(Math.random()*41); // 10-50
  const durationMs = 10000;
  toast(`🚀 Pump activated — ${botCount} bots aping in over the next 10 seconds`, 'ok');
  for(let i=0;i<botCount;i++){
    const delay = Math.random()*durationMs;
    setTimeout(()=>{
      const usd = 8 + Math.random()*220;
      botBuyOnCoin(coinId, usd, usd>150);
    }, delay);
  }
  setTimeout(()=> activePumps.delete(coinId), durationMs+3000);
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
    </div>
    <div class="cat-blurb" id="categoryBlurb"></div>
    <div class="searchbar">🔍 <input id="homeSearch" placeholder="Search by name or ticker..."></div>
    <div class="chip-row" id="sortChips">
      <div class="chip" data-sort="new">🆕 New</div>
      <div class="chip" data-sort="cap">💰 Market Cap</div>
      <div class="chip" data-sort="gainers">🔥 Gainers</div>
      <div class="chip" data-sort="losers">📉 Losers</div>
    </div>
    <div id="coinGrid" class="coin-grid"><div class="spinner" style="margin-top:40px;"></div></div>
  `;
  const blurb = document.getElementById('categoryBlurb');
  function updateBlurb(){
    blurb.textContent = homeCategory==='bot'
      ? "Fully simulated coins — nobody launched these, prices move automatically 24/7. Real market, real trades, but the counterparty pressure is bots, not people. Good for practicing reads on volatility."
      : "Coins launched by real people. Price only moves when someone actually buys or sells.";
  }
  updateBlurb();
  document.querySelectorAll('#categoryChips .chip').forEach(c=>{
    c.classList.toggle('active', c.dataset.cat===homeCategory);
    c.addEventListener('click', ()=>{ homeCategory=c.dataset.cat; document.querySelectorAll('#categoryChips .chip').forEach(x=>x.classList.remove('active')); c.classList.add('active'); updateBlurb(); loadHomeCoins(); });
  });
  document.querySelectorAll('#sortChips .chip').forEach(c=>{
    c.classList.toggle('active', c.dataset.sort===homeSort);
    c.addEventListener('click', ()=>{ homeSort=c.dataset.sort; document.querySelectorAll('#sortChips .chip').forEach(x=>x.classList.remove('active')); c.classList.add('active'); loadHomeCoins(); });
  });
  document.getElementById('homeSearch').addEventListener('input', ()=> loadHomeCoins());
  loadHomeCoins();
}

function loadHomeCoins(){
  if(homeUnsub) homeUnsub();
  const sortField = homeSort==='cap'?'marketCap':'createdAt';
  // Bot Market is a server-side filter (needs a composite index — see SETUP.md); Community stays
  // an unfiltered query + client-side exclusion so older coins launched before this feature
  // (which have no isBotCoin field at all) still show up correctly.
  const q = homeCategory==='bot'
    ? query(collection(db,'coins'), where('isBotCoin','==',true), orderBy(sortField,'desc'), limit(60))
    : query(collection(db,'coins'), orderBy(sortField,'desc'), limit(60));
  homeUnsub = onSnapshot(q, snap=>{
    let coins = snap.docs.map(d=>({id:d.id,...d.data()}));
    coins.forEach(c=> state.coinsCache.set(c.id,c));
    if(homeCategory==='user') coins = coins.filter(c=> !c.isBotCoin);
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
        ${c.ruggedAt?'<div class="grad-badge rug-badge">💀 RUGGED</div>':(c.isBotCoin?'<div class="grad-badge bot-badge">🤖 BOT</div>':(mc>=GRAD_MARKET_CAP?'<div class="grad-badge">🎓 GRAD</div>':''))}
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
let coinUnsub = null, chartRange='1h', shellCoinId=null, currentRecalc=null;
function renderCoinDetail(coinId){
  if(coinUnsub) coinUnsub();
  if(state.chart){ state.chart.destroy(); state.chart=null; }
  state.tradeMode='buy'; state.tradeAmount=0; shellCoinId=null; currentRecalc=null;
  const view = document.getElementById('view');
  view.innerHTML = `<div class="spinner" style="margin-top:60px;"></div>`;
  coinUnsub = onSnapshot(doc(db,'coins',coinId), snap=>{
    if(!snap.exists()){ view.innerHTML = `<div class="empty"><div class="em-ic">💀</div>This coin no longer exists.</div>`; return; }
    const coin = {id:snap.id, ...snap.data()};
    state.coinsCache.set(coin.id, coin);
    if(shellCoinId !== coin.id){
      shellCoinId = coin.id;
      buildCoinDetailShell(coin); // full DOM build — only happens once per coin visit
    } else {
      updateCoinDetailLive(coin); // cheap in-place refresh — keeps inputs/focus intact
    }
  });
  state.unsubs.push(coinUnsub);
}

function buildCoinDetailShell(coin){
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
            <div class="detail-ticker" id="detailTicker">$${esc(coin.ticker)} ${coin.ruggedAt?'<span class="grad-badge rug-badge">💀 RUGGED — delisting soon</span>':(coin.isBotCoin?'<span class="grad-badge bot-badge">🤖 BOT MARKET</span>':(mc>=GRAD_MARKET_CAP?'<span class="grad-badge">🎓 GRADUATED</span>':''))}</div>
            <div class="detail-name">${coin.isBotCoin? `${esc(coin.name)} · fully automated, trades 24/7 · ${(coin.tradeCount||0).toLocaleString()} trades so far` : `${esc(coin.name)} · launched by @${esc(coin.creatorUsername)} · ${timeAgo(coin.createdAt)}`}</div>
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
          <div style="font-weight:700;margin-bottom:10px;">Top Holders</div>
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
      </div>
    </div>
  `;

  document.getElementById('backBtn').addEventListener('click', ()=> navigate('home'));
  wireUserLinks(view);
  loadTopHolders(coin.id);
  startViewerCount(coin);
  drawChart(coin, true);
  document.querySelectorAll('#rangeRow .range-btn').forEach(b=>{
    b.addEventListener('click', ()=>{ chartRange=b.dataset.range; document.querySelectorAll('#rangeRow .range-btn').forEach(x=>x.classList.remove('active')); b.classList.add('active'); drawChart(coin, true); });
  });
  document.querySelectorAll('.trade-tab').forEach(t=>{
    t.addEventListener('click', ()=>{ state.tradeMode=t.dataset.mode; state.tradeAmount=0; rebuildTradePanel(coin); });
  });
  wireTradePanel(coin);
}

function recentTradesHtml(trades){
  if(!trades.length) return '<div class="empty" style="padding:20px;">No trades yet — be the first!</div>';
  return trades.slice(0,14).map(t=>`
    <div class="holder-line">
      <div class="user-link" data-uid="${t.isBot?'':(t.uid||'')}" style="display:flex;align-items:center;gap:8px;${t.isBot?'':'cursor:pointer;'}">
        <img class="avatar-sm" src="${avatarFor(t.username, t.avatarURL)}" style="border-radius:50%;">
        <span>${t.isBot?'🤖 ':''}@${esc(t.username)}${t.isExplosion?' 💥':''}${t.isDump?' 📉':''}</span>
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
          <span>@${esc(h.username||'anon')}</span>
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
  if(tickerEl) tickerEl.innerHTML = `$${esc(coin.ticker)} ${coin.ruggedAt?'<span class="grad-badge rug-badge">💀 RUGGED — delisting soon</span>':(coin.isBotCoin?'<span class="grad-badge bot-badge">🤖 BOT MARKET</span>':(mc>=GRAD_MARKET_CAP?'<span class="grad-badge">🎓 GRADUATED</span>':''))}`;
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
  if(coin.ruggedAt){
    return `<div class="empty" style="padding:24px 12px;">💀 This coin got rugged and is being delisted. You can still sell to exit, but buying is disabled.</div>`;
  }
  return `
    <div class="amt-display"><input id="tradeAmt" inputmode="decimal" placeholder="$0" value="${state.tradeAmount||''}"></div>
    <div class="amt-sub">Balance: ${fmtUsd(bal)}</div>
    <div class="quick-row">
      <div class="quick-btn" data-amt="5">$5</div>
      <div class="quick-btn" data-amt="20">$20</div>
      <div class="quick-btn" data-amt="50">$50</div>
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
    img.crossOrigin = 'anonymous';
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
    markers.push({ index:bestIdx, trade:t, img:getAvatarImg(t.avatarURL) });
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

async function doBuy(coinId, usdAmount){
  if(!usdAmount || usdAmount<=0){ toast('Enter an amount to buy.', 'err'); return; }
  const btn = document.getElementById('tradeSubmit');
  const originalBtnText = btn?.textContent;
  if(btn){ btn.disabled=true; btn.textContent='Buying…'; }
  coinsWithPendingUserTrade.add(coinId);
  try{
    const result = await runTransaction(db, async (tx)=>{
      const userRef = doc(db,'users',state.uid);
      const coinRef = doc(db,'coins',coinId);
      const holdRef = doc(db,'users',state.uid,'holdings',coinId);
      const [userSnap, coinSnap, holdSnap] = await Promise.all([tx.get(userRef), tx.get(coinRef), tx.get(holdRef)]);
      if(!userSnap.exists() || !coinSnap.exists()) throw new Error('Not found.');
      const user = userSnap.data(); const coin = coinSnap.data();
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
        const capped = ammBuy(coin, finalUsd);
        tokensOut = capped.tokensOut; newSol = capped.newSol; newTok = capped.newTok; newPrice = capped.newPrice;
        wasCapped = true;
      }

      if(!(tokensOut>0)) throw new Error('Amount too small to result in a trade.');
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (coin.recentTrades||[]).concat([{uid:state.uid, username:state.userDoc.username, avatarURL:state.userDoc.avatarURL||'', type:'buy', usdAmount:finalUsd, tokenAmount:tokensOut, t:Date.now()}]).slice(-14);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*totalSupplyOf(coin), priceHistory:hist, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1, lastTickAt:Date.now() });
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
        updatedAt: Date.now()
      }, {merge:true});
      const activityRef = doc(collection(db,'activity'));
      tx.set(activityRef, {
        uid: state.uid, username: state.userDoc.username, avatarURL: state.userDoc.avatarURL||'',
        type:'buy', usdAmount: finalUsd, tokenAmount: tokensOut,
        coinId: coin.id||coinId, ticker: coin.ticker, coinName: coin.name, coinImage: coin.imageURL||'',
        createdAt: serverTimestamp()
      });
      return { tokensOut, wasCapped, finalUsd };
    });
    if(result.wasCapped) toast(`Bought ${fmtTok(result.tokensOut)} tokens for ${fmtUsd(result.finalUsd)} — capped at ${Math.round(MAX_OWNERSHIP_PCT*100)}% ownership, rest refunded.`, 'ok');
    else toast(`Bought ${fmtTok(result.tokensOut)} tokens!`, 'ok');
    state.tradeAmount = 0;
    const nw = await refreshNetWorthSnapshot();
    checkMilestones(null, nw);
    checkRankOvertake();
  }catch(err){ toast(err.message, 'err'); }
  coinsWithPendingUserTrade.delete(coinId);
  if(btn){ btn.disabled=false; if(originalBtnText!=null) btn.textContent=originalBtnText; }
}

async function doSell(coinId, tokenAmount){
  if(!tokenAmount || tokenAmount<=0){ toast('Enter an amount to sell.', 'err'); return; }
  const btn = document.getElementById('tradeSubmit');
  const originalBtnText = btn?.textContent;
  if(btn){ btn.disabled=true; btn.textContent='Selling…'; }
  coinsWithPendingUserTrade.add(coinId);
  try{
    const result = await runTransaction(db, async (tx)=>{
      const userRef = doc(db,'users',state.uid);
      const coinRef = doc(db,'coins',coinId);
      const holdRef = doc(db,'users',state.uid,'holdings',coinId);
      const [userSnap, coinSnap, holdSnap] = await Promise.all([tx.get(userRef), tx.get(coinRef), tx.get(holdRef)]);
      if(!userSnap.exists() || !coinSnap.exists()) throw new Error('Not found.');
      const user = userSnap.data(); const coin = coinSnap.data();
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
      if(!(usdOut>0)) throw new Error('Amount too small to result in a trade.');
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (coin.recentTrades||[]).concat([{uid:state.uid, username:state.userDoc.username, avatarURL:state.userDoc.avatarURL||'', type:'sell', usdAmount:usdOut, tokenAmount, t:Date.now()}]).slice(-14);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*totalSupplyOf(coin), priceHistory:hist, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1, lastTickAt:Date.now() });
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
        closedAt: Date.now()
      });
      return { usdOut, pnl: usdOut-costRemoved };
    });
    toast(`Sold for ${fmtUsd(result.usdOut)}!`, 'ok');
    state.tradeAmount = 0;
    const nw = await refreshNetWorthSnapshot();
    checkMilestones(result.pnl, nw);
    checkRankOvertake();
  }catch(err){ toast(err.message, 'err'); }
  coinsWithPendingUserTrade.delete(coinId);
  if(btn){ btn.disabled=false; if(originalBtnText!=null) btn.textContent=originalBtnText; }
}

// Best-effort snapshot of the current user's total net worth (cash + all holdings at current
// price), appended to a timestamped history on their user doc. Powers the daily/weekly/all-time
// leaderboard views. Never blocks or throws into the calling trade flow — if this fails for any
// reason (offline, etc.) the trade itself has already succeeded.
async function refreshNetWorthSnapshot(){
  try{
    const holdSnap = await getDocs(collection(db,'users',state.uid,'holdings'));
    const holdings = holdSnap.docs.map(d=>({id:d.id,...d.data()})).filter(h=>h.tokens>0.0001);
    let holdingsVal = 0;
    for(const h of holdings){
      let coin = state.coinsCache.get(h.id);
      if(!coin){ const cs = await getDoc(doc(db,'coins',h.id)); if(cs.exists()) coin = {id:cs.id,...cs.data()}; }
      if(coin) holdingsVal += sellValue(coin, h.tokens);
    }
    const uSnap = await getDoc(doc(db,'users',state.uid));
    if(!uSnap.exists()) return null;
    const u = uSnap.data();
    const netWorth = (u.balance||0) + holdingsVal;
    const now = Date.now();
    const cutoffKeep = now - 35*86400000; // keep ~5 weeks of history, plenty for daily/weekly lookback
    let hist = (u.netWorthHistory||[]).filter(h=>h.t>=cutoffKeep);
    hist.push({t:now, nw:netWorth});
    if(hist.length>300) hist = hist.slice(-300);
    await updateDoc(doc(db,'users',state.uid), { netWorth, netWorthHistory: hist });
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
const BOT_TICK_MS = 14000;           // how often this tab rolls the dice
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

const WHALE_THRESHOLD = 500; // usd — triggers a platform-wide whale alert toast for anyone online

async function botBuyOnCoin(coinId, usdAmount, isExplosion){
  try{
    let whaleInfo = null;
    await runTransaction(db, async (tx)=>{
      const coinRef = doc(db,'coins',coinId);
      const coinSnap = await tx.get(coinRef);
      if(!coinSnap.exists()) return;
      const coin = coinSnap.data();
      const { tokensOut, newSol, newTok, newPrice } = ammBuy(coin, usdAmount);
      if(!(tokensOut>0)) return;
      const botName = randBotName();
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (coin.recentTrades||[]).concat([{uid:'bot', username:botName, type:'buy', usdAmount, tokenAmount:tokensOut, t:Date.now(), isBot:true, isExplosion:!!isExplosion}]).slice(-14);
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
async function botSellOnCoin(coinId, usdAmount, isDump){
  try{
    let whaleInfo = null;
    await runTransaction(db, async (tx)=>{
      const coinRef = doc(db,'coins',coinId);
      const coinSnap = await tx.get(coinRef);
      if(!coinSnap.exists()) return;
      const coin = coinSnap.data();
      const price = priceOf(coin);
      if(!(price>0)) return;
      let tokenAmount = usdAmount/price;
      const maxSellable = coin.tokenReserve*0.05; // cap so one dump can't crater the curve to near-zero
      if(tokenAmount > maxSellable) tokenAmount = maxSellable;
      const { usdOut, newSol, newTok, newPrice } = ammSell(coin, tokenAmount);
      if(!(usdOut>0)) return;
      const botName = randBotName();
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (coin.recentTrades||[]).concat([{uid:'bot', username:botName, type:'sell', usdAmount:usdOut, tokenAmount, t:Date.now(), isBot:true, isDump:!!isDump}]).slice(-14);
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
const BOT_COIN_SPAWN_CHANCE = 0.05;   // rolled roughly once a minute (see spawnCheckCounter below)
const BOT_COIN_TRADE_CHANCE = 0.75;   // per bot coin, per 14s tick — much livelier than young-coin noise
const BOT_COIN_QUERY_LIMIT = 30;
// Rare, dramatic crash-and-delist event — mirrors how real memecoins actually behave, and gives
// holding a bot coin genuine stakes instead of it just being a risk-free chart to watch. ~0.15%
// chance per coin per tick means most coins live a good while, but over a long enough run it's
// basically guaranteed eventually. After the crash, the coin sticks around briefly (so the crash
// is actually visible/tradeable) before being delisted to make room for a fresh spawn.
const BOT_COIN_RUG_CHANCE = 0.0015;
const BOT_COIN_RUG_MIN_AGE_MS = 15*60*1000; // too unfair to rug something seconds after it's born
const BOT_COIN_RUG_CLEANUP_MS = 45*1000;    // how long a rugged coin lingers, crashed, before delisting

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
  if(r<0.16) return 1200+Math.random()*6800;  // whale-sized swing — big, real volatility spikes
  if(r<0.50) return 150+Math.random()*650;    // medium
  return 10+Math.random()*120;                 // typical small/medium
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

function simulateBotCoinLaunch(){
  const totalSupply = BOT_COIN_SUPPLY_CHOICES[Math.floor(Math.random()*BOT_COIN_SUPPLY_CHOICES.length)];
  const startMcap = 2000+Math.random()*78000; // wide spread — some tiny, some near graduation-scale
  const initPrice = startMcap/totalSupply;
  const steps = 90;
  const stepGapMs = Math.floor((3+Math.random()*6)*3600000/steps); // spread over a fake 3-9hr past
  let p = initPrice;
  const priceHistory = [];
  const now = Date.now();
  for(let i=0;i<steps;i++){
    let mult;
    // Bigger and more frequent moves than a community coin's organic trading — this is what's
    // "priced in" as the coin's whole simulated history, so it should already look properly wild.
    if(Math.random()<0.14) mult = 1 + (Math.random()<0.5?-1:1)*(0.35+Math.random()*0.55); // big jump
    else mult = 1 + (Math.random()-0.5)*0.22; // energetic wobble
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
  return { priceHistory, currentPrice: p, tradeCountSeed: 900+Math.floor(Math.random()*5200), recentTrades, totalSupply };
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

async function spawnBotCoin(){
  try{
    const picked = await makeUniqueBotTicker();
    if(!picked) return;
    const { name, ticker } = picked;
    const { priceHistory, currentPrice, tradeCountSeed, recentTrades, totalSupply } = simulateBotCoinLaunch();
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
    await setDoc(coinRef, {
      name, ticker, description:'Fully automated market — no creator, no roadmap, just a chaotic 24/7 chart. Real trades are still real, only the counterparty is a bot.',
      imageURL:'', creatorUid:'bot', creatorUsername:'BotNet', isBotCoin:true, totalSupply,
      solReserve, tokenReserve,
      price: currentPrice, marketCap: currentPrice*totalSupply,
      priceHistory, recentTrades, tradeCount: tradeCountSeed,
      createdAt: serverTimestamp(), lastTickAt: Date.now()
    });
    await setDoc(doc(db,'tickers',ticker), { coinId: coinRef.id });
  }catch(err){ /* silent — e.g. a rare ticker race; next spawn check will just try again */ }
}

let botCoinSpawnCheckCounter = 0;
async function maybeSpawnBotCoin(){
  botCoinSpawnCheckCounter++;
  const isFirstCheck = botCoinSpawnCheckCounter === 1;
  if(!isFirstCheck && botCoinSpawnCheckCounter % 4 !== 0) return; // otherwise only check roughly once a minute
  try{
    const countSnap = await getCountFromServer(query(collection(db,'coins'), where('isBotCoin','==',true)));
    const count = countSnap.data().count;
    if(count >= BOT_COIN_POOL_CAP) return;
    // Bootstrap: if the pool is completely empty (e.g. first time this feature has ever run),
    // spawn a handful right away instead of waiting on the ~5%-per-minute probabilistic trickle —
    // otherwise Bot Market can sit empty for 15-20+ minutes before showing anything.
    if(count===0){
      const toSpawn = Math.min(5, BOT_COIN_POOL_CAP);
      for(let i=0;i<toSpawn;i++) spawnBotCoin();
      return;
    }
    if(Math.random() < BOT_COIN_SPAWN_CHANCE) spawnBotCoin();
  }catch(err){ /* ignore — e.g. missing index while Firestore builds one */ }
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
      if(tokensOut>0){
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
      if(usdOut>0){
        solReserve=newSol; tokenReserve=newTok; tradeCount++;
        hist.push({p:newPrice,t:simTime});
        trades.push({uid:'bot',username:randBotName(),type:'sell',usdAmount:usdOut,tokenAmount,t:simTime,isBot:true});
      }
    }
  }
  hist = hist.slice(-110); trades = trades.slice(-14);
  const newPrice = solReserve/tokenReserve;
  try{
    await updateDoc(doc(db,'coins',coinId), {
      solReserve, tokenReserve, price:newPrice, marketCap:newPrice*totalSupplyOf(coin),
      priceHistory:hist, recentTrades:trades, tradeCount, lastTickAt: Date.now()
    });
  }catch(err){ /* another tab may have just done the same catch-up — fine either way */ }
}

async function catchUpAllBotCoins(){
  try{
    const snap = await getDocs(query(collection(db,'coins'), where('isBotCoin','==',true), limit(BOT_COIN_QUERY_LIMIT)));
    for(const d of snap.docs) await catchUpBotCoin(d.id, d.data());
  }catch(err){ /* ignore — e.g. missing index while Firestore builds one */ }
}

async function botCoinTick(){
  try{
    const q = query(collection(db,'coins'), where('isBotCoin','==',true), limit(BOT_COIN_QUERY_LIMIT));
    const snap = await getDocs(q);
    snap.docs.forEach(d=>{
      if(coinsWithPendingUserTrade.has(d.id)) return; // don't fight a real trade in flight
      const coin = d.data();
      if(coin.ruggedAt){
        if(Date.now()-toMillisLoose(coin.ruggedAt) > BOT_COIN_RUG_CLEANUP_MS) cleanupRuggedCoin(d.id, coin);
        return;
      }
      const ageMs = Date.now()-toMillisLoose(coin.createdAt);
      if(ageMs > BOT_COIN_RUG_MIN_AGE_MS && Math.random() < BOT_COIN_RUG_CHANCE){ ruggedCoinEvent(d.id); return; }
      if(Math.random() >= BOT_COIN_TRADE_CHANCE) return;
      const bias = botCoinTrendBias(d.id);
      const buyChance = Math.min(0.95, Math.max(0.05, 0.5+bias*0.5));
      const usd = botCoinTradeSize();
      const big = usd>800;
      // Stagger across most of the tick window instead of firing every qualifying coin's
      // transaction in the same synchronous instant — this loop can touch up to 30 coins per
      // tick, so without spreading them out that's up to ~20+ concurrent Firestore transactions
      // landing at once, which is what made real buys/sells occasionally take ages.
      setTimeout(()=>{
        if(coinsWithPendingUserTrade.has(d.id)) return; // re-check — a trade may have started since
        if(Math.random() < buyChance) botBuyOnCoin(d.id, usd, big);
        else botSellOnCoin(d.id, usd, big);
      }, Math.random()*12000);
    });
  }catch(err){ /* ignore — e.g. missing index while Firestore builds one */ }
  maybeSpawnBotCoin();
}

async function ruggedCoinEvent(coinId){
  let ticker = '';
  try{
    await runTransaction(db, async (tx)=>{
      const coinRef = doc(db,'coins',coinId);
      const snap = await tx.get(coinRef);
      if(!snap.exists()) return;
      const c = snap.data();
      if(c.ruggedAt) return; // already rugged by another tab racing this same tick
      ticker = c.ticker;
      const crashFactor = 0.02+Math.random()*0.08; // keep 2-10% of liquidity → 90-98% price crash
      const newSol = c.solReserve*crashFactor;
      const newPrice = newSol/c.tokenReserve;
      const hist = (c.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-110);
      const trades = (c.recentTrades||[]).concat([{uid:'bot', username:randBotName(), type:'sell', usdAmount:c.solReserve-newSol, tokenAmount:0, t:Date.now(), isBot:true, isRug:true}]).slice(-14);
      tx.update(coinRef, {
        solReserve:newSol, price:newPrice, marketCap:newPrice*totalSupplyOf(c),
        priceHistory:hist, recentTrades:trades, tradeCount:(c.tradeCount||0)+1,
        ruggedAt: Date.now(), lastTickAt: Date.now()
      });
    });
    if(ticker) toast(`💀 $${ticker} just got rugged — crashed ~90%+ in seconds.`, 'err');
  }catch(err){ /* silent — bot noise shouldn't surface errors to the user */ }
}

async function cleanupRuggedCoin(coinId, coin){
  try{
    await deleteDoc(doc(db,'coins',coinId));
    if(coin.ticker) await deleteDoc(doc(db,'tickers',coin.ticker)).catch(()=>{});
  }catch(err){ /* another tab may already be cleaning this one up — fine either way */ }
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
      const fire = (fn)=> setTimeout(()=>{ if(!coinsWithPendingUserTrade.has(d.id)) fn(); }, Math.random()*12000);
      if(r < (acc += BOT_EXPLODE_CHANCE)){
        fire(()=> botBuyOnCoin(d.id, 200+Math.random()*500, true));
      } else if(r < (acc += BOT_DUMP_CHANCE)){
        fire(()=> botSellOnCoin(d.id, 200+Math.random()*500, true));
      } else if(r < (acc += BOT_BUY_CHANCE)){
        fire(()=> botBuyOnCoin(d.id, 4+Math.random()*36, false));
      } else if(r < (acc += BOT_SELL_CHANCE)){
        fire(()=> botSellOnCoin(d.id, 4+Math.random()*36, false));
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
  scheduleNext(botTick, BOT_TICK_MS);
  scheduleNext(botCoinTick, BOT_TICK_MS);
}
function stopBots(){ botRunning = false; }
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
    </div>
  `;
  const urlInput = document.getElementById('cImgUrl');
  const preview = document.getElementById('createImgPreview');
  urlInput.addEventListener('input', ()=>{
    const v = urlInput.value.trim();
    preview.innerHTML = v ? `<img src="${esc(v)}" onerror="this.parentElement.innerHTML='<span class=&quot;plus&quot;>⚠️</span>'">` : `<span class="plus">🖼️</span>`;
  });
  document.getElementById('createSubmit').addEventListener('click', submitCreateCoin);
}

async function submitCreateCoin(){
  const name = document.getElementById('cName').value.trim();
  const ticker = document.getElementById('cTicker').value.trim().toUpperCase();
  const desc = document.getElementById('cDesc').value.trim();
  if(name.length<2){ toast('Enter a coin name.', 'err'); return; }
  if(!/^[A-Z0-9]{2,8}$/.test(ticker)){ toast('Ticker must be 2-8 letters/numbers.', 'err'); return; }
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
    <div class="section-title" style="font-size:16px;">Your Holdings</div>
    <div id="holdingsList"><div class="spinner"></div></div>
  `;
  drawNetWorthChart('pfChart', state.userDoc?.netWorthHistory);
  const holdSnap = await getDocs(collection(db,'users',state.uid,'holdings'));
  const holdings = holdSnap.docs.map(d=>({id:d.id,...d.data()})).filter(h=>h.tokens>0.0001);
  let holdingsVal = 0;
  const rows = [];
  for(const h of holdings){
    let coin = state.coinsCache.get(h.id);
    if(!coin){ const cs = await getDoc(doc(db,'coins',h.id)); if(cs.exists()) coin = {id:cs.id,...cs.data()}; }
    if(!coin) continue;
    const price = priceOf(coin);
    const val = sellValue(coin, h.tokens);
    const costBasis = h.costBasis||0;
    const pnl = val-costBasis;
    holdingsVal += val;
    rows.push({h, coin, price, val, pnl});
  }
  const cash = state.userDoc?.balance||0;
  document.getElementById('pfTotal').textContent = fmtUsd(cash+holdingsVal);
  document.getElementById('pfCash').textContent = fmtUsd(cash);
  document.getElementById('pfHoldingsVal').textContent = fmtUsd(holdingsVal);
  document.getElementById('pfCoinsCount').textContent = rows.length;

  const list = document.getElementById('holdingsList');
  if(rows.length===0){ list.innerHTML = `<div class="empty"><div class="em-ic">📭</div>No holdings yet. Head to Explore and buy your first coin!</div>`; return; }
  list.innerHTML = rows.map(r=>{
    const up = r.pnl>=0;
    return `
    <div class="hold-row" data-coin="${r.coin.id}">
      <img class="coin-logo" src="${coinLogoFor(r.coin.ticker,r.coin.imageURL)}">
      <div class="hold-info">
        <div class="coin-ticker">$${esc(r.coin.ticker)}</div>
        <div class="coin-name">${fmtTok(r.h.tokens)} tokens</div>
      </div>
      <div class="hold-right">
        <div class="hold-val mono">${fmtUsd(r.val)}</div>
        <div class="mono" style="font-size:11.5px;color:${up?'var(--up)':'var(--down)'};">${up?'▲':'▼'} ${fmtUsd(Math.abs(r.pnl))}</div>
      </div>
    </div>`;}).join('');
  list.querySelectorAll('.hold-row').forEach(el=> el.addEventListener('click', ()=> navigate('coin', el.dataset.coin)));
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
function listenWhaleAlerts(){
  whaleAlertsReady = false;
  const q = query(collection(db,'activity'), orderBy('createdAt','desc'), limit(5));
  const un = onSnapshot(q, snap=>{
    if(!whaleAlertsReady){ whaleAlertsReady = true; return; } // skip the initial existing batch
    snap.docChanges().forEach(change=>{
      if(change.type!=='added') return;
      const t = change.doc.data();
      if(!(t.usdAmount>=WHALE_THRESHOLD)) return;
      const verb = t.type==='buy' ? 'dropped' : 'pulled';
      toast(`🐋 @${t.username} just ${verb} ${fmtUsd(t.usdAmount)} ${t.type==='buy'?'into':'out of'} $${t.ticker}!`, 'ok', ()=> navigate('coin', t.coinId));
    });
  }, ()=>{ /* silent — non-critical */ });
  state.unsubs.push(un);
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
  const q = query(collection(db,'activity'), orderBy('createdAt','desc'), limit(50));
  activityUnsub = onSnapshot(q, snap=>{
    if(!list) return;
    const items = snap.docs.map(d=>({id:d.id,...d.data()}));
    if(!items.length){ list.innerHTML = `<div class="empty"><div class="em-ic">🕒</div>No trades yet — activity will show up here as people buy and sell.</div>`; return; }
    list.innerHTML = items.map(t=>`
      <div class="holder-line">
        <div class="user-link" data-uid="${t.uid||''}" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <img class="avatar-sm" src="${avatarFor(t.username, t.avatarURL)}" style="border-radius:50%;">
          <span>@${esc(t.username)}</span>
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
      loadLeaderboard();
    });
  });
  loadLeaderboard();
}

// Prefix search on usernameLower (already stored on every user doc for signup uniqueness checks).
// A true fuzzy/substring search isn't practical with Firestore's query model, but prefix search
// covers "jump straight to someone's profile by username" well enough for a friends-scale app.
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
    let holdingsVal = 0;
    for(const d of holdSnap.docs){
      const h = d.data();
      if(!(h.tokens>0.0001)) continue;
      let coin = state.coinsCache.get(d.id);
      if(!coin){ const cs = await getDoc(doc(db,'coins',d.id)); if(cs.exists()){ coin = {id:cs.id,...cs.data()}; state.coinsCache.set(d.id, coin); } }
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
      const live = await liveNetWorthFor(u.uid, u.balance);
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
          <span>@${esc(r.username)}</span>
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

/* ===================== POSITIONS (shared by own + public profile) ===================== */
// Reads a user's holdings subcollection and splits it into open positions (still holding tokens)
// and closed ones (fully exited at some point, i.e. had activity but zero tokens left now).
// Requires holdings to be readable by any signed-in user (see updated Firestore rules in
// SETUP.md) so a public profile can show someone else's positions, not just your own.
async function loadPositions(uid){
  const holdSnap = await getDocs(collection(db,'users',uid,'holdings'));
  const holdings = holdSnap.docs.map(d=>({id:d.id,...d.data()})).filter(h=>h.tokens>0.0001);
  const open = [];
  for(const h of holdings){
    let coin = state.coinsCache.get(h.id);
    if(!coin){ const cs = await getDoc(doc(db,'coins',h.id)); if(cs.exists()){ coin = {id:cs.id, ...cs.data()}; state.coinsCache.set(h.id, coin); } }
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
  view.innerHTML = `
    <div class="back-btn" id="backBtn">← Back</div>
    <div class="profile-head">
      <img class="avatar-lg" src="${avatarFor(u.username,u.avatarURL)}">
      <div>
        <div class="profile-name">@${esc(u.username)}</div>
        <div class="profile-bio">${esc(u.bio)||'No bio yet.'}</div>
        <div class="mono" style="font-size:13px;font-weight:600;margin-top:4px;color:${todayUp?'var(--up)':'var(--down)'};">${todayUp?'▲':'▼'} ${Math.abs(today.pct).toFixed(1)}% today (${todayUp?'+':'-'}${fmtUsd(Math.abs(today.change))})</div>
      </div>
    </div>
    <div class="panel">
      <div class="settings-row"><span>Overall account balance</span><b class="mono">${fmtUsd(u.netWorth ?? u.balance)}</b></div>
      <div class="settings-row"><span>Cash</span><b class="mono">${fmtUsd(u.balance)}</b></div>
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
  const u = state.userDoc; if(!u) return;
  const view = document.getElementById('view');
  const today = todaysChange(u);
  const todayUp = today.change>=0;
  view.innerHTML = `
    <div class="section-title">Profile</div>
    <div class="profile-head">
      <img class="avatar-lg" id="profAvatarImg" src="${avatarFor(u.username,u.avatarURL)}">
      <div>
        <div class="profile-name">@${esc(u.username)}</div>
        <div class="profile-bio">${esc(u.bio)||'No bio yet.'}</div>
        <div class="mono" style="font-size:13px;font-weight:600;margin-top:4px;color:${todayUp?'var(--up)':'var(--down)'};">${todayUp?'▲':'▼'} ${Math.abs(today.pct).toFixed(1)}% today (${todayUp?'+':'-'}${fmtUsd(Math.abs(today.change))})</div>
      </div>
    </div>
    <div class="panel">
      <div class="settings-row"><span>Avatar image URL</span><button class="btn btn-ghost" id="changeAvatarBtn">Edit</button></div>
      <div class="settings-row"><span>Bio</span><button class="btn btn-ghost" id="editBioBtn">Edit</button></div>
      <div class="settings-row"><span>Overall account balance</span><b class="mono">${fmtUsd(u.netWorth ?? u.balance)}</b></div>
      <div class="settings-row"><span>Cash</span><b class="mono">${fmtUsd(u.balance)}</b></div>
      <div class="settings-row"><span>Win rate</span><b class="mono" id="winRateStat">—</b></div>
      <div class="settings-row"><span>Streak</span><b class="mono" id="winStreakStat">—</b></div>
      <div class="settings-row" style="border:none;"><span>Trading style</span><b class="mono" id="handsStat">—</b></div>
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
  document.getElementById('changeAvatarBtn').addEventListener('click', ()=> openAvatarModal());
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
