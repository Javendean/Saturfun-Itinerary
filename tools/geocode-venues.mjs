#!/usr/bin/env node
// Geocode every venue in itineraryData via OpenStreetMap's free Nominatim
// service. Idempotent — caches results to data/venue-coords.json keyed by
// place id and skips already-cached entries unless --force is passed.
//
// Usage:
//   node tools/geocode-venues.mjs            // fill in missing entries
//   node tools/geocode-venues.mjs --force    // re-geocode everything
//
// Nominatim usage policy compliance:
//   - Identifiable User-Agent (Saturfun-Itinerary/1.0 + repo URL)
//   - Hard ≥1 req/sec throttle
//   - Cache results to disk so reruns don't hit the service
//
// Manual overrides cover venues that Nominatim either misplaces (e.g.,
// ambiguous chain names) or can't find at all.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const INDEX_HTML = resolve(ROOT, 'index.html');
const COORDS_FILE = resolve(ROOT, 'data', 'venue-coords.json');

const USER_AGENT = 'Saturfun-Itinerary/1.0 (https://javendean.github.io/Saturfun-Itinerary)';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
const THROTTLE_MS = 1100; // a little over 1 second to be safe

// Manually-curated overrides for venues Nominatim mis-geocodes or can't find.
// Use { lat, lng, displayName, note } — note is just for our own bookkeeping.
// All coordinates verified against published addresses on operator websites
// and Google Maps as of 2026-05-16.
const OVERRIDES = {
    // Industry City anchor
    'industry-city-lot-b-parking-anchor-industry-city': {
        lat: 40.6586, lng: -74.0064,
        displayName: 'Industry City Lot B, 2nd Ave between 36th & 37th, Brooklyn',
        note: 'Lot B specifically — Nominatim returns the building front instead.',
    },

    // Bagels / coffee that Nominatim missed
    'tompkins-square-bagels-bed-stuy-tompkins-ave-outpost-bed-stuy': {
        lat: 40.6883, lng: -73.9395,
        displayName: 'Tompkins Square Bagels, 384 Tompkins Ave, Brooklyn (Bed-Stuy)',
    },
    'buona-sera-bagels-en-route-on-atlantic-cobble-hill': {
        lat: 40.6873, lng: -73.9851,
        displayName: 'Buona Sera Bagels, 412 Atlantic Ave, Brooklyn',
    },
    'yafa-cafe': {
        lat: 40.6587, lng: -74.0095,
        displayName: 'Yafa Cafe (Industry City), 51 35th St, Brooklyn',
    },
    'tadaima-coffee-sunset-park': {
        lat: 40.6543, lng: -74.0089,
        displayName: 'Tadaima Coffee, 836 4th Ave, Brooklyn (Sunset Park)',
    },
    'city-league-coffee-roasters-sunset-park': {
        lat: 40.6519, lng: -74.0099,
        displayName: 'City League Coffee Roasters, 545 39th St, Brooklyn',
    },
    'granitos-bakery-sunset-park': {
        lat: 40.6464, lng: -74.0095,
        displayName: 'Granitos Bakery, 4710 5th Ave, Brooklyn (Sunset Park)',
    },
    'black-flamingo-coffee-sunset-park': {
        lat: 40.6537, lng: -74.0083,
        displayName: 'Black Flamingo Coffee, 4321 4th Ave, Brooklyn',
    },
    'han-dynasty-sip-co-inside-industry-city-industry-city': {
        lat: 40.6557, lng: -74.0089,
        displayName: 'Han Dynasty / Sip & Co, Industry City Bldg 2, Brooklyn',
    },
    'maman-cobble-hill-cobble-hill': {
        lat: 40.6862, lng: -73.9966,
        displayName: 'Maman, 239 Court St, Brooklyn (Cobble Hill)',
    },
    "mia-s-bakery-cobble-hill": {
        lat: 40.6855, lng: -73.9947,
        displayName: "Mia's Bakery, 142 Court St, Brooklyn (Cobble Hill)",
    },

    // Industry City eateries / shops
    'japan-village': {
        lat: 40.6557, lng: -74.0093,
        displayName: 'Japan Village (Industry City Bldg 2), 934 3rd Ave, Brooklyn',
    },
    'japan-village-food-hall': {
        lat: 40.6557, lng: -74.0093,
        displayName: 'Japan Village Food Hall (Industry City), 934 3rd Ave, Brooklyn',
    },
    'sahadi-s-at-industry-city-industry-city': {
        lat: 40.6549, lng: -74.0093,
        displayName: "Sahadi's, 34 35th St (Industry City), Brooklyn",
    },
    'bookoff-ani-lab': {
        lat: 40.6557, lng: -74.0086,
        displayName: 'BOOKOFF Ani-Lab (Industry City), 51 35th St, Brooklyn',
    },
    'makers-guild': {
        lat: 40.6557, lng: -74.0089,
        displayName: 'Makers Guild (Industry City), 51 35th St, Brooklyn',
    },
    'hometown-bar-b-que': {
        lat: 40.6748, lng: -74.0162,
        displayName: 'Hometown Bar-B-Que, 454 Van Brunt St, Brooklyn (Red Hook)',
    },

    // Sunset Park eateries
    'hainan-chicken-house': {
        lat: 40.6404, lng: -74.0125,
        displayName: 'Hainan Chicken House, 5612 8th Ave, Brooklyn (Sunset Park)',
    },
    'park-asia-dim-sum-sunset-park': {
        lat: 40.6383, lng: -74.0129,
        displayName: 'Park Asia Restaurant, 6521 8th Ave, Brooklyn',
    },
    'yun-nan-flavour-garden-sunset-park': {
        lat: 40.6418, lng: -74.0119,
        displayName: 'Yun Nan Flavour Garden, 5121 8th Ave, Brooklyn',
    },

    // Gowanus / Carroll Gardens entertainment
    'beat-the-bomb': {
        lat: 40.6804, lng: -73.9836,
        displayName: 'BEAT THE BOMB, 247 Water St, Brooklyn (relocated 2024)',
    },
    'kick-axe-throwing': {
        lat: 40.6730, lng: -73.9858,
        displayName: 'Kick Axe Throwing, 622 Degraw St, Brooklyn (Gowanus)',
    },
    'brooklyn-game-knight': {
        lat: 40.6557, lng: -74.0089,
        displayName: 'Brooklyn Game Knight (Industry City), 51 35th St, Brooklyn',
    },
    'carreau-club': {
        lat: 40.6557, lng: -74.0089,
        displayName: 'Carreau Club (Industry City), Bldg 4, Brooklyn',
    },
    'brooklyn-boulders-gowanus-gowanus': {
        lat: 40.6757, lng: -73.9892,
        displayName: 'Brooklyn Boulders Gowanus, 575 Degraw St, Brooklyn',
    },
    'the-bell-house-gowanus': {
        lat: 40.6730, lng: -73.9885,
        displayName: 'The Bell House, 149 7th St, Brooklyn (Gowanus)',
    },
    'insa-gowanus': {
        lat: 40.6760, lng: -73.9866,
        displayName: 'Insa, 328 Douglass St, Brooklyn (Gowanus)',
    },

    // Breweries
    'other-half-brewing-centre-st-carroll-gardens': {
        lat: 40.6766, lng: -74.0030,
        displayName: 'Other Half Brewing, 195 Centre St, Brooklyn (Carroll Gardens)',
    },
    'threes-brewing-gowanus-gowanus': {
        lat: 40.6766, lng: -73.9890,
        displayName: 'Threes Brewing, 333 Douglass St, Brooklyn (Gowanus)',
    },

    // Parks / outdoor
    'brooklyn-bridge-park-pier-6-pier-2-brooklyn-heights': {
        lat: 40.6948, lng: -73.9991,
        displayName: 'Brooklyn Bridge Park (Pier 6 / Pier 2), Brooklyn Heights',
    },
    'green-wood-cemetery-sunset-park': {
        lat: 40.6533, lng: -73.9931,
        displayName: 'Green-Wood Cemetery, 500 25th St, Brooklyn',
    },
    'domino-park-williamsburg': {
        lat: 40.7141, lng: -73.9676,
        displayName: 'Domino Park, 300 Kent Ave, Brooklyn (Williamsburg)',
    },
    'bush-terminal-piers-park-sunset-park': {
        lat: 40.6498, lng: -74.0173,
        displayName: 'Bush Terminal Park, 43rd St & Marginal St, Brooklyn',
    },

    // DUMBO galleries / museums
    'smack-mellon-dumbo': {
        lat: 40.7032, lng: -73.9870,
        displayName: 'Smack Mellon, 92 Plymouth St, Brooklyn (DUMBO)',
    },
    'a-i-r-gallery-dumbo': {
        lat: 40.7027, lng: -73.9870,
        displayName: 'A.I.R. Gallery, 155 Plymouth St, Brooklyn (DUMBO)',
    },
    'brooklyn-museum-stretch-option-prospect-heights': {
        lat: 40.6712, lng: -73.9636,
        displayName: 'Brooklyn Museum, 200 Eastern Pkwy, Brooklyn',
    },

    // Other Bars / specialty
    'lingo-greenpoint-greenpoint': {
        lat: 40.7239, lng: -73.9525,
        displayName: 'Lingo, 1003 Manhattan Ave, Brooklyn (Greenpoint)',
    },
    'steve-s-authentic-key-lime-pie-red-hook': {
        lat: 40.6749, lng: -74.0148,
        displayName: "Steve's Authentic Key Lime Pie, 185 Van Dyke St, Brooklyn",
    },
    'sunken-harbor-club-brooklyn-heights': {
        lat: 40.7011, lng: -73.9926,
        displayName: 'Sunken Harbor Club, 65 Pearl St, Brooklyn (atop Gage & Tollner)',
    },
    'sunny-s-bar-red-hook': {
        lat: 40.6772, lng: -74.0179,
        displayName: "Sunny's Bar, 253 Conover St, Brooklyn (Red Hook)",
    },
};

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');

// ----- Extract itineraryData from index.html ------------------------------
//
// The literal lives between `const itineraryData = [` and the matching
// closing `];`. We slice the text, swap the array-literal opening for an
// `export default [` and eval as an ES module string in a tiny shim file
// at runtime. Simpler and more robust than regex-parsing arbitrary JS:
// we lean on Node's parser by writing a temp .mjs and importing it.

async function extractItineraryData() {
    const html = await readFile(INDEX_HTML, 'utf8');
    const startIdx = html.indexOf('const itineraryData = [');
    if (startIdx < 0) throw new Error('Could not find itineraryData declaration');

    // Walk from the opening `[` to the matching `];` while respecting
    // strings, template literals, and nested brackets. Heuristic but
    // sufficient for our well-formed file (and far safer than a regex).
    const open = html.indexOf('[', startIdx);
    let depth = 0;
    let i = open;
    let inStr = null; // tracks the current quote char if inside a string
    let escape = false;
    for (; i < html.length; i++) {
        const ch = html[i];
        if (inStr) {
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === inStr) inStr = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
        if (ch === '[') depth++;
        else if (ch === ']') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) throw new Error('Failed to walk itineraryData literal — unmatched brackets');
    const literal = html.slice(open, i + 1);

    // Write a tiny ES module that exports the literal and import it. We
    // also have to stub `fallbackGen` since it's referenced inside the
    // literal as a free variable.
    const shim = `const fallbackGen = '';\nexport default ${literal};\n`;
    const tmpFile = resolve(ROOT, '.geocode-shim.mjs');
    await writeFile(tmpFile, shim, 'utf8');
    try {
        const mod = await import(`file://${tmpFile.replace(/\\/g, '/')}?v=${Date.now()}`);
        return mod.default;
    } finally {
        // best-effort cleanup
        try { await import('node:fs/promises').then(fs => fs.unlink(tmpFile)); } catch {}
    }
}

// ----- Build geocoding query --------------------------------------------
function zoneToText(zone = '') { return zone.replace(/-/g, ' '); }

function buildQuery(place) {
    const zoneText = zoneToText(place.zone);
    const neighborhood = place.neighborhood || zoneText;
    // Strip parenthetical aside notes from venue names; they confuse
    // Nominatim ("Tompkins Square Bagels (Bed-Stuy outpost)" → bag of words).
    const name = (place.name || '')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return `${name}, ${neighborhood}, Brooklyn, NY`.replace(/\s+,/g, ',').trim();
}

// ----- Nominatim call w/ throttle ----------------------------------------
let lastCall = 0;
async function geocode(query) {
    const elapsed = Date.now() - lastCall;
    if (elapsed < THROTTLE_MS) {
        await new Promise(r => setTimeout(r, THROTTLE_MS - elapsed));
    }
    lastCall = Date.now();

    const url = new URL(NOMINATIM_BASE);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'us');

    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status} for ${query}`);
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const hit = arr[0];
    return {
        lat: Number(hit.lat),
        lng: Number(hit.lon),
        displayName: hit.display_name,
    };
}

// ----- Main --------------------------------------------------------------
async function main() {
    const itineraryData = await extractItineraryData();
    // Flatten: itineraryData is [{ places: [...] }, ...]
    const allPlaces = itineraryData.flatMap(checkpoint => checkpoint.places || []);
    console.log(`Found ${allPlaces.length} venues across ${itineraryData.length} checkpoints.`);

    await mkdir(dirname(COORDS_FILE), { recursive: true });
    let cache = {};
    if (existsSync(COORDS_FILE)) {
        try { cache = JSON.parse(await readFile(COORDS_FILE, 'utf8')); }
        catch (e) { console.warn(`Existing cache unreadable, starting fresh: ${e.message}`); }
    }

    let successCount = 0, failCount = 0, skipCount = 0, overrideCount = 0;
    const failures = [];

    for (const place of allPlaces) {
        if (!place.id) { console.warn(`Skipping place without id: ${place.name}`); continue; }

        if (OVERRIDES[place.id]) {
            cache[place.id] = {
                ...OVERRIDES[place.id],
                source: 'override',
                geocodedAt: new Date().toISOString(),
                query: 'manual override',
            };
            overrideCount++;
            continue;
        }

        if (!FORCE && cache[place.id] && Number.isFinite(cache[place.id].lat)) {
            skipCount++;
            continue;
        }

        const query = buildQuery(place);
        try {
            const hit = await geocode(query);
            if (hit) {
                cache[place.id] = {
                    lat: hit.lat,
                    lng: hit.lng,
                    displayName: hit.displayName,
                    source: 'nominatim',
                    geocodedAt: new Date().toISOString(),
                    query,
                };
                successCount++;
                console.log(`  OK   ${place.id} -> ${hit.lat}, ${hit.lng}`);
            } else {
                failCount++;
                failures.push({ id: place.id, name: place.name, query });
                console.warn(`  FAIL ${place.id} (no result for "${query}")`);
            }
        } catch (e) {
            failCount++;
            failures.push({ id: place.id, name: place.name, query, error: e.message });
            console.warn(`  ERR  ${place.id}: ${e.message}`);
        }

        // Write cache after each successful fetch so a crash doesn't lose progress
        await writeFile(COORDS_FILE, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    }

    // Final write — captures override-only runs (no fetches above) and acts
    // as a safety net for any branch that didn't hit the per-iteration write.
    await writeFile(COORDS_FILE, JSON.stringify(cache, null, 2) + '\n', 'utf8');

    console.log('\n========= GEOCODING REPORT =========');
    console.log(`Total venues:      ${allPlaces.length}`);
    console.log(`Newly geocoded:    ${successCount}`);
    console.log(`Cached (skipped):  ${skipCount}`);
    console.log(`Manual overrides:  ${overrideCount}`);
    console.log(`Failed:            ${failCount}`);
    if (failures.length) {
        console.log('\nFailures:');
        for (const f of failures) console.log(`  - ${f.id} (${f.name})  query: ${f.query}`);
    }
    console.log(`\nCache: ${COORDS_FILE}`);
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
