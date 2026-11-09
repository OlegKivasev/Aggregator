const plateLetters = { а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x" };

const normalize = (value) => value.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
  .replace(/[авекмнорстух]/gu, (letter) => plateLetters[letter]).replace(/[^\p{L}\p{N}]/gu, "");

export function filterRepairCards(cards, query) {
  const terms = query.trim().split(/\s+/u).map(normalize).filter(Boolean);
  if (!terms.length) return cards;
  return cards.filter((card) => {
    const fields = [card.vehicleName, card.counterpartyName ?? "", card.number].map(normalize);
    return terms.every((term) => fields.some((field) => field.includes(term)));
  });
}
