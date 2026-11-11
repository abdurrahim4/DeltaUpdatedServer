
import crypto from 'node:crypto';
import { list } from '../repositories/jsonStore.js';
import { OrderError } from './orders.js';

// ---------------------------------------
// DELIVERY PRICES
// ---------------------------------------

export const DEFAULT_TIERS = [
 { km: 1, fee: 5 },
  { km: 2, fee: 5 },
  { km: 3, fee: 6 },
  { km: 4, fee: 8 },
  { km: 5, fee: 10 },
  { km: 6, fee: 12 },
  { km: 7, fee: 15 },
  { km: 8, fee: 17 },
  { km: 9, fee: 20 },
  { km: 10, fee: 22 },
  { km: 11, fee: 24 },
  { km: 12, fee: 25 },
  { km: 13, fee: 27 },
  { km: 14, fee: 30 },
  { km: 15, fee: 30 }
];

const round = n =>
  Math.round((n + Number.EPSILON) * 100) / 100;

export const feeFor = (km, tiers = DEFAULT_TIERS) =>
  tiers.find(t => km <= t.km)?.fee ?? null;

export async function settings() {
  return (
    (await list('delivery-settings'))[0] || {
      id: 'global',
      maxKm: 15,
      tiers: DEFAULT_TIERS
    }
  );
}

// ---------------------------------------
// DELIVERY QUOTE SECURITY
// ---------------------------------------

const secret = () =>
  process.env.DELIVERY_QUOTE_SECRET ||
  process.env.JWT_SECRET;

const signature = value =>
  crypto
    .createHmac('sha256', secret())
    .update(value)
    .digest('hex');

export function signQuote(data) {
  if (!secret()) {
    throw new OrderError(
      'Delivery quote secret not configured',
      503
    );
  }

  const encoded = Buffer
    .from(JSON.stringify(data))
    .toString('base64url');

  return encoded + '.' + signature(encoded);
}

export function readQuote(token) {
  if (
    !secret() ||
    typeof token !== 'string' ||
    token.length > 5000
  ) {
    throw new OrderError('Delivery quote required', 400);
  }

  const [encoded, sig, ...extra] = token.split('.');

  if (
    extra.length ||
    !encoded ||
    !sig ||
    !/^[a-f0-9]{64}$/.test(sig)
  ) {
    throw new OrderError('Invalid delivery quote', 400);
  }

  const expected = signature(encoded);

  if (
    !crypto.timingSafeEqual(
      Buffer.from(sig, 'hex'),
      Buffer.from(expected, 'hex')
    )
  ) {
    throw new OrderError('Invalid delivery quote', 400);
  }

  let data;

  try {
    data = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    );
  } catch {
    throw new OrderError('Invalid delivery quote', 400);
  }

  if (
    !Number.isFinite(data.expiresAt) ||
    Date.now() > data.expiresAt
  ) {
    throw new OrderError(
      'Delivery quote expired. Verify your address again.',
      409
    );
  }

  return data;
}

// ---------------------------------------
// GEOAPIFY API
// ---------------------------------------

async function geo(url) {
  const key = process.env.GEOAPIFY_API_KEY;

  if (!key) {
    throw new OrderError(
      'GEOAPIFY_API_KEY is missing.',
      503
    );
  }

  const requestUrl = new URL(url);
  requestUrl.searchParams.set('apiKey', key);

  try {
    const response = await fetch(requestUrl, {
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      const body = await response.text();

      console.error('Geoapify request failed:', {
        endpoint: requestUrl.pathname,
        status: response.status,
        details: body.slice(0, 500)
      });

      throw new OrderError(
        'Map service temporarily unavailable. Please try again.',
        503
      );
    }

    return await response.json();

  } catch (error) {
    if (error instanceof OrderError) {
      throw error;
    }

    console.error(
      'Geoapify connection error:',
      error.message
    );

    throw new OrderError(
      'Unable to connect to the map service.',
      503
    );
  }
}

// ---------------------------------------
// VALIDATE COORDINATES
// ---------------------------------------

function validPoint(point) {
  if (!point || typeof point !== 'object') {
    return null;
  }

  const rawLat = point.lat ?? point.latitude;
  const rawLon =
    point.lon ??
    point.lng ??
    point.longitude;

  if (
    rawLat === null ||
    rawLat === undefined ||
    rawLat === '' ||
    rawLon === null ||
    rawLon === undefined ||
    rawLon === ''
  ) {
    return null;
  }

  const lat = Number(rawLat);
  const lon = Number(rawLon);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    (lat === 0 && lon === 0)
  ) {
    return null;
  }

  return { lat, lon };
}

function coords(branch) {
  return validPoint({
    lat:
      branch.latitude ??
      branch.lat ??
      branch.location?.lat,
    lon:
      branch.longitude ??
      branch.lon ??
      branch.lng ??
      branch.location?.lon ??
      branch.location?.lng
  });
}

// ---------------------------------------
// STRAIGHT-LINE DISTANCE
// Only used to shortlist nearby branches
// ---------------------------------------

function crowDistance(a, b) {
  const r = Math.PI / 180;

  const dlat = (b.lat - a.lat) * r;
  const dlon = (b.lon - a.lon) * r;

  const x =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.lat * r) *
    Math.cos(b.lat * r) *
    Math.sin(dlon / 2) ** 2;

  return (
    6371 *
    2 *
    Math.atan2(
      Math.sqrt(x),
      Math.sqrt(1 - x)
    )
  );
}

// ---------------------------------------
// CUSTOMER ADDRESS GEOCODING
// ---------------------------------------

export async function locate(address) {
  const street = String(address.street || '').trim();
  const house = String(address.houseNumber || '').trim();
  const city = String(address.city || '').trim();
  const postal = String(address.postalCode || '').trim();

  if (!street || !house || !city) {
    throw new OrderError(
      'Street, house number and city are required',
      400
    );
  }

  const query = [
    `${street} ${house}`,
    postal,
    city,
    'Poland'
  ].filter(Boolean).join(', ');

  const url =
    'https://api.geoapify.com/v1/geocode/search?' +
    new URLSearchParams({
      text: query,
      filter: 'countrycode:pl',
      limit: '1'
    });

  const data = await geo(url);

  const feature = data.features?.[0];
  const properties = feature?.properties;

  if (
    !properties ||
    !Number.isFinite(properties.lat) ||
    !Number.isFinite(properties.lon) ||
    (properties.rank?.confidence ?? 0) < 0.35
  ) {
    throw new OrderError(
      'Address not found. Check street, house number and city.',
      422
    );
  }

  return {
    lat: properties.lat,
    lon: properties.lon,
    label: properties.formatted || query,
    city: properties.city || city
  };
}

// ---------------------------------------
// DRIVING DISTANCE
// ---------------------------------------

export async function roadKm(from, to) {
  const start = validPoint(from);
  const destination = validPoint(to);

  if (!start || !destination) {
    console.error('Invalid routing coordinates:', {
      from,
      to
    });

    throw new OrderError(
      'Invalid restaurant or customer coordinates.',
      422
    );
  }

  // Geoapify uses latitude,longitude
  const waypoints = [
    `${start.lat},${start.lon}`,
    `${destination.lat},${destination.lon}`
  ].join('|');

  console.log('Geoapify routing waypoints:', waypoints);

  const url =
    'https://api.geoapify.com/v1/routing?' +
    new URLSearchParams({
      waypoints,
      mode: 'drive'
    });

  const data = await geo(url);

  const feature = data.features?.[0];

  if (!feature) {
    throw new OrderError(
      'No driving route found for this address.',
      422
    );
  }

  const meters = Number(feature.properties?.distance);

  if (!Number.isFinite(meters) || meters < 0) {
    throw new OrderError(
      'Invalid driving distance returned by map service.',
      503
    );
  }

  return round(meters / 1000);
}

// ---------------------------------------
// DELIVERY QUOTE
// ---------------------------------------

export async function quoteDelivery({
  branchId,
  address,
  subtotal
}) {
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    throw new OrderError('Invalid subtotal', 400);
  }

  const branches = (await list('branches'))
    .filter(b => b.available && !b.deletedAt);

  const selected = branches.find(
    b => b.id === branchId
  );

  if (!selected) {
    throw new OrderError(
      'Branch unavailable',
      404
    );
  }

  const destination = await locate(address);
  const config = await settings();
  const maxKm = config.maxKm || 15;

  const candidates = branches
    .map(b => ({
      ...b,
      point: coords(b)
    }))
    .filter(b => b.point)
    .sort(
      (a, b) =>
        crowDistance(a.point, destination) -
        crowDistance(b.point, destination)
    );

  const current = candidates.find(
    b => b.id === branchId
  );

  if (!current) {
    throw new OrderError(
      'Branch coordinates missing. Contact restaurant.',
      422
    );
  }

  console.log('Selected restaurant:', {
    name: current.name,
    coordinates: current.point
  });

  console.log('Customer destination:', destination);

  const km = await roadKm(
    current.point,
    destination
  );

  let recommended = null;

  if (km > maxKm) {
    const nearby = candidates
      .filter(
        b =>
          b.id !== branchId &&
          crowDistance(b.point, destination) <= maxKm
      )
      .slice(0, 5);

    for (const branch of nearby) {
      try {
        const distance = await roadKm(
          branch.point,
          destination
        );

        if (
          distance <= maxKm &&
          (
            !recommended ||
            distance < recommended.distanceKm
          )
        ) {
          recommended = {
            branchId: branch.id,
            name: branch.name,
            address: branch.address,
            distanceKm: distance
          };
        }
      } catch (error) {
        console.warn(
          'Alternative branch routing failed:',
          branch.id,
          error.message
        );
      }
    }
  }

  const eligible = km <= maxKm;

  const normalFee = eligible
    ? feeFor(km, config.tiers || DEFAULT_TIERS)
    : null;

  const now = Date.now();

  const promotions = (await list('delivery-promotions'))
    .filter(
      p =>
        p.enabled &&
        Date.parse(p.startAt) <= now &&
        Date.parse(p.endAt) > now &&
        (
          p.branchIds?.length === 0 ||
          p.branchIds?.includes(branchId)
        ) &&
        (
          p.type === 'all' ||
          subtotal >= p.minSubtotal
        )
    );

  const promo = eligible
    ? promotions.sort(
        (a, b) =>
          (b.minSubtotal || 0) -
          (a.minSubtotal || 0)
      )[0]
    : null;

  const fee = promo ? 0 : normalFee;

  const fullAddress = [
    destination.label,
    address.apartment
      ? 'Apartment ' + address.apartment
      : '',
    address.floor
      ? 'Floor ' + address.floor
      : ''
  ].filter(Boolean).join(', ');

  const result = {
    eligible,
    distanceKm: km,
    normalFee,
    deliveryFee: fee,
    promotion: promo
      ? {
          id: promo.id,
          name: promo.name
        }
      : null,
    recommended,
    formattedAddress: fullAddress
  };

  if (eligible) {
    result.quoteToken = signQuote({
      branchId,
      subtotal: round(subtotal),
      deliveryFee: fee,
      normalFee,
      promotionId: promo?.id || null,
      distanceKm: km,
      address: fullAddress,
      expiresAt: now + 10 * 60 * 1000
    });
  }

  return result;
}
