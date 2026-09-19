# Airbnb Tax & Accounting Assistant (Cloudflare Worker)

Gyors, megbízható és automatizált adó- és könyvelési lekérdező felület a Lodgify-ban kezelt Airbnb apartmanokhoz (`The Tucan`, `The Colibri`, `The Albatros`, `The Pirate`, `The Banana`).

## Főbb Funkciók

1. **Könyvelési Hónap Automatizmus:**
   - Az Airbnb a vendég érkezését (Check-in) követő napon utalja át a bevételt a bankszámlára.
   - Ezért az adott hónap első banki jóváírása az **előző hónap utolsó napján becheckolt vendégtől** származik.
   - Az adott hónap utolsó napján becheckolt vendég kifizetése már csak a következő hónapban érkezik a bankszámlára.
   - Amikor kiválasztasz egy hónapot (pl. **2026 Szeptember**), a rendszer automatikusan a `2026-08-31` – `2026-09-29` közötti érkezési időszakot állítja be, így a bankba érkezési dátumok pontosan **2026-09-01 – 2026-09-30** közé esnek.

2. **Rendszer-túlterhelés Védelem ("Ne terheljük túl a rendszert"):**
   - A lekérdezések nem a lassú és 429-es hibákra hajlamos külső API-t bombázzák minden kattintáskor, hanem a Cloudflare D1 relációs adatbázisból másodperctöredék alatt (1-2 ms) szolgálják ki az adatokat.

3. **Apartmanok és Kimenetek:**
   - Apartmanonkénti vagy Összes Apartman (`Everything`) szerinti bontás.
   - HTML Táblázat statisztikai KPI kártyákkal és nyomtatási nézettel.
   - Excel-kompatibilis CSV letöltés (UTF-8 BOM támogatással).

## Helyi Szinkronizálás (Sync)

Ha frissíteni szeretnéd a Lodgify-ból a foglalási adatokat az adatbázisba:
```bash
npm run sync
# vagy:
node sync.js
```

## Telepítés (Deploy)

Cloudflare Worker deploy:
```bash
npm run deploy
```

## Elérési Útvonal

- **Élő URL:** `https://ferkomes.com/987rhfkwjscdgm347364rgyeubdfcjsk4efwhi/tax`
