/**
 * Shared country + currency reference data and <option> builders.
 *
 * One source of truth instead of the short hardcoded lists that had drifted
 * between vendor.js, checkout.html, vendor.html and currency.js.
 */

import { escapeHtml } from './ui.js';

/* code, name, default currency. `OTHER` is the catch-all kept last. */
export const COUNTRIES = [
  ['GH', 'Ghana', 'GHS'], ['NG', 'Nigeria', 'NGN'], ['KE', 'Kenya', 'KES'],
  ['UG', 'Uganda', 'UGX'], ['TZ', 'Tanzania', 'TZS'], ['RW', 'Rwanda', 'RWF'],
  ['ZA', 'South Africa', 'ZAR'], ['CM', 'Cameroon', 'XAF'], ['CI', "Côte d'Ivoire", 'XOF'],
  ['SN', 'Senegal', 'XOF'], ['ET', 'Ethiopia', 'ETB'], ['EG', 'Egypt', 'EGP'],
  ['MA', 'Morocco', 'MAD'], ['DZ', 'Algeria', 'DZD'], ['TN', 'Tunisia', 'TND'],
  ['ZM', 'Zambia', 'ZMW'], ['ZW', 'Zimbabwe', 'USD'], ['BW', 'Botswana', 'BWP'],
  ['NA', 'Namibia', 'NAD'], ['MU', 'Mauritius', 'MUR'], ['MW', 'Malawi', 'MWK'],
  ['MZ', 'Mozambique', 'MZN'], ['AO', 'Angola', 'AOA'], ['BJ', 'Benin', 'XOF'],
  ['BF', 'Burkina Faso', 'XOF'], ['ML', 'Mali', 'XOF'], ['NE', 'Niger', 'XOF'],
  ['TG', 'Togo', 'XOF'], ['GA', 'Gabon', 'XAF'], ['CD', 'DR Congo', 'CDF'],
  ['US', 'United States', 'USD'], ['CA', 'Canada', 'CAD'], ['GB', 'United Kingdom', 'GBP'],
  ['IE', 'Ireland', 'EUR'], ['DE', 'Germany', 'EUR'], ['FR', 'France', 'EUR'],
  ['ES', 'Spain', 'EUR'], ['PT', 'Portugal', 'EUR'], ['IT', 'Italy', 'EUR'],
  ['NL', 'Netherlands', 'EUR'], ['BE', 'Belgium', 'EUR'], ['AT', 'Austria', 'EUR'],
  ['CH', 'Switzerland', 'CHF'], ['SE', 'Sweden', 'SEK'], ['NO', 'Norway', 'NOK'],
  ['DK', 'Denmark', 'DKK'], ['FI', 'Finland', 'EUR'], ['PL', 'Poland', 'PLN'],
  ['CZ', 'Czechia', 'CZK'], ['RO', 'Romania', 'RON'], ['GR', 'Greece', 'EUR'],
  ['HU', 'Hungary', 'HUF'], ['UA', 'Ukraine', 'UAH'], ['TR', 'Türkiye', 'TRY'],
  ['RU', 'Russia', 'RUB'], ['AE', 'United Arab Emirates', 'AED'], ['SA', 'Saudi Arabia', 'SAR'],
  ['QA', 'Qatar', 'QAR'], ['KW', 'Kuwait', 'KWD'], ['BH', 'Bahrain', 'BHD'],
  ['OM', 'Oman', 'OMR'], ['IL', 'Israel', 'ILS'], ['JO', 'Jordan', 'JOD'],
  ['LB', 'Lebanon', 'USD'], ['IN', 'India', 'INR'], ['PK', 'Pakistan', 'PKR'],
  ['BD', 'Bangladesh', 'BDT'], ['LK', 'Sri Lanka', 'LKR'], ['NP', 'Nepal', 'NPR'],
  ['CN', 'China', 'CNY'], ['HK', 'Hong Kong', 'HKD'], ['TW', 'Taiwan', 'TWD'],
  ['JP', 'Japan', 'JPY'], ['KR', 'South Korea', 'KRW'], ['SG', 'Singapore', 'SGD'],
  ['MY', 'Malaysia', 'MYR'], ['ID', 'Indonesia', 'IDR'], ['TH', 'Thailand', 'THB'],
  ['VN', 'Vietnam', 'VND'], ['PH', 'Philippines', 'PHP'], ['AU', 'Australia', 'AUD'],
  ['NZ', 'New Zealand', 'NZD'], ['BR', 'Brazil', 'BRL'], ['MX', 'Mexico', 'MXN'],
  ['AR', 'Argentina', 'ARS'], ['CL', 'Chile', 'CLP'], ['CO', 'Colombia', 'COP'],
  ['PE', 'Peru', 'PEN'], ['UY', 'Uruguay', 'UYU'], ['CR', 'Costa Rica', 'CRC'],
  ['PA', 'Panama', 'USD'], ['DO', 'Dominican Republic', 'DOP'], ['JM', 'Jamaica', 'JMD'],
  ['TT', 'Trinidad & Tobago', 'TTD'],
  ['OTHER', 'Elsewhere', 'USD'],
].map(([code, name, currency]) => ({ code, name, currency }));

/* code, name, symbol (space-suffixed symbols align with currency.js). */
export const CURRENCIES = [
  ['USD', 'US Dollar', '$'], ['EUR', 'Euro', '€'], ['GBP', 'British Pound', '£'],
  ['NGN', 'Nigerian Naira', '₦'], ['GHS', 'Ghanaian Cedi', 'GH₵ '], ['KES', 'Kenyan Shilling', 'KSh '],
  ['ZAR', 'South African Rand', 'R '], ['UGX', 'Ugandan Shilling', 'USh '], ['TZS', 'Tanzanian Shilling', 'TSh '],
  ['RWF', 'Rwandan Franc', 'RF '], ['XOF', 'West African CFA', 'CFA '], ['XAF', 'Central African CFA', 'FCFA '],
  ['EGP', 'Egyptian Pound', 'E£ '], ['MAD', 'Moroccan Dirham', 'DH '], ['ETB', 'Ethiopian Birr', 'Br '],
  ['ZMW', 'Zambian Kwacha', 'ZK '], ['CAD', 'Canadian Dollar', 'CA$ '], ['AUD', 'Australian Dollar', 'A$ '],
  ['NZD', 'New Zealand Dollar', 'NZ$ '], ['CHF', 'Swiss Franc', 'CHF '], ['SEK', 'Swedish Krona', 'kr '],
  ['NOK', 'Norwegian Krone', 'kr '], ['DKK', 'Danish Krone', 'kr '], ['PLN', 'Polish Zloty', 'zł '],
  ['CZK', 'Czech Koruna', 'Kč '], ['RON', 'Romanian Leu', 'lei '], ['HUF', 'Hungarian Forint', 'Ft '],
  ['TRY', 'Turkish Lira', '₺'], ['UAH', 'Ukrainian Hryvnia', '₴'], ['RUB', 'Russian Ruble', '₽'],
  ['AED', 'UAE Dirham', 'AED '], ['SAR', 'Saudi Riyal', 'SAR '], ['QAR', 'Qatari Riyal', 'QAR '],
  ['ILS', 'Israeli Shekel', '₪'], ['INR', 'Indian Rupee', '₹'], ['PKR', 'Pakistani Rupee', '₨ '],
  ['BDT', 'Bangladeshi Taka', '৳ '], ['LKR', 'Sri Lankan Rupee', 'Rs '], ['CNY', 'Chinese Yuan', '¥'],
  ['HKD', 'Hong Kong Dollar', 'HK$ '], ['TWD', 'Taiwan Dollar', 'NT$ '], ['JPY', 'Japanese Yen', '¥'],
  ['KRW', 'South Korean Won', '₩'], ['SGD', 'Singapore Dollar', 'S$ '], ['MYR', 'Malaysian Ringgit', 'RM '],
  ['IDR', 'Indonesian Rupiah', 'Rp '], ['THB', 'Thai Baht', '฿'], ['VND', 'Vietnamese Dong', '₫'],
  ['PHP', 'Philippine Peso', '₱'], ['BRL', 'Brazilian Real', 'R$ '], ['MXN', 'Mexican Peso', 'MX$ '],
  ['ARS', 'Argentine Peso', 'AR$ '], ['CLP', 'Chilean Peso', 'CLP$ '], ['COP', 'Colombian Peso', 'COL$ '],
].map(([code, name, symbol]) => ({ code, name, symbol }));

/** Currencies with no minor unit — rounded to whole numbers everywhere. */
export const ZERO_DECIMAL_CURRENCIES = ['UGX', 'JPY', 'RWF', 'TZS', 'KRW', 'VND', 'CLP', 'XOF', 'XAF', 'IDR'];

export function countryOptions(selected = 'GH') {
  return COUNTRIES.map((c) =>
    `<option value="${c.code}"${c.code === selected ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

export function currencyOptions(selected = 'USD', { withName = true } = {}) {
  return CURRENCIES.map((c) =>
    `<option value="${c.code}"${c.code === selected ? ' selected' : ''}>${escapeHtml(withName ? `${c.code} — ${c.name}` : c.code)}</option>`).join('');
}

export function currencyForCountry(code) {
  return COUNTRIES.find((c) => c.code === code)?.currency || 'USD';
}
