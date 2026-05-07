require('dotenv').config();
const chokidar  = require('chokidar');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const simpleGit = require('simple-git');

const PRINTS_DIR = path.join(__dirname, 'prints');
const DATA_FILE  = path.join(__dirname, 'data.json');
const git        = simpleGit(__dirname);

if (!fs.existsSync(PRINTS_DIR)) fs.mkdirSync(PRINTS_DIR);

const KNOWN_NICKS = ["Cq", "DU", "Flavinho", "Will", "Chavera", "Dukka", "Fluyr", "Chara"];

// ── Fila de processamento (evita push simultâneo) ──
let queue       = [];
let isRunning   = false;

async function enqueue(task) {
  queue.push(task);
  if (!isRunning) processQueue();
}

async function processQueue() {
  if (queue.length === 0) { isRunning = false; return; }
  isRunning = true;
  const task = queue.shift();
  await task();
  processQueue();
}

// ── Gemini Vision ──
function geminiVision(base64Image, mimeType, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Image } }
      ]}],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096, responseMimeType: "application/json" }
    });

    const apiKey = process.env.GEMINI_API_KEY;
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.candidates?.[0]?.content?.parts?.[0]?.text || '');
        } catch (e) { reject(new Error('Erro ao parsear resposta do Gemini')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Extrai dados do scoreboard ──
async function extractMatchFromImage(imgPath) {
  const base64   = fs.readFileSync(imgPath).toString('base64');
  const ext      = path.extname(imgPath).replace('.', '').toLowerCase();
  const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

  const prompt = `Você é um extrator de dados de scoreboards do CS2 e GamersClub.
Analise esta imagem e retorne SOMENTE um JSON válido (sem markdown).
Extraia APENAS jogadores desta lista: ${KNOWN_NICKS.join(', ')} (case-insensitive).
Use nick exato da lista. Se não aparecer na imagem, não inclua.

{
  "map": "nome_em_minusculas",
  "result": "win ou loss ou draw",
  "score": "13-7",
  "date": "YYYY-MM-DD",
  "players": {
    "NickDaLista": { "kills":0,"deaths":0,"assists":0,"kdr":0.0,"adr":0.0,"kast":0,"hs":0,"mk":0,"fk":0,"fa":0,"diff":0,"rating":0.0 }
  }
}
result = "win" se o time dos jogadores da lista ganhou, "loss" se perdeu.
date = data visível ou hoje. Retorne APENAS o JSON.`;

  const raw = await geminiVision(base64, mimeType, prompt);
  return JSON.parse(raw.replace(/```json\\n?/g,'').replace(/```\\n?/g,'').trim());
}

// ── Recalcula médias ──
function recalcPlayerStats(players, history) {
  const statsMap = {};
  for (const match of history) {
    if (!match.players) continue;
    for (const [nick, s] of Object.entries(match.players)) {
      if (!statsMap[nick]) statsMap[nick] = {
        kills:[],deaths:[],assists:[],kdr:[],adr:[],kast:[],hs:[],mk:[],fk:[],fa:[],diff:[],rating:[],matches:0
      };
      statsMap[nick].kills.push(s.kills||0);
      statsMap[nick].deaths.push(s.deaths||0);
      statsMap[nick].assists.push(s.assists||0);
      statsMap[nick].kdr.push(s.kdr||s.kd||0);
      statsMap[nick].adr.push(s.adr||0);
      statsMap[nick].kast.push(s.kast||0);
      statsMap[nick].hs.push(s.hs||0);
      statsMap[nick].mk.push(s.mk||0);
      statsMap[nick].fk.push(s.fk||0);
      statsMap[nick].fa.push(s.fa||0);
      statsMap[nick].diff.push(s.diff||0);
      statsMap[nick].rating.push(s.rating||0);
      statsMap[nick].matches++;
    }
  }
  const avg = arr => arr.length ? parseFloat((arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2)) : 0;
  const sum = arr => arr.reduce((a,b)=>a+b,0);
  return players.map(p => {
    const s = statsMap[p.playerNick];
    if (!s||s.matches===0) return { ...p, matches:0, stats:{} };
    return { ...p, matches:s.matches, stats:{
      KDR:avg(s.kdr), ADR:avg(s.adr), HS:avg(s.hs), KAST:avg(s.kast),
      kills:avg(s.kills), assists:avg(s.assists),
      MK:sum(s.mk), FK:sum(s.fk), FA:sum(s.fa), DIFF:avg(s.diff), rating:avg(s.rating),
      wins:  history.filter(m=>(m.result==='win' ||m.result==='W')&&m.players?.[p.playerNick]).length,
      losses:history.filter(m=>(m.result==='loss'||m.result==='L')&&m.players?.[p.playerNick]).length,
    }};
  });
}

// ── Lê e salva data.json ──
function readData() {
  if (!fs.existsSync(DATA_FILE)) return { players:[], history:[] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch { return { players:[], history:[] }; }
}
function saveData(data) {
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2),'utf8');
}

// ── Git: pull + add + commit + push ──
async function gitSync(files, message) {
  try {
    await git.pull('origin','main',{'--rebase':'true'});
  } catch(e) { console.warn('⚠️  git pull warning:', e.message); }
  try {
    await git.add(files);
    await git.commit(message);
    await git.push('origin','main');
    console.log('✅ Push para o GitHub feito com sucesso!');
  } catch (err) {
    console.error('❌ Erro no git push:', err.message);
  }
}

// ── Processa print nova ──
async function processImage(imgPath) {
  const imgName = path.basename(imgPath);
  console.log(`\\n📸 Nova print: ${imgName}`);
  console.log('🔍 Enviando para Gemini Vision...');
  try {
    await new Promise(r => setTimeout(r, 1500));
    const match = await extractMatchFromImage(imgPath);
    match.printFile = imgName;
    if (!match.date) match.date = new Date().toISOString().split('T')[0];

    const found = Object.keys(match.players||{});
    if (found.length === 0) { console.log('⚠️  Nenhum jogador do grupo encontrado. Pulando.'); return; }

    console.log(`🗺️  ${match.map} | ${match.result} | ${match.score}`);
    console.log(`👥 ${found.join(', ')}`);

    const data = readData();
    if (!Array.isArray(data.history)) data.history = [];
    if (data.history.some(m => m.printFile === imgName)) { console.log('⚠️  Já processada.'); return; }

    data.history.push(match);
    data.players = recalcPlayerStats(data.players, data.history);
    saveData(data);
    console.log(`💾 data.json: ${data.history.length} partidas`);

    for (const p of data.players.filter(p=>p.matches>0)) {
      const s=p.stats;
      console.log(`  ${p.playerNick.padEnd(12)} KDR:${s.KDR} ADR:${s.ADR} KAST:${s.KAST}% W:${s.wins} L:${s.losses}`);
    }

    console.log('\\n📤 Push para o GitHub...');
    await gitSync(['data.json', `prints/${imgName}`],
      `🎮 Auto: ${match.map} ${match.score} (${imgName}) [${new Date().toLocaleString('pt-BR')}]`);
  } catch (err) {
    console.error(`❌ Erro ao processar ${imgName}:`, err.message);
  }
}

// ── Remove partida ao deletar print ──
async function removeMatch(filePath) {
  const imgName = path.basename(filePath);
  console.log(`\\n🗑️  Print deletada: ${imgName}`);
  const data = readData();
  const idx = data.history.findIndex(m => m.printFile === imgName);
  if (idx === -1) { console.log('⚠️  Nenhuma partida vinculada. Nada alterado.'); return; }

  const removed = data.history.splice(idx, 1)[0];
  console.log(`📋 Removendo: ${removed.map} | ${removed.score}`);

  data.players = recalcPlayerStats(data.players, data.history);
  saveData(data);
  console.log(`💾 data.json: ${data.history.length} partidas restantes`);

  console.log('\\n📤 Push para o GitHub...');
  const filesToAdd = ['data.json'];
  try { await git.rm([`prints/${imgName}`]); } catch {}
  await gitSync(filesToAdd,
    `🗑️  Remove: ${removed.map} (${imgName}) [${new Date().toLocaleString('pt-BR')}]`);
}

// ── Watcher ──
const EXTS = ['.jpg','.jpeg','.png','.bmp'];
const watcher = chokidar.watch(PRINTS_DIR, {
  persistent: true, ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 }
});

watcher.on('add',   fp => { if(EXTS.includes(path.extname(fp).toLowerCase())) enqueue(()=>processImage(fp)); });
watcher.on('unlink',fp => { if(EXTS.includes(path.extname(fp).toLowerCase())) enqueue(()=>removeMatch(fp)); });

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║   CS Velharada — Watcher de Prints ativo! (Gemini) ║');
console.log(`║   Grupo: ${KNOWN_NICKS.join(', ').padEnd(44)}║`);
console.log('║   Monitorando: ./prints                              ║');
console.log('║   Para parar: Ctrl+C                                 ║');
console.log('╚══════════════════════════════════════════════════════╝\\n');