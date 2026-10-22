
/* ========================================
   IOD2 STARTICAL - ORBITAL TRACKING

   NORAD: 64538
   Orbital data: local tle.json
   Propagation: satellite.js / SGP4
   Map: Leaflet

   IMPORTANT:
   This JavaScript NEVER requests CelesTrak.
   GitHub Actions updates tle.json separately.
   ======================================== */

'use strict';

const $ = id => document.getElementById(id);


/* ========================================
   CONFIGURATION
   ======================================== */

const NORAD_ID = '64538';

// The JSON file must be next to index.html.
// This relative URL also works on GitHub Pages.
const TLE_URL = 'tle.json';

// Last valid TLE saved in this browser.
const CACHE_KEY = 'iod2-startical-tle-v2';

// Check GitHub Pages every 5 minutes.
// These requests do NOT go to CelesTrak.
const JSON_CHECK_INTERVAL = 5 * 60 * 1000;

const REQUEST_TIMEOUT = 12000;


/* ========================================
   GLOBAL VARIABLES
   ======================================== */

let map, marker, past, future, record, metadata;

let following = true;
let lastTrack = 0;

let tleMode = 'none';
let tleWarning = '';
let requestInProgress = false;


/* ========================================
   STATUS
   ======================================== */

function status(message) {
  $('status').textContent = message;
}


/* ========================================
   LOCAL STORAGE
   ======================================== */

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn('Storage unavailable:', error);
    return null;
  }
}


function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn('Unable to save data:', error);
    return false;
  }
}


/* ========================================
   TLE VALIDATION
   ======================================== */

function validateTle(line1, line2) {
  if (
    typeof line1 !== 'string' ||
    typeof line2 !== 'string' ||
    !line1.startsWith('1 ') ||
    !line2.startsWith('2 ') ||
    line1.length < 69 ||
    line2.length < 69 ||
    line1.slice(2, 7) !== NORAD_ID ||
    line2.slice(2, 7) !== NORAD_ID
  ) {
    throw new Error('Invalid IOD2 TLE.');
  }

  const candidate = satellite.twoline2satrec(
    line1,
    line2
  );

  if (
    candidate.error ||
    !Number.isFinite(candidate.jdsatepoch) ||
    !Number.isFinite(candidate.no) ||
    candidate.no <= 0
  ) {
    throw new Error('Invalid orbital elements.');
  }

  return candidate;
}


/* ========================================
   TLE CACHE
   ======================================== */

function saveTle(data) {
  writeStorage(
    CACHE_KEY,
    JSON.stringify(data)
  );
}


function getCachedTle() {
  try {
    const saved = readStorage(CACHE_KEY);

    if (!saved) return null;

    const data = JSON.parse(saved);

    validateTle(
      data.tle_line1,
      data.tle_line2
    );

    return data;

  } catch (error) {
    console.warn('Invalid cached TLE:', error);
    return null;
  }
}


/* ========================================
   LOAD JSON FROM GITHUB PAGES
   ======================================== */

async function fetchTleJson() {
  const response = await fetch(TLE_URL, {
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(
      'TLE file unavailable (' +
      response.status +
      ').'
    );
  }

  const data = await response.json();

  if (
    !data ||
    typeof data !== 'object'
  ) {
    throw new Error('Invalid TLE JSON.');
  }

  validateTle(
    data.tle_line1,
    data.tle_line2
  );

  return data;
}


/* ========================================
   APPLY TLE
   ======================================== */

function applyTle(data, mode) {
  const candidate = validateTle(
    data.tle_line1,
    data.tle_line2
  );

  record = candidate;
  metadata = data;
  tleMode = mode;
  lastTrack = 0;

  const name = String(
    data.satellite || 'IOD2'
  );

  $('sat-name').firstChild.textContent =
    name + ' ';

  const tooltip = document.createElement('span');
  tooltip.textContent = name;

  marker.setTooltipContent(tooltip).addTo(map);

  const epoch = new Date(
    (record.jdsatepoch - 2440587.5) * 86400000
  ).toISOString();

  const updated = data.last_update
    ? new Date(data.last_update)
    : null;

  $('tle-info').textContent =
    'Estimated position every second' +
    ' · TLE epoch: ' +
    epoch.slice(0, 19).replace('T', ' ') +
    ' UTC' +
    ' · Source: ' +
    (data.source || 'CelesTrak') +
    (
      updated && Number.isFinite(updated.getTime())
        ? ' · File updated: ' +
          updated.toISOString()
            .slice(0, 19)
            .replace('T', ' ') +
          ' UTC'
        : ''
    ) +
    '. This is not telemetry received from the satellite.';

  tick();
}


/* ========================================
   ORBITAL POSITION
   ======================================== */

function positionAt(date) {
  const result = satellite.propagate(
    record,
    date
  );

  if (
    !result ||
    !result.position ||
    !result.velocity ||
    record.error
  ) {
    throw new Error(
      'Unable to propagate this TLE.'
    );
  }

  const geo = satellite.eciToGeodetic(
    result.position,
    satellite.gstime(date)
  );

  const p = {
    lat: satellite.degreesLat(geo.latitude),
    lon: satellite.degreesLong(geo.longitude),
    alt: geo.height,
    speed: Math.hypot(
      result.velocity.x,
      result.velocity.y,
      result.velocity.z
    )
  };

  if (
    !Object.values(p).every(Number.isFinite) ||
    p.alt < 0
  ) {
    throw new Error(
      'Invalid orbital position.'
    );
  }

  return p;
}


/* ========================================
   ORBITAL TRAJECTORY
   ======================================== */

function trajectory(now, start, end) {
  const segments = [];
  let segment = [];

  for (
    let minute = start;
    minute <= end;
    minute++
  ) {
    const p = positionAt(
      new Date(
        now.getTime() + minute * 60000
      )
    );

    if (
      segment.length &&
      Math.abs(
        p.lon - segment[segment.length - 1][1]
      ) > 180
    ) {
      segments.push(segment);
      segment = [];
    }

    segment.push([p.lat, p.lon]);
  }

  if (segment.length) {
    segments.push(segment);
  }

  return segments;
}


/* ========================================
   POSITION UPDATE
   ======================================== */

function tick() {
  if (!record) return;

  try {
    const now = new Date();
    const p = positionAt(now);

    $('utc').textContent =
      now.toISOString()
        .slice(0, 19)
        .replace('T', ' ') +
      ' UTC';

    $('lat').textContent =
      Math.abs(p.lat).toFixed(2) + '° ' +
      (p.lat >= 0 ? 'N' : 'S');

    $('lon').textContent =
      Math.abs(p.lon).toFixed(2) + '° ' +
      (p.lon >= 0 ? 'E' : 'O');

    $('alt').textContent =
      p.alt.toFixed(1) + ' km';

    $('speed').textContent =
      p.speed.toFixed(2) + ' km/s';

    if (following) {
      map.setView(
        [p.lat, p.lon],
        map.getZoom(),
        {animate: false}
      );
    }

    marker.setLatLng([p.lat, p.lon]);

    if (
      now.getTime() - lastTrack > 60000
    ) {
      past.setLatLngs(
        trajectory(now, -45, 0)
      );

      future.setLatLngs(
        trajectory(now, 0, 90)
      );

      lastTrack = now.getTime();
    }

    const age =
      (
        now.getTime() -
        (record.jdsatepoch - 2440587.5) * 86400000
      ) / 86400000;

    let message = tleMode === 'published'
      ? 'IOD2 · TLE loaded from GitHub Pages'
      : 'IOD2 · Using cached TLE';

    if (age > 3) {
      message +=
        ' · Old TLE: ' +
        age.toFixed(1) +
        ' days';
    }

    if (age < 0) {
      message += ' · Future TLE epoch';
    }

    if (tleWarning) {
      message += ' · ' + tleWarning;
    }

    status(message);

  } catch (error) {
    record = null;

    marker.remove();
    past.setLatLngs([]);
    future.setLatLngs([]);

    for (
      const id of [
        'lat',
        'lon',
        'alt',
        'speed'
      ]
    ) {
      $(id).textContent = '—';
    }

    status(error.message);
  }
}


/* ========================================
   LOAD TLE WITH FALLBACK

   Reads ONLY tle.json from GitHub Pages.
   Never contacts CelesTrak.
   ======================================== */

async function loadTle() {
  if (requestInProgress) return;

  requestInProgress = true;
  $('refresh').disabled = true;

  if (!record) {
    status('Loading IOD2 orbital data…');
  }

  try {
    const data = await fetchTleJson();

    // Avoid recalculating everything when
    // the published TLE has not changed.

    const sameTle =
      record &&
      metadata &&
      metadata.tle_line1 === data.tle_line1 &&
      metadata.tle_line2 === data.tle_line2;

    if (!sameTle) {
      applyTle(data, 'published');
    } else {
      metadata = data;
      tleMode = 'published';
    }

    saveTle(data);

    tleWarning = '';
    tick();

  } catch (error) {
    console.warn(
      'Unable to load tle.json:',
      error
    );

    tleWarning =
      'Published TLE unavailable';

    // Continue using the TLE in memory.

    if (record) {
      tleMode = 'cached';
      tick();

    } else {
      // Try the last valid TLE
      // saved in this browser.

      const cached = getCachedTle();

      if (cached) {
        try {
          applyTle(cached, 'cached');
          tick();

        } catch (cacheError) {
          console.error(
            'Unable to restore cached TLE:',
            cacheError
          );

          status(
            'No valid orbital data available.'
          );
        }

      } else {
        status(
          'TLE unavailable · ' +
          'No cached orbital data. ' +
          'Try again later.'
        );
      }
    }

  } finally {
    requestInProgress = false;
    $('refresh').disabled = false;
  }
}


/* ========================================
   FOLLOW SATELLITE
   ======================================== */

function setFollowing(value) {
  following = value;

  $('follow').setAttribute(
    'aria-pressed',
    String(value)
  );

  $('follow').textContent = value
    ? 'Tracking enabled'
    : 'Center satellite';
}


/* ========================================
   MAP INITIALIZATION
   ======================================== */

if (!window.L || !window.satellite) {
  status(
    'The map libraries could not be loaded. ' +
    'Check the vendor folder.'
  );

  $('refresh').disabled = true;
  $('follow').disabled = true;

} else {

  const worldBounds = L.latLngBounds([
    [-90, -180],
    [90, 180]
  ]);

  map = L.map('map', {
    crs: L.CRS.EPSG4326,
    minZoom: 0,
    maxZoom: 6,
    zoomSnap: 0,
    zoomDelta: 0.25,
    maxBounds: worldBounds,
    maxBoundsViscosity: 1
  });

  map.getContainer().style.background =
    '#080f19';

  map.fitBounds(worldBounds);

  map.fitBounds(worldBounds, {
    padding: [0, 0]
  });

  // Initial view is the maximum
  // permitted zoom-out level.

  map.setMinZoom(map.getZoom());


  /* ========================================
     ILLUSTRATED BACKGROUND
     ======================================== */

  const background = L.imageOverlay(
    'assets/orbital-map.svg',
    worldBounds,
    {
      interactive: false,
      attribution:
        'Illustrative map · not for navigation'
    }
  ).addTo(map);

  background.on('error', () => {
    status(
      'The illustrated map could not be loaded. ' +
      'Check assets/orbital-map.svg.'
    );
  });


  /* ========================================
     SATELLITE MARKER
     ======================================== */

  marker = L.marker([0, 0], {
    icon: L.divIcon({
      className: '',
      html:
        '<div class="satellite-marker"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    })
  }).bindTooltip('IOD2', {
    permanent: true,
    direction: 'top',
    offset: [0, -14]
  });


  /* ========================================
     ORBITAL TRAJECTORIES
     ======================================== */

  past = L.polyline([], {
    color: '#577b88',
    weight: 2
  }).addTo(map);

  future = L.polyline([], {
    color: '#79e9b1',
    weight: 2,
    dashArray: '6 7'
  }).addTo(map);


  /* ========================================
     MAP INTERACTIONS
     ======================================== */

  map.on('dragstart', () => {
    setFollowing(false);
  });

  $('follow').addEventListener('click', () => {
    setFollowing(!following);
    tick();
  });

  // Manual refresh reads only tle.json.

  $('refresh').addEventListener(
    'click',
    loadTle
  );


  /* ========================================
     RESTORE CACHE IMMEDIATELY
     ======================================== */

  const cached = getCachedTle();

  if (cached) {
    try {
      applyTle(cached, 'cached');

    } catch (error) {
      console.warn(
        'Unable to initialize cached TLE:',
        error
      );
    }
  }


  /* ========================================
     AUTOMATIC UPDATES
     ======================================== */

  // Load the shared TLE from GitHub Pages.

  loadTle();

  // Update position every second.

  setInterval(tick, 1000);

  // Recheck GitHub Pages every 5 minutes.
  // This NEVER requests CelesTrak.

  setInterval(
    loadTle,
    JSON_CHECK_INTERVAL
  );
}
