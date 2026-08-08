'use strict';
/**
 * Запись книг XLSX без внешних зависимостей.
 *
 * Формат Office Open XML - это обычный ZIP-архив с несколькими файлами
 * XML внутри. Готовые библиотеки умеют несравнимо больше (формулы,
 * диаграммы, картинки), но тянут за собой десятки пакетов и десятки
 * мегабайт. Нам нужны только таблицы: шапка, полосы данных, автофильтр,
 * закреплённая строка и разумная ширина столбцов. Это пишется само,
 * а zlib для сжатия в Node уже встроен.
 *
 * Использование:
 *   const book = new Workbook();
 *   book.addSheet('Оборудование', columns, rows);
 *   fs.writeFileSync('report.xlsx', book.toBuffer());
 */
const zlib = require('zlib');

// =====================================================================
//  Контейнер ZIP
// =====================================================================

/** Таблица CRC32, считается один раз при загрузке модуля. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** Дата и время в формате MS-DOS, как того требует спецификация ZIP. */
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * Собирает ZIP-архив из списка {name, data}.
 * Сжатие - deflate без заголовка zlib (метод 8), как принято в ZIP.
 */
function buildZip(entries) {
  const now = new Date();
  const { time, day } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Если сжатие не дало выигрыша, кладём как есть
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);   // подпись локального заголовка
    local.writeUInt16LE(20, 4);           // версия для распаковки
    local.writeUInt16LE(0x0800, 6);       // флаг: имена в UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);

    locals.push(local, body);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);         // версия создателя
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(0, 38);         // внешние атрибуты
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, end]);
}

// =====================================================================
//  XML
// =====================================================================

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Управляющие символы Excel не принимает и файл считает повреждённым
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/** Номер столбца в буквенное обозначение: 1 -> A, 27 -> AA. */
function columnLetter(index) {
  let result = '';
  let n = index;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

// =====================================================================
//  Книга
// =====================================================================

/** Недопустимые в именах листов символы Excel заменяет молча - сделаем это явно. */
function safeSheetName(name, used) {
  let clean = String(name).replace(/[\\/?*[\]:]/g, '-').slice(0, 31).trim() || 'Лист';
  let candidate = clean;
  let counter = 2;
  while (used.has(candidate)) {
    const suffix = ' ' + counter;
    candidate = clean.slice(0, 31 - suffix.length) + suffix;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

class Workbook {
  constructor() {
    this.sheets = [];
    this.usedNames = new Set();
  }

  /**
   * Добавляет лист.
   * @param {string} name    заголовок вкладки
   * @param {Array}  columns [{ key, title, width, type }] - type: text|number|integer
   * @param {Array}  rows    массив объектов
   * @param {object} options { note } - пояснение над таблицей
   */
  addSheet(name, columns, rows, options = {}) {
    this.sheets.push({
      name: safeSheetName(name, this.usedNames),
      columns, rows: rows || [], note: options.note || null,
    });
    return this;
  }

  toBuffer() {
    const files = [
      { name: '[Content_Types].xml', data: this.contentTypes() },
      { name: '_rels/.rels', data: ROOT_RELS },
      { name: 'xl/workbook.xml', data: this.workbookXml() },
      { name: 'xl/_rels/workbook.xml.rels', data: this.workbookRels() },
      { name: 'xl/styles.xml', data: STYLES },
    ];
    this.sheets.forEach((sheet, index) => {
      files.push({
        name: `xl/worksheets/sheet${index + 1}.xml`,
        data: this.sheetXml(sheet),
      });
    });
    return buildZip(files);
  }

  contentTypes() {
    const sheets = this.sheets.map((_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ` +
      `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    ).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets}</Types>`;
  }

  workbookXml() {
    const sheets = this.sheets.map((sheet, i) =>
      `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    ).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets}</sheets></workbook>`;
  }

  workbookRels() {
    const rels = this.sheets.map((_, i) =>
      `<Relationship Id="rId${i + 1}" ` +
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ` +
      `Target="worksheets/sheet${i + 1}.xml"/>`
    ).join('');
    const stylesId = this.sheets.length + 1;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels}<Relationship Id="rId${stylesId}" ` +
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ` +
      `Target="styles.xml"/></Relationships>`;
  }

  sheetXml(sheet) {
    const { columns, rows, note } = sheet;
    const headerRow = note ? 2 : 1;
    const parts = [];

    // Ширина столбцов: по самому длинному значению, но в разумных пределах
    const cols = columns.map((column, i) => {
      const header = String(column.title || column.key || '').length;
      let longest = header;
      for (const row of rows.slice(0, 400)) {
        const text = row[column.key];
        if (text != null) longest = Math.max(longest, String(text).length);
      }
      const width = column.width || Math.min(Math.max(longest + 2, 8), 52);
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
    }).join('');

    // Пояснение над таблицей
    if (note) {
      parts.push(`<row r="1"><c r="A1" t="inlineStr" s="3">` +
        `<is><t>${escapeXml(note)}</t></is></c></row>`);
    }

    // Шапка
    const headerCells = columns.map((column, i) =>
      `<c r="${columnLetter(i + 1)}${headerRow}" t="inlineStr" s="1">` +
      `<is><t>${escapeXml(column.title || column.key)}</t></is></c>`
    ).join('');
    parts.push(`<row r="${headerRow}" ht="20" customHeight="1">${headerCells}</row>`);

    // Данные
    rows.forEach((row, rowIndex) => {
      const r = headerRow + 1 + rowIndex;
      const cells = columns.map((column, i) => {
        const ref = `${columnLetter(i + 1)}${r}`;
        const value = row[column.key];
        if (value === null || value === undefined || value === '') return '';

        const numeric = column.type === 'number' || column.type === 'integer';
        if (numeric && typeof value === 'number' && Number.isFinite(value)) {
          const style = column.type === 'integer' ? 2 : 4;
          return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
      }).join('');
      parts.push(`<row r="${r}">${cells}</row>`);
    });

    const lastColumn = columnLetter(Math.max(columns.length, 1));
    const lastRow = headerRow + rows.length;
    // Закрепляем строку заголовка и включаем автофильтр: без них
    // таблицей на несколько сотен строк невозможно пользоваться
    const freeze = `<sheetViews><sheetView workbookViewId="0">` +
      `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" ` +
      `activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
    const filter = rows.length
      ? `<autoFilter ref="A${headerRow}:${lastColumn}${lastRow}"/>` : '';

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${freeze}<cols>${cols}</cols><sheetData>${parts.join('')}</sheetData>${filter}</worksheet>`;
  }
}

// ---------------------------------------------------------------------
//  Неизменяемые части книги
// ---------------------------------------------------------------------

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

/**
 * Оформление. Нумерация ссылок важна: cellXfs идут по порядку,
 * и на них ссылается атрибут s= у ячейки.
 *   0 - обычная ячейка
 *   1 - шапка: полужирный на сером фоне с рамкой снизу
 *   2 - целое число
 *   3 - пояснение над таблицей
 *   4 - число с двумя знаками
 */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="#,##0"/>
<numFmt numFmtId="165" formatCode="#,##0.00"/>
</numFmts>
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><i/><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEDF1F3"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFB0BAC2"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

module.exports = { Workbook, buildZip, columnLetter, escapeXml };
