const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');

const app      = express();
const PORT     = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// GET /api/data — lê o data.json
app.get('/api/data', (req, res) => {
  if (!fs.existsSync(DATA_FILE)) {
    return res.json({ players: [], history: [] });
  }
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao ler data.json' });
  }
});

// POST /api/match — adiciona partida ao histórico
app.post('/api/match', (req, res) => {
  const match = req.body;
  if (!match || !match.map || !match.players) {
    return res.status(400).json({ error: 'Dados inválidos' });
  }
  let data = { players: [], history: [] };
  if (fs.existsSync(DATA_FILE)) {
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  if (!Array.isArray(data.history)) data.history = [];
  data.history.push(match);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  console.log(`[${new Date().toLocaleString('pt-BR')}] Partida salva: ${match.map} (${match.result})`);
  res.json({ ok: true, total: data.history.length });
});

// POST /api/players — atualiza stats dos jogadores
app.post('/api/players', (req, res) => {
  const players = req.body;
  if (!Array.isArray(players)) {
    return res.status(400).json({ error: 'Esperado array de players' });
  }
  let data = { players: [], history: [] };
  if (fs.existsSync(DATA_FILE)) {
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  data.players = players;
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  res.json({ ok: true });
});

// DELETE /api/match/:index — remove partida pelo índice
app.delete('/api/match/:index', (req, res) => {
  const idx = parseInt(req.params.index);
  let data = { players: [], history: [] };
  if (fs.existsSync(DATA_FILE)) {
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  if (isNaN(idx) || idx < 0 || idx >= data.history.length) {
    return res.status(404).json({ error: 'Partida não encontrada' });
  }
  const removed = data.history.splice(idx, 1);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  console.log(`[${new Date().toLocaleString('pt-BR')}] Partida removida: ${removed[0]?.map}`);
  res.json({ ok: true, total: data.history.length });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   CS Velharada — Servidor rodando!    ║');
  console.log(`║   Acesse: http://localhost:${PORT}         ║`);
  console.log('║   Para parar: Ctrl+C                  ║');
  console.log('╚════════════════════════════════════════╝\n');
});