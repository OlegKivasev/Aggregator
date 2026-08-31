export const isPartKomReturnableVisible = (result, showNonReturnable) => (
  result.supplier !== "part-kom" || showNonReturnable || result.isReturnable !== false
);
