import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, collection,
  query, orderBy, limit, runTransaction, serverTimestamp, where, getDocs, deleteField
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
const db = getFirestore(app);

/* ===================== CONSTANTS ===================== */
const STARTING_BALANCE = 100;
const CREATE_FEE = 5;
const INITIAL_SOL_RESERVE = 30;       // virtual "liquidity" seed
const INITIAL_TOKEN_RESERVE = 1_000_000_000; // 1B token supply per coin
const GRAD_MARKET_CAP = 69000;        // fun homage threshold
const K = INITIAL_SOL_RESERVE * INITIAL_TOKEN_RESERVE;

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
function fmtPrice(p){
  if(!p||isNaN(p)) return '$0.00';
  if(p>=1) return '$'+p.toFixed(4);
  if(p>=0.0001) return '$'+p.toFixed(6);
  return '$'+p.toExponential(2);
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
      balance: STARTING_BALANCE, createdAt: serverTimestamp()
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
  } else {
    state.uid = null; state.userDoc = null;
    document.getElementById('app').classList.add('hidden');
    document.getElementById('authScreen').classList.remove('hidden');
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
  else if(name==='profile') renderProfile();
  else if(name==='coin') renderCoinDetail(param);
  window.scrollTo(0,0);
}

/* ===================== HOME / EXPLORE ===================== */
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
let coinUnsub = null, chartRange='all';
function renderCoinDetail(coinId){
  if(coinUnsub) coinUnsub();
  state.tradeMode='buy'; state.tradeAmount=0;
  const view = document.getElementById('view');
  view.innerHTML = `<div class="spinner" style="margin-top:60px;"></div>`;
  coinUnsub = onSnapshot(doc(db,'coins',coinId), snap=>{
    if(!snap.exists()){ view.innerHTML = `<div class="empty"><div class="em-ic">💀</div>This coin no longer exists.</div>`; return; }
    const coin = {id:snap.id, ...snap.data()};
    state.coinsCache.set(coin.id, coin);
    paintCoinDetail(coin);
  });
  state.unsubs.push(coinUnsub);
}

function paintCoinDetail(coin){
  const view = document.getElementById('view');
  const price = priceOf(coin);
  const chg = pctChange(coin.priceHistory||[]);
  const up = chg>=0;
  const mc = marketCapOf(coin);
  const gradPct = Math.min(100, (mc/GRAD_MARKET_CAP)*100);
  const isOwn = coin.creatorUid===state.uid;
  const trades = (coin.recentTrades||[]).slice().reverse();

  view.innerHTML = `
    <div class="back-btn" id="backBtn">← Back to Explore</div>
    <div class="detail-grid">
      <div>
        <div class="detail-head">
          <img class="detail-logo" src="${coinLogoFor(coin.ticker,coin.imageURL)}">
          <div>
            <div class="detail-ticker">$${esc(coin.ticker)} ${mc>=GRAD_MARKET_CAP?'<span class="grad-badge">🎓 GRADUATED</span>':''}</div>
            <div class="detail-name">${esc(coin.name)} · launched by @${esc(coin.creatorUsername)} · ${timeAgo(coin.createdAt)}</div>
          </div>
        </div>
        <div class="price-row">
          <div class="price-big mono" id="livePrice">${fmtPrice(price)}</div>
          <div class="coin-chg ${up?'up':'down'}">${up?'▲':'▼'} ${Math.abs(chg).toFixed(1)}%</div>
        </div>
        <div class="panel">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;">
            <div><div style="font-size:11.5px;color:var(--txt-dim);">MARKET CAP</div><div class="mono" style="font-weight:600;">${fmtUsd(mc)}</div></div>
            <div><div style="font-size:11.5px;color:var(--txt-dim);">SUPPLY</div><div class="mono" style="font-weight:600;">${fmtTok(INITIAL_TOKEN_RESERVE)}</div></div>
            <div><div style="font-size:11.5px;color:var(--txt-dim);">HOLDERS TRADED</div><div class="mono" style="font-weight:600;">${(coin.tradeCount||0)}</div></div>
          </div>
          <div class="chart-wrap"><canvas id="priceChart"></canvas></div>
          <div class="range-row" id="rangeRow">
            ${['1H','1D','ALL'].map(r=>`<div class="range-btn ${r.toLowerCase()===chartRange?'active':''}" data-range="${r.toLowerCase()}">${r}</div>`).join('')}
          </div>
          <div style="margin-top:14px;">
            <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--txt-dim);margin-bottom:4px;">
              <span>Bonding curve progress</span><span>${gradPct.toFixed(1)}% to $${(GRAD_MARKET_CAP/1000)}K</span>
            </div>
            <div class="progress-track"><div class="progress-fill" style="width:${gradPct}%"></div></div>
          </div>
        </div>

        <div class="panel" style="margin-top:16px;">
          <div style="font-weight:700;margin-bottom:6px;">About $${esc(coin.ticker)}</div>
          <div class="desc-text">${esc(coin.description)||'No description provided.'}</div>
          <div class="meta-row">
            <span class="meta-tag">🎟️ ${esc(coin.ticker)}</span>
            <span class="meta-tag">👤 @${esc(coin.creatorUsername)}</span>
            <span class="meta-tag">💧 Virtual liquidity ${fmtUsd(coin.solReserve)}</span>
          </div>
        </div>

        <div class="panel" style="margin-top:16px;">
          <div style="font-weight:700;margin-bottom:10px;">Recent Trades</div>
          ${trades.length? trades.slice(0,12).map(t=>`
            <div class="holder-line">
              <img class="avatar-sm" src="${avatarFor(t.username)}" style="border-radius:50%;">
              <span>@${esc(t.username)}</span>
              <span class="${t.type==='buy'?'coin-chg up':'coin-chg down'}" style="padding:2px 7px;">${t.type==='buy'?'Bought':'Sold'}</span>
              <span class="amt mono">${fmtUsd(t.usdAmount)}</span>
            </div>`).join('') : '<div class="empty" style="padding:20px;">No trades yet — be the first!</div>'}
        </div>
      </div>

      <div class="trade-panel">
        <div class="panel">
          <div class="trade-tabs">
            <div class="trade-tab buy ${state.tradeMode==='buy'?'active':''}" data-mode="buy">Buy</div>
            <div class="trade-tab sell ${state.tradeMode==='sell'?'active':''}" data-mode="sell">Sell</div>
          </div>
          ${state.tradeMode==='buy'? buyPanelHtml(coin) : sellPanelHtml(coin)}
        </div>
      </div>
    </div>
  `;

  document.getElementById('backBtn').addEventListener('click', ()=> navigate('home'));
  drawChart(coin);
  document.querySelectorAll('#rangeRow .range-btn').forEach(b=>{
    b.addEventListener('click', ()=>{ chartRange=b.dataset.range; document.querySelectorAll('#rangeRow .range-btn').forEach(x=>x.classList.remove('active')); b.classList.add('active'); drawChart(coin); });
  });
  document.querySelectorAll('.trade-tab').forEach(t=>{
    t.addEventListener('click', ()=>{ state.tradeMode=t.dataset.mode; state.tradeAmount=0; paintCoinDetail(coin); });
  });
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
    <div class="amt-sub">You own: ${fmtTok(holding)} ${esc(coin.ticker)}</div>
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
  // fetch my holding for sell mode
  if(state.tradeMode==='sell'){
    const hSnap = await getDoc(doc(db,'users',state.uid,'holdings',coin.id));
    state.myHolding = hSnap.exists()? hSnap.data().tokens : 0;
    const sub = document.getElementById('amt-sub');
  }
  const input = document.getElementById('tradeAmt');
  const estOut = document.getElementById('estOut');
  const estImpact = document.getElementById('estImpact');
  function recalc(){
    const v = parseFloat(input.value)||0;
    state.tradeAmount = v;
    if(state.tradeMode==='buy'){
      const newSol = coin.solReserve+v;
      const newTok = K/newSol;
      const tokensOut = coin.tokenReserve-newTok;
      estOut.textContent = fmtTok(Math.max(0,tokensOut))+' '+coin.ticker;
      const oldPrice = priceOf(coin), newPrice = newSol/newTok;
      estImpact.textContent = (oldPrice? (((newPrice-oldPrice)/oldPrice)*100).toFixed(2):'0.00')+'%';
    } else {
      const tokIn = v;
      const newTok = coin.tokenReserve+tokIn;
      const newSol = K/newTok;
      const usdOut = coin.solReserve-newSol;
      estOut.textContent = fmtUsd(Math.max(0,usdOut));
      const oldPrice = priceOf(coin), newPrice = newSol/newTok;
      estImpact.textContent = (oldPrice? (((newPrice-oldPrice)/oldPrice)*100).toFixed(2):'0.00')+'%';
    }
  }
  input.addEventListener('input', recalc);
  recalc();

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

  document.getElementById('tradeSubmit').addEventListener('click', ()=>{
    if(state.tradeMode==='buy') doBuy(coin.id, parseFloat(input.value)||0);
    else doSell(coin.id, parseFloat(input.value)||0);
  });
}

function drawChart(coin){
  const ctx = document.getElementById('priceChart');
  if(!ctx) return;
  let hist = coin.priceHistory||[];
  if(chartRange==='1h') hist = hist.filter(p=> p.t && (Date.now()-toMillis(p.t)) <= 3600000);
  else if(chartRange==='1d') hist = hist.filter(p=> p.t && (Date.now()-toMillis(p.t)) <= 86400000);
  if(hist.length===0) hist = coin.priceHistory||[{p:priceOf(coin),t:Date.now()}];
  const labels = hist.map(p=> new Date(toMillis(p.t)).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));
  const prices = hist.map(p=>p.p);
  const up = prices[prices.length-1] >= prices[0];
  const color = up? '#C6FF3D' : '#FF4D6D';
  if(state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[{
      data: prices, borderColor: color, borderWidth:2.5, pointRadius:0, tension:.25,
      fill:true,
      backgroundColor: (context)=>{
        const g = context.chart.ctx.createLinearGradient(0,0,0,280);
        g.addColorStop(0, up? 'rgba(198,255,61,0.22)':'rgba(255,77,109,0.22)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        return g;
      }
    }]},
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ mode:'index', intersect:false,
        backgroundColor:'#161425', borderColor:'rgba(255,255,255,0.1)', borderWidth:1, padding:10,
        callbacks:{ label:(c)=> fmtPrice(c.parsed.y) } } },
      scales:{
        x:{ grid:{display:false}, ticks:{ color:'#615C7D', maxTicksLimit:6, font:{size:10} } },
        y:{ grid:{color:'rgba(255,255,255,0.05)'}, ticks:{ color:'#615C7D', font:{size:10}, callback:(v)=>fmtPrice(v) } }
      },
      interaction:{mode:'nearest',axis:'x',intersect:false}
    }
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
      const newSol = coin.solReserve + usdAmount;
      const newTok = K / newSol;
      const tokensOut = coin.tokenReserve - newTok;
      if(tokensOut<=0) throw new Error('Trade too small.');
      const newPrice = newSol/newTok;
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-80);
      const trades = (coin.recentTrades||[]).concat([{uid:state.uid, username:state.userDoc.username, type:'buy', usdAmount, tokenAmount:tokensOut, t:Date.now()}]).slice(-20);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*INITIAL_TOKEN_RESERVE, priceHistory:hist, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1 });
      tx.update(userRef, { balance: user.balance - usdAmount });
      const prevTokens = holdSnap.exists()? holdSnap.data().tokens:0;
      tx.set(holdRef, { tokens: prevTokens+tokensOut, ticker:coin.ticker, name:coin.name, imageURL:coin.imageURL||'', updatedAt: Date.now() }, {merge:true});
      return tokensOut;
    });
    toast(`Bought ${fmtTok(result)} tokens!`, 'ok');
    state.tradeAmount = 0;
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
      const newTok = coin.tokenReserve + tokenAmount;
      const newSol = K / newTok;
      const usdOut = coin.solReserve - newSol;
      if(usdOut<=0) throw new Error('Trade too small.');
      const newPrice = newSol/newTok;
      const hist = (coin.priceHistory||[]).concat([{p:newPrice, t:Date.now()}]).slice(-80);
      const trades = (coin.recentTrades||[]).concat([{uid:state.uid, username:state.userDoc.username, type:'sell', usdAmount:usdOut, tokenAmount, t:Date.now()}]).slice(-20);
      tx.update(coinRef, { solReserve:newSol, tokenReserve:newTok, price:newPrice, marketCap:newPrice*INITIAL_TOKEN_RESERVE, priceHistory:hist, recentTrades:trades, tradeCount:(coin.tradeCount||0)+1 });
      tx.update(userRef, { balance: user.balance + usdOut });
      tx.set(holdRef, { tokens: owned-tokenAmount, ticker:coin.ticker, name:coin.name, imageURL:coin.imageURL||'', updatedAt: Date.now() }, {merge:true});
      return usdOut;
    });
    toast(`Sold for ${fmtUsd(result)}!`, 'ok');
    state.tradeAmount = 0;
  }catch(err){ toast(err.message, 'err'); }
  if(btn){ btn.disabled=false; }
}

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
    const val = h.tokens*price;
    holdingsVal += val;
    rows.push({h, coin, price, val});
  }
  const cash = state.userDoc?.balance||0;
  document.getElementById('pfTotal').textContent = fmtUsd(cash+holdingsVal);
  document.getElementById('pfCash').textContent = fmtUsd(cash);
  document.getElementById('pfHoldingsVal').textContent = fmtUsd(holdingsVal);
  document.getElementById('pfCoinsCount').textContent = rows.length;

  const list = document.getElementById('holdingsList');
  if(rows.length===0){ list.innerHTML = `<div class="empty"><div class="em-ic">📭</div>No holdings yet. Head to Explore and buy your first coin!</div>`; return; }
  list.innerHTML = rows.map(r=>`
    <div class="hold-row" data-coin="${r.coin.id}">
      <img class="coin-logo" src="${coinLogoFor(r.coin.ticker,r.coin.imageURL)}">
      <div class="hold-info">
        <div class="coin-ticker">$${esc(r.coin.ticker)}</div>
        <div class="coin-name">${fmtTok(r.h.tokens)} tokens</div>
      </div>
      <div class="hold-right">
        <div class="hold-val mono">${fmtUsd(r.val)}</div>
        <div style="font-size:11.5px;color:var(--txt-dim);">${fmtPrice(r.price)}/tok</div>
      </div>
    </div>`).join('');
  list.querySelectorAll('.hold-row').forEach(el=> el.addEventListener('click', ()=> navigate('coin', el.dataset.coin)));
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
    <button class="btn btn-ghost btn-block" style="margin-top:20px;color:var(--down);" id="logoutBtn">Log Out</button>
  `;
  document.getElementById('logoutBtn').addEventListener('click', ()=> signOut(auth));
  document.getElementById('editBioBtn').addEventListener('click', ()=> openBioModal());
  document.getElementById('changeAvatarBtn').addEventListener('click', ()=> openAvatarModal());
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