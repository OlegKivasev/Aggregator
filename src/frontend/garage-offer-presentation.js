const samaraDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Samara", year: "numeric", month: "2-digit", day: "2-digit" });

export const garageDeliveryWarning = (item, now = Date.now()) => {
  if (item.availabilityStatus === "supplier_error") return "Не удалось проверить";
  if (item.availabilityStatus === "not_found") return "Предложение не подтверждено";
  const end = item.deliveryDateTo ?? item.deliveryDate;
  if (typeof end === "string" && Number.isFinite(Date.parse(end)) && end.slice(0, 10) < samaraDay.format(new Date(now))) {
    return "Срок доставки устарел";
  }
  return null;
};
