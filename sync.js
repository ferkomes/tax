// Standalone Lodgify -> Cloudflare D1 Tax Sync Runner
// Run anytime locally with: node sync.js or npm run sync

const { execSync } = require('child_process');
const fs = require('fs');

const LODGIFY_API_KEY = process.env.LODGIFY_API_KEY || "JyVLrOAsPcxki39vyFGZ6H6RuXDpzbNFZTyIc//fMGJb51Zklzvj4aHnndsnx05C";

const PROPERTIES_MAP = {
  569854: "The Albatros",
  569855: "The Banana",
  573525: "The Colibri",
  569856: "The Pirate",
  569857: "The Tucan"
};

async function sync() {
  console.log("🚀 Starting Lodgify Airbnb reservation fetch for tax database...");

  let offset = 0;
  const limit = 50;
  let allItems = [];

  // Fetch reservations from 2025 through 2027
  while (offset < 800) {
    const url = `https://api.lodgify.com/v1/reservation?offset=${offset}&limit=${limit}&trash=false&periodStart=2025-01-01&periodEnd=2027-01-01`;
    const resp = await fetch(url, {
      headers: {
        "X-ApiKey": LODGIFY_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!resp.ok) {
      throw new Error(`Lodgify API error: HTTP ${resp.status} - ${await resp.text()}`);
    }

    const data = await resp.json();
    if (!data.items || !data.items.length) break;

    allItems.push(...data.items);
    if (data.items.length < limit) break;
    offset += limit;
    await new Promise(r => setTimeout(r, 250));
  }

  // Filter only booked Airbnb reservations
  const airbnb = allItems.filter(i =>
    (i.source || "").toLowerCase() === "airbnbintegration" &&
    (i.status || "").toLowerCase() === "booked" &&
    !i.is_deleted
  );

  console.log(`📦 Fetched ${allItems.length} total items, found ${airbnb.length} active Airbnb bookings.`);

  const mapped = airbnb.map(item => {
    let confirmationCode = "N/A";
    if (item.source_text) {
      try {
        const st = typeof item.source_text === "string" ? JSON.parse(item.source_text) : item.source_text;
        if (st.confirmationCode) confirmationCode = st.confirmationCode;
      } catch (e) {}
    }
    if (confirmationCode === "N/A" && item.external_booking) {
      try {
        const ext = typeof item.external_booking === "string" ? JSON.parse(item.external_booking) : item.external_booking;
        confirmationCode = ext["Confirmation Code"] || ext.ConfirmationCode || confirmationCode;
      } catch (e) {}
    }

    const arr = item.arrival ? item.arrival.slice(0, 10) : "";
    const dep = item.departure ? item.departure.slice(0, 10) : "";
    let nights = 0;
    if (arr && dep) {
      nights = Math.round((new Date(dep) - new Date(arr)) / 86400000);
    }

    let bankArrivalDate = "";
    if (arr) {
      const d = new Date(arr);
      d.setDate(d.getDate() + 1);
      bankArrivalDate = d.toISOString().slice(0, 10);
    }

    const propName = PROPERTIES_MAP[item.property_id] || item.property_name || "Unknown";
    const guestName = item.guest?.name || "";
    const totalAmount = parseFloat(item.total_amount) || 0;

    return {
      booking_id: String(item.id).replace(".0", ""),
      property_name: propName,
      confirmation_code: confirmationCode,
      guest_name: guestName,
      arrival: arr,
      departure: dep,
      nights,
      total_amount: totalAmount,
      bank_arrival_date: bankArrivalDate,
      source: item.source,
      status: item.status
    };
  });

  console.log(`💾 Inserting ${mapped.length} rows into Cloudflare D1...`);

  const BATCH_SIZE = 25;
  for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
    const chunk = mapped.slice(i, i + BATCH_SIZE);
    let sql = "";
    for (const r of chunk) {
      const esc = (s) => (s ? String(s).replace(/'/g, "''") : "");
      sql += `INSERT INTO tax_bookings (booking_id, property_name, confirmation_code, guest_name, arrival, departure, nights, total_amount, bank_arrival_date, source, status) VALUES ('${esc(r.booking_id)}', '${esc(r.property_name)}', '${esc(r.confirmation_code)}', '${esc(r.guest_name)}', '${esc(r.arrival)}', '${esc(r.departure)}', ${r.nights}, ${r.total_amount}, '${esc(r.bank_arrival_date)}', '${esc(r.source)}', '${esc(r.status)}') ON CONFLICT(booking_id) DO UPDATE SET property_name=excluded.property_name, confirmation_code=excluded.confirmation_code, guest_name=excluded.guest_name, arrival=excluded.arrival, departure=excluded.departure, nights=excluded.nights, total_amount=excluded.total_amount, bank_arrival_date=excluded.bank_arrival_date, source=excluded.source, status=excluded.status; `;
    }
    const tempFile = `.batch_${i}.sql`;
    fs.writeFileSync(tempFile, sql);
    try {
      execSync(`npx wrangler d1 execute cleaning-data-sheet --remote --file=${tempFile}`, { stdio: "ignore" });
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  }

  console.log(`🎉 SUCCESS! Updated ${mapped.length} tax bookings in Cloudflare D1.`);
}

sync().catch(err => {
  console.error("❌ Sync failed:", err);
  process.exit(1);
});
