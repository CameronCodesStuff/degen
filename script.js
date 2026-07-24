import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, onSnapshot, collection,
  query, orderBy, limit, runTransaction, serverTimestamp, where, getDocs, deleteField, Timestamp
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
const MAX_OWNERSHIP_TOKENS = INITIAL_TOKEN_RESERVE * MAX_OWNERSHIP_PCT;

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
function toast(msg, type=''){
  const c = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast '+type;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='.3s'; setTimeout(()=>el.remove(),300); }, 3200);
}
function esc(s){ const d=document.createElement('div'); d.textContent = s==null?'':s; return d.innerHTML; }

/* AMM math */
function priceOf(coin){ return coin.solReserve / coin.tokenReserve; }
function marketCapOf(coin){ return priceOf(coin) * INITIAL_TOKEN_RESERVE; }
function circulatingOf(coin){ return INITIAL_TOKEN_RESERVE - coin.tokenReserve; }

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
    navigate('home');
    startBots();
  } else {
    state.uid = null; state.userDoc = null;
    document.getElementById('app').classList.add('hidden');
    document.getElementById('authScreen').classList.remove('hidden');
    stopBots();
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
  const durationMs = 120000;
  toast(`🚀 Pump activated — ${botCount} bots aping in over the next 2 minutes`, 'ok');
  for(let i=0;i<botCount;i++){
    const delay = Math.random()*durationMs;
    setTimeout(()=>{
      const usd = 8 + Math.random()*220;
      botBuyOnCoin(coinId, usd, usd>150);
    }, delay);
  }
  setTimeout(()=> activePumps.delete(coinId), durationMs+3000);
}


let homeUnsub = null, homeSort='new';
function renderHome(){
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="section-title">Explore Coins</div>
    <div class="searchbar">🔍 <input id="homeSearch" placeholder="Search by name or ticker..."></div>
    <div class="chip-row" id="sortChips">
      <div class="chip" data-sort="new">🆕 New</div>
      <div class="chip" data-sort="cap">💰 Market Cap</div>
      <div class="chip" data-sort="gainers">🔥 Gainers</div>
      <div class="chip" data-sort="losers">📉 Losers</div>
    </div>
    <div id="coinGrid" class="coin-grid"><div class="spinner" style="margin-top:40px;"></div></div>
  `;
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
  const q = query(collection(db,'coins'), orderBy(sortField,'desc'), limit(60));
  homeUnsub = onSnapshot(q, snap=>{
    let coins = snap.docs.map(d=>({id:d.id,...d.data()}));
    coins.forEach(c=> state.coinsCache.set(c.id,c));
    const term = (document.getElementById('homeSearch')?.value||'').toLowerCase();
    if(term) coins = coins.filter(c=> c.ticker.toLowerCase().includes(term) || c.name.toLowerCase().includes(term));
    if(homeSort==='gainers') coins = coins.slice().sort((a,b)=> pctChange(b.priceHistory)-pctChange(a.priceHistory));
    if(homeSort==='losers') coins = coins.slice().sort((a,b)=> pctChange(a.priceHistory)-pctChange(b.priceHistory));
    renderCoinGrid(coins);
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
  if(coins.length===0){ grid.innerHTML = `<div class="empty" style="grid-column:1/-1;"><div class="em-ic">👻</div>No coins found. Be the first to launch one!</div>`; return; }
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
        ${mc>=GRAD_MARKET_CAP?'<div class="grad-badge">🎓 GRAD</div>':''}
      </div>
      ${sparklineSvg(c.priceHistory, up)}
      <div class="coin-card-mid">
        <div class="coin-price mono">${fmtPrice(price)}</div>
        <div class="coin-chg ${up?'up':'down'}">${up?'▲':'▼'} ${Math.abs(chg).toFixed(1)}%</div>
      </div>
      <div class="coin-card-foot"><span>MCAP ${fmtUsd(mc)}</span><span>by @${esc(c.creatorUsername)}</span></div>
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
            <div class="detail-ticker" id="detailTicker">$${esc(coin.ticker)} ${mc>=GRAD_MARKET_CAP?'<span class="grad-badge">🎓 GRADUATED</span>':''}</div>
            <div class="detail-name">${esc(coin.name)} · launched by @${esc(coin.creatorUsername)} · ${timeAgo(coin.createdAt)}</div>
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
            <div><div style="font-size:11.5px;color:var(--txt-dim);">SUPPLY</div><div class="mono" style="font-weight:600;">${fmtTok(INITIAL_TOKEN_RESERVE)}</div></div>
            <div><div style="font-size:11.5px;color:var(--txt-dim);">TRADES</div><div class="mono" style="font-weight:600;" id="liveTradeCount">${(coin.tradeCount||0)}</div></div>
          </div>
          <div class="chart-wrap"><canvas id="priceChart"></canvas></div>
          <div class="range-row" id="rangeRow">
            ${['1M','1H','1D','ALL'].map(r=>`<div class="range-btn ${r.toLowerCase()===chartRange?'active':''}" data-range="${r.toLowerCase()}">${r}</div>`).join('')}
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
            <span class="meta-tag user-link" data-uid="${coin.creatorUid||''}" style="cursor:pointer;">👤 @${esc(coin.creatorUsername)}</span>
            <span class="meta-tag" id="liveLiquidity">💧 Virtual liquidity ${fmtUsd(coin.solReserve)}</span>
          </div>
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
        <img class="avatar-sm" src="${avatarFor(t.username)}" style="border-radius:50%;">
        <span>${t.isBot?'🤖 ':''}@${esc(t.username)}${t.isExplosion?' 💥':''}${t.isDump?' 📉':''}</span>
      </div>
      <span class="${t.type==='buy'?'coin-chg up':'coin-chg down'}" style="padding:2px 7px;">${t.type==='buy'?'Bought':'Sold'}</span>
      <span class="amt mono">${fmtUsd(t.usdAmount)}</span>
    </div>`).join('');
}
function wireUserLinks(container){
  container.querySelectorAll('.user-link[data-uid]').forEach(el=>{
    if(!el.dataset.uid) return;
    el.addEventListener('click', ()=> openProfile(el.dataset.uid));
  });
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
  if(tickerEl) tickerEl.innerHTML = `$${esc(coin.ticker)} ${mc>=GRAD_MARKET_CAP?'<span class="grad-badge">🎓 GRADUATED</span>':''}`;
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
  if(chartRange==='1h') return 3600000;
  if(chartRange==='1d') return 86400000;
  return Infinity;
}

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
  const labels = windowed.map(p=> new Date(toMillis(p.t)).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second: chartRange==='1m'?'2-digit':undefined}));
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

  if(state.chart && !forceRebuild){
    // live update: patch data in place for a smooth, non-flickery redraw
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = prices;
    state.chart.data.datasets[0].borderColor = color;
    state.chart.data.datasets[0].pointRadius = pointRadii;
    state.chart.data.datasets[0].pointBackgroundColor = pointColors;
    state.chart.options.plugins.currentPriceLine.price = prices[prices.length-1];
    state.chart.options.plugins.currentPriceLine.color = color;
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
        tooltip:{ mode:'index', intersect:false,
        backgroundColor:'#161425', borderColor:'rgba(255,255,255,0.1)', borderWidth:1, padding:10,
        callbacks:{ label:(c)=> fmtPrice(c.parsed.y) } } },
      scales:{
        x:{ grid:{display:false}, ticks:{ color:'#615C7D', maxTicksLimit:6, font:{size:10} } },
        y:{ grid:{color:'rgba(255,255,255,0.05)'}, ticks:{ color:'#615C7D', font:{size:10}, callback:(v)=>fmtPrice(v) } }
      },
      interaction:{mode:'nearest',axis:'x',intersect:false}
    },
    plugins:[currentPriceLinePlugin]
  });
}
function toMillis(t){ if(!t) return Date.now(); if(t.toDate) return t.toDate().getTime(); if(t.seconds) return t.seconds*1000; return t; }

/* ===================== TRADE EXECUTION ===================== */
async function doBuy(coinId, usdAmount){
  if(!usdAmount || usdAmount<=0){ toast('Enter an amount to buy.', 'err'); return; }
  const btn = document.getElementById('tradeSubmit');
  if(btn){ btn.disabled=true; btn.textContent='Buying…'; }
  try{
    const result = await runTransaction(db, async (tx)=>{
      const userRef = doc(db,'users',state.uid);
      const coinRef = doc(db,'coins',coinId);
      const holdRef = doc(db,'users',state.uid,'holdings',coinId);
      const [userSnap, coinSnap, holdSnap] = await Promise.all([tx.get(userRef), tx.get(coinRef), tx.get(holdRef)]);
      if(!userSnap.exists() || !coinSnap.exists()) throw new Error('Not found.');
      const user = userSnap.data(); const coin = coinSnap.data();
      if(user.balance < usdAmount) throw new Error("You don't have enough balance.");
      const prevTokens = holdSnap.exists()? holdSnap.data().tokens:0;
      if(prevTokens >= MAX_OWNERSHIP_TOKENS) throw new Error("You already hold the max allowed 80% of this coin's supply.");

      let { tokensOut, newSol, newTok, newPrice } = ammBuy(coin, usdAmount);
      let finalUsd = usdAmount, wasCapped = false;

      // If this buy would push the buyer over 80% of total supply, only fill it up to the cap
      // and charge/refund accordingly instead of rejecting the whole trade outright.
      if(prevTokens + tokensOut > MAX_OWNERSHIP_TOKENS){
        const capTokens = MAX_OWNERSHIP_TOKENS - prevTokens;
        const denom = coin.tokenReserve - capTokens;
        if(!(capTokens>0) || denom<=0) throw new Error("Not enough of this coin left in the curve to buy more.");
        finalUsd = (capTokens*coin.solReserve)/denom;
        const capped = ammBuy(coin, finalUsd);
        tokensOut = capped.tokensOut; newSol = capped.newSol; newTok = capped.newTok; newPrice = capped.newPrice;
        wasCapped = true;
      }

      if(!(tokensOut>0)) throw new Error('Amount too small to result in a trade.');
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-160);
      const trades = (coin.recentTrades||[]).concat([{uid:state.uid, username:state.userDoc.username, type:'buy', usdAmount:finalUsd, tokenAmount:tokensOut, t:Date.now()}]).slice(-20);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*INITIAL_TOKEN_RESERVE, priceHistory:hist, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1 });
      tx.update(userRef, { balance: user.balance - finalUsd });
      // costBasis/totalBoughtUsd/realizedPnl power the open/closed positions shown on a profile.
      const prevHold = holdSnap.exists()? holdSnap.data() : {};
      tx.set(holdRef, {
        tokens: prevTokens+tokensOut, ticker:coin.ticker, name:coin.name, imageURL:coin.imageURL||'',
        costBasis: (prevHold.costBasis||0) + finalUsd,
        totalBoughtUsd: (prevHold.totalBoughtUsd||0) + finalUsd,
        totalSoldUsd: prevHold.totalSoldUsd||0, realizedPnl: prevHold.realizedPnl||0,
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
    if(result.wasCapped) toast(`Bought ${fmtTok(result.tokensOut)} tokens for ${fmtUsd(result.finalUsd)} — capped at 80% ownership, rest refunded.`, 'ok');
    else toast(`Bought ${fmtTok(result.tokensOut)} tokens!`, 'ok');
    state.tradeAmount = 0;
    refreshNetWorthSnapshot();
  }catch(err){ toast(err.message, 'err'); }
  if(btn){ btn.disabled=false; }
}

async function doSell(coinId, tokenAmount){
  if(!tokenAmount || tokenAmount<=0){ toast('Enter an amount to sell.', 'err'); return; }
  const btn = document.getElementById('tradeSubmit');
  if(btn){ btn.disabled=true; btn.textContent='Selling…'; }
  try{
    const result = await runTransaction(db, async (tx)=>{
      const userRef = doc(db,'users',state.uid);
      const coinRef = doc(db,'coins',coinId);
      const holdRef = doc(db,'users',state.uid,'holdings',coinId);
      const [userSnap, coinSnap, holdSnap] = await Promise.all([tx.get(userRef), tx.get(coinRef), tx.get(holdRef)]);
      if(!userSnap.exists() || !coinSnap.exists()) throw new Error('Not found.');
      const user = userSnap.data(); const coin = coinSnap.data();
      const owned = holdSnap.exists()? holdSnap.data().tokens:0;
      if(tokenAmount > owned+0.0000001) throw new Error("You don't own that many tokens.");
      const { usdOut, newSol, newTok, newPrice } = ammSell(coin, tokenAmount);
      if(!(usdOut>0)) throw new Error('Amount too small to result in a trade.');
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-160);
      const trades = (coin.recentTrades||[]).concat([{uid:state.uid, username:state.userDoc.username, type:'sell', usdAmount:usdOut, tokenAmount, t:Date.now()}]).slice(-20);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*INITIAL_TOKEN_RESERVE, priceHistory:hist, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1 });
      tx.update(userRef, { balance: user.balance + usdOut });
      // Peel off this sell's proportional share of cost basis to get realized P&L for the trade,
      // so open positions (unrealized) and closed positions (realized) can both be shown accurately.
      const prevHold = holdSnap.exists()? holdSnap.data() : {};
      const prevCostBasis = prevHold.costBasis||0;
      const avgCost = owned>0 ? prevCostBasis/owned : 0;
      const costRemoved = Math.min(prevCostBasis, avgCost*tokenAmount);
      tx.set(holdRef, {
        tokens: owned-tokenAmount, ticker:coin.ticker, name:coin.name, imageURL:coin.imageURL||'',
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
      return usdOut;
    });
    toast(`Sold for ${fmtUsd(result)}!`, 'ok');
    state.tradeAmount = 0;
    refreshNetWorthSnapshot();
  }catch(err){ toast(err.message, 'err'); }
  if(btn){ btn.disabled=false; }
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
    if(!uSnap.exists()) return;
    const u = uSnap.data();
    const netWorth = (u.balance||0) + holdingsVal;
    const now = Date.now();
    const cutoffKeep = now - 35*86400000; // keep ~5 weeks of history, plenty for daily/weekly lookback
    let hist = (u.netWorthHistory||[]).filter(h=>h.t>=cutoffKeep);
    hist.push({t:now, nw:netWorth});
    if(hist.length>300) hist = hist.slice(-300);
    await updateDoc(doc(db,'users',state.uid), { netWorth, netWorthHistory: hist });
  }catch(err){ /* leaderboard snapshotting is best-effort */ }
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
let botInterval = null;

function randBotName(){ return 'Bot'+(1000+Math.floor(Math.random()*9000)); }

async function botBuyOnCoin(coinId, usdAmount, isExplosion){
  try{
    await runTransaction(db, async (tx)=>{
      const coinRef = doc(db,'coins',coinId);
      const coinSnap = await tx.get(coinRef);
      if(!coinSnap.exists()) return;
      const coin = coinSnap.data();
      const { tokensOut, newSol, newTok, newPrice } = ammBuy(coin, usdAmount);
      if(!(tokensOut>0)) return;
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-160);
      const trades = (coin.recentTrades||[]).concat([{uid:'bot', username:randBotName(), type:'buy', usdAmount, tokenAmount:tokensOut, t:Date.now(), isBot:true, isExplosion:!!isExplosion}]).slice(-20);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*INITIAL_TOKEN_RESERVE, priceHistory:hist, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1 });
    });
    if(isExplosion) toast(`💥 A whale just aped into a new coin!`, 'ok');
  }catch(err){ /* silent — bot noise shouldn't surface errors to the user */ }
}

// Sell-side bot pressure, mirroring botBuyOnCoin. Bots don't carry real token inventory, so
// this treats the "sell" purely as curve math (same constant-product formula ammSell uses for
// real users) — it just pushes price back down instead of up. Without this, bot activity only
// ever ratchets price upward, which reads as fake; real memecoin charts pump AND dump.
async function botSellOnCoin(coinId, usdAmount, isDump){
  try{
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
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-160);
      const trades = (coin.recentTrades||[]).concat([{uid:'bot', username:randBotName(), type:'sell', usdAmount:usdOut, tokenAmount, t:Date.now(), isBot:true, isDump:!!isDump}]).slice(-20);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*INITIAL_TOKEN_RESERVE, priceHistory:hist, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1 });
    });
    if(isDump) toast(`📉 Paper hands are dumping a coin!`, 'err');
  }catch(err){ /* silent — bot noise shouldn't surface errors to the user */ }
}

async function botTick(){
  try{
    const cutoff = Timestamp.fromDate(new Date(Date.now()-BOT_YOUNG_MS));
    const q = query(collection(db,'coins'), where('createdAt','>',cutoff), limit(15));
    const snap = await getDocs(q);
    snap.docs.forEach(d=>{
      const coin = d.data();
      const mc = marketCapOf({...coin});
      if(mc >= GRAD_MARKET_CAP) return; // graduated coins are left alone
      // Single roll split into ranges so buy/sell/explode/dump stay mutually exclusive per tick.
      const r = Math.random();
      let acc = 0;
      if(r < (acc += BOT_EXPLODE_CHANCE)){
        botBuyOnCoin(d.id, 200+Math.random()*500, true);
      } else if(r < (acc += BOT_DUMP_CHANCE)){
        botSellOnCoin(d.id, 200+Math.random()*500, true);
      } else if(r < (acc += BOT_BUY_CHANCE)){
        botBuyOnCoin(d.id, 4+Math.random()*36, false);
      } else if(r < (acc += BOT_SELL_CHANCE)){
        botSellOnCoin(d.id, 4+Math.random()*36, false);
      }
    });
  }catch(err){ /* ignore — e.g. missing index while Firestore builds one */ }
}

function startBots(){
  if(botInterval) return;
  botInterval = setInterval(botTick, BOT_TICK_MS);
  setTimeout(botTick, 3000); // one early tick shortly after load
}
function stopBots(){ if(botInterval){ clearInterval(botInterval); botInterval=null; } }

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
      creatorUid: state.uid, creatorUsername: state.userDoc.username,
      solReserve: INITIAL_SOL_RESERVE, tokenReserve: INITIAL_TOKEN_RESERVE,
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
    <div class="section-title" style="font-size:16px;">Your Holdings</div>
    <div id="holdingsList"><div class="spinner"></div></div>
  `;
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
    <div class="chip-row" id="lbChips">
      <div class="chip" data-cat="daily">📅 Daily</div>
      <div class="chip" data-cat="weekly">🗓️ Weekly</div>
      <div class="chip" data-cat="alltime">👑 All-Time</div>
    </div>
    <div id="lbList"><div class="spinner" style="margin-top:40px;"></div></div>
  `;
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

async function loadLeaderboard(){
  const list = document.getElementById('lbList');
  if(!list) return;
  list.innerHTML = `<div class="spinner" style="margin-top:40px;"></div>`;
  try{
    refreshNetWorthSnapshot(); // keep our own row fresh; doesn't block the rest of the list
    const snap = await getDocs(query(collection(db,'users'), limit(200)));
    const users = snap.docs.map(d=>({uid:d.id, ...d.data()}));
    const rows = users
      .map(u=>({ uid:u.uid, username:u.username, avatarURL:u.avatarURL, current: u.netWorth ?? u.balance ?? STARTING_BALANCE, change: netWorthChange(u, lbCategory) }))
      .filter(r=>r.username)
      .sort((a,b)=> b.change-a.change)
      .slice(0,25);
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
  const holdings = holdSnap.docs.map(d=>({id:d.id,...d.data()}));
  const open = [], closed = [];
  for(const h of holdings){
    const everTraded = (h.totalBoughtUsd||0) > 0;
    if(!(h.tokens>0.0001) && !everTraded) continue;
    let coin = state.coinsCache.get(h.id);
    if(!coin){ const cs = await getDoc(doc(db,'coins',h.id)); if(cs.exists()){ coin = {id:cs.id, ...cs.data()}; state.coinsCache.set(h.id, coin); } }
    if(h.tokens>0.0001){
      const val = coin? sellValue(coin, h.tokens) : 0;
      open.push({ h, coin, val, pnl: val-(h.costBasis||0) });
    } else if(everTraded){
      closed.push({ h, coin });
    }
  }
  open.sort((a,b)=> b.val-a.val);
  closed.sort((a,b)=> (b.h.updatedAt||0)-(a.h.updatedAt||0));
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
  if(!closed.length) return '<div class="empty" style="padding:16px;">No closed positions yet.</div>';
  return closed.map(r=>{
    const pnl = r.h.realizedPnl||0;
    const up = pnl>=0;
    const ticker = r.coin?.ticker || r.h.ticker;
    return `
    <div class="hold-row" data-coin="${r.h.id}" style="cursor:pointer;">
      <img class="coin-logo" src="${coinLogoFor(ticker, r.coin?.imageURL||r.h.imageURL)}">
      <div class="hold-info">
        <div class="coin-ticker">$${esc(ticker)}</div>
        <div class="coin-name">Bought ${fmtUsd(r.h.totalBoughtUsd||0)} · Sold ${fmtUsd(r.h.totalSoldUsd||0)}</div>
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
  view.innerHTML = `
    <div class="back-btn" id="backBtn">← Back</div>
    <div class="profile-head">
      <img class="avatar-lg" src="${avatarFor(u.username,u.avatarURL)}">
      <div>
        <div class="profile-name">@${esc(u.username)}</div>
        <div class="profile-bio">${esc(u.bio)||'No bio yet.'}</div>
      </div>
    </div>
    <div class="panel">
      <div class="settings-row" style="border:none;"><span>Cash balance</span><b class="mono">${fmtUsd(u.balance)}</b></div>
    </div>
    <div class="section-title" style="font-size:16px;margin-top:20px;">Open Positions</div>
    <div id="openPosList"><div class="spinner"></div></div>
    <div class="section-title" style="font-size:16px;margin-top:20px;">Closed Positions</div>
    <div id="closedPosList"><div class="spinner"></div></div>
  `;
  document.getElementById('backBtn').addEventListener('click', ()=> navigate('leaderboard'));
  try{
    const { open, closed } = await loadPositions(uid);
    const openEl = document.getElementById('openPosList');
    const closedEl = document.getElementById('closedPosList');
    if(openEl){ openEl.innerHTML = openPositionsHtml(open); wirePositionRows(openEl); }
    if(closedEl){ closedEl.innerHTML = closedPositionsHtml(closed); wirePositionRows(closedEl); }
  }catch(err){
    const openEl = document.getElementById('openPosList');
    if(openEl) openEl.innerHTML = `<div class="empty">Couldn't load positions: ${esc(err.message)}</div>`;
    const closedEl = document.getElementById('closedPosList');
    if(closedEl) closedEl.innerHTML = '';
  }
}

/* ===================== PROFILE ===================== */
function renderProfile(){
  const u = state.userDoc; if(!u) return;
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="section-title">Profile</div>
    <div class="profile-head">
      <img class="avatar-lg" id="profAvatarImg" src="${avatarFor(u.username,u.avatarURL)}">
      <div>
        <div class="profile-name">@${esc(u.username)}</div>
        <div class="profile-bio">${esc(u.bio)||'No bio yet.'}</div>
      </div>
    </div>
    <div class="panel">
      <div class="settings-row"><span>Avatar image URL</span><button class="btn btn-ghost" id="changeAvatarBtn">Edit</button></div>
      <div class="settings-row"><span>Bio</span><button class="btn btn-ghost" id="editBioBtn">Edit</button></div>
      <div class="settings-row" style="border:none;"><span>Cash balance</span><b class="mono">${fmtUsd(u.balance)}</b></div>
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
  loadPositions(state.uid).then(({open, closed})=>{
    const openEl = document.getElementById('openPosList');
    const closedEl = document.getElementById('closedPosList');
    if(openEl){ openEl.innerHTML = openPositionsHtml(open); wirePositionRows(openEl); }
    if(closedEl){ closedEl.innerHTML = closedPositionsHtml(closed); wirePositionRows(closedEl); }
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
