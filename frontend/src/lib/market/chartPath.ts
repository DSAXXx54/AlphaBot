export function pointX(index: number, count: number, minX: number, maxX: number) {
  if (count <= 1) return (minX + maxX) / 2;
  return minX + ((maxX - minX) * index) / (count - 1);
}

export function pointY(value: number, maxValue: number, minY: number, maxY: number) {
  return maxY - ((maxY - minY) * value) / Math.max(maxValue, 1);
}

export function buildLinePathFromBounds(
  values: number[],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  maxValue: number
): string {
  if (values.length === 0) return '';
  return values
    .map((value, index) => {
      const x = pointX(index, values.length, minX, maxX);
      const y = pointY(value, maxValue, minY, maxY);
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');
}

export function buildLinePath(
  values: number[],
  width: number,
  height: number,
  maxValue: number,
  padding = 28,
  bottomPad = padding
): string {
  return buildLinePathFromBounds(values, padding, width - padding, padding, height - bottomPad, maxValue);
}
