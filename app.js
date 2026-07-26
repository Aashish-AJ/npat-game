const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CATS = ['name','place','animal','thing'];
const CAT_LABELS = {name:'Name', place:'Place', animal:'Animal', thing:'Thing'};
const CAT_HINTS = {
  name:'a real person\u2019s first name',
  place:'a real city, country, or landmark',
  animal:'a real animal species',
  thing:'a real object'
};

const app = {
  screen:'landing',
  tab:'create',
  playerId:null,
  playerName:'',
  roomCode:null,
  isAdmin:false,
  room:null,
  players:[],
  roundResultsData:null,
  lastRenderedStatus:null,
  lastRenderedRound:null,
  pollTimer:null,
  timerInterval:null,
  busy:false,
  saveTimer:null,
  errorMsg:null
};

// ---------- db helpers ----------
async function fetchRoom(code){
  const { data, error } = await sb.from('rooms').select('*').eq('code', code).maybeSingle();
  if(error) return null;
  return data;
}
async function insertRoom(row){
  const { data, error } = await sb.from('rooms').insert(row).select().maybeSingle();
  if(error) return null;
  return data;
}
async function updateRoom(code, patch){
  const { data, error } = await sb.from('rooms').update(patch).eq('code', code).select().maybeSingle();
  if(error) return null;
  return data;
}
// Only writes if the row STILL matches `conditions` at the moment Postgres
// executes the update. If another browser already changed the row first,
// this returns null instead of overwriting their result -- this is what
// prevents two browsers from both "winning" a round transition at once.
async function conditionalUpdateRoom(code, conditions, patch){
  let q = sb.from('rooms').update(patch).eq('code', code);
  for(const [k,v] of Object.entries(conditions)) q = q.eq(k, v);
  const { data, error } = await q.select().maybeSingle();
  if(error) return null;
  return data;
}
async function fetchPlayers(code){
  const { data, error } = await sb.from('players').select('*').eq('room_code', code).order('joined_at');
  return error ? [] : (data || []);
}
async function insertPlayer(row){
  const { error } = await sb.from('players').insert(row);
  return !error;
}
async function updatePlayerScore(code, pid, newScore){
  const { error } = await sb.from('players').update({ score: newScore }).eq('room_code', code).eq('id', pid);
  return !error;
}
async function fetchAnswers(code, round){
  const { data, error } = await sb.from('answers').select('*').eq('room_code', code).eq('round_num', round);
  return error ? [] : (data || []);
}
async function upsertAnswer(row){
  const { error } = await sb.from('answers').upsert(row, { onConflict: 'room_code,round_num,player_id' });
  return !error;
}
async function fetchRoundResult(code, round){
  const { data, error } = await sb.from('round_results').select('*').eq('room_code', code).eq('round_num', round).maybeSingle();
  return error ? null : data;
}
async function insertRoundResult(row){
  const { error } = await sb.from('round_results').upsert(row, { onConflict: 'room_code,round_num' });
  return !error;
}
// pairs: [{category, word}] (word already lowercase/trimmed)
// returns a map "category|word" -> valid, only for pairs already judged before
async function fetchCachedWords(pairs){
  if(pairs.length===0) return {};
  const words = [...new Set(pairs.map(p=>p.word))];
  const { data, error } = await sb.from('word_cache').select('*').in('word', words);
  if(error || !data) return {};
  const map = {};
  data.forEach(row=>{ map[`${row.category}|${row.word}`] = row.valid; });
  return map;
}
// entries: [{category, word, valid}] -- saved so future rounds (any room)
// never need to ask the AI about these again.
async function cacheWords(entries){
  if(entries.length===0) return;
  const rows = entries.map(e=>({ category:e.category, word:e.word, valid:e.valid, checked_at:new Date().toISOString() }));
  await sb.from('word_cache').upsert(rows, { onConflict:'category,word' });
}

// ---------- misc helpers ----------
function genId(){
  return 'p_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
}
function genRoomCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c=''; for(let i=0;i<5;i++) c+=chars[Math.floor(Math.random()*chars.length)];
  return c;
}
function pickRandomLetter(used){
  const all = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(l=>!(used||[]).includes(l));
  if(all.length===0) return null;
  return all[Math.floor(Math.random()*all.length)];
}
function formatTime(ms){
  const s = Math.max(0, Math.ceil(ms/1000));
  const m = Math.floor(s/60);
  const sec = s%60;
  return `${m}:${sec.toString().padStart(2,'0')}`;
}
function esc(s){
  return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function myJitterMs(){
  let h = 0;
  for(const c of app.playerId) h = (h*31 + c.charCodeAt(0)) >>> 0;
  return h % 1200;
}

// ---------- root actions ----------
async function createRoom(){
  const name = document.getElementById('c-name').value.trim().slice(0,20);
  const rounds = parseInt(document.getElementById('c-rounds').value, 10);
  const duration = parseInt(document.getElementById('c-duration').value, 10);
  if(!name){ setError('Enter your name first.'); return; }
  setError(null);
  let code, existing;
  for(let i=0;i<5;i++){
    code = genRoomCode();
    existing = await fetchRoom(code);
    if(!existing) break;
  }
  const pid = genId();
  const room = await insertRoom({
    code, admin_id: pid, status:'lobby',
    total_rounds: rounds, round_duration: duration,
    current_round:0, used_letters:[], current_letter:null, round_end_time:null
  });
  if(!room){ setError('Could not create room. Check your Supabase setup / connection.'); return; }
  await insertPlayer({ id: pid, room_code: code, name, score:0 });
  app.playerId=pid; app.playerName=name; app.roomCode=code; app.isAdmin=true;
  enterRoom();
}

async function joinRoom(){
  const name = document.getElementById('j-name').value.trim().slice(0,20);
  const code = document.getElementById('j-code').value.trim().toUpperCase();
  if(!name){ setError('Enter your name first.'); return; }
  if(!code){ setError('Enter a room code.'); return; }
  setError(null);
  const room = await fetchRoom(code);
  if(!room){ setError('No room found with that code.'); return; }
  if(room.status!=='lobby'){ setError('That game has already started.'); return; }
  const pid = genId();
  const ok = await insertPlayer({ id: pid, room_code: code, name, score:0 });
  if(!ok){ setError('Could not join room.'); return; }
  app.playerId=pid; app.playerName=name; app.roomCode=code; app.isAdmin=(room.admin_id===pid);
  enterRoom();
}

function setError(msg){
  app.errorMsg = msg;
  render();
}

function enterRoom(){
  app.lastRenderedStatus = null;
  app.lastRenderedRound = null;
  app.roundResultsData = null;
  render();
  startPolling();
}

function startPolling(){
  if(app.pollTimer) clearInterval(app.pollTimer);
  pollOnce();
  app.pollTimer = setInterval(pollOnce, 2000);
}

async function pollOnce(){
  if(!app.roomCode) return;
  const room = await fetchRoom(app.roomCode);
  if(!room) return;
  app.room = room;
  app.players = await fetchPlayers(app.roomCode);

  gameTick(room);

  const statusChanged = room.status !== app.lastRenderedStatus;
  const roundChanged = room.status==='roundResults' && room.current_round !== app.lastRenderedRound;
  const lobbyLive = room.status==='lobby';

  if(statusChanged || roundChanged || lobbyLive){
    app.lastRenderedStatus = room.status;
    app.lastRenderedRound = room.current_round;
    if(room.status==='roundResults'){
      app.roundResultsData = await fetchRoundResult(app.roomCode, room.current_round);
    }
    render();
  }
  if(room.status==='playing'){
    updateAnsweringCount();
  }
}

// ---------- admin actions ----------
async function adminStartGame(){
  const latest = await fetchRoom(app.roomCode);
  const letter = pickRandomLetter(latest.used_letters);
  const usedLetters = [...(latest.used_letters||[]), letter];
  const roundEndTime = new Date(Date.now() + latest.round_duration*1000).toISOString();
  const updated = await conditionalUpdateRoom(app.roomCode, { status:'lobby' }, {
    used_letters: usedLetters,
    current_letter: letter,
    current_round: 1,
    round_end_time: roundEndTime,
    status: 'playing'
  });
  // If null, someone else (e.g. a double-tap) already started it -- just
  // pick up whatever is actually in the database rather than guessing.
  app.room = updated || await fetchRoom(app.roomCode);
  app.lastRenderedStatus = app.room.status;
  render();
}

async function adminNextRound(){
  await tryAdvanceRound();
}

// Moves the room from 'roundResults' to the next round (or 'finished').
// Uses a conditional update so that if two browsers call this at nearly
// the same moment, only the first one's write actually takes effect --
// the second is rejected by the database instead of silently overwriting
// it with a different random letter.
async function tryAdvanceRound(){
  const latest = await fetchRoom(app.roomCode);
  if(!latest || latest.status!=='roundResults') return;
  const expectedRound = latest.current_round;
  let patch;
  if(latest.current_round >= latest.total_rounds){
    patch = { status:'finished' };
  }else{
    const letter = pickRandomLetter(latest.used_letters);
    const usedLetters = [...(latest.used_letters||[]), letter];
    const roundEndTime = new Date(Date.now() + latest.round_duration*1000).toISOString();
    patch = {
      used_letters: usedLetters,
      current_letter: letter,
      current_round: latest.current_round + 1,
      round_end_time: roundEndTime,
      status: 'playing'
    };
  }
  const updated = await conditionalUpdateRoom(
    app.roomCode,
    { status:'roundResults', current_round: expectedRound },
    patch
  );
  // If updated is null, someone else already advanced this round first --
  // that's fine, we just show whatever they set instead of double-writing.
  app.room = updated || await fetchRoom(app.roomCode);
  app.players = await fetchPlayers(app.roomCode);
  app.lastRenderedStatus = app.room.status;
  app.lastRenderedRound = app.room.current_round;
  render();
}

// Runs on EVERY connected player's browser (not just the admin's), so the
// game keeps moving even if the admin's tab closes mid-game.
async function gameTick(roomRow){
  if(roomRow.status==='playing' && roomRow.round_end_time && Date.now() >= new Date(roomRow.round_end_time).getTime() && !app.busy){
    app.busy = true;
    setTimeout(async ()=>{
      try{
        const claimed = await conditionalUpdateRoom(
          app.roomCode,
          { status:'playing', current_round: roomRow.current_round },
          { status:'judging', judging_by: app.playerId, judging_claimed_at: new Date().toISOString() }
        );
        if(claimed && claimed.judging_by===app.playerId){
          app.room = claimed;
          if(app.lastRenderedStatus!=='judging'){ app.lastRenderedStatus='judging'; render(); }
          await performJudging(claimed);
        }
      } finally { app.busy = false; }
    }, myJitterMs());
    return;
  }
  if(roomRow.status==='judging' && roomRow.judging_claimed_at && Date.now()-new Date(roomRow.judging_claimed_at).getTime()>15000 && !app.busy){
    app.busy = true;
    setTimeout(async ()=>{
      try{
        const claimed = await conditionalUpdateRoom(
          app.roomCode,
          { status:'judging', judging_claimed_at: roomRow.judging_claimed_at },
          { judging_by: app.playerId, judging_claimed_at: new Date().toISOString() }
        );
        if(claimed && claimed.judging_by===app.playerId){
          await performJudging(claimed);
        }
      } finally { app.busy = false; }
    }, myJitterMs());
    return;
  }
  if(roomRow.status==='roundResults' && !app.isAdmin && !app.busy){
    const resultsAt = roomRow.results_at ? new Date(roomRow.results_at).getTime() : 0;
    if(Date.now()-resultsAt > 20000){
      app.busy = true;
      setTimeout(async ()=>{
        try{ await tryAdvanceRound(); } finally { app.busy = false; }
      }, myJitterMs());
    }
  }
}

function buildJudgeItems(letter, players, answersByPid){
  const prelim = {};
  const items = [];
  for(const p of players){
    const a = answersByPid[p.id] || {};
    prelim[p.id] = {};
    for(const cat of CATS){
      const val = (a[cat]||'').trim();
      const prefixOk = val.length>0 && letter && val[0].toUpperCase()===letter;
      prelim[p.id][cat] = { text: val, prefixOk, valid:false, points:0 };
      if(prefixOk) items.push({ id:`${p.id}|${cat}`, category:cat, answer:val });
    }
  }
  return { prelim, items };
}

async function performJudging(roomRow){
  const code = app.roomCode;
  const roundNum = roomRow.current_round;
  const letter = roomRow.current_letter;

  const players = await fetchPlayers(code);
  const answersRows = await fetchAnswers(code, roundNum);
  const answersByPid = {};
  answersRows.forEach(r=>{ answersByPid[r.player_id] = r; });

  const { prelim, items } = buildJudgeItems(letter, players, answersByPid);

  // Check the shared cache first -- words already judged before (in any
  // room, any game) don't need to be sent to the AI again.
  const cachePairs = items.map(it=>({ category: it.category, word: it.answer.trim().toLowerCase() }));
  const cacheMap = await fetchCachedWords(cachePairs);

  let validitySet = new Set();
  const toAsk = [];
  items.forEach(it=>{
    const key = `${it.category}|${it.answer.trim().toLowerCase()}`;
    if(Object.prototype.hasOwnProperty.call(cacheMap, key)){
      if(cacheMap[key]) validitySet.add(it.id);
    }else{
      toAsk.push(it);
    }
  });

  const newlyJudged = [];
  if(toAsk.length>0){
    try{
      const { data, error } = await sb.functions.invoke('smooth-function', { body: { letter, items: toAsk } });
      if(!error && data && Array.isArray(data.results)){
        const resultMap = {};
        data.results.forEach(o=>{ if(o) resultMap[o.id] = !!o.valid; });
        toAsk.forEach(it=>{
          const valid = !!resultMap[it.id];
          if(valid) validitySet.add(it.id);
          newlyJudged.push({ category: it.category, word: it.answer.trim().toLowerCase(), valid });
        });
      }else{
        // Edge function unreachable/misconfigured: fall back to accepting
        // anything that at least starts with the right letter, so the
        // game doesn't stall. Not cached, since we're not actually sure.
        toAsk.forEach(it=>validitySet.add(it.id));
      }
    }catch(e){
      toAsk.forEach(it=>validitySet.add(it.id));
    }
  }
  if(newlyJudged.length>0){
    await cacheWords(newlyJudged);
  }

  for(const cat of CATS){
    const groups = {};
    for(const p of players){
      const info = prelim[p.id][cat];
      const id = `${p.id}|${cat}`;
      info.valid = info.prefixOk && validitySet.has(id);
      if(info.valid){
        const norm = info.text.toLowerCase();
        (groups[norm] = groups[norm] || []).push(p.id);
      }
    }
    Object.values(groups).forEach(pids=>{
      const pts = Math.floor(10/pids.length);
      pids.forEach(pid=>{ prelim[pid][cat].points = pts; });
    });
  }

  const judged = {};
  for(const p of players){
    let total = 0;
    const catRes = {};
    CATS.forEach(cat=>{ catRes[cat] = prelim[p.id][cat]; total += prelim[p.id][cat].points; });
    judged[p.id] = { ...catRes, roundTotal: total };
  }

  await insertRoundResult({ room_code: code, round_num: roundNum, letter, judged });

  for(const p of players){
    const newScore = (p.score||0) + (judged[p.id] ? judged[p.id].roundTotal : 0);
    await updatePlayerScore(code, p.id, newScore);
  }

  await updateRoom(code, { status:'roundResults', results_at: new Date().toISOString() });

  app.room = await fetchRoom(code);
  app.players = await fetchPlayers(code);
  app.roundResultsData = await fetchRoundResult(code, roundNum);
  app.lastRenderedStatus = 'roundResults';
  app.lastRenderedRound = app.room.current_round;
  render();
}

// Spins through random letters, gradually slowing down, then lands on the
// real letter and unlocks the answer fields. Purely cosmetic -- the actual
// letter was already decided and saved before this ever runs.
function runLetterReveal(finalLetter){
  const el = document.getElementById('letter-circle');
  if(!el){ return; }
  const pool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const totalTicks = 16;
  let count = 0;
  function tick(){
    if(count < totalTicks){
      let r;
      do{ r = pool[Math.floor(Math.random()*pool.length)]; }while(r===finalLetter && count<totalTicks-1);
      el.textContent = r;
      count++;
      const delay = 60 + count*10; // gradually slows down
      setTimeout(tick, delay);
    }else{
      el.textContent = finalLetter;
      el.classList.remove('rolling');
      el.classList.add('landed');
      ['inp-name','inp-place','inp-animal','inp-thing'].forEach(id=>{
        const input = document.getElementById(id);
        if(input) input.disabled = false;
      });
    }
  }
  tick();
}

// ---------- player answer autosave ----------
function onAnswerInput(){
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(saveMyAnswers, 600);
}
async function saveMyAnswers(){
  if(!app.room || app.room.status!=='playing') return;
  const row = {
    room_code: app.roomCode,
    round_num: app.room.current_round,
    player_id: app.playerId,
    name: (document.getElementById('inp-name')||{}).value || '',
    place: (document.getElementById('inp-place')||{}).value || '',
    animal: (document.getElementById('inp-animal')||{}).value || '',
    thing: (document.getElementById('inp-thing')||{}).value || ''
  };
  await upsertAnswer(row);
}
async function updateAnsweringCount(){
  if(!app.room) return;
  const rows = await fetchAnswers(app.roomCode, app.room.current_round);
  const el = document.getElementById('answering-count');
  if(el) el.textContent = `${rows.length} / ${app.players.length} players answering`;
}

function startPlayTimer(){
  if(app.timerInterval) clearInterval(app.timerInterval);
  app.timerInterval = setInterval(()=>{
    if(!app.room || app.room.status!=='playing') return;
    const remain = new Date(app.room.round_end_time).getTime() - Date.now();
    const el = document.getElementById('countdown');
    if(el){
      el.textContent = formatTime(remain);
      el.className = remain<10000 ? 'low' : '';
    }
    if(remain<=0){
      ['inp-name','inp-place','inp-animal','inp-thing'].forEach(id=>{
        const e = document.getElementById(id);
        if(e && !e.disabled) e.disabled = true;
      });
      const status = document.getElementById('play-status');
      if(status) status.textContent = "Time's up! Waiting for results...";
    }
  }, 400);
}

function copyRoomCode(){
  if(navigator.clipboard) navigator.clipboard.writeText(app.roomCode).catch(()=>{});
}

// ---------- render ----------
function render(){
  const root = document.getElementById('root');
  if(!app.roomCode){ root.innerHTML = renderLanding(); return; }
  if(!app.room){ root.innerHTML = `<div class="sheet center">Loading room...</div>`; return; }
  switch(app.room.status){
    case 'lobby': root.innerHTML = renderLobby(); break;
    case 'playing': root.innerHTML = renderPlaying(); startPlayTimer(); runLetterReveal(app.room.current_letter); break;
    case 'judging': root.innerHTML = renderJudging(); break;
    case 'roundResults': root.innerHTML = renderResults(); break;
    case 'finished': root.innerHTML = renderFinal(); break;
    default: root.innerHTML = `<div class="sheet center">...</div>`;
  }
}

function renderLanding(){
  const err = app.errorMsg ? `<div class="error-box">${esc(app.errorMsg)}</div>` : '';
  const createTab = app.tab==='create';
  return `
    <div class="sheet"><div class="sheet-inner">
      <div class="tabs">
        <div class="tab ${createTab?'active':''}" onclick="app.tab='create'; render();">Create Room</div>
        <div class="tab ${!createTab?'active':''}" onclick="app.tab='join'; render();">Join Room</div>
      </div>
      ${err}
      ${createTab ? `
        <label>Your name</label>
        <input type="text" id="c-name" maxlength="20" placeholder="e.g. Priya">
        <div class="settings-row">
          <div>
            <label>Number of rounds</label>
            <select id="c-rounds">
              ${[3,5,7,10].map(n=>`<option value="${n}" ${n===5?'selected':''}>${n} rounds</option>`).join('')}
            </select>
          </div>
          <div>
            <label>Time per round</label>
            <select id="c-duration">
              <option value="30">30 sec</option>
              <option value="45">45 sec</option>
              <option value="60" selected>60 sec</option>
              <option value="90">90 sec</option>
              <option value="120">120 sec</option>
            </select>
          </div>
        </div>
        <button class="btn full" onclick="createRoom()">Create Room</button>
      ` : `
        <label>Your name</label>
        <input type="text" id="j-name" maxlength="20" placeholder="e.g. Priya">
        <label>Room code</label>
        <input type="text" id="j-code" maxlength="5" placeholder="e.g. K7QXP" style="text-transform:uppercase; letter-spacing:3px; font-family:'Space Mono',monospace;">
        <button class="btn secondary full" onclick="joinRoom()">Join Room</button>
      `}
      <hr class="divider">
      <p class="small-muted"><strong>How scoring works:</strong> each round you get a letter and fill in a Name, Place, Animal and Thing starting with it. Each valid, unique answer is worth 10 points. If other players write the same valid answer, those 10 points get split between you. Blank or made-up answers score 0.</p>
    </div></div>
    <p class="footer-note">Anyone with the room code can join and see the game. No account or login needed.</p>
  `;
}

function renderLobby(){
  const r = app.room;
  const players = [...app.players].sort((a,b)=> new Date(a.joined_at)-new Date(b.joined_at));
  const list = players.map(p=>`
    <li>
      <span>${esc(p.name)} ${p.id===r.admin_id?'<span class="badge">ADMIN</span>':''} ${p.id===app.playerId?'<span class="badge" style="background:var(--blue);color:#fff;">YOU</span>':''}</span>
      <span class="score-pill">0 pts</span>
    </li>`).join('');
  const canStart = players.length >= 1;
  return `
    <div class="sheet"><div class="sheet-inner">
      <h2 class="section-title">Room Lobby</h2>
      <div class="room-code-display" onclick="copyRoomCode()">${r.code}</div>
      <p class="code-hint">Tap the code to copy &middot; share it with friends to join</p>
      <p class="small-muted">${r.total_rounds} rounds &middot; ${r.round_duration}s per round</p>
      <hr class="divider">
      <label>Players (${players.length})</label>
      <ul class="player-list">${list}</ul>
      ${app.isAdmin ? `
        <button class="btn full" ${canStart?'':'disabled'} onclick="adminStartGame()">Start Game</button>
        ${players.length<2 ? '<p class="small-muted center" style="margin-top:8px;">You can start solo to try it out, but this plays best with friends.</p>' : ''}
      ` : `<p class="small-muted center">Waiting for the admin to start the game...</p>`}
    </div></div>
  `;
}

function renderPlaying(){
  const r = app.room;
  const letter = r.current_letter;
  return `
    <div class="sheet"><div class="sheet-inner">
      <div class="round-meta">Round ${r.current_round} of ${r.total_rounds}</div>
      <div class="letter-stage"><div class="letter-circle rolling" id="letter-circle"></div></div>
      <span id="countdown">${formatTime(new Date(r.round_end_time)-Date.now())}</span>
      <span id="answering-count">0 / ${app.players.length} players answering</span>
      ${CATS.map(cat=>`
        <div class="field-card">
          <label>${CAT_LABELS[cat]}</label>
          <input type="text" id="inp-${cat}" maxlength="40" placeholder="${letter}... (${CAT_HINTS[cat]})" oninput="onAnswerInput()" disabled>
        </div>
      `).join('')}
      <div id="play-status"></div>
    </div></div>
  `;
}

function renderJudging(){
  return `
    <div class="sheet"><div class="sheet-inner">
      <div class="spinner-wrap">
        <div class="spinner"></div>
        <p><strong>Checking everyone's answers...</strong></p>
        <p class="small-muted">Making sure each one is real and starts with the right letter.</p>
      </div>
    </div></div>
  `;
}

function renderResults(){
  const r = app.room;
  const roundNum = r.current_round;
  const judged = app.roundResultsData ? app.roundResultsData.judged : null;
  const players = [...app.players].sort((a,b)=> new Date(a.joined_at)-new Date(b.joined_at));

  const rows = players.map(p=>{
    const j = judged ? judged[p.id] : null;
    const cells = CATS.map(cat=>{
      if(!j) return '<td>-</td>';
      const info = j[cat];
      const cls = info.valid ? 'ans-valid' : 'ans-invalid';
      const text = info.text ? esc(info.text) : '<span class="small-muted">(blank)</span>';
      return `<td><span class="${cls}">${text}</span><span class="pts">${info.points} pts</span></td>`;
    }).join('');
    const total = j ? j.roundTotal : 0;
    return `<tr><td class="player-name-cell">${esc(p.name)}</td>${cells}<td class="total-cell">${total}</td><td class="total-cell">${p.score||0}</td></tr>`;
  }).join('');

  const isLast = r.current_round >= r.total_rounds;

  return `
    <div class="sheet"><div class="sheet-inner">
      <h2 class="section-title">Round ${roundNum} Results &mdash; Letter "${app.roundResultsData ? app.roundResultsData.letter : ''}"</h2>
      <div style="overflow-x:auto;">
        <table class="results-table">
          <thead><tr>
            <th>Player</th>
            ${CATS.map(c=>`<th>${CAT_LABELS[c]}</th>`).join('')}
            <th>Round</th><th>Total</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${app.isAdmin ? `
        <button class="btn full" onclick="adminNextRound()">${isLast ? 'See Final Results' : 'Start Next Round'}</button>
      ` : `<p class="small-muted center">Waiting for the admin to continue... (the game moves on by itself if they've gone quiet)</p>`}
    </div></div>
  `;
}

function renderFinal(){
  const players = [...app.players].sort((a,b)=> (b.score||0)-(a.score||0) || a.name.localeCompare(b.name));
  const items = players.map((p,i)=>`
    <li class="${i===0?'rank-1':''}">
      <span class="rank-num">${i+1}</span>
      <span class="lb-name">${esc(p.name)}${p.id===app.playerId?' (you)':''}</span>
      <span class="lb-score">${p.score||0}</span>
    </li>`).join('');
  return `
    <div class="sheet"><div class="sheet-inner">
      <h2 class="section-title">Final Scoreboard</h2>
      <ul class="leaderboard">${items}</ul>
      <button class="btn gold full" onclick="location.reload()">Play a New Game</button>
    </div></div>
  `;
}

render();
