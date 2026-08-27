// Live & Fallback Currency Conversion Engine

import { CURRENCIES, ZERO_DECIMAL_CURRENCIES } from './geo.js';

// Offline fallback rates (USD base). Live rates from open.er-api.com are merged
// over these when available, so this only needs the commonly-used currencies.
const FALLBACK_RATES_FROM_USD = {
  USD: 1, EUR: 0.92, GBP: 0.79, NGN: 1540, GHS: 15.3, KES: 129.5, ZAR: 18.1,
  UGX: 3710, TZS: 2680, RWF: 1320, XOF: 604, XAF: 604, EGP: 48.5, MAD: 9.9,
  ETB: 122, ZMW: 26.5, CAD: 1.37, AUD: 1.51, NZD: 1.64, CHF: 0.88, SEK: 10.6,
  NOK: 10.9, DKK: 6.9, PLN: 3.95, CZK: 23.1, RON: 4.57, HUF: 358, TRY: 34.2,
  UAH: 41.3, RUB: 92, AED: 3.67, SAR: 3.75, QAR: 3.64, ILS: 3.7, INR: 83.9,
  PKR: 278, BDT: 119, LKR: 296, CNY: 7.24, HKD: 7.8, TWD: 32.3, JPY: 154,
  KRW: 1355, SGD: 1.34, MYR: 4.5, IDR: 15800, THB: 34.5, VND: 25400, PHP: 58.2,
  BRL: 5.45, MXN: 18.7, ARS: 985, CLP: 945, COP: 4200,
};

const CURRENCY_SYMBOLS = Object.fromEntries(CURRENCIES.map((c) => [c.code, c.symbol]));

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
  if (ZERO_DECIMAL_CURRENCIES.includes(to)) {
    return Math.round(converted);
  }
  return Math.round(converted * 100) / 100;
}

export function formatCurrency(amount, currency = 'USD') {
  const code = (currency || 'USD').toUpperCase();
  const num = Number(amount || 0);
  const symbol = CURRENCY_SYMBOLS[code] || `${code} `;

  if (ZERO_DECIMAL_CURRENCIES.includes(code)) {
    return `${symbol}${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }

  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
