/* satellite.js: SGP4; Leaflet: geographic projection and layers. */
'use strict';
const $ = id => document.getElementById(id);
let map, marker, past, future, record, metadata, following = true, lastTrack = 0;


const GROUND_ANTENNAS = {
  "GC ACC": {latitude: 27.9319, longitude: -15.3866, altitude: 77},
  "AZ ACC": {latitude: 36.9714, longitude: -25.1706, altitude: 94},
  "IC ACC": {latitude: 5.2561, longitude: -3.9314, altitude: 29},
  "BR ACC": {latitude: -8.1120, longitude: -34.9260, altitude: 10},
  "SV GS": {latitude: 78.2266, longitude: 15.3910, altitude: 492}
};

function status(message) { $('status').textContent = message; }

function positionAt(date) {
  const result = satellite.propagate(record, date);
  if (!result || !result.position || !result.velocity || record.error) throw new Error('Unable to propagate this TLE.');
  const geo = satellite.eciToGeodetic(result.position, satellite.gstime(date));
  const p = {lat: satellite.degreesLat(geo.latitude), lon: satellite.degreesLong(geo.longitude), alt: geo.height,
    speed: Math.hypot(result.velocity.x, result.velocity.y, result.velocity.z)};
  if (!Object.values(p).every(Number.isFinite) || p.alt < 0) throw new Error('Invalid orbital position.');
  return p;
}

/* Splits segments when crossing ±180°, preventing lines from crossing the entire map. */
function trajectory(now, start, end) {
  const segments = []; let segment = [];
  for (let minute = start; minute <= end; minute++) {
    const p = positionAt(new Date(now.getTime() + minute * 60000));
    if (segment.length && Math.abs(p.lon - segment[segment.length - 1][1]) > 180) {
      segments.push(segment); segment = [];
    }
    segment.push([p.lat, p.lon]);
  }
  if (segment.length) segments.push(segment);
  return segments;
}

function tick() {
  if (!record) return;
  try {
    const now = new Date(), p = positionAt(now);
    $('utc').textContent = now.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    $('lat').textContent = Math.abs(p.lat).toFixed(2) + '° ' + (p.lat >= 0 ? 'N' : 'S');
    $('lon').textContent = Math.abs(p.lon).toFixed(2) + '° ' + (p.lon >= 0 ? 'E' : 'O');
    $('alt').textContent = p.alt.toFixed(1) + ' km'; $('speed').textContent = p.speed.toFixed(2) + ' km/s';
    if (following) map.setView([p.lat, p.lon], map.getZoom(), {animate: false});

    marker.setLatLng([p.lat, p.lon]);

    if (now.getTime() - lastTrack > 60000) {
      past.setLatLngs(trajectory(now, -45, 0)); future.setLatLngs(trajectory(now, 0, 90)); lastTrack = now.getTime();
    }

    const age = (now.getTime() - (record.jdsatepoch - 2440587.5) * 86400000) / 86400000;
    let message = metadata.mode === 'example' ? 'EXAMPLE · API not configured' : 'TLE received from the API';
    if (age > 3) message += ' · Old TLE: ' + age.toFixed(1) + ' days';
    if (age < 0) message += ' · Future TLE epoch';
    if (metadata.error) message += ' · The source reports an error';
    status(message);

  } catch (error) {
    record = null; marker.remove(); past.setLatLngs([]); future.setLatLngs([]);
    for (const id of ['lat', 'lon', 'alt', 'speed']) $(id).textContent = '—';
    status(error.message);
  }
}

async function loadTle() {
  $('refresh').disabled = true;
  status('Fetching TLE…');

  try {
    const response = await fetch('/api/tle', {cache: 'no-store', signal: AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error('API unavailable (' + response.status + ').');

    const data = await response.json();

    if (typeof data.tle_line1 !== 'string' || typeof data.tle_line2 !== 'string' ||
        !data.tle_line1.startsWith('1 ') || !data.tle_line2.startsWith('2 ') ||
        data.tle_line1.length < 69 || data.tle_line2.length < 69 ||
        data.tle_line1.slice(2, 7) !== data.tle_line2.slice(2, 7)) throw new Error('Invalid TLE response.');

    const candidate = satellite.twoline2satrec(data.tle_line1, data.tle_line2);
    if (candidate.error || !Number.isFinite(candidate.jdsatepoch) || !Number.isFinite(candidate.no) || candidate.no <= 0) throw new Error('Invalid orbital elements.');

    record = candidate; metadata = data; lastTrack = 0;

    $('sat-name').firstChild.textContent = String(data.satellite || 'IOD2') + ' ';

    const tooltip = document.createElement('span');
    tooltip.textContent = String(data.satellite || 'IOD2');
    marker.setTooltipContent(tooltip).addTo(map);

    const epoch = new Date((record.jdsatepoch - 2440587.5) * 86400000).toISOString();
    const updated = data.last_update ? new Date(data.last_update) : null;

    $('tle-info').textContent = 'Estimated position every second · TLE epoch: ' + epoch.slice(0, 19).replace('T', ' ') + ' UTC · Source: ' + (data.source || 'API') +
      (updated && Number.isFinite(updated.getTime()) ? ' · Source update: ' + updated.toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '') + '. This is not telemetry received from the satellite.';

    tick();

  } catch (error) {
    record = null; marker.remove(); past.setLatLngs([]); future.setLatLngs([]);
    for (const id of ['lat', 'lon', 'alt', 'speed']) $(id).textContent = '—';
    status(error.message + ' Click Refresh TLE to try again.');

  } finally { $('refresh').disabled = false; }
}

function setFollowing(value) {
  following = value; $('follow').setAttribute('aria-pressed', String(value));
  $('follow').textContent = value ? 'Tracking enabled' : 'Center satellite';
}


function drawGroundStations(map) {
  const groundLayer = L.layerGroup().addTo(map);

  Object.entries(GROUND_ANTENNAS).forEach(([name, station]) => {
    const {latitude, longitude, altitude} = station;

    const marker = L.circleMarker([latitude, longitude], {
      radius: 7,
      color: '#ffffff',
      weight: 2,
      fillColor: '#38bdf8',
      fillOpacity: 0.95
    });

    marker.bindTooltip(name, {
      permanent: true,
      direction: 'top',
      offset: [0, -10],
      className: 'groundstation-tooltip'
    });

    const popup = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = name;

    const details = document.createElement('div');
    details.textContent =
      `Lat: ${latitude.toFixed(4)}° | Lon: ${longitude.toFixed(4)}° | Alt: ${altitude} m`;

    popup.append(title, details);
    marker.bindPopup(popup);

    marker.addTo(groundLayer);
  });

  return groundLayer;
}


if (!window.L || !window.satellite) {
  status('The map libraries could not be loaded. Check that the public/vendor folder is complete.');
  $('refresh').disabled = true; $('follow').disabled = true;

} else {
  // Flat SVG map in the visual style of index2; no remote tile service.
  // This artwork is illustrative, not a geographic basemap.
  const worldBounds = L.latLngBounds([[-90, -180], [90, 180]]);
  map = L.map('map', {
    crs: L.CRS.EPSG4326,
    minZoom: 0,
    maxZoom: 6,
    zoomSnap: 0,
    zoomDelta: 0.25,
    maxBounds: worldBounds,
    maxBoundsViscosity: 1
  });
  map.getContainer().style.background = '#080f19';
  map.fitBounds(worldBounds);
  map.fitBounds(worldBounds, { padding: [0, 0] });

  // La vista inicial será el máximo alejamiento permitido.
  map.setMinZoom(map.getZoom());
  const background = L.imageOverlay('assets/orbital-map.svg', worldBounds, {
    interactive: false,
    attribution: 'Illustrative map · not for navigation'
  }).addTo(map);
  background.on('error', () => {
    status('The illustrated map could not be loaded. Check assets/orbital-map.svg.');
  });
  drawGroundStations(map);

  marker = L.marker([0, 0], {
    icon: L.divIcon({
      className: '',
      html: '<div class="satellite-marker"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    })
  }).bindTooltip('IOD2', {permanent: true, direction: 'top', offset: [0, -14]});

  past = L.polyline([], {color: '#577b88', weight: 2}).addTo(map);
  future = L.polyline([], {color: '#79e9b1', weight: 2, dashArray: '6 7'}).addTo(map);

  map.on('dragstart', () => setFollowing(false));

  $('follow').addEventListener('click', () => {
    setFollowing(!following); tick();
  });

  $('refresh').addEventListener('click', loadTle);

  loadTle(); setInterval(tick, 1000); setInterval(loadTle, 300000);
}