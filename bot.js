// ============================================================
// FX Signal Pro - 24/7 Trading Bot
// Railway / Render - Node.js 18+ (built-in fetch)
// ============================================================

// Node 18+ has built-in fetch - no dependencies needed!

// — Config ———————————————––
const TD_KEY   = process.env.TD_KEY   || ‘2dfb3a0242474809967353a965e730f1’;
const TD_KEY2  = process.env.TD_KEY2  || ‘c6f15065c04c4a5a94722b40a297dd0f’;
const TD_KEY3  = process.env.TD_KEY3  || ‘a459b1e8d10240f2bff8dcb67e2ed5b6’;
const TD_KEY4  = process.env.TD_KEY4  || ‘c7ccc7b36d7b4fa3a1b16b7860196049’;
const POLY_KEY = process.env.POLY_KEY || ‘Vxe1pa2pDsqR2wt5XguyxYOH68DwTiKi’;
const GROQ_KEY = process.env.GROQ_KEY || ‘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’;
const TG_TOKEN = process.env.TG_TOKEN || ‘8427595283:AAFaoATV4Cq-45Fq_eruMLRFaJsOrCt6Ceo’;
const TG_CHAT  = process.env.TG_CHAT  || ‘-1003612566723’;
const SB_URL   = process.env.SUPABASE_URL || ‘https://ugbowhydxxkpsamjxxai.supabase.co’;
const SB_KEY   = process.env.SUPABASE_KEY || ‘sb_publishable_I1wxgYYVPxo9PXhmBxpG5A_dYR2nsi9’;

// — Supabase DB ———————————————
async function dbInsert(table, data){
try{
const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
method: ‘POST’,
headers: {
‘Content-Type’: ‘application/json’,
‘apikey’: SB_KEY,
‘Authorization’: `Bearer ${SB_KEY}`,
‘Prefer’: ‘return=representation’
},
body: JSON.stringify(data)
});
const result = await res.json();
if(!res.ok) throw new Error(JSON.stringify(result));
return Array.isArray(result) ? result[0] : result;
}catch(e){
log(`[WARN] DB insert ${table}: ${e.message}`);
return null;
}
}

async function dbUpdate(table, match, data){
try{
const params = Object.entries(match).map(([k,v])=>`${k}=eq.${v}`).join(’&’);
const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
method: ‘PATCH’,
headers: {
‘Content-Type’: ‘application/json’,
‘apikey’: SB_KEY,
‘Authorization’: `Bearer ${SB_KEY}`
},
body: JSON.stringify(data)
});
if(!res.ok){ const e = await res.json(); throw new Error(JSON.stringify(e)); }
log(`[OK] DB update ${table}`);
}catch(e){
log(`[WARN] DB update ${table}: ${e.message}`);
}
}

async function dbSelect(table, params=’’){
try{
const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
headers: { ‘apikey’: SB_KEY, ‘Authorization’: `Bearer ${SB_KEY}` }
});
return await res.json();
}catch(e){
log(`[WARN] DB select ${table}: ${e.message}`);
return [];
}
}

// Save signal + trade to DB
async function saveSignalToDB(sigKey, pair, price, dec, conf, score, r, session, tgMsgId=null){
try{
// 1 - Save signal
const signal = await dbInsert(‘signals’, {
pair, signal: sigKey,
entry: parseFloat(price),
sl:    parseFloat(r.sl)  || 0,
tp1:   parseFloat(r.tp1) || 0,
tp2:   parseFloat(r.tp2) || 0,
tp3:   parseFloat(r.tp3) || 0,
trailing_sl: parseFloat(r.trailing_sl) || 0,
score, confidence: conf,
raisonnement: r.raisonnement || ‘’,
analysis: r.analyse || r.analysis || ‘’,
session
});
if(!signal?.id){ log(’[WARN] Signal not saved’); return null; }
log(`[OK] DB signal saved: ${signal.id}`);

```
// 2 - Save trade (with tg_message_id for reply-to)
const trade = await dbInsert('trades', {
  signal_id: signal.id,
  pair, signal: sigKey,
  entry: parseFloat(price),
  sl:    parseFloat(r.sl)  || 0,
  tp1:   parseFloat(r.tp1) || 0,
  tp2:   parseFloat(r.tp2) || 0,
  tp3:   parseFloat(r.tp3) || 0,
  status: 'active',
  tg_message_id: tgMsgId
});
if(trade?.id) log(`[OK] DB trade saved: ${trade.id}`);

// 3 - Update win_rate total
const wr = await dbSelect('win_rate', 'id=eq.1');
const current = wr[0] || {};
await dbUpdate('win_rate', {id:1}, {
  total_signals: (current.total_signals||0) + 1,
  updated_at: new Date().toISOString()
});

return signal.id;
```

}catch(e){
log(`[WARN] saveSignalToDB: ${e.message}`);
return null;
}
}

// Update active trades P&L + check TP/SL hits
async function updateActiveTrades(){
try{
const trades = await dbSelect(‘trades’, ‘status=eq.active’);
if(!trades?.length) return;

```
for(const trade of trades){
  const pairKey = Object.keys(prices).find(k => {
    const p = PAIRS.find(x=>x.key===k);
    return p?.label === trade.pair;
  });
  // 8h-21h UTC -> live price | ba3d 21h -> last closed candle close
  const utcH = new Date().getUTCHours();
  const sessionNow = utcH >= 8 && utcH < 21;
  let price = sessionNow ? prices[pairKey] : null;
  if (!price && pairKey && candles[pairKey]?.h1?.length) {
    // fallback: akhir closed candle close
    const h1c = candles[pairKey].h1;
    price = h1c[h1c.length - 1]?.c || null;
  }
  if(!price) continue;

  const isBuy = trade.signal === 'BUY';
  const entry = parseFloat(trade.entry);
  const pnl   = isBuy ? ((price-entry)/entry)*100 : ((entry-price)/entry)*100;

  const updates = { pnl_pct: parseFloat(pnl.toFixed(3)) };
  const dec = PAIRS.find(p=>p.label===trade.pair)?.dec || 5;
  const fmt = v => parseFloat(v).toFixed(dec);
  const sig = trade.signal==='BUY' ? '🟢 BUY' : '🔴 SELL';

  // -- TP1 Hit -> Move SL to BE --
  const tgId = trade.tg_message_id || null;

  if(!trade.tp1_hit && parseFloat(trade.tp1)>0){
    if((isBuy && price >= trade.tp1) || (!isBuy && price <= trade.tp1)){
      updates.tp1_hit = true;
      updates.sl = entry;
      log(`[TP] TP1 hit: ${trade.pair} - SL moved to BE`);
      await sendTelegramMsg(
```

## `🎯 <b>TP1 ATTEINT - SL -> BREAKEVEN</b>

## ⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code>
🎯 TP1: <code>${fmt(trade.tp1)}</code> ✅
🔄 <b>SL déplacé à BE: <code>${fmt(entry)}</code></b>

🎯 TP2: <code>${fmt(trade.tp2)}</code> en cours…
💡 Trade risk-free - laisse runner!
#TradeUpdate #FXSignalPro`, tgId);
}
}

```
  if(trade.tp1_hit && !trade.tp2_hit && parseFloat(trade.tp2)>0){
    if((isBuy && price >= trade.tp2) || (!isBuy && price <= trade.tp2)){
      updates.tp2_hit = true;
      updates.sl = parseFloat(trade.tp1);
      log(`[TP] TP2 hit: ${trade.pair} - SL moved to TP1`);
      await sendTelegramMsg(
```

## `🎯 <b>TP2 ATTEINT - SL -> TP1</b>

## ⏰ ${utcTime()}
${sig} ${trade.pair}
🎯 TP1: <code>${fmt(trade.tp1)}</code> ✅
🎯 TP2: <code>${fmt(trade.tp2)}</code> ✅
🔄 <b>SL déplacé à TP1: <code>${fmt(trade.tp1)}</code></b>

🎯 TP3: <code>${fmt(trade.tp3)}</code> en cours…
💡 Trade en profit garanti - laisse runner!
#TradeUpdate #FXSignalPro`, tgId);
}
}

```
  if(trade.tp1_hit && trade.tp2_hit && !trade.tp3_hit && parseFloat(trade.tp3)>0){
    if((isBuy && price >= trade.tp3) || (!isBuy && price <= trade.tp3)){
      updates.tp3_hit = true;
      updates.status = 'closed';
      updates.closed_at = new Date().toISOString();
      const slDist = Math.abs(entry - parseFloat(trade.sl));
      const rrTotal = slDist > 0 ? ((Math.abs(trade.tp3-entry)/slDist)*0.25 + (Math.abs(trade.tp2-entry)/slDist)*0.35 + (Math.abs(trade.tp1-entry)/slDist)*0.40).toFixed(2) : '-';
      log(`[TP] TP3 hit - trade closed: ${trade.pair}`);
      await updateWinRate(true, trade.user_entered);
      await sendTelegramMsg(
```

## `🏆 <b>TRADE FERMÉ - TP3 ATTEINT</b>

## ⏰ ${utcTime()}
${sig} ${trade.pair}
🎯 TP1 ✅ TP2 ✅ TP3 ✅

💰 <b>P&L: +${rrTotal}R</b>
📈 Excellent trade - félicitations! 🔥
#TradeClosed #FXSignalPro`, tgId);
}
}

```
  if(!trade.sl_hit && parseFloat(trade.sl)>0){
    if((isBuy && price <= trade.sl) || (!isBuy && price >= trade.sl)){
      updates.sl_hit = true;
      updates.status = 'closed';
      updates.closed_at = new Date().toISOString();
      const wasBE  = Math.abs(parseFloat(trade.sl) - entry) < (entry * 0.0001);
      const wasTP1 = trade.tp1_hit && Math.abs(parseFloat(trade.sl) - parseFloat(trade.tp1)) < (entry * 0.0001);
      log(`[SL] SL hit - trade closed: ${trade.pair}`);
      await updateWinRate(false, trade.user_entered);
      if(wasBE || wasTP1){
        await sendTelegramMsg(
```

## `➡️ <b>TRADE FERMÉ - BREAKEVEN</b>

## ⏰ ${utcTime()}
${sig} ${trade.pair}
${trade.tp1_hit?‘🎯 TP1 ✅’:’’}
🔄 SL touché au BE - 0 perte 👍
#BE #FXSignalPro`, tgId); } else { await sendTelegramMsg( `🛑 <b>TRADE FERMÉ - SL TOUCHÉ</b>

## ⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code>
🛑 SL: <code>${fmt(trade.sl)}</code> ❌

💰 P&L: -1R
📊 Analyse la prochaine setup - next trade! 💪
#SLHit #FXSignalPro`, tgId);
}
}
}

```
  await dbUpdate('trades', {id: trade.id}, updates);
}
```

}catch(e){
log(`[WARN] updateActiveTrades: ${e.message}`);
}
}

// AI Trade Analysis - kol 30min ila kayn trade actif
const lastTradeAnalysis = {}; // tradeId -> last analysis time

async function analyzeActiveTrades(){
try{
const trades = await dbSelect(‘trades’,‘status=eq.active&order=created_at.desc’);
if(!trades?.length) return;

```
// No HOLD messages on weekends or outside market hours
const dayNow = new Date().getUTCDay();
const hourNow = new Date().getUTCHours();
const isWeekend = dayNow === 0 || dayNow === 6;
const isMarketHours = hourNow >= 8 && hourNow < 21;
const canSendMsg = !isWeekend && isMarketHours;

for(const trade of trades){
  // Only analyze every 30min per trade
  const now = Date.now();
  const last = lastTradeAnalysis[trade.id] || 0;
  if(now - last < 5*60*1000) continue;
  lastTradeAnalysis[trade.id] = now;

  const pair = PAIRS.find(p=>p.label===trade.pair);
  if(!pair) continue;
  const t = computeTechnicals(pair.key);
  if(!t) continue;

  const price   = parseFloat(prices[pair.key]||trade.entry);
  const entry   = parseFloat(trade.entry);
  const sl      = parseFloat(trade.sl);
  const tp1     = parseFloat(trade.tp1);
  const tp2     = parseFloat(trade.tp2);
  const tp3     = parseFloat(trade.tp3);
  const isBuy   = trade.signal==='BUY';
  const pnlR    = sl ? ((isBuy?price-entry:entry-price)/Math.abs(entry-sl)).toFixed(2) : '0';
  const dec     = pair.dec;
  const fmt     = v => parseFloat(v).toFixed(dec);
  const elapsed = Math.round((now - new Date(trade.created_at).getTime())/60000);

  const prompt = `You are a professional forex trade manager. A trade is currently open. Analyze the current market conditions and decide what to do.
```

OPEN TRADE:
Pair: ${trade.pair}
Direction: ${trade.signal}
Entry: ${fmt(entry)} | Current Price: ${fmt(price)}
SL: ${fmt(sl)} | TP1: ${fmt(tp1)} | TP2: ${fmt(tp2)} | TP3: ${fmt(tp3)}
TP1 Hit: ${trade.tp1_hit} | TP2 Hit: ${trade.tp2_hit}
P&L: ${pnlR}R | Time in trade: ${elapsed} minutes

CURRENT MARKET:
Trend 4H: ${t.trend4h} | Structure 1H: ${t.struct1h} | Structure 15m: ${t.struct15m}
RSI 1H: ${t.rsi||‘N/A’} | RSI 15m: ${t.rsi15m||‘N/A’}
EMA alignment: ${t.emaDir} | ICT: ${t.ictDir}
Score: ${t.totalScore}/100

Liquidity: PDH=${t.prevDayHigh||‘N/A’} PDL=${t.prevDayLow||‘N/A’}
Liq sweep bull: ${t.liqSweepBull} | bear: ${t.liqSweepBear}

NEWS: ${calEvents.filter(e=>e.impact===‘High’).map(e=>`${e.currency} ${e.title}`).join(’, ’)||‘None’}

YOUR DECISION - reply ONLY in raw JSON:
{
“action”: “HOLD” or “CLOSE” or “MOVE_SL”,
“new_sl”: (only if MOVE_SL - new SL price as number),
“reason”: “One sentence explanation of your decision”,
“urgency”: “normal” or “urgent”
}

Rules:

- HOLD: market still in your favor, no action needed
- CLOSE: structure broken against trade, momentum reversed, or news risk - exit now
- MOVE_SL: trail SL to protect profits (only if trade is in profit)
- Be concise and decisive - no hesitation`;
  
  ```
  try{
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},
      body: JSON.stringify({ model:'llama-3.3-70b-versatile', max_tokens:300, temperature:0.2,
        messages:[{role:'user',content:prompt}] })
    });
    const data = await res.json();
    const raw  = data.choices?.[0]?.message?.content||'';
    const clean = raw.replace(/```json|```/g,'').trim();
    let r;
    try {
      r = JSON.parse(clean);
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if(match) {
        try{ r = JSON.parse(match[0]); }
        catch{
          log(`[WARN] Trade AI non-JSON [${trade.pair}] - silent retry in 2min`);
          setTimeout(() => { delete lastTradeAnalysis[trade.id]; }, 2*60*1000);
          continue;
        }
      } else {
        log(`[WARN] Trade AI non-JSON [${trade.pair}] - silent retry in 2min`);
        setTimeout(() => { delete lastTradeAnalysis[trade.id]; }, 2*60*1000);
        continue;
      }
    }
  
    log(`[AI] Trade AI [${trade.pair}]: ${r.action} - ${r.reason}`);
  
    const sig = trade.signal==='BUY'?'🟢 BUY':'🔴 SELL';
  
    if(r.action==='CLOSE'){
      // Determine win/loss for AI CLOSE based on P&L
      const aiPnlR  = parseFloat(pnlR);
      const aiIsWin = aiPnlR > 0;
      const aiIsBE  = aiPnlR === 0 || (aiPnlR > -0.1 && aiPnlR < 0.1);
      await dbUpdate('trades',{id:trade.id},{
        status:'closed',
        closed_at: new Date().toISOString(),
        pnl_pct: parseFloat(pnl.toFixed(3)),
        ai_close: true,
        ai_close_pnl_r: aiPnlR
      });
      // Count AI CLOSE in win_rate (win if P&L > 0, loss if P&L < 0, skip if BE)
      if (!aiIsBE) await updateWinRate(aiIsWin, trade.user_entered);
      // Delete last HOLD msg if exists
      const holdKey = `${trade.id}`;
      if (lastHoldMsgId[holdKey]) {
        await deleteTelegramMsg(lastHoldMsgId[holdKey]);
        lastHoldMsgId[holdKey] = null;
      }
      await sendTelegramMsg(
  ```

## `🤖 <b>AI TRADE ALERT - ${r.urgency===‘urgent’?‘⚠️ URGENT’:’’}</b>

⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code> -> Now: <code>${fmt(price)}</code>
💰 P&L: ${aiPnlR>=0?’+’:’’}${pnlR}R ${aiIsWin?‘✅’:aiIsBE?‘➡️’:‘❌’}

## 🚨 <b>AI RECOMMENDS: CLOSE NOW</b>
📝 “${r.reason}”

⚡ Exit at market price immediately
#AIAlert #TradeManagement`, trade.tg_message_id||null);

```
    } else if(r.action==='MOVE_SL' && r.new_sl){
      const newSL = parseFloat(r.new_sl);
      const validMove = isBuy ? newSL > sl : newSL < sl;
      if(validMove){
        await dbUpdate('trades',{id:trade.id},{ sl: newSL });
        await sendTelegramMsg(
```

## `🤖 <b>AI TRADE UPDATE</b>

⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code> | Now: <code>${fmt(price)}</code>
💰 P&L: ${parseFloat(pnlR)>=0?’+’:’’}${pnlR}R

## 🔄 <b>AI MOVES SL: ${fmt(sl)} -> ${fmt(newSL)}</b>
📝 “${r.reason}”

## ✅ Update your SL manually
#AIUpdate #TradeManagement`, trade.tg_message_id||null); } } else { // HOLD - only during market hours (8h-21h UTC, Mon-Fri) if (!canSendMsg) { log(`-> HOLD supprimé (weekend/hors heures) [${trade.pair}]`); continue; } // delete previous HOLD msg then send new one const holdKey = `${trade.id}`; if (lastHoldMsgId[holdKey]) { await deleteTelegramMsg(lastHoldMsgId[holdKey]); lastHoldMsgId[holdKey] = null; } const tpsHit = [trade.tp1_hit,trade.tp2_hit,trade.tp3_hit].filter(Boolean).length; const pnlEmoji = parseFloat(pnlR)>=0 ? '📈' : '📉'; const holdMsgId = await sendTelegramMsg( `🤖 <b>AI TRADE UPDATE - HOLD</b>

⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code> | Now: <code>${fmt(price)}</code>
${pnlEmoji} P&L: ${parseFloat(pnlR)>=0?’+’:’’}${pnlR}R
🛑 SL: <code>${fmt(sl)}</code>
🎯 TPs atteints: ${tpsHit}/3

## ✅ <b>HOLD - Tenir la position</b>
📝 “${r.reason}”

#AIUpdate #Hold`, trade.tg_message_id||null); if (holdMsgId) lastHoldMsgId[holdKey] = holdMsgId; log(`-> HOLD - alert sent (replaced prev msg)`);
}

```
  }catch(aiErr){
    log(`[WARN] Trade AI error [${trade.pair}]: ${aiErr.message}`);
  }
}
```

}catch(e){
log(`[WARN] analyzeActiveTrades: ${e.message}`);
}
}

async function updateWinRate(isWin, userEntered){
const wr = await dbSelect(‘win_rate’,‘id=eq.1’);
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
await dbUpdate(‘win_rate’, {id:1}, updates);
}

// Track last HOLD message per trade (to delete before sending new one)
const lastHoldMsgId = {};
let dxyData = { price: null, trend: ‘neutre’, change: null }; // DXY correlation
const lastAICall    = {};  // throttle: { pair: timestamp }
const lastAIScore   = {};  // { pair: score } - skip AI if score unchanged

async function deleteTelegramMsg(msgId) {
if (!msgId) return;
try {
await fetch(`https://api.telegram.org/bot${TG_TOKEN}/deleteMessage`, {
method: ‘POST’, headers: { ‘Content-Type’: ‘application/json’ },
body: JSON.stringify({ chat_id: TG_CHAT, message_id: msgId })
});
} catch(e) { log(`[WARN] TG delete: ${e.message}`); }
}

async function sendTelegramMsg(text, replyToMsgId=null){
try{
const body = { chat_id:TG_CHAT, text, parse_mode:‘HTML’, disable_web_page_preview:true };
if(replyToMsgId) body.reply_to_message_id = replyToMsgId;
const res  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
method:‘POST’, headers:{‘Content-Type’:‘application/json’},
body: JSON.stringify(body)
});
const data = await res.json();
return data?.result?.message_id || null;
}catch(e){ log(`[WARN] TG msg: ${e.message}`); return null; }
}

const PAIRS = [
{ key:‘EURUSD’, label:‘EUR/USD’, dec:5, pip:0.0001 },
{ key:‘GBPUSD’, label:‘GBP/USD’, dec:5, pip:0.0001 },
{ key:‘XAUUSD’, label:‘XAU/USD’, dec:2, pip:0.10   },
{ key:‘USDJPY’, label:‘USD/JPY’, dec:3, pip:0.01   },
];
const TD_MAP = { ‘EUR/USD’:‘EURUSD’,‘GBP/USD’:‘GBPUSD’,‘XAU/USD’:‘XAUUSD’,‘USD/JPY’:‘USDJPY’ };
const POLY_MAP = { EURUSD:‘C:EURUSD’,GBPUSD:‘C:GBPUSD’,XAUUSD:‘C:XAUUSD’,USDJPY:‘C:USDJPY’ };

const PRICE_SECS = 60;   // fetch prices every 60s (active hours only)
const SCAN_SECS  = 60;   // AI scan every 60s
const CANDLE_MS  = 2 * 60 * 60 * 1000; // refresh candles every 2h

// — State –––––––––––––––––––––––––
const prices     = {};
const prevPrices = {};
const prevClose  = {};
const candles    = {};
const liveCandle = {};
let   lastSig    = {};   // lastSig[key] = { sig, time } - reset after 2h
let   calEvents  = [];
let   calBlocked = false;

// — Utils –––––––––––––––––––––––––
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Session tracking
let lastSession = ‘’;
let dayStats = { signals:0, tp1:0, tp2:0, tp3:0, sl:0, date:’’ };

function getSession() {
const h = new Date().getUTCHours();
if(h >= 8  && h < 13) return ‘🇬🇧 London’;
if(h >= 13 && h < 17) return ‘🔀 London+NY Overlap’;
if(h >= 17 && h < 21) return ‘🇺🇸 New York’;
return ‘🌏 Asian’;
}

function isActiveSession() {
const now = new Date();
const h   = now.getUTCHours();
const day = now.getUTCDay(); // 0=Sun, 6=Sat
if (day === 0 || day === 6) return false; // weekend
return h >= 8 && h < 21;
}

function log(msg) {
console.log(`[${new Date().toISOString()}] ${msg}`);
}

// UTC timestamp for Telegram messages - ex: “14:32 UTC”
function utcTime() {
const now = new Date();
const h = String(now.getUTCHours()).padStart(2,‘0’);
const m = String(now.getUTCMinutes()).padStart(2,‘0’);
return `${h}:${m} UTC`;
}

// Check session change - ka-yb3at message ki tbeddel
async function checkSessionChange() {
// No messages on weekends
const dayNow = new Date().getUTCDay();
if (dayNow === 0 || dayNow === 6) return;
if(!isActiveSession()) return;
const session = getSession();
if(session === lastSession) return;

// Session changed or first time
const isStart = lastSession === ‘’ || lastSession === ‘🌏 Asian’;
lastSession = session;

const sessionInfo = {
‘🇬🇧 London’:          { time:‘09h00-18h00’, pairs:‘EUR/USD • GBP/USD’, tip:‘Breakouts + trend Londres’ },
‘🔀 London+NY Overlap’: { time:‘14h00-18h00’, pairs:‘Toutes les paires’, tip:‘🔥 Meilleure liquidité - aktar signals’ },
‘🇺🇸 New York’:         { time:‘14h00-23h00’, pairs:‘EUR/USD • USD/JPY’, tip:‘Volatilité USD forte’ },
};
const info = sessionInfo[session] || { time:’-’, pairs:’-’, tip:’-’ };

## const msg = `⏰ <b>SESSION ${isStart?‘OUVERTE’:‘CHANGÉE’}</b> - ${utcTime()}

## ${session}
🕐 ${info.time} UTC
📊 Paires actives: ${info.pairs}
💡 ${info.tip}

🤖 Scan actif - en attente de setup…
#Session #FXSignalPro`;

await sendTelegramMsg(msg);
log(`[OK] Session message sent: ${session}`);
}

// End of Day summary - 21h UTC
async function sendEndOfDaySummary() {
try {
const todayISO = new Date().toISOString().split(‘T’)[0];
const trades = await dbSelect(‘trades’,
`created_at=gte.${todayISO}T00:00:00Z&created_at=lte.${todayISO}T23:59:59Z&order=created_at.asc`
);

```
const total   = trades.length;
const tp1hits = trades.filter(t=>t.tp1_hit).length;
const tp2hits = trades.filter(t=>t.tp2_hit).length;
const tp3hits = trades.filter(t=>t.tp3_hit).length;
const slhits  = trades.filter(t=>t.sl_hit).length;
const be      = trades.filter(t=>!t.tp1_hit&&!t.sl_hit&&t.status==='closed').length;
const wins    = trades.filter(t=>t.tp1_hit||t.tp2_hit||t.tp3_hit||(t.ai_close&&parseFloat(t.ai_close_pnl_r||0)>0.1)).length;
const wr      = total > 0 ? Math.round((wins/total)*100) : 0;

// P&L total basé sur RR
// TP1=40% position RR1.5, TP2=35% RR2.5, TP3=25% RR4 - SL=-1R
let totalRR = 0;
for(const t of trades){
  const entry = parseFloat(t.entry);
  const sl    = parseFloat(t.sl);
  const tp1   = parseFloat(t.tp1);
  const tp2   = parseFloat(t.tp2);
  const tp3   = parseFloat(t.tp3);
  if(!entry||!sl) continue;
  const slDist = Math.abs(entry-sl);
  if(!slDist) continue;
  let rr = 0;
  if(t.sl_hit){ rr = -1; }
  else if(t.tp3_hit){ rr += tp1?((Math.abs(tp1-entry)/slDist)*0.40):0; rr += tp2?((Math.abs(tp2-entry)/slDist)*0.35):0; rr += tp3?((Math.abs(tp3-entry)/slDist)*0.25):0; }
  else if(t.tp2_hit){ rr += tp1?((Math.abs(tp1-entry)/slDist)*0.40):0; rr += tp2?((Math.abs(tp2-entry)/slDist)*0.35):0; }
  else if(t.tp1_hit){ rr += tp1?((Math.abs(tp1-entry)/slDist)*0.40):0; }
  else if(t.ai_close){ rr = parseFloat(t.ai_close_pnl_r||0); } // AI CLOSE - real P&L
  else if(t.status==='closed'){ rr = 0; } // BE
  totalRR += rr;
}

// Trade list détaillé
const tradeLines = trades.map((t,i) => {
  const sig  = t.signal==='BUY' ? '🟢 Buy' : '🔴 Sell';
  let result = '';
  if(t.sl_hit)                                result = 'SL ❌';
  else if(t.tp3_hit)                          result = 'TP1 ✅ TP2 ✅ TP3 ✅';
  else if(t.tp2_hit)                          result = 'TP1 ✅ TP2 ✅';
  else if(t.tp1_hit)                          result = 'TP1 ✅';
  else if(t.ai_close){
    const r = parseFloat(t.ai_close_pnl_r||0);
    result = r > 0.1 ? `🤖 AI Close ✅ +${r.toFixed(2)}R` : r < -0.1 ? `🤖 AI Close ❌ ${r.toFixed(2)}R` : '🤖 AI Close ➡️ BE';
  }
  else if(t.status==='closed')                result = 'BE ➡️';
  else                                        result = '⏳ En cours';
  return `  ${i+1}. ${sig} ${t.pair} -> ${result}`;
}).join('\n');

const today = new Date().toLocaleDateString('fr-FR', {
  weekday:'long', day:'numeric', month:'long',
  timeZone:'UTC'
});

const perf = totalRR > 1 ? '🔥 Excellente journée' :
             totalRR > 0 ? '✅ Bonne journée' :
             totalRR === 0 ? '➡️ Journée neutre (BE)' : '❌ Journée difficile';

const rrStr = totalRR >= 0 ? `+${totalRR.toFixed(2)}R` : `${totalRR.toFixed(2)}R`;

const msg = `🌙 <b>RÉSUMÉ DE JOURNÉE - FX SIGNAL PRO</b>
```

-----

⏰ ${utcTime()}
📅 ${today.charAt(0).toUpperCase()+today.slice(1)}

${total > 0 ? `📋 <b>Trades du jour:</b>
${tradeLines}

-----

📊 <b>Statistiques:</b>
Signals: ${total} | Wins: ${wins} | Losses: ${slhits} | BE: ${be}
Win Rate: ${total>0?wr+’%’:’-’}
TP1: ${tp1hits} | TP2: ${tp2hits} | TP3: ${tp3hits} | SL: ${slhits}

💰 <b>P&L total: ${rrStr}</b>
(basé sur RR - TP1×40% + TP2×35% + TP3×25%)

${perf}`:`😴 Aucun signal aujourd’hui - marché en range`}

-----

📅 Prochain briefing demain à 08h00 UTC
#EndOfDay #FXSignalPro`;

```
// Friday EOD - add "See you Monday" message
const eodDay = new Date().getUTCDay(); // 5 = Friday
let finalMsg = msg;
if (eodDay === 5) {
  finalMsg += `
```

🌙 <b>Bon week-end à tous!</b>
On se retrouve lundi à l’ouverture du marché.
Profitez bien du repos 💪
<i>See you next week!</i>`;
}

```
await sendTelegramMsg(finalMsg);
log(`[OK] End of day summary sent - ${total} trades | ${rrStr}`);

// Reset lastSig - signals jdad nhar jdid [OK]
lastSig = {};  // reset kol signal - nhar jdid
lastSession = '';
```

} catch(e) {
log(`[WARN] EOD summary: ${e.message}`);
}
}

// Schedule End of Day at 21h00 UTC
function scheduleEndOfDay() {
const now    = new Date();
const next21 = new Date();
next21.setUTCHours(21, 0, 0, 0);
if(now.getUTCHours() >= 21) next21.setUTCDate(next21.getUTCDate()+1);
const msUntil = next21.getTime() - now.getTime();
log(`[EOD] EOD summary scheduled in ${Math.round(msUntil/60000)} minutes`);
setTimeout(async () => {
const day = new Date().getUTCDay();
if (day !== 0 && day !== 6) { // Skip Sunday(0) and Saturday(6)
await sendEndOfDaySummary();
} else {
log(’[EOD] Weekend - skipping EOD summary’);
lastSig = {};
lastSession = ‘’;
}
// Schedule next day (skip weekends)
const scheduleNext = () => {
const n = new Date();
n.setUTCHours(21, 0, 0, 0);
n.setUTCDate(n.getUTCDate() + 1);
// If next day is Saturday(6) skip to Monday
if (n.getUTCDay() === 6) n.setUTCDate(n.getUTCDate() + 2);
// If next day is Sunday(0) skip to Monday
else if (n.getUTCDay() === 0) n.setUTCDate(n.getUTCDate() + 1);
setTimeout(async () => {
const d = new Date().getUTCDay();
if (d !== 0 && d !== 6) await sendEndOfDaySummary();
else { lastSig = {}; lastSession = ‘’; }
scheduleNext();
}, n.getTime() - Date.now());
};
scheduleNext();
}, msUntil);
}

// Weekly Report - every Friday at 21h00 UTC
async function sendWeeklyReport() {
try {
// Get trades from last 7 days
const fromISO = new Date(Date.now() - 7*24*60*60*1000).toISOString();
const trades  = await dbSelect(‘trades’,
`created_at=gte.${fromISO}&order=created_at.asc`
);

```
const total   = trades.length;
const tp1hits = trades.filter(t=>t.tp1_hit).length;
const tp2hits = trades.filter(t=>t.tp2_hit).length;
const tp3hits = trades.filter(t=>t.tp3_hit).length;
const slhits  = trades.filter(t=>t.sl_hit).length;
const be      = trades.filter(t=>!t.tp1_hit&&!t.sl_hit&&t.status==='closed').length;
const wins    = trades.filter(t=>t.tp1_hit||t.tp2_hit||t.tp3_hit||(t.ai_close&&parseFloat(t.ai_close_pnl_r||0)>0.1)).length;
const wr      = total > 0 ? Math.round((wins/total)*100) : 0;

// Group by day
const byDay = {};
for(const t of trades){
  const day = new Date(t.created_at).toLocaleDateString('fr-FR', {
    weekday:'long', day:'numeric', month:'long', timeZone:'UTC'
  });
  if(!byDay[day]) byDay[day] = [];
  byDay[day].push(t);
}

// P&L per day + total
let totalRR = 0;
const dayLines = Object.entries(byDay).map(([day, dayTrades]) => {
  let dayRR = 0;
  const lines = dayTrades.map(t => {
    const entry  = parseFloat(t.entry);
    const sl     = parseFloat(t.sl);
    const tp1    = parseFloat(t.tp1);
    const tp2    = parseFloat(t.tp2);
    const tp3    = parseFloat(t.tp3);
    const slDist = Math.abs(entry-sl);
    let rr = 0;
    if(t.sl_hit)       rr = -1;
    else if(t.tp3_hit)  rr = (Math.abs(tp1-entry)/slDist)*0.40 + (Math.abs(tp2-entry)/slDist)*0.35 + (Math.abs(tp3-entry)/slDist)*0.25;
    else if(t.tp2_hit)  rr = (Math.abs(tp1-entry)/slDist)*0.40 + (Math.abs(tp2-entry)/slDist)*0.35;
    else if(t.tp1_hit)  rr = (Math.abs(tp1-entry)/slDist)*0.40;
    else if(t.ai_close) rr = parseFloat(t.ai_close_pnl_r||0); // AI CLOSE real P&L
    if(slDist) dayRR += rr;

    const sig    = t.signal==='BUY'?'🟢':'🔴';
    let result;
    if(t.sl_hit)       result = 'SL ❌';
    else if(t.tp3_hit) result = 'TP1✅TP2✅TP3✅';
    else if(t.tp2_hit) result = 'TP1✅TP2✅';
    else if(t.tp1_hit) result = 'TP1✅';
    else if(t.ai_close){ const ar=parseFloat(t.ai_close_pnl_r||0); result = ar>0.1?`🤖AI+${ar.toFixed(2)}R✅`:ar<-0.1?`🤖AI${ar.toFixed(2)}R❌`:'🤖AI BE➡️'; }
    else result = t.status==='closed' ? 'BE➡️' : '⏳';
    return `    ${sig} ${t.pair} -> ${result}`;
  }).join('\n');

  totalRR += dayRR;
  const rrStr = dayRR >= 0 ? `+${dayRR.toFixed(2)}R` : `${dayRR.toFixed(2)}R`;
  const dayWins = dayTrades.filter(t=>t.tp1_hit||t.tp2_hit||t.tp3_hit||(t.ai_close&&parseFloat(t.ai_close_pnl_r||0)>0.1)).length;
  return `📅 <b>${day.charAt(0).toUpperCase()+day.slice(1)}</b> (${dayTrades.length} trades | ${rrStr})\n${lines}`;
}).join('\n\n');

const totalRRStr = totalRR >= 0 ? `+${totalRR.toFixed(2)}R` : `${totalRR.toFixed(2)}R`;
const perf = totalRR > 3  ? '🔥 Excellente semaine' :
             totalRR > 0  ? '✅ Semaine profitable' :
             totalRR === 0 ? '➡️ Semaine neutre (BE)' : '❌ Semaine difficile';

// Best pair
const pairStats = {};
for(const t of trades){
  if(!pairStats[t.pair]) pairStats[t.pair] = { wins:0, total:0 };
  pairStats[t.pair].total++;
  if(t.tp1_hit||t.tp2_hit||t.tp3_hit) pairStats[t.pair].wins++;
}
const bestPair = Object.entries(pairStats)
  .sort((a,b) => (b[1].wins/b[1].total) - (a[1].wins/a[1].total))[0];

const msg = `📊 <b>RAPPORT HEBDOMADAIRE - FX SIGNAL PRO</b>
```

-----

⏰ ${utcTime()}
🗓️ Semaine du ${new Date(Date.now()-6*24*60*60*1000).toLocaleDateString(‘fr-FR’,{day:‘numeric’,month:‘long’})} au ${new Date().toLocaleDateString(‘fr-FR’,{day:‘numeric’,month:‘long’,year:‘numeric’})}

${total > 0 ? `${dayLines}

-----

📈 <b>RÉSUMÉ DE LA SEMAINE:</b>
Total signals: ${total}
✅ Wins: ${wins} | ❌ Losses: ${slhits} | ➡️ BE: ${be}
📊 Win Rate: ${wr}%
🎯 TP1: ${tp1hits} | TP2: ${tp2hits} | TP3: ${tp3hits} | SL: ${slhits}

💰 <b>P&L total semaine: ${totalRRStr}</b>
(TP1×40% + TP2×35% + TP3×25%)
${bestPair ? `\n🏆 Meilleure paire: ${bestPair[0]} (${Math.round(bestPair[1].wins/bestPair[1].total*100)}% WR)` : ‘’}

${perf}`:`😴 Aucun signal cette semaine`}

-----

🌙 <b>Bon week-end à tous!</b>
On se retrouve lundi à l’ouverture du marché - restez disciplinés 💪
<i>See you next week! 🚀</i>
#WeeklyReport #FXSignalPro`;

```
await sendTelegramMsg(msg);
log(`[OK] Weekly report sent - ${total} trades | ${totalRRStr}`);
```

} catch(e) {
log(`[WARN] Weekly report: ${e.message}`);
}
}

// Schedule weekly report - every Friday 21h UTC
function scheduleWeeklyReport() {
const now  = new Date();
const next = new Date();
// Find next Friday 21h UTC
const daysUntilFriday = (5 - now.getUTCDay() + 7) % 7 || 7; // 5 = Friday
next.setUTCDate(now.getUTCDate() + (daysUntilFriday === 0 && now.getUTCHours() >= 21 ? 7 : daysUntilFriday));
next.setUTCHours(21, 0, 0, 0);
const msUntil = next.getTime() - now.getTime();
log(`[STATS] Weekly report scheduled in ${Math.round(msUntil/3600000)}h`);
setTimeout(async () => {
await sendWeeklyReport();
setInterval(sendWeeklyReport, 7*24*60*60*1000);
}, msUntil);
}

// — Technical Indicators ———————————–
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
resistance: Math.max(…highs),
support: Math.min(…lows),
recentHigh: Math.max(…recent.map(x => x.h)),
recentLow: Math.min(…recent.map(x => x.l)),
};
}

function findNextSRLevels(candles1h, candles4h, price, isBuy) {
const pivots = [];
const collectPivots = (candles, label) => {
const c = candles.slice(-80);
for(let i=2; i<c.length-2; i++){
const isHigh = c[i].h>c[i-1].h && c[i].h>c[i-2].h && c[i].h>c[i+1].h && c[i].h>c[i+2].h;
const isLow  = c[i].l<c[i-1].l && c[i].l<c[i-2].l && c[i].l<c[i+1].l && c[i].l<c[i+2].l;
if(isHigh) pivots.push({ level: c[i].h, type:‘resistance’, src:label });
if(isLow)  pivots.push({ level: c[i].l, type:‘support’,    src:label });
}
};
collectPivots(candles1h, ‘1H’);
collectPivots(candles4h, ‘4H’);
const minDist = price * 0.0005;
const relevant = pivots
.filter(p => isBuy ? p.level > price + minDist : p.level < price - minDist)
.sort((a,b) => isBuy ? a.level - b.level : b.level - a.level);
const deduped = [];
for(const p of relevant){
const last = deduped[deduped.length-1];
if(!last || Math.abs(p.level-last.level)/price > 0.001) deduped.push(p);
}
return deduped.slice(0, 5);
}

function calcStructuredSLTP(candles1h, candles15m, candles4h, price, isBuy, dec) {
const pip    = dec===2 ? 0.10 : dec===3 ? 0.01 : 0.0001;
const minSL  = pip * (dec===2 ? 80 : 8);
const c15    = candles15m.slice(-20);
const swH15  = c15.length ? Math.max(…c15.map(x=>x.h)) : price;
const swL15  = c15.length ? Math.min(…c15.map(x=>x.l)) : price;
const sl     = isBuy
? Math.min(swL15 - pip*2, price - minSL)
: Math.max(swH15 + pip*2, price + minSL);
const slDist = Math.abs(price - sl);
const nextLevels = findNextSRLevels(candles1h, candles4h, price, isBuy);

let tp1=null, tp1RR=0;
for(const lvl of nextLevels){
const rr = Math.abs(lvl.level-price)/slDist;
if(rr>=1.5 && rr<=3.5){ tp1=lvl.level; tp1RR=rr; break; }
}
if(!tp1){ tp1 = isBuy ? price+slDist*2 : price-slDist*2; tp1RR=2; }

let tp2=null;
for(const lvl of nextLevels){
const rr = Math.abs(lvl.level-price)/slDist;
if(rr > tp1RR+0.3 && rr<=5){ tp2=lvl.level; break; }
}
if(!tp2) tp2 = isBuy ? price+slDist*3 : price-slDist*3;

let tp3=null;
for(const lvl of nextLevels){
const rr = Math.abs(lvl.level-price)/slDist;
if(rr > Math.abs(tp2-price)/slDist+0.3 && rr<=6){ tp3=lvl.level; break; }
}
if(!tp3) tp3 = isBuy ? price+slDist*4 : price-slDist*4;

return {
sl:  parseFloat(sl.toFixed(dec)),
tp1: parseFloat(tp1.toFixed(dec)),
tp2: parseFloat(tp2.toFixed(dec)),
tp3: parseFloat(tp3.toFixed(dec)),
slDist: parseFloat(slDist.toFixed(dec+1)),
tp1RR:  parseFloat(tp1RR.toFixed(2)),
nextLevels: nextLevels.slice(0,3).map(l=>l.level.toFixed(dec))
};
}

function getSwingStructure(cands) {
const c = cands.slice(-20);
if (c.length < 4) return ‘neutre’;
const highs = c.map(x => x.h), lows = c.map(x => x.l);
const hh = highs[highs.length-1] > highs[highs.length-3];
const hl = lows[lows.length-1]   > lows[lows.length-3];
const ll = lows[lows.length-1]   < lows[lows.length-3];
const lh = highs[highs.length-1] < highs[highs.length-3];
if (hh && hl) return ‘haussier’;
if (ll && lh) return ‘baissier’;
return ‘neutre’;
}

// — ATR (Average True Range) —————————––
function calcATR(candles, period = 14) {
if (!candles || candles.length < period + 1) return null;
const trs = [];
for (let i = 1; i < candles.length; i++) {
const h = candles[i].h, l = candles[i].l, pc = candles[i-1].c;
trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
}
// Wilders smoothing
let atr = trs.slice(0, period).reduce((a,b) => a+b, 0) / period;
for (let i = period; i < trs.length; i++) atr = (atr * (period-1) + trs[i]) / period;
return atr;
}

// ATR Volatility Filter - returns { ok, label, atr, atrPct }
function atrFilter(candles1h, price, dec) {
const atr = calcATR(candles1h, 14);
if (!atr) return { ok: true, label: ‘ATR N/A’, atr: null, atrPct: null };
const atrPct = (atr / price) * 100;
// Dead market: ATR < 0.03% price -> no movement
// Spike/news: ATR > 0.35% price -> too risky
const dead  = atrPct < 0.03;
const spike = atrPct > 0.35;
const ok    = !dead && !spike;
const label = dead ? ‘😴 Marché mort (ATR trop bas)’ : spike ? ‘⚡ Spike/News (ATR trop élevé)’ : `✅ ATR normal (${atrPct.toFixed(3)}%)`;
return { ok, label, atr: parseFloat(atr.toFixed(dec+1)), atrPct: parseFloat(atrPct.toFixed(4)) };
}

// — Order Blocks ––––––––––––––––––––––
// VALID OB = last bearish/bullish candle + 3 strong candles after + displacement
// Displacement = move > 1.5x the OB candle body size
function findOrderBlocks(candles1h, price, dec) {
const c = candles1h.slice(-60);
if (c.length < 10) return { bullOB: null, bearOB: null, nearBullOB: false, nearBearOB: false };

let bullOB = null, bearOB = null;

for (let i = 1; i < c.length - 4; i++) {
const ob    = c[i];
const next1 = c[i+1], next2 = c[i+2], next3 = c[i+3];

```
// -- Bullish OB --
// Condition 1: OB candle is bearish (red)
const isBearOB = ob.c < ob.o;
const obBearBody = ob.o - ob.c;

if (isBearOB && obBearBody > 0) {
  // Condition 2: next 3 candles all bullish
  const allBull = next1.c > next1.o && next2.c > next2.o && next3.c > next3.o;
  // Condition 3: each bull candle has body > 60% of range (strong)
  const bull1Strong = (next1.c - next1.o) / (next1.h - next1.l || 1) > 0.6;
  const bull2Strong = (next2.c - next2.o) / (next2.h - next2.l || 1) > 0.6;
  const bull3Strong = (next3.c - next3.o) / (next3.h - next3.l || 1) > 0.6;
  // Condition 4: displacement = total move of 3 candles > 1.5x OB body
  const displacement = next3.c - ob.c;
  const hasDisplacement = displacement > obBearBody * 1.5;

  if (allBull && (bull1Strong || bull2Strong) && bull3Strong && hasDisplacement) {
    bullOB = { top: ob.o, bottom: ob.l };
  }
}

// -- Bearish OB --
// Condition 1: OB candle is bullish (green)
const isBullOB = ob.c > ob.o;
const obBullBody = ob.c - ob.o;

if (isBullOB && obBullBody > 0) {
  // Condition 2: next 3 candles all bearish
  const allBear = next1.c < next1.o && next2.c < next2.o && next3.c < next3.o;
  // Condition 3: each bear candle has body > 60% of range (strong)
  const bear1Strong = (next1.o - next1.c) / (next1.h - next1.l || 1) > 0.6;
  const bear2Strong = (next2.o - next2.c) / (next2.h - next2.l || 1) > 0.6;
  const bear3Strong = (next3.o - next3.c) / (next3.h - next3.l || 1) > 0.6;
  // Condition 4: displacement = total move > 1.5x OB body
  const displacement = ob.c - next3.c;
  const hasDisplacement = displacement > obBullBody * 1.5;

  if (allBear && (bear1Strong || bear2Strong) && bear3Strong && hasDisplacement) {
    bearOB = { top: ob.h, bottom: ob.c };
  }
}
```

}

// Price inside OB zone = retrace back into the OB
const nearBullOB = bullOB ? price >= bullOB.bottom * 0.9995 && price <= bullOB.top * 1.0005 : false;
const nearBearOB = bearOB ? price >= bearOB.bottom * 0.9995 && price <= bearOB.top * 1.0005 : false;

return {
bullOB: bullOB ? { top: bullOB.top.toFixed(dec), bottom: bullOB.bottom.toFixed(dec) } : null,
bearOB: bearOB ? { top: bearOB.top.toFixed(dec), bottom: bearOB.bottom.toFixed(dec) } : null,
nearBullOB,
nearBearOB,
};
}

// — Candle Momentum Filter –––––––––––––––––
// Last 3 closed candles on 15m
// body / range > 0.6 = strong candle
// 2+ strong in direction -> STRONG
// 1  strong in direction -> NEUTRAL
// 0  strong in direction -> WEAK
function candleStrength(candles15m, direction) {
if (!candles15m || candles15m.length < 4) {
return { strong: false, level: ‘neutral’, strongCount: 0, label: ‘N/A’ };
}

const last3 = candles15m.slice(-4, -1); // 3 dernières bougies fermées
let strongCount = 0;

for (const candle of last3) {
const body    = Math.abs(candle.c - candle.o);
const range   = candle.h - candle.l;
const bodyPct = range > 0 ? body / range : 0;
const isBull  = candle.c > candle.o;
const isBear  = candle.c < candle.o;

```
// Strong candle dans la bonne direction: body > 60% range
if (direction === 'bull' && isBull && bodyPct > 0.6) strongCount++;
if (direction === 'bear' && isBear && bodyPct > 0.6) strongCount++;
```

}

// 3 levels
const level  = strongCount >= 2 ? ‘strong’ : strongCount === 1 ? ‘neutral’ : ‘weak’;
const strong = level === ‘strong’;
const dirLabel = direction === ‘bull’ ? ‘haussières’ : ‘baissières’;
const label  = level === ‘strong’
? `✅ Momentum fort - ${strongCount}/3 bougies ${dirLabel} solides`
: level === ‘neutral’
? `⚠️ Momentum neutre - ${strongCount}/3 bougie ${dirLabel} solide`
: `❌ Momentum faible - 0/3 bougies ${dirLabel} solides`;

return { strong, level, strongCount, label };
}

// — Compute Technicals ———————————––
function computeTechnicals(key) {
const price = prices[key];
const c = candles[key];
if (!price || !c?.h1?.length || c.h1.length < 20) return null;

// h1_calc = closed candles only -> EMA / RSI / Structure / ATR / OB (always clean)
// prices[key] = live price -> entry / TP/SL / P&L (always real-time)
const h1 = […c.h1];

const h4 = c.h4 || [];
const m15 = c.m15 || [];
const closes1h  = h1.map(x => x.c);
const closes4h  = h4.map(x => x.c);
const closes15m = m15.map(x => x.c);
const dec = PAIRS.find(p => p.key === key).dec;

// Daily bias (trend long terme - l muhim)
const daily = c.daily || [];
const closesDaily = daily.map(x => x.c);
const ema20_daily = calcEMA(closesDaily, Math.min(20, closesDaily.length));
const ema50_daily = calcEMA(closesDaily, Math.min(50, closesDaily.length));
const structDaily = getSwingStructure(daily.slice(-30));
const lastCloseDaily = closesDaily[closesDaily.length - 1] || price;
const trendDaily = (ema50_daily && lastCloseDaily > ema50_daily && structDaily === ‘haussier’) ? ‘haussier’
: (ema50_daily && lastCloseDaily < ema50_daily && structDaily === ‘baissier’) ? ‘baissier’
: structDaily || ‘neutre’;

// Daily/4H bias
const ema50_4h   = calcEMA(closes4h, Math.min(50, closes4h.length));
const struct4h   = getSwingStructure(h4.slice(-30));
const lastClose4h = closes4h[closes4h.length - 1] || price;
const trend4h = (ema50_4h && lastClose4h > ema50_4h && struct4h === ‘haussier’) ? ‘haussier’
: (ema50_4h && lastClose4h < ema50_4h && struct4h === ‘baissier’) ? ‘baissier’
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
const struct15m = closes15m.length >= 8 ? getSwingStructure(m15.slice(-15)) : ‘neutre’;
const sr15m = closes15m.length >= 10 ? findSR(m15, 30) : sr1h;
const swing15mH = m15.length >= 6 ? Math.max(…m15.slice(-6).map(x => x.h)) : price;
const swing15mL = m15.length >= 6 ? Math.min(…m15.slice(-6).map(x => x.l)) : price;
const bos15m_bull = price > swing15mH * 1.0001 && struct15m === ‘haussier’;
const bos15m_bear = price < swing15mL * 0.9999 && struct15m === ‘baissier’;
const emaCross15m_bull = ema9_15m && ema21_15m && ema9_15m > ema21_15m && price > ema9_15m;
const emaCross15m_bear = ema9_15m && ema21_15m && ema9_15m < ema21_15m && price < ema9_15m;

// S&R
const range4h = sr4h.resistance - sr4h.support;
const pos4h = range4h > 0 ? (price - sr4h.support) / range4h : 0.5;
const nearSupport    = pos4h < 0.2;
const nearResistance = pos4h > 0.8;

// Liquidity Zones
const last10_4h  = h4.slice(-10);
const highs4h    = last10_4h.map(x=>x.h);
const lows4h     = last10_4h.map(x=>x.l);
const prevDayHigh = highs4h.length >= 2 ? Math.max(…highs4h.slice(-2)) : null;
const prevDayLow  = lows4h.length  >= 2 ? Math.min(…lows4h.slice(-2))  : null;
const eqHigh = highs4h.length>=3 ? highs4h.filter(h=>Math.abs(h-Math.max(…highs4h))/Math.max(…highs4h)<0.001).length>=2 : false;
const eqLow  = lows4h.length >=3 ? lows4h.filter(l=>Math.abs(l-Math.min(…lows4h))/Math.min(…lows4h)<0.001).length>=2  : false;
const recentHigh4h = highs4h.length ? Math.max(…highs4h.slice(-3)) : price;
const recentLow4h  = lows4h.length  ? Math.min(…lows4h.slice(-3))  : price;
const liqSweepBull = price < recentLow4h  * 1.002 && struct4h === ‘haussier’;
const liqSweepBear = price > recentHigh4h * 0.998 && struct4h === ‘baissier’;
const nearPDH = prevDayHigh ? Math.abs(price-prevDayHigh)/price < 0.003 : false;
const nearPDL = prevDayLow  ? Math.abs(price-prevDayLow) /price < 0.003 : false;
const liqBull = (liqSweepBull||nearPDL||eqLow)  && struct4h===‘haussier’;
const liqBear = (liqSweepBear||nearPDH||eqHigh) && struct4h===‘baissier’;

// EMA alignment
const bullishEMA = ema20 && ema50 && ema20 > ema50 && price > ema20;
const bearishEMA = ema20 && ema50 && ema20 < ema50 && price < ema20;
const emaDir = bullishEMA ? ‘haussier’ : bearishEMA ? ‘baissier’ : ‘neutre’;

// RSI
const rsiOversold   = rsi14 && rsi14 < 35;
const rsiOverbought = rsi14 && rsi14 > 65;
const rsiDir = rsiOversold ? ‘haussier’ : rsiOverbought ? ‘baissier’ : ‘neutre’;

// ICT/SMC
const active = isActiveSession();
const swingH = sr1h.recentHigh, swingL = sr1h.recentLow;
const bos_bull = price > swingH * 1.0002 && struct1h === ‘haussier’;
const bos_bear = price < swingL * 0.9998 && struct1h === ‘baissier’;
const midRange = (swingH + swingL) / 2;
const fvg_bull = price < midRange && struct1h === ‘haussier’;
const fvg_bear = price > midRange && struct1h === ‘baissier’;
const ict15m_bull = active && bos15m_bull && emaCross15m_bull && trend4h === ‘haussier’;
const ict15m_bear = active && bos15m_bear && emaCross15m_bear && trend4h === ‘baissier’;

// – ATR Volatility Filter –
const atrData = atrFilter(h1, price, dec);
const atr1h   = atrData.atr;
const atrPct  = atrData.atrPct;
const atrOk   = atrData.ok;
const atrLabel = atrData.label;

// – Order Blocks –
const obData     = findOrderBlocks(h1, price, dec);
const nearBullOB = obData.nearBullOB;
const nearBearOB = obData.nearBearOB;
const bullOB     = obData.bullOB;
const bearOB     = obData.bearOB;

// – Candle Strength Filter –
const csDir    = struct15m === ‘haussier’ ? ‘bull’ : ‘bear’;
const csData   = candleStrength(m15, csDir);
const candlesOk = csData.strong;
const candlesLabel = csData.label;

// – Volume Analysis (1H tick volume) –
let volContext = ‘N/A’, volRatio = null, lastVol = null, avgVol = null;
const volCandles = h1.slice(-20);
if(volCandles.length >= 5 && volCandles.some(v => v.v > 0)){
const vols = volCandles.map(v => v.v).filter(v => v > 0);
avgVol = Math.round(vols.reduce((a,b) => a+b, 0) / vols.length);
lastVol = volCandles[volCandles.length-1].v;
volRatio = avgVol > 0 ? parseFloat((lastVol / avgVol).toFixed(2)) : 1;
volContext = volRatio >= 1.5 ? ‘HIGH’ : volRatio <= 0.5 ? ‘LOW’ : ‘NORMAL’;
}

// Scores
let srScore = nearSupport ? 25 : nearResistance ? 25 : 0;
let srDir   = nearSupport ? ‘haussier’ : nearResistance ? ‘baissier’ : ‘neutre’;
if (srScore > 0 && trend4h !== srDir) srScore = 12;
// Order Block bonus - price in OB zone = extra confluence
if (nearBullOB && trend4h === ‘haussier’) { srScore = Math.min(25, srScore + 5); srDir = ‘haussier’; }
if (nearBearOB && trend4h === ‘baissier’) { srScore = Math.min(25, srScore + 5); srDir = ‘baissier’; }

let emaScore = 0, ictScore = 0, ictDir = ‘inactif’;
if (bullishEMA && trend4h === ‘haussier’) emaScore = 25;
else if (bearishEMA && trend4h === ‘baissier’) emaScore = 25;
else if (emaDir !== ‘neutre’) emaScore = 12;
const emaDir2 = emaScore > 0 ? emaDir : ‘neutre’;

let rsiScore = 0;
if (rsiOversold  && nearSupport)    rsiScore = 25;
else if (rsiOverbought && nearResistance) rsiScore = 25;
else if (rsiOversold || rsiOverbought)    rsiScore = 15;

if (active && (ict15m_bull || (bos_bull && bos15m_bull)) && trend4h === ‘haussier’) { ictScore = 25; ictDir = ‘haussier’; }
else if (active && (ict15m_bear || (bos_bear && bos15m_bear)) && trend4h === ‘baissier’) { ictScore = 25; ictDir = ‘baissier’; }
else if (active && (bos_bull || fvg_bull) && trend4h === ‘haussier’) { ictScore = 18; ictDir = ‘haussier’; }
else if (active && (bos_bear || fvg_bear) && trend4h === ‘baissier’) { ictScore = 18; ictDir = ‘baissier’; }
else if (active) ictScore = 5;

// Base score (100pts)
let totalScore = srScore + emaScore + rsiScore + ictScore;

// Bonus filters (max +20pts total) - affect throttle trigger too
// ATR bonus: normal volatility = +5
if (atrOk) totalScore = Math.min(100, totalScore + 5);

// Order Block bonus: price in OB aligned with trend = +8
if (nearBullOB && trend4h === ‘haussier’) totalScore = Math.min(100, totalScore + 8);
else if (nearBearOB && trend4h === ‘baissier’) totalScore = Math.min(100, totalScore + 8);

// Volume bonus: high volume = +4
if (volContext === ‘HIGH’) totalScore = Math.min(100, totalScore + 4);
else if (volContext === ‘LOW’) totalScore = Math.max(0, totalScore - 5); // penalty

// Candle Momentum bonus: strong = +3, weak = penalty
const candlesLevel = csData.level; // declare here for score use
if (candlesLevel === ‘strong’) totalScore = Math.min(100, totalScore + 3);
else if (candlesLevel === ‘weak’) totalScore = Math.max(0, totalScore - 3);
const bullCount = [srDir, emaDir2, rsiDir, ictDir].filter(d => d === ‘haussier’).length;
const bearCount = [srDir, emaDir2, rsiDir, ictDir].filter(d => d === ‘baissier’).length;
let finalDir = ‘neutre’;
if (bullCount >= 3) finalDir = ‘haussier’;
else if (bearCount >= 3) finalDir = ‘baissier’;
// 2 aligned = lean direction - still send to AI for final decision
else if (bullCount === 2) finalDir = ‘haussier_lean’;
else if (bearCount === 2) finalDir = ‘baissier_lean’;

// Structured SL/TP based on real S/R levels
const isBuyDir  = finalDir === ‘haussier’ || finalDir === ‘haussier_lean’;
const isSellDir = finalDir === ‘baissier’ || finalDir === ‘baissier_lean’;
const structuredLevels = (isBuyDir||isSellDir) && m15.length>=6 && h1.length>=20
? calcStructuredSLTP(h1, m15, h4, price, isBuyDir, dec)
: null;

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
prevDayHigh: prevDayHigh?.toFixed(dec)||null, prevDayLow: prevDayLow?.toFixed(dec)||null,
eqHigh, eqLow, liqSweepBull, liqSweepBear, nearPDH, nearPDL, liqBull, liqBear,
recentHigh: sr1h.recentHigh.toFixed(dec), recentLow: sr1h.recentLow.toFixed(dec),
bos_bull, bos_bear, fvg_bull, fvg_bear, active,
trendDaily, structDaily, ema20_daily: ema20_daily?.toFixed(4), ema50_daily: ema50_daily?.toFixed(4),
srScore, emaScore, rsiScore, ictScore, totalScore,
srDir, emaDir: emaDir2, rsiDir, ictDir, finalDir,
structuredLevels,
// New filters
atr1h, atrPct, atrOk, atrLabel,
bullOB, bearOB, nearBullOB, nearBearOB,
candlesOk, candlesLabel, candlesLevel: csData.level, candlesCount: csData.strongCount,
volContext, volRatio, lastVol, avgVol,
};
}

// — Fetch Prices —————————————––
// Fetch DXY (US Dollar Index) for correlation context
async function fetchDXY() {
try {
const [rPrice, rCandles] = await Promise.all([
fetch(`https://api.twelvedata.com/price?symbol=DX-Y.NYB&apikey=${TD_KEY}`),
fetch(`https://api.twelvedata.com/time_series?symbol=DX-Y.NYB&interval=1h&outputsize=20&apikey=${TD_KEY}`)
]);
const [dPrice, dCandles] = await Promise.all([rPrice.json(), rCandles.json()]);

```
const price = parseFloat(dPrice?.price);
if (!price) return;

dxyData.price = price;

// DXY trend from last 10 candles
if (dCandles?.values?.length >= 10) {
  const closes = dCandles.values.slice(0, 10).map(v => parseFloat(v.close)).reverse();
  const ema5 = closes.slice(-5).reduce((a,b) => a+b,0) / 5;
  const ema10 = closes.reduce((a,b) => a+b,0) / 10;
  dxyData.trend = ema5 > ema10 ? 'haussier' : ema5 < ema10 ? 'baissier' : 'neutre';
  dxyData.change = ((closes[closes.length-1] - closes[0]) / closes[0] * 100).toFixed(3);
}
log(`[OK] DXY: ${price.toFixed(3)} | trend: ${dxyData.trend} | change: ${dxyData.change}%`);
```

} catch(e) {
log(`[WARN] DXY fetch: ${e.message}`);
}
}

async function fetchPrices() {
// Refresh DXY every 30min
dxyRefreshCount = (dxyRefreshCount || 0) + 1;
if (dxyRefreshCount % 30 === 0) await fetchDXY();

// Always fetch if active trade exists (TP/SL tracking 24/7)
// Outside session + no active trades -> skip
const hasTrades = await dbSelect(‘trades’, ‘status=eq.active&limit=1’);
const hasActiveTrades = hasTrades && hasTrades.length > 0;
if (!isActiveSession() && !hasActiveTrades) return;
try {
const [r1, r2, r3, r4] = await Promise.all([
fetch(`https://api.twelvedata.com/price?symbol=EUR%2FUSD&apikey=${TD_KEY}`),
fetch(`https://api.twelvedata.com/price?symbol=GBP%2FUSD&apikey=${TD_KEY2}`),
fetch(`https://api.twelvedata.com/price?symbol=XAU%2FUSD&apikey=${TD_KEY3}`),
fetch(`https://api.twelvedata.com/price?symbol=USD%2FJPY&apikey=${TD_KEY4}`),
]);
const [d1, d2, d3, d4] = await Promise.all([r1.json(), r2.json(), r3.json(), r4.json()]);
const map = { ‘EUR/USD’: d1, ‘GBP/USD’: d2, ‘XAU/USD’: d3, ‘USD/JPY’: d4 };

```
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
log(`[OK] Prices: ${Object.keys(prices).map(k => `${k}=${prices[k]}`).join(' | ')}`);

// Save prices f Supabase - UPSERT (insert ola update automatique)
const priceUpdates = Object.entries(prices).map(([pair, price]) => {
  const prev = prevPrices[pair] || price;
  const change_pct = prev ? parseFloat(((price - prev) / prev * 100).toFixed(4)) : 0;
  return fetch(`${SB_URL}/rest/v1/prices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({ pair, price, change_pct, updated_at: new Date().toISOString() })
  });
});
await Promise.all(priceUpdates);
Object.assign(prevPrices, prices);
```

} catch(e) {
log(`[WARN] fetchPrices error: ${e.message}`);
}
}

// — Fetch Candles ——————————————
async function fetchDailyCandles(pairKey) {
const polyKey = POLY_MAP[pairKey];
if (!polyKey) return;
const today = new Date().toISOString().split(‘T’)[0];
const from  = new Date(Date.now() - 500 * 86400000).toISOString().split(‘T’)[0];
try {
const url = `https://api.polygon.io/v2/aggs/ticker/${polyKey}/range/1/day/${from}/${today}?adjusted=true&sort=asc&limit=500&apiKey=${POLY_KEY}`;
const res  = await fetch(url);
const data = await res.json();
const bars = (data.results || []).map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
if (!candles[pairKey]) candles[pairKey] = {};
if (bars.length) candles[pairKey].h4 = bars;
log(`[OK] Daily ${pairKey}: ${bars.length} candles`);
} catch (e) {
log(`[WARN] Daily ${pairKey}: ${e.message}`);
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
o: parseFloat(v.open), h: parseFloat(v.high), l: parseFloat(v.low), c: parseFloat(v.close),
v: parseFloat(v.volume) || 0,
})).reverse();
if (!candles[pairKey]) candles[pairKey] = {};
if (d1h?.values?.length)  candles[pairKey].h1  = parse(d1h);
if (d15m?.values?.length) candles[pairKey].m15 = parse(d15m);
log(`[OK] Intra ${pairKey}: 1H=${candles[pairKey].h1?.length} 15m=${candles[pairKey].m15?.length}`);
} catch (e) {
log(`[WARN] Intra ${pairKey}: ${e.message}`);
}
}

async function fetchAllCandles() {
log(’[STATS] Fetching candles…’);
for (const p of PAIRS) {
await fetchDailyCandles(p.key);
await sleep(13000); // Polygon free = 5 req/min
}
for (const p of PAIRS) {
await fetchIntraCandles(p.key);
await sleep(1000);
}
log(’[OK] All candles loaded’);
await fetchDXY(); // DXY correlation
}

// — Economic Calendar –––––––––––––––––––
async function fetchCalendar() {
try {
// Railway = server-side - direct fetch mashi bloqué [OK]
const url = `https://nfs.faireconomy.media/ff_calendar_thisweek.json`;
const res  = await fetch(url);
if(!res.ok) throw new Error(’HTTP ’+res.status);
const data = await res.json();
const todayStr = new Date().toLocaleDateString(‘en-US’, { month: ‘short’, day: ‘numeric’, year: ‘numeric’ });
calEvents = data.filter(e => {
const eDate = new Date(e.date).toLocaleDateString(‘en-US’, { month: ‘short’, day: ‘numeric’, year: ‘numeric’ });
return eDate === todayStr && [‘USD’, ‘EUR’, ‘GBP’, ‘JPY’].includes(e.currency);
});
const nowMs = Date.now();
calBlocked = calEvents.some(e => {
if (e.impact !== ‘High’) return false;
const diff = new Date(e.date).getTime() - nowMs;
return diff > -15 * 60000 && diff < 30 * 60000;
});
log(`[CAL] Calendar: ${calEvents.length} events today - blocked: ${calBlocked}`);

```
// Save f Supabase bach Vercel y9ra (mashi bloqué f browser) [OK]
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
    log(`[OK] Calendar saved to DB: ${calEvents.length} events`);
  }
}catch(dbErr){ log(`[WARN] Calendar DB save: ${dbErr.message}`); }
```

} catch (e) {
log(`[WARN] Calendar: ${e.message}`);
}
}

// — Telegram ———————————————–
async function sendTelegram(sigKey, pair, price, dec, conf, score, r, probLabel=‘📊 HIGH PROBABILITY’, t=null) {
try {
const isBuy  = sigKey === ‘BUY’;
const arrow  = isBuy ? ‘📈’ : ‘📉’;
const action = isBuy ? ‘🟢 BUY’ : ‘🔴 SELL’;
const fmt    = v => parseFloat(v) > 0 ? parseFloat(v).toFixed(dec) : ‘-’;
const rr     = r.sl && r.tp2 ? Math.abs((parseFloat(r.tp2) - price) / (price - parseFloat(r.sl))).toFixed(1) : ‘-’;
const sess   = getSession();
const now    = utcTime();

```
// -- Lot Calculator --
// Pip value USD account (standard lot = 100k)
// EUR/USD GBP/USD = 0/pip | XAU/USD = 0/0.10move | USD/JPY ~ 0/pip
const pipValueMap = { 'EUR/USD': 10, 'GBP/USD': 10, 'XAU/USD': 10, 'USD/JPY': 10 };
const pipValue = pipValueMap[pair] || 10;
// SL distance in pips
const slPips = r.sl && price ? (
  pair === 'XAU/USD'
    ? Math.abs(price - parseFloat(r.sl)) / 0.10          // XAU: 0.10 = 1 pip
    : dec === 3
    ? Math.abs(price - parseFloat(r.sl)) / 0.01          // JPY
    : Math.abs(price - parseFloat(r.sl)) / 0.0001        // EUR GBP
) : 0;
const calcLots = (riskUSD) => {
  if(!slPips || slPips <= 0) return '-';
  const lots = riskUSD / (slPips * pipValue);
  return lots.toFixed(2);
};
const slPipsDisplay = slPips > 0 ? slPips.toFixed(1) : '-';
const lotCalc = slPips > 0 ? `
```

💰 <b>RISK CALCULATOR</b> <i>(SL = ${slPipsDisplay} pips)</i>
Risk $50   -> <code>${calcLots(50)} lots</code>
Risk $100  -> <code>${calcLots(100)} lots</code>
Risk $200  -> <code>${calcLots(200)} lots</code>
Risk $500  -> <code>${calcLots(500)} lots</code>
—————–` : ‘’;

```
const text =
```

## `${arrow} <b>FX SIGNAL PRO</b> ${arrow}

## <b>${action} - ${pair}</b>
⏰ ${now} | ${sess}
${probLabel}

## 📌 <b>Entry:</b>  <code>${parseFloat(price).toFixed(dec)}</code>
🛑 <b>SL:</b>     <code>${fmt(r.sl)}</code>
🎯 <b>TP1:</b>    <code>${fmt(r.tp1)}</code>  <i>(40% - 30-45min)</i>
🎯 <b>TP2:</b>    <code>${fmt(r.tp2)}</code>  <i>(35% - 1-2h)</i>
🎯 <b>TP3:</b>    <code>${fmt(r.tp3)}</code>  <i>(25% - 2-4h)</i>

## 📊 <b>Score:</b> ${score}/100 | <b>RR:</b> ${rr} | <b>Conf:</b> ${conf}%
${lotCalc}
🔬 <b>Filters:</b>
📊 ATR: ${t ? t.atrLabel : ‘-’}
🕯️ Momentum: ${t ? t.candlesLabel : ‘-’}
🧱 OB: ${t ? (t.nearBullOB ? ‘✅ Bull OB zone’ : t.nearBearOB ? ‘✅ Bear OB zone’ : ‘-’) : ‘-’}

## 🧠 <b>Analysis:</b>
<i>${(r.raisonnement || r.analyse || ‘-’).substring(0, 400)}</i>

⚠️ <i>Not financial advice - manage your risk</i>
#${pair.replace(’/’, ‘_’)} #${isBuy ? ‘BUY’ : ‘SELL’} #FXSignalPro`;

```
const res  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
});
const data = await res.json();
if (data.ok) log(`[OK] Telegram sent: ${pair} ${sigKey}`);
else log(`[WARN] Telegram error: ${data.description}`);
return data?.result?.message_id || null;
```

} catch (e) {
log(`[WARN] Telegram: ${e.message}`);
return null;
}
}

// — AI Scan ————————————————
async function runScan() {
if (!isActiveSession()) {
log(’[SLEEP] Outside active hours - skipping scan’);
return;
}
if (calBlocked) {
log(’[BLOCK] HIGH IMPACT news - scan blocked’);
return;
}

const analyses = PAIRS
.map(p => ({ …p, tech: computeTechnicals(p.key) }))
.filter(p => p.tech)
.sort((a, b) => b.tech.totalScore - a.tech.totalScore);

if (!analyses.length) { log(’[WARN] No technicals yet’); return; }

// Max 2 active trades total
const allActiveTrades = await dbSelect(‘trades’, ‘status=eq.active&limit=10’);
const activeCount = allActiveTrades?.length || 0;
if (activeCount >= 2) {
log(`-> Max 2 trades actifs atteint (${activeCount}/2) - scan bloqué`);
return;
}

// Filter candidates: direction claire seulement (score >= 40 minimum)
const candidates = analyses.filter(p => {
const dir = p.tech.finalDir;
const hasDir = dir.includes(‘haussier’) || dir.includes(‘baissier’);
return hasDir && p.tech.totalScore >= 40;
});

if (!candidates.length) { log(’-> WAIT: no valid candidates (no direction or score < 40)’); return; }

// Pick best candidate not already in active trade
let best = null;
for (const cand of candidates) {
const alreadyActive = allActiveTrades?.some(tr => tr.pair === cand.label);
if (!alreadyActive) { best = cand; break; }
}
if (!best) { log(’-> All valid pairs already have active trades’); return; }

const t = best.tech;
log(`[SCAN] Scanning ${best.label} - score ${t.totalScore}/100 - ${t.finalDir} (active: ${activeCount}/2)`);

// score < 40 = too weak even for AI
if (t.totalScore < 40) { log(`-> WAIT: score ${t.totalScore} too low`); return; }

// AI THROTTLE - call AI only when score changes OR every 5min
const pairKey2 = best.key;
const now_ai = Date.now();
const lastCall = lastAICall[pairKey2] || 0;
const lastScore = lastAIScore[pairKey2];
const scoreChanged = lastScore !== t.totalScore;
const timeSinceCall = now_ai - lastCall;
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 min fallback

// Call AI if: score changed (INSTANT) OR 5min passed
if (!scoreChanged && timeSinceCall < MIN_INTERVAL_MS) {
log(`-> AI throttled (score=${t.totalScore} unchanged, ${Math.round(timeSinceCall/1000)}s ago)`);
return;
}
lastAICall[pairKey2]  = now_ai;
lastAIScore[pairKey2] = t.totalScore;

const session = getSession();

// Fetch win rate + last trades for AI context
let winRateContext = ‘No data yet’;
let lastTradesContext = ‘No recent trades’;
try {
const wrRows = await dbSelect(‘win_rate’, ‘limit=1&order=updated_at.desc’);
if(wrRows && wrRows.length){
const wr = wrRows[0];
winRateContext = `Total: ${wr.total_trades} trades | Wins: ${wr.wins} | Losses: ${wr.losses} | Win Rate: ${wr.total_trades>0?Math.round(wr.wins/wr.total_trades*100):0}%`;
}
const lastTrades = await dbSelect(‘trades’, ‘order=created_at.desc&limit=5’);
if(lastTrades && lastTrades.length){
lastTradesContext = lastTrades.map(tr => {
const pnl = tr.pnl_pct != null ? (tr.pnl_pct > 0 ? `+${tr.pnl_pct.toFixed(2)}%` : `${tr.pnl_pct.toFixed(2)}%`) : ‘open’;
return `${tr.pair} ${tr.signal} ${tr.status==='active'?'[ACTIVE]':tr.status==='win'?'WIN':'LOSS'} ${pnl}`;
}).join(’ | ’);
}
} catch(e) {}

// Last 10 candles OHLC for best pair (1H closed)
const h1candles = candles[best.key]?.h1 || [];
const last10 = h1candles.slice(-10);
const ohlcContext = last10.length
? last10.map(c2 => `O:${c2.o.toFixed(best.dec)} H:${c2.h.toFixed(best.dec)} L:${c2.l.toFixed(best.dec)} C:${c2.c.toFixed(best.dec)} V:${c2.v||0}`).join(’ | ’)
: ‘N/A’;

// Daily candles context (last 5 days)
const dailyCandles = candles[best.key]?.daily || [];
const last5daily = dailyCandles.slice(-5);
const dailyContext = last5daily.length
? last5daily.map(c2 => `O:${c2.o.toFixed(best.dec)} H:${c2.h.toFixed(best.dec)} L:${c2.l.toFixed(best.dec)} C:${c2.c.toFixed(best.dec)}`).join(’ | ’)
: ‘N/A’;

// Weekend gap detection
const nowDay = new Date().getUTCDay();
const isMonday = nowDay === 1;
let gapContext = ‘N/A’;
if (isMonday && last5daily.length >= 1 && last10.length >= 1) {
const fridayClose = last5daily[last5daily.length - 1].c;
const mondayOpen  = last10[last10.length - 1].o;
const gapPct = ((mondayOpen - fridayClose) / fridayClose * 100).toFixed(3);
const gapPips = Math.abs(mondayOpen - fridayClose).toFixed(best.dec);
gapContext = `Friday close: ${fridayClose.toFixed(best.dec)} | Monday open: ${mondayOpen.toFixed(best.dec)} | Gap: ${parseFloat(gapPct) >= 0 ? '+' : ''}${gapPct}% (${gapPips} pts)`;
}

// Day of week context
const days = [‘Sunday’,‘Monday’,‘Tuesday’,‘Wednesday’,‘Thursday’,‘Friday’,‘Saturday’];
const dayContext = days[nowDay];

const newsContext = calEvents.length
? calEvents.slice(0, 5).map(e => `${e.impact === 'High' ? '🔴' : e.impact === 'Medium' ? '🟡' : '🟢'} ${e.currency} ${e.title} @ ${new Date(e.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}`).join(’\n’)
: ‘No major news today’;

const prompt = `You are a senior forex trader with 15 years experience. You are the SOLE decision maker - think and decide like a real trader, not a mechanical system.

TRADING STYLE: Daily bias -> 1H confirmation -> 15m entry. Intraday: 30min-4h max. Tight SL on structure. Min RR 1.5.

SL/TP RULES (STRICT):

- SL: nearest 15m swing high/low (real structure, not fixed pips)
- TP1: ALWAYS at exactly 2× the SL distance (RR 1:2) - NO EXCEPTION
- TP2: 3× SL distance (RR 1:3)
- TP3: based on next major S/R level (RR 1:4 minimum)

SESSION: ${session} | DAY: ${dayContext}
PAIR: ${best.label} @ ${t.price.toFixed(best.dec)}
OTHER PAIRS: ${analyses.slice(1).map(p => `${p.label}(${p.tech.totalScore}/100 ${p.tech.trend4h})`).join(’ | ’)}

DXY (US Dollar Index): ${dxyData.price ? `${dxyData.price.toFixed(3)} | Trend: ${dxyData.trend} | Change: ${dxyData.change}%` : ‘N/A’}
-> DXY haussier = USD strong (bearish EUR/GBP, bullish USD/JPY) | DXY baissier = USD weak (bullish EUR/GBP)

BOT PERFORMANCE (last trades):
Win Rate: ${winRateContext}
Last 5 trades: ${lastTradesContext}

LAST 5 DAILY CANDLES (oldest -> newest):
${dailyContext}
${isMonday ? `⚠️ MONDAY OPEN - Weekend gap: ${gapContext}` : ‘’}

LAST 10 CANDLES 1H (oldest -> newest):
${ohlcContext}

NEWS TODAY:
${newsContext}

DAILY BIAS (most important - long term direction):
Trend: ${t.trendDaily} | Structure: ${t.structDaily}
EMA20: ${t.ema20_daily||‘N/A’} | EMA50: ${t.ema50_daily||‘N/A’} | Price: ${t.price.toFixed(best.dec)}
-> ${t.trendDaily===‘haussier’?‘📈 Daily bullish - prefer BUY setups’:t.trendDaily===‘baissier’?‘📉 Daily bearish - prefer SELL setups’:‘⚠️ Daily neutral - trade with caution’}

4H BIAS (intermediate):
Trend: ${t.trend4h} | Structure: ${t.struct4h}
EMA50: ${t.ema50_4h || ‘N/A’}
Support: ${t.support4h} | Resistance: ${t.resistance4h}
-> ${t.trend4h===t.trendDaily?‘✅ 4H aligned with Daily’:‘⚠️ 4H conflicts with Daily - be careful’}

1H CONFIRMATION:
Structure: ${t.struct1h} | EMA20: ${t.ema20 || ‘N/A’} | EMA50: ${t.ema50 || ‘N/A’} | EMA200: ${t.ema200 || ‘N/A’}
RSI(14): ${t.rsi || ‘N/A’} ${parseFloat(t.rsi) < 35 ? ‘- OVERSOLD’ : parseFloat(t.rsi) > 65 ? ‘- OVERBOUGHT’ : ‘’}
Near support: ${t.nearSupport} | Near resistance: ${t.nearResistance}
Swing High: ${t.recentHigh} | Swing Low: ${t.recentLow}

15m ENTRY:
Structure: ${t.struct15m} | EMA9: ${t.ema9_15m || ‘N/A’} | EMA21: ${t.ema21_15m || ‘N/A’}
RSI 15m: ${t.rsi15m || ‘N/A’} | BOS bull: ${t.bos15m_bull} | BOS bear: ${t.bos15m_bear}
EMA cross bull: ${t.emaCross15m_bull} | bear: ${t.emaCross15m_bear}
Entry zone: ${t.sr15mLow} -> ${t.sr15mHigh}

LIQUIDITY ZONES:
PDH: ${t.prevDayHigh||‘N/A’} | PDL: ${t.prevDayLow||‘N/A’}
Near PDH: ${t.nearPDH} | Near PDL: ${t.nearPDL}
Equal Highs 4H: ${t.eqHigh} | Equal Lows 4H: ${t.eqLow}
Liquidity Sweep Bull (swept lows->long): ${t.liqSweepBull}
Liquidity Sweep Bear (swept highs->short): ${t.liqSweepBear}
Liq zone BUY confirmed: ${t.liqBull} | SELL confirmed: ${t.liqBear}

STRUCTURED SL/TP (calculated on real S/R structure):
${t.structuredLevels ? `SL: ${t.structuredLevels.sl} | TP1 (RR ${t.structuredLevels.tp1RR}): ${t.structuredLevels.tp1} | TP2: ${t.structuredLevels.tp2} | TP3: ${t.structuredLevels.tp3} Next S/R levels: ${t.structuredLevels.nextLevels?.join(' -> ')||'N/A'} -> Use these as base levels - adjust if context requires` : ‘Insufficient data - calculate from visible structure’}

ICT/SMC: BOS bull: ${t.bos_bull} | BOS bear: ${t.bos_bear} | FVG bull: ${t.fvg_bull} | FVG bear: ${t.fvg_bear}

SCORES: S&R: ${t.srScore}/25 (${t.srDir}) | EMA: ${t.emaScore}/25 (${t.emaDir}) | RSI: ${t.rsiScore}/25 (${t.rsiDir}) | ICT: ${t.ictScore}/25 (${t.ictDir})
Total: ${t.totalScore}/100

— ADVANCED FILTERS —
ATR Volatility: ${t.atrLabel} | ATR 1H: ${t.atr1h||‘N/A’} (${t.atrPct||‘N/A’}% of price)
-> ${t.atrOk ? ‘✅ Volatility normal - entry valid’ : ‘⛔ Volatility filter FAILED - consider WAIT’}

Order Blocks 1H:
Bull OB zone: ${t.bullOB ? t.bullOB.bottom+’ -> ‘+t.bullOB.top : ‘none detected’}  | Price in Bull OB: ${t.nearBullOB}
Bear OB zone: ${t.bearOB ? t.bearOB.bottom+’ -> ’+t.bearOB.top : ‘none detected’}  | Price in Bear OB: ${t.nearBearOB}
-> ${t.nearBullOB ? ‘✅ Price in Bull Order Block - strong buy zone’ : t.nearBearOB ? ‘✅ Price in Bear Order Block - strong sell zone’ : ‘Price not in OB zone’}

Candle Momentum 15m: ${t.candlesLabel} (${t.candlesCount}/3 strong)
-> ${t.candlesLevel === ‘strong’ ? ‘✅ Strong momentum - confirms entry’ : t.candlesLevel === ‘neutral’ ? ‘⚠️ Neutral momentum - valid but be cautious’ : ‘❌ Weak momentum - consider WAIT’}

Volume 1H (tick): ${t.volContext} | Last: ${t.lastVol||‘N/A’} | Avg: ${t.avgVol||‘N/A’} | Ratio: ${t.volRatio||‘N/A’}x
-> ${t.volContext===‘HIGH’ ? ‘✅ High volume - strong move confirmation’ : t.volContext===‘LOW’ ? ‘⚠️ Low volume - weak move, caution’ : t.volContext===‘NORMAL’ ? ‘✅ Normal volume’ : ‘Volume data unavailable’}

YOUR JUDGMENT AS A TRADER - YOU ARE THE SOLE DECISION MAKER:

- You can BUY/SELL even with only 2 strategies aligned IF the setup is clear
- You can BUY/SELL even with score < 65 IF you see a genuine opportunity
- You can WAIT even with score 90 IF the context doesn’t feel right
- Key: clear setup + logical SL + RR >= 1.5
- WAIT only if: no visible setup, full range market, or HIGH IMPACT news imminent

CRITICAL COHERENCE RULE - NEVER BREAK THIS:

- If your analysis mentions “no clear trigger”, “waiting for confirmation”, “no trigger yet”, or any doubt about entry -> signal MUST be “WAIT”
- NEVER say “no trigger” in your analysis AND put BUY/SELL at the same time - this is a fatal contradiction
- A signal is only valid if you can clearly identify: (1) the trigger on 15m (2) the exact SL level (3) RR >= 1.5
- If you cannot clearly identify all 3 -> WAIT, no exceptions

CONFIDENCE - YOUR OWN HONEST ASSESSMENT (0-95):

- This is NOT the score. Score is mechanical. Confidence is YOUR trader judgment.
- Base it on: trend clarity (4H strong or weak?) + how many filters align + trigger quality (clean BOS or messy?) + market context (news? session? ATR normal?)
- 85-95: Everything aligned perfectly - clear trend, clean trigger, OB zone, strong candles, good ATR
- 70-84: Good setup but 1-2 things not perfect - still valid
- 55-69: Moderate setup - borderline, proceed with caution
- 40-54: Weak setup - consider WAIT instead
- <40: WAIT - not enough conviction

SL: use nearest 15m swing high/low (not fixed formula).
TPs: based on real S&R levels.

Reply ONLY in raw JSON no markdown:
{
“signal”: “BUY or SELL or WAIT”,
“confidence”: 0-95, // YOUR OWN assessment: based on trend clarity + filter alignment + trigger strength + context. NOT derived from score. Ask yourself: how convinced am I this trade will work?
“raisonnement”: “Your trader reasoning in 2 sentences: 4H bias + 1H setup + 15m trigger”,
“entry”: ${t.price.toFixed(best.dec)},
“sl”: 0,
“tp1”: 0,
“tp2”: 0,
“tp3”: 0,
“trailing_sl”: 0,
“sr_detail”: “S&R analysis one sentence”,
“ema_detail”: “EMA alignment one sentence”,
“rsi_detail”: “RSI reading one sentence”,
“ict_detail”: “ICT/SMC structure one sentence”,
“analyse”: “Full analysis: (1) 4H context (2) 1H setup (3) 15m trigger (4) trade plan”
}`;

try {
const res  = await fetch(‘https://api.groq.com/openai/v1/chat/completions’, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’, ‘Authorization’: `Bearer ${GROQ_KEY}` },
body: JSON.stringify({
model: ‘llama-3.3-70b-versatile’,
messages: [{ role: ‘user’, content: prompt }],
max_tokens: 1500,
temperature: 0.3,
response_format: { type: ‘json_object’ },
}),
});
const data = await res.json();
// Log Groq errors (rate limit, quota, etc.)
if (data.error) { log(`[WARN] Groq API error: ${data.error.message}`); return; }
if (!data.choices?.length) { log(`[WARN] Groq no choices: ${JSON.stringify(data).substring(0,150)}`); return; }
const raw  = data.choices?.[0]?.message?.content || ‘’;
const clean = raw.replace(/`json|`/g, ‘’).trim();
if (!clean) { log(`[WARN] Groq empty response`); return; }

```
let r;
try {
  r = JSON.parse(clean);
} catch(parseErr) {
  // Try extract JSON from text
  const match = clean.match(/\{[\s\S]*\}/);
  if(match) {
    try { r = JSON.parse(match[0]); }
    catch { log(`[WARN] AI returned non-JSON - skipping scan`); return; }
  } else {
    log(`[WARN] AI non-JSON (${clean.length} chars): ${clean.substring(0,200)}`);
    return;
  }
}

log(`[AI] AI: ${r.signal} | conf: ${r.confidence}% | ${r.raisonnement?.substring(0, 80)}...`);

const isBuy  = r.signal === 'BUY';
const isSell = r.signal === 'SELL';

// Recalculate structuredLevels based on AI final direction (not score direction)
// This fixes the bug where score=haussier but AI=SELL -> wrong TPs
const aiStructured = (candles[best.key]?.h1?.length >= 20 && candles[best.key]?.m15?.length >= 6)
  ? calcStructuredSLTP(candles[best.key].h1, candles[best.key].m15, candles[best.key].h4||[], t.price, isBuy, best.dec)
  : null;

if(aiStructured){
  // Always use AI-direction structured levels for SL/TP
  r.sl  = aiStructured.sl;
  r.tp1 = aiStructured.tp1;
  r.tp2 = aiStructured.tp2;
  r.tp3 = aiStructured.tp3;
}

// AI est le seul décideur - pas de hard gate
// Si AI dit BUY/SELL -> on envoie. Si AI dit WAIT -> on skip.
if (!isBuy && !isSell) { log(`-> AI dit WAIT - skip`); return; }

// [BLOCK] ATR HARD BLOCK - avant tout, indépendamment de l'AI
if (!t.atrOk) {
  log(`[BLOCK] ATR hard block [${best.label}]: ${t.atrLabel} - signal annulé`);
  return;
}

// [BLOCK] 2nd trade needs AI confidence >= 70
const activeCountNow = allActiveTrades?.length || 0;
if (activeCountNow >= 1) {
  const conf2 = parseInt(r.confidence) || 0;
  if (conf2 < 70) {
    log(`-> 2nd trade bloqué: AI confidence ${conf2}% < 70% requis`);
    return;
  }
  log(`-> 2nd trade autorisé: AI confidence ${conf2}% >= 70% ✅`);
}

// [BLOCK] Block new signal si nafs paire 3andha trade actif
const activeTrades = await dbSelect('trades', `status=eq.active&pair=eq.${best.label}&limit=1`);
if (activeTrades && activeTrades.length > 0) {
  log(`-> Trade actif kayn f ${best.label} - signal bloqué 7ta ytsakar`);
  return;
}

// Probability label basé sur score (info seulement)
const probLabel = t.totalScore >= 80 ? '🔥 SUPER HIGH PROBABILITY'
                : t.totalScore >= 65 ? '📊 HIGH PROBABILITY'
                : '⚠️ MODERATE PROBABILITY';

const sigKey = isBuy ? 'BUY' : 'SELL';

// Only send if signal changed OR 2h passed since last signal
const now2 = Date.now();
const last = lastSig[best.key];
const twoHours = 2 * 60 * 60 * 1000;
if (last && last.sig === sigKey && (now2 - last.time) < twoHours) {
  log(`-> Same signal (${sigKey}) sent ${Math.round((now2-last.time)/60000)}min ago - skip`);
  return;
}
lastSig[best.key] = { sig: sigKey, time: now2 };
const tgMsgId = await sendTelegram(sigKey, best.label, t.price, best.dec, r.confidence, t.totalScore, r, probLabel, t);
await saveSignalToDB(sigKey, best.label, t.price, best.dec, r.confidence, t.totalScore, r, session, tgMsgId);
```

} catch (e) {
log(`[WARN] AI scan error: ${e.message}`);
}
}

// — Daily Briefing —————————————–
async function sendDailyBriefing() {
try {
// Fetch calendar fresh
await fetchCalendar();

```
const today = new Date().toLocaleDateString('fr-FR', {
  weekday: 'long', day: 'numeric', month: 'long',
  timeZone: 'UTC'
});

const highEvents   = calEvents.filter(e => e.impact === 'High');
const mediumEvents = calEvents.filter(e => e.impact === 'Medium');

// Format events
const formatEvents = (events) => events.length
  ? events.map(e => {
      const time = new Date(e.date).toLocaleTimeString('fr-FR',
        { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      return `  • ${e.currency} - ${e.title} @ ${time}`;
    }).join('\n')
  : '  Aucun';

const impactSummary = highEvents.length === 0
  ? '✅ Journée calme - trading normal'
  : highEvents.length <= 2
  ? '⚠️ Quelques news HIGH - prudence aux horaires indiqués'
  : '🚨 Journée chargée - réduire exposure ou éviter trading';

const msg = `📰 <b>BRIEFING JOURNALIER - FX SIGNAL PRO</b>
```

-----

⏰ ${utcTime()}
📅 ${today.charAt(0).toUpperCase() + today.slice(1)}

🔴 <b>NEWS HIGH IMPACT (${highEvents.length}):</b>
${formatEvents(highEvents)}

🟡 <b>NEWS MEDIUM IMPACT (${mediumEvents.length}):</b>
${formatEvents(mediumEvents)}

-----

📊 <b>Impact sur le trading:</b>

🔴 HIGH IMPACT:
-> Signal bloqué 15min avant + 30min après
-> Spreads élargis - éviter entrées manuelles
-> Volatilité forte possible

🟡 MEDIUM IMPACT:
-> Prudence - surveiller prix avant entrée
-> Pas de blocage automatique

-----

${impactSummary}

⏰ <b>Sessions actives aujourd’hui:</b>
🏦 London: 09h00 -> 18h00 UTC
🗽 New York: 14h00 -> 23h00 UTC
🔥 Overlap: 15h00 -> 19h00 - meilleure liquidité

⚠️ Not financial advice
#DailyBriefing #FXSignalPro`;

```
await sendTelegramMsg(msg);
log(`[OK] Daily briefing sent`);
```

} catch(e) {
log(`[WARN] Daily briefing: ${e.message}`);
}
}

// Schedule daily briefing at 8h00 UTC
function scheduleDailyBriefing() {
const now     = new Date();
const next8h  = new Date();
next8h.setUTCHours(8, 0, 0, 0);
if(now.getUTCHours() >= 8) next8h.setUTCDate(next8h.getUTCDate() + 1);
const msUntil = next8h.getTime() - now.getTime();
log(`[CAL] Daily briefing scheduled in ${Math.round(msUntil/60000)} minutes`);
setTimeout(async () => {
await sendDailyBriefing();
// Repeat every 24h
setInterval(sendDailyBriefing, 24 * 60 * 60 * 1000);
}, msUntil);
}

## // — Main Loop –––––––––––––––––––––––
async function init() {
log(’[START] FX Signal Pro Bot starting…’);
await sendTelegramMsg(
`🤖 <b>FX Signal Pro Bot - ONLINE</b>

## ✅ Bot démarré - scan actif 8h-21h UTC
📊 Paires: EUR/USD • GBP/USD • XAU/USD • USD/JPY
⏰ Sessions: London • NY • Overlap

🔍 En attente de setup…
#FXSignalPro`
).catch(() => {});

// Initial candle load
await fetchAllCandles();
await fetchPrices();
await fetchCalendar();

// Run first scan
await runScan();

// Price fetch loop - kol 60s
setInterval(fetchPrices, PRICE_SECS * 1000);

// Scan loop - kol 60s
setInterval(runScan, SCAN_SECS * 1000);

// Update active trades P&L + TP/SL - kol 60s
setInterval(updateActiveTrades, 60 * 1000);

// AI trade analysis - kol 5min (msg ghir ki CLOSE/MOVE_SL)
setInterval(analyzeActiveTrades, 5 * 60 * 1000);

// Candle refresh - kol 2h
setInterval(fetchAllCandles, CANDLE_MS);

// Calendar refresh - kol 5min
setInterval(fetchCalendar, 5 * 60 * 1000);

// Daily briefing kol nhar 8h UTC
scheduleDailyBriefing();

// End of Day summary 21h UTC
scheduleEndOfDay();

// Weekly report - Friday 21h UTC
scheduleWeeklyReport();

// Session change check kol 60s
setInterval(checkSessionChange, 60 * 1000);

log(’[OK] Bot running - waiting for signals…’);
}

// Keep-alive server for Railway/Render
import { createServer } from ‘http’;
createServer(async (req, res) => {
const url = req.url?.split(’?’)[0];
if (url === ‘/weekly’) {
res.writeHead(200, {‘Content-Type’: ‘text/plain’});
res.end(‘Sending weekly report…’);
await sendWeeklyReport();
} else if (url === ‘/eod’) {
res.writeHead(200, {‘Content-Type’: ‘text/plain’});
res.end(‘Sending EOD summary…’);
await sendEndOfDaySummary();
} else if (url === ‘/briefing’) {
res.writeHead(200, {‘Content-Type’: ‘text/plain’});
res.end(‘Sending daily briefing…’);
await sendDailyBriefing();
} else {
res.writeHead(200);
res.end(‘FX Signal Pro Bot - Running ✅’);
}
}).listen(process.env.PORT || 3000);

init().catch(e => {
log(`[ERR] Fatal error: ${e.message}`);
process.exit(1);
});
