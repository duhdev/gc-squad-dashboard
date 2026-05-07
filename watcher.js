require('dotenv').config();
const chokidar  = require('chokidar');
const fs        = require('fs');
const path      = require('path');
const OpenAI    = require('openai');
const simpleGit = require('simple-git');

const PRINTS_DIR = path.join(__dirname, 'prints');
const DATA_FILE  = path.join(__dirname, 'data.json');
const git        = simpleGit(__dirname);
const openai     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

if (!fs.existsSync(PRINTS_DIR)) fs.mkdirSync(PRINTS_DIR);

// ── Extrai dados do scoreboard via GPT-4o Vision ──
async function extractMatchFromImage(imgPath) {
  const imageData = fs.readFileSync(imgPath);
  const base64    = imageData.toString('base64');
  const ext       = path.extname(imgPath).replace('.', '').toLowerCase();
  const mime      = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

  const prompt = `Você é um extrator de dados de scoreboards do CS2.
Analise esta imagem e retorne SOMENTE um JSON válido neste formato (sem markdown):
{
  "map": "nome_do_mapa",
  "result": "win",
  "score": "13-7",
  "date": "YYYY-MM-DD",
  "players": {
    "NickDoJogador": {
      "kills": 0,
      "deaths": 0,
      "assists": 0,
      "mvps": 0,
      "hs_percent": 0,
      "adr": 0,
      "rating": 0.0
    }
  }
}
Regras:
- map: nome em minúsculas (ex: "mirage", "inferno", "dust2")
- result: "win", "loss" ou "draw"
- score: formato "X-Y"
- date: data de hoje se não visível
- inclua TODOS os jogadores visíveis
- hs_percent, adr e rating podem ser 0 se não visíveis
Retorne APENAS o JSON, sem nenhum texto adicional.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } }
      ]
    }]
  });

  const raw     = response.choices[0].message.content.trim();
  const cleaned = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
  return JSON.parse(cleaned);
}

// ── Recalcula médias de todos os jogadores ──
function recalcPlayerStats(history) {
  const statsMap = {};
  for (const match of history) {
    if (!match.players) continue;
    for (const [nick, s] of Object.entries(match.players)) {
      if (!statsMap[nick]) statsMap[nick] = { kills:[], deaths:[], assists:[], mvps:[], hs_percent:[], adr:[], rating:[], matches:0 };
      statsMap[nick].kills.push(s.kills || 0);
      statsMap[nick].deaths.push(s.deaths || 0);
      statsMap[nick].assists.push(s.assists || 0);
      statsMap[nick].mvps.push(s.mvps || 0);
      statsMap[nick].hs_percent.push(s.hs_percent || 0);
      statsMap[nick].adr.push(s.adr || 0);
      statsMap[nick].rating.push(s.rating || 0);
      statsMap[nick].matches++;
    }
  }
  const avg = arr => arr.length ? parseFloat((arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2)) : 0;
  const sum = arr => arr.reduce((a,b)=>a+b,0);
  const players = [];
  for (const [nick, s] of Object.entries(statsMap)) {
    players.push({
      playerNick: nick,
      matches: s.matches,
      stats: {
        kills_avg:      avg(s.kills),
        deaths_avg:     avg(s.deaths),
        assists_avg:    avg(s.assists),
        mvps_total:     sum(s.mvps),
        mvps_avg:       avg(s.mvps),
        hs_percent_avg: avg(s.hs_percent),
        adr_avg:        avg(s.adr),
        rating_avg:     avg(s.rating),
        kd_ratio:       sum(s.deaths) > 0 ? parseFloat((sum(s.kills)/sum(s.deaths)).toFixed(2)) : 0,
        wins:           history.filter(m => m.result==='win'  && m.players?.[nick]).length,
        losses:         history.filter(m => m.result==='loss' && m.players?.[nick]).length,
      }
    });
  }
  return players.sort((a,b) => b.stats.rating_avg - a.stats.rating_avg);
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

  console.log(`\n📸 Nova print detectada: ${imgName}`);
  console.log('🔍 Enviando para GPT-4o Vision...');

  try {
    await new Promise(r => setTimeout(r, 1500));

    const match = await extractMatchFromImage(imgPath);
    match.printFile = imgName;
    if (!match.date) match.date = new Date().toISOString().split('T')[0];

    console.log(`🗺️  Mapa: ${match.map} | Resultado: ${match.result} | Score: ${match.score}`);
    console.log(`👥 Jogadores: ${Object.keys(match.players).join(', ')}`);

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
    data.players   = recalcPlayerStats(data.history);
    data.updatedAt = new Date().toISOString();

    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log(`💾 data.json atualizado! (${data.history.length} partidas)`);

    console.log('\n📊 Médias atualizadas:');
    for (const p of data.players) {
      const s = p.stats;
      console.log(`  ${p.playerNick.padEnd(20)} | K/D: ${s.kd_ratio} | Rating: ${s.rating_avg} | Kills/g: ${s.kills_avg} | ADR: ${s.adr_avg} | Partidas: ${p.matches}`);
    }

    console.log('\n📤 Fazendo push para o GitHub...');
    await gitPush(imgName);

  } catch (err) {
    console.error(`❌ Erro ao processar ${imgName}:`, err.message);
  } finally {
    processing.delete(imgPath);
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

console.log('╔══════════════════════════════════════════════╗');
console.log('║   CS Velharada — Watcher de Prints ativo!   ║');
console.log('║   Monitorando: ./prints                      ║');
console.log('║   Coloque uma print lá e o sistema faz tudo ║');
console.log('║   Para parar: Ctrl+C                        ║');
console.log('╚══════════════════════════════════════════════╝\n');