// ============================================================
// FX Signal Pro - 24/7 Trading Bot
// Railway / Render - Node.js 18+ (built-in fetch)
// ============================================================

// Node 18+ has built-in fetch - no dependencies needed!

// --- Config -------------------------------------------------
const TD_KEY   = process.env.TD_KEY   || '2dfb3a0242474809967353a965e730f1';
const TD_KEY2  = process.env.TD_KEY2  || 'c6f15065c04c4a5a94722b40a297dd0f';
const TD_KEY3  = process.env.TD_KEY3  || 'a459b1e8d10240f2bff8dcb67e2ed5b6';
const TD_KEY4  = process.env.TD_KEY4  || 'c7ccc7b36d7b4fa3a1b16b7860196049';
const POLY_KEY = process.env.POLY_KEY || 'Vxe1pa2pDsqR2wt5XguyxYOH68DwTiKi';
const GROQ_KEY  = process.env.GROQ_KEY  || '';
const GROQ_KEY2 = process.env.GROQ_KEY2 || ''; // second key for rotation
let groqKeyIndex = 0; // rotate between keys
const TG_TOKEN = process.env.TG_TOKEN || '8427595283:AAFaoATV4Cq-45Fq_eruMLRFaJsOrCt6Ceo';
const TG_CHAT  = process.env.TG_CHAT  || '-1003612566723';
const SB_URL   = process.env.SUPABASE_URL || 'https://ugbowhydxxkpsamjxxai.supabase.co';
const SB_KEY   = process.env.SUPABASE_KEY || 'sb_publishable_I1wxgYYVPxo9PXhmBxpG5A_dYR2nsi9';

// --- Supabase DB ---------------------------------------------
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
    log(`[WARN] DB insert ${table}: ${e.message}`);
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
    log(`[OK] DB update ${table}`);
  }catch(e){
    log(`[WARN] DB update ${table}: ${e.message}`);
  }
}

async function dbSelect(table, params=''){
  try{
    const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
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
    if(!signal?.id){ log('[WARN] Signal not saved'); return null; }
    log(`[OK] DB signal saved: ${signal.id}`);

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
  }catch(e){
    log(`[WARN] saveSignalToDB: ${e.message}`);
    return null;
  }
}

// Update active trades P&L + check TP/SL hits
async function updateActiveTrades(){
  try{
    const trades = await dbSelect('trades', 'status=eq.active');
    if(!trades?.length) return;

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
`🎯 <b>TP1 ATTEINT - SL -> BREAKEVEN</b>
-------------------
⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code>
🎯 TP1: <code>${fmt(trade.tp1)}</code> ✅
🔄 <b>SL déplacé à BE: <code>${fmt(entry)}</code></b>
-------------------
🎯 TP2: <code>${fmt(trade.tp2)}</code> en cours...
💡 Trade risk-free - laisse runner!
#TradeUpdate #FXSignalPro`, tgId);
        }
      }

      if(trade.tp1_hit && !trade.tp2_hit && parseFloat(trade.tp2)>0){
        if((isBuy && price >= trade.tp2) || (!isBuy && price <= trade.tp2)){
          updates.tp2_hit = true;
          updates.sl = parseFloat(trade.tp1);
          log(`[TP] TP2 hit: ${trade.pair} - SL moved to TP1`);
          await sendTelegramMsg(
`🎯 <b>TP2 ATTEINT - SL -> TP1</b>
-------------------
⏰ ${utcTime()}
${sig} ${trade.pair}
🎯 TP1: <code>${fmt(trade.tp1)}</code> ✅
🎯 TP2: <code>${fmt(trade.tp2)}</code> ✅
🔄 <b>SL déplacé à TP1: <code>${fmt(trade.tp1)}</code></b>
-------------------
🎯 TP3: <code>${fmt(trade.tp3)}</code> en cours...
💡 Trade en profit garanti - laisse runner!
#TradeUpdate #FXSignalPro`, tgId);
        }
      }

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
`🏆 <b>TRADE FERMÉ - TP3 ATTEINT</b>
-------------------
⏰ ${utcTime()}
${sig} ${trade.pair}
🎯 TP1 ✅ TP2 ✅ TP3 ✅
-------------------
💰 <b>P&amp;L: +${rrTotal}R</b>
📈 Excellent trade - félicitations! 🔥
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
          log(`[SL] SL hit - trade closed: ${trade.pair}`);
          await updateWinRate(false, trade.user_entered);
          if(wasBE || wasTP1){
            await sendTelegramMsg(
`➡️ <b>TRADE FERMÉ - BREAKEVEN</b>
-------------------
⏰ ${utcTime()}
${sig} ${trade.pair}
${trade.tp1_hit?'🎯 TP1 ✅':''}
🔄 SL touché au BE - 0 perte 👍
#BE #FXSignalPro`, tgId);
          } else {
            await sendTelegramMsg(
`🛑 <b>TRADE FERMÉ - SL TOUCHÉ</b>
-------------------
⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code>
🛑 SL: <code>${fmt(trade.sl)}</code> ❌
-------------------
💰 P&amp;L: -1R
📊 Analyse la prochaine setup - next trade! 💪
#SLHit #FXSignalPro`, tgId);
          }
        }
      }

      await dbUpdate('trades', {id: trade.id}, updates);
    }
  }catch(e){
    log(`[WARN] updateActiveTrades: ${e.message}`);
  }
}

// AI Trade Analysis - kol 30min ila kayn trade actif
const lastTradeAnalysis = {}; // tradeId -> last analysis time

async function analyzeActiveTrades(){
  try{
    const trades = await dbSelect('trades','status=eq.active&order=created_at.desc');
    if(!trades?.length) return;

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

      // 4H swing levels for trailing
      const h4candles = candles[pair.key]?.h4 || candles[pair.key]?.daily || [];
      const last10_4h = h4candles.slice(-10);
      const swingHighs4h = last10_4h.map(x => x.h).sort((a,b) => b-a).slice(0,3);
      const swingLows4h  = last10_4h.map(x => x.l).sort((a,b) => a-b).slice(0,3);
      // Last lower high (for SELL trailing) = highest swing high below current SL
      const lastSwingHigh4h = swingHighs4h.find(h => h < sl) || swingHighs4h[0];
      // Last higher low (for BUY trailing) = lowest swing low above current SL  
      const lastSwingLow4h  = swingLows4h.find(l => l > sl)  || swingLows4h[0];

      const prompt = `You are a professional forex trade manager. A trade is currently open. Your job: trail the SL with the 4H market structure to lock in profits.

OPEN TRADE:
Pair: ${trade.pair}
Direction: ${trade.signal}
Entry: ${fmt(entry)} | Current Price: ${fmt(price)}
Current SL: ${fmt(sl)} | TP1: ${fmt(tp1)} | TP2: ${fmt(tp2)} | TP3: ${fmt(tp3)}
TP1 Hit: ${trade.tp1_hit} | TP2 Hit: ${trade.tp2_hit}
P&L: ${pnlR}R | Time in trade: ${elapsed} minutes

4H MARKET STRUCTURE (for trailing):
Trend 4H: ${t.trend4h} | Structure 4H: ${t.struct4h}
Last 3 swing highs (4H): ${swingHighs4h.map(h=>h.toFixed(dec)).join(' | ')}
Last 3 swing lows  (4H): ${swingLows4h.map(l=>l.toFixed(dec)).join(' | ')}
${isBuy ? 
  `→ BUY trail: move SL to last 4H higher low = ${lastSwingLow4h?.toFixed(dec)} (only if > current SL ${fmt(sl)})` :
  `→ SELL trail: move SL to last 4H lower high = ${lastSwingHigh4h?.toFixed(dec)} (only if < current SL ${fmt(sl)})`
}

SR CHANNELS (TradingView method — pivot clusters):
Resistances: ${t.srResistances.length ? t.srResistances.map(z => `${z.lo}-${z.hi}(s:${z.strength})`).join(' | ') : 'none'}
Supports:    ${t.srSupports.length ? t.srSupports.map(z => `${z.lo}-${z.hi}(s:${z.strength})`).join(' | ') : 'none'}
${t.nearSRZone ? `⚠️ Price INSIDE SR zone ${t.srInside?.[0]?.lo}-${t.srInside?.[0]?.hi} — caution, wait for breakout or rejection` : ''}
${t.closestRes ? `Next resistance: ${t.closestRes.lo}-${t.closestRes.hi}` : ''}
${t.closestSup ? `Next support: ${t.closestSup.lo}-${t.closestSup.hi}` : ''}

1H CONFIRMATION:
Structure 1H: ${t.struct1h} | RSI: ${t.rsi||'N/A'}
EMA: ${t.emaDir} | Score: ${t.totalScore}/100

Price Action:
${isBuy ? `Bull PA: ${t.pa_bull?'✅ Full':'⚠️ Partial'} | ${t.paBullLabel}` : `Bear PA: ${t.pa_bear?'✅ Full':'⚠️ Partial'} | ${t.paBearLabel}`}
Doji: ${t.doji15m||t.doji30m ? '⚠️ Indecision detected' : 'none'}

NEWS: ${calEvents.filter(e=>e.impact==='High').map(e=>`${e.currency} ${e.title}`).join(', ')||'None'}

TRAILING RULES (STRICT):
- MOVE_SL: Trail SL to 4H swing structure to follow the move
  * SELL: new_sl = last 4H lower high (below current SL) — locks profit if market continues down
  * BUY:  new_sl = last 4H higher low (above current SL) — locks profit if market continues up
  * Only move if trade is in profit (P&L > 0) AND new SL is better than current
  * Move SL to last swing + 2-3 pips buffer
- CLOSE: 4H structure broken against trade (new high > entry for SELL, new low < entry for BUY)
  * Also CLOSE if: strong reversal candle, momentum fully reversed, HIGH impact news
- HOLD: trend intact, no new swing to trail to yet

YOUR DECISION - reply ONLY in raw JSON:
{
  "action": "HOLD" or "CLOSE" or "MOVE_SL",
  "new_sl": (only if MOVE_SL - exact price as number with ${dec} decimals),
  "reason": "One sentence: what 4H structure justifies this decision",
  "urgency": "normal" or "urgent"
}`;

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
`🤖 <b>AI TRADE ALERT - ${r.urgency==='urgent'?'⚠️ URGENT':''}</b>
-------------------
⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code> -> Now: <code>${fmt(price)}</code>
💰 P&L: ${aiPnlR>=0?'+':''}${pnlR}R ${aiIsWin?'✅':aiIsBE?'➡️':'❌'}

🚨 <b>AI RECOMMENDS: CLOSE NOW</b>
📝 "${r.reason}"
-------------------
⚡ Exit at market price immediately
#AIAlert #TradeManagement`, trade.tg_message_id||null);

        } else if(r.action==='MOVE_SL' && r.new_sl){
          const newSL = parseFloat(r.new_sl);
          const validMove = isBuy ? newSL > sl : newSL < sl;
          if(validMove){
            await dbUpdate('trades',{id:trade.id},{ sl: newSL });
            await sendTelegramMsg(
`🤖 <b>AI TRADE UPDATE</b>
-------------------
⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code> | Now: <code>${fmt(price)}</code>
💰 P&L: ${parseFloat(pnlR)>=0?'+':''}${pnlR}R

🔄 <b>AI MOVES SL: ${fmt(sl)} -> ${fmt(newSL)}</b>
📝 "${r.reason}"
-------------------
✅ Update your SL manually
#AIUpdate #TradeManagement`, trade.tg_message_id||null);
          }
        } else {
          // HOLD - only during market hours (8h-21h UTC, Mon-Fri)
          if (!canSendMsg) { log(`-> HOLD supprimé (weekend/hors heures) [${trade.pair}]`); continue; }
          // delete previous HOLD msg then send new one
          const holdKey = `${trade.id}`;
          if (lastHoldMsgId[holdKey]) {
            await deleteTelegramMsg(lastHoldMsgId[holdKey]);
            lastHoldMsgId[holdKey] = null;
          }
          const tpsHit = [trade.tp1_hit,trade.tp2_hit,trade.tp3_hit].filter(Boolean).length;
          const pnlEmoji = parseFloat(pnlR)>=0 ? '📈' : '📉';
          const holdMsgId = await sendTelegramMsg(
`🤖 <b>AI TRADE UPDATE - HOLD</b>
-------------------
⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(entry)}</code> | Now: <code>${fmt(price)}</code>
${pnlEmoji} P&L: ${parseFloat(pnlR)>=0?'+':''}${pnlR}R
🛑 SL: <code>${fmt(sl)}</code>
🎯 TPs atteints: ${tpsHit}/3

✅ <b>HOLD - Tenir la position</b>
📝 "${r.reason}"
-------------------
#AIUpdate #Hold`, trade.tg_message_id||null);
          if (holdMsgId) lastHoldMsgId[holdKey] = holdMsgId;
          log(`-> HOLD - alert sent (replaced prev msg)`);
        }

      }catch(aiErr){
        log(`[WARN] Trade AI error [${trade.pair}]: ${aiErr.message}`);
      }
    }
  }catch(e){
    log(`[WARN] analyzeActiveTrades: ${e.message}`);
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

// Track last HOLD message per trade (to delete before sending new one)
const lastHoldMsgId = {};
let dxyData = { price: null, trend: 'neutre', change: null }; // DXY correlation
let dxyRefreshCount = 0; // DXY refresh counter
const lastAICall    = {};  // throttle: { pair: timestamp }
const lastAIScore   = {};  // { pair: score } - skip AI if score unchanged

async function deleteTelegramMsg(msgId) {
  if (!msgId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/deleteMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, message_id: msgId })
    });
  } catch(e) { log(`[WARN] TG delete: ${e.message}`); }
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
  }catch(e){ log(`[WARN] TG msg: ${e.message}`); return null; }
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

// --- State --------------------------------------------------
const prices     = {};
const prevPrices = {};
const prevClose  = {};
const candles    = {};
const liveCandle = {};
let   lastSig    = {};   // lastSig[key] = { sig, time } - reset after 2h
let   calEvents  = [];
let   calBlocked = false;

// --- Utils --------------------------------------------------
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
  const now = new Date();
  const h   = now.getUTCHours();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false; // weekend
  return h >= 8 && h < 21;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// UTC timestamp for Telegram messages - ex: "14:32 UTC"
function utcTime() {
  const now = new Date();
  const h = String(now.getUTCHours()).padStart(2,'0');
  const m = String(now.getUTCMinutes()).padStart(2,'0');
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
  const isStart = lastSession === '' || lastSession === '🌏 Asian';
  lastSession = session;

  const sessionInfo = {
    '🇬🇧 London':          { time:'09h00-18h00', pairs:'EUR/USD • GBP/USD', tip:'Breakouts + trend Londres' },
    '🔀 London+NY Overlap': { time:'14h00-18h00', pairs:'Toutes les paires', tip:'🔥 Meilleure liquidité - aktar signals' },
    '🇺🇸 New York':         { time:'14h00-23h00', pairs:'EUR/USD • USD/JPY', tip:'Volatilité USD forte' },
  };
  const info = sessionInfo[session] || { time:'-', pairs:'-', tip:'-' };

  const msg = `⏰ <b>SESSION ${isStart?'OUVERTE':'CHANGÉE'}</b> - ${utcTime()}
-------------------
${session}
🕐 ${info.time} UTC
📊 Paires actives: ${info.pairs}
💡 ${info.tip}
-------------------
🤖 Scan actif - en attente de setup...
#Session #FXSignalPro`;

  await sendTelegramMsg(msg);
  log(`[OK] Session message sent: ${session}`);
}

// End of Day summary - 21h UTC
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
-------------------
⏰ ${utcTime()}
📅 ${today.charAt(0).toUpperCase()+today.slice(1)}

${total > 0 ? `📋 <b>Trades du jour:</b>
${tradeLines}

-------------------
📊 <b>Statistiques:</b>
  Signals: ${total} | Wins: ${wins} | Losses: ${slhits} | BE: ${be}
  Win Rate: ${total>0?wr+'%':'-'}
  TP1: ${tp1hits} | TP2: ${tp2hits} | TP3: ${tp3hits} | SL: ${slhits}

💰 <b>P&amp;L total: ${rrStr}</b>
  (basé sur RR - TP1×40% + TP2×35% + TP3×25%)

${perf}` : `😴 Aucun signal aujourd'hui - marché en range`}

-------------------
📅 Prochain briefing demain à 08h00 UTC
#EndOfDay #FXSignalPro`;

    // Friday EOD - add "See you Monday" message
    const eodDay = new Date().getUTCDay(); // 5 = Friday
    let finalMsg = msg;
    if (eodDay === 5) {
      finalMsg += `

🌙 <b>Bon week-end à tous!</b>
On se retrouve lundi à l'ouverture du marché.
Profitez bien du repos 💪
<i>See you next week!</i>`;
    }

    await sendTelegramMsg(finalMsg);
    log(`[OK] End of day summary sent - ${total} trades | ${rrStr}`);

    // Reset lastSig - signals jdad nhar jdid [OK]
    lastSig = {};  // reset kol signal - nhar jdid
    lastSession = '';
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
      log('[EOD] Weekend - skipping EOD summary');
      lastSig = {};
      lastSession = '';
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
        else { lastSig = {}; lastSession = ''; }
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
    const trades  = await dbSelect('trades',
      `created_at=gte.${fromISO}&order=created_at.asc`
    );

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
-------------------
⏰ ${utcTime()}
🗓️ Semaine du ${new Date(Date.now()-6*24*60*60*1000).toLocaleDateString('fr-FR',{day:'numeric',month:'long'})} au ${new Date().toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'})}

${total > 0 ? `${dayLines}

-------------------
📈 <b>RÉSUMÉ DE LA SEMAINE:</b>
  Total signals: ${total}
  ✅ Wins: ${wins} | ❌ Losses: ${slhits} | ➡️ BE: ${be}
  📊 Win Rate: ${wr}%
  🎯 TP1: ${tp1hits} | TP2: ${tp2hits} | TP3: ${tp3hits} | SL: ${slhits}

💰 <b>P&amp;L total semaine: ${totalRRStr}</b>
  (TP1×40% + TP2×35% + TP3×25%)
${bestPair ? `\n🏆 Meilleure paire: ${bestPair[0]} (${Math.round(bestPair[1].wins/bestPair[1].total*100)}% WR)` : ''}

${perf}` : `😴 Aucun signal cette semaine`}

-------------------
🌙 <b>Bon week-end à tous!</b>
On se retrouve lundi à l'ouverture du marché - restez disciplinés 💪
<i>See you next week! 🚀</i>
#WeeklyReport #FXSignalPro`;

    await sendTelegramMsg(msg);
    log(`[OK] Weekly report sent - ${total} trades | ${totalRRStr}`);
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

// --- Technical Indicators -----------------------------------
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

function calcStructuredSLTP(candles1h, candles15m, candles4h, price, isBuy, dec, atrValue=null) {
  const pip    = dec===2 ? 0.10 : dec===3 ? 0.01 : 0.0001;
  const minSL  = pip * (dec===2 ? 80 : 8);
  const c15    = candles15m.slice(-20);
  const swH15  = c15.length ? Math.max(...c15.map(x=>x.h)) : price;
  const swL15  = c15.length ? Math.min(...c15.map(x=>x.l)) : price;

  // ATR-aware SL: ila ATR kbir → SL ytb3ed (buffer = 1.5× ATR)
  const atrBuffer = atrValue ? atrValue * 1.5 : pip * 2;
  const sl     = isBuy
    ? Math.min(swL15 - atrBuffer, price - minSL)
    : Math.max(swH15 + atrBuffer, price + minSL);
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


// --- ATR (Average True Range) -------------------------------
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
  if (!atr) return { ok: true, label: 'ATR N/A', atr: null, atrPct: null };
  const atrPct = (atr / price) * 100;
  // Dead market: ATR < 0.03% price -> no movement
  // Spike/news: ATR > 0.35% price -> too risky
  // Threshold per pair: Gold = more volatile by nature
  const spikeThreshold = dec === 2 ? 0.60 : 0.35; // Gold(dec=2)=0.60%, others=0.35%
  const dead  = atrPct < 0.03;
  const spike = atrPct > spikeThreshold;
  const ok    = !dead && !spike;
  const label = dead ? '😴 Marché mort (ATR trop bas)' : spike ? `⚡ Spike/News (ATR trop élevé ${atrPct.toFixed(3)}%)` : `✅ ATR normal (${atrPct.toFixed(3)}%)`;
  return { ok, label, atr: parseFloat(atr.toFixed(dec+1)), atrPct: parseFloat(atrPct.toFixed(4)), spikeThreshold };
}

// --- Order Blocks (LuxAlgo ICT method) -----------------------
// Bullish OB: BOS bull → find lowest candle before swing high
// Bearish OB: BOS bear → find highest candle before swing low
function findOrderBlocks(candles1h, price, dec) {
  const bars = candles1h.slice(-Math.min(200, candles1h.length));
  const n = bars.length;
  const swingLen = 10;

  // Find swing highs and lows
  const swingHighs = [], swingLows = [];
  for (let i = swingLen; i < n - swingLen; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - swingLen; j <= i + swingLen; j++) {
      if (j !== i) {
        if (bars[j].h >= bars[i].h) isHigh = false;
        if (bars[j].l <= bars[i].l) isLow  = false;
      }
    }
    if (isHigh) swingHighs.push({ idx: i, level: bars[i].h });
    if (isLow)  swingLows.push ({ idx: i, level: bars[i].l });
  }

  let bullOB = null, bearOB = null;

  // Bullish OB: price breaks above last swing high → OB = candle with lowest low before BOS
  if (swingHighs.length > 0) {
    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    const lastBar = bars[n - 1];
    if (lastBar.c > lastSwingHigh.level) {
      // BOS bullish confirmed — find OB candle (lowest low before swing high)
      let minLow = Infinity, obIdx = lastSwingHigh.idx;
      for (let i = Math.max(0, lastSwingHigh.idx - 20); i < lastSwingHigh.idx; i++) {
        if (bars[i].l < minLow) { minLow = bars[i].l; obIdx = i; }
      }
      const ob = bars[obIdx];
      const obTop = Math.max(ob.o, ob.c);
      const obBtm = ob.l;
      const isBreaker = price < obBtm; // price broke below OB = breaker block
      if (!isBreaker) {
        bullOB = {
          top:    parseFloat(obTop.toFixed(dec)),
          bottom: parseFloat(obBtm.toFixed(dec)),
          breaker: false
        };
      }
    }
  }

  // Bearish OB: price breaks below last swing low → OB = candle with highest high before BOS
  if (swingLows.length > 0) {
    const lastSwingLow = swingLows[swingLows.length - 1];
    const lastBar = bars[n - 1];
    if (lastBar.c < lastSwingLow.level) {
      // BOS bearish confirmed — find OB candle (highest high before swing low)
      let maxHigh = -Infinity, obIdx = lastSwingLow.idx;
      for (let i = Math.max(0, lastSwingLow.idx - 20); i < lastSwingLow.idx; i++) {
        if (bars[i].h > maxHigh) { maxHigh = bars[i].h; obIdx = i; }
      }
      const ob = bars[obIdx];
      const obTop = ob.h;
      const obBtm = Math.min(ob.o, ob.c);
      const isBreaker = price > obTop; // price broke above OB = breaker block
      if (!isBreaker) {
        bearOB = {
          top:    parseFloat(obTop.toFixed(dec)),
          bottom: parseFloat(obBtm.toFixed(dec)),
          breaker: false
        };
      }
    }
  }

  const nearBullOB = bullOB ? price >= bullOB.bottom * 0.9995 && price <= bullOB.top * 1.0005 : false;
  const nearBearOB = bearOB ? price >= bearOB.bottom * 0.9995 && price <= bearOB.top * 1.0005 : false;

  return { bullOB, bearOB, nearBullOB, nearBearOB };
}

// --- Liquidity Zones (LuxAlgo ICT method) --------------------
// Buyside liq  = cluster of 3+ swing HIGHS within ATR/4 (equal highs = buy stops)
// Sellside liq = cluster of 3+ swing LOWS  within ATR/4 (equal lows  = sell stops)
function findLiquidityZones(candles1h, price, dec) {
  const bars = candles1h.slice(-Math.min(200, candles1h.length));
  const n = bars.length;
  const swingLen = 5;

  // ATR for margin
  let atr = 0;
  for (let i = 1; i < Math.min(15, n); i++) {
    atr += Math.max(bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i-1].c),
      Math.abs(bars[i].l - bars[i-1].c));
  }
  atr /= 14;
  const margin = atr / 4;

  // Find swing highs and lows
  const swingHighs = [], swingLows = [];
  for (let i = swingLen; i < n - swingLen; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - swingLen; j <= i + swingLen; j++) {
      if (j !== i) {
        if (bars[j].h >= bars[i].h) isHigh = false;
        if (bars[j].l <= bars[i].l) isLow  = false;
      }
    }
    if (isHigh) swingHighs.push(bars[i].h);
    if (isLow)  swingLows.push (bars[i].l);
  }

  // Find buyside liquidity clusters (equal highs)
  let buysideLiq = null;
  if (swingHighs.length >= 3) {
    // Sort descending, find cluster
    const sorted = [...swingHighs].sort((a, b) => b - a);
    for (let i = 0; i < sorted.length - 2; i++) {
      const count = sorted.filter(h => Math.abs(h - sorted[i]) <= margin).length;
      if (count >= 3) {
        const cluster = sorted.filter(h => Math.abs(h - sorted[i]) <= margin);
        const clusterMid = cluster.reduce((a, b) => a + b, 0) / cluster.length;
        if (clusterMid > price) { // above price = buyside (buy stops)
          buysideLiq = {
            level: parseFloat(clusterMid.toFixed(dec)),
            top:   parseFloat((clusterMid + margin).toFixed(dec)),
            bottom:parseFloat((clusterMid - margin).toFixed(dec)),
            count
          };
          break;
        }
      }
    }
  }

  // Find sellside liquidity clusters (equal lows)
  let sellsideLiq = null;
  if (swingLows.length >= 3) {
    const sorted = [...swingLows].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 2; i++) {
      const count = sorted.filter(l => Math.abs(l - sorted[i]) <= margin).length;
      if (count >= 3) {
        const cluster = sorted.filter(l => Math.abs(l - sorted[i]) <= margin);
        const clusterMid = cluster.reduce((a, b) => a + b, 0) / cluster.length;
        if (clusterMid < price) { // below price = sellside (sell stops)
          sellsideLiq = {
            level: parseFloat(clusterMid.toFixed(dec)),
            top:   parseFloat((clusterMid + margin).toFixed(dec)),
            bottom:parseFloat((clusterMid - margin).toFixed(dec)),
            count
          };
          break;
        }
      }
    }
  }

  const nearBuyside  = buysideLiq  ? Math.abs(price - buysideLiq.level)  / price < 0.005 : false;
  const nearSellside = sellsideLiq ? Math.abs(price - sellsideLiq.level) / price < 0.005 : false;

  return { buysideLiq, sellsideLiq, nearBuyside, nearSellside };
}

// --- Candle Momentum Filter ----------------------------------
// Last 3 closed candles on 15m
// body / range > 0.6 = strong candle
// 2+ strong in direction -> STRONG
// 1  strong in direction -> NEUTRAL
// 0  strong in direction -> WEAK
function candleStrength(candles15m, direction) {
  if (!candles15m || candles15m.length < 4) {
    return { strong: false, level: 'neutral', strongCount: 0, label: 'N/A' };
  }

  const last3 = candles15m.slice(-4, -1); // 3 dernières bougies fermées
  let strongCount = 0;

  for (const candle of last3) {
    const body    = Math.abs(candle.c - candle.o);
    const range   = candle.h - candle.l;
    const bodyPct = range > 0 ? body / range : 0;
    const isBull  = candle.c > candle.o;
    const isBear  = candle.c < candle.o;

    // Strong candle dans la bonne direction: body > 60% range
    if (direction === 'bull' && isBull && bodyPct > 0.6) strongCount++;
    if (direction === 'bear' && isBear && bodyPct > 0.6) strongCount++;
  }

  // 3 levels
  const level  = strongCount >= 2 ? 'strong' : strongCount === 1 ? 'neutral' : 'weak';
  const strong = level === 'strong';
  const dirLabel = direction === 'bull' ? 'haussières' : 'baissières';
  const label  = level === 'strong'
    ? `✅ Momentum fort - ${strongCount}/3 bougies ${dirLabel} solides`
    : level === 'neutral'
    ? `⚠️ Momentum neutre - ${strongCount}/3 bougie ${dirLabel} solide`
    : `❌ Momentum faible - 0/3 bougies ${dirLabel} solides`;

  return { strong, level, strongCount, label };
}


// --- SR Channels (TradingView "Support Resistance Channels" logic) ---
// Based on: pivot points + channel grouping + strength scoring
function findSRChannels(candles1h, price, dec, pivotPeriod = 10, maxChannels = 6, loopback = 290) {
  if (!candles1h || candles1h.length < pivotPeriod * 2 + 1) return [];

  const bars = candles1h.slice(-Math.min(loopback, candles1h.length));
  const n = bars.length;

  // Channel width = 5% of (highest - lowest) in last 300 bars
  const highest = Math.max(...bars.map(b => b.h));
  const lowest  = Math.min(...bars.map(b => b.l));
  const cwidth  = (highest - lowest) * 0.05;

  // Find pivot highs and lows (period = 10 each side)
  const pivots = [];
  for (let i = pivotPeriod; i < n - pivotPeriod; i++) {
    const bar = bars[i];
    // Pivot High
    let isHigh = true;
    for (let j = i - pivotPeriod; j <= i + pivotPeriod; j++) {
      if (j !== i && bars[j].h >= bar.h) { isHigh = false; break; }
    }
    if (isHigh) pivots.push({ level: bar.h, idx: i });

    // Pivot Low
    let isLow = true;
    for (let j = i - pivotPeriod; j <= i + pivotPeriod; j++) {
      if (j !== i && bars[j].l <= bar.l) { isLow = false; break; }
    }
    if (isLow) pivots.push({ level: bar.l, idx: i });
  }

  if (!pivots.length) return [];

  // Group pivots into SR zones
  const zones = [];
  for (let i = 0; i < pivots.length; i++) {
    let lo = pivots[i].level;
    let hi = lo;
    let strength = 0;

    for (let j = 0; j < pivots.length; j++) {
      const cpp = pivots[j].level;
      const wdth = cpp <= hi ? hi - cpp : cpp - lo;
      if (wdth <= cwidth) {
        lo = Math.min(lo, cpp);
        hi = Math.max(hi, cpp);
        strength += 20; // each pivot = +20
      }
    }

    // Add touch count (candles touching the zone)
    for (let b = 0; b < n; b++) {
      if ((bars[b].h <= hi && bars[b].h >= lo) ||
          (bars[b].l <= hi && bars[b].l >= lo)) {
        strength += 1;
      }
    }

    zones.push({ hi, lo, strength });
  }

  // Sort by strength descending
  zones.sort((a, b) => b.strength - a.strength);

  // Deduplicate: remove zones that overlap
  const final = [];
  for (const zone of zones) {
    const overlap = final.some(z =>
      (zone.lo <= z.hi && zone.hi >= z.lo)
    );
    if (!overlap && zone.strength >= 40) { // min 2 pivots
      final.push(zone);
    }
    if (final.length >= maxChannels) break;
  }

  // Label each zone
  return final.map(z => ({
    hi:  parseFloat(z.hi.toFixed(dec)),
    lo:  parseFloat(z.lo.toFixed(dec)),
    mid: parseFloat(((z.hi + z.lo) / 2).toFixed(dec)),
    strength: z.strength,
    type: price > z.hi ? 'support' : price < z.lo ? 'resistance' : 'inside',
  }));
}

// --- Compute Technicals -------------------------------------
function computeTechnicals(key) {
  const price = prices[key];
  const c = candles[key];
  if (!price || !c?.h1?.length || c.h1.length < 20) return null;

  // h1_calc = closed candles only -> EMA / RSI / Structure / ATR / OB (always clean)
  // prices[key] = live price -> entry / TP/SL / P&L (always real-time)
  const h1 = [...c.h1];

  const h4 = c.h4 || [];
  const m30 = c.m30 || [];
  const m15 = c.m15 || [];
  const closes1h  = h1.map(x => x.c);
  const closes4h  = h4.map(x => x.c);
  const closes15m = m15.map(x => x.c);
  const dec = PAIRS.find(p => p.key === key).dec;

  // Daily bias — use RECENT 20 candles for medium-term trend (more relevant)
  const daily = c.daily || [];
  const closesDaily = daily.map(x => x.c);
  // Recent trend (last 20 days) — most important
  const recentDaily = daily.slice(-20);
  const closesRecentDaily = recentDaily.map(x => x.c);
  const ema10_recent = calcEMA(closesRecentDaily, Math.min(10, closesRecentDaily.length));
  const ema20_recent = calcEMA(closesRecentDaily, Math.min(20, closesRecentDaily.length));
  const structRecentDaily = getSwingStructure(recentDaily);
  const lastCloseDaily = closesDaily[closesDaily.length - 1] || price;
  // trendDaily = recent 20 days trend (not 427 days!)
  const trendDaily = (ema10_recent && ema20_recent && ema10_recent < ema20_recent && structRecentDaily === 'baissier') ? 'baissier'
                   : (ema10_recent && ema20_recent && ema10_recent > ema20_recent && structRecentDaily === 'haussier') ? 'haussier'
                   : structRecentDaily || 'neutre';
  // Long term trend (info only — for context)
  const ema20_daily = calcEMA(closesDaily, Math.min(20, closesDaily.length));
  const ema50_daily = calcEMA(closesDaily, Math.min(50, closesDaily.length));
  const structDaily = getSwingStructure(daily.slice(-30));

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

  // SR Channels (TradingView logic — pivot clusters + strength)
  const srChannels = findSRChannels(h1, price, dec);
  const srResistances = srChannels.filter(z => z.type === 'resistance').slice(0, 3);
  const srSupports    = srChannels.filter(z => z.type === 'support').slice(0, 3);
  const srInside      = srChannels.filter(z => z.type === 'inside');
  const nearSRZone    = srInside.length > 0;
  const nearSRStrong  = srInside.some(z => z.strength >= 100);
  const closestRes    = srResistances[0] || null;
  const closestSup    = srSupports[0]    || null;

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

  const active = isActiveSession();
  const swingH = sr1h.recentHigh, swingL = sr1h.recentLow;

  // --- Price Action Patterns (15m + 1H) ---
  // Engulfing candle: current candle body > prev candle body * 1.5
  const last2_15m = m15.slice(-3, -1); // last 2 closed candles
  const last2_1h  = h1.slice(-3, -1);

  // Bullish engulfing (15m)
  const bullEngulf15m = last2_15m.length === 2 &&
    last2_15m[0].c < last2_15m[0].o && // prev = bearish
    last2_15m[1].c > last2_15m[1].o && // curr = bullish
    (last2_15m[1].c - last2_15m[1].o) > (last2_15m[0].o - last2_15m[0].c) * 1.2;

  // Bearish engulfing (15m)
  const bearEngulf15m = last2_15m.length === 2 &&
    last2_15m[0].c > last2_15m[0].o && // prev = bullish
    last2_15m[1].c < last2_15m[1].o && // curr = bearish
    (last2_15m[1].o - last2_15m[1].c) > (last2_15m[0].c - last2_15m[0].o) * 1.2;

  // Pin bar / Hammer (rejection candle) on 15m
  const lastC15m = m15[m15.length - 2]; // last closed
  let pinBarBull15m = false, pinBarBear15m = false;
  if (lastC15m) {
    const body = Math.abs(lastC15m.c - lastC15m.o);
    const range = lastC15m.h - lastC15m.l;
    const lowerWick = Math.min(lastC15m.c, lastC15m.o) - lastC15m.l;
    const upperWick = lastC15m.h - Math.max(lastC15m.c, lastC15m.o);
    if (range > 0) {
      pinBarBull15m = lowerWick > body * 2 && lowerWick > range * 0.6; // hammer
      pinBarBear15m = upperWick > body * 2 && upperWick > range * 0.6; // shooting star
    }
  }

  // Strong close (last closed 1H candle closes in top/bottom 25% of range)
  const lastC1h = h1[h1.length - 2];
  let strongCloseBull1h = false, strongCloseBear1h = false;
  if (lastC1h) {
    const range1h = lastC1h.h - lastC1h.l;
    if (range1h > 0) {
      strongCloseBull1h = lastC1h.c > lastC1h.l + range1h * 0.75 && lastC1h.c > lastC1h.o;
      strongCloseBear1h = lastC1h.c < lastC1h.h - range1h * 0.75 && lastC1h.c < lastC1h.o;
    }
  }

  // Strong close 30m
  const lastC30m = m30.length >= 2 ? m30[m30.length - 2] : null;
  let strongCloseBull30m = false, strongCloseBear30m = false;
  if (lastC30m) {
    const range30m = lastC30m.h - lastC30m.l;
    if (range30m > 0) {
      strongCloseBull30m = lastC30m.c > lastC30m.l + range30m * 0.75 && lastC30m.c > lastC30m.o;
      strongCloseBear30m = lastC30m.c < lastC30m.h - range30m * 0.75 && lastC30m.c < lastC30m.o;
    }
  }

  // Doji detection (15m + 30m) — indecision candle
  const dojiThreshold = 0.1; // body < 10% of range
  const lastC15m_doji = m15.length >= 2 ? m15[m15.length - 2] : null;
  let doji15m = false, doji30m = false;
  if (lastC15m_doji) {
    const body15 = Math.abs(lastC15m_doji.c - lastC15m_doji.o);
    const range15 = lastC15m_doji.h - lastC15m_doji.l;
    doji15m = range15 > 0 && body15 / range15 < dojiThreshold;
  }
  if (lastC30m) {
    const body30 = Math.abs(lastC30m.c - lastC30m.o);
    const range30 = lastC30m.h - lastC30m.l;
    doji30m = range30 > 0 && body30 / range30 < dojiThreshold;
  }

  // Rejection candle f S/R zone (pin bar AT support or resistance)
  const rejectionBullSR = pinBarBull15m && nearSupport;   // hammer f support
  const rejectionBearSR = pinBarBear15m && nearResistance; // shooting star f resistance

  // Higher Highs / Lower Lows sequence (15m last 6 candles)
  const last6_15m = m15.slice(-7, -1);
  let hhll_bull = false, hhll_bear = false;
  if (last6_15m.length >= 4) {
    const highs = last6_15m.map(x => x.h);
    const lows  = last6_15m.map(x => x.l);
    hhll_bull = highs[highs.length-1] > highs[highs.length-3] && lows[lows.length-1] > lows[lows.length-3];
    hhll_bear = highs[highs.length-1] < highs[highs.length-3] && lows[lows.length-1] < lows[lows.length-3];
  }

  // PA Score triggers (includes 30m + rejection)
  const pa_bull = (bullEngulf15m || pinBarBull15m || rejectionBullSR || strongCloseBull1h || strongCloseBull30m) && hhll_bull;
  const pa_bear = (bearEngulf15m || pinBarBear15m || rejectionBearSR || strongCloseBear1h || strongCloseBear30m) && hhll_bear;
  const pa_bull_partial = bullEngulf15m || pinBarBull15m || rejectionBullSR || strongCloseBull1h || strongCloseBull30m || hhll_bull;
  const pa_bear_partial = bearEngulf15m || pinBarBear15m || rejectionBearSR || strongCloseBear1h || strongCloseBear30m || hhll_bear;

  // PA pattern label
  const paBullLabel = rejectionBullSR ? 'Rejection Bull f S/R 15m' :
    bullEngulf15m ? 'Bullish Engulfing 15m' :
    pinBarBull15m ? 'Pin Bar Bull 15m' :
    strongCloseBull30m ? 'Strong Close Bull 30m' :
    strongCloseBull1h ? 'Strong Close Bull 1H' :
    hhll_bull ? 'HH/HL sequence' : 'none';
  const paBearLabel = rejectionBearSR ? 'Rejection Bear f S/R 15m' :
    bearEngulf15m ? 'Bearish Engulfing 15m' :
    pinBarBear15m ? 'Pin Bar Bear 15m' :
    strongCloseBear30m ? 'Strong Close Bear 30m' :
    strongCloseBear1h ? 'Strong Close Bear 1H' :
    hhll_bear ? 'LH/LL sequence' : 'none';

  // --- Fibonacci Retracement ---
  // Calculate fib levels from last swing high/low (1H, last 50 candles)
  const fibCandles = h1.slice(-50);
  const fibHigh = Math.max(...fibCandles.map(x => x.h));
  const fibLow  = Math.min(...fibCandles.map(x => x.l));
  const fibRange = fibHigh - fibLow;
  const fib236 = fibHigh - fibRange * 0.236;
  const fib382 = fibHigh - fibRange * 0.382;
  const fib500 = fibHigh - fibRange * 0.500;
  const fib618 = fibHigh - fibRange * 0.618;
  const fib786 = fibHigh - fibRange * 0.786;

  // Price near key fib level (within 0.1%)
  const tolerance = price * 0.001;
  const nearFib236 = Math.abs(price - fib236) < tolerance;
  const nearFib382 = Math.abs(price - fib382) < tolerance;
  const nearFib500 = Math.abs(price - fib500) < tolerance;
  const nearFib618 = Math.abs(price - fib618) < tolerance;
  const nearFib786 = Math.abs(price - fib786) < tolerance;
  const nearGoldenZone = nearFib618 || nearFib786; // 61.8-78.6% = golden zone
  const nearFibAny = nearFib236 || nearFib382 || nearFib500 || nearFib618 || nearFib786;

  const fibLabel = nearGoldenZone ? `Golden Zone (${nearFib618?'61.8%':'78.6%'})` :
                   nearFib500 ? '50% retracement' :
                   nearFib382 ? '38.2% retracement' :
                   nearFib236 ? '23.6% retracement' : 'not at key fib level';

  // Keep bos/fvg for backward compat
  const bos_bull = price > swingH * 1.0002 && struct1h === 'haussier';
  const bos_bear = price < swingL * 0.9998 && struct1h === 'baissier';
  const fvg_bull = false;
  const fvg_bear = false;

  // -- ATR Volatility Filter --
  const atrData = atrFilter(h1, price, dec);
  const atr1h   = atrData.atr;
  const atrPct  = atrData.atrPct;
  const atrOk   = atrData.ok;
  const atrLabel = atrData.label;

  // -- Order Blocks (LuxAlgo ICT method) --
  const obData     = findOrderBlocks(h1, price, dec);
  const nearBullOB = obData.nearBullOB;
  const nearBearOB = obData.nearBearOB;
  const bullOB     = obData.bullOB;
  const bearOB     = obData.bearOB;

  // -- Liquidity Zones (LuxAlgo ICT method) --
  const liqData      = findLiquidityZones(h1, price, dec);
  const buysideLiq   = liqData.buysideLiq;
  const sellsideLiq  = liqData.sellsideLiq;
  const nearBuyside  = liqData.nearBuyside;
  const nearSellside = liqData.nearSellside;

  // -- Candle Strength Filter --
  const csDir    = struct15m === 'haussier' ? 'bull' : 'bear';
  const csData   = candleStrength(m15, csDir);
  const candlesOk = csData.strong;
  const candlesLabel = csData.label;

  // -- Volume Analysis (1H tick volume) --
  let volContext = 'N/A', volRatio = null, lastVol = null, avgVol = null;
  const volCandles = h1.slice(-20);
  if(volCandles.length >= 5 && volCandles.some(v => v.v > 0)){
    const vols = volCandles.map(v => v.v).filter(v => v > 0);
    avgVol = Math.round(vols.reduce((a,b) => a+b, 0) / vols.length);
    lastVol = volCandles[volCandles.length-1].v;
    volRatio = avgVol > 0 ? parseFloat((lastVol / avgVol).toFixed(2)) : 1;
    volContext = volRatio >= 1.5 ? 'HIGH' : volRatio <= 0.5 ? 'LOW' : 'NORMAL';
  }

  // Scores
  let srScore = nearSupport ? 25 : nearResistance ? 25 : 0;
  let srDir   = nearSupport ? 'haussier' : nearResistance ? 'baissier' : 'neutre';
  if (srScore > 0 && trend4h !== srDir) srScore = 12;
  // Order Block bonus - price in OB zone = extra confluence
  if (nearBullOB && trend4h === 'haussier') { srScore = Math.min(25, srScore + 5); srDir = 'haussier'; }
  if (nearBearOB && trend4h === 'baissier') { srScore = Math.min(25, srScore + 5); srDir = 'baissier'; }

  let emaScore = 0, ictScore = 0, ictDir = 'inactif';
  if (bullishEMA && trend4h === 'haussier') emaScore = 25;
  else if (bearishEMA && trend4h === 'baissier') emaScore = 25;
  else if (emaDir !== 'neutre') emaScore = 12;
  const emaDir2 = emaScore > 0 ? emaDir : 'neutre';

  let rsiScore = 0;
  if (rsiOversold  && nearSupport)    rsiScore = 25;
  else if (rsiOverbought && nearResistance) rsiScore = 25;
  else if (rsiOversold || rsiOverbought)    rsiScore = 15;

  // PA Score (replaces ICT)
  // Full PA setup (pattern + sequence + trend aligned) = 25pts
  // Partial (1 pattern only) = 15pts
  // Fib golden zone bonus = +5pts
  if (active && pa_bull && trend4h === 'haussier') { ictScore = 25; ictDir = 'haussier'; }
  else if (active && pa_bear && trend4h === 'baissier') { ictScore = 25; ictDir = 'baissier'; }
  else if (active && pa_bull_partial && trend4h === 'haussier') { ictScore = 15; ictDir = 'haussier'; }
  else if (active && pa_bear_partial && trend4h === 'baissier') { ictScore = 15; ictDir = 'baissier'; }
  else if (active && bos_bull && trend4h === 'haussier') { ictScore = 10; ictDir = 'haussier'; }
  else if (active && bos_bear && trend4h === 'baissier') { ictScore = 10; ictDir = 'baissier'; }
  else if (active) ictScore = 0;

  // Fibonacci bonus
  if (nearGoldenZone) ictScore = Math.min(25, ictScore + 5);
  else if (nearFibAny) ictScore = Math.min(25, ictScore + 3);

  // Base score (100pts)
  let totalScore = srScore + emaScore + rsiScore + ictScore;

  // Bonus filters (max +20pts total) - affect throttle trigger too
  // ATR bonus: normal volatility = +5
  if (atrOk) totalScore = Math.min(100, totalScore + 5);

  // Order Block bonus: price in OB aligned with trend = +8
  if (nearBullOB && trend4h === 'haussier') totalScore = Math.min(100, totalScore + 8);
  else if (nearBearOB && trend4h === 'baissier') totalScore = Math.min(100, totalScore + 8);

  // Volume bonus: high volume = +4
  if (volContext === 'HIGH') totalScore = Math.min(100, totalScore + 4);
  else if (volContext === 'LOW') totalScore = Math.max(0, totalScore - 5); // penalty

  // Candle Momentum bonus: strong = +3, weak = penalty
  const candlesLevel = csData.level; // declare here for score use
  if (candlesLevel === 'strong') totalScore = Math.min(100, totalScore + 3);
  else if (candlesLevel === 'weak') totalScore = Math.max(0, totalScore - 3);
  const bullCount = [srDir, emaDir2, rsiDir, ictDir].filter(d => d === 'haussier').length;
  const bearCount = [srDir, emaDir2, rsiDir, ictDir].filter(d => d === 'baissier').length;
  let finalDir = 'neutre';
  if (bullCount >= 3) finalDir = 'haussier';
  else if (bearCount >= 3) finalDir = 'baissier';
  // 2 aligned = lean direction - still send to AI for final decision
  else if (bullCount === 2) finalDir = 'haussier_lean';
  else if (bearCount === 2) finalDir = 'baissier_lean';

  // Structured SL/TP based on real S/R levels
  const isBuyDir  = finalDir === 'haussier' || finalDir === 'haussier_lean';
  const isSellDir = finalDir === 'baissier' || finalDir === 'baissier_lean';
  const structuredLevels = (isBuyDir||isSellDir) && m15.length>=6 && h1.length>=20
    ? calcStructuredSLTP(h1, m15, h4, price, isBuyDir, dec, atr1h)
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
    srChannels, srResistances, srSupports, nearSRZone, nearSRStrong, closestRes, closestSup,
    support4h: sr4h.support.toFixed(dec), resistance4h: sr4h.resistance.toFixed(dec),
    prevDayHigh: prevDayHigh?.toFixed(dec)||null, prevDayLow: prevDayLow?.toFixed(dec)||null,
    eqHigh, eqLow, liqSweepBull, liqSweepBear, nearPDH, nearPDL, liqBull, liqBear,
    buysideLiq, sellsideLiq, nearBuyside, nearSellside,
    recentHigh: sr1h.recentHigh.toFixed(dec), recentLow: sr1h.recentLow.toFixed(dec),
    bos_bull, bos_bear, fvg_bull, fvg_bear, active,
    pa_bull, pa_bear, pa_bull_partial, pa_bear_partial,
    doji15m, doji30m, rejectionBullSR, rejectionBearSR,
    strongCloseBull30m, strongCloseBear30m,
    bullEngulf15m, bearEngulf15m, pinBarBull15m, pinBarBear15m,
    strongCloseBull1h, strongCloseBear1h, hhll_bull, hhll_bear,
    paBullLabel, paBearLabel,
    fib236: fib236.toFixed(dec), fib382: fib382.toFixed(dec),
    fib500: fib500.toFixed(dec), fib618: fib618.toFixed(dec), fib786: fib786.toFixed(dec),
    nearFibAny, nearGoldenZone, fibLabel,
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

// --- Fetch Prices -------------------------------------------
// Fetch DXY (US Dollar Index) for correlation context
async function fetchDXY() {
  try {
    const [rPrice, rCandles] = await Promise.all([
      fetch(`https://api.twelvedata.com/price?symbol=DX-Y.NYB&apikey=${TD_KEY}`),
      fetch(`https://api.twelvedata.com/time_series?symbol=DX-Y.NYB&interval=1h&outputsize=20&apikey=${TD_KEY}`)
    ]);
    const [dPrice, dCandles] = await Promise.all([rPrice.json(), rCandles.json()]);
    
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
  const hasTrades = await dbSelect('trades', 'status=eq.active&limit=1');
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
  } catch(e) {
    log(`[WARN] fetchPrices error: ${e.message}`);
  }
}

// --- Fetch Candles ------------------------------------------
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
    if (bars.length) {
      candles[pairKey].daily = bars;  // daily candles -> .daily
      candles[pairKey].h4    = bars;  // keep .h4 alias for compatibility
    }
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
    const [r1h, r30m, r15m] = await Promise.all([
      fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=1h&outputsize=300&apikey=${apiKey}`),
      fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=30min&outputsize=200&apikey=${apiKey}`),
      fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=15min&outputsize=150&apikey=${apiKey}`),
    ]);
    const [d1h, d30m, d15m] = await Promise.all([r1h.json(), r30m.json(), r15m.json()]);
    const parse = d => (d?.values || []).map(v => ({
      o: parseFloat(v.open), h: parseFloat(v.high), l: parseFloat(v.low), c: parseFloat(v.close),
      v: parseFloat(v.volume) || 0,
    })).reverse();
    if (!candles[pairKey]) candles[pairKey] = {};
    if (d1h?.values?.length)  candles[pairKey].h1  = parse(d1h);
    if (d30m?.values?.length) candles[pairKey].m30 = parse(d30m);
    if (d15m?.values?.length) candles[pairKey].m15 = parse(d15m);
    log(`[OK] Intra ${pairKey}: 1H=${candles[pairKey].h1?.length} 30m=${candles[pairKey].m30?.length} 15m=${candles[pairKey].m15?.length}`);
  } catch (e) {
    log(`[WARN] Intra ${pairKey}: ${e.message}`);
  }
}

async function fetchAllCandles() {
  log('[STATS] Fetching candles...');
  for (const p of PAIRS) {
    await fetchDailyCandles(p.key);
    await sleep(13000); // Polygon free = 5 req/min
  }
  for (const p of PAIRS) {
    await fetchIntraCandles(p.key);
    await sleep(1000);
  }
  log('[OK] All candles loaded');
  await fetchDXY(); // DXY correlation
}

// --- Economic Calendar --------------------------------------
async function fetchCalendar() {
  try {
    // Railway = server-side - direct fetch mashi bloqué [OK]
    // Try current week first, fallback to next week
    const nowDay = new Date().getUTCDay();
    // If Friday after 21h or weekend, use next week
    const useNext = (nowDay === 5 && new Date().getUTCHours() >= 21) || nowDay === 6 || nowDay === 0;
    const url = useNext 
      ? 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'
      : 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
    const res  = await fetch(url);
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    // ForexFactory dates are in EST (America/New_York) — compare both UTC and EST
    const todayUTC = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const todayEST = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
    const todayISO8 = new Date().toISOString().split('T')[0]; // YYYY-MM-DD UTC
    
    calEvents = data.filter(e => {
      if (!['USD', 'EUR', 'GBP', 'JPY'].includes(e.country)) return false;
      // Parse date - faireconomy uses EST timezone (-04:00 or -05:00)
      const eDate = new Date(e.date);
      // Convert to UTC date string
      const eDateISO = eDate.toISOString().split('T')[0]; // UTC date
      // Also check EST date (event might be today EST but yesterday UTC)
      const eDateEST = eDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
      return eDateISO === todayISO8 || eDateEST === todayEST;
    });
    const nowMs = Date.now();
    calBlocked = calEvents.some(e => {
      if (e.impact !== 'High') return false;
      const diff = new Date(e.date).getTime() - nowMs;
      return diff > -15 * 60000 && diff < 30 * 60000;
    });
    log(`[CAL] Calendar: ${calEvents.length} events today - blocked: ${calBlocked}`);
    // Log high impact events for visibility
    const highEvents = calEvents.filter(e => e.impact === 'High');
    if (highEvents.length > 0) {
      log(`[CAL] HIGH IMPACT today: ${highEvents.map(e => e.country+' '+e.title).join(' | ')}`);
    }

    // Save f Supabase bach Vercel y9ra (mashi bloqué f browser) [OK]
    try{
      // Clear today's events first
      const todayISO = new Date().toISOString().split('T')[0];
      await fetch(`${SB_URL}/rest/v1/calendar?event_time=gte.${todayISO}T00:00:00Z&event_time=lte.${todayISO}T23:59:59Z`, {
        method: 'DELETE',
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
      });
      // Insert today's events (all currencies for Vercel display)
      const allTodayEvents = data.filter(e => {
        const eDate = new Date(e.date);
        const eDateISO = eDate.toISOString().split('T')[0];
        const eDateEST = eDate.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', timeZone:'America/New_York'});
        return eDateISO === todayISO || eDateEST === todayEST;
      });
      if(allTodayEvents.length){
        await fetch(`${SB_URL}/rest/v1/calendar`, {
          method: 'POST',
          headers: { 'Content-Type':'application/json','apikey':SB_KEY,'Authorization':`Bearer ${SB_KEY}`,'Prefer':'return=minimal' },
          body: JSON.stringify(allTodayEvents.map(e => ({
            event_time: new Date(e.date).toISOString(),
            currency: e.country, // field = country in faireconomy API
            title: e.title,
            impact: e.impact,
            updated_at: new Date().toISOString()
          })))
        });
        log(`[OK] Calendar saved to DB: ${allTodayEvents.length} events | Bot tracking: ${calEvents.length} (USD/EUR/GBP/JPY)`);
      }
    }catch(dbErr){ log(`[WARN] Calendar DB save: ${dbErr.message}`); }

  } catch (e) {
    log(`[WARN] Calendar: ${e.message}`);
  }
}

// --- Telegram -----------------------------------------------
async function sendTelegram(sigKey, pair, price, dec, conf, score, r, probLabel='📊 HIGH PROBABILITY', t=null) {
  try {
    const isBuy  = sigKey === 'BUY';
    const arrow  = isBuy ? '📈' : '📉';
    const action = isBuy ? '🟢 BUY' : '🔴 SELL';
    const fmt    = v => parseFloat(v) > 0 ? parseFloat(v).toFixed(dec) : '-';
    const rr     = r.sl && r.tp2 ? Math.abs((parseFloat(r.tp2) - price) / (price - parseFloat(r.sl))).toFixed(1) : '-';
    const sess   = getSession();
    const now    = utcTime();

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
💰 <b>RISK CALCULATOR</b> <i>(SL = ${slPipsDisplay} pips)</i>
  Risk $50   -> <code>${calcLots(50)} lots</code>
  Risk $100  -> <code>${calcLots(100)} lots</code>
  Risk $200  -> <code>${calcLots(200)} lots</code>
  Risk $500  -> <code>${calcLots(500)} lots</code>
-----------------` : '';

    const text =
`${arrow} <b>FX SIGNAL PRO</b> ${arrow}
-----------------
<b>${action} - ${pair}</b>
⏰ ${now} | ${sess}
${probLabel}
-----------------
📌 <b>Entry:</b>  <code>${parseFloat(price).toFixed(dec)}</code>
🛑 <b>SL:</b>     <code>${fmt(r.sl)}</code>
🎯 <b>TP1:</b>    <code>${fmt(r.tp1)}</code>  <i>(40% - 30-45min)</i>
🎯 <b>TP2:</b>    <code>${fmt(r.tp2)}</code>  <i>(35% - 1-2h)</i>
🎯 <b>TP3:</b>    <code>${fmt(r.tp3)}</code>  <i>(25% - 2-4h)</i>
-----------------
📊 <b>Score:</b> ${score}/100 | <b>RR:</b> ${rr} | <b>Conf:</b> ${conf}%
${lotCalc}
🔬 <b>Filters:</b>
  📊 ATR: ${t ? t.atrLabel : '-'}${t && t.atrPct > (t.dec === 2 ? 0.40 : 0.25) ? `
⚠️ <b>ATR ÉLEVÉ — SL élargi automatiquement</b>
   Respectez le Risk Calculator ci-dessous 👇` : ''}
  🕯️ Momentum: ${t ? t.candlesLabel : '-'}
  🧱 OB: ${t ? (t.nearBullOB ? '✅ Bull OB zone' : t.nearBearOB ? '✅ Bear OB zone' : '-') : '-'}
-----------------
🧠 <b>Analysis:</b>
<i>${(r.raisonnement || r.analyse || '-').substring(0, 400)}</i>
-----------------
⚠️ <i>Not financial advice - manage your risk</i>
#${pair.replace('/', '_')} #${isBuy ? 'BUY' : 'SELL'} #FXSignalPro`;

    const res  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = await res.json();
    if (data.ok) log(`[OK] Telegram sent: ${pair} ${sigKey}`);
    else log(`[WARN] Telegram error: ${data.description}`);
    return data?.result?.message_id || null;
  } catch (e) {
    log(`[WARN] Telegram: ${e.message}`);
    return null;
  }
}

// --- AI Scan ------------------------------------------------
async function runScan() {
  if (!isActiveSession()) {
    log('[SLEEP] Outside active hours - skipping scan');
    return;
  }
  if (calBlocked) {
    log('[BLOCK] HIGH IMPACT news - scan blocked');
    return;
  }

  const analyses = PAIRS
    .map(p => ({ ...p, tech: computeTechnicals(p.key) }))
    .filter(p => p.tech)
    .sort((a, b) => b.tech.totalScore - a.tech.totalScore);

  if (!analyses.length) { log('[WARN] No technicals yet'); return; }

  // Max 2 active trades total
  const allActiveTrades = await dbSelect('trades', 'status=eq.active&limit=10');
  const activeCount = allActiveTrades?.length || 0;
  if (activeCount >= 2) {
    log(`-> Max 2 trades actifs atteint (${activeCount}/2) - scan bloqué`);
    return;
  }

  // Filter candidates: direction claire seulement (score >= 40 minimum)
  const candidates = analyses.filter(p => {
    const dir = p.tech.finalDir;
    const hasDir = dir.includes('haussier') || dir.includes('baissier');
    return hasDir && p.tech.totalScore >= 40;
  });

  if (!candidates.length) { log('-> WAIT: no valid candidates (no direction or score < 40)'); return; }

  // Pick best candidate not already in active trade
  let best = null;
  for (const cand of candidates) {
    const alreadyActive = allActiveTrades?.some(tr => tr.pair === cand.label);
    if (!alreadyActive) { best = cand; break; }
  }
  if (!best) { log('-> All valid pairs already have active trades'); return; }

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
  const MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 min = 1 candle

  // Call AI if: score changed (INSTANT) OR 5min passed
  if (!scoreChanged && timeSinceCall < MIN_INTERVAL_MS) {
    log(`-> AI throttled (score=${t.totalScore} unchanged, ${Math.round(timeSinceCall/1000)}s ago)`);
    return;
  }
  lastAICall[pairKey2]  = now_ai;
  lastAIScore[pairKey2] = t.totalScore;

  const session = getSession();

  // Fetch win rate + last trades for AI context
  let winRateContext = 'No data yet';
  let lastTradesContext = 'No recent trades';
  try {
    const wrRows = await dbSelect('win_rate', 'limit=1&order=updated_at.desc');
    if(wrRows && wrRows.length){
      const wr = wrRows[0];
      winRateContext = `Total: ${wr.total_trades} trades | Wins: ${wr.wins} | Losses: ${wr.losses} | Win Rate: ${wr.total_trades>0?Math.round(wr.wins/wr.total_trades*100):0}%`;
    }
    const lastTrades = await dbSelect('trades', 'order=created_at.desc&limit=5');
    if(lastTrades && lastTrades.length){
      lastTradesContext = lastTrades.map(tr => {
        const pnl = tr.pnl_pct != null ? (tr.pnl_pct > 0 ? `+${tr.pnl_pct.toFixed(2)}%` : `${tr.pnl_pct.toFixed(2)}%`) : 'open';
        return `${tr.pair} ${tr.signal} ${tr.status==='active'?'[ACTIVE]':tr.status==='win'?'WIN':'LOSS'} ${pnl}`;
      }).join(' | ');
    }
  } catch(e) {}

  // Last 10 candles OHLC for best pair (1H closed)
  const h1candles = candles[best.key]?.h1 || [];
  const last10 = h1candles.slice(-6);
  const ohlcContext = last10.length
    ? last10.map(c2 => `O:${c2.o.toFixed(best.dec)} H:${c2.h.toFixed(best.dec)} L:${c2.l.toFixed(best.dec)} C:${c2.c.toFixed(best.dec)} V:${c2.v||0}`).join(' | ')
    : 'N/A';

  // Daily candles context (last 5 days)
  const dailyCandles = candles[best.key]?.daily || [];
  const last5daily = dailyCandles.slice(-3);
  const dailyContext = last5daily.length
    ? last5daily.map(c2 => `O:${c2.o.toFixed(best.dec)} H:${c2.h.toFixed(best.dec)} L:${c2.l.toFixed(best.dec)} C:${c2.c.toFixed(best.dec)}`).join(' | ')
    : 'N/A';

  // Weekend gap detection
  const nowDay = new Date().getUTCDay();
  const isMonday = nowDay === 1;
  let gapContext = 'N/A';
  if (isMonday && last5daily.length >= 1 && last10.length >= 1) {
    const fridayClose = last5daily[last5daily.length - 1].c;
    const mondayOpen  = last10[last10.length - 1].o;
    const gapPct = ((mondayOpen - fridayClose) / fridayClose * 100).toFixed(3);
    const gapPips = Math.abs(mondayOpen - fridayClose).toFixed(best.dec);
    gapContext = `Friday close: ${fridayClose.toFixed(best.dec)} | Monday open: ${mondayOpen.toFixed(best.dec)} | Gap: ${parseFloat(gapPct) >= 0 ? '+' : ''}${gapPct}% (${gapPips} pts)`;
  }

  // Day of week context
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const dayContext = days[nowDay];

  const newsContext = calEvents.length
    ? calEvents.slice(0, 5).map(e => `${e.impact === 'High' ? '🔴' : e.impact === 'Medium' ? '🟡' : '🟢'} ${e.currency} ${e.title} @ ${new Date(e.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}`).join('\n')
    : 'No major news today';

  const prompt = `You are a senior forex trader with 15 years experience. You are the SOLE decision maker - think and decide like a real trader, not a mechanical system.

TRADING STYLE: Daily bias -> 1H confirmation -> 15m entry. Intraday: 30min-4h max. Tight SL on structure. Min RR 1.5.

SL/TP RULES (STRICT):
- SL: nearest 15m swing high/low (real structure, not fixed pips)
- TP1: ALWAYS at exactly 2× the SL distance (RR 1:2) - NO EXCEPTION
- TP2: 3× SL distance (RR 1:3)
- TP3: based on next major S/R level (RR 1:4 minimum)

SESSION: ${session} | DAY: ${dayContext}
PAIR: ${best.label} @ ${t.price.toFixed(best.dec)}
OTHER PAIRS: ${analyses.slice(1).map(p => `${p.label}(${p.tech.totalScore}/100 ${p.tech.trend4h})`).join(' | ')}

DXY: ${dxyData.price?`${dxyData.price.toFixed(3)} ${dxyData.trend} ${dxyData.change}%`:'N/A'}

LAST 5 DAILY CANDLES (oldest -> newest):
${dailyContext}
${isMonday ? `⚠️ MONDAY OPEN - Weekend gap: ${gapContext}` : ''}

LAST 6 CANDLES 1H: ${ohlcContext}

NEWS TODAY:
${newsContext}

DAILY BIAS (most important - long term direction):
Trend: ${t.trendDaily} | Structure: ${t.structDaily}
EMA20: ${t.ema20_daily||'N/A'} | EMA50: ${t.ema50_daily||'N/A'} | Price: ${t.price.toFixed(best.dec)}
-> ${t.trendDaily==='haussier'?'📈 Daily bullish - prefer BUY setups':t.trendDaily==='baissier'?'📉 Daily bearish - prefer SELL setups':'⚠️ Daily neutral - trade with caution'}

4H BIAS (intermediate):
Trend: ${t.trend4h} | Structure: ${t.struct4h}
EMA50: ${t.ema50_4h || 'N/A'}
Support: ${t.support4h} | Resistance: ${t.resistance4h}
-> ${t.trend4h===t.trendDaily?'✅ 4H aligned with Daily':'⚠️ 4H conflicts with Daily - be careful'}

SR CHANNELS (TradingView method — pivot clusters):
Resistances: ${t.srResistances.length ? t.srResistances.map(z => `${z.lo}-${z.hi}(s:${z.strength})`).join(' | ') : 'none'}
Supports:    ${t.srSupports.length ? t.srSupports.map(z => `${z.lo}-${z.hi}(s:${z.strength})`).join(' | ') : 'none'}
${t.nearSRZone ? `⚠️ Price INSIDE SR zone ${t.srInside?.[0]?.lo}-${t.srInside?.[0]?.hi} — caution, wait for breakout or rejection` : ''}
${t.closestRes ? `Next resistance: ${t.closestRes.lo}-${t.closestRes.hi}` : ''}
${t.closestSup ? `Next support: ${t.closestSup.lo}-${t.closestSup.hi}` : ''}

1H CONFIRMATION:
Structure: ${t.struct1h} | EMA20: ${t.ema20 || 'N/A'} | EMA50: ${t.ema50 || 'N/A'} | EMA200: ${t.ema200 || 'N/A'}
RSI(14): ${t.rsi || 'N/A'} ${parseFloat(t.rsi) < 35 ? '- OVERSOLD' : parseFloat(t.rsi) > 65 ? '- OVERBOUGHT' : ''}
Near support: ${t.nearSupport} | Near resistance: ${t.nearResistance}
Swing High: ${t.recentHigh} | Swing Low: ${t.recentLow}

15m ENTRY:
Structure: ${t.struct15m} | EMA9: ${t.ema9_15m || 'N/A'} | EMA21: ${t.ema21_15m || 'N/A'}
RSI 15m: ${t.rsi15m || 'N/A'} | BOS bull: ${t.bos15m_bull} | BOS bear: ${t.bos15m_bear}
EMA cross bull: ${t.emaCross15m_bull} | bear: ${t.emaCross15m_bear}
Entry zone: ${t.sr15mLow} -> ${t.sr15mHigh}

LIQUIDITY: PDH=${t.prevDayHigh||'N/A'} PDL=${t.prevDayLow||'N/A'} | NearPDH=${t.nearPDH} NearPDL=${t.nearPDL} | LiqBull=${t.liqBull} LiqBear=${t.liqBear}
ICT LIQUIDITY (LuxAlgo):
  Buyside  (buy stops above): ${t.buysideLiq  ? t.buysideLiq.level +' ('+t.buysideLiq.count+' equal highs)' : 'none'} ${t.nearBuyside  ? '⚡ Price near buyside liq!' : ''}
  Sellside (sell stops below): ${t.sellsideLiq ? t.sellsideLiq.level+' ('+t.sellsideLiq.count+' equal lows)'  : 'none'} ${t.nearSellside ? '⚡ Price near sellside liq!' : ''}

S/R levels: ${t.structuredLevels ? `SL=${t.structuredLevels.sl} TP1=${t.structuredLevels.tp1} TP2=${t.structuredLevels.tp2} TP3=${t.structuredLevels.tp3} (next: ${t.structuredLevels.nextLevels?.join(' → ')||'N/A'})` : 'calculate from structure'}

PRICE ACTION (15m + 1H):
  Bull patterns: ${t.pa_bull ? '✅ FULL setup' : t.pa_bull_partial ? '⚠️ Partial' : '❌ None'}
    → ${t.paBullLabel}
  Bear patterns: ${t.pa_bear ? '✅ FULL setup' : t.pa_bear_partial ? '⚠️ Partial' : '❌ None'}
    → ${t.paBearLabel}
  Details: Engulf Bull=${t.bullEngulf15m} Bear=${t.bearEngulf15m} | PinBar Bull=${t.pinBarBull15m} Bear=${t.pinBarBear15m}
  Rejection f S/R: Bull=${t.rejectionBullSR} Bear=${t.rejectionBearSR}
  Strong Close 30m: Bull=${t.strongCloseBull30m} Bear=${t.strongCloseBear30m}
  Doji: 15m=${t.doji15m} 30m=${t.doji30m} ${(t.doji15m||t.doji30m)?'⚠️ Indecision - avoid entry':''}
  Strong Close 1H: Bull=${t.strongCloseBull1h} Bear=${t.strongCloseBear1h}
  HH/HL=${t.hhll_bull} | LH/LL=${t.hhll_bear}

FIB: 38.2%=${t.fib382} 50%=${t.fib500} 61.8%=${t.fib618} 78.6%=${t.fib786}
  ${t.nearGoldenZone ? '🎯 GOLDEN ZONE 61.8-78.6%' : t.nearFibAny ? '📍 At fib level' : 'Not at fib level'}

Score: ${t.totalScore}/100 (S&R=${t.srScore} EMA=${t.emaScore} RSI=${t.rsiScore} PA=${t.ictScore})

--- ADVANCED FILTERS ---
ATR: ${t.atrLabel}

OB: Bull=${t.nearBullOB} Bear=${t.nearBearOB} ${t.nearBullOB?'✅ Bull OB':t.nearBearOB?'✅ Bear OB':'no OB'}

Candle Momentum 15m: ${t.candlesLabel} (${t.candlesCount}/3 strong)
-> ${t.candlesLevel === 'strong' ? '✅ Strong momentum - confirms entry' : t.candlesLevel === 'neutral' ? '⚠️ Neutral momentum - valid but be cautious' : '❌ Weak momentum - consider WAIT'}

Volume 1H (tick): ${t.volContext} | Last: ${t.lastVol||'N/A'} | Avg: ${t.avgVol||'N/A'} | Ratio: ${t.volRatio||'N/A'}x
-> ${t.volContext==='HIGH' ? '✅ High volume - strong move confirmation' : t.volContext==='LOW' ? '⚠️ Low volume - weak move, caution' : t.volContext==='NORMAL' ? '✅ Normal volume' : 'Volume data unavailable'}

YOUR JUDGMENT AS A TRADER - YOU ARE THE SOLE DECISION MAKER:
- You think like a professional trend-following trader
- The Daily/4H trend is your bible — NEVER trade against it
- You wait for the market to come to YOU (pullback to key level), then enter WITH the trend
- Key: trend aligned + price at level + PA pattern confirms + momentum present + RR >= 1.5
- WAIT is always better than a bad trade

CRITICAL RULES - NEVER BREAK THESE:

1. TREND RULE (most important):
- Daily trend haussier → BUY signals ONLY. Any SELL idea = WAIT.
- Daily trend baissier → SELL signals ONLY. Any BUY idea = WAIT.
- Daily neutre → follow 4H trend instead
- Trading against the trend = the biggest mistake in trading

2. PULLBACK ENTRY RULE:
- Wait for price to pull back to a key level (S/R, OB, Fibonacci 38-62%) THEN enter
- Market haussier pulling back to support → BUY entry ✅
- Market baissier pulling back to resistance → SELL entry ✅
- Never enter in the middle of a trend without a pullback — that is chasing

3. MOMENTUM RULE:
- Momentum weak (0/3 candles) = WAIT always, no exceptions
- Strong entry needs at least 1-2 candles confirming direction
- Doji present = indecision = WAIT

4. RSI RULE:
- RSI oversold (<35) + SELL = FORBIDDEN (possible bounce)
- RSI overbought (>65) + BUY = FORBIDDEN (possible drop)
- Exception: RSI crossing 65 downward → SELL valid
- Exception: RSI crossing 35 upward → BUY valid

5. ENTRY TIMING RULE:
- Price already moved 30+ pips from structure = LATE = WAIT
- Valid entry: price AT the level (S/R, OB, fib), not after the move
- Rejection candle AT level = best entry signal

6. PRICE ACTION CONFIRMATION:
- Best setups: Engulfing OR Pin Bar/Rejection OR Strong Close AT key level
- Fibonacci golden zone (61.8-78.6%) + PA pattern = highest probability
- No PA pattern = no entry, wait for confirmation candle

7. COHERENCE RULE:
- "no clear trigger" in analysis → WAIT
- Valid signal requires: (1) PA trigger on 15m/30m (2) SL on nearest structure (3) RR >= 1.5
- If you cannot identify all 3 clearly → WAIT

CONFIDENCE - YOUR OWN HONEST ASSESSMENT (0-95):
- 85-95: Trend clear + pullback to key level + PA pattern + momentum + fib confluence
- 70-84: Good setup, 1-2 elements missing but trend aligned
- 55-69: Moderate, borderline — be cautious
- 40-54: Weak — lean toward WAIT
- <40: WAIT

SL: nearest 15m/30m swing high (SELL) or swing low (BUY) — real structure, not fixed pips.
TPs: next key S/R levels in trend direction.

Reply ONLY in raw JSON no markdown:
{
  "signal": "BUY or SELL or WAIT",
  "confidence": 0-95, // YOUR OWN assessment: based on trend clarity + filter alignment + trigger strength + context. NOT derived from score. Ask yourself: how convinced am I this trade will work?
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
  "pa_detail": "Price Action pattern seen on 15m/1H one sentence + fib level if relevant",
  "analyse": "Full analysis: (1) 4H context (2) 1H setup (3) 15m trigger (4) trade plan"
}`;

  try {
    const res  = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKeyIndex++ % 2 === 0 ? GROQ_KEY : (GROQ_KEY2 || GROQ_KEY)}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });
    const data = await res.json();
    // Log Groq errors (rate limit, quota, etc.)
    if (data.error) { log(`[WARN] Groq API error: ${data.error.message}`); return; }
    if (!data.choices?.length) { log(`[WARN] Groq no choices: ${JSON.stringify(data).substring(0,150)}`); return; }
    const raw  = data.choices?.[0]?.message?.content || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    if (!clean) { log(`[WARN] Groq empty response`); return; }

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
      ? calcStructuredSLTP(candles[best.key].h1, candles[best.key].m15, candles[best.key].h4||[], t.price, isBuy, best.dec, t.atr1h)
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

    // [BLOCK] ATR HARD BLOCK — Gold exception (always volatile)
    if (!t.atrOk) {
      if (best.dec === 2) {
        // Gold — warning only, not hard block
        log(`[WARN] ATR élevé Gold [${best.label}]: ${t.atrLabel} - signal autorisé avec SL large`);
      } else {
        log(`[BLOCK] ATR hard block [${best.label}]: ${t.atrLabel} - signal annulé`);
        return;
      }
    }

    // [BLOCK] MOMENTUM WEAK = block signal (0/3 strong candles)
    if (t.candlesLevel === 'weak') {
      log(`[BLOCK] Momentum faible [${best.label}]: 0/3 bougies - signal annulé`);
      return;
    }

    // Trend alignment — logged only (AI already has rules in prompt)
    const signalDir = isBuy ? 'haussier' : 'baissier';
    if (t.trendDaily !== 'neutre' && signalDir !== t.trendDaily) {
      log(`[WARN] Contre trend [${best.label}]: AI=${r.signal} Daily=${t.trendDaily} — AI accepted despite trend`);
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

  } catch (e) {
    log(`[WARN] AI scan error: ${e.message}`);
  }
}

// --- Daily Briefing -----------------------------------------
async function sendDailyBriefing() {
  try {
    // Fetch calendar fresh
    await fetchCalendar();

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
-------------------
⏰ ${utcTime()}
📅 ${today.charAt(0).toUpperCase() + today.slice(1)}

🔴 <b>NEWS HIGH IMPACT (${highEvents.length}):</b>
${formatEvents(highEvents)}

🟡 <b>NEWS MEDIUM IMPACT (${mediumEvents.length}):</b>
${formatEvents(mediumEvents)}

-------------------
📊 <b>Impact sur le trading:</b>

🔴 HIGH IMPACT:
  -> Signal bloqué 15min avant + 30min après
  -> Spreads élargis - éviter entrées manuelles
  -> Volatilité forte possible

🟡 MEDIUM IMPACT:
  -> Prudence - surveiller prix avant entrée
  -> Pas de blocage automatique

-------------------
${impactSummary}

⏰ <b>Sessions actives aujourd'hui:</b>
  🏦 London: 09h00 -> 18h00 UTC
  🗽 New York: 14h00 -> 23h00 UTC
  🔥 Overlap: 15h00 -> 19h00 - meilleure liquidité

⚠️ Not financial advice
#DailyBriefing #FXSignalPro`;

    await sendTelegramMsg(msg);
    log(`[OK] Daily briefing sent`);
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

// --- Main Loop ----------------------------------------------
async function init() {
  log('[START] FX Signal Pro Bot starting...');
  await sendTelegramMsg(
`🤖 <b>FX Signal Pro Bot - ONLINE</b>
-------------------
✅ Bot démarré - scan actif 8h-21h UTC
📊 Paires: EUR/USD • GBP/USD • XAU/USD • USD/JPY
⏰ Sessions: London • NY • Overlap
-------------------
🔍 En attente de setup...
#FXSignalPro`
  ).catch(() => {});

  // Initial candle load
  await fetchAllCandles();
  await fetchPrices();
  await fetchCalendar();

  // On startup: check active trades - close stale ones where SL already hit
  try {
    const activeTrades = await dbSelect('trades', 'status=eq.active&order=created_at.desc');
    if (activeTrades && activeTrades.length > 0) {
      for (const trade of activeTrades) {
        // Check if SL already hit (price past SL level)
        const pairObj = PAIRS.find(p => p.label === trade.pair);
        const startupPrice = prices[pairObj?.key];
        if (startupPrice && trade.sl) {
          const isBuy = trade.signal === 'BUY';
          const slHit = isBuy ? startupPrice <= parseFloat(trade.sl) : startupPrice >= parseFloat(trade.sl);
          if (slHit) {
            await dbUpdate('trades', { id: trade.id }, {
              status: 'closed',
              sl_hit: true,
              closed_at: new Date().toISOString()
            });
            await updateWinRate(false);
            const dec = pairObj?.dec || 5;
            const fmt = v => parseFloat(v).toFixed(dec);
            const sig = trade.signal === 'BUY' ? '🟢 BUY' : '🔴 SELL';
            await sendTelegramMsg(
`🛑 <b>TRADE FERMÉ - SL TOUCHÉ</b> <i>(détecté au redémarrage)</i>
-------------------
⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(trade.entry)}</code>
🛑 SL: <code>${fmt(trade.sl)}</code> ❌
-------------------
💰 P&L: -1R
#SLHit #FXSignalPro`);
            log(`[SL] Stale trade closed on startup: ${trade.pair}`);
            continue;
          }
        }
        const pair = PAIRS.find(p => p.label === trade.pair);
        const dec = pair?.dec || 5;
        const fmt = v => parseFloat(v).toFixed(dec);
        const sig = trade.signal === 'BUY' ? '🟢 BUY' : '🔴 SELL';
        const price = prices[pair?.key] || trade.entry;
        const isBuy = trade.signal === 'BUY';
        const entry = parseFloat(trade.entry);
        const sl = parseFloat(trade.sl);
        const pnlR = sl ? ((isBuy ? price - entry : entry - price) / Math.abs(entry - sl)).toFixed(2) : '0';
        const pnlEmoji = parseFloat(pnlR) >= 0 ? '📈' : '📉';
        const elapsed = Math.round((Date.now() - new Date(trade.created_at).getTime()) / 60000);
        const msgId = await sendTelegramMsg(
`🤖 <b>BOT REDÉMARRÉ - TRADE ACTIF</b>
-------------------
⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(trade.entry)}</code> | Now: <code>${fmt(price)}</code>
${pnlEmoji} P&L: ${parseFloat(pnlR) >= 0 ? '+' : ''}${pnlR}R
🛑 SL: <code>${fmt(trade.sl)}</code>
🎯 TP1: <code>${fmt(trade.tp1)}</code> ${trade.tp1_hit ? '✅' : ''}
🎯 TP2: <code>${fmt(trade.tp2)}</code> ${trade.tp2_hit ? '✅' : ''}
🎯 TP3: <code>${fmt(trade.tp3)}</code> ${trade.tp3_hit ? '✅' : ''}
-------------------
⏳ Trade ouvert depuis ${elapsed} minutes
#TradeActif #FXSignalPro`);
        // Update tg_message_id with new message
        if (msgId) await dbUpdate('trades', { id: trade.id }, { tg_message_id: msgId });
        log(`[OK] Active trade resume sent: ${trade.pair}`);

        // Check if SL/TP already hit while bot was offline
        const currentPrice = prices[pair?.key] || parseFloat(trade.entry);
        const tradeIsBuy = trade.signal === 'BUY';
        const tradeSL = parseFloat(trade.sl);
        const tradeTP1 = parseFloat(trade.tp1);
        const slAlreadyHit = tradeSL > 0 && ((tradeIsBuy && currentPrice <= tradeSL) || (!tradeIsBuy && currentPrice >= tradeSL));
        const tp1AlreadyHit = tradeTP1 > 0 && ((tradeIsBuy && currentPrice >= tradeTP1) || (!tradeIsBuy && currentPrice <= tradeTP1));

        if (slAlreadyHit && !trade.sl_hit) {
          await dbUpdate('trades', { id: trade.id }, {
            sl_hit: true, status: 'closed',
            closed_at: new Date().toISOString()
          });
          await updateWinRate(false, trade.user_entered);
          await sendTelegramMsg(
`🛑 <b>SL TOUCHÉ (détecté au redémarrage)</b>
-------------------
⏰ ${utcTime()}
${sig} ${trade.pair}
📌 Entry: <code>${fmt(trade.entry)}</code>
🛑 SL: <code>${fmt(trade.sl)}</code> ❌
-------------------
💰 P&L: -1R
#SLHit #FXSignalPro`, msgId);
          log(`[OK] SL hit detected on startup: ${trade.pair}`);
        } else if (tp1AlreadyHit && !trade.tp1_hit) {
          await dbUpdate('trades', { id: trade.id }, {
            tp1_hit: true, sl: parseFloat(trade.entry)
          });
          await sendTelegramMsg(
`🎯 <b>TP1 ATTEINT (détecté au redémarrage)</b>
-------------------
⏰ ${utcTime()}
${sig} ${trade.pair}
🎯 TP1: <code>${fmt(trade.tp1)}</code> ✅
🔄 SL déplacé à BE
#TP1Hit #FXSignalPro`, msgId);
          log(`[OK] TP1 hit detected on startup: ${trade.pair}`);
        }
      }
    }
  } catch(e) {
    log(`[WARN] Active trade resume: ${e.message}`);
  }

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

  log('[OK] Bot running - waiting for signals...');
}

// Keep-alive server for Railway/Render
import { createServer } from 'http';
createServer(async (req, res) => {
  const url = req.url?.split('?')[0];
  if (url === '/weekly') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Sending weekly report...');
    await sendWeeklyReport();
  } else if (url === '/eod') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Sending EOD summary...');
    await sendEndOfDaySummary();
  } else if (url === '/briefing') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Sending daily briefing...');
    await sendDailyBriefing();
  } else {
    res.writeHead(200);
    res.end('FX Signal Pro Bot - Running ✅');
  }
}).listen(process.env.PORT || 3000);

init().catch(e => {
  log(`[ERR] Fatal error: ${e.message}`);
  process.exit(1);
});
