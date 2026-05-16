#!/usr/bin/env node
// Generate a single KML file containing every venue from itineraryData
// joined with its lat/lng from data/venue-coords.json. The output is
// committed to the repo so users can one-click import into Google My
// Maps for a native Google Maps experience with all pins.
//
// Usage:
//   node tools/export-kml.mjs   // writes data/saturfun-venues.kml

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const INDEX_HTML = resolve(ROOT, 'index.html');
const COORDS_FILE = resolve(ROOT, 'data', 'venue-coords.json');
const KML_FILE = resolve(ROOT, 'data', 'saturfun-venues.kml');

// Same literal-extractor approach as geocode-venues.mjs: locate the
// itineraryData array, walk for the matching `]`, eval as an ES module.
async function extractItineraryData() {
    const html = await readFile(INDEX_HTML, 'utf8');
    const startIdx = html.indexOf('const itineraryData = [');
    if (startIdx < 0) throw new Error('Could not find itineraryData declaration');
    const open = html.indexOf('[', startIdx);
    let depth = 0;
    let i = open;
    let inStr = null;
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
    const shim = `const fallbackGen = '';\nexport default ${literal};\n`;
    const tmpFile = resolve(ROOT, '.kml-shim.mjs');
    await writeFile(tmpFile, shim, 'utf8');
    try {
        const mod = await import(`file://${tmpFile.replace(/\\/g, '/')}?v=${Date.now()}`);
        return mod.default;
    } finally {
        try { await import('node:fs/promises').then(fs => fs.unlink(tmpFile)); } catch {}
    }
}

// XML special-character escaping for use inside <name>/<description> nodes.
function escapeXml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function zoneToText(zone = '') {
    return zone.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function buildDescription(place, checkpoint) {
    const parts = [];
    parts.push(escapeXml(place.desc || ''));
    const metaBits = [];
    if (place.duration) metaBits.push(escapeXml(place.duration));
    if (place.priceBand) metaBits.push(escapeXml(place.priceBand));
    if (place.zone) metaBits.push(escapeXml(zoneToText(place.zone)));
    if (metaBits.length) parts.push(metaBits.join(' · '));
    if (checkpoint?.title) parts.push(`Time slot: ${escapeXml(checkpoint.time || '')} — ${escapeXml(checkpoint.title)}`);
    if (place.notes) parts.push(`Notes: ${escapeXml(place.notes)}`);
    return parts.filter(Boolean).join('\n\n');
}

async function main() {
    const [itineraryData, coordsRaw] = await Promise.all([
        extractItineraryData(),
        existsSync(COORDS_FILE) ? readFile(COORDS_FILE, 'utf8') : Promise.resolve('{}'),
    ]);
    const coords = JSON.parse(coordsRaw);

    let placemarkCount = 0;
    let skippedNoCoords = 0;
    const placemarks = [];

    for (const checkpoint of itineraryData) {
        for (const place of (checkpoint.places || [])) {
            const c = coords[place.id];
            if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) {
                skippedNoCoords++;
                console.warn(`  skip ${place.id} (no coords)`);
                continue;
            }
            const name = escapeXml(place.name || place.id);
            const desc = buildDescription(place, checkpoint);
            // KML coords are lng,lat[,alt] — common gotcha. We use 0 alt.
            placemarks.push(
                `    <Placemark>\n` +
                `      <name>${name}</name>\n` +
                `      <description><![CDATA[${desc}]]></description>\n` +
                `      <Point><coordinates>${c.lng},${c.lat},0</coordinates></Point>\n` +
                `    </Placemark>`
            );
            placemarkCount++;
        }
    }

    const today = new Date().toISOString().slice(0, 10);
    const kml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<kml xmlns="http://www.opengis.net/kml/2.2">\n` +
        `  <Document>\n` +
        `    <name>Saturfun — Brooklyn Itinerary</name>\n` +
        `    <description>${placemarkCount} venues across Flushing, Brooklyn &amp; Manhattan. Generated from itineraryData on ${today}.</description>\n` +
        placemarks.join('\n') + '\n' +
        `  </Document>\n` +
        `</kml>\n`;

    await writeFile(KML_FILE, kml, 'utf8');
    console.log(`Wrote ${KML_FILE}`);
    console.log(`Placemarks: ${placemarkCount}, skipped (no coords): ${skippedNoCoords}`);
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
