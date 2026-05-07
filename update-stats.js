const fs = require('fs');
const https = require('https');

const DATA_FILE = './data.json';

const PLAYER_IDS = {
  Cq:       { gcId: 1489954 },
  DU:       { gcId: 1311055 },
  Flavinho: { gcId: 822519  },
  Chara:    { gcId: null    }, // sem ID numérico no data.json
  Chavera:  { gcId: 13547   },
  Dukka:    { gcId: 24134   },
};

function fetchGC(gcId) {
  return new Promise((resolve, reject) => {
    const url = `https://gamersclub.com.br/api/player/box/${gcId}`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': `https://gamersclub.com.br/player/${gcId}`
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('\n🔄 Buscando stats da Gamersclub...\n');

  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const data = JSON.parse(raw);

  for (const player of data.players) {
    const nick = player.playerNick || player.nick;
    const cfg = PLAYER_IDS[nick];

    if (!cfg?.gcId) {
      console.log(`⚠️  ${nick} — sem gcId, pulando`);
      continue;
    }

    try {
      const gc = await fetchGC(cfg.gcId);
      console.log(`📦 ${nick} resposta:`, JSON.stringify(gc)?.slice(0, 200));

      if (!gc) { console.log(`❌ ${nick} — sem dados`); continue; }

      // Adapta conforme campos retornados pela GC
      const stats = gc.stats || gc.player?.stats || gc;

      player.stats = player.stats || {};
      if (stats.kdr  !== undefined) player.stats.KDR  = String(stats.kdr);
      if (stats.adr  !== undefined) player.stats.ADR  = String(stats.adr);
      if (stats.kast !== undefined) player.stats.KAST = String(stats.kast);
      if (stats.hs   !== undefined) player.stats.HS   = String(stats.hs);
      if (stats.kills!== undefined) player.stats.Kills= String(stats.kills);
      if (stats.rp   !== undefined) player.stats.RP   = String(stats.rp);
      if (gc.level   !== undefined) player.level       = gc.level;

      player.updatedAt = new Date().toISOString();
      console.log(`✅ ${nick} atualizado`);

    } catch(e) {
      console.log(`❌ ${nick} — erro: ${e.message}`);
    }

    // Delay pra não levar ban
    await new Promise(r => setTimeout(r, 800));
  }

  data.lastUpdate = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log('\n✅ data.json salvo!\n');
}

main();