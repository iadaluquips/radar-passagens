// Radar de passagens — roda sozinho no GitHub Actions (Node 20+, sem instalar nada)
// Fontes: Travelpayouts (varre os meses) + SerpApi/Google Flights (confirma em tempo real, opcional)
// Aviso: Telegram

const fs = require('fs');
const path = require('path');

const DIR = process.env.RADAR_DIR || __dirname;
const ARQ_ROTAS = path.join(DIR, 'rotas.json');
const ARQ_HIST = path.join(DIR, 'historico.json');

const TP_TOKEN = process.env.TRAVELPAYOUTS_TOKEN || '';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

const PADRAO = {
  desconto_minimo_pct: 15,          // avisa se estiver X% abaixo da média
  dias_minimos_de_historico: 5,     // só usa a média depois de X dias coletados
  janela_media_dias: 60,            // média calculada sobre os últimos X dias
  confirmacoes_google_por_rodada: 3, // limite p/ caber nas 250 buscas grátis/mês
  max_avisos_por_rota: 3            // no máximo X datas por rota em cada aviso
};

// ---------- utilidades ----------
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const brl = (n) => 'R$ ' + Math.round(n).toLocaleString('pt-BR');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hojeSP = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const diasEntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const dataBR = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const nomeMes = (ym) => {
  const m = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return m[Number(ym.slice(5, 7)) - 1] + '/' + ym.slice(0, 4);
};
const somaMes = (ym, n) => {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

function mesesDaRota(rota, hoje) {
  const atual = hoje.slice(0, 7);
  let lista = [];
  if (Array.isArray(rota.meses) && rota.meses.length) lista = rota.meses;
  else {
    const n = Number(rota.proximos_meses) || 11;
    for (let i = 0; i <= n; i++) lista.push(somaMes(atual, i));
  }
  return lista.filter((m) => m >= atual);
}

// ---------- Travelpayouts ----------
async function buscarTP(origem, destino, mesIda, mesVolta) {
  const u = new URL('https://api.travelpayouts.com/aviasales/v3/prices_for_dates');
  const p = {
    origin: origem, destination: destino, departure_at: mesIda,
    one_way: mesVolta ? 'false' : 'true', direct: 'false', unique: 'false',
    sorting: 'price', currency: 'brl', limit: '1000', page: '1'
  };
  if (mesVolta) p.return_at = mesVolta;
  for (const k in p) u.searchParams.set(k, p[k]);
  const r = await fetch(u, { headers: { 'X-Access-Token': TP_TOKEN } });
  if (!r.ok) throw new Error('Travelpayouts respondeu ' + r.status);
  const j = await r.json();
  if (!j.success) throw new Error('Travelpayouts: ' + (j.error || 'erro desconhecido'));
  return j.data || [];
}

async function melhorDoMes(rota, mes) {
  const idaVolta = rota.ida_e_volta !== false;
  let ofertas = [];
  if (idaVolta) {
    for (const mv of [mes, somaMes(mes, 1)]) {
      ofertas = ofertas.concat(await buscarTP(rota.origem, rota.destino, mes, mv));
      await esperar(250);
    }
    const min = rota.dias_min ?? 1;
    const max = rota.dias_max ?? 60;
    ofertas = ofertas.filter((o) => {
      if (!o.return_at) return false;
      const d = diasEntre(o.departure_at.slice(0, 10), o.return_at.slice(0, 10));
      return d >= min && d <= max;
    });
  } else {
    ofertas = await buscarTP(rota.origem, rota.destino, mes, null);
    await esperar(250);
  }
  if (rota.max_escalas != null) {
    ofertas = ofertas.filter((o) => (o.transfers ?? 0) <= rota.max_escalas && (o.return_transfers ?? 0) <= rota.max_escalas);
  }
  const hoje = hojeSP();
  ofertas = ofertas.filter((o) => o.departure_at && o.departure_at.slice(0, 10) >= hoje);
  ofertas.sort((a, b) => a.price - b.price);
  const o = ofertas[0];
  if (!o) return null;
  return {
    preco: o.price,
    ida: o.departure_at.slice(0, 10),
    volta: o.return_at ? o.return_at.slice(0, 10) : null,
    aeroOrigem: o.origin_airport || rota.origem,
    aeroDestino: o.destination_airport || rota.destino,
    cia: o.airline || '',
    escalas: o.transfers ?? 0,
    link: o.link ? 'https://www.aviasales.com' + o.link : null
  };
}

// ---------- SerpApi (Google Flights) ----------
async function confirmarGoogle(of) {
  const u = new URL('https://serpapi.com/search.json');
  const p = {
    engine: 'google_flights', departure_id: of.aeroOrigem, arrival_id: of.aeroDestino,
    outbound_date: of.ida, type: of.volta ? '1' : '2', currency: 'BRL', gl: 'br', api_key: SERPAPI_KEY
  };
  if (of.volta) p.return_date = of.volta;
  for (const k in p) u.searchParams.set(k, p[k]);
  const r = await fetch(u);
  if (!r.ok) throw new Error('SerpApi respondeu ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('SerpApi: ' + j.error);
  const voos = [].concat(j.best_flights || [], j.other_flights || []).map((v) => v.price).filter((x) => x > 0);
  const pi = j.price_insights || {};
  const preco = pi.lowest_price || (voos.length ? Math.min(...voos) : null);
  if (!preco) return null;
  return {
    preco,
    nivel: pi.price_level || null,
    faixa: Array.isArray(pi.typical_price_range) ? pi.typical_price_range : null,
    url: (j.search_metadata && j.search_metadata.google_flights_url) || null
  };
}

const linkGoogle = (of) =>
  'https://www.google.com/travel/flights?q=' +
  encodeURIComponent(`Flights from ${of.aeroOrigem} to ${of.aeroDestino} on ${of.ida}` + (of.volta ? ` through ${of.volta}` : '')) +
  '&curr=BRL';

// ---------- histórico e média ----------
function estatisticas(serie, hoje, janela) {
  const vals = [];
  let minimo = null;
  for (const dia in serie) {
    if (dia >= hoje) continue;
    const v = serie[dia];
    if (minimo === null || v < minimo) minimo = v;
    if (diasEntre(dia, hoje) <= janela) vals.push(v);
  }
  const media = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  return { n: vals.length, media, minimo };
}

function avaliar(preco, est, rota, cfg) {
  const motivos = [];
  let desconto = null;
  if (est.media && est.n >= cfg.dias_minimos_de_historico) {
    desconto = ((est.media - preco) / est.media) * 100;
    if (desconto >= cfg.desconto_minimo_pct) motivos.push(`${Math.round(desconto)}% abaixo da média (${brl(est.media)})`);
    if (est.minimo && preco <= est.minimo * 0.97) motivos.push('menor preço já registrado');
  }
  if (rota.preco_alvo && preco <= rota.preco_alvo) motivos.push(`abaixo do seu alvo de ${brl(rota.preco_alvo)}`);
  const nota = desconto === null ? null : Math.max(0, Math.min(100, Math.round(50 + desconto * 2)));
  return { motivos, desconto, nota };
}

// ---------- Telegram ----------
async function enviarTelegram(texto) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log('\n[Telegram não configurado — mensagem abaixo]\n' + texto.replace(/<[^>]+>/g, '') + '\n');
    return;
  }
  const partes = [];
  let atual = '';
  for (const bloco of texto.split('\n\n')) {
    if ((atual + '\n\n' + bloco).length > 3800) { partes.push(atual); atual = bloco; }
    else atual = atual ? atual + '\n\n' + bloco : bloco;
  }
  if (atual) partes.push(atual);
  for (const parte of partes) {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: parte, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    if (!r.ok) throw new Error('Telegram respondeu ' + r.status + ': ' + (await r.text()));
  }
}

function blocoOferta(c) {
  const of = c.oferta;
  const datas = of.volta ? `${dataBR(of.ida)} a ${dataBR(of.volta)} (${diasEntre(of.ida, of.volta)} dias)` : dataBR(of.ida);
  const linhas = [];
  linhas.push(`✈️ <b>${esc(c.rota.nome)}</b>`);
  linhas.push(`📅 ${datas}`);
  linhas.push(`💰 <b>${brl(c.preco)}</b>` + (c.av.nota !== null ? `  ·  nota ${c.av.nota}/100` : ''));
  linhas.push('✅ ' + c.av.motivos.map(esc).join(' · '));
  if (c.google) {
    let g = `🔎 Confirmado agora no Google Flights: ${brl(c.google.preco)}`;
    if (c.google.faixa) g += ` (faixa normal: ${brl(c.google.faixa[0])} a ${brl(c.google.faixa[1])})`;
    linhas.push(g);
  } else {
    linhas.push('⚠️ Preço de cache (pode ter algumas horas). Confirme no link.');
  }
  const links = [`<a href="${esc((c.google && c.google.url) || linkGoogle(of))}">Google Flights</a>`];
  if (of.link) links.push(`<a href="${esc(of.link)}">Aviasales</a>`);
  linhas.push('🔗 ' + links.join('  |  '));
  return linhas.join('\n');
}

// ---------- principal ----------
async function main() {
  if (!TP_TOKEN) throw new Error('Falta o secret TRAVELPAYOUTS_TOKEN.');
  const arq = JSON.parse(fs.readFileSync(ARQ_ROTAS, 'utf8'));
  const cfg = Object.assign({}, PADRAO, arq.config || {});
  const rotas = arq.rotas || [];

  const hist = fs.existsSync(ARQ_HIST) ? JSON.parse(fs.readFileSync(ARQ_HIST, 'utf8')) : {};
  hist.precos = hist.precos || {};
  hist.alertas = hist.alertas || {};
  hist.ofertas = hist.ofertas || {};

  if (!rotas.length) {
    console.log('Nenhuma rota cadastrada ainda. Adicione rotas no painel.');
    if (!hist.conectado) {
      hist.conectado = true;
      fs.writeFileSync(ARQ_HIST, JSON.stringify(hist, null, 1));
      await enviarTelegram('🟢 <b>Radar de passagens conectado!</b>\nAgora adicione suas rotas no painel.');
    }
    return;
  }
  const primeiraVez = !hist.iniciado;
  const hoje = hojeSP();

  const achados = [];
  let consultas = 0;
  let falhas = 0;

  for (const rota of rotas) {
    rota.nome = rota.nome || `${rota.origem} → ${rota.destino}`;
    for (const mes of mesesDaRota(rota, hoje)) {
      consultas++;
      let oferta;
      try {
        oferta = await melhorDoMes(rota, mes);
      } catch (e) {
        falhas++;
        console.log(`Erro em ${rota.nome} ${mes}: ${e.message}`);
        continue;
      }
      if (!oferta) { console.log(`${rota.nome} ${mes}: sem preço disponível`); continue; }
      const chave = `${rota.origem}-${rota.destino}|${mes}`;
      const serie = (hist.precos[chave] = hist.precos[chave] || {});
      const est = estatisticas(serie, hoje, cfg.janela_media_dias);
      serie[hoje] = serie[hoje] ? Math.min(serie[hoje], oferta.preco) : oferta.preco;
      console.log(`${rota.nome} ${mes}: ${brl(oferta.preco)}` + (est.media ? ` (média ${brl(est.media)}, ${est.n} dias)` : ''));
      hist.ofertas[chave] = {
        preco: oferta.preco, ida: oferta.ida, volta: oferta.volta, de: oferta.aeroOrigem, para: oferta.aeroDestino,
        cia: oferta.cia, escalas: oferta.escalas, link: oferta.link, confirmado: false, em: hoje
      };
      achados.push({ rota, mes, chave, oferta, est, preco: oferta.preco, av: avaliar(oferta.preco, est, rota, cfg) });
    }
  }

  if (consultas && falhas === consultas) throw new Error('Todas as consultas falharam. Confira o token da Travelpayouts.');

  // candidatos a alerta (sem repetir o mesmo aviso)
  let candidatos = achados.filter((c) => {
    if (!c.av.motivos.length) return false;
    const ult = hist.alertas[c.chave];
    return !(ult && c.preco >= ult.preco * 0.97 && diasEntre(ult.data, hoje) < 7);
  });
  candidatos.sort((a, b) => (b.av.desconto ?? 0) - (a.av.desconto ?? 0) || a.preco - b.preco);

  // confirmação em tempo real no Google Flights (opcional)
  if (SERPAPI_KEY) {
    for (const c of candidatos.slice(0, cfg.confirmacoes_google_por_rodada)) {
      try {
        const g = await confirmarGoogle(c.oferta);
        if (!g) continue;
        c.google = g;
        c.preco = g.preco;
        Object.assign(hist.ofertas[c.chave], { preco: g.preco, confirmado: true, faixa: g.faixa });
        c.av = avaliar(g.preco, c.est, c.rota, cfg);
      } catch (e) {
        console.log(`Não consegui confirmar no Google (${c.rota.nome} ${c.mes}): ${e.message}`);
      }
    }
    candidatos = candidatos.filter((c) => {
      if (!c.av.motivos.length) console.log(`${c.rota.nome} ${c.mes}: preço subiu no Google, aviso cancelado`);
      return c.av.motivos.length;
    });
  }

  const blocos = [];
  if (primeiraVez) {
    const linhas = ['🟢 <b>Radar de passagens ligado!</b>', 'Menor preço de hoje em cada rota:'];
    for (const rota of rotas) {
      const m = achados.filter((c) => c.rota === rota).sort((a, b) => a.preco - b.preco)[0];
      linhas.push(m ? `• ${esc(rota.nome)}: ${brl(m.preco)} em ${nomeMes(m.mes)}` : `• ${esc(rota.nome)}: sem preço disponível ainda`);
    }
    linhas.push(`A média fica confiável depois de ${cfg.dias_minimos_de_historico} dias de coleta.`);
    blocos.push(linhas.join('\n'));
  }
  if (candidatos.length) {
    blocos.push('🔥 <b>Oferta encontrada</b>');
    const porRota = new Map();
    for (const c of candidatos) {
      hist.alertas[c.chave] = { preco: c.preco, data: hoje };
      const n = porRota.get(c.rota) || 0;
      porRota.set(c.rota, n + 1);
      if (n < cfg.max_avisos_por_rota) blocos.push(blocoOferta(c));
    }
    for (const [rota, n] of porRota) {
      const extra = n - cfg.max_avisos_por_rota;
      if (extra > 0) blocos.push(`➕ ${esc(rota.nome)}: mais ${extra} mês(es) com preço baixo.`);
    }
  }

  // resumo semanal: segunda-feira, na rodada da manhã
  const agora = new Date();
  if (!primeiraVez && agora.getUTCDay() === 1 && agora.getUTCHours() < 15 && hist.resumo !== hoje) {
    const linhas = ['📊 <b>Resumo da semana</b>'];
    for (const rota of rotas) {
      const top = achados.filter((c) => c.rota === rota).sort((a, b) => a.preco - b.preco).slice(0, 5);
      if (!top.length) continue;
      linhas.push(`\n<b>${esc(rota.nome)}</b>`);
      for (const c of top) {
        let l = `• ${nomeMes(c.mes)}: ${brl(c.preco)}`;
        if (c.av.desconto !== null) l += ` (${c.av.desconto >= 0 ? '-' : '+'}${Math.abs(Math.round(c.av.desconto))}% vs média)`;
        linhas.push(l);
      }
    }
    blocos.push(linhas.join('\n'));
    hist.resumo = hoje;
  }

  // limpeza: guarda no máximo 180 dias e descarta meses que já passaram
  const mesAtual = hoje.slice(0, 7);
  for (const chave in hist.precos) {
    if (chave.split('|')[1] < mesAtual) { delete hist.precos[chave]; delete hist.alertas[chave]; delete hist.ofertas[chave]; continue; }
    for (const dia in hist.precos[chave]) if (diasEntre(dia, hoje) > 180) delete hist.precos[chave][dia];
  }

  // salva o histórico antes de avisar, para não perder a coleta se o Telegram falhar
  hist.iniciado = hist.iniciado || hoje;
  hist.conectado = true;
  hist.atualizado = hoje;
  hist.atualizado_em = new Date().toISOString();
  fs.writeFileSync(ARQ_HIST, JSON.stringify(hist, null, 1));

  if (blocos.length) await enviarTelegram(blocos.join('\n\n'));
  console.log(`\nFim: ${achados.length} preços coletados, ${candidatos.length} aviso(s) enviado(s).`);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
}
module.exports = { main, estatisticas, avaliar, mesesDaRota };
