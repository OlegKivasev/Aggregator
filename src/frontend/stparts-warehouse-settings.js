export const stpartsWarehouseColors = ["green", "blue", "red"];

export const normalizeStpartsWarehouseColors = (value) => {
  if (!Array.isArray(value)) {
    return ["green"];
  }

  const colors = [...new Set(value.filter((color) => stpartsWarehouseColors.includes(color)))];
  return colors.length ? colors : ["green"];
};

export const isStpartsWarehouseVisible = (result, enabledColors) => (
  result.supplier !== "stparts" || enabledColors.has(result.warehouseColor)
);
