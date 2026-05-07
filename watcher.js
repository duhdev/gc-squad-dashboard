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

// ── Chama Gemini Vision via HTTPS ──
function geminiVision(base64Image, mimeType, prompt) {
  return new Promise((resolve, reject) => {
   const body = JSON.stringify({
  contents: [{
    parts: [
      { text: prompt },
      { inline_data: { mime_type: mimeType, data: base64Image } }
    ]
  }],
  generationConfig: {
    temperature: 0.1,
    maxOutputTokens: 4096,
    responseMimeType: "application/json"
  }
});

    const apiKey = process.env.GEMINI_API_KEY;
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text);
        } catch (e) {
          reject(new Error('Erro ao parsear resposta do Gemini'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Extrai dados do scoreboard via Gemini Vision ──
async function extractMatchFromImage(imgPath) {
  const imageData = fs.readFileSync(imgPath);
  const base64    = imageData.toString('base64');
  const ext       = path.extname(imgPath).replace('.', '').toLowerCase();
  const mimeType  = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const knickList = KNOWN_NICKS.join(', ');

  const prompt = `Você é um extrator de dados de scoreboards do CS2 e GamersClub.
Analise esta imagem de scoreboard e retorne SOMENTE um JSON válido (sem markdown, sem explicação).

Regras IMPORTANTES:
- Extraia APENAS os jogadores cujos nicks estão nesta lista: ${knickList}
- Ignore completamente todos os outros jogadores
- A comparação de nicks é case-insensitive (ex: "cq" = "Cq", "du" = "DU")
- Se um nick da lista não aparecer na imagem, não inclua no JSON
- Campos disponíveis na GamersClub: K (kills), A (assists), D (deaths), DIFF, ADR, KDR, KAST, FA, MK, FK
- Se algum campo não for visível, use 0

Formato de retorno:
{
  "map": "nome_do_mapa_em_minusculas",
  "result": "win",
  "score": "13-7",
  "date": "YYYY-MM-DD",
  "players": {
    "NickExatoDaLista": {
      "kills": 0,
      "deaths": 0,
      "assists": 0,
      "kdr": 0.0,
      "adr": 0.0,
      "kast": 0,
      "hs": 0,
      "mk": 0,
      "fk": 0,
      "fa": 0,
      "diff": 0,
      "rating": 0.0
    }
  }
}

Para "result": se o time dos jogadores da lista ganhou = "win", perdeu = "loss".
Para "map": minúsculas sem espaços (ex: "ancient", "mirage", "dust2", "nuke").
Para "date": use a data visível na imagem. Se não visível, use hoje.
Retorne APENAS o JSON, sem nenhum texto adicional.`;

  const raw     = await geminiVision(base64, mimeType, prompt);
  const cleaned = raw.replace(/```json\\n?/g,'').replace(/```\\n?/g,'').trim();
  return JSON.parse(cleaned);
}

// ── Recalcula médias ──
function recalcPlayerStats(players, history) {
  const statsMap = {};
  for (const match of history) {
    if (!match.players) continue;
    for (const [nick, s] of Object.entries(match.players)) {
      if (!statsMap[nick]) statsMap[nick] = {
        kills:[], deaths:[], assists:[], kdr:[], adr:[], kast:[], hs:[], mk:[], fk:[], fa:[], diff:[], rating:[], matches:0
      };
      statsMap[nick].kills.push(s.kills || 0);
      statsMap[nick].deaths.push(s.deaths || 0);
      statsMap[nick].assists.push(s.assists || 0);
      statsMap[nick].kdr.push(s.kdr || s.kd || 0);
      statsMap[nick].adr.push(s.adr || 0);
      statsMap[nick].kast.push(s.kast || 0);
      statsMap[nick].hs.push(s.hs || 0);
      statsMap[nick].mk.push(s.mk || 0);
      statsMap[nick].fk.push(s.fk || 0);
      statsMap[nick].fa.push(s.fa || 0);
      statsMap[nick].diff.push(s.diff || 0);
      statsMap[nick].rating.push(s.rating || 0);
      statsMap[nick].matches++;
    }
  }
  const avg = arr => arr.length ? parseFloat((arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2)) : 0;
  const sum = arr => arr.reduce((a,b)=>a+b,0);

  return players.map(p => {
    const s = statsMap[p.playerNick];
    if (!s || s.matches === 0) return { ...p, matches: 0, stats: {} };
    return {
      ...p,
      matches: s.matches,
      stats: {
        KDR:     avg(s.kdr),
        ADR:     avg(s.adr),
        HS:      avg(s.hs),
        KAST:    avg(s.kast),
        kills:   avg(s.kills),
        assists: avg(s.assists),
        MK:      sum(s.mk),
        FK:      sum(s.fk),
        FA:      sum(s.fa),
        DIFF:    avg(s.diff),
        rating:  avg(s.rating),
        wins:    history.filter(m => (m.result==='win'||m.result==='W')  && m.players?.[p.playerNick]).length,
        losses:  history.filter(m => (m.result==='loss'||m.result==='L') && m.players?.[p.playerNick]).length,
      }
    };
  });
}

// ── Push automático pro GitHub ──
async function gitPush(imgName) {
  try {
    await git.add(['data.json', `prints/${imgName}`]);
    await git.commit(`🎮 Auto: partida via print (${imgName}) [${new Date().toLocaleString('pt-BR')}]`);
    await git.push('origin', 'main');
    console.log('✅ Push para o GitHub feito com sucesso!');
  } catch (err) {
    console.error('❌ Erro no git push:', err.message);
  }
}

// ── Processador principal ──
const processing = new Set();

async function processImage(imgPath) {
  const imgName = path.basename(imgPath);
  if (processing.has(imgPath)) return;
  processing.add(imgPath);

  console.log(`\\n📸 Nova print detectada: ${imgName}`);
  console.log('🔍 Enviando para Gemini Vision...');

  try {
    await new Promise(r => setTimeout(r, 1500));

    const match = await extractMatchFromImage(imgPath);
    match.printFile = imgName;
    if (!match.date) match.date = new Date().toISOString().split('T')[0];

    const foundPlayers = Object.keys(match.players || {});
    if (foundPlayers.length === 0) {
      console.log('⚠️  Nenhum jogador do grupo encontrado na imagem. Pulando.');
      processing.delete(imgPath);
      return;
    }

    console.log(`🗺️  Mapa: ${match.map} | Resultado: ${match.result} | Score: ${match.score}`);
    console.log(`👥 Jogadores encontrados: ${foundPlayers.join(', ')}`);

    let data = { players: [], history: [] };
    if (fs.existsSync(DATA_FILE)) {
      try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
    }
    if (!Array.isArray(data.history)) data.history = [];

    if (data.history.some(m => m.printFile === imgName)) {
      console.log('⚠️  Print já processada, ignorando.');
      processing.delete(imgPath);
      return;
    }

    data.history.push(match);
    data.players   = recalcPlayerStats(data.players, data.history);
    data.updatedAt = new Date().toISOString();

    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log(`💾 data.json atualizado! (${data.history.length} partidas)`);

    console.log('\\n📊 Médias atualizadas:');
    for (const p of data.players.filter(p => p.matches > 0)) {
      const s = p.stats;
      console.log(`  ${p.playerNick.padEnd(12)} | KDR: ${s.KDR} | ADR: ${s.ADR} | KAST: ${s.KAST}% | Rating: ${s.rating} | Partidas: ${p.matches} | W:${s.wins} L:${s.losses}`);
    }

    console.log('\\n📤 Fazendo push para o GitHub...');
    await gitPush(imgName);

  } catch (err) {
    console.error(`❌ Erro ao processar ${imgName}:`, err.message);
  } finally {
    processing.delete(imgPath);
  }
}
// ── Remove partida ao deletar print ──
async function removeMatch(filePath) {
  const imgName = path.basename(filePath);
  console.log(`\n🗑️  Print deletada: ${imgName}`);

  let data = { players: [], history: [] };
  if (fs.existsSync(DATA_FILE)) {
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }

  const idx = data.history.findIndex(m => m.printFile === imgName);
  if (idx === -1) {
    console.log('⚠️  Nenhuma partida vinculada a essa print. Nada alterado.');
    return;
  }

  const removed = data.history.splice(idx, 1)[0];
  console.log(`📋 Partida removida: ${removed.map} | ${removed.score} | ${removed.date}`);

  data.players   = recalcPlayerStats(data.players, data.history);
  data.updatedAt = new Date().toISOString();

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  console.log(`💾 data.json atualizado! (${data.history.length} partidas restantes)`);

  if (data.history.length > 0) {
    console.log('\n📊 Médias recalculadas:');
    for (const p of data.players.filter(p => p.matches > 0)) {
      const s = p.stats;
      console.log(`  ${p.playerNick.padEnd(12)} | KDR: ${s.KDR} | ADR: ${s.ADR} | Rating: ${s.rating} | Partidas: ${p.matches}`);
    }
  }

  // Push pro GitHub
  console.log('\n📤 Fazendo push para o GitHub...');
  try {
    await git.add(['data.json']);
    try { await git.rm([`prints/${imgName}`]); } catch {}
    await git.commit(`🗑️  Remove partida: ${removed.map} (${imgName}) [${new Date().toLocaleString('pt-BR')}]`);
    await git.push('origin', 'main');
    console.log('✅ Push para o GitHub feito com sucesso!');
  } catch (err) {
    console.error('❌ Erro no git push:', err.message);
  }
}

// ── Watcher ──
const EXTS = ['.jpg', '.jpeg', '.png', '.bmp'];
const watcher = chokidar.watch(PRINTS_DIR, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 }
});

watcher.on('add', filePath => {
  if (EXTS.includes(path.extname(filePath).toLowerCase())) {
    processImage(filePath);
  }
});

watcher.on('add', filePath => {
  if (EXTS.includes(path.extname(filePath).toLowerCase())) {
    processImage(filePath);
  }
});

watcher.on('unlink', filePath => {
  if (EXTS.includes(path.extname(filePath).toLowerCase())) {
    removeMatch(filePath);
  }
});

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║   CS Velharada — Watcher de Prints ativo! (Gemini) ║');
console.log(`║   Grupo: ${KNOWN_NICKS.join(', ').padEnd(44)}║`);
console.log('║   Monitorando: ./prints                              ║');
console.log('║   Para parar: Ctrl+C                                 ║');
console.log('╚══════════════════════════════════════════════════════╝\\n');