export const isAutopiterReturnableVisible = (result, showNonReturnable) => (
  result.supplier !== "autopiter" || showNonReturnable || result.isReturnable === true
);
