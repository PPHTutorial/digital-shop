// Live & Fallback Currency Conversion Engine

const FALLBACK_RATES_FROM_USD = {
  USD: 1,
  NGN: 1540.0,
  GBP: 0.79,
  EUR: 0.92,
  KES: 129.5,
  GHS: 15.3,
  ZAR: 18.1,
  CAD: 1.37,
  UGX: 3710.0,
  AUD: 1.51,
  INR: 83.9,
  JPY: 154.0,
  AED: 3.67,
  SAR: 3.75,
  BRL: 5.45,
  RWF: 1320.0,
  TZS: 2680.0,
};

const CURRENCY_SYMBOLS = {
  USD: '$',
  NGN: '₦',
  GBP: '£',
  EUR: '€',
  KES: 'KSh ',
  GHS: 'GH₵ ',
  ZAR: 'R ',
  CAD: 'CA$ ',
  UGX: 'USh ',
  AUD: 'A$ ',
  INR: '₹',
  JPY: '¥',
  AED: 'AED ',
  SAR: 'SAR ',
  BRL: 'R$ ',
  RWF: 'RF ',
  TZS: 'TSh ',
};

let cachedRates = null;
let lastFetchedAt = 0;

export async function getExchangeRates(base = 'USD') {
  const normalizedBase = base.toUpperCase();
  const now = Date.now();

  // Return memory cached rates if recent (< 30 minutes)
  if (cachedRates && cachedRates.base === normalizedBase && now - lastFetchedAt < 1800000) {
    return cachedRates.rates;
  }

  // Check sessionStorage cache
  try {
    const raw = sessionStorage.getItem(`rates_${normalizedBase}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.timestamp && now - parsed.timestamp < 1800000 && parsed.rates) {
        cachedRates = { base: normalizedBase, rates: parsed.rates };
        lastFetchedAt = parsed.timestamp;
        return parsed.rates;
      }
    }
  } catch {}

  // Fetch live exchange rates from open API
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${normalizedBase}`);
    if (res.ok) {
      const data = await res.json();
      if (data?.rates) {
        const rates = { ...FALLBACK_RATES_FROM_USD, ...data.rates };
        cachedRates = { base: normalizedBase, rates };
        lastFetchedAt = now;
        try {
          sessionStorage.setItem(`rates_${normalizedBase}`, JSON.stringify({ timestamp: now, rates }));
        } catch {}
        return rates;
      }
    }
  } catch (err) {
    console.warn('Live exchange rates unavailable, using fallback rates:', err);
  }

  return FALLBACK_RATES_FROM_USD;
}

export function convertAmount(amount, fromCurrency = 'USD', toCurrency = 'USD', rates = FALLBACK_RATES_FROM_USD) {
  const num = Number(amount || 0);
  const from = (fromCurrency || 'USD').toUpperCase();
  const to = (toCurrency || 'USD').toUpperCase();

  if (from === to) return num;

  const fromRate = rates[from] || FALLBACK_RATES_FROM_USD[from] || 1;
  const toRate = rates[to] || FALLBACK_RATES_FROM_USD[to] || 1;

  // Convert from -> USD -> to
  const amountInUSD = num / fromRate;
  const converted = amountInUSD * toRate;

  // Currencies without sub-units (like UGX, JPY, RWF) round to integer, others round to 2 decimals
  if (['UGX', 'JPY', 'RWF', 'TZS'].includes(to)) {
    return Math.round(converted);
  }
  return Math.round(converted * 100) / 100;
}

export function formatCurrency(amount, currency = 'USD') {
  const code = (currency || 'USD').toUpperCase();
  const num = Number(amount || 0);
  const symbol = CURRENCY_SYMBOLS[code] || `${code} `;

  if (['UGX', 'JPY', 'RWF', 'TZS'].includes(code)) {
    return `${symbol}${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }

  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
