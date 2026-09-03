export const isArmtekReturnableVisible = (result, showNonReturnable) => (
  result.supplier !== "armtek" || showNonReturnable || result.isReturnable !== false
);
