// Aliases describe one make; parent companies and their separate makes are not interchangeable.
const aliasGroups = [
  ["VW", "VOLKSWAGEN", "ФОЛЬКСВАГЕН", "ФОЛЬКСВАГЭН"],
  ["MERCEDES-BENZ", "MERCEDES", "BENZ", "MB", "МЕРСЕДЕС-БЕНЦ", "МЕРСЕДЕС", "МЕРСЕДЕС БЕНЗ"],
  ["CITROËN", "CITROEN", "СИТРОЕН", "СИТРОЭН"],
  ["LADA", "VAZ", "AVTOVAZ", "ЛАДА", "ВАЗ", "АВТОВАЗ"],
  ["GAZ", "ГАЗ"],
  ["UAZ", "УАЗ"],
  ["ZAZ", "ЗАЗ", "ЗАПОРОЖЕЦ"],
  ["ZIL", "ЗИЛ"],
  ["IZH", "ИЖ"],
  ["LUAZ", "ЛУАЗ"],
  ["MOSKVICH", "МОСКВИЧ", "АЗЛК", "AZLK"],
  ["TAGAZ", "ТАГАЗ"],
  ["FORD", "FOMOCO", "FORD MOTOR COMPANY", "ФОРД", "ФОМОКО"],
  ["BMW", "БМВ"],
  ["AUDI", "АУДИ"],
  ["SKODA", "ŠKODA", "ШКОДА"],
  ["SEAT", "СЕАТ", "СЭАТ"],
  ["CUPRA", "КУПРА"],
  ["OPEL", "ОПЕЛЬ"],
  ["VAUXHALL", "ВОКСХОЛЛ", "ВОКСХОЛ", "ВАКСХОЛЛ"],
  ["CHEVROLET", "CHEVY", "ШЕВРОЛЕ", "ШЕВРОЛЕТ"],
  ["BUICK", "БЬЮИК", "БЮИК"],
  ["CADILLAC", "КАДИЛЛАК", "КАДИЛАК"],
  ["GMC", "ДЖИ ЭМ СИ"],
  ["DAEWOO", "ДЭУ", "ДЕУ"],
  ["UZ-DAEWOO", "УЗ ДЭУ", "УЗДЭУ"],
  ["RAVON", "РАВОН"],
  ["RENAULT", "РЕНО"],
  ["RENAULT TRUCKS", "РЕНО ТРАКС"],
  ["PEUGEOT", "ПЕЖО"],
  ["DACIA", "ДАЧИЯ", "ДАСИЯ"],
  ["FIAT", "ФИАТ"],
  ["ALFA ROMEO", "АЛЬФА РОМЕО", "АЛФА РОМЕО"],
  ["LANCIA", "ЛЯНЧА", "ЛАНЧА", "ЛАНЧИЯ"],
  ["ABARTH", "АБАРТ"],
  ["VOLVO", "ВОЛЬВО"],
  ["SAAB", "СААБ"],
  ["TOYOTA", "ТОЙОТА", "ТОЁТА"],
  ["LEXUS", "ЛЕКСУС"],
  ["NISSAN", "НИССАН", "НИСАН"],
  ["INFINITI", "ИНФИНИТИ"],
  ["HONDA", "ХОНДА"],
  ["ACURA", "АКУРА"],
  ["MAZDA", "МАЗДА"],
  ["MITSUBISHI", "MITSUBISI", "МИЦУБИСИ", "МИТСУБИСИ", "МИТЦУБИСИ"],
  ["SUBARU", "СУБАРУ"],
  ["SUZUKI", "СУЗУКИ"],
  ["DAIHATSU", "ДАЙХАТСУ", "ДАИХАТСУ"],
  ["ISUZU", "ИСУЗУ"],
  ["DATSUN", "ДАТСУН"],
  ["HYUNDAI", "HYNDAI", "ХЕНДАЙ", "ХЁНДАЙ", "ХЮНДАЙ", "ХУНДАЙ", "ХЭНДАЙ"],
  ["KIA", "КИА", "КИЯ"],
  ["GENESIS", "ГЕНЕЗИС", "ДЖЕНЕЗИС"],
  ["SSANGYONG", "SSANG YONG", "САНГ ЙОНГ", "САНГЙОНГ", "ССАНГЙОНГ", "САНЬЕНГ"],
  ["KG MOBILITY", "KGM", "КГ МОБИЛИТИ"],
  ["JAGUAR", "ЯГУАР"],
  ["LAND ROVER", "ЛЕНД РОВЕР", "ЛЭНД РОВЕР", "ЛАНД РОВЕР"],
  ["ROVER", "РОВЕР"],
  ["MINI", "МИНИ"],
  ["PORSCHE", "ПОРШЕ", "ПОРШ"],
  ["BENTLEY", "БЕНТЛИ"],
  ["ROLLS-ROYCE", "РОЛЛС РОЙС", "РОЛС РОЙС"],
  ["ASTON MARTIN", "АСТОН МАРТИН"],
  ["FERRARI", "ФЕРРАРИ"],
  ["LAMBORGHINI", "ЛАМБОРГИНИ", "ЛАМБОРДЖИНИ"],
  ["MASERATI", "МАЗЕРАТИ"],
  ["MCLAREN", "МАКЛАРЕН"],
  ["CHRYSLER", "КРАЙСЛЕР"],
  ["DODGE", "ДОДЖ"],
  ["JEEP", "ДЖИП"],
  ["RAM", "РАМ"],
  ["LINCOLN", "ЛИНКОЛЬН"],
  ["MERCURY", "МЕРКЬЮРИ"],
  ["PONTIAC", "ПОНТИАК"],
  ["OLDSMOBILE", "ОЛДСМОБИЛЬ"],
  ["PLYMOUTH", "ПЛИМУТ"],
  ["HUMMER", "ХАММЕР", "ХАМЕР"],
  ["HOLDEN", "ХОЛДЕН"],
  ["TESLA", "ТЕСЛА"],
  ["CHERY", "ЧЕРИ"],
  ["CHANGAN", "ЧАНГАН", "ЧАНЪАНЬ"],
  ["GEELY", "ДЖИЛИ", "ДЖИЛЛИ"],
  ["GREAT WALL", "GWM", "ГРЕЙТ ВОЛЛ", "ГРЕЙТ ВОЛ", "ГРЕЙТ УОЛЛ"],
  ["HAVAL", "ХАВАЛ", "ХАВЕЙЛ", "ХЭВАЛ"],
  ["TANK", "ТАНК"],
  ["WEY", "ВЕЙ"],
  ["LIFAN", "ЛИФАН"],
  ["BYD", "БИД", "БИ УАЙ ДИ"],
  ["JAC", "ДЖАК"],
  ["FAW", "ФАВ"],
  ["FOTON", "ФОТОН"],
  ["DONGFENG", "ДОНГФЕНГ", "ДОНФЕНГ", "ДУНФЭН"],
  ["DFSK", "ДФСК"],
  ["GAC", "ГАК"],
  ["BAIC", "БАИК", "БАЙК"],
  ["BAW", "БАВ"],
  ["BRILLIANCE", "БРИЛЛИАНС"],
  ["ZOTYE", "ЗОТИ"],
  ["OMODA", "ОМОДА"],
  ["JAECOO", "ДЖЕЙКУ", "ДЖЕЙКО"],
  ["JETOUR", "ДЖЕТУР"],
  ["EXLANTIX", "ЭКСЛАНТИКС"],
  ["BELGEE", "БЕЛДЖИ"],
  ["LIVAN AUTO", "LIVAN", "ЛИВАН"],
  ["LIXIANG", "LI AUTO", "ЛИСЯН", "ЛИ СЯН"],
  ["VOYAH", "ВОЯ", "ВОЯХ"],
  ["ZEEKR", "ЗИКР"],
  ["XPENG", "X PENG", "ИКСПЕНГ"],
  ["NIO", "НИО"],
  ["XIAOMI", "СЯОМИ"],
  ["LEAPMOTOR", "ЛИПМОТОР"],
  ["LYNK & CO", "LYNK AND CO", "ЛИНК ЭНД КО"],
  ["HONGQI", "ХОНГЦИ", "ХУНЦИ"],
  ["HAFEI", "ХАФЕЙ"],
  ["HAWTAI", "ХАВТАЙ"],
  ["DERWAYS", "ДЕРВЕЙС"],
  ["VORTEX", "ВОРТЕКС"],
  ["XCITE", "ИКСАЙТ"],
  ["MAN", "МАН"],
  ["DAF", "ДАФ"],
  ["IVECO", "ИВЕКО"],
  ["TATA", "ТАТА"],
  ["MAHINDRA", "МАХИНДРА"],
  ["PROTON", "ПРОТОН"],
  ["PERODUA", "ПЕРОДУА"],
  ["SCION", "САЙОН"],
  ["SMART", "СМАРТ"],
  ["LOTUS", "ЛОТУС"],
  ["MAYBACH", "МАЙБАХ"],
];

const normalizeName = (value) => value.normalize("NFKD").replace(/\p{M}/gu, "")
  .toLocaleUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
const groupsByName = new Map(aliasGroups.flatMap((group) => group.map((name) => [normalizeName(name), group])));

export function createApplicabilityMakeMatcher(makeNames) {
  const exactNames = new Map();
  const candidates = new Map();
  const searchNames = new Map();
  for (const name of makeNames) {
    exactNames.set(name.trim().toLocaleUpperCase(), name);
    const aliases = [name];
    const words = name.split(/\s+/u);
    for (let end = words.length; end > 0; end -= 1) {
      const group = groupsByName.get(normalizeName(words.slice(0, end).join(" ")));
      if (!group) continue;
      const suffix = end < words.length ? ` ${words.slice(end).join(" ")}` : "";
      aliases.push(...group.map((alias) => `${alias}${suffix}`));
      break;
    }
    const normalizedAliases = [...new Set(aliases.map(normalizeName))];
    searchNames.set(name, normalizedAliases);
    for (const alias of normalizedAliases) {
      if (!candidates.has(alias)) candidates.set(alias, new Set());
      candidates.get(alias).add(name);
    }
  }
  return {
    resolve(value) {
      if (typeof value !== "string" || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
      const exact = exactNames.get(value.trim().toLocaleUpperCase());
      if (exact) return exact;
      const matches = candidates.get(normalizeName(value));
      return matches?.size === 1 ? [...matches][0] : null;
    },
    matches(name, query) {
      const normalizedQuery = normalizeName(query);
      return !normalizedQuery || Boolean(searchNames.get(name)?.some((alias) => alias.includes(normalizedQuery)));
    },
  };
}
