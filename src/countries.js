// Maps English country names (as returned by data sources) to Arabic name + ISO2 code.
// ISO2 is used to render an emoji flag at runtime (regional-indicator code points),
// so no flag images need to be shipped. Extra aliases cover common naming variants.

export const COUNTRIES = {
  "argentina": { ar: "الأرجنتين", iso: "AR" },
  "australia": { ar: "أستراليا", iso: "AU" },
  "austria": { ar: "النمسا", iso: "AT" },
  "belgium": { ar: "بلجيكا", iso: "BE" },
  "bolivia": { ar: "بوليفيا", iso: "BO" },
  "brazil": { ar: "البرازيل", iso: "BR" },
  "cameroon": { ar: "الكاميرون", iso: "CM" },
  "canada": { ar: "كندا", iso: "CA" },
  "cape verde": { ar: "الرأس الأخضر", iso: "CV" },
  "chile": { ar: "تشيلي", iso: "CL" },
  "colombia": { ar: "كولومبيا", iso: "CO" },
  "costa rica": { ar: "كوستاريكا", iso: "CR" },
  "croatia": { ar: "كرواتيا", iso: "HR" },
  "curacao": { ar: "كوراساو", iso: "CW" },
  "czech republic": { ar: "التشيك", iso: "CZ" },
  "czechia": { ar: "التشيك", iso: "CZ" },
  "denmark": { ar: "الدنمارك", iso: "DK" },
  "ecuador": { ar: "الإكوادور", iso: "EC" },
  "egypt": { ar: "مصر", iso: "EG" },
  "england": { ar: "إنجلترا", iso: "GB-ENG" },
  "france": { ar: "فرنسا", iso: "FR" },
  "germany": { ar: "ألمانيا", iso: "DE" },
  "ghana": { ar: "غانا", iso: "GH" },
  "greece": { ar: "اليونان", iso: "GR" },
  "haiti": { ar: "هايتي", iso: "HT" },
  "honduras": { ar: "هندوراس", iso: "HN" },
  "iran": { ar: "إيران", iso: "IR" },
  "iraq": { ar: "العراق", iso: "IQ" },
  "italy": { ar: "إيطاليا", iso: "IT" },
  "ivory coast": { ar: "ساحل العاج", iso: "CI" },
  "cote d'ivoire": { ar: "ساحل العاج", iso: "CI" },
  "japan": { ar: "اليابان", iso: "JP" },
  "jordan": { ar: "الأردن", iso: "JO" },
  "korea republic": { ar: "كوريا الجنوبية", iso: "KR" },
  "south korea": { ar: "كوريا الجنوبية", iso: "KR" },
  "mexico": { ar: "المكسيك", iso: "MX" },
  "morocco": { ar: "المغرب", iso: "MA" },
  "netherlands": { ar: "هولندا", iso: "NL" },
  "new zealand": { ar: "نيوزيلندا", iso: "NZ" },
  "nigeria": { ar: "نيجيريا", iso: "NG" },
  "norway": { ar: "النرويج", iso: "NO" },
  "panama": { ar: "بنما", iso: "PA" },
  "paraguay": { ar: "باراغواي", iso: "PY" },
  "peru": { ar: "بيرو", iso: "PE" },
  "poland": { ar: "بولندا", iso: "PL" },
  "portugal": { ar: "البرتغال", iso: "PT" },
  "qatar": { ar: "قطر", iso: "QA" },
  "saudi arabia": { ar: "السعودية", iso: "SA" },
  "scotland": { ar: "اسكتلندا", iso: "GB-SCT" },
  "senegal": { ar: "السنغال", iso: "SN" },
  "serbia": { ar: "صربيا", iso: "RS" },
  "slovakia": { ar: "سلوفاكيا", iso: "SK" },
  "slovenia": { ar: "سلوفينيا", iso: "SI" },
  "south africa": { ar: "جنوب أفريقيا", iso: "ZA" },
  "spain": { ar: "إسبانيا", iso: "ES" },
  "sweden": { ar: "السويد", iso: "SE" },
  "switzerland": { ar: "سويسرا", iso: "CH" },
  "tunisia": { ar: "تونس", iso: "TN" },
  "turkey": { ar: "تركيا", iso: "TR" },
  "turkiye": { ar: "تركيا", iso: "TR" },
  "ukraine": { ar: "أوكرانيا", iso: "UA" },
  "united states": { ar: "الولايات المتحدة", iso: "US" },
  "usa": { ar: "الولايات المتحدة", iso: "US" },
  "uruguay": { ar: "أوروغواي", iso: "UY" },
  "uzbekistan": { ar: "أوزبكستان", iso: "UZ" },
  "venezuela": { ar: "فنزويلا", iso: "VE" },
  "wales": { ar: "ويلز", iso: "GB-WLS" },
};

// England / Scotland / Wales don't have a single-emoji flag from ISO code, so map to the
// subdivision (Tag) emoji when available, otherwise fall back to a soccer-ball glyph.
const SUBDIVISION_FLAGS = {
  "GB-ENG": "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
  "GB-SCT": "🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
  "GB-WLS": "🏴\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}",
};

export function flagEmoji(iso) {
  if (!iso) return "⚽";
  if (SUBDIVISION_FLAGS[iso]) return SUBDIVISION_FLAGS[iso];
  if (iso.length !== 2) return "⚽";
  const A = 0x1f1e6;
  const cc = iso.toUpperCase();
  return String.fromCodePoint(A + cc.charCodeAt(0) - 65, A + cc.charCodeAt(1) - 65);
}

export function lookupCountry(name) {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return COUNTRIES[key] || null;
}

// Normalize a raw team name into a display object. Falls back gracefully for
// teams not in the map (e.g. "Winner Group A" placeholders in future fixtures).
export function teamInfo(rawName) {
  const name = (rawName || "").trim();
  const c = lookupCountry(name);
  if (c) return { name, ar: c.ar, iso: c.iso, flag: flagEmoji(c.iso) };
  return { name, ar: name, iso: null, flag: "⚽" };
}
