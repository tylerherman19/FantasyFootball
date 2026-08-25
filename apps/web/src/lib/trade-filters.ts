export const tradeFilterHref = (
  pathname: string,
  current: URLSearchParams,
  key: string,
  value: string,
): string => {
  const next = new URLSearchParams(current.toString());
  if (value === '') next.delete(key);
  else next.set(key, value);

  if (key === 'target' && value !== '') next.delete('pos');
  if (key === 'pos' && value !== '') next.delete('target');

  const query = next.toString();
  return query === '' ? pathname : `${pathname}?${query}`;
};
