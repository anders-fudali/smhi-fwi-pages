'use strict';

// ── FWI helpers ───────────────────────────────────────────────────────────────
const FWI_COLORS = ['#9e9e9e','#2196f3','#4caf50','#ffeb3b','#ff9800','#f44336','#b71c1c'];
const FWI_LABELS = ['Ingen data','Mycket liten','Liten','Måttlig','Stor','Mycket stor','Extremt stor'];

function fwiColor(index) {
  if (index === null || index === undefined || index < 0) return FWI_COLORS[0];
  return FWI_COLORS[Math.min(Math.round(index), 6)] || FWI_COLORS[0];
}

function fwiTextColor(index) {
  if (index === null || index === undefined || index < 0) return '#fff';
  const i = Math.min(Math.round(index), 6);
  return i === 3 ? '#333' : '#fff';
}

function fwiLabel(index) {
  if (index === null || index === undefined) return FWI_LABELS[0];
  if (index < 0) return 'Utanför säsongen';
  return FWI_LABELS[Math.min(Math.round(index), 6)] || FWI_LABELS[0];
}

// ── State ─────────────────────────────────────────────────────────────────────
const groupUuid  = new URLSearchParams(location.search).get('group');
let pubGroup        = null;
let pubCenters      = [];
let pubDates        = [];
let pubDateIdx      = 0;
let pubForce         = false;
let pubLastFetchedAt = null;
let pubCirclesVisible = true;

// Static data mode: set by the hosting page (e.g. GitHub Pages).
// When set, all data is loaded from static JSON files relative to this base URL
// instead of the live API.
const DATA_BASE = window.GH_PAGES_DATA_BASE ?? null;
function apiUrl(apiPath, staticPath) {
  return DATA_BASE ? DATA_BASE + staticPath : apiPath;
}

// No UUID → blank page, nothing to do
if (!groupUuid) {
  document.getElementById('pub-map').style.display = 'none';
  throw new Error('no-group'); // stop script execution
}

// ── Dark mode ─────────────────────────────────────────────────────────────────
if (localStorage.getItem('dark') === '1') document.body.classList.add('dark');

// ── Map setup ─────────────────────────────────────────────────────────────────
const map = L.map('pub-map', { attributionControl: false });

const tileLayers = {
  light: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' }),
  dark:  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap contributors © CARTO' }),
};
tileLayers.light.addTo(map);

const centerLayer   = L.layerGroup().addTo(map);
const labelLayer    = L.layerGroup(); // off by default
const areaDotsLayer = L.layerGroup(); // off by default
map.createPane('airspacePane').style.zIndex = 350;
map.createPane('obstaclePane').style.zIndex = 390;
const airspaceLayer = L.layerGroup(); // off by default
const obstacleLayer = L.layerGroup(); // off by default

// ── Legend collapse ───────────────────────────────────────────────────────────
function togglePubBriefing() {
  const content = document.getElementById('pub-briefing-content');
  const tab = document.getElementById('pub-briefing-tab');
  const expanded = content.classList.toggle('expanded');
  tab.textContent = expanded ? '▾' : '▴';
}

function pubToggleLegend() {
  const content = document.getElementById('pub-legend-content');
  const tab = document.getElementById('pub-legend-tab');
  const expanded = content.classList.toggle('expanded');
  tab.textContent = expanded ? '▴' : '▾';
}

// ── Layer toggles ─────────────────────────────────────────────────────────────
function pubToggleAirspace() {
  const btn = document.getElementById('btn-airspace');
  if (map.hasLayer(airspaceLayer)) { map.removeLayer(airspaceLayer); btn.classList.remove('active'); }
  else { map.addLayer(airspaceLayer); btn.classList.add('active'); }
}

function pubToggleObstacles() {
  const btn = document.getElementById('btn-obstacles');
  if (map.hasLayer(obstacleLayer)) { map.removeLayer(obstacleLayer); btn.classList.remove('active'); }
  else { map.addLayer(obstacleLayer); btn.classList.add('active'); }
}

function pubToggleLabels() {
  const btn = document.getElementById('btn-labels');
  if (map.hasLayer(labelLayer)) { map.removeLayer(labelLayer); btn.classList.remove('active'); }
  else { map.addLayer(labelLayer); btn.classList.add('active'); }
}

function pubToggleCircles() {
  pubCirclesVisible = !pubCirclesVisible;
  document.getElementById('btn-circles').classList.toggle('active', pubCirclesVisible);
  renderMap();
}

async function pubToggleAreaDots() {
  const btn = document.getElementById('btn-area-dots');
  if (map.hasLayer(areaDotsLayer)) {
    map.removeLayer(areaDotsLayer);
    btn.classList.remove('active');
    return;
  }
  map.addLayer(areaDotsLayer);
  btn.classList.add('active');
  await renderAreaDots();
}

async function renderAreaDots() {
  if (!pubGroup) return;
  const date = pubDates[pubDateIdx];
  if (!date) return;
  areaDotsLayer.clearLayers();
  try {
    let points;
    if (DATA_BASE) {
      points = (window._pubHeatmaps || {})[date] || [];
    } else {
      const res = await fetch(`/api/groups/${pubGroup.id}/area-points/heatmap?date=${date}`);
      if (!res.ok) return;
      points = (await res.json()).points;
    }
    heatmapData = { [date]: points };
    renderMap(); // refresh center badges with area-derived FWI
    if (map.hasLayer(areaDotsLayer)) {
      for (const [lat, lon, idx] of points) {
        const hasData = idx !== null && idx > 0;
        L.circleMarker([lat, lon], {
          radius: 5,
          color: 'none',
          fillColor: hasData ? fwiColor(idx) : '#9e9e9e',
          fillOpacity: hasData ? 0.6 : 0.3,
          interactive: false,
        }).addTo(areaDotsLayer);
      }
      centerLayer.bringToFront && centerLayer.bringToFront();
      labelLayer.bringToFront && labelLayer.bringToFront();
    }
  } catch (_) {}
}

function airspaceStyle(cls) {
  const styles = {
    G: { color: '#1565c0', fillColor: '#42a5f5', fillOpacity: 0.08 },
    D: { color: '#e65100', fillColor: '#ff9800', fillOpacity: 0.10 },
    C: { color: '#558b2f', fillColor: '#8bc34a', fillOpacity: 0.10 },
    R: { color: '#cc0000', fillColor: '#ff0000', fillOpacity: 0.12 },
    P: { color: '#880000', fillColor: '#cc0000', fillOpacity: 0.15 },
    Q: { color: '#ff6600', fillColor: '#ff9900', fillOpacity: 0.12 },
    W: { color: '#7700cc', fillColor: '#9933ff', fillOpacity: 0.08 },
  };
  return { weight: 1.2, ...(styles[cls?.toUpperCase()] || styles.G) };
}

function obstacleColor(type) {
  const colors = {
    WINDMILL: '#388E3C', ANTENNA: '#7B1FA2', STACK: '#BF360C',
    BUILDING: '#455A64', TOWER: '#C62828', CRANE: '#E65100',
    POLE: '#F9A825', BRIDGE: '#00838F', SPIRE: '#283593', TANK: '#558B2F',
  };
  return colors[type?.toUpperCase()] || '#757575';
}

async function loadPubAirspace() {
  try {
    const geojson = await fetch(apiUrl('/api/airspace', 'data/airspace.json')).then(r => r.json());
    L.geoJSON(geojson, {
      style: f => ({ ...airspaceStyle(f.properties.class), pane: 'airspacePane' }),
      onEachFeature: (f, layer) => {
        const p = f.properties;
        layer.bindPopup(`<div class="popup-title">${p.name}</div>
          <div class="popup-row"><span class="popup-label">Klass</span><span class="popup-val">${p.class}</span></div>
          <div class="popup-row"><span class="popup-label">Tak</span><span class="popup-val">${p.ceiling}</span></div>
          <div class="popup-row"><span class="popup-label">Golv</span><span class="popup-val">${p.floor}</span></div>`);
      },
    }).addTo(airspaceLayer);
  } catch (_) {}
}

async function loadPubObstacles() {
  try {
    const res = await fetch(apiUrl('/api/obstacles', 'data/obstacles.json'));
    if (!res.ok) return;
    const geojson = await res.json();
    for (const f of geojson.features) {
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      L.circleMarker([lat, lon], {
        radius: 4, color: '#000', fillColor: obstacleColor(p.obstacleType),
        fillOpacity: 0.85, weight: 0.5, pane: 'obstaclePane',
      }).addTo(obstacleLayer).bindPopup(`<div class="popup-title">${p.name || p.obstacleType}</div>
        <div class="popup-row"><span class="popup-label">Typ</span><span class="popup-val">${p.obstacleType}</span></div>
        <div class="popup-row"><span class="popup-label">Höjd</span><span class="popup-val">${p.height} ft</span></div>
        <div class="popup-row"><span class="popup-label">Elev</span><span class="popup-val">${p.elevation} ft</span></div>`);
    }
  } catch (_) {}
}

// ── Haversine distance (km) ────────────────────────────────────────────────────
function haversineDist(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Live heatmap cache (date → [[lat,lon,idx],...]) ───────────────────────────
let heatmapData = {};

function centerFwiFromHeatmap(center, date) {
  const points = heatmapData[date];
  if (!points || !points.length) return null;
  const radius = center.radiusKm ?? center.radius_km ?? 5.5;
  const nearby = points.filter(([lat, lon, idx]) => idx > 0 && idx <= 100 &&
    haversineDist(center.lat, center.lon, lat, lon) <= radius);
  if (!nearby.length) return null;
  return nearby.reduce((s, [,,idx]) => s + idx, 0) / nearby.length;
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderMap() {
  centerLayer.clearLayers();
  labelLayer.clearLayers();
  if (!pubCenters.length || !pubDates.length) return;

  const date = pubDates[pubDateIdx];
  const bounds = [];

  pubCenters.forEach(center => {
    const dayAvg   = center.dailyAverages.find(d => d.date === date);
    const centerBd = pubGroup?.centerAreaBreakdowns?.find(b => b.name === center.name);
    const areaIdx  = centerBd?.areaBreakdown?.find(e => e.date === date)?.displayIndex
                     ?? centerFwiFromHeatmap(center, date);
    const avgIndex = areaIdx ?? dayAvg?.avgFwiindex ?? null;
    const avgFwi   = dayAvg?.avgFwi ?? null;
    const color    = fwiColor(avgIndex);

    const radiusKm = center.radiusKm ?? center.radius_km ?? 5.5;
    if (pubCirclesVisible) {
      L.circle([center.lat, center.lon], {
        radius: radiusKm * 1000,
        color, fillColor: color, fillOpacity: 0.08,
        weight: 1.5, dashArray: '5,4',
        interactive: false,
      }).addTo(centerLayer);
    }

    const size  = 22;
    const badge = avgIndex !== null && avgIndex >= 0 ? Math.min(Math.round(avgIndex), 6) : '—';
    const cm = L.marker([center.lat, center.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div class="center-marker" style="width:${size}px;height:${size}px;background:${color};color:${fwiTextColor(avgIndex)}">${badge}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      }),
    }).addTo(centerLayer);

    const idxStr = avgIndex != null && avgIndex >= 0 ? Math.min(Math.round(avgIndex), 6) : '—';
    cm.bindPopup(`
      <div class="popup-title">${center.name}</div>
      <div class="popup-row"><span class="popup-val">${idxStr} – ${fwiLabel(avgIndex)}</span></div>
    `);
    cm.bindTooltip(`<strong>${center.name}</strong><br>${idxStr} – ${fwiLabel(avgIndex)}`, { sticky: false, direction: 'top', offset: [0, -8] });

    L.marker([center.lat, center.lon], {
      icon: L.divIcon({
        className: 'center-label-icon',
        html: `<div class="center-label"><span class="cl-badge" style="background:${color};color:${fwiTextColor(avgIndex)}">${badge}</span>${center.name}</div>`,
        iconAnchor: [0, -size / 2 - 2],
      }),
      interactive: false,
    }).addTo(labelLayer);

    bounds.push([center.lat, center.lon]);
  });

  return bounds;
}


// ── Load & init ───────────────────────────────────────────────────────────────
fetch(apiUrl(`/api/public/group/${groupUuid}`, `data/${groupUuid}.json`))
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(({ group, centers, lastFetchedAt, heatmaps }) => {
      pubGroup         = group;
      pubCenters       = centers;
      pubLastFetchedAt = lastFetchedAt ?? null;
      if (heatmaps) window._pubHeatmaps = heatmaps;
      pubDates   = [...new Set(centers.flatMap(c => c.dailyAverages.map(d => d.date)))].sort();

      if (!pubDates.length) {
        document.getElementById('pub-no-group').style.display = 'flex';
        document.getElementById('pub-no-group').textContent = 'Ingen prognosdata tillgänglig.';
        map.setView([62, 15], 5);
        return;
      }

      // Resolve initial date from hash
      const hashDate = location.hash.replace('#', '');
      const today    = new Date().toISOString().split('T')[0];
      const target   = hashDate.match(/^\d{4}-\d{2}-\d{2}$/) ? hashDate : today;
      let idx = pubDates.findIndex(d => d >= target);
      if (idx < 0) idx = pubDates.length - 1;
      pubDateIdx = idx;

      // Render and fit bounds
      const bounds = renderMap();
      if (bounds?.length) {
        map.fitBounds(L.latLngBounds(bounds).pad(0.25));
      } else {
        map.setView([62, 15], 5);
      }

      document.getElementById('pub-legend').style.display = '';
      document.getElementById('pub-legend-content').classList.add('expanded');
      document.getElementById('pub-legend-tab').textContent = '▴';

      document.getElementById('pub-toggles').style.display = '';
      if (pubGroup.hasAreaPoints) {
        document.getElementById('btn-area-dots').style.display = '';
      }

      renderBriefing(pubCenters, pubDates[pubDateIdx], pubGroup);
      document.getElementById('pub-briefing-content').classList.add('expanded');
      document.getElementById('pub-briefing-tab').textContent = '▾';
      loadPubAirspace();
      loadPubObstacles();
      renderAreaDots(); // pre-load heatmap so center badges show area-derived FWI

      // Route polyline — always draw if ≥2 centers, fallback color matches admin
      if (centers.length >= 2) {
        const color  = pubGroup.color || '#888888';
        const coords = centers.map(c => [c.lat, c.lon]);
        L.polyline([...coords, coords[0]], { color: '#000', weight: 5, opacity: 0.18, interactive: false }).addTo(map);
        L.polyline([...coords, coords[0]], { color, weight: 3, opacity: 0.85 }).addTo(map);
      }

      document.title = `${group.name} – FWI Prognos`;
      const nameEl = document.getElementById('pub-group-name');
      if (nameEl) { nameEl.textContent = group.name; nameEl.style.display = ''; }
    })
    .catch(() => {
      document.getElementById('pub-no-group').style.display = 'flex';
      document.getElementById('pub-no-group').textContent = 'Gruppen hittades inte.';
      map.setView([62, 15], 5);
    });

map.on('zoomend', () => { if (pubCenters.length) renderMap(); });

window.addEventListener('hashchange', () => {
  const hashDate = location.hash.replace('#', '');
  if (!hashDate.match(/^\d{4}-\d{2}-\d{2}$/) || !pubDates.length) return;
  let idx = pubDates.findIndex(d => d >= hashDate);
  if (idx < 0) idx = pubDates.length - 1;
  if (idx === pubDateIdx) return;
  pubDateIdx = idx;
  renderMap();
  renderBriefing(pubCenters, pubDates[pubDateIdx], pubGroup);
  renderAreaDots();
});

// ── Mission briefing ──────────────────────────────────────────────────────────
function inSeason(dateStr, start, end) {
  const mmdd = dateStr.slice(5);
  const s = start || '04-01', e = end || '09-30';
  return s <= e ? mmdd >= s && mmdd <= e : mmdd >= s || mmdd <= e;
}

function togglePubForce() {
  pubForce = !pubForce;
  renderBriefing(pubCenters, pubDates[pubDateIdx], pubGroup);
}

function computeBriefing(centers, date, group) {
  const outsideSeason = !inSeason(date, group.season_start, group.season_end);
  if (outsideSeason && !pubForce) return { level: 'outside', outsideSeason: true };

  // Use server-pre-computed briefing
  const briefing = (group.briefings ?? []).find(b => b.date === date);
  if (briefing) return outsideSeason ? { ...briefing, outsideSeason: true } : briefing;

  // Fallback if no briefing for this date
  if (!group.hasAreaPoints) return { level: 'no_area' };
  return { level: 'no_data' };
}

function renderFreshnessNote() {
  const times = [pubLastFetchedAt, pubGroup?.area_last_sync].filter(Boolean).sort();
  const latest = times.at(-1);
  if (!latest) return '';
  const dt = new Date(latest);
  const dateStr = dt.toLocaleDateString('sv-SE');
  const timeStr = dt.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  const today = new Date().toLocaleDateString('sv-SE');
  const stale = dateStr !== today;
  return stale
    ? `<div style="font-size:11px;color:#e65100;margin-top:6px">🔺 Uppdaterad: ${dateStr} ${timeStr}</div>`
    : `<div style="font-size:11px;color:#aaa;margin-top:6px">Uppdaterad: ${timeStr}</div>`;
}

function renderBriefing(centers, date, group) {
  const el = document.getElementById('pub-briefing-content');
  if (!el) return;
  const b = computeBriefing(centers, date, group);

  const ICONS  = { 2: '🔴', 1: '🟡', 0: '🟢' };
  const BG     = { 2: '#ffebee', 1: '#fff8e1', 0: '#f1f8e9' };
  const isCombined = b.fullRoute && b.targetedTimes && b.bp?.length;
  const TITLES = {
    2: b.fullRoute ? '2 flygningar/dygn' : '2 överflygningar',
    1: isCombined ? '1 slinga + riktade' : b.fullRoute ? '1 flygning/dygn' : '1 överflygning',
    0: 'Ingen bevakning',
  };
  const SUBS = {
    2: b.fullRoute ? 'Längs hela slingan' : 'Berörda brytpunkter',
    1: isCombined ? 'Hela slingan + berörda' : b.fullRoute ? 'Längs hela slingan' : 'Berörda brytpunkter',
    0: 'Risk 1–3 i hela området',
  };

  const forceBtn = `<button onclick="togglePubForce()" title="Visa utanför säsong"
    style="background:${pubForce ? '#e65100' : 'rgba(0,0,0,0.08)'};border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:13px;line-height:1.4">⚡</button>`;

  if (b.level === 'outside') {
    el.innerHTML = `<div style="background:#fff;border-radius:10px;padding:8px 12px;box-shadow:0 2px 8px rgba(0,0,0,.15)">
      <div style="display:flex;align-items:center;justify-content:space-between;color:#888"><span>Utanför säsongen</span>${forceBtn}</div>
      ${renderFreshnessNote()}</div>`;
    return;
  }
  if (b.level === 'no_area') {
    el.innerHTML = `<div style="background:#fff;border-radius:10px;padding:8px 12px;box-shadow:0 2px 8px rgba(0,0,0,.15)">
      <div style="display:flex;align-items:center;justify-content:space-between;color:#888"><span>Inget bevakningsområde definierat.</span>${forceBtn}</div>
      ${renderFreshnessNote()}</div>`;
    return;
  }
  if (b.level === 'no_data') {
    el.innerHTML = `<div style="background:#fff;border-radius:10px;padding:8px 12px;box-shadow:0 2px 8px rgba(0,0,0,.15)">
      <div style="display:flex;align-items:center;justify-content:space-between;color:#888"><span>Ingen prognosdata för ${date}</span>${forceBtn}</div>
      ${renderFreshnessNote()}</div>`;
    return;
  }

  const bpNames = b.bp?.map(c => c.name).join(', ') ?? '';
  const timeBadge = t => `<span style="background:#1a237e;color:#fff;border-radius:4px;padding:1px 7px;font-size:12px;font-weight:600">${t}</span>`;
  const flightRow = (time, desc) => `
    <div style="display:flex;align-items:baseline;gap:8px;margin-top:6px">
      ${timeBadge(time)}
      ${desc ? `<span style="font-size:12px">${desc}</span>` : ''}
    </div>`;

  let flightRows = '';
  if (isCombined) {
    flightRows = flightRow(b.times[0], 'Hela slingan') + flightRow(b.targetedTimes[0], `Riktad: ${bpNames}`);
  } else if (b.times?.length) {
    const bpHtml = b.bp?.map(c => `<span style="display:inline-block;background:${fwiColor(c.index)};color:#fff;border-radius:4px;padding:1px 6px;margin:2px 2px 0 0;font-size:11px">${c.name}</span>`).join('') ?? '';
    const desc = b.fullRoute ? 'Hela slingan' : bpHtml;
    flightRows = b.times.map(t => flightRow(t, desc)).join('');
  }

  const statsLine = b.level > 0
    ? `<div style="font-size:11px;color:#888;margin-top:6px">Risk 5/5E: <b>${b.pct5}%</b> · Risk 4: <b>${b.pct4}%</b></div>`
    : '';
  const seasonNote = b.outsideSeason
    ? `<div style="font-size:11px;color:#e65100;margin-top:4px">⚠ Utanför säsongen</div>` : '';

  el.innerHTML = `
    <div style="background:${BG[b.level]};border-radius:10px;padding:10px 14px;box-shadow:0 2px 8px rgba(0,0,0,.15)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
        <span style="font-size:20px">${ICONS[b.level]}</span>
        <div style="flex:1">
          <div style="font-weight:700;font-size:13px">${TITLES[b.level]}</div>
          <div style="font-size:11px;color:#666">${SUBS[b.level]}</div>
        </div>
        ${forceBtn}
      </div>
      ${flightRows}
      ${statsLine}
      ${seasonNote}
      ${renderFreshnessNote()}
    </div>`;
}
