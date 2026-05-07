const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const PLAYERS = [
  { nick: 'Cq',       id: '1489954' },
  { nick: 'DU',       id: '1311055' },
  { nick: 'Flavinho', id: '822519'  },
  { nick: 'Will',     id: '805025'  },
  { nick: 'Chavera',  id: '13547'   },
  { nick: 'Dukka',    id: '24134'   },
  // { nick: 'Chara',  id: 'XXXXX' },
  // { nick: 'Fluyr',  id: 'XXXXX' },
];

const OUTPUT_FILE = path.join(__dirname, 'data.json');
const DELAY_MS    = 1500;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Referer': 'https://gamersclub.com.br/',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPlayer(player) {
  const url = `https://gamersclub.com.br/player/${player.id}`;
  console.log(`  → Buscando ${player.nick} ...`);
  try {
    const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(html);
    const stats = {};

    // Tenta pegar dados do __NEXT_DATA__ (Next.js)
    let nd = null;
    try { nd = JSON.parse($('script#__NEXT_DATA__').html()); } catch {}

    if (nd) {
      const pp = nd?.props?.pageProps || {};
      const pd = pp?.player || pp?.data?.player || {};
      if (pd.kdr   != null) stats.KDR     = String(pd.kdr   || pd.kdRatio || '');
      if (pd.adr   != null) stats.ADR     = String(pd.adr   || '');
      if (pd.kast  != null) stats.KAST    = String(pd.kast  || '');
      if (pd.hs    != null) stats.HS      = String(pd.hs    || pd.headshotPercentage || '');
      if (pd.kills != null) stats.kills   = String(pd.kills || '');
      if (pd.level != null) stats.level   = String(pd.level || '');
      if (pd.rp    != null) stats.RP      = String(pd.rp    || pd.ratingPoints || '');
    }

    // Fallback: scraping de elementos da página
    $('[class*="stat"], [class*="Stat"]').each((_, el) => {
      const label = $(el).find('[class*="label"], span').first().text().trim().toUpperCase();
      const value = $(el).find('[class*="value"], strong, b').first().text().trim();
      if (label && value) stats[label] = value;
    });

    const level   = stats.level   || '?';
    const matches = parseInt(stats.MATCHES || stats.PARTIDAS || '0') || 0;

    console.log(`    ✓ ${player.nick} — KD: ${stats.KDR||'?'} | ADR: ${stats.ADR||'?'} | HS: ${stats.HS||'?'}%`);

    return {
      playerNick: player.nick,
      playerId:   player.id,
      level, matches,
      updatedAt: new Date().toISOString(),
      stats: {
        KDR:     stats.KDR     || '',
        ADR:     stats.ADR     || '',
        HS:      stats.HS      || '',
        KAST:    stats.KAST    || '',
        kills:   stats.kills   || '',
        assists: stats.assists || '',
        MK:      stats.MK      || '',
        FK:      stats.FK      || '',
        RP:      stats.RP      || '',
      },
    };
  } catch (err) {
    console.warn(`    ✗ Erro em ${player.nick}: ${err.message}`);
    return { playerNick: player.nick, playerId: player.id, level:'?', matches:0, updatedAt: new Date().toISOString(), stats:{}, _error: err.message };
  }
}

async function main() {
  console.log('\n🎯 CS Velharada — Atualizador\n');
  let existing = { players: [], history: [] };
  if (fs.existsSync(OUTPUT_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch {}
  }
  const players = [];
  for (let i = 0; i < PLAYERS.length; i++) {
    players.push(await fetchPlayer(PLAYERS[i]));
    if (i < PLAYERS.length - 1) await sleep(DELAY_MS);
  }
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), players, history: existing.history || [] }, null, 2));
  console.log(`\n✅ data.json salvo com ${players.length} jogadores!\n`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });