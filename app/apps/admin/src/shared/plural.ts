/**
 * A count with its noun in the right number: plural(1, 'firm') → "1 firm",
 * plural(2, 'firm') → "2 firms". Irregular plurals are passed in:
 * plural(2, 'index', 'indices') → "2 indices", plural(3, 'person', 'people').
 */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}
