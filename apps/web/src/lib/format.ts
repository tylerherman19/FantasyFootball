
/**
 * 1st, 2nd, 3rd, 11th.
 *
 * Written out because "8 of 10" was being read as odds on the league home page
 * — a ratio beside the word "win" is a probability everywhere else a fantasy
 * manager looks. An ordinal cannot be misread as one.
 */
export const ordinal = (n: number): string => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
};
