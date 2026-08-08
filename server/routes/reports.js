'use strict';
const express = require('express');
const reports = require('../reports');
const snapshots = require('../snapshots');
const { escapeXml } = require('../xlsx');
const { logChange } = require('../db');

const router = express.Router();

/** Вытаскивает охват из строки запроса. */
function readScope(query) {
  return {
    building_id: query.building_id || null,
    floor_id: query.floor_id || null,
    department_id: query.department_id || null,
    from: query.from || null,
    to: query.to || null,
  };
}

/** Имя файла со штампом даты, безопасное для Windows. */
function fileName(base, extension) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-` +
    `${String(now.getDate()).padStart(2, '0')}`;
  return `mednet-${base}-${stamp}.${extension}`;
}

/** Кириллица в имени файла требует кодирования по RFC 5987. */
function attachment(res, name) {
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; ` +
    `filename*=UTF-8''${encodeURIComponent(name)}`
  );
}

// ---------------------------------------------------------------------
//  Перечень доступных отчётов
// ---------------------------------------------------------------------
router.get('/reports', (req, res) => {
  res.json({
    reports: reports.listReports(),
    snapshots: snapshots.listSnapshots().map((s) => ({ period: s.period, taken_at: s.taken_at })),
  });
});

// ---------------------------------------------------------------------
//  Предпросмотр: первые строки и общее количество
// ---------------------------------------------------------------------
router.get('/reports/preview', (req, res) => {
  const data = reports.buildReport(String(req.query.key || ''), readScope(req.query));
  if (!data) return res.status(404).json({ error: 'not_found', message: 'Такого отчёта нет' });
  res.json({
    title: data.title,
    note: data.note || null,
    columns: data.columns,
    rows: data.rows.slice(0, 15),
    total: data.rows.length,
  });
});

// ---------------------------------------------------------------------
//  Выгрузка одного отчёта в CSV
// ---------------------------------------------------------------------
router.get('/reports/export', (req, res) => {
  const key = String(req.query.key || '');
  const data = reports.buildReport(key, readScope(req.query));
  if (!data) return res.status(404).json({ error: 'not_found', message: 'Такого отчёта нет' });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  attachment(res, fileName(key, 'csv'));
  res.send(reports.toCsv(data));
});

// ---------------------------------------------------------------------
//  Книга XLSX со всеми отчётами сразу
// ---------------------------------------------------------------------
router.get('/reports/workbook', (req, res) => {
  const keys = req.query.keys ? String(req.query.keys).split(',').filter(Boolean) : null;
  const buffer = reports.buildWorkbook(readScope(req.query), keys);

  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  attachment(res, fileName('отчёты', 'xlsx'));
  logChange(req, 'report', null, 'export', 'выгружена книга отчётов');
  res.send(buffer);
});

// ---------------------------------------------------------------------
//  Печатная сводка: обычная страница, которую браузер сохраняет в PDF
//  штатной командой «Печать». Отдельная библиотека для этого не нужна.
// ---------------------------------------------------------------------
router.get('/reports/summary', (req, res) => {
  const scope = readScope(req.query);
  const blocks = ['connectivity', 'by_status', 'by_type', 'by_department',
    'switch_load', 'port_distribution', 'quality']
    .map((key) => reports.buildReport(key, scope))
    .filter(Boolean);

  const dynamics = snapshots.snapshotTable();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderSummary(reports.describeScope(scope), blocks, dynamics));
});

// ---------------------------------------------------------------------
//  Срезы
// ---------------------------------------------------------------------
router.get('/reports/snapshots', (req, res) => {
  res.json(snapshots.snapshotTable());
});

router.post('/reports/snapshots', (req, res) => {
  const result = snapshots.capture({ force: true });
  logChange(req, 'report', null, 'create', `снят срез за ${result.period}`);
  res.json(result);
});

// =====================================================================
//  Отрисовка печатной сводки
// =====================================================================

function renderTable(block) {
  const head = block.columns.map((c) => `<th>${escapeXml(c.title)}</th>`).join('');
  const body = block.rows.map((row) => {
    const isTotal = String(row[block.columns[0].key]).toUpperCase() === 'ИТОГО';
    const cells = block.columns.map((c) => {
      const value = row[c.key];
      const numeric = c.type === 'number' || c.type === 'integer';
      const text = value === null || value === undefined ? '' : String(value);
      return `<td class="${numeric ? 'num' : ''}">${escapeXml(text)}</td>`;
    }).join('');
    return `<tr class="${isTotal ? 'total' : ''}">${cells}</tr>`;
  }).join('');

  return `<section class="block">
    <h2>${escapeXml(block.title)}</h2>
    ${block.note ? `<p class="note">${escapeXml(block.note)}</p>` : ''}
    <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
  </section>`;
}

function renderSummary(scopeText, blocks, dynamics) {
  const now = new Date();
  const printed = now.toLocaleString('ru-RU');
  const dynamicsBlock = dynamics.rows.length
    ? renderTable({ title: 'Динамика по месяцам', columns: dynamics.columns.slice(0, 10), rows: dynamics.rows })
    : '';

  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8">
<title>MedNet Tracker — сводный отчёт</title>
<style>
  /* Оформление под печать: чёрным по белому, поля под A4.
     Сохранить в PDF можно штатной командой браузера «Печать». */
  @page { size: A4 portrait; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", system-ui, sans-serif; font-size: 10.5pt;
    color: #16202a; margin: 0 auto; padding: 24px; max-width: 900px; background: #fff;
  }
  header { border-bottom: 2px solid #16202a; padding-bottom: 10px; margin-bottom: 18px; }
  h1 { font-size: 17pt; margin: 0 0 4px; }
  .meta { color: #5a6b78; font-size: 9.5pt; }
  h2 { font-size: 12pt; margin: 0 0 6px; }
  .block { margin-bottom: 22px; page-break-inside: avoid; }
  .note { color: #5a6b78; font-size: 9pt; margin: 0 0 7px; font-style: italic; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; }
  th {
    text-align: left; background: #eef2f4; border-bottom: 1.5px solid #9fb0bc;
    padding: 5px 7px; font-weight: 600;
  }
  td { padding: 4px 7px; border-bottom: 1px solid #dde4e9; }
  td.num, th:nth-child(n+2) { text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  tr.total td { font-weight: 700; border-top: 1.5px solid #9fb0bc; background: #f6f8f9; }
  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #cfd8de;
    color: #5a6b78; font-size: 8.5pt; }
  .print-hint { background: #eef6f6; border: 1px solid #b9d9d9; padding: 9px 12px;
    border-radius: 4px; margin-bottom: 18px; font-size: 9.5pt; }
  @media print { .print-hint { display: none; } body { padding: 0; } }
</style>
</head><body>

<div class="print-hint">
  Чтобы сохранить отчёт в PDF, нажмите <b>Ctrl+P</b> и выберите
  «Сохранить как PDF» в списке принтеров. Эта подсказка на печать не попадёт.
</div>

<header>
  <h1>Сводный отчёт по сетевой инфраструктуре</h1>
  <div class="meta">${escapeXml(scopeText)} · сформирован ${escapeXml(printed)}</div>
</header>

${blocks.map(renderTable).join('')}
${dynamicsBlock}

<footer>
  MedNet Tracker — учёт сетевой инфраструктуры.
  Отчёт отражает состояние базы на момент формирования.
</footer>
</body></html>`;
}

module.exports = router;
