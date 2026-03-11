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
async function saveSignalToDB(sigKey, pair, price, dec, conf, score, r, session, tgMsgId=null){
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

    // 2 — Save trade (with tg_message_id for reply-to)
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
      const dec = PAIRS.find(p=>p.label===trade.pair)?.dec || 5;
      const fmt = v => parseFloat(v).toFixed(dec);
      const sig = trade.signal==='BUY' ? '🟢 BUY' : '🔴 SELL';

      // ── TP1 Hit → Move SL to BE ──
      const tgId = trade.tg_message_id || null;

      if(!trade.tp1_hit && parseFloat(trade.tp1)>0){
        if((isBuy && price >= trade.tp1) || (!isBuy && price <= trade.tp1)){
          updates.tp1_hit = true;
          updates.sl = entry;
          log(`🎯 TP1 hit: ${trade.pair} — SL moved to BE`);
          await sendTelegramMsg(
`🎯 <b>TP1 ATTEINT — SL → BREAKEVEN</b>
━━━━━━━━━━━━━━━━━━━
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code>
🎯 TP1: <code>${fmt(trade.tp1)}</code> ✅
🔄 <b>SL déplacé à BE: <code>${fmt(entry)}</code></b>
━━━━━━━━━━━━━━━━━━━
🎯 TP2: <code>${fmt(trade.tp2)}</code> en cours...
💡 Trade risk-free — laisse runner!
#TradeUpdate #FXSignalPro`, tgId);
        }
      }

      if(trade.tp1_hit && !trade.tp2_hit && parseFloat(trade.tp2)>0){
        if((isBuy && price >= trade.tp2) || (!isBuy && price <= trade.tp2)){
          updates.tp2_hit = true;
          updates.sl = parseFloat(trade.tp1);
          log(`🎯 TP2 hit: ${trade.pair} — SL moved to TP1`);
          await sendTelegramMsg(
`🎯 <b>TP2 ATTEINT — SL → TP1</b>
━━━━━━━━━━━━━━━━━━━
${sig} ${trade.pair}
🎯 TP1: <code>${fmt(trade.tp1)}</code> ✅
🎯 TP2: <code>${fmt(trade.tp2)}</code> ✅
🔄 <b>SL déplacé à TP1: <code>${fmt(trade.tp1)}</code></b>
━━━━━━━━━━━━━━━━━━━
🎯 TP3: <code>${fmt(trade.tp3)}</code> en cours...
💡 Trade en profit garanti — laisse runner!
#TradeUpdate #FXSignalPro`, tgId);
        }
      }

      if(trade.tp1_hit && trade.tp2_hit && !trade.tp3_hit && parseFloat(trade.tp3)>0){
        if((isBuy && price >= trade.tp3) || (!isBuy && price <= trade.tp3)){
          updates.tp3_hit = true;
          updates.status = 'closed';
          updates.closed_at = new Date().toISOString();
          const slDist = Math.abs(entry - parseFloat(trade.sl));
          const rrTotal = slDist > 0 ? ((Math.abs(trade.tp3-entry)/slDist)*0.25 + (Math.abs(trade.tp2-entry)/slDist)*0.35 + (Math.abs(trade.tp1-entry)/slDist)*0.40).toFixed(2) : '—';
          log(`🎯 TP3 hit — trade closed: ${trade.pair}`);
          await updateWinRate(true, trade.user_entered);
          await sendTelegramMsg(
`🏆 <b>TRADE FERMÉ — TP3 ATTEINT</b>
━━━━━━━━━━━━━━━━━━━
${sig} ${trade.pair}
🎯 TP1 ✅ TP2 ✅ TP3 ✅
━━━━━━━━━━━━━━━━━━━
💰 <b>P&amp;L: +${rrTotal}R</b>
📈 Excellent trade — félicitations! 🔥
#TradeClosed #FXSignalPro`, tgId);
        }
      }

      if(!trade.sl_hit && parseFloat(trade.sl)>0){
        if((isBuy && price <= trade.sl) || (!isBuy && price >= trade.sl)){
          updates.sl_hit = true;
          updates.status = 'closed';
          updates.closed_at = new Date().toISOString();
          const wasBE  = Math.abs(parseFloat(trade.sl) - entry) < (entry * 0.0001);
          const wasTP1 = trade.tp1_hit && Math.abs(parseFloat(trade.sl) - parseFloat(trade.tp1)) < (entry * 0.0001);
          log(`🛑 SL hit — trade closed: ${trade.pair}`);
          await updateWinRate(false, trade.user_entered);
          if(wasBE || wasTP1){
            await sendTelegramMsg(
`➡️ <b>TRADE FERMÉ — BREAKEVEN</b>
━━━━━━━━━━━━━━━━━━━
${sig} ${trade.pair}
${trade.tp1_hit?'🎯 TP1 ✅':''}
🔄 SL touché au BE — 0 perte 👍
#BE #FXSignalPro`, tgId);
          } else {
            await sendTelegramMsg(
`🛑 <b>TRADE FERMÉ — SL TOUCHÉ</b>
━━━━━━━━━━━━━━━━━━━
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code>
🛑 SL: <code>${fmt(trade.sl)}</code> ❌
━━━━━━━━━━━━━━━━━━━
💰 P&amp;L: -1R
📊 Analyse la prochaine setup — next trade! 💪
#SLHit #FXSignalPro`, tgId);
          }
        }
      }

      await dbUpdate('trades', {id: trade.id}, updates);
    }
  }catch(e){
    log(`⚠️ updateActiveTrades: ${e.message}`);
  }
}

// AI Trade Analysis — kol 30min ila kayn trade actif
const lastTradeAnalysis = {}; // tradeId → last analysis time

async function analyzeActiveTrades(){
  try{
    const trades = await dbSelect('trades','status=eq.active&order=created_at.desc');
    if(!trades?.length) return;

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

OPEN TRADE:
Pair: ${trade.pair}
Direction: ${trade.signal}
Entry: ${fmt(entry)} | Current Price: ${fmt(price)}
SL: ${fmt(sl)} | TP1: ${fmt(tp1)} | TP2: ${fmt(tp2)} | TP3: ${fmt(tp3)}
TP1 Hit: ${trade.tp1_hit} | TP2 Hit: ${trade.tp2_hit}
P&L: ${pnlR}R | Time in trade: ${elapsed} minutes

CURRENT MARKET:
Trend 4H: ${t.trend4h} | Structure 1H: ${t.struct1h} | Structure 15m: ${t.struct15m}
RSI 1H: ${t.rsi||'N/A'} | RSI 15m: ${t.rsi15m||'N/A'}
EMA alignment: ${t.emaDir} | ICT: ${t.ictDir}
Score: ${t.totalScore}/100

Liquidity: PDH=${t.prevDayHigh||'N/A'} PDL=${t.prevDayLow||'N/A'}
Liq sweep bull: ${t.liqSweepBull} | bear: ${t.liqSweepBear}

NEWS: ${calEvents.filter(e=>e.impact==='High').map(e=>`${e.currency} ${e.title}`).join(', ')||'None'}

YOUR DECISION — reply ONLY in raw JSON:
{
  "action": "HOLD" or "CLOSE" or "MOVE_SL",
  "new_sl": (only if MOVE_SL — new SL price as number),
  "reason": "One sentence explanation of your decision",
  "urgency": "normal" or "urgent"
}

Rules:
- HOLD: market still in your favor, no action needed
- CLOSE: structure broken against trade, momentum reversed, or news risk — exit now
- MOVE_SL: trail SL to protect profits (only if trade is in profit)
- Be concise and decisive — no hesitation`;

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
              log(`⚠️ Trade AI non-JSON [${trade.pair}] — silent retry in 2min`);
              setTimeout(() => { delete lastTradeAnalysis[trade.id]; }, 2*60*1000);
              continue;
            }
          } else {
            log(`⚠️ Trade AI non-JSON [${trade.pair}] — silent retry in 2min`);
            setTimeout(() => { delete lastTradeAnalysis[trade.id]; }, 2*60*1000);
            continue;
          }
        }

        log(`🤖 Trade AI [${trade.pair}]: ${r.action} — ${r.reason}`);

        const sig = trade.signal==='BUY'?'🟢 BUY':'🔴 SELL';

        if(r.action==='CLOSE'){
          await dbUpdate('trades',{id:trade.id},{
            status:'closed', closed_at:new Date().toISOString()
          });
          await sendTelegramMsg(
`🤖 <b>AI TRADE ALERT — ${r.urgency==='urgent'?'⚠️ URGENT':''}</b>
━━━━━━━━━━━━━━━━━━━
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code> → Now: <code>${fmt(price)}</code>
💰 P&L: ${parseFloat(pnlR)>=0?'+':''}${pnlR}R

🚨 <b>AI RECOMMENDS: CLOSE NOW</b>
📝 "${r.reason}"
━━━━━━━━━━━━━━━━━━━
⚡ Exit at market price immediately
#AIAlert #TradeManagement`, trade.tg_message_id||null);

        } else if(r.action==='MOVE_SL' && r.new_sl){
          const newSL = parseFloat(r.new_sl);
          const validMove = isBuy ? newSL > sl : newSL < sl;
          if(validMove){
            await dbUpdate('trades',{id:trade.id},{ sl: newSL });
            await sendTelegramMsg(
`🤖 <b>AI TRADE UPDATE</b>
━━━━━━━━━━━━━━━━━━━
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code> | Now: <code>${fmt(price)}</code>
💰 P&L: ${parseFloat(pnlR)>=0?'+':''}${pnlR}R

🔄 <b>AI MOVES SL: ${fmt(sl)} → ${fmt(newSL)}</b>
📝 "${r.reason}"
━━━━━━━━━━━━━━━━━━━
✅ Update your SL manually
#AIUpdate #TradeManagement`, trade.tg_message_id||null);
          }
        } else {
          log(`→ HOLD — no alert sent`);
        }

      }catch(aiErr){
        log(`⚠️ Trade AI error [${trade.pair}]: ${aiErr.message}`);
      }
    }
  }catch(e){
    log(`⚠️ analyzeActiveTrades: ${e.message}`);
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

async function sendTelegramMsg(text, replyToMsgId=null){
  try{
    const body = { chat_id:TG_CHAT, text, parse_mode:'HTML', disable_web_page_preview:true };
    if(replyToMsgId) body.reply_to_message_id = replyToMsgId;
    const res  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return data?.result?.message_id || null;
  }catch(e){ log(`⚠️ TG msg: ${e.message}`); return null; }
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

// Session tracking
let lastSession = '';
let dayStats = { signals:0, tp1:0, tp2:0, tp3:0, sl:0, date:'' };

function getSession() {
  const h = new Date().getUTCHours();
  if(h >= 8  && h < 13) return '🇬🇧 London';
  if(h >= 13 && h < 17) return '🔀 London+NY Overlap';
  if(h >= 17 && h < 21) return '🇺🇸 New York';
  return '🌏 Asian';
}

function isActiveSession() {
  const h = new Date().getUTCHours();
  return h >= 8 && h < 21;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Check session change — ka-yb3at message ki tbeddel
async function checkSessionChange() {
  if(!isActiveSession()) return;
  const session = getSession();
  if(session === lastSession) return;

  // Session changed or first time
  const isStart = lastSession === '' || lastSession === '🌏 Asian';
  lastSession = session;

  const sessionInfo = {
    '🇬🇧 London':          { time:'10h00-19h00', pairs:'EUR/USD • GBP/USD', tip:'Breakouts + trend Londres' },
    '🔀 London+NY Overlap': { time:'15h00-19h00', pairs:'Toutes les paires', tip:'🔥 Meilleure liquidité — aktar signals' },
    '🇺🇸 New York':         { time:'17h00-00h00', pairs:'EUR/USD • USD/JPY', tip:'Volatilité USD forte' },
  };
  const info = sessionInfo[session] || { time:'—', pairs:'—', tip:'—' };

  const msg = `⏰ <b>SESSION ${isStart?'OUVERTE':'CHANGÉE'}</b>
━━━━━━━━━━━━━━━━━━━
${session}
🕐 ${info.time} (Maroc)
📊 Paires actives: ${info.pairs}
💡 ${info.tip}
━━━━━━━━━━━━━━━━━━━
🤖 Scan actif — en attente de setup...
#Session #FXSignalPro`;

  await sendTelegramMsg(msg);
  log(`✅ Session message sent: ${session}`);
}

// End of Day summary — 21h UTC
async function sendEndOfDaySummary() {
  try {
    const todayISO = new Date().toISOString().split('T')[0];
    const trades = await dbSelect('trades',
      `created_at=gte.${todayISO}T00:00:00Z&created_at=lte.${todayISO}T23:59:59Z&order=created_at.asc`
    );

    const total   = trades.length;
    const tp1hits = trades.filter(t=>t.tp1_hit).length;
    const tp2hits = trades.filter(t=>t.tp2_hit).length;
    const tp3hits = trades.filter(t=>t.tp3_hit).length;
    const slhits  = trades.filter(t=>t.sl_hit).length;
    const be      = trades.filter(t=>!t.tp1_hit&&!t.sl_hit&&t.status==='closed').length;
    const wins    = trades.filter(t=>t.tp1_hit||t.tp2_hit||t.tp3_hit).length;
    const wr      = total > 0 ? Math.round((wins/total)*100) : 0;

    // P&L total basé sur RR
    // TP1=40% position RR1.5, TP2=35% RR2.5, TP3=25% RR4 — SL=-1R
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
      else if(t.status==='closed')                result = 'BE ➡️';
      else                                        result = '⏳ En cours';
      return `  ${i+1}. ${sig} ${t.pair} → ${result}`;
    }).join('\n');

    const today = new Date().toLocaleDateString('fr-FR', {
      weekday:'long', day:'numeric', month:'long',
      timeZone:'Africa/Casablanca'
    });

    const perf = totalRR > 1 ? '🔥 Excellente journée' :
                 totalRR > 0 ? '✅ Bonne journée' :
                 totalRR === 0 ? '➡️ Journée neutre (BE)' : '❌ Journée difficile';

    const rrStr = totalRR >= 0 ? `+${totalRR.toFixed(2)}R` : `${totalRR.toFixed(2)}R`;

    const msg = `🌙 <b>RÉSUMÉ DE JOURNÉE — FX SIGNAL PRO</b>
━━━━━━━━━━━━━━━━━━━
📅 ${today.charAt(0).toUpperCase()+today.slice(1)}

${total > 0 ? `📋 <b>Trades du jour:</b>
${tradeLines}

━━━━━━━━━━━━━━━━━━━
📊 <b>Statistiques:</b>
  Signals: ${total} | Wins: ${wins} | Losses: ${slhits} | BE: ${be}
  Win Rate: ${total>0?wr+'%':'—'}
  TP1: ${tp1hits} | TP2: ${tp2hits} | TP3: ${tp3hits} | SL: ${slhits}

💰 <b>P&amp;L total: ${rrStr}</b>
  (basé sur RR — TP1×40% + TP2×35% + TP3×25%)

${perf}` : `😴 Aucun signal aujourd'hui — marché en range`}

━━━━━━━━━━━━━━━━━━━
📅 Prochain briefing demain à 10h00 (Maroc)
#EndOfDay #FXSignalPro`;

    await sendTelegramMsg(msg);
    log(`✅ End of day summary sent — ${total} trades | ${rrStr}`);

    // Reset lastSig — signals jdad nhar jdid ✅
    lastSig = {};
    lastSession = '';
  } catch(e) {
    log(`⚠️ EOD summary: ${e.message}`);
  }
}

// Schedule End of Day at 21h00 UTC
function scheduleEndOfDay() {
  const now    = new Date();
  const next21 = new Date();
  next21.setUTCHours(21, 0, 0, 0);
  if(now.getUTCHours() >= 21) next21.setUTCDate(next21.getUTCDate()+1);
  const msUntil = next21.getTime() - now.getTime();
  log(`🌙 EOD summary scheduled in ${Math.round(msUntil/60000)} minutes`);
  setTimeout(async () => {
    await sendEndOfDaySummary();
    setInterval(sendEndOfDaySummary, 24*60*60*1000);
  }, msUntil);
}

// Weekly Report — every Friday at 21h00 UTC (23h Maroc)
async function sendWeeklyReport() {
  try {
    // Get trades from last 7 days
    const fromISO = new Date(Date.now() - 7*24*60*60*1000).toISOString();
    const trades  = await dbSelect('trades',
      `created_at=gte.${fromISO}&order=created_at.asc`
    );

    const total   = trades.length;
    const tp1hits = trades.filter(t=>t.tp1_hit).length;
    const tp2hits = trades.filter(t=>t.tp2_hit).length;
    const tp3hits = trades.filter(t=>t.tp3_hit).length;
    const slhits  = trades.filter(t=>t.sl_hit).length;
    const be      = trades.filter(t=>!t.tp1_hit&&!t.sl_hit&&t.status==='closed').length;
    const wins    = trades.filter(t=>t.tp1_hit||t.tp2_hit||t.tp3_hit).length;
    const wr      = total > 0 ? Math.round((wins/total)*100) : 0;

    // Group by day
    const byDay = {};
    for(const t of trades){
      const day = new Date(t.created_at).toLocaleDateString('fr-FR', {
        weekday:'long', day:'numeric', month:'long', timeZone:'Africa/Casablanca'
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
        if(t.sl_hit)      rr = -1;
        else if(t.tp3_hit) rr = (Math.abs(tp1-entry)/slDist)*0.40 + (Math.abs(tp2-entry)/slDist)*0.35 + (Math.abs(tp3-entry)/slDist)*0.25;
        else if(t.tp2_hit) rr = (Math.abs(tp1-entry)/slDist)*0.40 + (Math.abs(tp2-entry)/slDist)*0.35;
        else if(t.tp1_hit) rr = (Math.abs(tp1-entry)/slDist)*0.40;
        if(slDist) dayRR += rr;

        const sig    = t.signal==='BUY'?'🟢':'🔴';
        let result   = t.sl_hit ? 'SL ❌' : t.tp3_hit ? 'TP1✅TP2✅TP3✅' : t.tp2_hit ? 'TP1✅TP2✅' : t.tp1_hit ? 'TP1✅' : t.status==='closed' ? 'BE➡️' : '⏳';
        return `    ${sig} ${t.pair} → ${result}`;
      }).join('\n');

      totalRR += dayRR;
      const rrStr = dayRR >= 0 ? `+${dayRR.toFixed(2)}R` : `${dayRR.toFixed(2)}R`;
      const dayWins = dayTrades.filter(t=>t.tp1_hit||t.tp2_hit||t.tp3_hit).length;
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

    const msg = `📊 <b>RAPPORT HEBDOMADAIRE — FX SIGNAL PRO</b>
━━━━━━━━━━━━━━━━━━━
🗓️ Semaine du ${new Date(Date.now()-6*24*60*60*1000).toLocaleDateString('fr-FR',{day:'numeric',month:'long'})} au ${new Date().toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'})}

${total > 0 ? `${dayLines}

━━━━━━━━━━━━━━━━━━━
📈 <b>RÉSUMÉ DE LA SEMAINE:</b>
  Total signals: ${total}
  ✅ Wins: ${wins} | ❌ Losses: ${slhits} | ➡️ BE: ${be}
  📊 Win Rate: ${wr}%
  🎯 TP1: ${tp1hits} | TP2: ${tp2hits} | TP3: ${tp3hits} | SL: ${slhits}

💰 <b>P&amp;L total semaine: ${totalRRStr}</b>
  (TP1×40% + TP2×35% + TP3×25%)
${bestPair ? `\n🏆 Meilleure paire: ${bestPair[0]} (${Math.round(bestPair[1].wins/bestPair[1].total*100)}% WR)` : ''}

${perf}` : `😴 Aucun signal cette semaine`}

━━━━━━━━━━━━━━━━━━━
📅 Prochain briefing lundi à 10h00 (Maroc)
#WeeklyReport #FXSignalPro`;

    await sendTelegramMsg(msg);
    log(`✅ Weekly report sent — ${total} trades | ${totalRRStr}`);
  } catch(e) {
    log(`⚠️ Weekly report: ${e.message}`);
  }
}

// Schedule weekly report — every Friday 21h UTC (23h Maroc)
function scheduleWeeklyReport() {
  const now  = new Date();
  const next = new Date();
  // Find next Friday 21h UTC
  const daysUntilFriday = (5 - now.getUTCDay() + 7) % 7 || 7; // 5 = Friday
  next.setUTCDate(now.getUTCDate() + (daysUntilFriday === 0 && now.getUTCHours() >= 21 ? 7 : daysUntilFriday));
  next.setUTCHours(21, 0, 0, 0);
  const msUntil = next.getTime() - now.getTime();
  log(`📊 Weekly report scheduled in ${Math.round(msUntil/3600000)}h`);
  setTimeout(async () => {
    await sendWeeklyReport();
    setInterval(sendWeeklyReport, 7*24*60*60*1000);
  }, msUntil);
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

function findNextSRLevels(candles1h, candles4h, price, isBuy) {
  const pivots = [];
  const collectPivots = (candles, label) => {
    const c = candles.slice(-80);
    for(let i=2; i<c.length-2; i++){
      const isHigh = c[i].h>c[i-1].h && c[i].h>c[i-2].h && c[i].h>c[i+1].h && c[i].h>c[i+2].h;
      const isLow  = c[i].l<c[i-1].l && c[i].l<c[i-2].l && c[i].l<c[i+1].l && c[i].l<c[i+2].l;
      if(isHigh) pivots.push({ level: c[i].h, type:'resistance', src:label });
      if(isLow)  pivots.push({ level: c[i].l, type:'support',    src:label });
    }
  };
  collectPivots(candles1h, '1H');
  collectPivots(candles4h, '4H');
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
  const swH15  = c15.length ? Math.max(...c15.map(x=>x.h)) : price;
  const swL15  = c15.length ? Math.min(...c15.map(x=>x.l)) : price;
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

  // Liquidity Zones
  const last10_4h  = h4.slice(-10);
  const highs4h    = last10_4h.map(x=>x.h);
  const lows4h     = last10_4h.map(x=>x.l);
  const prevDayHigh = highs4h.length >= 2 ? Math.max(...highs4h.slice(-2)) : null;
  const prevDayLow  = lows4h.length  >= 2 ? Math.min(...lows4h.slice(-2))  : null;
  const eqHigh = highs4h.length>=3 ? highs4h.filter(h=>Math.abs(h-Math.max(...highs4h))/Math.max(...highs4h)<0.001).length>=2 : false;
  const eqLow  = lows4h.length >=3 ? lows4h.filter(l=>Math.abs(l-Math.min(...lows4h))/Math.min(...lows4h)<0.001).length>=2  : false;
  const recentHigh4h = highs4h.length ? Math.max(...highs4h.slice(-3)) : price;
  const recentLow4h  = lows4h.length  ? Math.min(...lows4h.slice(-3))  : price;
  const liqSweepBull = price < recentLow4h  * 1.002 && struct4h === 'haussier';
  const liqSweepBear = price > recentHigh4h * 0.998 && struct4h === 'baissier';
  const nearPDH = prevDayHigh ? Math.abs(price-prevDayHigh)/price < 0.003 : false;
  const nearPDL = prevDayLow  ? Math.abs(price-prevDayLow) /price < 0.003 : false;
  const liqBull = (liqSweepBull||nearPDL||eqLow)  && struct4h==='haussier';
  const liqBear = (liqSweepBear||nearPDH||eqHigh) && struct4h==='baissier';

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

  // Structured SL/TP based on real S/R levels
  const isBuyDir  = finalDir === 'haussier';
  const isSellDir = finalDir === 'baissier';
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
    srScore, emaScore, rsiScore, ictScore, totalScore,
    srDir, emaDir: emaDir2, rsiDir, ictDir, finalDir,
    structuredLevels,
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

    // Save prices f Supabase — UPSERT (insert ola update automatique)
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
async function sendTelegram(sigKey, pair, price, dec, conf, score, r, probLabel='📊 HIGH PROBABILITY') {
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
${probLabel}
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
    return data?.result?.message_id || null;
  } catch (e) {
    log(`⚠️ Telegram: ${e.message}`);
    return null;
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
  if (t.totalScore < 50)      { log(`→ WAIT: score ${t.totalScore} < 50`); return; }

  // Moderate track (50-65) — AI validates harder before sending
  const isModerate = t.totalScore >= 50 && t.totalScore < 65;

  const session = getSession();
  const newsContext = calEvents.length
    ? calEvents.slice(0, 5).map(e => `${e.impact === 'High' ? '🔴' : e.impact === 'Medium' ? '🟡' : '🟢'} ${e.currency} ${e.title} @ ${new Date(e.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`).join('\n')
    : 'No major news today';

  const prompt = `You are a senior forex trader with 15 years experience. Analyze like a real trader — think and decide.

SETUP QUALITY: ${isModerate ? '⚠️ MODERATE (score 50-65) — Be EXTRA strict. Only validate if setup is genuinely good despite lower score. Prefer WAIT if any doubt.' : '✅ HIGH CONFIDENCE (score 65+) — Validate if direction is clear.'}

TRADING STYLE: Daily bias → 1H confirmation → 15m entry. Intraday: 30min-4h max. Tight SL on structure. Min RR 1.5.

SL/TP RULES (STRICT):
- SL: nearest 15m swing high/low (real structure, not fixed pips)
- TP1: ALWAYS at exactly 2× the SL distance (RR 1:2) — NO EXCEPTION
- TP2: 3× SL distance (RR 1:3)
- TP3: based on next major S/R level (RR 1:4 minimum)

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

LIQUIDITY ZONES:
PDH: ${t.prevDayHigh||'N/A'} | PDL: ${t.prevDayLow||'N/A'}
Near PDH: ${t.nearPDH} | Near PDL: ${t.nearPDL}
Equal Highs 4H: ${t.eqHigh} | Equal Lows 4H: ${t.eqLow}
Liquidity Sweep Bull (swept lows→long): ${t.liqSweepBull}
Liquidity Sweep Bear (swept highs→short): ${t.liqSweepBear}
Liq zone BUY confirmed: ${t.liqBull} | SELL confirmed: ${t.liqBear}

STRUCTURED SL/TP (calculated on real S/R structure):
${t.structuredLevels ? `SL: ${t.structuredLevels.sl} | TP1 (RR ${t.structuredLevels.tp1RR}): ${t.structuredLevels.tp1} | TP2: ${t.structuredLevels.tp2} | TP3: ${t.structuredLevels.tp3}
Next S/R levels: ${t.structuredLevels.nextLevels?.join(' → ')||'N/A'}
→ Use these as base levels — adjust if context requires` : 'Insufficient data — calculate from visible structure'}

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

    let r;
    try {
      r = JSON.parse(clean);
    } catch(parseErr) {
      // Try extract JSON from text
      const match = clean.match(/\{[\s\S]*\}/);
      if(match) {
        try { r = JSON.parse(match[0]); }
        catch { log(`⚠️ AI returned non-JSON — skipping scan`); return; }
      } else {
        log(`⚠️ AI returned non-JSON — skipping scan: ${clean.substring(0,100)}`);
        return;
      }
    }

    log(`🤖 AI: ${r.signal} | conf: ${r.confidence}% | ${r.raisonnement?.substring(0, 80)}...`);

    const isBuy  = r.signal === 'BUY';
    const isSell = r.signal === 'SELL';

    // Override SL/TP avec niveaux structurés (S/R réels) — after isBuy/isSell declaration
    if(t.structuredLevels && (isBuy||isSell)){
      const sl = t.structuredLevels;
      if(!parseFloat(r.sl) || !parseFloat(r.tp1)){
        r.sl=sl.sl; r.tp1=sl.tp1; r.tp2=sl.tp2; r.tp3=sl.tp3;
      } else {
        const entry = parseFloat(r.entry||t.price);
        const aiRR  = Math.abs(parseFloat(r.tp1)-entry)/Math.abs(parseFloat(r.sl)-entry);
        if(aiRR < 1.5) r.tp1 = sl.tp1;
      }
    }

    // Hard gate
    const bullC = [t.srDir, t.emaDir, t.rsiDir, t.ictDir].filter(d => d === 'haussier').length;
    const bearC = [t.srDir, t.emaDir, t.rsiDir, t.ictDir].filter(d => d === 'baissier').length;

    // Moderate track: AI must say BUY/SELL (not WAIT) — no strict count needed
    // High track: standard hard gate bullC/bearC >= 3 + score >= 65
    const validHigh     = (isBuy && bullC >= 3 && t.totalScore >= 65) || (isSell && bearC >= 3 && t.totalScore >= 65);
    const validModerate = isModerate && (isBuy || isSell); // AI already decided
    const valid = validHigh || validModerate;

    if (!valid) { log(`→ Hard gate blocked: bull=${bullC} bear=${bearC} score=${t.totalScore}`); return; }

    // Probability label
    const probLabel = t.totalScore >= 80 ? '🔥 SUPER HIGH PROBABILITY'
                    : t.totalScore >= 65 ? '📊 HIGH PROBABILITY'
                    : '⚠️ MODERATE PROBABILITY';

    const sigKey = isBuy ? 'BUY' : 'SELL';

    // Only send if signal changed
    if (lastSig[best.key] === sigKey) { log(`→ Same signal as last time — skip`); return; }
    lastSig[best.key] = sigKey;
    const tgMsgId = await sendTelegram(sigKey, best.label, t.price, best.dec, r.confidence, t.totalScore, r, probLabel);
    await saveSignalToDB(sigKey, best.label, t.price, best.dec, r.confidence, t.totalScore, r, session, tgMsgId);

  } catch (e) {
    log(`⚠️ AI scan error: ${e.message}`);
  }
}

// ─── Daily Briefing ─────────────────────────────────────────
async function sendDailyBriefing() {
  try {
    // Fetch calendar fresh
    await fetchCalendar();

    const today = new Date().toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long',
      timeZone: 'Africa/Casablanca'
    });

    const highEvents   = calEvents.filter(e => e.impact === 'High');
    const mediumEvents = calEvents.filter(e => e.impact === 'Medium');

    // Format events
    const formatEvents = (events) => events.length
      ? events.map(e => {
          const time = new Date(e.date).toLocaleTimeString('fr-FR',
            { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Casablanca' });
          return `  • ${e.currency} — ${e.title} @ ${time}`;
        }).join('\n')
      : '  Aucun';

    const impactSummary = highEvents.length === 0
      ? '✅ Journée calme — trading normal'
      : highEvents.length <= 2
      ? '⚠️ Quelques news HIGH — prudence aux horaires indiqués'
      : '🚨 Journée chargée — réduire exposure ou éviter trading';

    const msg = `📰 <b>BRIEFING JOURNALIER — FX SIGNAL PRO</b>
━━━━━━━━━━━━━━━━━━━
📅 ${today.charAt(0).toUpperCase() + today.slice(1)}

🔴 <b>NEWS HIGH IMPACT (${highEvents.length}):</b>
${formatEvents(highEvents)}

🟡 <b>NEWS MEDIUM IMPACT (${mediumEvents.length}):</b>
${formatEvents(mediumEvents)}

━━━━━━━━━━━━━━━━━━━
📊 <b>Impact sur le trading:</b>

🔴 HIGH IMPACT:
  → Signal bloqué 15min avant + 30min après
  → Spreads élargis — éviter entrées manuelles
  → Volatilité forte possible

🟡 MEDIUM IMPACT:
  → Prudence — surveiller prix avant entrée
  → Pas de blocage automatique

━━━━━━━━━━━━━━━━━━━
${impactSummary}

⏰ <b>Sessions actives aujourd'hui:</b>
  🏦 London: 10h00 → 19h00 (Maroc)
  🗽 New York: 15h00 → 24h00 (Maroc)
  🔥 Overlap: 15h00 → 19h00 — meilleure liquidité

⚠️ Not financial advice
#DailyBriefing #FXSignalPro`;

    await sendTelegramMsg(msg);
    log(`✅ Daily briefing sent`);
  } catch(e) {
    log(`⚠️ Daily briefing: ${e.message}`);
  }
}

// Schedule daily briefing at 8h00 UTC (10h Maroc)
function scheduleDailyBriefing() {
  const now     = new Date();
  const next8h  = new Date();
  next8h.setUTCHours(8, 0, 0, 0);
  if(now.getUTCHours() >= 8) next8h.setUTCDate(next8h.getUTCDate() + 1);
  const msUntil = next8h.getTime() - now.getTime();
  log(`📅 Daily briefing scheduled in ${Math.round(msUntil/60000)} minutes`);
  setTimeout(async () => {
    await sendDailyBriefing();
    // Repeat every 24h
    setInterval(sendDailyBriefing, 24 * 60 * 60 * 1000);
  }, msUntil);
}

// ─── Main Loop ──────────────────────────────────────────────
async function init() {
  log('🚀 FX Signal Pro Bot starting...');
  await sendTelegramMsg(
`🤖 <b>FX Signal Pro Bot — ONLINE</b>
━━━━━━━━━━━━━━━━━━━
✅ Bot démarré — scan actif 8h-21h UTC
📊 Paires: EUR/USD • GBP/USD • XAU/USD • USD/JPY
⏰ Sessions: London • NY • Overlap
━━━━━━━━━━━━━━━━━━━
🔍 En attente de setup...
#FXSignalPro`
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

  // AI trade analysis — kol 5min (msg ghir ki CLOSE/MOVE_SL)
  setInterval(analyzeActiveTrades, 5 * 60 * 1000);

  // Candle refresh — kol 2h
  setInterval(fetchAllCandles, CANDLE_MS);

  // Calendar refresh — kol 5min
  setInterval(fetchCalendar, 5 * 60 * 1000);

  // Daily briefing kol nhar 8h UTC (10h Maroc)
  scheduleDailyBriefing();

  // End of Day summary 21h UTC
  scheduleEndOfDay();

  // Weekly report — Friday 21h UTC (23h Maroc)
  scheduleWeeklyReport();

  // Session change check kol 60s
  setInterval(checkSessionChange, 60 * 1000);

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
