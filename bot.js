// ============================================================
// FX Signal Pro — 24/7 Trading Bot
// Railway / Render — Node.js 18+ (built-in fetch)
// ============================================================

// Node 18+ has built-in fetch — no dependencies needed!

// ─── Config ─────────────────────────────────────────────────
const TD_KEY   = process.env.TD_KEY   || '2dfb3a0242474809967353a965e730f1';
const TD_KEY2  = process.env.TD_KEY2  || 'c6f15065c04c4a5a94722b40a297dd0f';
const TD_KEY3  = process.env.TD_KEY3  || 'a459b1e8d10240f2bff8dcb67e2ed5b6';
const TD_KEY4  = process.env.TD_KEY4  || 'c7ccc7b36d7b4fa3a1b16b7860196049';
const POLY_KEY = process.env.POLY_KEY || 'Vxe1pa2pDsqR2wt5XguyxYOH68DwTiKi';
const GROQ_KEY = process.env.GROQ_KEY || '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';
const TG_TOKEN = process.env.TG_TOKEN || '8427595283:AAFaoATV4Cq-45Fq_eruMLRFaJsOrCt6Ceo';
const TG_CHAT  = process.env.TG_CHAT  || '-1003612566723';
const SB_URL   = process.env.SUPABASE_URL || 'https://ugbowhydxxkpsamjxxai.supabase.co';
const SB_KEY   = process.env.SUPABASE_KEY || 'sb_publishable_I1wxgYYVPxo9PXhmBxpG5A_dYR2nsi9';

// ─── Supabase DB ─────────────────────────────────────────────
async function dbInsert(table, data){
  try{
    const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(data)
    });
    const result = await res.json();
    if(!res.ok) throw new Error(JSON.stringify(result));
    return Array.isArray(result) ? result[0] : result;
  }catch(e){
    log(`⚠️ DB insert ${table}: ${e.message}`);
    return null;
  }
}

async function dbUpdate(table, match, data){
  try{
    const params = Object.entries(match).map(([k,v])=>`${k}=eq.${v}`).join('&');
    const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`
      },
      body: JSON.stringify(data)
    });
    if(!res.ok){ const e = await res.json(); throw new Error(JSON.stringify(e)); }
    log(`✅ DB update ${table}`);
  }catch(e){
    log(`⚠️ DB update ${table}: ${e.message}`);
  }
}

async function dbSelect(table, params=''){
  try{
    const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
    });
    return await res.json();
  }catch(e){
    log(`⚠️ DB select ${table}: ${e.message}`);
    return [];
  }
}

// Save signal + trade to DB
async function saveSignalToDB(sigKey, pair, price, dec, conf, score, r, session){
  try{
    // 1 — Save signal
    const signal = await dbInsert('signals', {
      pair, signal: sigKey,
      entry: parseFloat(price),
      sl:    parseFloat(r.sl)  || 0,
      tp1:   parseFloat(r.tp1) || 0,
      tp2:   parseFloat(r.tp2) || 0,
      tp3:   parseFloat(r.tp3) || 0,
      trailing_sl: parseFloat(r.trailing_sl) || 0,
      score, confidence: conf,
      raisonnement: r.raisonnement || '',
      analysis: r.analyse || r.analysis || '',
      session
    });
    if(!signal?.id){ log('⚠️ Signal not saved'); return null; }
    log(`✅ DB signal saved: ${signal.id}`);

    // 2 — Save trade
    const trade = await dbInsert('trades', {
      signal_id: signal.id,
      pair, signal: sigKey,
      entry: parseFloat(price),
      sl:    parseFloat(r.sl)  || 0,
      tp1:   parseFloat(r.tp1) || 0,
      tp2:   parseFloat(r.tp2) || 0,
      tp3:   parseFloat(r.tp3) || 0,
      status: 'active'
    });
    if(trade?.id) log(`✅ DB trade saved: ${trade.id}`);

    // 3 — Update win_rate total
    const wr = await dbSelect('win_rate', 'id=eq.1');
    const current = wr[0] || {};
    await dbUpdate('win_rate', {id:1}, {
      total_signals: (current.total_signals||0) + 1,
      updated_at: new Date().toISOString()
    });

    return signal.id;
  }catch(e){
    log(`⚠️ saveSignalToDB: ${e.message}`);
    return null;
  }
}

// Update active trades P&L + check TP/SL hits
async function updateActiveTrades(){
  try{
    const trades = await dbSelect('trades', 'status=eq.active');
    if(!trades?.length) return;

    for(const trade of trades){
      const price = prices[Object.keys(prices).find(k => {
        const p = PAIRS.find(x=>x.key===k);
        return p?.label === trade.pair;
      })];
      if(!price) continue;

      const isBuy = trade.signal === 'BUY';
      const entry = parseFloat(trade.entry);
      const pnl   = isBuy ? ((price-entry)/entry)*100 : ((entry-price)/entry)*100;

      const updates = { pnl_pct: parseFloat(pnl.toFixed(3)) };

      // Check TP/SL hits
      if(!trade.tp1_hit && parseFloat(trade.tp1)>0){
        if((isBuy && price >= trade.tp1) || (!isBuy && price <= trade.tp1)){
          updates.tp1_hit = true;
          log(`🎯 TP1 hit: ${trade.pair}`);
        }
      }
      if(!trade.tp2_hit && parseFloat(trade.tp2)>0){
        if((isBuy && price >= trade.tp2) || (!isBuy && price <= trade.tp2)){
          updates.tp2_hit = true;
          log(`🎯 TP2 hit: ${trade.pair}`);
        }
      }
      if(!trade.tp3_hit && parseFloat(trade.tp3)>0){
        if((isBuy && price >= trade.tp3) || (!isBuy && price <= trade.tp3)){
          updates.tp3_hit = true;
          updates.status = 'closed';
          updates.closed_at = new Date().toISOString();
          log(`🎯 TP3 hit — trade closed: ${trade.pair}`);
          await updateWinRate(true, trade.user_entered);
          await sendTelegramMsg(`🎯 <b>TP3 HIT — TRADE CLOSED</b>\n${trade.pair} ${trade.signal}\nP&L: +${pnl.toFixed(2)}% ✅`);
        }
      }
      if(!trade.sl_hit && parseFloat(trade.sl)>0){
        if((isBuy && price <= trade.sl) || (!isBuy && price >= trade.sl)){
          updates.sl_hit = true;
          updates.status = 'closed';
          updates.closed_at = new Date().toISOString();
          log(`🛑 SL hit — trade closed: ${trade.pair}`);
          await updateWinRate(false, trade.user_entered);
          await sendTelegramMsg(`🛑 <b>SL HIT — TRADE CLOSED</b>\n${trade.pair} ${trade.signal}\nP&L: ${pnl.toFixed(2)}% ❌`);
        }
      }

      await dbUpdate('trades', {id: trade.id}, updates);
    }
  }catch(e){
    log(`⚠️ updateActiveTrades: ${e.message}`);
  }
}

async function updateWinRate(isWin, userEntered){
  const wr = await dbSelect('win_rate','id=eq.1');
  const c  = wr[0] || {};
  const updates = {
    total_wins:   (c.total_wins||0)   + (isWin?1:0),
    total_losses: (c.total_losses||0) + (isWin?0:1),
    updated_at: new Date().toISOString()
  };
  if(userEntered){
    updates.user_wins   = (c.user_wins||0)   + (isWin?1:0);
    updates.user_losses = (c.user_losses||0) + (isWin?0:1);
    updates.user_total  = (c.user_total||0)  + 1;
  }
  await dbUpdate('win_rate', {id:1}, updates);
}

async function sendTelegramMsg(text){
  try{
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({chat_id:TG_CHAT, text, parse_mode:'HTML', disable_web_page_preview:true})
    });
  }catch(e){ log(`⚠️ TG msg: ${e.message}`); }
}

const PAIRS = [
  { key:'EURUSD', label:'EUR/USD', dec:5, pip:0.0001 },
  { key:'GBPUSD', label:'GBP/USD', dec:5, pip:0.0001 },
  { key:'XAUUSD', label:'XAU/USD', dec:2, pip:0.10   },
  { key:'USDJPY', label:'USD/JPY', dec:3, pip:0.01   },
];
const TD_MAP = { 'EUR/USD':'EURUSD','GBP/USD':'GBPUSD','XAU/USD':'XAUUSD','USD/JPY':'USDJPY' };
const POLY_MAP = { EURUSD:'C:EURUSD',GBPUSD:'C:GBPUSD',XAUUSD:'C:XAUUSD',USDJPY:'C:USDJPY' };

const PRICE_SECS = 60;   // fetch prices every 60s (active hours only)
const SCAN_SECS  = 60;   // AI scan every 60s
const CANDLE_MS  = 2 * 60 * 60 * 1000; // refresh candles every 2h

// ─── State ──────────────────────────────────────────────────
const prices     = {};
const prevPrices = {};
const prevClose  = {};
const candles    = {};
const liveCandle = {};
let   lastSig    = {};   // lastSig[key] = 'BUY'|'SELL'|'WAIT'
let   calEvents  = [];
let   calBlocked = false;

// ─── Utils ──────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getSession() {
  const h = new Date().getUTCHours();
  if (h >= 7  && h < 12) return '🇬🇧 London';
  if (h >= 12 && h < 17) return '🇺🇸 New York';
  if (h >= 12 && h < 21) return '🔥 Overlap';
  return '🌏 Asian';
}

function isActiveSession() {
  const h = new Date().getUTCHours();
  return h >= 8 && h < 21;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Technical Indicators ───────────────────────────────────
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const h = closes.slice(-(period + 5));
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = h[i] - h[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < h.length; i++) {
    const d = h[i] - h[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}

function findSR(cands, lookback = 50) {
  const c = cands.slice(-lookback);
  const highs = c.map(x => x.h), lows = c.map(x => x.l);
  const recent = c.slice(-20);
  return {
    resistance: Math.max(...highs),
    support: Math.min(...lows),
    recentHigh: Math.max(...recent.map(x => x.h)),
    recentLow: Math.min(...recent.map(x => x.l)),
  };
}

function getSwingStructure(cands) {
  const c = cands.slice(-20);
  if (c.length < 4) return 'neutre';
  const highs = c.map(x => x.h), lows = c.map(x => x.l);
  const hh = highs[highs.length-1] > highs[highs.length-3];
  const hl = lows[lows.length-1]   > lows[lows.length-3];
  const ll = lows[lows.length-1]   < lows[lows.length-3];
  const lh = highs[highs.length-1] < highs[highs.length-3];
  if (hh && hl) return 'haussier';
  if (ll && lh) return 'baissier';
  return 'neutre';
}

// ─── Compute Technicals ─────────────────────────────────────
function computeTechnicals(key) {
  const price = prices[key];
  const c = candles[key];
  if (!price || !c?.h1?.length || c.h1.length < 20) return null;

  // Inject live candle
  let h1 = [...c.h1];
  const lc = liveCandle[key];
  if (lc) {
    const hourStart = Math.floor(Date.now() / 3600000) * 3600000;
    if (lc.candleStart === hourStart && h1.length > 0) {
      const last = h1[h1.length - 1];
      h1[h1.length - 1] = { ...last, c: lc.c, h: Math.max(last.h, lc.h), l: Math.min(last.l, lc.l) };
    } else {
      h1 = [...h1, { o: lc.o, h: lc.h, l: lc.l, c: lc.c, v: 0 }];
    }
  }
  if (h1.length > 0) h1[h1.length - 1] = { ...h1[h1.length - 1], c: price };

  const h4 = c.h4 || [];
  const m15 = c.m15 || [];
  const closes1h  = h1.map(x => x.c);
  const closes4h  = h4.map(x => x.c);
  const closes15m = m15.map(x => x.c);
  const dec = PAIRS.find(p => p.key === key).dec;

  // Daily/4H bias
  const ema50_4h   = calcEMA(closes4h, Math.min(50, closes4h.length));
  const struct4h   = getSwingStructure(h4.slice(-30));
  const lastClose4h = closes4h[closes4h.length - 1] || price;
  const trend4h = (ema50_4h && lastClose4h > ema50_4h && struct4h === 'haussier') ? 'haussier'
                : (ema50_4h && lastClose4h < ema50_4h && struct4h === 'baissier') ? 'baissier'
                : struct4h;

  // 1H
  const rsi14  = calcRSI(closes1h, 14);
  const ema20  = calcEMA(closes1h, 20);
  const ema50  = calcEMA(closes1h, 50);
  const ema200 = calcEMA(closes1h, Math.min(200, closes1h.length));
  const struct1h = getSwingStructure(h1.slice(-20));
  const sr1h   = findSR(h1, 50);
  const sr4h   = findSR(h4, 30);

  // 15m
  const rsi15m = closes15m.length >= 15 ? calcRSI(closes15m, 14) : null;
  const ema9_15m  = calcEMA(closes15m, Math.min(9, closes15m.length));
  const ema21_15m = calcEMA(closes15m, Math.min(21, closes15m.length));
  const struct15m = closes15m.length >= 8 ? getSwingStructure(m15.slice(-15)) : 'neutre';
  const sr15m = closes15m.length >= 10 ? findSR(m15, 30) : sr1h;
  const swing15mH = m15.length >= 6 ? Math.max(...m15.slice(-6).map(x => x.h)) : price;
  const swing15mL = m15.length >= 6 ? Math.min(...m15.slice(-6).map(x => x.l)) : price;
  const bos15m_bull = price > swing15mH * 1.0001 && struct15m === 'haussier';
  const bos15m_bear = price < swing15mL * 0.9999 && struct15m === 'baissier';
  const emaCross15m_bull = ema9_15m && ema21_15m && ema9_15m > ema21_15m && price > ema9_15m;
  const emaCross15m_bear = ema9_15m && ema21_15m && ema9_15m < ema21_15m && price < ema9_15m;

  // S&R
  const range4h = sr4h.resistance - sr4h.support;
  const pos4h = range4h > 0 ? (price - sr4h.support) / range4h : 0.5;
  const nearSupport    = pos4h < 0.2;
  const nearResistance = pos4h > 0.8;

  // EMA alignment
  const bullishEMA = ema20 && ema50 && ema20 > ema50 && price > ema20;
  const bearishEMA = ema20 && ema50 && ema20 < ema50 && price < ema20;
  const emaDir = bullishEMA ? 'haussier' : bearishEMA ? 'baissier' : 'neutre';

  // RSI
  const rsiOversold   = rsi14 && rsi14 < 35;
  const rsiOverbought = rsi14 && rsi14 > 65;
  const rsiDir = rsiOversold ? 'haussier' : rsiOverbought ? 'baissier' : 'neutre';

  // ICT/SMC
  const active = isActiveSession();
  const swingH = sr1h.recentHigh, swingL = sr1h.recentLow;
  const bos_bull = price > swingH * 1.0002 && struct1h === 'haussier';
  const bos_bear = price < swingL * 0.9998 && struct1h === 'baissier';
  const midRange = (swingH + swingL) / 2;
  const fvg_bull = price < midRange && struct1h === 'haussier';
  const fvg_bear = price > midRange && struct1h === 'baissier';
  const ict15m_bull = active && bos15m_bull && emaCross15m_bull && trend4h === 'haussier';
  const ict15m_bear = active && bos15m_bear && emaCross15m_bear && trend4h === 'baissier';

  // Scores
  let srScore = nearSupport ? 25 : nearResistance ? 25 : 0;
  let srDir   = nearSupport ? 'haussier' : nearResistance ? 'baissier' : 'neutre';
  if (srScore > 0 && trend4h !== srDir) srScore = 12;

  let emaScore = 0, ictScore = 0, ictDir = 'inactif';
  if (bullishEMA && trend4h === 'haussier') emaScore = 25;
  else if (bearishEMA && trend4h === 'baissier') emaScore = 25;
  else if (emaDir !== 'neutre') emaScore = 12;
  const emaDir2 = emaScore > 0 ? emaDir : 'neutre';

  let rsiScore = 0;
  if (rsiOversold  && nearSupport)    rsiScore = 25;
  else if (rsiOverbought && nearResistance) rsiScore = 25;
  else if (rsiOversold || rsiOverbought)    rsiScore = 15;

  if (active && (ict15m_bull || (bos_bull && bos15m_bull)) && trend4h === 'haussier') { ictScore = 25; ictDir = 'haussier'; }
  else if (active && (ict15m_bear || (bos_bear && bos15m_bear)) && trend4h === 'baissier') { ictScore = 25; ictDir = 'baissier'; }
  else if (active && (bos_bull || fvg_bull) && trend4h === 'haussier') { ictScore = 18; ictDir = 'haussier'; }
  else if (active && (bos_bear || fvg_bear) && trend4h === 'baissier') { ictScore = 18; ictDir = 'baissier'; }
  else if (active) ictScore = 5;

  const totalScore = srScore + emaScore + rsiScore + ictScore;
  const bullCount = [srDir, emaDir2, rsiDir, ictDir].filter(d => d === 'haussier').length;
  const bearCount = [srDir, emaDir2, rsiDir, ictDir].filter(d => d === 'baissier').length;
  let finalDir = 'neutre';
  if (bullCount >= 3) finalDir = 'haussier';
  else if (bearCount >= 3) finalDir = 'baissier';

  return {
    price, dec, trend4h, struct4h,
    ema50_4h: ema50_4h?.toFixed(dec),
    rsi: rsi14 ? rsi14.toFixed(1) : null,
    ema20: ema20?.toFixed(dec), ema50: ema50?.toFixed(dec), ema200: ema200?.toFixed(dec),
    struct1h, rsi15m: rsi15m ? rsi15m.toFixed(1) : null,
    ema9_15m: ema9_15m?.toFixed(dec), ema21_15m: ema21_15m?.toFixed(dec),
    struct15m, bos15m_bull, bos15m_bear, emaCross15m_bull, emaCross15m_bear,
    sr15mHigh: sr15m.recentHigh.toFixed(dec), sr15mLow: sr15m.recentLow.toFixed(dec),
    nearSupport, nearResistance,
    support4h: sr4h.support.toFixed(dec), resistance4h: sr4h.resistance.toFixed(dec),
    recentHigh: sr1h.recentHigh.toFixed(dec), recentLow: sr1h.recentLow.toFixed(dec),
    bos_bull, bos_bear, fvg_bull, fvg_bear, active,
    srScore, emaScore, rsiScore, ictScore, totalScore,
    srDir, emaDir: emaDir2, rsiDir, ictDir, finalDir,
  };
}

// ─── Fetch Prices ───────────────────────────────────────────
async function fetchPrices() {
  if (!isActiveSession()) return;
  try {
    const [r1, r2, r3, r4] = await Promise.all([
      fetch(`https://api.twelvedata.com/price?symbol=EUR%2FUSD&apikey=${TD_KEY}`),
      fetch(`https://api.twelvedata.com/price?symbol=GBP%2FUSD&apikey=${TD_KEY2}`),
      fetch(`https://api.twelvedata.com/price?symbol=XAU%2FUSD&apikey=${TD_KEY3}`),
      fetch(`https://api.twelvedata.com/price?symbol=USD%2FJPY&apikey=${TD_KEY4}`),
    ]);
    const [d1, d2, d3, d4] = await Promise.all([r1.json(), r2.json(), r3.json(), r4.json()]);
    const map = { 'EUR/USD': d1, 'GBP/USD': d2, 'XAU/USD': d3, 'USD/JPY': d4 };

    for (const [sym, val] of Object.entries(map)) {
      const key = TD_MAP[sym];
      const price = parseFloat(val?.price);
      if (!key || !price) continue;
      prices[key] = price;
      const now = Date.now();
      const hourStart = Math.floor(now / 3600000) * 3600000;
      if (!liveCandle[key] || liveCandle[key].candleStart !== hourStart) {
        liveCandle[key] = { o: price, h: price, l: price, c: price, candleStart: hourStart };
      } else {
        liveCandle[key].h = Math.max(liveCandle[key].h, price);
        liveCandle[key].l = Math.min(liveCandle[key].l, price);
        liveCandle[key].c = price;
      }
    }
    log(`✅ Prices: ${Object.keys(prices).map(k => `${k}=${prices[k]}`).join(' | ')}`);

    // Save prices f Supabase Bach Vercel y9rahom (0 Twelve Data req mn Vercel)
    const priceUpdates = Object.entries(prices).map(([pair, price]) => {
      const prev = prevPrices[pair] || price;
      const change_pct = prev ? parseFloat(((price - prev) / prev * 100).toFixed(4)) : 0;
      return fetch(`${SB_URL}/rest/v1/prices?pair=eq.${pair}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SB_KEY,
          'Authorization': `Bearer ${SB_KEY}`
        },
        body: JSON.stringify({ price, change_pct, updated_at: new Date().toISOString() })
      });
    });
    await Promise.all(priceUpdates);
    // Save prev prices for change_pct
    Object.assign(prevPrices, prices);
  } catch(e) {
    log(`⚠️ fetchPrices error: ${e.message}`);
  }
}

// ─── Fetch Candles ──────────────────────────────────────────
async function fetchDailyCandles(pairKey) {
  const polyKey = POLY_MAP[pairKey];
  if (!polyKey) return;
  const today = new Date().toISOString().split('T')[0];
  const from  = new Date(Date.now() - 500 * 86400000).toISOString().split('T')[0];
  try {
    const url = `https://api.polygon.io/v2/aggs/ticker/${polyKey}/range/1/day/${from}/${today}?adjusted=true&sort=asc&limit=500&apiKey=${POLY_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    const bars = (data.results || []).map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    if (!candles[pairKey]) candles[pairKey] = {};
    if (bars.length) candles[pairKey].h4 = bars;
    log(`✅ Daily ${pairKey}: ${bars.length} candles`);
  } catch (e) {
    log(`⚠️ Daily ${pairKey}: ${e.message}`);
  }
}

async function fetchIntraCandles(pairKey) {
  const sym = PAIRS.find(p => p.key === pairKey)?.label;
  if (!sym) return;
  const keyMap = { EURUSD: TD_KEY, GBPUSD: TD_KEY2, XAUUSD: TD_KEY3, USDJPY: TD_KEY4 };
  const apiKey = keyMap[pairKey] || TD_KEY;
  try {
    const [r1h, r15m] = await Promise.all([
      fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=1h&outputsize=100&apikey=${apiKey}`),
      fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=15min&outputsize=150&apikey=${apiKey}`),
    ]);
    const [d1h, d15m] = await Promise.all([r1h.json(), r15m.json()]);
    const parse = d => (d?.values || []).map(v => ({
      o: parseFloat(v.open), h: parseFloat(v.high), l: parseFloat(v.low), c: parseFloat(v.close), v: 0,
    })).reverse();
    if (!candles[pairKey]) candles[pairKey] = {};
    if (d1h?.values?.length)  candles[pairKey].h1  = parse(d1h);
    if (d15m?.values?.length) candles[pairKey].m15 = parse(d15m);
    log(`✅ Intra ${pairKey}: 1H=${candles[pairKey].h1?.length} 15m=${candles[pairKey].m15?.length}`);
  } catch (e) {
    log(`⚠️ Intra ${pairKey}: ${e.message}`);
  }
}

async function fetchAllCandles() {
  log('📊 Fetching candles...');
  for (const p of PAIRS) {
    await fetchDailyCandles(p.key);
    await sleep(13000); // Polygon free = 5 req/min
  }
  for (const p of PAIRS) {
    await fetchIntraCandles(p.key);
    await sleep(1000);
  }
  log('✅ All candles loaded');
}

// ─── Economic Calendar ──────────────────────────────────────
async function fetchCalendar() {
  try {
    // Railway = server-side — direct fetch mashi bloqué ✅
    const url = `https://nfs.faireconomy.media/ff_calendar_thisweek.json`;
    const res  = await fetch(url);
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    calEvents = data.filter(e => {
      const eDate = new Date(e.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return eDate === todayStr && ['USD', 'EUR', 'GBP', 'JPY'].includes(e.currency);
    });
    const nowMs = Date.now();
    calBlocked = calEvents.some(e => {
      if (e.impact !== 'High') return false;
      const diff = new Date(e.date).getTime() - nowMs;
      return diff > -15 * 60000 && diff < 30 * 60000;
    });
    log(`📅 Calendar: ${calEvents.length} events today — blocked: ${calBlocked}`);

    // Save f Supabase bach Vercel y9ra (mashi bloqué f browser) ✅
    try{
      // Clear today's events first
      const todayISO = new Date().toISOString().split('T')[0];
      await fetch(`${SB_URL}/rest/v1/calendar?event_time=gte.${todayISO}T00:00:00Z&event_time=lte.${todayISO}T23:59:59Z`, {
        method: 'DELETE',
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
      });
      // Insert new events
      if(calEvents.length){
        await fetch(`${SB_URL}/rest/v1/calendar`, {
          method: 'POST',
          headers: { 'Content-Type':'application/json','apikey':SB_KEY,'Authorization':`Bearer ${SB_KEY}`,'Prefer':'return=minimal' },
          body: JSON.stringify(calEvents.map(e => ({
            event_time: new Date(e.date).toISOString(),
            currency: e.currency,
            title: e.title,
            impact: e.impact,
            updated_at: new Date().toISOString()
          })))
        });
        log(`✅ Calendar saved to DB: ${calEvents.length} events`);
      }
    }catch(dbErr){ log(`⚠️ Calendar DB save: ${dbErr.message}`); }

  } catch (e) {
    log(`⚠️ Calendar: ${e.message}`);
  }
}

// ─── Telegram ───────────────────────────────────────────────
async function sendTelegram(sigKey, pair, price, dec, conf, score, r) {
  try {
    const isBuy  = sigKey === 'BUY';
    const arrow  = isBuy ? '📈' : '📉';
    const action = isBuy ? '🟢 BUY' : '🔴 SELL';
    const fmt    = v => parseFloat(v) > 0 ? parseFloat(v).toFixed(dec) : '—';
    const rr     = r.sl && r.tp2 ? Math.abs((parseFloat(r.tp2) - price) / (price - parseFloat(r.sl))).toFixed(1) : '—';
    const sess   = getSession();
    const now    = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Casablanca' });

    const text =
`${arrow} <b>FX SIGNAL PRO</b> ${arrow}
━━━━━━━━━━━━━━━━━
<b>${action} — ${pair}</b>
⏰ ${now} Casablanca | ${sess}
━━━━━━━━━━━━━━━━━
📌 <b>Entry:</b>  <code>${parseFloat(price).toFixed(dec)}</code>
🛑 <b>SL:</b>     <code>${fmt(r.sl)}</code>
🎯 <b>TP1:</b>    <code>${fmt(r.tp1)}</code>  <i>(40% — 30-45min)</i>
🎯 <b>TP2:</b>    <code>${fmt(r.tp2)}</code>  <i>(35% — 1-2h)</i>
🎯 <b>TP3:</b>    <code>${fmt(r.tp3)}</code>  <i>(25% — 2-4h)</i>
━━━━━━━━━━━━━━━━━
📊 <b>Score:</b> ${score}/100 | <b>RR:</b> ${rr} | <b>Conf:</b> ${conf}%
━━━━━━━━━━━━━━━━━
🧠 <b>Analysis:</b>
<i>${(r.raisonnement || r.analyse || '—').substring(0, 400)}</i>
━━━━━━━━━━━━━━━━━
⚠️ <i>Not financial advice — manage your risk</i>
#${pair.replace('/', '_')} #${isBuy ? 'BUY' : 'SELL'} #FXSignalPro`;

    const res  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = await res.json();
    if (data.ok) log(`✅ Telegram sent: ${pair} ${sigKey}`);
    else log(`⚠️ Telegram error: ${data.description}`);
  } catch (e) {
    log(`⚠️ Telegram: ${e.message}`);
  }
}

// ─── AI Scan ────────────────────────────────────────────────
async function runScan() {
  if (!isActiveSession()) {
    log('😴 Outside active hours — skipping scan');
    return;
  }
  if (calBlocked) {
    log('⛔ HIGH IMPACT news — scan blocked');
    return;
  }

  const analyses = PAIRS
    .map(p => ({ ...p, tech: computeTechnicals(p.key) }))
    .filter(p => p.tech)
    .sort((a, b) => b.tech.totalScore - a.tech.totalScore);

  if (!analyses.length) { log('⚠️ No technicals yet'); return; }

  const best = analyses[0];
  const t    = best.tech;

  log(`🔍 Scanning ${best.label} — score ${t.totalScore}/100 — ${t.finalDir}`);

  const isBull15 = t.finalDir.includes('haussier');
  const isBear15 = t.finalDir.includes('baissier');
  if (!isBull15 && !isBear15) { log('→ WAIT: no clear direction'); return; }
  if (t.totalScore < 65)      { log(`→ WAIT: score ${t.totalScore} < 65`); return; }

  const session = getSession();
  const newsContext = calEvents.length
    ? calEvents.slice(0, 5).map(e => `${e.impact === 'High' ? '🔴' : e.impact === 'Medium' ? '🟡' : '🟢'} ${e.currency} ${e.title} @ ${new Date(e.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`).join('\n')
    : 'No major news today';

  const prompt = `You are a senior forex trader with 15 years experience. Analyze like a real trader — think and decide.

TRADING STYLE: Daily bias → 1H confirmation → 15m entry. Intraday: 30min-4h max. Tight SL on structure. Min RR 1.5.

SESSION: ${session}
PAIR: ${best.label} @ ${t.price.toFixed(best.dec)}
OTHER PAIRS: ${analyses.slice(1).map(p => `${p.label}(${p.tech.totalScore}/100 ${p.tech.trend4h})`).join(' | ')}

NEWS TODAY:
${newsContext}

DAILY/4H BIAS:
Trend: ${t.trend4h} | Structure: ${t.struct4h}
EMA50: ${t.ema50_4h || 'N/A'} | Price: ${t.price.toFixed(best.dec)}
Support: ${t.support4h} | Resistance: ${t.resistance4h}

1H CONFIRMATION:
Structure: ${t.struct1h} | EMA20: ${t.ema20 || 'N/A'} | EMA50: ${t.ema50 || 'N/A'} | EMA200: ${t.ema200 || 'N/A'}
RSI(14): ${t.rsi || 'N/A'} ${parseFloat(t.rsi) < 35 ? '— OVERSOLD' : parseFloat(t.rsi) > 65 ? '— OVERBOUGHT' : ''}
Near support: ${t.nearSupport} | Near resistance: ${t.nearResistance}
Swing High: ${t.recentHigh} | Swing Low: ${t.recentLow}

15m ENTRY:
Structure: ${t.struct15m} | EMA9: ${t.ema9_15m || 'N/A'} | EMA21: ${t.ema21_15m || 'N/A'}
RSI 15m: ${t.rsi15m || 'N/A'} | BOS bull: ${t.bos15m_bull} | BOS bear: ${t.bos15m_bear}
EMA cross bull: ${t.emaCross15m_bull} | bear: ${t.emaCross15m_bear}
Entry zone: ${t.sr15mLow} → ${t.sr15mHigh}

ICT/SMC: BOS bull: ${t.bos_bull} | BOS bear: ${t.bos_bear} | FVG bull: ${t.fvg_bull} | FVG bear: ${t.fvg_bear}

SCORES: S&R: ${t.srScore}/25 (${t.srDir}) | EMA: ${t.emaScore}/25 (${t.emaDir}) | RSI: ${t.rsiScore}/25 (${t.rsiDir}) | ICT: ${t.ictScore}/25 (${t.ictDir})
Total: ${t.totalScore}/100

MINIMUM TO ENTER: Clear 4H bias + 1H confirms + 15m trigger (BOS or EMA cross) + Active session + No HIGH IMPACT news in 30min + RR >= 1.5. If ANY missing → WAIT.

SL: use nearest 15m swing high/low (not fixed formula).
TPs: based on real S&R levels.

Reply ONLY in raw JSON no markdown:
{
  "signal": "BUY or SELL or WAIT",
  "confidence": 0-95,
  "raisonnement": "Your trader reasoning in 2 sentences: 4H bias + 1H setup + 15m trigger",
  "entry": ${t.price.toFixed(best.dec)},
  "sl": 0,
  "tp1": 0,
  "tp2": 0,
  "tp3": 0,
  "trailing_sl": 0,
  "sr_detail": "S&R analysis one sentence",
  "ema_detail": "EMA alignment one sentence",
  "rsi_detail": "RSI reading one sentence",
  "ict_detail": "ICT/SMC structure one sentence",
  "analyse": "Full analysis: (1) 4H context (2) 1H setup (3) 15m trigger (4) trade plan"
}`;

  try {
    const res  = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.3,
      }),
    });
    const data = await res.json();
    const raw  = data.choices?.[0]?.message?.content || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const r    = JSON.parse(clean);

    log(`🤖 AI: ${r.signal} | conf: ${r.confidence}% | ${r.raisonnement?.substring(0, 80)}...`);

    const isBuy  = r.signal === 'BUY';
    const isSell = r.signal === 'SELL';

    // Hard gate
    const bullC = [t.srDir, t.emaDir, t.rsiDir, t.ictDir].filter(d => d === 'haussier').length;
    const bearC = [t.srDir, t.emaDir, t.rsiDir, t.ictDir].filter(d => d === 'baissier').length;
    const valid = (isBuy && bullC >= 3 && t.totalScore >= 65) || (isSell && bearC >= 3 && t.totalScore >= 65);

    if (!valid) { log(`→ Hard gate blocked: bull=${bullC} bear=${bearC} score=${t.totalScore}`); return; }

    const sigKey = isBuy ? 'BUY' : 'SELL';

    // Only send if signal changed
    if (lastSig[best.key] === sigKey) { log(`→ Same signal as last time — skip`); return; }
    lastSig[best.key] = sigKey;
    await sendTelegram(sigKey, best.label, t.price, best.dec, r.confidence, t.totalScore, r);
    await saveSignalToDB(sigKey, best.label, t.price, best.dec, r.confidence, t.totalScore, r, session);

  } catch (e) {
    log(`⚠️ AI scan error: ${e.message}`);
  }
}

// ─── Main Loop ──────────────────────────────────────────────
async function init() {
  log('🚀 FX Signal Pro Bot starting...');
  await sendTelegram('INFO', 'BOT', 0, 2, 100, 100, {
    signal: 'INFO',
    raisonnement: '🤖 FX Signal Pro Bot started — scanning 8h-21h UTC',
    analyse: 'Active pairs: EUR/USD, GBP/USD, XAU/USD, USD/JPY',
  }).catch(() => {});

  // Initial candle load
  await fetchAllCandles();
  await fetchPrices();
  await fetchCalendar();

  // Run first scan
  await runScan();

  // Price fetch loop — kol 60s
  setInterval(fetchPrices, PRICE_SECS * 1000);

  // Scan loop — kol 60s
  setInterval(runScan, SCAN_SECS * 1000);

  // Update active trades P&L + TP/SL — kol 60s
  setInterval(updateActiveTrades, 60 * 1000);

  // Candle refresh — kol 2h
  setInterval(fetchAllCandles, CANDLE_MS);

  // Calendar refresh — kol 5min
  setInterval(fetchCalendar, 5 * 60 * 1000);

  log('✅ Bot running — waiting for signals...');
}

// Keep-alive server for Railway/Render
import { createServer } from 'http';
createServer((req, res) => {
  res.writeHead(200);
  res.end('FX Signal Pro Bot — Running ✅');
}).listen(process.env.PORT || 3000);

init().catch(e => {
  log(`❌ Fatal error: ${e.message}`);
  process.exit(1);
});
