// Cloudflare Worker for Tax & Airbnb Accounting
// Protected with HTTP Basic Auth (Admin / Kurvaanyad1!)
// Clean, single-table CSV export for accountant (no repeated sub-headers or empty lines)
// Monthly helper with automated accounting check-in window

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const TARGET_PATH = '/987rhfkwjscdgm347364rgyeubdfcjsk4efwhi/tax';

      if (!url.pathname.startsWith(TARGET_PATH)) {
        return new Response('Not Found', { status: 404 });
      }

      // --- HTTP BASIC AUTHENTICATION ---
      const auth = authenticateUser(request);
      if (!auth) {
        return unauthorizedResponse();
      }

      // --- DEBUG LOGGING SETUP ---
      let debugLogs = [];
      const log = (msg) => {
        const time = new Date().toISOString().split('T')[1].split('.')[0];
        const logMsg = `[${time}] ${msg}`;
        debugLogs.push(logMsg);
        console.log(logMsg);
      };

      log(`Worker indult. Felhasználó: ${auth.username}, Metódus: ${request.method}`);

      let startDateParam, endDateParam, apartmentName, outputType, headerPeriodText = '';

      if (request.method === 'POST') {
        const formData = await request.formData();
        const monthValue = formData.get('month');
        const customStart = formData.get('customStartDate');
        const customEnd = formData.get('customEndDate');

        apartmentName = formData.get('apartment') || 'Everything';
        outputType = formData.get('outputType') || 'table';

        if (customStart && customEnd) {
          startDateParam = customStart.trim();
          endDateParam = customEnd.trim();
          headerPeriodText = `${startDateParam} - ${endDateParam}`;
        } else if (monthValue) {
          const parts = monthValue.split('|');
          startDateParam = parts[0];
          endDateParam = parts[1];
          headerPeriodText = parts[2] || `${startDateParam} - ${endDateParam}`;
        }
      } else {
        const customStart = url.searchParams.get('customStartDate');
        const customEnd = url.searchParams.get('customEndDate');
        const start = url.searchParams.get('startDate');
        const end = url.searchParams.get('endDate');
        const periodParam = url.searchParams.get('period');
        const monthValue = url.searchParams.get('month');

        apartmentName = url.searchParams.get('apartment') || 'Everything';
        outputType = url.searchParams.get('outputType') || 'table';

        if (start && end) {
          startDateParam = start.trim();
          endDateParam = end.trim();
          headerPeriodText = periodParam || `${startDateParam} - ${endDateParam}`;
        } else if (customStart && customEnd) {
          startDateParam = customStart.trim();
          endDateParam = customEnd.trim();
          headerPeriodText = `${startDateParam} - ${endDateParam}`;
        } else if (monthValue) {
          const parts = monthValue.split('|');
          startDateParam = parts[0];
          endDateParam = parts[1];
          headerPeriodText = parts[2] || `${startDateParam} - ${endDateParam}`;
        }
      }

      // Ha nincsenek dátum paraméterek, megjelenítjük az űrlapot
      if (!startDateParam || !endDateParam) {
        log('Nincsenek dátum paraméterek, űrlap megjelenítése.');
        return new Response(getHtmlForm(TARGET_PATH, auth.username), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      log(`Lekérdezés: Kezdés=${startDateParam}, Vége=${endDateParam}, Apartman=${apartmentName}, Időszak=${headerPeriodText}`);

      const startDate = new Date(startDateParam + 'T00:00:00Z');
      const endDate = new Date(endDateParam + 'T23:59:59Z');

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return renderErrorPage('Érvénytelen dátum formátum.', debugLogs);
      }

      const allApartmentNames = ['The Tucan', 'The Colibri', 'The Albatros', 'The Pirate', 'The Banana'];
      let allBookingData = [];

      // Adatok lekérdezése Cloudflare D1 adatbázisból
      try {
        if (env.DB) {
          log(`==> D1 lekérdezése: érkezés ${startDateParam} és ${endDateParam} között...`);
          let sql = `SELECT * FROM tax_bookings WHERE arrival >= ? AND arrival <= ?`;
          const sqlParams = [startDateParam, endDateParam];

          if (apartmentName !== 'Everything') {
            sql += ` AND property_name = ?`;
            sqlParams.push(apartmentName);
          }
          sql += ` ORDER BY departure ASC`;

          const queryRes = await env.DB.prepare(sql).bind(...sqlParams).all();
          const rows = queryRes.results || [];
          log(`<== D1 találatok száma: ${rows.length}`);

          for (const row of rows) {
            const departureDate = new Date(row.departure + 'T00:00:00Z');
            const arrivalDate = new Date(row.arrival + 'T00:00:00Z');

            const arrivalDatePlusOneDay = new Date(arrivalDate);
            arrivalDatePlusOneDay.setUTCDate(arrivalDatePlusOneDay.getUTCDate() + 1);

            const formattedDepartureDate = formatHungarianDate(departureDate);
            const formattedArrivalDatePlusOneDay = formatHungarianDate(arrivalDatePlusOneDay);

            const totalAmount = parseFloat(row.total_amount) || 0;
            const totalAmountTimes015 = totalAmount * 0.15;
            const totalAmountTimes085 = totalAmount * 0.85;

            allBookingData.push({
              confirmationCode: row.confirmation_code || 'N/A',
              departureDateValue: departureDate.getTime(),
              formattedDepartureDate,
              nights: row.nights || 0,
              guestName: row.guest_name || '',
              totalAmount,
              totalAmountTimes015,
              totalAmountTimes085,
              formattedArrivalDatePlusOneDay,
              propertyName: row.property_name
            });
          }
        }
      } catch (d1Err) {
        log(`[HIBA] D1 hiba: ${d1Err.message}`);
      }

      log(`Összes feldolgozott foglalás: ${allBookingData.length}`);

      // Rendezés távozási dátum szerint növekvő sorrendbe (mint az eredeti kódban)
      allBookingData.sort((a, b) => a.departureDateValue - b.departureDateValue);

      // PONTOSAN AZ EREDETI OSZLOPOK FEJLÉCEI
      const headers = [
        'Foglalási szám',
        'Kijelentkezés dátuma',
        'Éjszakák száma',
        'Vendég neve',
        'Vendég által fizetett teljes díj',
        'Booking/AirBnB jutaléka',
        'Kezelési költség',
        'Bankszámlára érkezett összeg',
        'Bankba érkezés dátuma'
      ];

      const totalNights = allBookingData.reduce((sum, item) => sum + item.nights, 0);
      const totalGuestPaid = allBookingData.reduce((sum, item) => sum + item.totalAmount, 0);
      const totalCommission = allBookingData.reduce((sum, item) => sum + item.totalAmountTimes015, 0);
      const totalBankszamlara = allBookingData.reduce((sum, item) => sum + item.totalAmountTimes085, 0);

      const formattedTotals = {
        totalNights,
        totalGuestPaid: `€${totalGuestPaid.toFixed(2)}`,
        totalCommission: `€${totalCommission.toFixed(2)}`,
        totalBankszamlara: `€${totalBankszamlara.toFixed(2)}`
      };

      const headerApartmanName = apartmentName === 'Everything' ? 'Összes Apartman' : apartmentName;
      const tableHeader = `KUNDOLF FERENC, 164 ${headerApartmanName} - ${headerPeriodText}`;

      // --- CSV LETÖLTÉS (EGYSÉGES, TISZTA, FÖLÖSLEGES ISMÉTLŐDÉSEKTŐL MENTES TÁBLÁZAT) ---
      if (outputType === 'csv') {
        log('Kimenet formátuma: CSV');

        // Egyetlen egységes táblázat generálása: nincs 5-ször ismétlődő fejléc vagy üres sor
        const csvContent = '\uFEFF' + generateCleanCsv(allBookingData, headers, formattedTotals, tableHeader);

        // Biztonságos ASCII fájlnév az HTTP fejléchez (kizárja a Cloudflare ByteString hibát)
        const safeBase = sanitizeAscii(`KUNDOLF_FERENC_164_${headerApartmanName}_${headerPeriodText}`);
        const filename = `${safeBase}.csv`;

        return new Response(csvContent, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        });
      }

      // --- HTML TÁBLÁZAT KIMENET ---
      log('Kimenet formátuma: HTML Táblázat');
      const htmlTable = generateHtmlTable(
        allBookingData,
        headers,
        formattedTotals,
        tableHeader,
        apartmentName,
        allApartmentNames,
        headerPeriodText,
        startDateParam,
        endDateParam,
        TARGET_PATH,
        debugLogs,
        auth.username
      );

      return new Response(htmlTable, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    } catch (fatalErr) {
      return new Response(`Szerverhiba:\n${fatalErr.message}\n\nStack:\n${fatalErr.stack}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }
};

// --- AUTHENTICATION SEGÉDFÜGGVÉNYEK ---

function authenticateUser(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return null;
  }
  try {
    const base64Credentials = authHeader.substring(6).trim();
    const decoded = atob(base64Credentials);
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) return null;
    const user = decoded.substring(0, colonIndex).trim();
    const pass = decoded.substring(colonIndex + 1).trim();

    // Felhasználó: Admin (vagy admin), Jelszó: Kurvaanyad1!
    if (pass === 'Kurvaanyad1!' && (user.toLowerCase() === 'admin' || !user)) {
      return { role: 'admin', username: user || 'Admin' };
    }
    if (pass === 'Kurvaanyad1!') {
      return { role: 'admin', username: user || 'Admin' };
    }
    return null;
  } catch (e) {
    return null;
  }
}

function unauthorizedResponse(msg = 'Hozzáférés megtagadva: Kérlek jelentkezz be.') {
  return new Response(msg, {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Airbnb Tax Accounting", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8'
    }
  });
}

// --- DÁTUM ÉS SZÖVEG SEGÉDFÜGGVÉNYEK ---

function sanitizeAscii(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function formatHungarianDate(date) {
  if (!date || isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('hu-HU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

function getMonthData() {
  const monthsHu = [
    'Január', 'Február', 'Március', 'Április', 'Május', 'Június',
    'Július', 'Augusztus', 'Szeptember', 'Október', 'November', 'December'
  ];
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];
  const list = [];

  for (const y of years) {
    for (let m = 1; m <= 12; m++) {
      // Könyvelési szabály az Airbnb kifizetésekhez:
      // Az adott hónap első banki befizetése az előző hónap utolsó napján érkezett vendég után jön (+1 nap)
      const prevMonthLastDay = new Date(Date.UTC(y, m - 1, 0));
      // Az adott hónap utolsó napján bejelentkező vendég pénze már a következő hónapban érkezik!
      const currMonthLastDay = new Date(Date.UTC(y, m, 0));
      const penultimateDay = new Date(Date.UTC(y, m, -1));

      const startStr = prevMonthLastDay.toISOString().split('T')[0];
      const endStr = penultimateDay.toISOString().split('T')[0];

      const bankStartStr = `${y}-${String(m).padStart(2, '0')}-01`;
      const bankEndStr = currMonthLastDay.toISOString().split('T')[0];

      const monthName = monthsHu[m - 1];
      const periodLabel = `${y} ${monthName}`;
      const label = `${y} ${monthName} (Érkezés: ${startStr} – ${endStr} | Bank: ${bankStartStr} – ${bankEndStr})`;

      list.push({
        year: y,
        month: m,
        periodLabel,
        label,
        value: `${startStr}|${endStr}|${periodLabel}`,
        startStr,
        endStr,
        bankStartStr,
        bankEndStr
      });
    }
  }
  return list;
}

// --- TISZTA, EGYSÉGES CSV GENERÁLÁS A KÖNYVELŐNEK ---
// Nincs benne semmi fölösleges: 1 címsor, 1 fejlécsor, az adatsorok, és 1 Összesen sor a végén.
function generateCleanCsv(data, headers, totals, tableHeader) {
  const csvRows = [];

  // 1. Cím sor
  csvRows.push(`"${tableHeader.replace(/"/g, '""')}"`);

  // 2. Pontos oszlopfejlécek
  csvRows.push(headers.map(h => `"${h.replace(/"/g, '""')}"`).join(','));

  // 3. Foglalási adatsorok
  for (const item of data) {
    const row = [
      item.confirmationCode,
      item.formattedDepartureDate,
      item.nights,
      item.guestName,
      `€${item.totalAmount.toFixed(2)}`,
      `€${item.totalAmountTimes015.toFixed(2)}`,
      `€0.00`,
      `€${item.totalAmountTimes085.toFixed(2)}`,
      item.formattedArrivalDatePlusOneDay
    ];

    const escapedRow = row.map(cell => {
      let processedCell = String(cell).replace(/"/g, '""');
      if (processedCell.match(/[,\s€]/) || processedCell.includes('\n')) {
        return `"${processedCell}"`;
      }
      return processedCell;
    });
    csvRows.push(escapedRow.join(','));
  }

  // 4. Egyetlen Összesen sor a táblázat legalján
  const totalRow = [
    'Összesen:',
    '',
    totals.totalNights,
    '',
    totals.totalGuestPaid,
    totals.totalCommission,
    `€0.00`,
    totals.totalBankszamlara,
    ''
  ];

  const escapedTotalRow = totalRow.map(cell => `"${String(cell).replace(/"/g, '""')}"`);
  csvRows.push(escapedTotalRow.join(','));

  return csvRows.join('\n');
}

// --- HTML TÁBLÁZAT MEGJELENÍTÉSE ---

function generateHtmlTable(
  data,
  headers,
  totals,
  tableHeader,
  apartmentName,
  allApartmentNames,
  headerPeriodText,
  startDateParam,
  endDateParam,
  targetPath,
  debugLogs,
  username
) {
  const isEverything = apartmentName === 'Everything';
  const csvDownloadUrl = `${targetPath}?startDate=${startDateParam}&endDate=${endDateParam}&apartment=${encodeURIComponent(apartmentName)}&period=${encodeURIComponent(headerPeriodText)}&outputType=csv`;

  return `<!DOCTYPE html>
<html lang="hu">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Adó- és Könyvelési Adatok - ${tableHeader}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --success: #10b981;
      --accent: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
      line-height: 1.5;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 24px;
      background: white;
      padding: 20px 24px;
      border-radius: 12px;
      border: 1px solid var(--border);
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    h1 { font-size: 20px; font-weight: 700; color: var(--text); }
    .actions { display: flex; gap: 12px; align-items: center; }
    .user-badge {
      font-size: 13px;
      font-weight: 600;
      background: #f1f5f9;
      color: #334155;
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 600;
      border-radius: 8px;
      text-decoration: none;
      border: none;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-secondary { background: #f1f5f9; color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: #e2e8f0; }

    /* Summary KPI Cards */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .kpi-card {
      background: white;
      padding: 18px 20px;
      border-radius: 12px;
      border: 1px solid var(--border);
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .kpi-title { font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .kpi-value { font-size: 24px; font-weight: 700; color: var(--text); margin-top: 6px; }
    .kpi-value.green { color: #059669; }
    .kpi-value.blue { color: #2563eb; }
    .kpi-value.orange { color: #d97706; }

    /* Info Badge */
    .info-box {
      background: #eff6ff;
      border-left: 4px solid var(--primary);
      padding: 12px 16px;
      border-radius: 6px;
      font-size: 13px;
      color: #1e40af;
      margin-bottom: 24px;
    }

    /* Tables */
    .table-section {
      background: white;
      border-radius: 12px;
      border: 1px solid var(--border);
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      margin-bottom: 30px;
      overflow: hidden;
    }
    .table-section-title {
      padding: 16px 20px;
      font-size: 16px;
      font-weight: 700;
      background: #f8fafc;
      border-bottom: 1px solid var(--border);
      color: #334155;
    }
    .table-responsive { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
    th {
      background: #f1f5f9;
      color: #475569;
      font-weight: 600;
      padding: 12px 16px;
      border-bottom: 2px solid var(--border);
      white-space: nowrap;
    }
    td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      color: #1e293b;
      white-space: nowrap;
    }
    tr:nth-child(even) { background-color: #f8fafc; }
    tr:hover { background-color: #f1f1f1; }
    .total-row td {
      font-weight: 700;
      background: #e2e8f0 !important;
      border-top: 2px solid #cbd5e1;
      color: #0f172a;
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      background: #e0f2fe;
      color: #0369a1;
    }

    /* Debug */
    details { margin-top: 30px; background: white; padding: 16px; border-radius: 8px; border: 1px solid var(--border); }
    summary { font-weight: 600; cursor: pointer; color: var(--text-muted); }
    textarea { width: 100%; height: 180px; font-family: monospace; font-size: 12px; margin-top: 10px; padding: 10px; background: #0f172a; color: #38bdf8; border-radius: 6px; }

    @media print {
      body { background: white; padding: 0; }
      .header-bar .actions, details { display: none !important; }
      .table-section { box-shadow: none; border: 1px solid #000; }
      th, td { border: 1px solid #ccc; font-size: 11px; padding: 6px 8px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <div>
        <h1>${tableHeader}</h1>
        <div style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">
          Foglalási időszak: <strong>${startDateParam} – ${endDateParam}</strong>
        </div>
      </div>
      <div class="actions">
        <span class="user-badge">👤 ${username}</span>
        <a href="${targetPath}" class="btn btn-secondary">🔍 Új Lekérdezés</a>
        <a href="${csvDownloadUrl}" class="btn btn-primary">
          📥 CSV Letöltése (Excel)
        </a>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-title">Összes Éjszaka</div>
        <div class="kpi-value blue">${totals.totalNights} éj</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Vendég által fizetett összeg</div>
        <div class="kpi-value">${totals.totalGuestPaid}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Booking/AirBnB jutaléka</div>
        <div class="kpi-value orange">${totals.totalCommission}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Bankszámlára érkezett összeg</div>
        <div class="kpi-value green">${totals.totalBankszamlara}</div>
      </div>
    </div>

    <div class="info-box">
      💡 <strong>Könyvelési szabály:</strong> Az Airbnb az érkezést követő napon utal. Ezért a hónap első banki jóváírása az előző hónap utolsó napján becheckolt vendégtől származik, míg a hónap utolsó napján becheckolt vendég összege már csak a következő hónapban érkezik a számlára.
    </div>

    ${isEverything ? renderEverythingApartments(data, headers, allApartmentNames, headerPeriodText, totals) : renderSingleApartmentTable(data, headers, totals, tableHeader)}

    <details>
      <summary>Rendszernaplók (Debug Logok)</summary>
      <textarea readonly>${debugLogs.join('\n')}</textarea>
    </details>
  </div>
</body>
</html>`;
}

function renderSingleApartmentTable(data, headers, totals, title) {
  return `
  <div class="table-section">
    <div class="table-responsive">
      <table>
        <thead>
          <tr>
            ${headers.map(h => `<th>${h}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${data.length === 0 ? `<tr><td colspan="${headers.length}" style="text-align: center; padding: 30px; color: #94a3b8;">Nincs találat ebben az időszakban.</td></tr>` : ''}
          ${data.map(item => `
            <tr>
              <td><span class="badge">${item.confirmationCode}</span></td>
              <td>${item.formattedDepartureDate}</td>
              <td>${item.nights}</td>
              <td><strong>${item.guestName}</strong></td>
              <td>€${item.totalAmount.toFixed(2)}</td>
              <td>€${item.totalAmountTimes015.toFixed(2)}</td>
              <td>€0.00</td>
              <td><strong>€${item.totalAmountTimes085.toFixed(2)}</strong></td>
              <td>${item.formattedArrivalDatePlusOneDay}</td>
            </tr>
          `).join('')}
          <tr class="total-row">
            <td>Összesen:</td>
            <td></td>
            <td>${totals.totalNights}</td>
            <td></td>
            <td>${totals.totalGuestPaid}</td>
            <td>${totals.totalCommission}</td>
            <td>€0.00</td>
            <td>${totals.totalBankszamlara}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderEverythingApartments(data, headers, apartmentNames, periodText, grandTotals) {
  let html = '';

  for (const name of apartmentNames) {
    const aptData = data.filter(i => i.propertyName === name);
    if (aptData.length === 0) continue;

    const aptTotals = {
      totalNights: aptData.reduce((sum, item) => sum + item.nights, 0),
      totalGuestPaid: `€${aptData.reduce((sum, item) => sum + item.totalAmount, 0).toFixed(2)}`,
      totalCommission: `€${aptData.reduce((sum, item) => sum + item.totalAmountTimes015, 0).toFixed(2)}`,
      totalBankszamlara: `€${aptData.reduce((sum, item) => sum + item.totalAmountTimes085, 0).toFixed(2)}`
    };

    html += `
    <div class="table-section">
      <div class="table-section-title">🏡 ${name} - ${periodText} (${aptData.length} foglalás)</div>
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              ${headers.map(h => `<th>${h}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${aptData.map(item => `
              <tr>
                <td><span class="badge">${item.confirmationCode}</span></td>
                <td>${item.formattedDepartureDate}</td>
                <td>${item.nights}</td>
                <td><strong>${item.guestName}</strong></td>
                <td>€${item.totalAmount.toFixed(2)}</td>
                <td>€${item.totalAmountTimes015.toFixed(2)}</td>
                <td>€0.00</td>
                <td><strong>€${item.totalAmountTimes085.toFixed(2)}</strong></td>
                <td>${item.formattedArrivalDatePlusOneDay}</td>
              </tr>
            `).join('')}
            <tr class="total-row">
              <td>Összesen:</td>
              <td></td>
              <td>${aptTotals.totalNights}</td>
              <td></td>
              <td>${aptTotals.totalGuestPaid}</td>
              <td>${aptTotals.totalCommission}</td>
              <td>€0.00</td>
              <td>${aptTotals.totalBankszamlara}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`;
  }

  // Nagy összesen blokk
  html += `
  <div class="table-section" style="border: 2px solid var(--primary);">
    <div class="table-section-title" style="background: #eff6ff; color: var(--primary);">⭐ NAGY ÖSSZESEN (Minden Apartman Együtt)</div>
    <div class="table-responsive">
      <table>
        <thead>
          <tr>
            ${headers.map(h => `<th>${h}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          <tr class="total-row" style="font-size: 15px;">
            <td>NAGY ÖSSZESEN:</td>
            <td></td>
            <td>${grandTotals.totalNights}</td>
            <td></td>
            <td>${grandTotals.totalGuestPaid}</td>
            <td>${grandTotals.totalCommission}</td>
            <td>€0.00</td>
            <td>${grandTotals.totalBankszamlara}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>`;

  return html;
}

// --- FORM MEGJELENÍTÉSE ---

function getHtmlForm(targetPath, username) {
  const apartmentNames = ['Everything', 'The Tucan', 'The Colibri', 'The Albatros', 'The Pirate', 'The Banana'];
  const monthsData = getMonthData();

  const now = new Date();
  const currentY = now.getFullYear();
  const currentM = now.getMonth() + 1;
  const defaultMonthObj = monthsData.find(m => m.year === currentY && m.month === currentM) || monthsData[monthsData.length - 1];
  const defaultMonthValue = defaultMonthObj ? defaultMonthObj.value : '';

  return `<!DOCTYPE html>
<html lang="hu">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Airbnb Adó- és Könyvelési Lekérdező</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --bg: #f1f5f9;
      --card-bg: #ffffff;
      --border: #cbd5e1;
      --text: #0f172a;
      --text-muted: #64748b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .form-container {
      width: 100%;
      max-width: 650px;
      background: white;
      padding: 36px;
      border-radius: 16px;
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.08), 0 8px 10px -6px rgba(0,0,0,0.04);
      border: 1px solid var(--border);
    }
    .top-user {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .user-pill {
      background: #e2e8f0;
      color: #334155;
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: 600;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 8px;
    }
    p.subtitle {
      font-size: 14px;
      color: var(--text-muted);
      margin-bottom: 24px;
    }
    .form-group { margin-bottom: 20px; }
    label {
      display: block;
      font-weight: 600;
      font-size: 14px;
      color: #334155;
      margin-bottom: 8px;
    }
    select, input[type="text"] {
      width: 100%;
      padding: 12px 14px;
      font-size: 15px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: white;
      color: var(--text);
      transition: border-color 0.2s;
    }
    select:focus, input[type="text"]:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(37,99,235,0.15);
    }
    .help-card {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      padding: 14px 16px;
      font-size: 13px;
      color: #1e40af;
      margin-top: 10px;
      line-height: 1.5;
    }
    .help-card strong { color: #1e3a8a; }
    .or-divider {
      display: flex;
      align-items: center;
      text-align: center;
      margin: 24px 0 16px 0;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .or-divider::before, .or-divider::after {
      content: '';
      flex: 1;
      border-bottom: 1px solid #e2e8f0;
    }
    .or-divider:not(:empty)::before { margin-right: 12px; }
    .or-divider:not(:empty)::after { margin-left: 12px; }
    .date-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    button.submit-btn {
      width: 100%;
      background: var(--primary);
      color: white;
      padding: 14px;
      font-size: 16px;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      margin-top: 24px;
      transition: background-color 0.2s, transform 0.1s;
    }
    button.submit-btn:hover { background: var(--primary-hover); }
    button.submit-btn:active { transform: scale(0.99); }
  </style>
</head>
<body>
  <div class="form-container">
    <div class="top-user">
      <span>Bejelentkezve: <strong class="user-pill">🔒 ${username}</strong></span>
    </div>
    <h1>🗓️ Airbnb Adó- és Könyvelési Lekérdező</h1>
    <p class="subtitle">Automatikus könyvelési dátumok az Airbnb banki jóváírási logikája alapján.</p>

    <form method="POST" action="${targetPath}">
      <!-- Hónap választó -->
      <div class="form-group">
        <label for="month">Könyvelési Hónap kiválasztása:</label>
        <select id="month" name="month" onchange="onMonthChange(this.value)">
          <option value="">-- Válassz egy hónapot --</option>
          ${monthsData.map(m => `
            <option value="${m.value}" ${m.value === defaultMonthValue ? 'selected' : ''}>
              ${m.label}
            </option>
          `).join('')}
        </select>

        <div id="monthHelp" class="help-card">
          📅 <strong>Automatikus könyvelési dátum-illesztés:</strong><br>
          Az Airbnb a vendég érkezését követő napon indítja a banki átutalást.
          Így az adott hónap első banki jóváírása az <strong>előző hónap utolsó napján becheckolt</strong> vendégtől származik,
          míg az <strong>adott hónap utolsó napján becheckolt</strong> vendég kifizetése már csak a következő hónapban érkezik!
        </div>
      </div>

      <div class="or-divider">VAGY EGYEDI DÁTUM MEGADÁSA</div>

      <!-- Egyedi dátum -->
      <div class="date-grid">
        <div class="form-group">
          <label for="customStartDate">Kezdő érkezési nap:</label>
          <input type="text" id="customStartDate" name="customStartDate" placeholder="YYYY-MM-DD (pl. 2026-08-31)">
        </div>
        <div class="form-group">
          <label for="customEndDate">Záró érkezési nap:</label>
          <input type="text" id="customEndDate" name="customEndDate" placeholder="YYYY-MM-DD (pl. 2026-09-29)">
        </div>
      </div>

      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;">

      <!-- Apartman és kimenet választó -->
      <div class="date-grid">
        <div class="form-group">
          <label for="apartment">Apartman:</label>
          <select id="apartment" name="apartment" required>
            ${apartmentNames.map(name => `
              <option value="${name}" ${name === 'Everything' ? 'selected' : ''}>
                ${name === 'Everything' ? '🌟 Összes Apartman (Everything)' : name}
              </option>
            `).join('')}
          </select>
        </div>

        <div class="form-group">
          <label for="outputType">Kimenet Típusa:</label>
          <select id="outputType" name="outputType" required>
            <option value="table" selected>📊 HTML Táblázat</option>
            <option value="csv">📥 CSV Letöltése (Excel)</option>
          </select>
        </div>
      </div>

      <button type="submit" class="submit-btn">Adatok Lekérdezése →</button>
    </form>
  </div>

  <script>
    function onMonthChange(val) {
      if (val) {
        document.getElementById('customStartDate').value = '';
        document.getElementById('customEndDate').value = '';
      }
    }
  </script>
</body>
</html>`;
}

function renderErrorPage(errorMsg, debugLogs) {
  return new Response(`
    <!DOCTYPE html>
    <html lang="hu">
    <head>
      <meta charset="UTF-8">
      <title>Hiba történt</title>
      <style>
        body { font-family: sans-serif; padding: 30px; background: #fff5f5; color: #991b1b; }
        .box { max-width: 700px; margin: 0 auto; background: white; padding: 24px; border-radius: 8px; border: 1px solid #fecaca; }
        textarea { width: 100%; height: 300px; font-family: monospace; font-size: 12px; background: #1e293b; color: #38bdf8; padding: 10px; border-radius: 6px; }
        button { padding: 10px 18px; background: #dc2626; color: white; border: none; border-radius: 6px; cursor: pointer; margin-top: 15px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h2>❌ Hiba történt a lekérdezés során!</h2>
        <p><strong>Hibaüzenet:</strong> ${errorMsg}</p>
        <h3 style="margin-top: 20px; color: #334155;">Rendszernaplók:</h3>
        <textarea readonly>${debugLogs.join('\n')}</textarea>
        <br><button onclick="window.history.back()">← Vissza az űrlaphoz</button>
      </div>
    </body>
    </html>
  `, {
    status: 500,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
